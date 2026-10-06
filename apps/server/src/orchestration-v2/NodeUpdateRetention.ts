import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { increment, orchestrationNodeUpdatesPrunedTotal } from "../observability/Metrics.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

/**
 * Online retention for superseded `node.updated` events.
 *
 * The node projection is a last-write-wins upsert, so only the newest
 * `node.updated` per (thread stream, node id) can influence a rebuild or a
 * resume, which already tolerate sequence gaps. Older rows of idle threads are
 * removed on the shared connection in small transactions with pauses between
 * them, a bounded number per scheduler tick, so a large backlog drains over
 * many ticks instead of blocking requests. Freed pages are reused by SQLite;
 * this never runs VACUUM.
 */

/** Events read per discovery statement, of every type, so sparse node updates cannot widen a scan. */
export const NODE_UPDATE_RETENTION_PAGE_SIZE = 2_000;
/** Rows one delete transaction removes. Measured at ~100–160 ms on a large live database. */
export const NODE_UPDATE_RETENTION_DELETE_BATCH_SIZE = 250;
/** Pause between delete transactions, capping the share of the connection retention uses. */
export const NODE_UPDATE_RETENTION_BATCH_PAUSE = Duration.millis(75);
/** Rows one scheduler tick (every 5 s) may delete, across all threads. */
export const NODE_UPDATE_RETENTION_ROWS_PER_PASS = 2_000;
/** A thread's newest event must be at least this old before it is pruned. */
export const NODE_UPDATE_RETENTION_IDLE_MS = 10 * 60_000;
/** Pause between full walks over all threads. */
export const NODE_UPDATE_RETENTION_INTERVAL_MS = 10 * 60_000;
const THREADS_PER_PASS = 25;
const ACTIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];

/**
 * Where a thread's newest-first scan stands. Rows at or above `before` were
 * scanned; `retained` holds the node ids whose newest row was among them.
 */
export interface NodeUpdatePruneProgress {
  readonly threadId: string;
  readonly head: number;
  before: number;
  readonly retained: Set<string>;
}

export interface NodeUpdatePruneResult {
  readonly deletedRows: number;
  readonly batches: number;
  readonly pages: number;
  /** `budget`: resume later from the same progress. `busy`: the thread gained a run. */
  readonly status: "complete" | "budget" | "busy";
}

export interface NodeUpdateRetentionOptions {
  readonly rowsPerPass?: number;
  readonly deleteBatchSize?: number;
  readonly batchPause?: Duration.Input;
}

export const startProgress = (threadId: string, head: number): NodeUpdatePruneProgress => ({
  threadId,
  head,
  before: head + 1,
  retained: new Set(),
});

export const make = (options: NodeUpdateRetentionOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rowsPerPass = options.rowsPerPass ?? NODE_UPDATE_RETENTION_ROWS_PER_PASS;
    const deleteBatchSize = options.deleteBatchSize ?? NODE_UPDATE_RETENTION_DELETE_BATCH_SIZE;
    const batchPause = Duration.fromInputUnsafe(
      options.batchPause ?? NODE_UPDATE_RETENTION_BATCH_PAUSE,
    );

    const deleteBatch = (threadId: string, sequences: ReadonlyArray<number>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const active = yield* sql`
            SELECT 1 FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
            LIMIT 1
          `;
          if (active.length > 0) return false;
          yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(sequences)}`;
          return true;
        }),
      );

    /**
     * Delete up to `budget` superseded `node.updated` rows at or below the
     * progress head, newest first. The first row seen per node is the one
     * kept. Appends that race the scan only add newer rows, so a row found
     * superseded stays superseded, and progress can resume on a later pass.
     */
    const pruneThread = (progress: NodeUpdatePruneProgress, budget: number) =>
      Effect.gen(function* () {
        let deletedRows = 0;
        let batches = 0;
        let pages = 0;
        while (true) {
          const rows = yield* sql<{ readonly sequence: number; readonly node_id: string | null }>`
            SELECT
              sequence,
              CASE
                WHEN application_event_version = 2 AND event_type = 'node.updated'
                THEN json_extract(payload_json, '$.id')
                ELSE NULL
              END AS node_id
            FROM orchestration_events
            WHERE aggregate_kind = 'thread'
              AND stream_id = ${progress.threadId}
              AND sequence < ${progress.before}
            ORDER BY sequence DESC
            LIMIT ${NODE_UPDATE_RETENTION_PAGE_SIZE}
          `;
          pages += 1;
          const superseded: Array<number> = [];
          let budgetReached = false;
          let scannedThrough = progress.before;
          for (const row of rows) {
            if (budgetReached) break;
            scannedThrough = row.sequence;
            if (row.node_id === null) continue;
            if (!progress.retained.has(row.node_id)) {
              progress.retained.add(row.node_id);
              continue;
            }
            superseded.push(row.sequence);
            budgetReached = deletedRows + superseded.length >= budget;
          }
          for (let offset = 0; offset < superseded.length; offset += deleteBatchSize) {
            const batch = superseded.slice(offset, offset + deleteBatchSize);
            if (!(yield* deleteBatch(progress.threadId, batch))) {
              return { deletedRows, batches, pages, status: "busy" } as NodeUpdatePruneResult;
            }
            deletedRows += batch.length;
            batches += 1;
            // Each transaction holds the shared connection; leave it to requests for a while.
            if (!Duration.isZero(batchPause)) yield* Effect.sleep(batchPause);
            else yield* Effect.yieldNow;
          }
          // Every row from `scannedThrough` up has been accounted for.
          progress.before = scannedThrough;
          if (budgetReached) {
            return { deletedRows, batches, pages, status: "budget" } as NodeUpdatePruneResult;
          }
          if (rows.length < NODE_UPDATE_RETENTION_PAGE_SIZE) {
            return { deletedRows, batches, pages, status: "complete" } as NodeUpdatePruneResult;
          }
          yield* Effect.yieldNow;
        }
      });

    // Walk position, an unfinished thread and per-thread progress live in
    // memory; after a restart the first walk revisits every thread once.
    let cursor = "";
    let nextWalkAt = 0;
    let unfinished: NodeUpdatePruneProgress | null = null;
    const prunedThrough = new Map<string, number>();

    /**
     * One bounded slice of the walk over idle threads: at most `rowsPerPass`
     * deletions, finishing an interrupted thread first. After a full walk it
     * waits `NODE_UPDATE_RETENTION_INTERVAL_MS`.
     */
    const runPass = Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (unfinished === null && nowMs < nextWalkAt) return { deletedRows: 0, threads: 0 };
      let deletedRows = 0;
      const prunedThreads = new Set<string>();
      const prune = (progress: NodeUpdatePruneProgress) =>
        Effect.gen(function* () {
          const result = yield* pruneThread(progress, rowsPerPass - deletedRows);
          deletedRows += result.deletedRows;
          if (result.deletedRows > 0) prunedThreads.add(progress.threadId);
          unfinished = result.status === "budget" ? progress : null;
          if (result.status === "complete") prunedThrough.set(progress.threadId, progress.head);
        });

      if (unfinished !== null) yield* prune(unfinished);
      if (unfinished === null) {
        const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread.thread_id
          FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id > ${cursor}
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = thread.thread_id
                AND run.status IN ${sql.in(ACTIVE_RUN_STATUSES)}
            )
          ORDER BY thread.thread_id ASC
          LIMIT ${THREADS_PER_PASS}
        `;
        let visited = 0;
        for (const { thread_id: threadId } of threads) {
          if (deletedRows >= rowsPerPass) break;
          visited += 1;
          cursor = threadId;
          const head = (yield* sql<{ readonly sequence: number; readonly occurred_at: string }>`
            SELECT sequence, occurred_at
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            ORDER BY sequence DESC
            LIMIT 1
          `)[0];
          if (head === undefined || prunedThrough.get(threadId) === head.sequence) continue;
          if (nowMs - Date.parse(head.occurred_at) < NODE_UPDATE_RETENTION_IDLE_MS) continue;
          yield* prune(startProgress(threadId, head.sequence));
          if (unfinished !== null) break;
        }
        if (
          unfinished === null &&
          visited === threads.length &&
          threads.length < THREADS_PER_PASS
        ) {
          cursor = "";
          nextWalkAt = nowMs + NODE_UPDATE_RETENTION_INTERVAL_MS;
        }
      }
      if (deletedRows > 0) {
        yield* increment(orchestrationNodeUpdatesPrunedTotal, {}, deletedRows);
        yield* Effect.logInfo("orchestration-v2.node-update-retention.pruned", {
          deletedRows,
          threads: prunedThreads.size,
        });
      }
      return { deletedRows, threads: prunedThreads.size };
    });

    return { pruneThread, runPass };
  });

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const retention = yield* make();
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register(
      "node-update-retention",
      retention.runPass.pipe(Effect.withSpan("NodeUpdateRetention.runPass")),
    );
  }),
);
