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
 * It is not a sandbox; it stops the ordinary path and says why. Known ways around it: the host
 * API without `gh` (curl with a token, another CLI, a query read from a file), `git push` to the
 * base branch, the real `gh` by absolute path, aliases the user defined before, and shells whose
 * login profile prepends its own PATH (on macOS `brew shellenv` can put Homebrew's `gh` first).
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
# Flags whose value is the next argument; a value is never a command word.
takes_value() {
  case "$1" in
    -R|--repo|--hostname|-X|--method|-H|--header|-f|--raw-field|-F|--field|--input|-q|--jq|-t|--template|--title|-b|--body|--body-file|-B|--base|--head|-l|--label|-a|--assignee|-r|--reviewer|-m|--milestone|-p|--project|-S|--search|-s|--state|-L|--limit|-A|--author|--json|--subject|--match-head-commit|--cache|--preview) return 0 ;;
  esac
  return 1
}
args=("$@")
count=\${#args[@]}
words=()
i=0
while [ "$i" -lt "$count" ]; do
  arg="\${args[i]}"
  case "$arg" in
    --)
      i=$((i + 1))
      while [ "$i" -lt "$count" ]; do
        words+=("\${args[i]}")
        i=$((i + 1))
      done
      ;;
    --*=* | -?=*) ;;
    -*) if takes_value "$arg"; then i=$((i + 1)); fi ;;
    *) words+=("$arg") ;;
  esac
  i=$((i + 1))
done
mentions_merge() {
  case "$1" in
    *merge* | *Merge* | *MERGE*) return 0 ;;
  esac
  return 1
}
case "\${words[0]}" in
  pr)
    # "merge" anywhere after pr, flag values aside: gh pr -R o/r merge, gh pr --repo o/r merge.
    for word in "\${words[@]:1}"; do
      [ "$word" = "merge" ] && refuse
    done
    ;;
  alias)
    # An alias that expands to a merge would run it under another name.
    case "\${words[1]}" in
      set)
        for arg in "\${args[@]}"; do mentions_merge "$arg" && refuse; done
        ;;
      import)
        [ "\${#words[@]}" -le 2 ] && refuse
        for word in "\${words[@]:2}"; do
          [ "$word" = "-" ] && refuse
          [ -f "$word" ] && grep -qi merge "$word" && refuse
        done
        ;;
    esac
    ;;
  api)
    for arg in "\${args[@]}"; do
      case "$arg" in
        *pulls/*/merge* | */merges | */merges[?]* | *mergePullRequest* | *enablePullRequestAutoMerge*) refuse ;;
      esac
    done
    ;;
esac
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
