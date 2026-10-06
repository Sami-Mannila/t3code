import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrganizationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const NOW = DateTime.makeUnsafe("2026-10-06T12:00:00.000Z");
type TaskState = NonNullable<OrganizationThread["task"]>["state"];

function shell(
  id: string,
  organization: OrganizationThread | null,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    ...(organization === null ? {} : { organization }),
    projectId: ProjectId.make("project"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const task = (owner: string, state: TaskState): NonNullable<OrganizationThread["task"]> => ({
  title: owner,
  ownerThreadId: ThreadId.make(owner),
  dependencyThreadIds: [],
  state,
  revision: null,
  reviewedRevision: null,
  reviewerThreadId: null,
  notes: null,
});
const role = (
  kind: OrganizationThread["role"],
  parent: string | null,
  state?: TaskState,
  owner?: string,
): OrganizationThread => ({
  role: kind,
  parentThreadId: parent === null ? null : ThreadId.make(parent),
  ...(state === undefined ? {} : { task: task(owner ?? "unused", state) }),
});

/** Chief → lead-a (accepted) → executor-a1, executor-a2, reviewer-a; lead-b → executor-b. */
const organization = (leadState: TaskState = "accepted") => [
  shell("chief", role("chief", null)),
  shell("lead-a", role("lead", "chief", leadState, "lead-a")),
  shell("executor-a1", role("executor", "lead-a", "accepted", "executor-a1")),
  shell("executor-a2", role("executor", "lead-a", "accepted", "executor-a2")),
  shell("reviewer-a", role("reviewer", "lead-a")),
  shell("lead-b", role("lead", "chief", "accepted", "lead-b")),
  shell("executor-b", role("executor", "lead-b", "working", "executor-b")),
  shell("plain", null),
];

/** `failOnce` (`"<command type>:<thread id>"`) fails that per-thread command the first time. */
const harness = (threads: Array<OrchestrationV2ThreadShell>, failOnce?: string) => {
  const dispatched: Array<string> = [];
  let failed = false;
  const layer = ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getShellSnapshot: (options) =>
          Effect.succeed({
            schemaVersion: 2,
            snapshotSequence: 7,
            threads: threads.filter(
              (thread) => (thread.archivedAt !== null) === (options?.location === "archive"),
            ),
          } as never),
        dispatch: (command) =>
          Effect.suspend(() => {
            if (command.type !== "thread.archive" && command.type !== "thread.unarchive")
              throw new Error(`unexpected ${command.type}`);
            const key = `${command.type}:${command.threadId}`;
            if (key === failOnce && !failed) {
              failed = true;
              return Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "injected failure",
                }),
              );
            }
            dispatched.push(key);
            const index = threads.findIndex((thread) => thread.id === command.threadId);
            threads[index] = {
              ...threads[index]!,
              archivedAt: command.type === "thread.archive" ? NOW : null,
            };
            return Effect.succeed({ sequence: 8, storedEvents: [] });
          }),
      }),
    ),
  );
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.dispatch(command);
    }).pipe(Effect.provide(layer));
  return { dispatched, dispatch, threads };
};

const workstream = (
  type: "thread.workstream.archive" | "thread.workstream.unarchive",
  threadId: string,
  extra: { readonly organizationActorThreadId?: ThreadId } = {},
) =>
  ({
    type,
    commandId: CommandId.make(`command:${type}:${threadId}`),
    threadId: ThreadId.make(threadId),
    ...extra,
  }) satisfies OrchestrationV2ServerCommand;

describe("workstream archive", () => {
  it.effect("archives the lead after its executors and reviewers, and nothing else", () =>
    Effect.gen(function* () {
      const { dispatch, dispatched, threads } = harness(organization());
      yield* dispatch(workstream("thread.workstream.archive", "lead-a"));
      expect(dispatched).toEqual([
        "thread.archive:executor-a1",
        "thread.archive:executor-a2",
        "thread.archive:reviewer-a",
        "thread.archive:lead-a",
      ]);
      expect(
        threads.filter((thread) => thread.archivedAt !== null).map((thread) => thread.id),
      ).toEqual(["lead-a", "executor-a1", "executor-a2", "reviewer-a"]);

      // A retry, or a retry after an interruption, only finishes what is left.
      yield* dispatch(workstream("thread.workstream.archive", "lead-a"));
      expect(dispatched).toHaveLength(4);

      dispatched.length = 0;
      yield* dispatch(workstream("thread.workstream.unarchive", "lead-a"));
      expect(dispatched).toEqual([
        "thread.unarchive:executor-a1",
        "thread.unarchive:executor-a2",
        "thread.unarchive:reviewer-a",
        "thread.unarchive:lead-a",
      ]);
      expect(threads.every((thread) => thread.archivedAt === null)).toBe(true);
    }),
  );

  it.effect("finishes an interrupted archive without replaying archived threads", () =>
    Effect.gen(function* () {
      const threads = organization();
      threads[2] = { ...threads[2]!, archivedAt: NOW };
      const { dispatch, dispatched } = harness(threads);
      yield* dispatch(workstream("thread.workstream.archive", "lead-a"));
      expect(dispatched).toEqual([
        "thread.archive:executor-a2",
        "thread.archive:reviewer-a",
        "thread.archive:lead-a",
      ]);
    }),
  );

  it.effect("keeps the lead archived when a restore fails partway, so a retry finishes it", () =>
    Effect.gen(function* () {
      const threads = organization().map((thread) =>
        ["lead-a", "executor-a1", "executor-a2", "reviewer-a"].includes(thread.id)
          ? { ...thread, archivedAt: NOW }
          : thread,
      );
      const { dispatch, dispatched } = harness(threads, "thread.unarchive:executor-a2");
      yield* Effect.flip(dispatch(workstream("thread.workstream.unarchive", "lead-a")));
      expect(dispatched).toEqual(["thread.unarchive:executor-a1"]);
      expect(threads.find((thread) => thread.id === "lead-a")?.archivedAt).toBe(NOW);

      yield* dispatch(workstream("thread.workstream.unarchive", "lead-a"));
      expect(dispatched).toEqual([
        "thread.unarchive:executor-a1",
        "thread.unarchive:executor-a2",
        "thread.unarchive:reviewer-a",
        "thread.unarchive:lead-a",
      ]);
      expect(threads.every((thread) => thread.archivedAt === null)).toBe(true);
    }),
  );

  it.effect("archives an idle workstream whatever its lead's task state", () =>
    Effect.gen(function* () {
      for (const state of ["queued", "blocked", "awaiting_review", "changes_requested"] as const) {
        const { dispatch, dispatched } = harness(organization(state));
        yield* dispatch(workstream("thread.workstream.archive", "lead-a"));
        expect(dispatched.at(-1), state).toBe("thread.archive:lead-a");
      }
    }),
  );

  it.effect("refuses while work runs, or for agents", () =>
    Effect.gen(function* () {
      const refused = (
        threads: Array<OrchestrationV2ThreadShell>,
        command: OrchestrationV2ServerCommand,
      ) =>
        Effect.gen(function* () {
          const { dispatch, dispatched } = harness(threads);
          const error = yield* Effect.flip(dispatch(command));
          expect(dispatched).toEqual([]);
          return String((error as { readonly cause?: unknown }).cause);
        });

      const running = organization();
      running[3] = { ...running[3]!, status: "running" };
      expect(yield* refused(running, workstream("thread.workstream.archive", "lead-a"))).toContain(
        "executor-a2",
      );
      const pending = organization();
      pending[4] = {
        ...pending[4]!,
        pendingRuntimeRequest: { id: "request" as never, kind: "user_input", createdAt: NOW },
      };
      expect(yield* refused(pending, workstream("thread.workstream.archive", "lead-a"))).toContain(
        "reviewer-a",
      );
      expect(
        yield* refused(
          organization(),
          workstream("thread.workstream.archive", "lead-a", {
            organizationActorThreadId: ThreadId.make("chief"),
          }),
        ),
      ).toContain("Only the user");
      expect(
        yield* refused(organization(), workstream("thread.workstream.archive", "executor-a1")),
      ).toContain("lead");
    }),
  );
});
