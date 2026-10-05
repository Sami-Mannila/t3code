import * as DateTime from "effect/DateTime";
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
 * removed in small transactions on the shared connection. Freed pages are
 * reused by SQLite; this never runs VACUUM.
 */

/** Discovery page size and the most rows one delete transaction removes. */
export const NODE_UPDATE_RETENTION_BATCH_SIZE = 2_000;
/** A thread's newest event must be at least this old before it is pruned. */
export const NODE_UPDATE_RETENTION_IDLE_MS = 10 * 60_000;
/** Pause between full walks over all threads. */
export const NODE_UPDATE_RETENTION_INTERVAL_MS = 10 * 60_000;
const THREADS_PER_PASS = 25;
const ROWS_PER_PASS = 10_000;
const ACTIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];

export interface NodeUpdatePruneResult {
  readonly deletedRows: number;
  readonly batches: number;
  /** False when the thread gained an active run and pruning stopped early. */
  readonly complete: boolean;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Remove every `node.updated` at or below `throughSequence` that has a newer
   * `node.updated` for the same node in the same stream. Scans newest first, so
   * the first row seen per node is the one kept. Appends that race the scan
   * only add newer rows, so a row found superseded stays superseded.
   */
  const pruneThread = (threadId: string, throughSequence: number) =>
    Effect.gen(function* () {
      const retained = new Set<string>();
      let before = throughSequence + 1;
      let deletedRows = 0;
      let batches = 0;
      while (true) {
        const rows = yield* sql<{ readonly sequence: number; readonly node_id: string | null }>`
          SELECT sequence, json_extract(payload_json, '$.id') AS node_id
          FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND application_event_version = 2
            AND event_type = 'node.updated'
            AND sequence < ${before}
          ORDER BY sequence DESC
          LIMIT ${NODE_UPDATE_RETENTION_BATCH_SIZE}
        `;
        const superseded: Array<number> = [];
        for (const row of rows) {
          if (row.node_id === null) continue;
          if (retained.has(row.node_id)) superseded.push(row.sequence);
          else retained.add(row.node_id);
        }
        if (superseded.length > 0) {
          const removed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const active = yield* sql`
                SELECT 1 FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
                LIMIT 1
              `;
              if (active.length > 0) return false;
              yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(superseded)}`;
              return true;
            }),
          );
          if (!removed) {
            return { deletedRows, batches, complete: false } satisfies NodeUpdatePruneResult;
          }
          deletedRows += superseded.length;
          batches += 1;
        }
        // The connection is shared with every request; let them through between batches.
        yield* Effect.yieldNow;
        const last = rows.at(-1);
        if (last === undefined || rows.length < NODE_UPDATE_RETENTION_BATCH_SIZE) {
          return { deletedRows, batches, complete: true } satisfies NodeUpdatePruneResult;
        }
        before = last.sequence;
      }
    });

  // Walk position and per-thread progress live in memory; after a restart the
  // first walk revisits every thread once, which finds nothing to delete on
  // threads already pruned.
  let cursor = "";
  let nextWalkAt = 0;
  const prunedThrough = new Map<string, number>();

  /**
   * One bounded slice of the walk over idle threads. Continues on the next call
   * until the walk finishes, then waits `NODE_UPDATE_RETENTION_INTERVAL_MS`.
   */
  const runPass = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs < nextWalkAt) return { deletedRows: 0, threads: 0 };
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
    let deletedRows = 0;
    let prunedThreads = 0;
    let budgetSpent = false;
    for (const { thread_id: threadId } of threads) {
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
      const result = yield* pruneThread(threadId, head.sequence);
      if (result.complete) prunedThrough.set(threadId, head.sequence);
      if (result.deletedRows > 0) {
        deletedRows += result.deletedRows;
        prunedThreads += 1;
      }
      if (deletedRows >= ROWS_PER_PASS) {
        budgetSpent = true;
        break;
      }
    }
    if (!budgetSpent && threads.length < THREADS_PER_PASS) {
      cursor = "";
      nextWalkAt = nowMs + NODE_UPDATE_RETENTION_INTERVAL_MS;
    }
    if (deletedRows > 0) {
      yield* increment(orchestrationNodeUpdatesPrunedTotal, {}, deletedRows);
      yield* Effect.logInfo("orchestration-v2.node-update-retention.pruned", {
        deletedRows,
        threads: prunedThreads,
      });
    }
    return { deletedRows, threads: prunedThreads };
  });

  return { pruneThread, runPass };
});

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const retention = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register(
      "node-update-retention",
      retention.runPass.pipe(Effect.withSpan("NodeUpdateRetention.runPass")),
    );
  }),
);
