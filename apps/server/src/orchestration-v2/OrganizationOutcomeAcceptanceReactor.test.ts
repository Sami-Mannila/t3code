import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrganizationThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as GitManager from "../git/GitManager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as OrganizationOutcomeAcceptanceReactor from "./OrganizationOutcomeAcceptanceReactor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

class TestFailure extends Schema.TaggedError<TestFailure>()("TestFailure", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const projectId = ProjectId.make("reactor-project");
const chief = ThreadId.make("reactor-chief"),
  lead = ThreadId.make("reactor-lead"),
  executor = ThreadId.make("reactor-executor");

const shell = (id: ThreadId, organization: OrganizationThread, patch = {}) =>
  ({
    id,
    projectId,
    title: id,
    organization,
    pullRequests: [],
    archivedAt: null,
    deletedAt: null,
    branch: null,
    worktreePath: null,
    createdAt: DateTime.makeUnsafe(0),
    ...patch,
  }) as unknown as OrchestrationV2ThreadShell;

const reviewed = {
  title: "Work",
  dependencyThreadIds: [],
  state: "accepted" as const,
  revision: "r1",
  reviewedRevision: "r1",
  reviewerThreadId: ThreadId.make("reactor-reviewer"),
  notes: null,
};
const organization = [
  shell(chief, { role: "chief", parentThreadId: null }),
  shell(lead, {
    role: "lead",
    parentThreadId: chief,
    task: {
      ...reviewed,
      ownerThreadId: lead,
      dependencyThreadIds: [executor],
      state: "awaiting_review",
    },
  }),
  shell(
    executor,
    { role: "executor", parentThreadId: lead, task: { ...reviewed, ownerThreadId: executor } },
    { branch: "t3/organization/work", worktreePath: "/worktrees/work" },
  ),
];

/** A reactor over a fixed organization; `accept` decides each acceptance dispatch. */
const harness = (input: {
  readonly branchLookup: () => Effect.Effect<GitManager.GitBranchPullRequest | null, TestFailure>;
  readonly accept: (commandId: string) => Effect.Effect<void, TestFailure>;
}) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const reactor = yield* OrganizationOutcomeAcceptanceReactor.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: () => input.branchLookup() as never,
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({ snapshotSequence: 1, threads: organization } as never),
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "thread.metadata.update")
                  yield* input.accept(command.commandId).pipe(Effect.mapError(() => ({}) as never));
                return { sequence: dispatched.length, storedEvents: [] };
              }),
          }),
        ),
      ),
    );
    const of = (type: string) => dispatched.filter((command) => command.type === type);
    return { reactor, dispatched, of };
  });

it.effect("waits when an executor branch's pull request cannot be looked up", () =>
  Effect.gen(function* () {
    let reachable = false;
    const { reactor, of } = yield* harness({
      branchLookup: () =>
        reachable
          ? Effect.succeed(null)
          : Effect.fail(new TestFailure({ reason: "host unreachable" })),
      accept: () => Effect.void,
    });
    yield* reactor.sweep();
    // A failed lookup is not "no pull request": nothing is accepted, and it is not cached.
    assert.lengthOf(of("thread.metadata.update"), 0);
    reachable = true;
    yield* reactor.sweep();
    assert.lengthOf(of("thread.metadata.update"), 1);
  }),
);

it.effect("tells the Chief once when an executor branch keeps failing to be checked", () =>
  Effect.gen(function* () {
    const { reactor, of } = yield* harness({
      branchLookup: () => Effect.fail(new TestFailure({ reason: "gh: authentication required" })),
      accept: () => Effect.void,
    });
    yield* reactor.sweep();
    yield* reactor.sweep();
    assert.lengthOf(of("message.dispatch"), 0);
    yield* reactor.sweep();
    yield* reactor.sweep();
    const notices = of("message.dispatch");
    assert.lengthOf(notices, 1);
    const notice = notices[0] as Extract<
      OrchestrationV2ServerCommand,
      { type: "message.dispatch" }
    >;
    assert.equal(notice.threadId, chief);
    assert.include(notice.text, `can't check PRs for ${executor}`);
    assert.include(notice.text, "authentication required");
    // Still holding: nothing was accepted.
    assert.lengthOf(of("thread.metadata.update"), 0);
  }),
);

it.effect("tells the Chief when an executor branch has failed to be checked for an hour", () =>
  Effect.gen(function* () {
    const { reactor, of } = yield* harness({
      branchLookup: () => Effect.fail(new TestFailure({ reason: "host unreachable" })),
      accept: () => Effect.void,
    });
    yield* reactor.sweep();
    yield* TestClock.adjust("61 minutes");
    yield* reactor.sweep();
    assert.lengthOf(of("message.dispatch"), 1);
  }),
);

it.effect("retries an acceptance the orchestrator refused under its command id", () =>
  Effect.gen(function* () {
    // A refusal is recorded under its command id, as a rejected receipt is.
    const refused = new Set<string>();
    let transient = true;
    const { reactor, of } = yield* harness({
      branchLookup: () => Effect.succeed(null),
      accept: (commandId) => {
        if (refused.has(commandId))
          return Effect.fail(new TestFailure({ reason: "Previously rejected." }));
        if (transient) {
          transient = false;
          refused.add(commandId);
          return Effect.fail(new TestFailure({ reason: "Worktree is missing." }));
        }
        return Effect.void;
      },
    });
    yield* reactor.sweep();
    yield* reactor.sweep();
    const attempts = of("thread.metadata.update").map((command) => command.commandId);
    assert.lengthOf(attempts, 2);
    assert.equal(attempts[0], attempts[1]);
    // The Chief hears a reason once, however often the attempt is refused.
    const reasons = new Set(of("message.dispatch").map((command) => command.commandId));
    assert.equal(reasons.size, 1);
    yield* TestClock.adjust("1 hour");
    yield* reactor.sweep();
    const retried = of("thread.metadata.update").map((command) => command.commandId);
    assert.lengthOf(retried, 3);
    assert.notEqual(retried[2], attempts[0]);
    assert.isFalse(refused.has(retried[2]!));
  }),
);
