import type { organizationTaskContext } from "./OrganizationTaskContext.ts";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  OrchestrationV2Command,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as OrganizationWorkspace from "./OrganizationWorkspace.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as FileSystem from "effect/FileSystem";
import * as ThreadManagement from "./ThreadManagementService.ts";
import type { OrganizationThread, OrganizationTask } from "@t3tools/contracts";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";

const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(PlatformTestLayer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const TestLayer = Layer.mergeAll(
  ProjectStore.layer,
  EffectOutbox.layer,
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(PlatformTestLayer),
);

const NativeToolkitLayer = McpHttpServer.ThreadToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(TestLayer),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
);
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "organization-regression", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "organization-regression", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "reviews actual child artifacts, consolidates the outcome and reserves final acceptance for the user",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const projects = yield* ProjectService.ProjectService;
      const sink = yield* EventSink.EventSinkV2;
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${workspace}/result.txt`, "organization proof\n");
      const projectId = ProjectId.make("organization-project");
      yield* projects.create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Organization proof",
        workspaceRoot: workspace,
      });
      const chief = ThreadId.make("chief"),
        lead = ThreadId.make("lead"),
        executor = ThreadId.make("executor"),
        reviewer = ThreadId.make("reviewer");
      const task = (id: ThreadId): OrganizationTask => ({
        title: `${id} work`,
        ownerThreadId: id,
        dependencyThreadIds: [],
        state: "queued",
        revision: null,
        reviewedRevision: null,
        reviewerThreadId: null,
        notes: null,
      });
      const create = (id: ThreadId, organization: OrganizationThread) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: id,
          projectId,
          title: id,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          createdBy: "user",
          creationSource: "web",
          organization,
        });
      yield* create(chief, { role: "chief", parentThreadId: null });
      yield* create(lead, { role: "lead", parentThreadId: chief, task: task(lead) });
      yield* create(executor, { role: "executor", parentThreadId: lead, task: task(executor) });
      yield* create(reviewer, { role: "reviewer", parentThreadId: lead });
      const now = yield* DateTime.now;
      for (const id of [lead, executor, reviewer]) {
        yield* sink.write({
          commandId: CommandId.make(`native-${id}`),
          events: [
            {
              id: EventId.make(`native-${id}`),
              type: "provider-thread.updated",
              threadId: id,
              driver,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: ProviderThreadId.make(`provider-${id}`),
                driver,
                providerInstanceId: modelSelection.instanceId,
                providerSessionId: null,
                appThreadId: id,
                ownerNodeId: NodeId.make(`node-${id}`),
                nativeThreadRef: { driver, nativeId: `native-${id}`, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
      }
      const update = (
        id: ThreadId,
        key: string,
        patch: Partial<OrganizationTask>,
        actor?: ThreadId,
      ) =>
        Effect.gen(function* () {
          const before = yield* threads.getThreadProjection(id);
          const org = before.thread.organization!;
          return yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(key),
            threadId: id,
            organization: { ...org, task: { ...org.task!, ...patch } },
            ...(actor ? { organizationActorThreadId: actor } : {}),
          });
        });
      yield* update(
        executor,
        "submit",
        { state: "awaiting_review", manifest: ["result.txt"] },
        executor,
      );
      let current = (yield* threads.getThreadProjection(executor)).thread.organization!.task!;
      assert.equal(current.files?.[0]?.bytes, 19);
      assert.equal(current.revision?.length, 64);
      yield* update(executor, "assign", { ownerThreadId: reviewer }, lead);
      assert.equal(
        (yield* update(
          executor,
          "self-review-denied",
          { state: "accepted", reviewedRevision: current.revision, reviewerThreadId: executor },
          executor,
        ).pipe(Effect.result))._tag,
        "Failure",
      );
      const reviewerProjection = yield* threads.getThreadProjection(reviewer);
      const nativeReviewer = reviewerProjection.providerThreads[0]!;
      yield* sink.write({
        commandId: CommandId.make("alias-native"),
        events: [
          {
            id: EventId.make("alias-native"),
            type: "provider-thread.updated",
            threadId: reviewer,
            occurredAt: now,
            payload: {
              ...nativeReviewer,
              nativeThreadRef: { driver, nativeId: `native-${executor}`, strength: "strong" },
            },
          },
        ],
      });
      assert.equal(
        (yield* update(
          executor,
          "alias-review-denied",
          { state: "accepted", reviewedRevision: current.revision, reviewerThreadId: reviewer },
          reviewer,
        ).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* sink.write({
        commandId: CommandId.make("restore-native"),
        events: [
          {
            id: EventId.make("restore-native"),
            type: "provider-thread.updated",
            threadId: reviewer,
            occurredAt: now,
            payload: nativeReviewer,
          },
        ],
      });

      yield* update(
        executor,
        "review",
        { state: "accepted", reviewedRevision: current.revision, reviewerThreadId: reviewer },
        reviewer,
      );
      yield* update(lead, "consolidate", { state: "awaiting_review" }, lead);
      current = (yield* threads.getThreadProjection(lead)).thread.organization!.task!;
      assert.deepEqual(current.dependencyThreadIds, [executor]);
      assert.equal(current.files?.[0]?.path, "executor/result.txt");
      yield* update(lead, "assign-final", { ownerThreadId: reviewer }, chief);
      yield* update(
        lead,
        "review-final",
        { reviewedRevision: current.revision, reviewerThreadId: reviewer },
        reviewer,
      );
      const forbidden = yield* update(lead, "agent-accept", { state: "accepted" }, chief).pipe(
        Effect.result,
      );
      assert.equal(forbidden._tag, "Failure");
      yield* update(lead, "user-accept", { state: "accepted" });
      assert.equal(
        (yield* threads.getThreadProjection(lead)).thread.organization!.task!.state,
        "accepted",
      );
      yield* fs.writeFileString(`${workspace}/result.txt`, "changed after review");
      const changed = yield* update(lead, "stale-accept", { state: "accepted" }).pipe(
        Effect.result,
      );
      assert.equal(changed._tag, "Failure");
    }).pipe(
      Effect.provide(
        ThreadManagement.layer.pipe(
          Layer.provideMerge(TestLayer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "native delegation reserves a separate worktree before any child provider start and replays once",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectService.ProjectService;
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* ProcessRunner.ProcessRunner;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const args of [
        ["init"],
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        ],
      ]) {
        const git = yield* runner.run({
          command: "git",
          args,
          cwd: root,
          timeout: "10 seconds",
          maxOutputBytes: 1024 * 1024,
        });
        assert.equal(git.code, 0);
      }
      const projectId = ProjectId.make("native-organization-project"),
        chief = ThreadId.make("native-chief");
      yield* projects.create({
        commandId: CommandId.make("native-project"),
        projectId,
        title: "Native organization",
        workspaceRoot: root,
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("native-chief-create"),
        threadId: chief,
        projectId,
        title: "Chief",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        organization: { role: "chief", parentThreadId: null },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("native-chief-start"),
        messageId: MessageId.make("native-chief-request"),
        threadId: chief,
        text: "Delegate the outcome",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parent = yield* orchestrator.getThreadProjection(chief);
      const run = parent.runs[0]!;
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("native-delegate"),
        parentThreadId: chief,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Create an outcome plan and delegate implementation",
        title: "Outcome",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const result = yield* orchestrator.dispatch(command);
      const created = result.storedEvents.find((event) => event.event.type === "thread.created");
      assert.isDefined(created);
      const child = yield* orchestrator.getThreadProjection(created!.event.threadId);
      assert.equal(child.thread.organization?.role, "lead");
      assert.equal(child.thread.organization?.parentThreadId, chief);
      assert.equal(child.thread.worktreePath, null);
      assert.equal(child.runs[0]?.status, "preparing");
      const replay = yield* orchestrator.dispatch(command);
      assert.equal(replay.sequence, result.sequence);
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.filter(
          (thread) => thread.organization?.parentThreadId === chief,
        ).length,
        1,
      );
      yield* OrganizationWorkspace.prepare({
        commandId: command.commandId,
        threadId: child.thread.id,
        runId: child.runs[0]!.id,
      });
      const prepared = yield* orchestrator.getThreadProjection(child.thread.id);
      assert.equal(prepared.runs[0]?.status, "starting");
      assert.notEqual(prepared.thread.worktreePath, root);
      assert.isTrue(yield* fs.exists(`${prepared.thread.worktreePath}/.git`));
      yield* OrganizationWorkspace.prepare({
        commandId: command.commandId,
        threadId: child.thread.id,
        runId: child.runs[0]!.id,
      });
      assert.equal((yield* orchestrator.getThreadProjection(child.thread.id)).runs.length, 1);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const delegateImplementation = {
        ...command,
        commandId: CommandId.make("native-implementation"),
        parentThreadId: child.thread.id,
        parentRunId: prepared.runs[0]!.id,
        parentNodeId: prepared.runs[0]!.rootNodeId!,
        task: "Create result.txt",
        title: "Implementation",
      };
      const implementation = yield* orchestrator.dispatch(delegateImplementation);
      const executorId = implementation.storedEvents.find(
        (event) => event.event.type === "thread.created",
      )!.event.threadId;
      const executor = yield* orchestrator.getThreadProjection(executorId);
      yield* OrganizationWorkspace.prepare({
        commandId: delegateImplementation.commandId,
        threadId: executorId,
        runId: executor.runs[0]!.id,
      });
      const readyExecutor = yield* threads.getThreadProjection(executorId);
      yield* fs.writeFileString(
        `${readyExecutor.thread.worktreePath}/result.txt`,
        "organization proof\n",
      );
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("native-submit"),
        threadId: executorId,
        organizationActorThreadId: executorId,
        organization: {
          ...readyExecutor.thread.organization!,
          task: {
            ...readyExecutor.thread.organization!.task!,
            manifest: ["result.txt"],
            state: "awaiting_review",
          },
        },
      });
      const reviewCommand = {
        ...delegateImplementation,
        commandId: CommandId.make("native-review"),
        organizationReview: true,
        organizationReviewTaskThreadId: executorId,
        task: "Independently inspect result.txt",
        title: "Review",
      };
      const reviewResult = yield* orchestrator.dispatch(reviewCommand);
      const reviewerId = reviewResult.storedEvents.find(
        (event) => event.event.type === "thread.created",
      )!.event.threadId;
      const reviewer = yield* threads.getThreadProjection(reviewerId);
      assert.equal(reviewer.thread.organization?.role, "reviewer");
      assert.equal(reviewer.thread.organization?.reviewTaskThreadId, executorId);
      assert.equal(
        (yield* threads.getThreadProjection(executorId)).thread.organization?.task?.ownerThreadId,
        reviewerId,
      );
      yield* OrganizationWorkspace.prepare({
        commandId: reviewCommand.commandId,
        threadId: reviewerId,
        runId: reviewer.runs[0]!.id,
      });
      for (const id of [executorId, reviewerId]) {
        const current = yield* threads.getThreadProjection(id);
        const native = current.providerThreads[0]!;
        yield* sink.write({
          commandId: CommandId.make(`native-identity-${id}`),
          events: [
            {
              id: EventId.make(`native-identity-${id}`),
              type: "provider-thread.updated",
              threadId: id,
              occurredAt: yield* DateTime.now,
              payload: {
                ...native,
                nativeThreadRef: { driver, nativeId: `actual-distinct-${id}`, strength: "strong" },
              },
            },
          ],
        });
      }
      const server = yield* McpServer.McpServer;
      const invoke = (args: Record<string, unknown>, actorId = reviewerId) =>
        server.callTool({ name: "t3_organization_task", arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("organization-test"),
            threadId: actorId,
            providerSessionId: "native-reviewer-session",
            providerInstanceId: modelSelection.instanceId,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        );
      for (const target of [undefined, reviewerId, executorId]) {
        const read = yield* invoke({
          action: "read",
          clientRequestId: `read-${target ?? "default"}`,
          ...(target ? { threadId: target } : {}),
        });
        assert.isFalse(read.isError);
        const content = read.structuredContent as {
          threadId: string;
          workspace: string;
          organization: OrganizationThread;
        } & ReturnType<typeof organizationTaskContext>;
        assert.equal(content.threadId, executorId);
        assert.equal(content.currentOwner?.threadId, reviewerId);
        assert.equal(content.currentOwner?.role, "reviewer");
        assert.equal(content.reviewAssignment?.reviewerThreadId, reviewerId);
        assert.equal(content.reviewAssignment?.taskThreadId, executorId);
        assert.equal(content.reviewAssignment?.revision, content.organization.task?.revision);
        assert.equal(content.organization.task?.reviewerThreadId, null);
        assert.equal(content.organization.task?.reviewedRevision, null);
        assert.equal(content.reviewAttestation, null);
        assert.equal(content.artifactSources[0]?.workspace, readyExecutor.thread.worktreePath);

        assert.equal(content.workspace, readyExecutor.thread.worktreePath);
        assert.equal(content.organization.task?.files?.[0]?.path, "result.txt");
        assert.equal(content.organization.task?.files?.[0]?.bytes, 19);
        assert.equal(
          yield* fs.readFileString(`${content.workspace}/result.txt`),
          "organization proof\n",
        );
      }
      const unrelated = yield* invoke({
        action: "read",
        threadId: child.thread.id,
        clientRequestId: "foreign-target-denied",
      });
      assert.equal((unrelated.structuredContent as { code: string }).code, "capability_denied");
      const inspectedRevision = (yield* threads.getThreadProjection(executorId)).thread
        .organization!.task!.revision!;
      const staleReview = yield* invoke({
        action: "accept_review",
        clientRequestId: "stale-review-denied",
        revision: "not-the-inspected-revision",
      });
      assert.equal((staleReview.structuredContent as { code: string }).code, "invalid_request");
      const accepted = yield* invoke({
        action: "accept_review",
        revision: inspectedRevision,
        clientRequestId: "native-review-accept",
        notes: "Inspected the exact 19-byte manifest file independently.",
      });
      assert.equal((accepted.structuredContent as { threadId?: string }).threadId, executorId);

      assert.equal(
        (yield* threads.getThreadProjection(executorId)).thread.organization?.task?.state,
        "accepted",
      );
      const approved = accepted.structuredContent as ReturnType<typeof organizationTaskContext>;
      assert.equal(approved.reviewAttestation?.reviewerThreadId, reviewerId);
      assert.equal(approved.reviewAssignment, null);
      const outcome = (yield* threads.getThreadProjection(child.thread.id)).thread.organization!;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("native-outcome-submit"),
        threadId: child.thread.id,
        organizationActorThreadId: child.thread.id,
        organization: { ...outcome, task: { ...outcome.task!, state: "awaiting_review" } },
      });
      const finalReview = yield* orchestrator.dispatch({
        ...reviewCommand,
        commandId: CommandId.make("native-final-review"),
        organizationReviewTaskThreadId: child.thread.id,
        task: "Review the consolidated outcome",
        title: "Outcome review",
      });
      const finalReviewerId = finalReview.storedEvents.find(
        (event) => event.event.type === "thread.created",
      )!.event.threadId;
      const aggregateRead = yield* invoke(
        { action: "read", clientRequestId: "aggregate-read" },
        finalReviewerId,
      );
      const aggregate = aggregateRead.structuredContent as {
        threadId: string;
        organization: OrganizationThread;
      } & ReturnType<typeof organizationTaskContext>;
      assert.equal(aggregate.threadId, child.thread.id);
      assert.equal(aggregate.reviewAssignment?.reviewerThreadId, finalReviewerId);
      assert.equal(aggregate.artifactSources.length, 1);
      assert.equal(aggregate.artifactSources[0]?.taskThreadId, executorId);
      assert.deepEqual(aggregate.artifactSources[0]?.manifest, ["result.txt"]);
      assert.equal(
        yield* fs.readFileString(
          `${aggregate.artifactSources[0]!.workspace}/${aggregate.artifactSources[0]!.manifest[0]}`,
        ),
        "organization proof\n",
      );
      assert.equal(
        aggregate.artifactSources[0]?.acceptedRevision,
        approved.reviewAttestation?.revision,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ProcessRunner.layer, NativeToolkitLayer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "all worker follow-ups reserve through durable admission and an eleventh waits without consuming a command receipt",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectService.ProjectService;
      const fs = yield* FileSystem.FileSystem;
      const sink = yield* EventSink.EventSinkV2;
      const root = yield* fs.makeTempDirectoryScoped();
      const projectId = ProjectId.make("capacity-project"),
        chief = ThreadId.make("capacity-chief"),
        lead = ThreadId.make("capacity-lead");
      yield* projects.create({
        commandId: CommandId.make("capacity-project-create"),
        projectId,
        title: "Capacity",
        workspaceRoot: root,
      });
      const create = (id: ThreadId, organization: OrganizationThread) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`capacity-create-${id}`),
          threadId: id,
          projectId,
          title: id,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: root,
          createdBy: "user",
          creationSource: "web",
          organization,
        });
      yield* create(chief, { role: "chief", parentThreadId: null });
      yield* create(lead, { role: "lead", parentThreadId: chief });
      const workers: Array<{ threadId: ThreadId; runId: RunId }> = [];
      for (let i = 0; i < 11; i++) {
        const id = ThreadId.make(`capacity-worker-${i}`);
        yield* create(id, {
          role: "executor",
          parentThreadId: lead,
          task: {
            title: "Implementation",
            ownerThreadId: id,
            dependencyThreadIds: [],
            state: "queued",
            revision: null,
            reviewedRevision: null,
            reviewerThreadId: null,
            notes: null,
          },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`capacity-message-${i}`),
          threadId: id,
          messageId: MessageId.make(`capacity-message-${i}`),
          text: "Continue implementation",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.equal(projection.runs[0]?.status, "preparing");
        workers.push({ threadId: id, runId: projection.runs[0]!.id });
        if (i < 10)
          yield* orchestrator.dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`capacity-release-${i}`),
            threadId: id,
            runId: projection.runs[0]!.id,
          });
      }
      const busySwitch = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("busy-switch-denied"),
          threadId: workers[0]!.threadId,
          messageId: MessageId.make("busy-switch"),
          text: "Switch worker provider",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          modelSelection: { instanceId: ProviderInstanceId.make("other-provider"), model: "other" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.result);
      assert.equal(busySwitch._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(workers[0]!.threadId)).runs.length, 1);
      const beforeSelection = yield* orchestrator.getThreadProjection(workers[0]!.threadId);
      yield* sink.write({
        commandId: CommandId.make("preselect-other-provider"),
        events: [
          {
            id: EventId.make("preselect-other-provider"),
            type: "thread.provider-switched",
            threadId: beforeSelection.thread.id,
            occurredAt: yield* DateTime.now,
            payload: {
              ...beforeSelection.thread,
              providerInstanceId: ProviderInstanceId.make("other-provider"),
              modelSelection: {
                instanceId: ProviderInstanceId.make("other-provider"),
                model: "other",
              },
            },
          },
        ],
      });
      const preselected = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("busy-preselected-switch-denied"),
          threadId: beforeSelection.thread.id,
          messageId: MessageId.make("busy-preselected-switch"),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.result);
      assert.equal(preselected._tag, "Failure");
      if (
        preselected._tag === "Failure" &&
        preselected.failure._tag === "OrchestratorDispatchError"
      )
        assert.include(String(preselected.failure.cause), "retain their native provider identity");
      else assert.fail("Expected pinned native provider validation before queue creation");
      assert.equal(
        (yield* orchestrator.getThreadProjection(beforeSelection.thread.id)).runs.length,
        1,
      );
      const last = workers[10]!;
      const release = {
        type: "prepared-run.release" as const,
        commandId: CommandId.make("capacity-release-last"),
        ...last,
      };
      for (let i = 0; i < 7; i++)
        assert.equal((yield* orchestrator.dispatch(release).pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* orchestrator.getThreadProjection(last.threadId)).runs[0]?.status,
        "preparing",
      );
      const first = yield* orchestrator.getThreadProjection(workers[0]!.threadId);
      yield* sink.write({
        commandId: CommandId.make("capacity-complete-first"),
        events: [
          {
            id: EventId.make("capacity-complete-first"),
            type: "run.updated",
            threadId: first.thread.id,
            runId: first.runs[0]!.id,
            occurredAt: yield* DateTime.now,
            payload: { ...first.runs[0]!, status: "completed", completedAt: yield* DateTime.now },
          },
        ],
      });
      yield* orchestrator.dispatch(release);
      const started = yield* orchestrator.getThreadProjection(last.threadId);
      assert.equal(started.runs[0]?.status, "starting");
      const replay = yield* orchestrator.dispatch(release);
      assert.isAbove(replay.sequence, 0);
      assert.equal((yield* orchestrator.getThreadProjection(last.threadId)).runs.length, 1);
    }).pipe(Effect.provide(TestLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it("wire commands cannot provide server artifact verification or spoof an agent actor through the user endpoint", () => {
  const decoded = decodeCommand({
    type: "thread.metadata.update",
    commandId: "spoof",
    threadId: "task",
    organizationActorThreadId: "reviewer",
    organizationVerification: { revision: "forged", previousRevision: null },
  });
  assert.isFalse("organizationVerification" in decoded);
  const bound = ThreadManagement.withCreationProvenance(decoded, {
    createdBy: "user",
    creationSource: "web",
  });
  assert.isFalse("organizationActorThreadId" in bound);
});
