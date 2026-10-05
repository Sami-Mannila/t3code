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

/** A thread whose node `a` flips status `updates` times, plus one node `b` and a visit. */
const seedThread = (threadId: ThreadId, updates: number) =>
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
    events.push({
      id: EventId.make(`event:retention:${eventCounter++}`),
      type: "thread.visited",
      threadId,
      occurredAt: now,
      payload: { ...makeThread(threadId, now), lastVisitedAt: now },
    });
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

it.effect("prunes superseded node updates of idle threads in bounded batches", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const retention = yield* NodeUpdateRetention.make;
    const idle = ThreadId.make("thread:retention-idle");
    const busy = ThreadId.make("thread:retention-busy");
    const updates = NodeUpdateRetention.NODE_UPDATE_RETENTION_BATCH_SIZE * 2 + 500;
    yield* seedThread(idle, updates);
    yield* seedThread(busy, 3);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      )
      VALUES ('run:retention-busy', ${busy}, 1, 'codex', 'running', '1970-01-01T00:00:00.000Z', '{}')
    `;
    const liveNodes = (yield* projections.getThreadProjection(idle)).nodes;
    const busyBefore = yield* nodeRows(busy);

    // Recently written threads wait until they have been quiet for a while.
    assert.deepEqual(yield* retention.runPass, { deletedRows: 0, threads: 0 });
    assert.equal((yield* nodeRows(idle)).length, updates + 4);

    yield* TestClock.adjust(NodeUpdateRetention.NODE_UPDATE_RETENTION_IDLE_MS + 1);
    const pass = yield* retention.runPass;
    // The walk finished, so the next one waits for the interval.
    assert.deepEqual(yield* retention.runPass, { deletedRows: 0, threads: 0 });

    // Node `a` keeps only its newest row; `b`, the thread events and the busy thread stay.
    assert.deepEqual(pass, { deletedRows: updates, threads: 1 });
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

it.effect("deletes at most one batch per transaction and stops once a run starts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const retention = yield* NodeUpdateRetention.make;
    const threadId = ThreadId.make("thread:retention-batches");
    const updates = NodeUpdateRetention.NODE_UPDATE_RETENTION_BATCH_SIZE * 2 + 500;
    yield* seedThread(threadId, updates);
    const head = (yield* sql<{ readonly sequence: number }>`
      SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE stream_id = ${threadId}
    `)[0]!.sequence;

    const pruned = yield* retention.pruneThread(threadId, head);
    assert.deepEqual(pruned, { deletedRows: updates, batches: 3, complete: true });

    // A thread that gains an active run is left alone inside the delete transaction.
    const other = ThreadId.make("thread:retention-started");
    yield* seedThread(other, 5);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      )
      VALUES ('run:retention-started', ${other}, 1, 'codex', 'queued', '1970-01-01T00:00:00.000Z', '{}')
    `;
    const before = yield* nodeRows(other);
    const otherHead = (yield* sql<{ readonly sequence: number }>`
      SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE stream_id = ${other}
    `)[0]!.sequence;
    assert.deepEqual(yield* retention.pruneThread(other, otherHead), {
      deletedRows: 0,
      batches: 0,
      complete: false,
    });
    assert.deepEqual(yield* nodeRows(other), before);
  }).pipe(Effect.provide(TestLayer)),
);
