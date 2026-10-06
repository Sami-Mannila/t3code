import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  OrganizationRepositoryPath,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import { organizationNeedsWorktree, organizationRepository } from "./OrganizationPolicy.ts";
import * as Projects from "./ProjectStore.ts";
import * as Threads from "./ThreadManagementService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

const GIT_TIMEOUT: Duration.Input = "30 seconds";
/** Checking out a large repository can take minutes. */
const WORKTREE_ADD_TIMEOUT: Duration.Input = "5 minutes";
const GIT_OUTPUT_BYTES = 1_048_576;
/** Untranslated Git output, so worktree listings and error text can be matched. */
const GIT_ENV = { LC_ALL: "C", LANGUAGE: "C" };
const DETAIL_CHARS = 2_000;
const MAX_CANDIDATES = 20;

const excerpt = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_CHARS ? `${trimmed.slice(0, DETAIL_CHARS)}…` : trimmed;
};

export class OrganizationWorkspaceError extends Schema.TaggedError<OrganizationWorkspaceError>()(
  "OrganizationWorkspaceError",
  {
    threadId: Schema.String,
    reason: Schema.String,
    /** Truncated output of the failing Git command, when there is one. */
    detail: Schema.optional(Schema.String),
    /** False when retrying would repeat the same failure, such as a Git exit other than lock contention. */
    retryable: Schema.Boolean,
  },
) {
  override get message() {
    return `Unable to prepare the organization's isolated Git worktree: ${this.reason}${this.detail ? `\n${this.detail}` : ""}`;
  }
}

/**
 * Another Git process holding a lock in the same repository, such as a concurrent executor
 * preparation. The lock clears on its own, so that exit is worth retrying.
 */
export const isGitLockContention = (output: string) =>
  // A ref directory/file conflict ("'refs/heads/a' exists; cannot create 'refs/heads/a/b'")
  // is permanent even though Git reports it as a lock failure.
  !/exists; cannot create/i.test(output) &&
  /Unable to create '[^']*\.lock': File exists|(?:could not|cannot) lock[^\n]*File exists/i.test(
    output,
  );

/** Deterministic preparation failures fail the run at once instead of burning retries. */
const isWorkspaceError = Schema.is(OrganizationWorkspaceError);
export const isTerminalWorkspaceFailure = (error: unknown) =>
  isWorkspaceError(error) && !error.retryable;

export class OrganizationRepositoryError extends Schema.TaggedError<OrganizationRepositoryError>()(
  "OrganizationRepositoryError",
  {
    repository: Schema.String,
    reason: Schema.String,
    /** Immediate children of the project root that are Git repositories. */
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message() {
    const found = this.candidates.length
      ? ` Git repositories directly under the project root: ${this.candidates.map((name) => `"${name}"`).join(", ")}.`
      : " No Git repositories were found directly under the project root.";
    return `Repository "${this.repository}" ${this.reason}.${found}`;
  }
}

const isRepositoryPath = Schema.is(OrganizationRepositoryPath);

/**
 * Resolves a task repository to the real path of a Git repository root inside the project root.
 * Rejects symlink escapes, folders inside a repository and repositories without a commit.
 * Spawn failures and timeouts stay as ProcessRunner errors, which callers may retry.
 */
export const resolveRepository = Effect.fn("OrganizationWorkspace.resolveRepository")(
  function* (input: { workspaceRoot: string; repository: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.realPath(input.workspaceRoot).pipe(Effect.option);
    if (Option.isNone(root))
      return yield* new OrganizationRepositoryError({
        repository: input.repository,
        reason: `cannot be used because the project root ${input.workspaceRoot} is not readable`,
        candidates: [],
      });
    const candidates = Effect.gen(function* () {
      const found: Array<string> = [];
      if (yield* fs.exists(path.join(root.value, ".git"))) found.push(".");
      for (const name of (yield* fs.readDirectory(root.value)).toSorted()) {
        if (found.length >= MAX_CANDIDATES) break;
        if (!name.startsWith(".") && (yield* fs.exists(path.join(root.value, name, ".git"))))
          found.push(name);
      }
      return found;
    }).pipe(Effect.orElseSucceed((): Array<string> => []));
    const reject = (reason: string) =>
      Effect.flatMap(candidates, (found) =>
        Effect.fail(
          new OrganizationRepositoryError({
            repository: input.repository,
            reason,
            candidates: found,
          }),
        ),
      );
    if (!isRepositoryPath(input.repository))
      return yield* reject("is not a normalized path relative to the project root");
    const directory = yield* fs
      .realPath(path.join(root.value, input.repository))
      .pipe(Effect.option);
    if (Option.isNone(directory)) return yield* reject("does not exist under the project root");
    if (directory.value !== root.value && !directory.value.startsWith(`${root.value}${path.sep}`))
      return yield* reject("resolves outside the project root");
    const git = (args: ReadonlyArray<string>) =>
      process.run({
        command: "git",
        args,
        cwd: directory.value,
        timeout: GIT_TIMEOUT,
        maxOutputBytes: GIT_OUTPUT_BYTES,
        env: GIT_ENV,
      });
    const toplevel = yield* git(["rev-parse", "--show-toplevel"]);
    if (toplevel.code !== 0)
      return yield* reject(
        `is not a Git repository (${toplevel.stderr.trim().split("\n")[0] || `git exited with code ${toplevel.code}`})`,
      );
    const top = yield* fs.realPath(toplevel.stdout.trim()).pipe(Effect.option);
    if (Option.getOrUndefined(top) !== directory.value)
      return yield* reject(
        `is a folder inside the Git repository at ${toplevel.stdout.trim()}; name that repository's root instead`,
      );
    if ((yield* git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).code !== 0)
      return yield* reject("has no commits yet; a worktree needs a commit to branch from");
    return directory.value;
  },
);

/**
 * Called only by the durable preparation outbox, before provider-turn.start. Every organization
 * child passes through here because `prepared-run.release` is the admission and capacity gate;
 * only executors also get a worktree, in their task's repository.
 */
export const prepare = Effect.fn("OrganizationWorkspace.prepare")(function* (input: {
  commandId: CommandId;
  threadId: ThreadId;
  runId: RunId;
}) {
  const threads = yield* Threads.ThreadManagementService;
  const projection = yield* threads.getThreadProjection(input.threadId);
  const run = projection.runs.find((item) => item.id === input.runId);
  if (!projection.thread.organization || run?.status !== "preparing") return;
  if (organizationNeedsWorktree(projection.thread.organization.role)) {
    const projects = yield* Projects.ProjectStoreV2;
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* ProcessRunner.ProcessRunner;
    const fail = (reason: string, detail?: string, retryable = false) =>
      new OrganizationWorkspaceError({
        threadId: input.threadId,
        reason,
        ...(detail ? { detail } : {}),
        retryable,
      });
    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return yield* fail("the project no longer exists");
    const repositoryRoot = yield* resolveRepository({
      workspaceRoot: project.value.workspaceRoot,
      repository: organizationRepository(projection.thread),
    }).pipe(
      Effect.catchTag("OrganizationRepositoryError", (error) => Effect.fail(fail(error.message))),
    );
    const key = NodeCrypto.createHash("sha256").update(input.threadId).digest("hex").slice(0, 24);
    const workspace = path.join(config.worktreesDir, "organization", key);
    const branch = `t3/organization/${key}`;
    const git = (
      args: ReadonlyArray<string>,
      cwd = repositoryRoot,
      timeout: Duration.Input = GIT_TIMEOUT,
    ) =>
      process
        .run({ command: "git", args, cwd, timeout, maxOutputBytes: GIT_OUTPUT_BYTES, env: GIT_ENV })
        .pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.succeed(result.stdout.trim())
              : Effect.fail(
                  fail(
                    `git ${args.join(" ")} exited with code ${result.code} in ${cwd}`,
                    excerpt(result.stderr || result.stdout),
                    isGitLockContention(result.stderr),
                  ),
                ),
          ),
        );
    // Storage cleanup removes idle worktrees under this lease after checking that no run is
    // queued; this run is already preparing, so the checkout it ensures here stays.
    yield* withWorkspaceLease(
      path.resolve(workspace),
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(config.worktreesDir, "organization"), {
          recursive: true,
        });
        // Creation is idempotent: an earlier attempt may have been killed mid-checkout, and storage
        // cleanup removes idle worktrees but keeps their branch. Both the path and the branch derive
        // from this thread's ID, so they belong to this task alone.
        yield* git(["worktree", "prune"]);
        const registered = yield* git(["worktree", "list", "--porcelain"]);
        // Git records the real path; the workspace itself may not exist.
        const realWorkspace = path.join(
          yield* fs.realPath(path.join(config.worktreesDir, "organization")),
          key,
        );
        const entry = registered
          .split("\n\n")
          .map((block) => block.split("\n"))
          .find((lines) =>
            [workspace, realWorkspace].includes(lines[0]?.replace(/^worktree /, "") ?? ""),
          );
        // `git worktree add` holds this lock until its checkout finishes; a leftover one marks an
        // add that was killed, which never released a run, so the folder holds only Git's partial
        // checkout. It may lack even its .git file, so Git cannot remove it itself.
        if (entry?.includes("locked initializing")) {
          // Deleted only when Git vouches that nothing in it is anyone's work:
          // - no .git of its own: the add was killed before it wrote one (status would otherwise
          //   describe whatever repository encloses the folder);
          // - no index in its admin directory: checkout writes the index last, so it never
          //   finished and no run was ever released (status would show every file as changed);
          // - otherwise only a clean status.
          // A Git exit refuses without retrying; a timeout or spawn failure retries; neither deletes.
          if (yield* fs.exists(path.join(workspace, ".git"))) {
            const adminDir = yield* git(
              ["rev-parse", "--path-format=absolute", "--git-dir"],
              workspace,
            );
            if (yield* fs.exists(path.join(adminDir, "index"))) {
              const status = yield* process.run({
                command: "git",
                args: ["status", "--porcelain"],
                cwd: workspace,
                timeout: WORKTREE_ADD_TIMEOUT,
                maxOutputBytes: GIT_OUTPUT_BYTES,
                outputMode: "truncate",
                env: GIT_ENV,
              });
              if (status.code !== 0)
                return yield* fail(
                  `git status exited with code ${status.code} in the interrupted worktree ${workspace}; move its contents away, then retry`,
                  excerpt(status.stderr || status.stdout),
                );
              if (status.stdout.trim() !== "")
                return yield* fail(
                  `${workspace} is an interrupted worktree with changes in it; move its contents away, then retry`,
                );
            }
          }
          yield* git(["worktree", "unlock", workspace]);
          yield* fs.remove(workspace, { recursive: true });
          yield* git(["worktree", "prune"]);
        } else if (!entry && (yield* fs.exists(workspace))) {
          // Not a worktree of this repository: recreate it only if nothing is in it.
          if ((yield* fs.readDirectory(workspace)).length > 0)
            return yield* fail(
              `${workspace} exists but is not a worktree of ${repositoryRoot}; move its contents away, then retry`,
            );
          yield* fs.remove(workspace, { recursive: true });
        }
        if (!(yield* fs.exists(workspace))) {
          const branchExists = yield* process
            .run({
              command: "git",
              args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
              cwd: repositoryRoot,
              timeout: GIT_TIMEOUT,
              maxOutputBytes: GIT_OUTPUT_BYTES,
              env: GIT_ENV,
            })
            .pipe(Effect.map((result) => result.code === 0));
          yield* git(
            branchExists
              ? ["worktree", "add", workspace, branch]
              : [
                  "worktree",
                  "add",
                  "-b",
                  branch,
                  workspace,
                  run.workspacePreparation?.type === "worktree"
                    ? run.workspacePreparation.baseRef
                    : "HEAD",
                ],
            repositoryRoot,
            WORKTREE_ADD_TIMEOUT,
          );
        }
        const actual = yield* git(["rev-parse", "--show-toplevel"], workspace);
        const expectedCommon = yield* git([
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const actualCommon = yield* git(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          workspace,
        );
        if ((yield* fs.realPath(expectedCommon)) !== (yield* fs.realPath(actualCommon)))
          return yield* fail("the existing worktree belongs to a different repository");
        const actualBranch = yield* git(["branch", "--show-current"], workspace);
        if (
          (yield* fs.realPath(actual)) !== (yield* fs.realPath(workspace)) ||
          actualBranch !== branch
        )
          return yield* fail("the existing path is not this task's registered worktree");
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${input.commandId}:organization-workspace`),
          threadId: input.threadId,
          worktreePath: workspace,
          branch,
        });
      }),
    );
  }
  yield* threads.dispatch({
    type: "prepared-run.release",
    commandId: CommandId.make(`${input.commandId}:organization-release`),
    threadId: input.threadId,
    runId: input.runId,
  });
});
