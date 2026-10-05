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
- A Git exit during preparation is deterministic, so the effect worker fails the run and blocks the
  task on the first attempt, with the command's stderr in the task notes that reach the parent and
  the Chief. Spawn failures and timeouts are still retried. Retrying the failed run re-enqueues
  the organization effect, not the generic worktree preparation, which would run in the root. It
  also returns the blocked task to queued; admission would otherwise hold an executor's run until
  a coordinator unblocked it.
