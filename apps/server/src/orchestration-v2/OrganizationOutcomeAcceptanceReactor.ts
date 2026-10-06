import {
  organizationAcceptanceNote,
  organizationOutcomeGate,
  type OutcomeThread,
} from "@t3tools/shared/organizationOutcome";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ORGANIZATION_PULL_REQUEST_NOTICE_PREFIX } from "./OrganizationPolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Accepts organization outcomes for the user. Pull requests are the gate when the user's
 * acceptance matters: a reviewed outcome is accepted once every pull request it owns merged, or
 * on its independent review alone when it opened none. A pull request closed without merging
 * holds the outcome and tells the Chief once.
 */
export class OrganizationOutcomeAcceptanceReactor extends Context.Service<
  OrganizationOutcomeAcceptanceReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Sweeps one project, or every project when omitted. */
    readonly sweep: (projectId?: ProjectId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/OrganizationOutcomeAcceptanceReactor") {}

const outcomeThread = (thread: OrchestrationV2ThreadShell): OutcomeThread => ({
  id: thread.id,
  title: thread.title,
  organization: thread.organization,
  pullRequests: thread.pullRequests,
  createdAtMs: DateTime.toEpochMillis(thread.createdAt),
});

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const sweepNow = Effect.fn("OrganizationOutcomeAcceptanceReactor.sweep")(function* (
    projectId: ProjectId | undefined,
  ) {
    const snapshot = yield* threads.getShellSnapshot();
    const live = snapshot.threads.filter(
      (thread) =>
        thread.organization &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        (projectId === undefined || thread.projectId === projectId),
    );
    const candidates = live.map(outcomeThread);
    for (const lead of live) {
      if (lead.organization?.role !== "lead") continue;
      const gate = organizationOutcomeGate(outcomeThread(lead), candidates);
      const task = lead.organization.task!;
      const revision = task.revision;
      if (gate.kind === "ready" && revision) {
        // As the server, without an agent actor: agents can never accept an outcome.
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`server:organization-accept:${lead.id}:${revision}`),
            threadId: lead.id,
            organization: {
              ...lead.organization,
              task: { ...task, state: "accepted", notes: organizationAcceptanceNote(gate) },
            },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Organization outcome acceptance skipped", {
                threadId: lead.id,
                cause,
              }),
            ),
          );
      }
      if (gate.kind === "closed_pull_request" && revision) {
        const chief = live.find(
          (thread) => thread.projectId === lead.projectId && thread.organization?.role === "chief",
        );
        if (!chief) continue;
        const key = `${lead.id}:${revision}:${gate.pullRequest.key}`;
        // A deterministic command id makes the notice once per revision and pull request.
        yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:organization-pr-closed:${key}`),
            threadId: chief.id,
            messageId: MessageId.make(`${ORGANIZATION_PULL_REQUEST_NOTICE_PREFIX}${key}`),
            senderThreadId: lead.id,
            text: `Organization update: ${lead.title}: PR #${gate.pullRequest.number} closed without merging; outcome not accepted. This is coordinator evidence, not user approval. Report it only if the user must decide what happens next.`,
            notification: {
              source: { kind: "background_task" },
              outcome: "failed",
              summary: `${lead.title}: PR #${gate.pullRequest.number} closed without merging`,
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Organization pull request notice skipped", {
                threadId: lead.id,
                cause,
              }),
            ),
          );
      }
    }
  });

  const worker = yield* makeDrainableWorker((projectId: ProjectId | undefined) =>
    sweepNow(projectId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Organization outcome acceptance sweep failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("OrganizationOutcomeAcceptanceReactor.start")(function* () {
    // Startup sweep: pull requests may have merged while the server was down.
    yield* worker.enqueue(undefined);
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        switch (event.type) {
          // GitHub-side merges arrive through the pull request sync reactor.
          case "thread.pull-request-synced":
          case "thread.metadata-updated":
            return event.payload.organization
              ? worker.enqueue(event.payload.projectId)
              : Effect.void;
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
    sweep: (projectId?: ProjectId) => worker.enqueue(projectId).pipe(Effect.andThen(worker.drain)),
    drain: worker.drain,
  } satisfies OrganizationOutcomeAcceptanceReactor["Service"];
});

export const layer = Layer.effect(OrganizationOutcomeAcceptanceReactor, make);
