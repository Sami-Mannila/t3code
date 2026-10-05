import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as NodeCrypto from "node:crypto";
import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as Projects from "./ProjectStore.ts";
import * as Threads from "./ThreadManagementService.ts";

class OrganizationWorkspaceError extends Schema.TaggedError<OrganizationWorkspaceError>()(
  "OrganizationWorkspaceError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Unable to prepare the organization's isolated Git worktree.";
  }
}

/** Called only by the durable preparation outbox, before provider-turn.start. */
export const prepare = Effect.fn("OrganizationWorkspace.prepare")(function* (input: {
  commandId: CommandId;
  threadId: ThreadId;
  runId: RunId;
}) {
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectStoreV2;
  const config = yield* Config.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* ProcessRunner.ProcessRunner;
  const projection = yield* threads.getThreadProjection(input.threadId);
  const run = projection.runs.find((item) => item.id === input.runId);
  if (!projection.thread.organization || run?.status !== "preparing") return;
  const project = yield* projects.get(projection.thread.projectId);
  if (Option.isNone(project))
    return yield* new OrganizationWorkspaceError({
      threadId: input.threadId,
      cause: "Project not found",
    });
  const key = NodeCrypto.createHash("sha256").update(input.threadId).digest("hex").slice(0, 24);
  const workspace = path.join(config.worktreesDir, "organization", key);
  const branch = `t3/organization/${key}`;
  const git = (args: ReadonlyArray<string>, cwd = project.value.workspaceRoot) =>
    process
      .run({ command: "git", args, cwd, timeout: "30 seconds", maxOutputBytes: 1_048_576 })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(
                new OrganizationWorkspaceError({ threadId: input.threadId, cause: result.stderr }),
              ),
        ),
      );
  yield* fs.makeDirectory(path.join(config.worktreesDir, "organization"), { recursive: true });
  if (!(yield* fs.exists(workspace)))
    yield* git([
      "worktree",
      "add",
      "-b",
      branch,
      workspace,
      run.workspacePreparation?.type === "worktree" ? run.workspacePreparation.baseRef : "HEAD",
    ]);
  const actual = yield* git(["rev-parse", "--show-toplevel"], workspace);
  const expectedCommon = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const actualCommon = yield* git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    workspace,
  );
  if ((yield* fs.realPath(expectedCommon)) !== (yield* fs.realPath(actualCommon)))
    return yield* new OrganizationWorkspaceError({
      threadId: input.threadId,
      cause: "Workspace belongs to a different repository",
    });
  const actualBranch = yield* git(["branch", "--show-current"], workspace);
  if ((yield* fs.realPath(actual)) !== (yield* fs.realPath(workspace)) || actualBranch !== branch)
    return yield* new OrganizationWorkspaceError({
      threadId: input.threadId,
      cause: "Existing path is not this task's registered worktree",
    });
  yield* threads.dispatch({
    type: "thread.metadata.update",
    commandId: CommandId.make(`${input.commandId}:organization-workspace`),
    threadId: input.threadId,
    worktreePath: workspace,
    branch,
  });
  yield* threads.dispatch({
    type: "prepared-run.release",
    commandId: CommandId.make(`${input.commandId}:organization-release`),
    threadId: input.threadId,
    runId: input.runId,
  });
});
