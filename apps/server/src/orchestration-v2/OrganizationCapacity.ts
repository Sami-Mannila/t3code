import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  ThreadId,
  RunId,
} from "@t3tools/contracts";

export const ORGANIZATION_WORKER_LIMIT = 10;
type RoleThread = Pick<OrchestrationV2AppThread, "id" | "organization">;
type WorkerRun = Pick<OrchestrationV2Run, "id" | "threadId" | "status">;
/** Called inside serialized admission: start intents consume capacity before provider outbox delivery.
 * Queued/preparing runs are durable waiters, not reservations. A waiting native run retains its
 * reservation because answering its tool/approval request can resume that same provider turn. */
export function organizationWorkerCapacity(
  threads: readonly RoleThread[],
  runs: readonly WorkerRun[],
  candidateThreadId?: ThreadId,
  candidateRunId?: RunId,
) {
  const workers = new Set(
    threads
      .filter((t) => t.organization?.role === "executor" || t.organization?.role === "reviewer")
      .map((t) => t.id),
  );
  const occupiedRunIds = [
    ...new Set(
      runs
        .filter(
          (run) =>
            workers.has(run.threadId) && ["starting", "running", "waiting"].includes(run.status),
        )
        .map((run) => run.id),
    ),
  ];
  const available = Math.max(0, ORGANIZATION_WORKER_LIMIT - occupiedRunIds.length);
  const ownsReservation =
    candidateRunId !== undefined &&
    runs.some(
      (run) =>
        run.id === candidateRunId &&
        run.threadId === candidateThreadId &&
        occupiedRunIds.includes(run.id),
    );
  return {
    limit: ORGANIZATION_WORKER_LIMIT,
    occupiedRunIds,
    available,
    canStart:
      candidateThreadId !== undefined && !workers.has(candidateThreadId)
        ? true
        : ownsReservation || available > 0,
  };
}
