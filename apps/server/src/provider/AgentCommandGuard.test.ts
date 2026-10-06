import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_MERGE_REFUSAL,
  agentCommandGuardDirectory,
  installAgentCommandGuard,
  withAgentCommandGuard,
} from "./AgentCommandGuard.ts";

const TestLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** The installed shim in front of a fake "real" gh that echoes what it was given. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped();
  const guard = yield* installAgentCommandGuard(root);
  const realBin = path.join(root, "real-bin");
  yield* fs.makeDirectory(realBin);
  yield* fs.writeFileString(path.join(realBin, "gh"), '#!/usr/bin/env bash\necho "real gh $*"\n');
  yield* fs.chmod(path.join(realBin, "gh"), 0o755);
  const env = yield* withAgentCommandGuard({ PATH: `${realBin}:/usr/bin:/bin` }, guard);
  const gh = (...args: ReadonlyArray<string>) =>
    runner.run({
      command: "bash",
      args: ["-c", 'gh "$@"', "gh", ...args],
      env,
      timeout: "10 seconds",
    });
  return { root, guard, env, gh };
});

// The shim is a Bash script; the server puts it on PATH only on POSIX hosts.
describe("agent gh shim", () => {
  it.effect("installs into the state directory and is first on PATH once", () =>
    Effect.gen(function* () {
      const { root, guard, env } = yield* setup;
      expect(guard).toBe(agentCommandGuardDirectory(root));
      expect(env.PATH?.split(":")[0]).toBe(guard);
      expect(yield* withAgentCommandGuard(env, guard)).toBe(env);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("leaves a Windows environment alone", () =>
    Effect.gen(function* () {
      const env = { PATH: "C:\\bin" };
      expect(yield* withAgentCommandGuard(env, "/state/agent-bin")).toBe(env);
    }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
  );

  it.effect("refuses merges through gh pr merge and the API", () =>
    Effect.gen(function* () {
      const { gh } = yield* setup;
      for (const args of [
        ["pr", "merge", "12", "--squash"],
        ["pr", "merge", "--auto"],
        ["-R", "acme/app", "pr", "merge", "12"],
        ["api", "-X", "PUT", "repos/acme/app/pulls/12/merge"],
        ["api", "/repos/acme/app/pulls/12/merge", "-f", "merge_method=squash"],
        ["api", "graphql", "-f", "query=mutation { mergePullRequest(input: {}) { x } }"],
        ["api", "graphql", "-f", "query=mutation { enablePullRequestAutoMerge(input: {}) { x } }"],
        // Flag values between pr and merge do not hide it.
        ["pr", "-R", "acme/app", "merge", "12"],
        ["pr", "--repo", "acme/app", "merge", "12"],
        ["pr", "--repo=acme/app", "merge", "12"],
        ["pr", "--unknown-flag", "merge"],
        // Aliases that expand to a merge.
        ["alias", "set", "ship", "pr merge --squash"],
        ["alias", "set", "--clobber", "ship", "api repos/acme/app/pulls/12/merge -X PUT"],
        ["alias", "import", "-"],
        ["alias", "import"],
        // The merges API merges a branch into another.
        ["api", "-X", "POST", "repos/acme/app/merges"],
        ["api", "repos/acme/app/merges?x=1"],
        ["api", "graphql", "-f", "query=mutation { mergeBranch(input: {}) { x } }"],
      ]) {
        const result = yield* gh(...args);
        expect(result.code, args.join(" ")).toBe(1);
        expect(result.stderr).toContain(AGENT_MERGE_REFUSAL);
        expect(result.stdout).toBe("");
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("runs every other command with the real gh", () =>
    Effect.gen(function* () {
      const { gh } = yield* setup;
      for (const args of [
        ["pr", "create", "--title", "merge the parser"],
        ["pr", "view", "12"],
        ["pr", "list", "--search", "merge"],
        ["api", "repos/acme/app/pulls/12"],
        ["api", "graphql", "-f", "query={ viewer { login } }"],
        ["pr", "-R", "acme/app", "view", "12"],
        ["pr", "create", "--body", "merge"],
        ["alias", "set", "co", "pr checkout"],
        ["alias", "list"],
        ["api", "repos/acme/app/commits"],
      ]) {
        const result = yield* gh(...args);
        expect(result.code, args.join(" ")).toBe(0);
        expect(result.stdout.trim()).toBe(`real gh ${args.join(" ")}`);
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
