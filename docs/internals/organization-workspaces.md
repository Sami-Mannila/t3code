# Organization workspaces

An organization project root does not have to be a Git repository. It is often a plain folder of
repositories, so worktrees are tied to tasks, not to the root.

- Only executors write files, so only executors get a worktree and branch
  ([`organizationNeedsWorktree`](../../apps/server/src/orchestration-v2/OrganizationPolicy.ts)).
  Chief, Advisor, leads and reviewers run in the project root. Reviewers inspect each submission in
  place through `artifactSources[].workspace`, and a lead outcome aggregates its executors'
  worktrees, so neither needs a checkout of its own.
- A task names its repository relative to the project root. Absent means `"."`, which keeps tasks
  created before this field, and roots that are themselves a repository, working as before. The
  repository is fixed once delegated; `delegate_task` validates it before creating the child, and
  preparation validates it again, because the folder can change in between. Every Git command for
  an executor's worktree, including recreating or cleaning it up later, runs in that repository,
  not in the root.
- Every organization child still goes through the `organization-workspace.prepare` effect, even
  when it gets no worktree. That effect ends in `prepared-run.release`, which is the admission and
  worker-capacity gate; skipping it for roles without a worktree would let them start unadmitted.
- Creating an executor's worktree is idempotent, because its path and branch derive from the
  thread ID and belong to that task alone. Preparation prunes stale registrations, checks out the
  task's existing branch when the folder is gone (a killed checkout, or storage cleanup, which
  keeps the branch), and replaces a folder only when it is empty or is a registered worktree
  still carrying the `initializing` lock of an add that was killed, and only when Git vouches for
  it: it has no `.git` of its own, its admin directory has no `index` (checkout writes it last,
  so the checkout never finished), or `git status` shows it clean. Any Git exit there refuses
  without deleting. A folder with other contents is never deleted;
  preparation fails and names it. Git runs in the C locale so its output can be matched. `worktree add` gets five minutes, since a
  large repository's checkout can take longer than the other Git commands' 30 seconds.
- Storage cleanup's idle-worktree pass
  ([`idleWorktreeRemovable`](../../apps/server/src/storageCleanup.ts)) must not remove an
  executor checkout that review or outcome consolidation still reads: tasks awaiting review or
  accepted keep their worktree until the lead's own task is accepted or either thread is
  archived. No user or agent accepts a lead: the
  [acceptance reactor](../../apps/server/src/orchestration-v2/OrganizationOutcomeAcceptanceReactor.ts)
  does, once the reviewed revision's dependency tasks are accepted and every pull request the
  outcome owns has merged, or on the review alone when it owns none. A thread owns only links
  added after it was created; delegated roles start with no links, since inherited ones would
  gate the wrong work. An open pull request from a reviewed executor's branch counts even when
  nobody linked it; a legacy single link on the lead counts unless its parent has the same one.
  Each attempt's command id hashes the inputs it decided on, so a refused acceptance is
  reported to the Chief once and a later attempt can still succeed.
- A merged pull request has to mean the user accepted the work, so agents must not merge.
  No MCP tool merges or lets an organization agent unlink, and provider sessions get a `gh`
  shim first on PATH
  ([`AgentCommandGuard`](../../apps/server/src/provider/AgentCommandGuard.ts)) that refuses
  `gh pr merge` and merge API calls. It is not a sandbox: an agent can still reach the host API
  without `gh` (curl with a token, a query read from a file). Removal and preparation take the same workspace lease, and removal re-checks for a
  queued or active run as its last step, so a run that is preparing keeps its checkout.
- A Git exit during preparation is usually deterministic, so the effect worker fails the run on the
  first attempt, with the command's stderr in the task notes that reach the parent and the Chief.
  Lock contention (`index.lock`, `could not lock`, `cannot lock ref`), typically from another
  executor preparing in the same repository, clears on its own and is retried, as are spawn
  failures and timeouts.
- A failure blocks only work that was about to run (`queued`, `working`, `changes_requested`).
  Follow-up messages to executors and reviewers go through preparation too, so a failure there
  fails that run and leaves a task awaiting review or accepted as it was.
- Retrying a delegated child's failed run (lead, executor or reviewer) re-enqueues the
  organization effect, not the generic worktree preparation, which would run in the root. A
  user-enrolled Chief or Advisor retries the generic preparation of its original launch. The
  retry lifts only the block the preparation recorded, back to `changes_requested` for a
  correction round with feedback on the current revision and to `queued` otherwise; admission
  would otherwise hold an executor's run until a coordinator unblocked it. A block recorded by a
  coordinator or worker stays.

## Role models

Each role starts on the model in the server setting `organizationRoleModelSelections` (Settings →
General → Organization role models), resolved by `resolveOrganizationRoleModelSelection` in
`packages/shared/src/serverSettings.ts`. `delegate_task` without a `target`, the organization
page's Add role, the role instructions and the native smoke all read it. An unset role uses
`DEFAULT_ORGANIZATION_ROLE_MODEL_SELECTIONS`, which names a driver rather than an instance, so a
child keeps its parent's instance of that driver when it can. A configured model is never
replaced: an unavailable provider or model fails the delegation with `provider_unavailable` or
`model_unavailable`.
