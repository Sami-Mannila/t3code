import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrganizationThread,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as OrganizationWorkspace from "./OrganizationWorkspace.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const PlatformLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner.run({
      command: "git",
      args: ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
      cwd,
      timeout: "10 seconds",
      maxOutputBytes: 1024 * 1024,
    });
  });

const makeRepository = (directory: string, commit = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true });
    assert.equal((yield* git(directory, "init")).code, 0);
    if (commit)
      assert.equal((yield* git(directory, "commit", "--allow-empty", "-m", "fixture")).code, 0);
  });

/** A plain folder holding repositories `a` and `b`, a commit-less repository and a plain folder. */
const multiRepositoryRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  yield* makeRepository(`${root}/a`);
  yield* makeRepository(`${root}/b`);
  yield* makeRepository(`${root}/empty`, false);
  yield* fs.makeDirectory(`${root}/a/src`);
  yield* fs.makeDirectory(`${root}/notes`);
  return root;
});

const rejection = (workspaceRoot: string, repository: string) =>
  OrganizationWorkspace.resolveRepository({ workspaceRoot, repository }).pipe(
    Effect.flatMap((resolved) => Effect.die(`expected a rejection, resolved ${resolved}`)),
    Effect.catchTag("OrganizationRepositoryError", Effect.succeed),
    Effect.orDie,
  );

it.layer(PlatformLayer)("OrganizationWorkspace.resolveRepository", (it) => {
  it.effect('accepts a project root that is itself a repository as "."', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* makeRepository(root);
      assert.equal(
        yield* OrganizationWorkspace.resolveRepository({ workspaceRoot: root, repository: "." }),
        root,
      );
    }),
  );

  it.effect("resolves a named repository under a plain folder root", () =>
    Effect.gen(function* () {
      const root = yield* multiRepositoryRoot;
      assert.equal(
        yield* OrganizationWorkspace.resolveRepository({ workspaceRoot: root, repository: "b" }),
        `${root}/b`,
      );
    }),
  );

  it.effect("rejects a plain folder root and lists the repositories under it", () =>
    Effect.gen(function* () {
      const root = yield* multiRepositoryRoot;
      const error = yield* rejection(root, ".");
      assert.include(error.reason, "is not a Git repository");
      assert.deepEqual(error.candidates, ["a", "b", "empty"]);
      assert.include(error.message, '"a", "b", "empty"');
      assert.include((yield* rejection(root, "notes")).reason, "is not a Git repository");
      assert.include((yield* rejection(root, "missing")).reason, "does not exist");
    }),
  );

  it.effect("rejects a repository without a commit and a folder inside a repository", () =>
    Effect.gen(function* () {
      const root = yield* multiRepositoryRoot;
      assert.include((yield* rejection(root, "empty")).reason, "has no commits");
      assert.include((yield* rejection(root, "a/src")).reason, "is a folder inside");
    }),
  );

  it.effect("rejects paths and symlinks that leave the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* multiRepositoryRoot;
      const outside = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* makeRepository(outside);
      yield* fs.symlink(outside, `${root}/escape`);
      for (const repository of ["../b", outside, "a/../b", "./a", "a/.git"])
        assert.include(
          (yield* rejection(root, repository)).reason,
          "not a normalized path",
          repository,
        );
      assert.include((yield* rejection(root, "escape")).reason, "outside the project root");
    }),
  );

  it.effect("lists at most twenty candidate repositories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      for (let i = 0; i < 25; i++) {
        const name = `${root}/repo-${String(i).padStart(2, "0")}`;
        yield* fs.makeDirectory(name);
        yield* fs.writeFileString(`${name}/.git`, "");
      }
      assert.equal((yield* rejection(root, "nothing")).candidates.length, 20);
    }),
  );
});

const projectId = ProjectId.make("workspace-project");
const runId = RunId.make("workspace-run");
const threadId = ThreadId.make("workspace-thread");
let prepared = 0;

/** Runs prepare against a fresh thread, recording the commands it dispatches. */
const prepareThread = (input: {
  readonly workspaceRoot: string;
  readonly organization: OrganizationThread;
  readonly baseRef?: string;
  readonly threadId?: ThreadId;
}) =>
  Effect.gen(function* () {
    // Worktree paths derive from the thread ID, and the suite shares one worktrees directory.
    const threadId = input.threadId ?? ThreadId.make(`workspace-thread-${prepared++}`);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const projection = {
      thread: {
        id: threadId,
        projectId,
        organization: input.organization,
        worktreePath: null,
        branch: null,
      },
      runs: [
        {
          id: runId,
          status: "preparing",
          workspacePreparation: { type: "worktree", baseRef: input.baseRef ?? "HEAD" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const exit = yield* OrganizationWorkspace.prepare({
      commandId: CommandId.make("workspace-prepare"),
      threadId,
      runId,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(projection),
            dispatch: (command) =>
              Ref.update(dispatched, (all) => [...all, command]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot: input.workspaceRoot } as never)),
          }),
        ),
      ),
      Effect.exit,
    );
    return { exit, dispatched: yield* Ref.get(dispatched) };
  });

const task = (repository?: string): NonNullable<OrganizationThread["task"]> => ({
  title: "Work",
  ...(repository === undefined ? {} : { repository }),
  ownerThreadId: threadId,
  dependencyThreadIds: [],
  state: "queued",
  revision: null,
  reviewedRevision: null,
  reviewerThreadId: null,
  notes: null,
});

it.layer(
  Layer.merge(
    PlatformLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-organization-workspace-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
)("OrganizationWorkspace.prepare", (it) => {
  it.effect("creates an executor's worktree and branch in its task's repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* multiRepositoryRoot;
      const { exit, dispatched } = yield* prepareThread({
        workspaceRoot: root,
        organization: { role: "executor", parentThreadId: ThreadId.make("lead"), task: task("b") },
      });
      assert.equal(exit._tag, "Success");
      assert.deepEqual(
        dispatched.map((command) => command.type),
        ["thread.metadata.update", "prepared-run.release"],
      );
      const metadata = dispatched[0] as Extract<
        OrchestrationV2ServerCommand,
        { readonly type: "thread.metadata.update" }
      >;
      const worktree = metadata.worktreePath!;
      assert.match(metadata.branch!, /^t3\/organization\/[0-9a-f]{24}$/);
      const common = yield* git(
        worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      );
      assert.equal(yield* fs.realPath(common.stdout.trim()), `${root}/b/.git`);
      assert.equal((yield* git(`${root}/b`, "rev-parse", "--verify", metadata.branch!)).code, 0);
      assert.notEqual((yield* git(`${root}/a`, "rev-parse", "--verify", metadata.branch!)).code, 0);
    }),
  );

  it.effect("leads and reviewers reach release without a worktree, even in a plain folder", () =>
    Effect.gen(function* () {
      const root = yield* multiRepositoryRoot;
      for (const organization of [
        { role: "lead", parentThreadId: ThreadId.make("chief"), task: task() },
        { role: "reviewer", parentThreadId: ThreadId.make("lead") },
      ] satisfies ReadonlyArray<OrganizationThread>) {
        const { exit, dispatched } = yield* prepareThread({ workspaceRoot: root, organization });
        assert.equal(exit._tag, "Success");
        assert.deepEqual(
          dispatched.map((command) => command.type),
          ["prepared-run.release"],
        );
      }
    }),
  );

  it.effect("deterministic failures are not retryable and carry the real cause", () =>
    Effect.gen(function* () {
      const root = yield* multiRepositoryRoot;
      const executor = (repository: string): OrganizationThread => ({
        role: "executor",
        parentThreadId: ThreadId.make("lead"),
        task: task(repository),
      });
      const notRepository = yield* prepareThread({
        workspaceRoot: root,
        organization: executor("."),
      });
      const badRef = yield* prepareThread({
        workspaceRoot: root,
        organization: executor("a"),
        baseRef: "no-such-ref",
      });
      const failure = (exit: typeof badRef.exit) =>
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      for (const { exit, dispatched } of [notRepository, badRef]) {
        assert.isTrue(OrganizationWorkspace.isTerminalWorkspaceFailure(failure(exit)));
        assert.deepEqual(dispatched, []);
      }
      const notRepositoryError = failure(notRepository.exit) as Error;
      assert.include(notRepositoryError.message, "is not a Git repository");
      assert.include(notRepositoryError.message, '"a", "b", "empty"');
      const badRefError = failure(badRef.exit) as OrganizationWorkspace.OrganizationWorkspaceError;
      assert.include(badRefError.reason, "git worktree add");
      assert.include(badRefError.detail, "no-such-ref");
    }),
  );

  it.effect("lock contention with another Git process in the repository stays retryable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* multiRepositoryRoot;
      const threadId = ThreadId.make(`workspace-thread-${prepared++}`);
      // A concurrent preparation holding this task's branch ref lock.
      const key = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24);
      yield* fs.makeDirectory(`${root}/b/.git/refs/heads/t3/organization`, { recursive: true });
      yield* fs.writeFileString(`${root}/b/.git/refs/heads/t3/organization/${key}.lock`, "");
      const { exit, dispatched } = yield* prepareThread({
        workspaceRoot: root,
        threadId,
        organization: { role: "executor", parentThreadId: ThreadId.make("lead"), task: task("b") },
      });
      assert.deepEqual(dispatched, []);
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      assert.instanceOf(error, OrganizationWorkspace.OrganizationWorkspaceError);
      assert.include((error as OrganizationWorkspace.OrganizationWorkspaceError).detail, ".lock");
      assert.isFalse(OrganizationWorkspace.isTerminalWorkspaceFailure(error));
    }),
  );
});

it("classifies only Git lock contention as transient", () => {
  for (const stderr of [
    "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
    "error: could not lock config file .git/config: File exists",
    "fatal: cannot lock ref 'refs/heads/t3/organization/abc': Unable to create '/repo/.git/refs/heads/t3/organization/abc.lock': File exists.",
  ])
    assert.isTrue(OrganizationWorkspace.isGitLockContention(stderr), stderr);
  for (const stderr of [
    "fatal: not a git repository (or any of the parent directories): .git",
    "fatal: invalid reference: no-such-ref",
    "fatal: a branch named 't3/organization/abc' already exists",
    "fatal: '/worktrees/abc' already exists",
    "",
  ])
    assert.isFalse(OrganizationWorkspace.isGitLockContention(stderr), stderr);
});
