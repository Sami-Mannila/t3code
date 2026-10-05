import type { OrganizationTask, OrchestrationV2ThreadShell } from "@t3tools/contracts";

export interface PilotFailureReceipt {
  readonly task:
    | Pick<OrganizationTask, "state" | "revision" | "ownerThreadId" | "notes">
    | undefined;
  readonly runId: OrchestrationV2ThreadShell["latestRunId"];
  readonly status: OrchestrationV2ThreadShell["status"];
  readonly requestId: string | null;
}

export function pilotFailureReceipt(thread: OrchestrationV2ThreadShell): PilotFailureReceipt {
  const task = thread.organization?.task;
  return {
    task: task
      ? {
          state: task.state,
          revision: task.revision,
          ownerThreadId: task.ownerThreadId,
          notes: task.notes,
        }
      : undefined,
    runId: thread.latestRunId,
    status: thread.status,
    requestId: thread.pendingRuntimeRequest?.id ?? null,
  };
}

/** Task blockers and native run failures have independent lifetimes. Starting a recovery
 * turn must not make an unchanged historical task blocker appear newly reported. */
export function hasNewPilotFailure(
  current: PilotFailureReceipt,
  before?: PilotFailureReceipt,
): boolean {
  if (
    current.task?.state === "blocked" &&
    (before?.task?.state !== "blocked" ||
      current.task.revision !== before.task.revision ||
      current.task.ownerThreadId !== before.task.ownerThreadId ||
      current.task.notes !== before.task.notes)
  )
    return true;
  if (
    ["failed", "interrupted", "cancelled"].includes(current.status) &&
    (current.runId !== before?.runId || current.status !== before.status)
  )
    return true;
  return current.requestId !== null && current.requestId !== before?.requestId;
}
