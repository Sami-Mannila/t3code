import * as Equal from "effect/Equal";
import type { OrganizationThread, OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";

/** Shared by every canonical command, including commands originating through MCP. */
export function organizationProblem(input: {
  thread: OrchestrationV2AppThread;
  next: OrganizationThread | null;
  threads: ReadonlyArray<
    Pick<OrchestrationV2AppThread, "id" | "projectId" | "organization" | "deletedAt" | "archivedAt">
  >;
  actorThreadId?: ThreadId;
  checkpointRefs?: ReadonlyArray<string>;
}): string | null {
  const { thread, next, actorThreadId } = input;
  const previous = thread.organization;
  const threads = new Map(input.threads.map((item) => [item.id, item]));
  threads.set(thread.id, { ...thread, organization: next });
  const related = (id: ThreadId) => {
    const item = threads.get(id);
    return item?.projectId === thread.projectId && item.deletedAt === null ? item : undefined;
  };
  const actor = actorThreadId ? related(actorThreadId) : undefined;
  if (actorThreadId && !actor?.organization)
    return "The acting conversation has no organization role in this project.";
  if (!next)
    return previous
      ? "Organization identity is retained for its recorded work; archive the conversation instead."
      : null;
  if (previous && (previous.role !== next.role || previous.parentThreadId !== next.parentThreadId))
    return "A recorded role and its reporting parent cannot be reassigned.";
  if (!previous && actorThreadId)
    return "Only the user can enroll existing conversations; delegate_task creates agent roles.";
  const parent = next.parentThreadId ? related(next.parentThreadId) : undefined;
  const requiredParent =
    next.role === "lead" ? "chief" : ["executor", "reviewer"].includes(next.role) ? "lead" : null;
  if (requiredParent ? parent?.organization?.role !== requiredParent : next.parentThreadId !== null)
    return "Reporting chain must be Chief → lead → executor or reviewer; Advisor and Chief are root roles.";
  if (
    next.role === "chief" &&
    input.threads.some(
      (item) =>
        item.id !== thread.id &&
        item.projectId === thread.projectId &&
        item.deletedAt === null &&
        item.archivedAt === null &&
        item.organization?.role === "chief",
    )
  )
    return "This project already has a Chief conversation.";
  const task = next.task;
  const old = previous?.task;
  if (!task) return old ? "Recorded tasks cannot be removed." : null;
  if (["advisor", "chief", "reviewer"].includes(next.role))
    return "Tasks belong to lead or executor conversations; reviewer ownership references that original task.";
  if (
    actor &&
    actor.id !== thread.id &&
    actor.id !== next.parentThreadId &&
    actor.id !== old?.ownerThreadId
  )
    return "Only the task's owner or direct coordinator can update this work.";
  if (
    old &&
    (old.title !== task.title ||
      !Equal.equals(old.dependencyThreadIds, task.dependencyThreadIds)) &&
    next.role !== "lead" &&
    !(
      actor?.id === next.parentThreadId &&
      ["queued", "blocked", "changes_requested"].includes(old.state)
    )
  )
    return "Only the coordinator can change the plan before execution or during correction.";
  if (old?.state === "accepted" && task.state === "accepted" && !Equal.equals(old, task))
    return "Accepted evidence is immutable until its coordinator explicitly reopens it.";
  if (
    task.lastReview &&
    !Equal.equals(task.lastReview, old?.lastReview) &&
    !(
      actor?.organization?.role === "reviewer" &&
      actor.id === old?.ownerThreadId &&
      task.lastReview.reviewerThreadId === actor.id &&
      task.lastReview.revision === old?.revision &&
      task.state === "changes_requested"
    )
  )
    return "Review feedback must come from the assigned reviewer of this revision.";
  const owner = related(task.ownerThreadId);
  if (!owner?.organization)
    return "Task owner must be an organization conversation in this project.";
  if (
    task.ownerThreadId !== thread.id &&
    !(task.ownerThreadId === next.parentThreadId && ["queued", "blocked"].includes(task.state)) &&
    !(
      owner.organization.role === "reviewer" &&
      owner.organization.parentThreadId === (next.role === "lead" ? thread.id : next.parentThreadId)
    )
  )
    return "Task ownership may move only to its original worker or an independent reviewer under the same lead.";
  if (new Set(task.dependencyThreadIds).size !== task.dependencyThreadIds.length)
    return "Dependencies must be unique.";
  for (const id of task.dependencyThreadIds) {
    const dependency = related(id);
    if (id === thread.id || !dependency?.organization?.task)
      return "Dependencies must reference other organization tasks in this project.";
    const seen = new Set<ThreadId>();
    const visits = (cursor: ThreadId): boolean => {
      if (cursor === thread.id) return true;
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      return threads.get(cursor)?.organization?.task?.dependencyThreadIds.some(visits) ?? false;
    };
    if (visits(id)) return "Task dependencies cannot form a cycle.";
  }
  if (
    ["working", "awaiting_review", "accepted"].includes(task.state) &&
    task.dependencyThreadIds.some((id) => related(id)?.organization?.task?.state !== "accepted")
  )
    return "All dependencies must be accepted before this task can execute or be accepted.";
  if (task.state === "working" && task.ownerThreadId !== thread.id)
    return "Implementation work remains with the original worker, not the reviewer or coordinator.";
  if (task.revision !== old?.revision && task.reviewedRevision !== null)
    return "A new submission invalidates the previous review.";
  if (
    ["awaiting_review", "accepted"].includes(task.state) &&
    (!task.revision || !input.checkpointRefs?.includes(task.revision))
  )
    return "Submit and verify actual manifest files before review or acceptance.";
  if (task.reviewedRevision !== null && task.reviewedRevision !== old?.reviewedRevision) {
    if (
      !actor ||
      actor.organization?.role !== "reviewer" ||
      actor.id !== old?.ownerThreadId ||
      actor.id === thread.id ||
      task.reviewerThreadId !== actor.id ||
      task.reviewedRevision !== old?.revision ||
      task.revision !== old?.revision
    )
      return "Only the assigned independent reviewer can attest the exact submitted revision.";
  }
  if (task.state === "accepted" && old?.state !== "accepted") {
    if (next.role === "lead") {
      if (actorThreadId) return "Final outcome acceptance requires the user, not an agent.";
      if (
        input.threads.some(
          (item) =>
            item.organization?.parentThreadId === thread.id &&
            item.organization.task &&
            item.organization.task.state !== "accepted",
        )
      )
        return "All implementation tasks must be independently accepted before final outcome acceptance.";
    } else if (!actor || actor.organization?.role !== "reviewer" || actor.id !== old?.ownerThreadId)
      return "Only the assigned independent reviewer accepts an executor submission.";
    if (
      !task.revision ||
      task.reviewedRevision !== task.revision ||
      !task.reviewerThreadId ||
      old?.state !== "awaiting_review"
    )
      return "Acceptance requires independent review of the current submitted revision.";
  }
  if (
    old?.state === "accepted" &&
    task.state !== "accepted" &&
    !(
      actor?.id === next.parentThreadId &&
      task.state === "changes_requested" &&
      task.reviewedRevision === null &&
      task.reviewerThreadId === null &&
      task.ownerThreadId === thread.id
    )
  )
    return "Only the coordinator can reopen accepted implementation work, clearing its old review.";
  return null;
}

export function delegatedOrganization(
  parent: OrchestrationV2AppThread,
  childId: ThreadId,
  title: string,
  review = false,
): OrganizationThread | undefined {
  if (!parent.organization) return undefined;
  const role =
    parent.organization.role === "chief"
      ? "lead"
      : parent.organization.role === "lead"
        ? review
          ? "reviewer"
          : "executor"
        : null;
  if (!role) throw new Error("Only Chief and outcome leads may delegate organization work.");
  if (role === "reviewer") return { role, parentThreadId: parent.id };
  return {
    role,
    parentThreadId: parent.id,
    task: {
      title,
      ownerThreadId: childId,
      dependencyThreadIds: [],
      state: "queued",
      revision: null,
      reviewedRevision: null,
      reviewerThreadId: null,
      notes: null,
    },
  };
}

/** Execution authorization is checked again when a deferred provider turn actually starts. */
export function organizationExecutionProblem(
  thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "organization" | "worktreePath">,
  threads: ReadonlyArray<
    Pick<OrchestrationV2AppThread, "id" | "projectId" | "organization" | "deletedAt">
  >,
  requireWorkspace = true,
): string | null {
  const org = thread.organization;
  if (!org) return null;
  if (["executor", "reviewer"].includes(org.role) && requireWorkspace && !thread.worktreePath)
    return "Organization workers require their prepared worktree before execution.";
  if (org.role === "reviewer") {
    const target = threads.find(
      (item) =>
        item.id === org.reviewTaskThreadId &&
        item.projectId === thread.projectId &&
        item.deletedAt === null,
    );
    if (
      !target?.organization?.task ||
      target.organization.task.state !== "awaiting_review" ||
      target.organization.task.ownerThreadId !== thread.id
    )
      return "This reviewer is not the current owner of an awaiting-review submission.";
  }
  if (org.role !== "executor" || !org.task) return null;
  if (
    org.task.ownerThreadId !== thread.id ||
    !["queued", "working", "changes_requested"].includes(org.task.state)
  )
    return "This executor does not own executable work; its coordinator must explicitly unblock or return the task.";
  if (
    org.task.dependencyThreadIds.some(
      (id) =>
        !threads.some(
          (item) =>
            item.id === id &&
            item.projectId === thread.projectId &&
            item.deletedAt === null &&
            item.organization?.task?.state === "accepted" &&
            item.organization.task.revision === item.organization.task.reviewedRevision,
        ),
    )
  )
    return "Task execution is waiting for independently accepted dependencies.";
  return null;
}

export function organizationInstructions(
  thread: Pick<OrchestrationV2AppThread, "id" | "organization">,
): string {
  const org = thread.organization;
  if (!org) return "";
  const contract = `Organization role: ${org.role}. Your identity is this native conversation (${thread.id}); role authority is server-bound. Chief → outcome lead → executor and independent reviewer. Use native delegate_task and t3_organization_task; never spawn a second CLI or resume another role's native session. Do not treat agent notifications as user approval. Worktrees separate implementation changes; there is no claimed OS sandbox. No quota polling: report actual provider failures to Chief and wait for explicit recovery. Default executor is OpenCode fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash; Chief/lead/reviewer default Codex gpt-6.1-sol. Unavailable targets must be reported, never substituted.`;
  const role =
    org.role === "chief"
      ? "You are the user's primary conversation. Delegate implementation outcomes to leads using delegate_task; do not implement files yourself. Report incoming task updates proactively here in plain language with project/outcome context, exact blocker and concrete options. Keep updates brief; final outcome acceptance belongs to the user."
      : org.role === "lead"
        ? "Plan and delegate implementation using delegate_task. Supply dependencyThreadIds atomically in delegate_task when creating dependent implementation work; it waits until dependencies have current independent acceptance. Do not implement or copy child artifacts. Once a child submits, delegate_task(role=review, reviewTaskThreadId=child conversation ID) creates an independent reviewer. After all children are independently accepted, submit your own outcome with t3_organization_task(action=submit); the server aggregates their current manifests. Delegate an independent outcome review targeting your own conversation. Ask Chief for final user acceptance; never accept an outcome yourself."
        : org.role === "executor"
          ? "Implement only your delegated task in your worktree. Read/claim your task using t3_organization_task, then submit with action=submit and manifest of relative files. A prose completion is not a submission. If blocked, action=block with exact reason. Do not self-review or delegate."
          : org.role === "reviewer"
            ? `Review the actual submitted files of task ${org.reviewTaskThreadId ?? "assigned by your lead"}; t3_organization_task(action=read) with omitted threadId returns the assigned task ID, worktree, manifest and revision. Your own conversation ID also resolves to that assigned task; never substitute another target. Do not implement fixes. Use accept_review only for the exact independently inspected submission, or request_changes with actionable findings. Your native session must differ from the submitter's.`
            : "Advise on goals and portfolio decisions. Do not implement, delegate implementation, or claim user acceptance.";
  return `${contract}\n${role}`;
}
