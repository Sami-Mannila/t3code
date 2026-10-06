// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  type OrganizationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";
import {
  IDLE_WORKTREE_RETENTION_MS,
  idleWorktreeRemovable,
  make as makeStorageCleanup,
  unsavedWorktreeEntries,
} from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";

const NOW_MS = Date.parse("2026-10-06T12:00:00.000Z");
const PROJECT_ID = ProjectId.make("project-idle-worktrees");

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: `/worktrees/${id}`,
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
    branch: `t3/${id}`,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: DateTime.makeUnsafe(NOW_MS - 2 * IDLE_WORKTREE_RETENTION_MS),
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW_MS - 3 * IDLE_WORKTREE_RETENTION_MS),
    updatedAt: DateTime.makeUnsafe(NOW_MS - 2 * IDLE_WORKTREE_RETENTION_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("idle worktree eligibility", () => {
  type TaskState = NonNullable<OrganizationThread["task"]>["state"];
  const task = (owner: string, state: TaskState): NonNullable<OrganizationThread["task"]> => ({
    title: "Task",
    ownerThreadId: ThreadId.make(owner),
    dependencyThreadIds: [],
    state,
    revision: null,
    reviewedRevision: null,
    reviewerThreadId: null,
    notes: null,
  });
  const settledAt = DateTime.makeUnsafe(NOW_MS - IDLE_WORKTREE_RETENTION_MS);
  const none = new Map<string, OrchestrationV2ThreadShell>();
  const removable = (
    thread: OrchestrationV2ThreadShell,
    others: ReadonlyArray<OrchestrationV2ThreadShell> = [],
  ) => idleWorktreeRemovable(thread, NOW_MS, new Map(others.map((other) => [other.id, other])));

  it("prunes ordinary threads only once they are settled and quiet for an hour", () => {
    expect(idleWorktreeRemovable(shell("unsettled"), NOW_MS, none)).toBe(false);
    expect(removable(shell("settled", { settledAt }))).toBe(true);
    expect(removable(shell("pinned-settled", { settledOverride: "settled" }))).toBe(true);
    const recent = DateTime.makeUnsafe(NOW_MS - IDLE_WORKTREE_RETENTION_MS / 2);
    expect(removable(shell("recent", { settledAt, latestRunCompletedAt: recent }))).toBe(false);
    expect(removable(shell("running", { settledAt, status: "running" }))).toBe(false);
  });

  it("prunes organization reviewers, leads and executors that are not working", () => {
    const org = (organization: OrganizationThread) => removable(shell("org", { organization }));
    expect(org({ role: "reviewer", parentThreadId: ThreadId.make("lead") })).toBe(true);
    expect(org({ role: "lead", parentThreadId: ThreadId.make("chief") })).toBe(true);
    expect(org({ role: "chief", parentThreadId: null })).toBe(false);
    const executor = (state: TaskState): OrganizationThread => ({
      role: "executor",
      parentThreadId: ThreadId.make("lead"),
      task: task("executor", state),
    });
    expect(org(executor("working"))).toBe(false);
    for (const state of ["queued", "blocked", "changes_requested"] as const) {
      expect(org(executor(state))).toBe(true);
    }
  });

  it("keeps submitted and accepted executor work until its lead's outcome is final", () => {
    const lead = (state: TaskState, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
      shell("lead", {
        organization: {
          role: "lead",
          parentThreadId: ThreadId.make("chief"),
          task: task("lead", state),
        },
        ...overrides,
      });
    for (const state of ["awaiting_review", "accepted"] as const) {
      const child = shell("executor", {
        organization: {
          role: "executor",
          parentThreadId: ThreadId.make("lead"),
          task: task("executor", state),
        },
      });
      expect(removable(child, [lead("working")])).toBe(false);
      expect(removable(child, [lead("awaiting_review")])).toBe(false);
      // An unknown lead cannot vouch for its outcome.
      expect(removable(child)).toBe(false);
      expect(removable(child, [lead("accepted")])).toBe(true);
      expect(removable(child, [lead("working", { archivedAt: settledAt })])).toBe(true);
      expect(removable({ ...child, archivedAt: settledAt }, [lead("working")])).toBe(true);
    }
  });

  it("allows only reproducible caches among untracked and ignored files", () => {
    expect(unsavedWorktreeEntries("")).toEqual([]);
    expect(unsavedWorktreeEntries("!! node_modules/\0!! pkg/__pycache__/\0!! .venv/\0")).toEqual(
      [],
    );
    expect(unsavedWorktreeEntries("!! dist/\0?? notes.md\0 M README.md\0")).toEqual([
      "!! dist/",
      "?? notes.md",
      " M README.md",
    ]);
  });
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

describe("idle worktree removal", () => {
  it.effect("removes clean idle worktrees, keeps the rest and their branches", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-idle-worktree-repo-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(repo, { recursive: true, force: true })),
      );
      git(repo, "init", "-b", "main");
      NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "hello\n");
      NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), "dist/\nnode_modules/\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "init");
      NodeFS.mkdirSync(config.worktreesDir, { recursive: true });
      const worktreesDir = NodeFS.realpathSync(config.worktreesDir);
      const names = [
        "clean",
        "caches",
        "dirty",
        "untracked",
        "output",
        "active",
        "recent",
        "unsettled",
        "queued",
      ];
      const worktree = (name: string) => NodePath.join(worktreesDir, name);
      for (const name of names) git(repo, "worktree", "add", "-b", `t3/${name}`, worktree(name));
      NodeFS.mkdirSync(NodePath.join(worktree("caches"), "node_modules", "pkg"), {
        recursive: true,
      });
      NodeFS.writeFileSync(NodePath.join(worktree("caches"), "node_modules", "pkg", "i.js"), "");
      NodeFS.writeFileSync(NodePath.join(worktree("dirty"), "README.md"), "changed\n");
      NodeFS.writeFileSync(NodePath.join(worktree("untracked"), "notes.md"), "draft\n");
      NodeFS.mkdirSync(NodePath.join(worktree("output"), "dist"));
      NodeFS.writeFileSync(NodePath.join(worktree("output"), "dist", "report.json"), "{}");

      threads.splice(
        0,
        threads.length,
        ...names.map((name) =>
          shell(name, {
            worktreePath: worktree(name),
            settledAt: name === "unsettled" ? null : DateTime.makeUnsafe(NOW_MS - 1),
            ...(name === "active"
              ? { status: "running" as const, activeRunId: null }
              : name === "recent"
                ? {
                    latestRunCompletedAt: DateTime.makeUnsafe(
                      NOW_MS - IDLE_WORKTREE_RETENTION_MS / 2,
                    ),
                  }
                : {}),
          }),
        ),
      );
      projects.splice(0, projects.length, { id: PROJECT_ID, workspaceRoot: repo });

      // The shell still reads idle, but a run was queued after it was read.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, payload_json
        )
        VALUES (
          'run:queued', ${ThreadId.make("queued")}, 1, 'codex', 'queued',
          '1970-01-01T00:00:00.000Z', '{}'
        )
      `;

      const cleanup = yield* makeStorageCleanup;
      assert.equal(yield* cleanup.cleanIdleWorktrees(NOW_MS), 2);

      const remaining = names.filter((name) => NodeFS.existsSync(worktree(name)));
      expect(remaining).toEqual([
        "dirty",
        "untracked",
        "output",
        "active",
        "recent",
        "unsettled",
        "queued",
      ]);
      expect(
        NodeFS.readFileSync(NodePath.join(worktree("output"), "dist", "report.json"), "utf8"),
      ).toBe("{}");
      for (const name of names) {
        expect(git(repo, "branch", "--list", `t3/${name}`)).toContain(`t3/${name}`);
      }
      expect(invalidated).toEqual([worktree("clean"), worktree("caches")]);

      // A resumed thread checks its branch out again, as ProviderTurnStartService does.
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.pruneWorktrees({ cwd: repo });
      yield* driver.createWorktree({ cwd: repo, refName: "t3/clean", path: worktree("clean") });
      expect(git(worktree("clean"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("t3/clean");
      expect(NodeFS.readFileSync(NodePath.join(worktree("clean"), "README.md"), "utf8")).toBe(
        "hello\n",
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

const threads: Array<OrchestrationV2ThreadShell> = [];
const projects: Array<{ readonly id: ProjectId; readonly workspaceRoot: string }> = [];
const invalidated: Array<string> = [];

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-idle-worktrees-test-",
}).pipe(Layer.provide(NodeServices.layer));
const gitDriverLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(configLayer),
);
const TestLayer = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerSettings.ServerSettingsService.layerTest(),
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () => Effect.succeed(projects as never),
  }),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getShellSnapshot: (options) =>
      Effect.succeed({
        schemaVersion: 2,
        snapshotSequence: 1,
        threads: options?.location === "archive" ? [] : [...threads],
      } as never),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({
    invalidate: (cwd) => Effect.sync(() => invalidated.push(cwd)),
  }),
).pipe(Layer.provideMerge(gitDriverLayer));
