import type { OrganizationRole, OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import { organizationRepository } from "./OrganizationPolicy.ts";

type TaskThread = Pick<
  OrchestrationV2AppThread,
  | "id"
  | "projectId"
  | "title"
  | "worktreePath"
  | "branch"
  | "organization"
  | "deletedAt"
  | "archivedAt"
>;

/** Read-only interpretation of canonical ownership, not a new assignment or review attestation. */
export function organizationTaskContext(thread: TaskThread, threads: ReadonlyArray<TaskThread>) {
  const task = thread.organization?.task;
  const related = threads.filter(
    (item) => item.projectId === thread.projectId && item.deletedAt === null,
  );
  const owner = related.find((item) => item.id === task?.ownerThreadId);
  const reviewAssignment =
    task?.state === "awaiting_review" &&
    task.revision &&
    owner?.organization?.role === "reviewer" &&
    owner.organization.reviewTaskThreadId === thread.id &&
    owner.archivedAt === null &&
    owner.organization.parentThreadId ===
      (thread.organization?.role === "lead" ? thread.id : thread.organization?.parentThreadId)
      ? { reviewerThreadId: owner.id, taskThreadId: thread.id, revision: task.revision }
      : null;
  const reviewAttestation =
    task?.reviewerThreadId && task.reviewedRevision
      ? { reviewerThreadId: task.reviewerThreadId, revision: task.reviewedRevision }
      : null;
  const sources =
    thread.organization?.role === "lead"
      ? related.filter(
          (item) =>
            task?.dependencyThreadIds.includes(item.id) &&
            item.organization?.role === "executor" &&
            item.organization.parentThreadId === thread.id,
        )
      : task
        ? [thread]
        : [];
  return {
    // A conversation without a task, such as a reviewer, has no repository of its own.
    repository: task ? organizationRepository(thread) : null,
    branch: thread.branch,
    currentOwner: owner
      ? {
          threadId: owner.id,
          title: owner.title,
          role: (owner.organization?.role ?? null) as OrganizationRole | null,
        }
      : null,
    reviewAssignment,
    reviewAttestation,
    protocol:
      "currentOwner and reviewAssignment describe the live task assignment. task.reviewerThreadId and task.reviewedRevision are completed attestations only; null means review has not been accepted, not that no reviewer is assigned. artifactSources locates the submitted files for independent inspection; acceptance rechecks their current bytes. A valid existing reviewAssignment on the unchanged revision may resume its reviewer after a tooling failure without inventing a new assignment.",
    artifactSources: sources.map((source) => ({
      taskThreadId: source.id as ThreadId,
      repository: organizationRepository(source),
      branch: source.branch,
      workspace: source.worktreePath,
      manifest: source.organization?.task?.manifest ?? [],
      submittedRevision: source.organization?.task?.revision ?? null,
      acceptedRevision:
        source.organization?.task?.state === "accepted" &&
        source.organization.task.reviewedRevision === source.organization.task.revision
          ? source.organization.task.revision
          : null,
      files: source.organization?.task?.files ?? [],
    })),
  };
}
