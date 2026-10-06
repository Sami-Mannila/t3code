import { isHostWindows } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Merging a pull request is the user's acceptance of the work, so agents T3 spawns must not do
 * it. Their provider processes get a `gh` shim first on PATH that refuses merge commands and
 * otherwise runs the real `gh`. The user's own terminals and the server's own `gh` calls (the
 * user's merge button) keep the real one.
 *
 * Residual risk: an agent can still reach the host API without `gh` (curl with a token, a
 * different CLI, a GraphQL query read from a file). The shim stops the ordinary path and says
 * why; it is not a sandbox.
 */
export const AGENT_MERGE_REFUSAL =
  "Merging is reserved for the user; ask the Chief to request a merge.";

const SHIM_DIRECTORY_VARIABLE = "T3CODE_AGENT_COMMAND_GUARD_DIR";

/** The `gh` shim. Bash so it runs wherever provider CLIs run shell commands. */
export const GH_SHIM_SCRIPT = `#!/usr/bin/env bash
# T3 Code agent command guard: merging pull requests is reserved for the user.
refuse() {
  echo "${AGENT_MERGE_REFUSAL}" >&2
  exit 1
}
positional=()
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) positional+=("$arg") ;;
  esac
done
for ((i = 0; i + 1 < \${#positional[@]}; i++)); do
  if [ "\${positional[i]}" = "pr" ] && [ "\${positional[i + 1]}" = "merge" ]; then
    refuse
  fi
done
if [ "\${positional[0]}" = "api" ]; then
  for arg in "$@"; do
    case "$arg" in
      *pulls/*/merge*|*mergePullRequest*|*enablePullRequestAutoMerge*) refuse ;;
    esac
  done
fi
guard_dir="\${${SHIM_DIRECTORY_VARIABLE}:-$(cd "$(dirname "$0")" && pwd)}"
IFS=: read -r -a entries <<< "$PATH"
for entry in "\${entries[@]}"; do
  [ -z "$entry" ] && continue
  [ "$entry" = "$guard_dir" ] && continue
  if [ -x "$entry/gh" ] && [ ! -d "$entry/gh" ]; then
    exec "$entry/gh" "$@"
  fi
done
echo "gh: command not found" >&2
exit 127
`;

/** Where the shim lives; adapters put it on PATH whether or not it is installed yet. */
export const agentCommandGuardDirectory = (stateDir: string) => `${stateDir}/agent-bin`;

/** Writes the shim into the server-owned directory at startup. */
export const installAgentCommandGuard = Effect.fn("installAgentCommandGuard")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = agentCommandGuardDirectory(stateDir);
  yield* fs.makeDirectory(directory, { recursive: true });
  const shim = path.join(directory, "gh");
  yield* fs.writeFileString(shim, GH_SHIM_SCRIPT);
  yield* fs.chmod(shim, 0o755);
  return directory;
});

/**
 * A provider agent session's environment, with the guard directory first on PATH. Windows keeps
 * its environment: the shim is a Bash script.
 */
export const withAgentCommandGuard = (environment: NodeJS.ProcessEnv, directory: string) =>
  Effect.map(isHostWindows, (windows): NodeJS.ProcessEnv => {
    const current = environment.PATH ?? "";
    if (windows || current.split(":")[0] === directory) return environment;
    return {
      ...environment,
      PATH: current === "" ? directory : `${directory}:${current}`,
      [SHIM_DIRECTORY_VARIABLE]: directory,
    };
  });
