import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as NodeUpdateRetention from "./NodeUpdateRetention.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const databaseLayer = SqlitePersistenceMemory;
const storesLayer = Layer.mergeAll(
  databaseLayer,
  EventStore.layer.pipe(Layer.provideMerge(databaseLayer)),
  ProjectionStore.layer.pipe(Layer.provideMerge(databaseLayer)),
);
const TestLayer = Layer.mergeAll(
  storesLayer,
  EventSink.layer.pipe(Layer.provide(storesLayer)),
  ProjectionMaintenance.layer.pipe(Layer.provide(storesLayer)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

const makeThread = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make(`project:${threadId}`),
  title: `Thread ${threadId}`,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const makeNode = (
  threadId: ThreadId,
  key: string,
  now: DateTime.Utc,
  status: OrchestrationV2ExecutionNode["status"],
): OrchestrationV2ExecutionNode => {
  const id = NodeId.make(`${threadId}:${key}`);
  return {
    id,
    threadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: id,
    kind: "reasoning",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
  };
};

let eventCounter = 0;
const nodeEvent = (node: OrchestrationV2ExecutionNode, now: DateTime.Utc) =>
  ({
    id: EventId.make(`event:retention:${eventCounter++}`),
    type: "node.updated",
    threadId: node.threadId,
    occurredAt: now,
    payload: node,
  }) satisfies OrchestrationV2DomainEvent;

/**
 * A thread whose node `a` flips status `updates` times, plus one node `b`,
 * then `visits` thread events that are not node updates.
 */
const seedThread = (threadId: ThreadId, updates: number, visits = 1) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const created: OrchestrationV2DomainEvent = {
      id: EventId.make(`event:retention:${eventCounter++}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: makeThread(threadId, now),
    };
    const events: Array<OrchestrationV2DomainEvent> = [created];
    for (let index = 0; index < updates; index++) {
      events.push(
        nodeEvent(makeNode(threadId, "a", now, index % 2 === 0 ? "running" : "waiting"), now),
      );
      if (index === 1) events.push(nodeEvent(makeNode(threadId, "b", now, "completed"), now));
    }
    events.push(nodeEvent(makeNode(threadId, "a", now, "completed"), now));
    for (let index = 0; index < visits; index++) {
      events.push({
        id: EventId.make(`event:retention:${eventCounter++}`),
        type: "thread.visited",
        threadId,
        occurredAt: now,
        payload: { ...makeThread(threadId, now), lastVisitedAt: now },
      });
    }
    yield* eventSink.write({ events });
  });

const nodeRows = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly event_type: string; readonly node_id: string | null }>`
      SELECT event_type, json_extract(payload_json, '$.id') AS node_id
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY sequence ASC
    `;
  });

const insertRun = (runId: string, threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      )
      VALUES (${runId}, ${threadId}, 1, 'codex', ${status}, '1970-01-01T00:00:00.000Z', '{}')
    `;
  });

const streamHead = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{ readonly sequence: number }>`
      SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE stream_id = ${threadId}
    `)[0]!.sequence;
  });

it.effect("spreads a large thread over passes of bounded deletions", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const retention = yield* NodeUpdateRetention.make({ batchPause: 0 });
    const perPass = NodeUpdateRetention.NODE_UPDATE_RETENTION_ROWS_PER_PASS;
    const idle = ThreadId.make("thread:retention-idle");
    const busy = ThreadId.make("thread:retention-busy");
    const updates = perPass * 2 + 500;
    yield* seedThread(idle, updates);
    yield* seedThread(busy, 3);
    yield* insertRun("run:retention-busy", busy, "running");
    const liveNodes = (yield* projections.getThreadProjection(idle)).nodes;
    const busyBefore = yield* nodeRows(busy);

    // Recently written threads wait until they have been quiet for a while.
    assert.deepEqual(yield* retention.runPass, { deletedRows: 0, threads: 0 });
    assert.equal((yield* nodeRows(idle)).length, updates + 4);

    yield* TestClock.adjust(NodeUpdateRetention.NODE_UPDATE_RETENTION_IDLE_MS + 1);
    // One thread's backlog never exceeds the per-pass budget; later passes resume it.
    assert.deepEqual(yield* retention.runPass, { deletedRows: perPass, threads: 1 });
    assert.deepEqual(yield* retention.runPass, { deletedRows: perPass, threads: 1 });
    assert.deepEqual(yield* retention.runPass, { deletedRows: 500, threads: 1 });
    // The walk finished, so the next one waits for the interval.
    assert.deepEqual(yield* retention.runPass, { deletedRows: 0, threads: 0 });

    // Node `a` keeps only its newest row; `b`, the thread events and the busy thread stay.
    assert.deepEqual(
      (yield* nodeRows(idle)).map((row) => [row.event_type, row.node_id]),
      [
        ["thread.created", idle],
        ["node.updated", `${idle}:b`],
        ["node.updated", `${idle}:a`],
        ["thread.visited", idle],
      ],
    );
    assert.deepEqual(yield* nodeRows(busy), busyBefore);

    // Replaying the pruned log reproduces the live projection.
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepEqual((yield* projections.getThreadProjection(idle)).nodes, liveNodes);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("deletes in small transactions and stops once a run starts", () =>
  Effect.gen(function* () {
    const retention = yield* NodeUpdateRetention.make({ batchPause: 0 });
    const threadId = ThreadId.make("thread:retention-batches");
    yield* seedThread(threadId, 1_000);
    const pruned = yield* retention.pruneThread(
      NodeUpdateRetention.startProgress(threadId, yield* streamHead(threadId)),
      Number.POSITIVE_INFINITY,
    );
    assert.deepEqual(pruned, {
      deletedRows: 1_000,
      batches: 1_000 / NodeUpdateRetention.NODE_UPDATE_RETENTION_DELETE_BATCH_SIZE,
      pages: 1,
      status: "complete",
    });

    // A thread that gains an active run is left alone inside the delete transaction.
    const other = ThreadId.make("thread:retention-started");
    yield* seedThread(other, 5);
    yield* insertRun("run:retention-started", other, "queued");
    const before = yield* nodeRows(other);
    const stopped = yield* retention.pruneThread(
      NodeUpdateRetention.startProgress(other, yield* streamHead(other)),
      Number.POSITIVE_INFINITY,
    );
    assert.equal(stopped.status, "busy");
    assert.equal(stopped.deletedRows, 0);
    assert.deepEqual(yield* nodeRows(other), before);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reads every event page by page when node updates are sparse", () =>
  Effect.gen(function* () {
    const retention = yield* NodeUpdateRetention.make({ batchPause: 0 });
    const pageSize = NodeUpdateRetention.NODE_UPDATE_RETENTION_PAGE_SIZE;
    const threadId = ThreadId.make("thread:retention-sparse");
    // Three node updates sit beneath two and a half pages of other events.
    yield* seedThread(threadId, 2, pageSize * 2 + pageSize / 2);
    const pruned = yield* retention.pruneThread(
      NodeUpdateRetention.startProgress(threadId, yield* streamHead(threadId)),
      Number.POSITIVE_INFINITY,
    );
    assert.deepEqual(pruned, { deletedRows: 2, batches: 1, pages: 3, status: "complete" });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("spreads discovery of a sparse thread over passes of bounded reads", () =>
  Effect.gen(function* () {
    const retention = yield* NodeUpdateRetention.make({ batchPause: 0, pagesPerPass: 1 });
    const pageSize = NodeUpdateRetention.NODE_UPDATE_RETENTION_PAGE_SIZE;
    const threadId = ThreadId.make("thread:retention-sparse-passes");
    // Node `a` has two superseded rows beneath two and a half pages of other events.
    yield* seedThread(threadId, 2, pageSize * 2 + pageSize / 2);
    yield* TestClock.adjust(NodeUpdateRetention.NODE_UPDATE_RETENTION_IDLE_MS + 1);
    const deleted: Array<number> = [];
    for (let pass = 0; pass < 3; pass++) deleted.push((yield* retention.runPass).deletedRows);
    assert.deepEqual(deleted, [0, 0, 2]);
    // The walk finished, so the next one waits for the interval.
    assert.deepEqual(yield* retention.runPass, { deletedRows: 0, threads: 0 });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("leaves events appended to a paused thread for the next walk", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const retention = yield* NodeUpdateRetention.make({ batchPause: 0 });
    const perPass = NodeUpdateRetention.NODE_UPDATE_RETENTION_ROWS_PER_PASS;
    const threadId = ThreadId.make("thread:retention-appended");
    yield* seedThread(threadId, perPass + 500);
    yield* TestClock.adjust(NodeUpdateRetention.NODE_UPDATE_RETENTION_IDLE_MS + 1);
    assert.equal((yield* retention.runPass).deletedRows, perPass);

    // New updates land while the thread is paused mid-scan.
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        nodeEvent(makeNode(threadId, "a", now, "running"), now),
        nodeEvent(makeNode(threadId, "c", now, "running"), now),
      ],
    });
    assert.equal((yield* retention.runPass).deletedRows, 500);
    const nodeIds = (
      rows: ReadonlyArray<{ readonly event_type: string; readonly node_id: string | null }>,
    ) => rows.flatMap((row) => (row.event_type === "node.updated" ? [row.node_id] : []));
    // `a` keeps the newest row of the paused scan and its appended row; `b` and `c` stay.
    assert.deepEqual(nodeIds(yield* nodeRows(threadId)), [
      `${threadId}:b`,
      `${threadId}:a`,
      `${threadId}:a`,
      `${threadId}:c`,
    ]);
    const live = (yield* projections.getThreadProjection(threadId)).nodes;
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepEqual((yield* projections.getThreadProjection(threadId)).nodes, live);

    // The next walk sees the new head and removes the row the append superseded.
    yield* TestClock.adjust(NodeUpdateRetention.NODE_UPDATE_RETENTION_INTERVAL_MS);
    assert.equal((yield* retention.runPass).deletedRows, 1);
  }).pipe(Effect.provide(TestLayer)),
);
