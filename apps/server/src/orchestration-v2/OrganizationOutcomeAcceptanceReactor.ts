import * as NodeCrypto from "node:crypto";

import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  organizationAcceptanceNote,
  organizationOutcomeGate,
  ownedOutcomePullRequests,
  type OutcomePullRequest,
  type OutcomeThread,
} from "@t3tools/shared/organizationOutcome";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ORGANIZATION_ACCEPTANCE_NOTICE_PREFIX,
  ORGANIZATION_PULL_REQUEST_NOTICE_PREFIX,
} from "./OrganizationPolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Accepts organization outcomes for the user. Pull requests are the gate when the user's
 * acceptance matters: a reviewed outcome is accepted once every pull request it owns merged, or
 * on its independent review alone when it opened none. A pull request closed without merging,
 * or an acceptance the server refuses, holds the outcome and tells the Chief once.
 */
export class OrganizationOutcomeAcceptanceReactor extends Context.Service<
  OrganizationOutcomeAcceptanceReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Sweeps one project, or every project when omitted, now. */
    readonly sweep: (projectId?: ProjectId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/OrganizationOutcomeAcceptanceReactor") {}

/** Bursts of task and pull request updates in one project are swept once. */
const SWEEP_DEBOUNCE = Duration.seconds(3);
/** A refused acceptance whose inputs did not change is retried once per this window. */
const ATTEMPT_BUCKET_MS = 3_600_000;
/** How long a branch's pull request lookup is reused. */
const BRANCH_LOOKUP_TTL_MS = 60_000;

interface SweepRequest {
  readonly projectId?: ProjectId | undefined;
  /** Only these leads; all leads in scope when absent. */
  readonly leadIds?: ReadonlySet<ThreadId> | undefined;
  readonly trigger: "startup" | "event" | "manual";
}

const outcomeThread = (thread: OrchestrationV2ThreadShell): OutcomeThread => ({
  id: thread.id,
  title: thread.title,
  organization: thread.organization,
  pullRequests: thread.pullRequests,
  linkedPullRequest: thread.linkedPullRequest,
  createdAtMs: DateTime.toEpochMillis(thread.createdAt),
});

const digest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

const failureReason = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    if ("cause" in cause && typeof cause.cause === "string") return cause.cause;
    if ("detail" in cause && typeof cause.detail === "string") return cause.detail;
    if ("message" in cause && typeof cause.message === "string") return cause.message;
  }
  return "The server could not verify the outcome.";
};

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const vcs = yield* GitManager.GitManager;
  const branchLookups = new Map<string, { at: number; value: OutcomePullRequest | null }>();

  /**
   * The pull request open from an implementation task's branch, linked or not. `undefined`
   * when the host could not be asked: the lead then waits for a later sweep, since only a real
   * "no pull request" answer may let it through. Failures are not cached.
   */
  const branchPullRequest = (
    thread: OrchestrationV2ThreadShell,
  ): Effect.Effect<OutcomePullRequest | null | undefined> =>
    Effect.gen(function* () {
      if (!thread.branch || !thread.worktreePath) return null;
      const key = `${thread.worktreePath}\0${thread.branch}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = branchLookups.get(key);
      if (cached && now - cached.at < BRANCH_LOOKUP_TTL_MS) return cached.value;
      const lookup = yield* vcs
        .branchPullRequest({ cwd: thread.worktreePath, branch: thread.branch })
        .pipe(Effect.result);
      if (lookup._tag === "Failure") {
        yield* Effect.logWarning("Organization branch pull request lookup failed", {
          threadId: thread.id,
          cause: lookup.failure,
        });
        return undefined;
      }
      const found = lookup.success;
      const parsed = found ? parseChangeRequestUrl(found.url) : null;
      const value: OutcomePullRequest | null =
        found === null
          ? null
          : {
              key: parsed
                ? threadPullRequestKeyOf({ ...parsed, url: found.url })
                : `url:${found.url}`,
              number: found.number,
              state: found.state,
            };
      branchLookups.set(key, { at: now, value });
      return value;
    });

  const notifyChief = (input: {
    readonly chief: OrchestrationV2ThreadShell;
    readonly lead: OrchestrationV2ThreadShell;
    readonly prefix: string;
    readonly key: string;
    readonly text: string;
    readonly summary: string;
  }) =>
    // A deterministic command id makes each notice once.
    threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:${input.prefix}${input.key}`),
        threadId: input.chief.id,
        messageId: MessageId.make(`${input.prefix}${input.key}`),
        senderThreadId: input.lead.id,
        text: `${input.text} This is coordinator evidence, not user approval. Report it only if the user must decide what happens next.`,
        notification: {
          source: { kind: "background_task" },
          outcome: "failed",
          summary: input.summary,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Organization outcome notice skipped", {
            threadId: input.lead.id,
            cause,
          }),
        ),
      );

  const sweepNow = Effect.fn("OrganizationOutcomeAcceptanceReactor.sweep")(function* (
    request: SweepRequest,
  ) {
    const snapshot = yield* threads.getShellSnapshot();
    const live = snapshot.threads.filter(
      (thread) =>
        thread.organization &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        (request.projectId === undefined || thread.projectId === request.projectId),
    );
    const byId = new Map(live.map((thread) => [thread.id, thread]));
    const candidates = live.map(outcomeThread);
    for (const lead of live) {
      if (lead.organization?.role !== "lead") continue;
      if (request.leadIds && !request.leadIds.has(lead.id)) continue;
      const task = lead.organization.task;
      const revision = task?.revision;
      if (!task || !revision) continue;
      let gate = organizationOutcomeGate(outcomeThread(lead), candidates);
      if (
        gate.kind === "accepted" ||
        gate.kind === "in_progress" ||
        gate.kind === "waiting_for_task"
      )
        continue;
      // A reviewed outcome: its executors' branches may carry pull requests nobody linked.
      const withBranches = yield* Effect.forEach(task.dependencyThreadIds, (id) =>
        Effect.gen(function* () {
          const thread = byId.get(id);
          if (!thread) return { thread: undefined, unknown: false };
          const found = yield* branchPullRequest(thread);
          return {
            thread: { ...outcomeThread(thread), branchPullRequest: found ?? null },
            unknown: found === undefined,
          };
        }),
      );
      // A branch the host could not be asked about may carry an open pull request.
      if (withBranches.some((entry) => entry.unknown)) continue;
      const enriched = [
        ...candidates.filter((thread) => !task.dependencyThreadIds.includes(thread.id)),
        ...withBranches.flatMap((entry) => (entry.thread ? [entry.thread] : [])),
      ];
      gate = organizationOutcomeGate(outcomeThread(lead), enriched);
      const chief = live.find(
        (thread) => thread.projectId === lead.projectId && thread.organization?.role === "chief",
      );
      if (gate.kind === "closed_pull_request") {
        if (chief)
          yield* notifyChief({
            chief,
            lead,
            prefix: ORGANIZATION_PULL_REQUEST_NOTICE_PREFIX,
            key: `${lead.id}:${revision}:${gate.pullRequest.key}`,
            text: `Organization update: ${lead.title}: PR #${gate.pullRequest.number} closed without merging; outcome not accepted.`,
            summary: `${lead.title}: PR #${gate.pullRequest.number} closed without merging`,
          });
        continue;
      }
      if (gate.kind !== "ready") continue;
      // Each attempt is its own command: the inputs it decided on and the hour name it. A
      // refusal the orchestrator records under that id cannot block a later attempt: changed
      // inputs retry at once, and a transient cause (a file read, a missing worktree) next hour.
      const attempt = digest(
        [
          revision,
          task.reviewedRevision,
          ...task.dependencyThreadIds.map((id) => {
            const dependency = byId.get(id)?.organization?.task;
            return [id, dependency?.state, dependency?.revision, dependency?.reviewedRevision].join(
              " ",
            );
          }),
          ...ownedOutcomePullRequests(outcomeThread(lead), enriched).map(
            (pullRequest) => `${pullRequest.key} ${pullRequest.state}`,
          ),
          String(Math.floor((yield* Clock.currentTimeMillis) / ATTEMPT_BUCKET_MS)),
        ].join("\n"),
      );
      const note = organizationAcceptanceNote(gate);
      // As the server, without an agent actor: agents can never accept an outcome. The same
      // verification as any acceptance runs first (artifact hashes, dependency reviews).
      const result = yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`server:organization-accept:${lead.id}:${revision}:${attempt}`),
          threadId: lead.id,
          organization: {
            ...lead.organization,
            task: { ...task, state: "accepted", notes: note },
          },
        })
        .pipe(Effect.result);
      if (result._tag === "Success") {
        if (request.trigger === "startup")
          yield* Effect.logInfo("Organization outcome accepted at startup", {
            threadId: lead.id,
            revision,
            reason: note,
          });
        continue;
      }
      const reason = failureReason(result.failure);
      yield* Effect.logWarning("Organization outcome acceptance refused", {
        threadId: lead.id,
        revision,
        reason,
      });
      if (chief)
        yield* notifyChief({
          chief,
          lead,
          prefix: ORGANIZATION_ACCEPTANCE_NOTICE_PREFIX,
          key: `${lead.id}:${revision}:${digest(reason)}`,
          text: `Organization update: ${lead.title}: the reviewed outcome could not be accepted: ${reason}`,
          summary: `${lead.title}: acceptance refused`,
        });
    }
  });

  const worker = yield* makeDrainableWorker((request: SweepRequest) =>
    sweepNow(request).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Organization outcome acceptance sweep failed", { cause }),
      ),
    ),
  );

  // Affected leads per project, swept together once a burst settles.
  const pending = yield* Ref.make(new Map<ProjectId, Set<ThreadId>>());
  const affectedLead = (thread: OrchestrationV2ThreadShell["organization"], id: ThreadId) =>
    thread?.role === "lead" ? id : (thread?.parentThreadId ?? undefined);

  const start = Effect.fn("OrganizationOutcomeAcceptanceReactor.start")(function* () {
    // Startup sweep: pull requests may have merged while the server was down.
    yield* worker.enqueue({ trigger: "startup" });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        switch (event.type) {
          // GitHub-side merges arrive through the pull request sync reactor.
          case "thread.pull-request-synced":
          case "thread.metadata-updated": {
            const lead = affectedLead(event.payload.organization, event.payload.id);
            if (lead === undefined) return Effect.void;
            const projectId = event.payload.projectId;
            return Ref.modify(pending, (current) => {
              const leads = current.get(projectId);
              if (leads) {
                leads.add(lead);
                return [false, current];
              }
              return [true, new Map(current).set(projectId, new Set([lead]))];
            }).pipe(
              Effect.flatMap((first) =>
                first
                  ? Effect.sleep(SWEEP_DEBOUNCE).pipe(
                      Effect.andThen(
                        Ref.modify(pending, (current) => {
                          const next = new Map(current);
                          const leads = next.get(projectId);
                          next.delete(projectId);
                          return [leads, next];
                        }),
                      ),
                      Effect.flatMap((leadIds) =>
                        worker.enqueue({ projectId, leadIds, trigger: "event" }),
                      ),
                      Effect.forkDetach,
                      Effect.asVoid,
                    )
                  : Effect.void,
              ),
            );
          }
          default:
            return Effect.void;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Organization outcome acceptance event stream failed", { cause }),
        ),
      ),
    );
  });

  return {
    start,
    sweep: (projectId?: ProjectId) =>
      worker.enqueue({ projectId, trigger: "manual" }).pipe(Effect.andThen(worker.drain)),
    drain: worker.drain,
  } satisfies OrganizationOutcomeAcceptanceReactor["Service"];
});

export const layer = Layer.effect(OrganizationOutcomeAcceptanceReactor, make);
