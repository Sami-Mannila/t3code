import { organizationTaskContext } from "./OrganizationTaskContext.ts";
import {
  organizationInstructions,
  organizationPreparationBlock,
  organizationPreparationUnblock,
} from "./OrganizationPolicy.ts";
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
  DEFAULT_SERVER_SETTINGS,
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
import * as OrganizationOutcomeAcceptanceReactor from "./OrganizationOutcomeAcceptanceReactor.ts";
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
  "reviews actual child artifacts, consolidates the outcome and accepts it once its pull requests merge",
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
      assert.isTrue(
        (yield* threads.getThreadProjection(lead)).messages.some(
          (message) => message.id === "organization-parent:review",
        ),
      );
      const chiefNotices = threads
        .getThreadProjection(chief)
        .pipe(
          Effect.map((projection) =>
            projection.messages.filter((message) => message.id.startsWith("organization:")),
          ),
        );
      // Executor submission, assignment and review reach the lead, not the Chief.
      assert.deepEqual(yield* chiefNotices, []);
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
      // A reviewed outcome is news even though the lead's state is unchanged.
      const reviewedNotices = yield* chiefNotices;
      assert.deepEqual(
        reviewedNotices.map((message) => message.id),
        ["organization:consolidate", "organization:review-final"],
      );
      assert.include(
        reviewedNotices[1]?.text,
        `[${lead}] awaiting review, independently reviewed:`,
      );
      const forbidden = yield* update(lead, "agent-accept", { state: "accepted" }, chief).pipe(
        Effect.result,
      );
      assert.equal(forbidden._tag, "Failure");

      // The server accepts the outcome once the pull requests it owns merge.
      const reactor = yield* OrganizationOutcomeAcceptanceReactor.make;
      const leadTask = threads
        .getThreadProjection(lead)
        .pipe(Effect.map((projection) => projection.thread.organization!.task!));
      const link = (number: number, linkedAt: string, state: "open" | "closed" | "merged") => ({
        host: "github.com",
        repository: "acme/app",
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        source: "agent" as const,
        linkedAt,
        snapshot: {
          state,
          title: "Work",
          headBranch: "work",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: linkedAt,
        },
        stack: null,
      });
      const linkPullRequests = (id: ThreadId, key: string, links: ReturnType<typeof link>[]) =>
        Effect.gen(function* () {
          const thread = (yield* threads.getThreadProjection(id)).thread;
          yield* sink.write({
            commandId: CommandId.make(key),
            events: [
              {
                id: EventId.make(key),
                type: "thread.pull-request-synced",
                threadId: id,
                occurredAt: yield* DateTime.now,
                payload: { ...thread, pullRequests: links },
              },
            ],
          });
        });
      const linkedAt = DateTime.formatIso(yield* DateTime.now);
      // A link older than the lead (test clocks start at the epoch) was inherited; it gates nothing.
      yield* linkPullRequests(lead, "lead-inherited-pr", [
        link(1, "1969-12-31T00:00:00.000Z", "open"),
      ]);
      yield* linkPullRequests(executor, "executor-pr-open", [link(12, linkedAt, "open")]);
      // Work the lead starts after the review is separate scope.
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-later-executor"),
        threadId: ThreadId.make("later-executor"),
        projectId,
        title: "later-executor",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: workspace,
        createdBy: "user",
        creationSource: "web",
        organization: {
          role: "executor",
          parentThreadId: lead,
          task: { ...task(ThreadId.make("later-executor")), state: "working" },
        },
      });
      yield* reactor.sweep();
      assert.equal((yield* leadTask).state, "awaiting_review");

      const prNotices = threads
        .getThreadProjection(chief)
        .pipe(
          Effect.map((projection) =>
            projection.messages.filter((message) => message.id.startsWith("organization-pr:")),
          ),
        );
      yield* linkPullRequests(executor, "executor-pr-closed", [link(12, linkedAt, "closed")]);
      yield* reactor.sweep();
      yield* reactor.sweep();
      assert.equal((yield* leadTask).state, "awaiting_review");
      const closedNotices = yield* prNotices;
      assert.lengthOf(closedNotices, 1);
      assert.include(closedNotices[0]?.text, "PR #12 closed without merging");

      yield* linkPullRequests(executor, "executor-pr-merged", [link(12, linkedAt, "merged")]);
      // A restarted server's startup sweep finds the merge.
      const restarted = yield* OrganizationOutcomeAcceptanceReactor.make;
      yield* restarted.start();
      yield* restarted.drain;
      const accepted = yield* leadTask;
      assert.equal(accepted.state, "accepted");
      assert.equal(accepted.notes, "Accepted after merge of #12.");
      assert.isTrue(
        (yield* chiefNotices).some((message) =>
          message.text.includes(`[${lead}] accepted: lead work. Accepted after merge of #12.`),
        ),
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
      // The Chief's own pull request must not become the lead's.
      const chiefLink = {
        projectId,
        repository: "acme/app",
        number: 28064,
        url: "https://github.com/acme/app/pull/28064",
      };
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("native-chief-pr"),
        events: [
          {
            id: EventId.make("native-chief-pr"),
            type: "thread.pull-request-synced",
            threadId: chief,
            occurredAt: yield* DateTime.now,
            payload: {
              ...parent.thread,
              linkedPullRequest: chiefLink,
              branchPullRequest: chiefLink,
              pullRequests: [
                {
                  host: "github.com",
                  repository: "acme/app",
                  number: 28064,
                  url: chiefLink.url,
                  source: "agent",
                  linkedAt: DateTime.formatIso(yield* DateTime.now),
                  snapshot: null,
                  stack: null,
                },
              ],
            },
          },
        ],
      });
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
      assert.equal((yield* orchestrator.getThreadProjection(chief)).thread.pullRequests?.length, 1);
      assert.deepEqual(child.thread.pullRequests ?? [], []);
      assert.equal(child.thread.linkedPullRequest ?? null, null);
      assert.equal(child.thread.branchPullRequest ?? null, null);
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
      // Leads coordinate from the project root; only executors get a worktree.
      assert.equal(prepared.thread.worktreePath, null);
      assert.equal(prepared.thread.branch, null);
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
      const preparedReviewer = (yield* threads.getThreadProjection(reviewerId)).thread;
      assert.equal(preparedReviewer.worktreePath, null);
      assert.equal(preparedReviewer.branch, null);
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
        assert.equal(content.artifactSources[0]?.repository, ".");
        assert.equal(content.artifactSources[0]?.branch, readyExecutor.thread.branch);
        assert.equal(content.repository, ".");
        assert.equal(content.branch, readyExecutor.thread.branch);

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

/** A plain folder holding Git repositories `a` and `b`, as when a project root groups repositories. */
const multiRepositoryProject = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      runner.run({
        command: "git",
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
        cwd,
        timeout: "10 seconds",
        maxOutputBytes: 1024 * 1024,
      });
    for (const name of ["a", "b"]) {
      yield* fs.makeDirectory(`${root}/${name}`);
      assert.equal((yield* git(`${root}/${name}`, "init")).code, 0);
      assert.equal((yield* git(`${root}/${name}`, "commit", "--allow-empty", "-m", name)).code, 0);
    }
    yield* projects.create({
      commandId: CommandId.make(`${projectId}-create`),
      projectId,
      title: "Repositories",
      workspaceRoot: root,
    });
    return { root, git };
  });

const startRoot = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  projectId: ProjectId,
  role: "chief" | "advisor",
) =>
  Effect.gen(function* () {
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}-create`),
      threadId,
      projectId,
      title: role,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      organization: { role, parentThreadId: null },
    });
    const commandId = CommandId.make(`${threadId}-start`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId,
      messageId: MessageId.make(`${threadId}-request`),
      threadId,
      text: "Plan the work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    return commandId;
  });

const delegate = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  parentThreadId: ThreadId,
  key: string,
  extra: Partial<Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>> = {},
) =>
  Effect.gen(function* () {
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const run = parent.runs[0]!;
    const commandId = CommandId.make(key);
    const result = yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId,
      parentThreadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: key,
      title: key,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      ...extra,
    });
    const childId = result.storedEvents.find((event) => event.event.type === "thread.created")!
      .event.threadId;
    const child = yield* orchestrator.getThreadProjection(childId);
    yield* OrganizationWorkspace.prepare({
      commandId,
      threadId: childId,
      runId: child.runs[0]!.id,
    });
    return (yield* orchestrator.getThreadProjection(childId)).thread;
  });

it.effect(
  "only executors get a worktree: they work in a named repository under a plain folder root",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sink = yield* EventSink.EventSinkV2;
      const fs = yield* FileSystem.FileSystem;
      const projectId = ProjectId.make("repositories-project");
      const { root, git } = yield* multiRepositoryProject(projectId);
      const chief = ThreadId.make("repositories-chief");
      const advisor = ThreadId.make("repositories-advisor");
      // Chief and Advisor are user-created root roles: they run in the project root.
      for (const [id, role] of [
        [chief, "chief"],
        [advisor, "advisor"],
      ] as const) {
        const started = yield* startRoot(orchestrator, id, projectId, role);
        const effects = yield* outbox.listByCommandId(started);
        assert.deepEqual(
          effects.map((effect) => effect.request.type),
          ["provider-turn.start"],
        );
        const thread = (yield* orchestrator.getThreadProjection(id)).thread;
        assert.equal(thread.worktreePath, null);
        assert.equal(thread.branch, null);
      }

      const lead = yield* delegate(orchestrator, chief, "repositories-lead");
      assert.equal(lead.organization?.role, "lead");
      assert.equal(lead.worktreePath, null);
      assert.equal(lead.branch, null);

      const executor = yield* delegate(orchestrator, lead.id, "repositories-executor", {
        organizationRepository: "b",
      });
      assert.equal(executor.organization?.task?.repository, "b");
      assert.isNotNull(executor.worktreePath);
      const common = yield* git(
        executor.worktreePath!,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      );
      assert.equal(yield* fs.realPath(common.stdout.trim()), `${root}/b/.git`);
      assert.equal((yield* git(`${root}/b`, "rev-parse", "--verify", executor.branch!)).code, 0);

      const metadata = (
        id: ThreadId,
        key: string,
        patch: Partial<OrganizationTask>,
        actor?: ThreadId,
      ) =>
        Effect.gen(function* () {
          const org = (yield* threads.getThreadProjection(id)).thread.organization!;
          return yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(key),
            threadId: id,
            organization: { ...org, task: { ...org.task!, ...patch } },
            ...(actor ? { organizationActorThreadId: actor } : {}),
          });
        });
      const moved = yield* metadata(
        executor.id,
        "repository-moved",
        { repository: "a" },
        lead.id,
      ).pipe(Effect.result);
      assert.isTrue(
        moved._tag === "Failure" &&
          String((moved.failure as { cause?: unknown }).cause).includes("repository is fixed"),
      );

      yield* fs.writeFileString(`${executor.worktreePath}/result.txt`, "repository b\n");
      yield* metadata(
        executor.id,
        "repositories-submit",
        { state: "awaiting_review", manifest: ["result.txt"] },
        executor.id,
      );
      const reviewer = yield* delegate(orchestrator, lead.id, "repositories-review", {
        organizationReview: true,
        organizationReviewTaskThreadId: executor.id,
      });
      assert.equal(reviewer.worktreePath, null);
      assert.equal(reviewer.branch, null);
      const reviewRepository = yield* orchestrator
        .dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("repositories-review-repository"),
          parentThreadId: lead.id,
          parentRunId: (yield* orchestrator.getThreadProjection(lead.id)).runs[0]!.id,
          parentNodeId: (yield* orchestrator.getThreadProjection(lead.id)).runs[0]!.rootNodeId!,
          task: "Review",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
          organizationReview: true,
          organizationReviewTaskThreadId: executor.id,
          organizationRepository: "b",
        })
        .pipe(Effect.result);
      assert.isTrue(
        reviewRepository._tag === "Failure" &&
          String((reviewRepository.failure as { cause?: unknown }).cause).includes(
            "Reviewers inspect the submission in place",
          ),
      );

      // Independent review compares the recorded native conversations.
      const recordNative = (id: ThreadId) =>
        Effect.gen(function* () {
          const native = (yield* threads.getThreadProjection(id)).providerThreads[0]!;
          yield* sink.write({
            commandId: CommandId.make(`repositories-native-${id}`),
            events: [
              {
                id: EventId.make(`repositories-native-${id}`),
                type: "provider-thread.updated",
                threadId: id,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...native,
                  nativeThreadRef: { driver, nativeId: `distinct-${id}`, strength: "strong" },
                },
              },
            ],
          });
        });
      yield* recordNative(executor.id);
      yield* recordNative(reviewer.id);
      const submitted = (yield* threads.getThreadProjection(executor.id)).thread.organization!
        .task!;
      yield* metadata(
        executor.id,
        "repositories-accept",
        { state: "accepted", reviewedRevision: submitted.revision, reviewerThreadId: reviewer.id },
        reviewer.id,
      );
      // The lead submits its outcome without a lead worktree.
      yield* metadata(lead.id, "repositories-outcome", { state: "awaiting_review" }, lead.id);
      const outcome = (yield* threads.getThreadProjection(lead.id)).thread.organization!.task!;
      assert.equal(outcome.files?.[0]?.path, `${executor.id}/result.txt`);
      const outcomeReviewer = yield* delegate(
        orchestrator,
        lead.id,
        "repositories-outcome-review",
        {
          organizationReview: true,
          organizationReviewTaskThreadId: lead.id,
        },
      );
      yield* recordNative(lead.id);
      yield* recordNative(outcomeReviewer.id);
      yield* metadata(
        lead.id,
        "repositories-outcome-attest",
        { reviewedRevision: outcome.revision, reviewerThreadId: outcomeReviewer.id },
        outcomeReviewer.id,
      );
      // No pull request was opened: the server accepts the outcome on its review.
      yield* (yield* OrganizationOutcomeAcceptanceReactor.make).sweep();
      const accepted = (yield* threads.getThreadProjection(lead.id)).thread.organization!.task!;
      assert.equal(accepted.state, "accepted");
      assert.equal(
        accepted.notes,
        "Accepted after independent review; no pull request was opened.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ProcessRunner.layer, NativeToolkitLayer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("retrying a failed organization preparation runs the organization prepare again", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const projectId = ProjectId.make("retry-project");
    yield* multiRepositoryProject(projectId);
    const chief = ThreadId.make("retry-chief");
    yield* startRoot(orchestrator, chief, projectId, "chief");
    const parent = yield* orchestrator.getThreadProjection(chief);
    const result = yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("retry-lead"),
      parentThreadId: chief,
      parentRunId: parent.runs[0]!.id,
      parentNodeId: parent.runs[0]!.rootNodeId!,
      task: "Outcome",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const leadId = result.storedEvents.find((event) => event.event.type === "thread.created")!.event
      .threadId;
    const lead = yield* threads.getThreadProjection(leadId);
    const runId = lead.runs[0]!.id;
    // What the effect worker records when preparation fails for good.
    const failAndBlock = (key: string, notes: (task: OrganizationTask) => OrganizationTask) =>
      Effect.gen(function* () {
        yield* threads.dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make(`${key}-failed`),
          threadId: leadId,
          runId,
          failure: {
            class: "unknown",
            message: "simulated",
            code: "organization_workspace_failed",
            retryable: false,
          },
        });
        const org = (yield* threads.getThreadProjection(leadId)).thread.organization!;
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${key}-blocked`),
          threadId: leadId,
          organization: { ...org, task: notes(org.task!) },
        });
      });
    const retryRun = (key: string) =>
      Effect.gen(function* () {
        const retry = CommandId.make(key);
        yield* threads.dispatch({
          type: "prepared-run.retry",
          commandId: retry,
          threadId: leadId,
          runId,
        });
        assert.deepEqual(
          (yield* outbox.listByCommandId(retry)).map((effect) => effect.request.type),
          ["organization-workspace.prepare"],
        );
        const retried = yield* threads.getThreadProjection(leadId);
        assert.equal(retried.runs[0]?.status, "preparing");
        return { retry, task: retried.thread.organization!.task! };
      });

    // Retrying lifts the block the failed preparation recorded.
    yield* failAndBlock("retry-1", (task) => organizationPreparationBlock(task, "simulated")!);
    const first = yield* retryRun("retry-run-1");
    assert.equal(first.task.state, "queued");
    assert.equal(first.task.notes, null);

    // A block the coordinator recorded is not the preparation's to lift.
    yield* failAndBlock("retry-2", (task) => ({
      ...task,
      state: "blocked",
      notes: "Waiting for the Chief's decision.",
    }));
    const second = yield* retryRun("retry-run-2");
    assert.equal(second.task.state, "blocked");
    assert.equal(second.task.notes, "Waiting for the Chief's decision.");
    const retry = second.retry;
    yield* OrganizationWorkspace.prepare({ commandId: retry, threadId: leadId, runId });
    assert.equal((yield* threads.getThreadProjection(leadId)).runs[0]?.status, "starting");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ProcessRunner.layer, ThreadManagement.layer).pipe(
        Layer.provideMerge(TestLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it("a preparation failure blocks only work about to run, and its retry restores that work", () => {
  const task = (patch: Partial<OrganizationTask>): OrganizationTask => ({
    title: "Work",
    ownerThreadId: ThreadId.make("executor"),
    dependencyThreadIds: [],
    state: "queued",
    revision: null,
    reviewedRevision: null,
    reviewerThreadId: null,
    notes: null,
    ...patch,
  });
  for (const state of ["awaiting_review", "accepted", "blocked"] as const)
    assert.isNull(organizationPreparationBlock(task({ state }), "boom"), state);
  for (const state of ["queued", "working"] as const) {
    const blocked = organizationPreparationBlock(task({ state }), "boom")!;
    assert.equal(blocked.state, "blocked");
    assert.include(blocked.notes, "boom");
    assert.equal(organizationPreparationUnblock(blocked)?.state, "queued");
  }
  // A correction round keeps its review feedback and resumes as one.
  const lastReview = {
    reviewerThreadId: ThreadId.make("reviewer"),
    revision: "r1",
    verdict: "changes_requested" as const,
  };
  const correction = organizationPreparationBlock(
    task({ state: "changes_requested", revision: "r1", lastReview }),
    "boom",
  )!;
  const resumed = organizationPreparationUnblock(correction)!;
  assert.equal(resumed.state, "changes_requested");
  assert.deepEqual(resumed.lastReview, lastReview);
  assert.equal(resumed.notes, null);
  assert.isNull(organizationPreparationUnblock(task({ state: "blocked", notes: "Needs input." })));
  assert.isNull(organizationPreparationUnblock(task({ state: "accepted" })));
});

it("organization instructions name each role's configured model", () => {
  const settings = {
    organizationRoleModelSelections: {
      ...DEFAULT_SERVER_SETTINGS.organizationRoleModelSelections,
      executor: { instanceId: ProviderInstanceId.make("opencode-work"), model: "work-model" },
    },
  };
  const text = organizationInstructions(
    {
      id: ThreadId.make("instructions-chief"),
      organization: { role: "chief", parentThreadId: null },
      worktreePath: null,
      branch: null,
    },
    settings,
  );
  assert.include(text, "executor opencode-work work-model");
  assert.include(text, "reviewer codex gpt-6.1-sol");
  // Chief and Advisor are added by the user, not delegated.
  const delegated = text.slice(
    text.indexOf("delegate_task omits target"),
    text.indexOf("The user adds Chief and Advisor on"),
  );
  assert.include(delegated, "lead codex gpt-6.1-sol");
  assert.notInclude(delegated, "chief ");
  assert.include(text, "The user adds Chief and Advisor on chief codex gpt-6.1-sol, advisor");
  assert.notInclude(text, "executor opencode fireworks");
});

it("t3_organization_task read reports a repository only for a conversation with a task", () => {
  const thread = (id: string, organization: OrganizationThread) =>
    ({
      id: ThreadId.make(id),
      projectId: ProjectId.make("context-project"),
      title: id,
      worktreePath: null,
      branch: null,
      organization,
      deletedAt: null,
      archivedAt: null,
    }) as const;
  const executor = thread("context-executor", {
    role: "executor",
    parentThreadId: ThreadId.make("context-lead"),
    task: {
      title: "Work",
      repository: "b",
      ownerThreadId: ThreadId.make("context-executor"),
      dependencyThreadIds: [],
      state: "queued",
      revision: null,
      reviewedRevision: null,
      reviewerThreadId: null,
      notes: null,
    },
  });
  const reviewer = thread("context-reviewer", {
    role: "reviewer",
    parentThreadId: ThreadId.make("context-lead"),
    reviewTaskThreadId: executor.id,
  });
  assert.equal(organizationTaskContext(executor, [executor, reviewer]).repository, "b");
  assert.isNull(organizationTaskContext(reviewer, [executor, reviewer]).repository);
});

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

const taskNoticeSetup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const projectId = ProjectId.make("notice-project");
  yield* projects.create({
    commandId: CommandId.make("notice-project-create"),
    projectId,
    title: "Notices",
    workspaceRoot: root,
  });
  const create = (id: ThreadId, organization: OrganizationThread) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`notice-create-${id}`),
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
  const chief = ThreadId.make("notice-chief"),
    lead = ThreadId.make("notice-lead"),
    executor = ThreadId.make("notice-executor");
  yield* create(chief, { role: "chief", parentThreadId: null });
  yield* create(lead, { role: "lead", parentThreadId: chief, task: task(lead) });
  yield* create(executor, { role: "executor", parentThreadId: lead, task: task(executor) });
  const update = (id: ThreadId, key: string, patch: Partial<OrganizationTask>, actor = id) =>
    Effect.gen(function* () {
      const org = (yield* threads.getThreadProjection(id)).thread.organization!;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(key),
        threadId: id,
        organizationActorThreadId: actor,
        organization: { ...org, task: { ...org.task!, ...patch } },
      });
    });
  const block = (id: ThreadId, key: string, actor = id) =>
    update(id, key, { state: "blocked", notes: "Needs input." }, actor);
  const notices = (id: ThreadId) =>
    threads
      .getThreadProjection(id)
      .pipe(
        Effect.map((projection) =>
          projection.messages.filter((message) => message.id.startsWith("organization")),
        ),
      );
  const noticeIds = (id: ThreadId) =>
    notices(id).pipe(Effect.map((messages) => messages.map((message) => message.id as string)));
  const chiefRuns = threads
    .getThreadProjection(chief)
    .pipe(Effect.map((projection) => projection.runs));
  return { orchestrator, chief, lead, executor, update, block, notices, noticeIds, chiefRuns };
});

const taskNoticeLayer = ThreadManagement.layer.pipe(
  Layer.provideMerge(TestLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("a child task update wakes both the Chief and the parent lead", () =>
  Effect.gen(function* () {
    const { chief, lead, executor, block, notices, noticeIds } = yield* taskNoticeSetup;
    yield* block(executor, "executor-blocked");
    assert.deepEqual(yield* noticeIds(chief), ["organization:executor-blocked"]);
    assert.deepEqual(yield* noticeIds(lead), ["organization-parent:executor-blocked"]);
    const [leadNotice] = yield* notices(lead);
    assert.equal(leadNotice?.senderThreadId, executor);
    assert.include(leadNotice?.text, "Continue your own task");
    assert.deepEqual(yield* noticeIds(executor), []);
  }).pipe(Effect.provide(taskNoticeLayer)),
);

it.effect("a lead task update notifies only its Chief parent, once", () =>
  Effect.gen(function* () {
    const { chief, lead, executor, block, noticeIds } = yield* taskNoticeSetup;
    yield* block(lead, "lead-blocked");
    assert.deepEqual(yield* noticeIds(chief), ["organization:lead-blocked"]);
    assert.deepEqual(yield* noticeIds(lead), []);
    assert.deepEqual(yield* noticeIds(executor), []);
  }).pipe(Effect.provide(taskNoticeLayer)),
);

it.effect("a lead updating its executor's task does not notify itself", () =>
  Effect.gen(function* () {
    const { chief, lead, executor, block, noticeIds } = yield* taskNoticeSetup;
    yield* block(executor, "lead-blocks-executor", lead);
    assert.deepEqual(yield* noticeIds(chief), ["organization:lead-blocks-executor"]);
    assert.deepEqual(yield* noticeIds(lead), []);
  }).pipe(Effect.provide(taskNoticeLayer)),
);

it.effect("a child update under an archived lead is refused and sends no notices", () =>
  Effect.gen(function* () {
    const { orchestrator, chief, lead, executor, block, noticeIds } = yield* taskNoticeSetup;
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("notice-archive-lead"),
      threadId: lead,
    });
    // An archived lead breaks the reporting chain, so the update itself is refused.
    const orphaned = yield* block(executor, "executor-blocked-orphan").pipe(Effect.result);
    assert.equal(orphaned._tag, "Failure");
    assert.deepEqual(yield* noticeIds(chief), []);
    assert.deepEqual(yield* noticeIds(lead), []);
  }).pipe(Effect.provide(taskNoticeLayer)),
);

it.effect("the Chief hears only status changes of its leads and blocked work", () =>
  Effect.gen(function* () {
    const { chief, lead, executor, update, noticeIds } = yield* taskNoticeSetup;
    yield* update(lead, "lead-notes", { notes: "Planning the outcome." });
    yield* update(lead, "lead-manifest", { manifest: ["plan.md"] });
    // Executor claims and progress belong to the parent lead.
    yield* update(executor, "executor-claim", { state: "working" });
    yield* update(executor, "executor-notes", { notes: "Halfway." });
    assert.deepEqual(yield* noticeIds(chief), []);
    assert.deepEqual(yield* noticeIds(lead), [
      "organization-parent:executor-claim",
      "organization-parent:executor-notes",
    ]);
    yield* update(lead, "lead-claim", { state: "working" });
    assert.deepEqual(yield* noticeIds(chief), ["organization:lead-claim"]);
  }).pipe(Effect.provide(taskNoticeLayer)),
);

it.effect("the Chief is not woken by its own task updates", () =>
  Effect.gen(function* () {
    const { chief, lead, block, noticeIds } = yield* taskNoticeSetup;
    yield* block(lead, "chief-blocks-lead", chief);
    assert.deepEqual(yield* noticeIds(chief), []);
  }).pipe(Effect.provide(taskNoticeLayer)),
);

it.effect("queued Chief notices merge into one turn with each task's latest state", () =>
  Effect.gen(function* () {
    const { chief, lead, executor, update, block, notices, noticeIds, chiefRuns } =
      yield* taskNoticeSetup;
    // The first notice starts a Chief turn; the next one queues behind it.
    yield* update(lead, "lead-claim", { state: "working" });
    yield* block(executor, "executor-blocked");
    yield* block(lead, "lead-blocked");
    yield* update(lead, "lead-unblocked", { state: "working", notes: null });
    assert.sameMembers(yield* noticeIds(chief), [
      "organization:lead-claim",
      "organization:executor-blocked",
    ]);
    const runs = yield* chiefRuns;
    assert.equal(runs.length, 2);
    const queued = runs.filter((run) => run.status === "queued");
    assert.deepEqual(
      queued.map((run) => run.userMessageId),
      ["organization:executor-blocked"],
    );
    const merged = (yield* notices(chief)).find(
      (message) => message.id === "organization:executor-blocked",
    )!;
    const lines = merged.text.split("\n").filter((line) => line.startsWith("- ["));
    assert.deepEqual(lines, [
      `- [${executor}] blocked: ${executor} work. Needs input.`,
      `- [${lead}] working: ${lead} work.`,
    ]);
    assert.equal(merged.notification?.outcome, "failed");
    assert.equal(merged.notification?.summary, "2 task updates");
    assert.notInclude(merged.text, "Explain the outcome");
    assert.include(merged.text, "end your turn without a message");
  }).pipe(Effect.provide(taskNoticeLayer)),
);

it.effect(
  "the Chief and its leads ask the user through a durable question only the user answers",
  () =>
    Effect.gen(function* () {
      const { orchestrator, chief, lead, executor } = yield* taskNoticeSetup;
      for (const id of [chief, lead, executor])
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`ask-start-${id}`),
          messageId: MessageId.make(`ask-start-${id}`),
          threadId: id,
          text: "Work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      const server = yield* McpServer.McpServer;
      const call = (actor: ThreadId, name: string, args: Record<string, unknown>) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("organization-test"),
            threadId: actor,
            providerSessionId: `session-${actor}`,
            providerInstanceId: modelSelection.instanceId,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        );
      const ask = (actor: ThreadId, clientRequestId: string) =>
        call(actor, "t3_organization_ask_user", {
          clientRequestId,
          questions: [
            {
              id: "release",
              header: "Release",
              question: "Ship the outcome now?",
              options: [
                { label: "Ship", description: "Merge today" },
                { label: "Wait", description: "Hold for review" },
              ],
            },
          ],
        });
      const content = (result: { structuredContent?: unknown }) =>
        result.structuredContent as { requestId: string; threadId: string; code?: string };
      const pending = orchestrator
        .getThreadProjection(chief)
        .pipe(
          Effect.map((projection) =>
            projection.runtimeRequests.filter((request) => request.status === "pending"),
          ),
        );

      const first = yield* ask(chief, "decide-release");
      assert.isFalse(first.isError);
      const replay = yield* ask(chief, "decide-release");
      assert.equal(content(replay).requestId, content(first).requestId);
      assert.lengthOf(yield* pending, 1);

      // A lead's question opens where the user talks to the organization.
      const fromLead = yield* ask(lead, "lead-scope");
      assert.isFalse(fromLead.isError);
      assert.equal(content(fromLead).threadId, chief);

      const denied = yield* ask(executor, "executor-question");
      assert.equal(content(denied).code, "capability_denied");

      yield* ask(chief, "third");
      const capped = yield* ask(chief, "fourth");
      assert.equal(content(capped).code, "orchestration_error");
      assert.include(
        (capped.structuredContent as { message: string }).message,
        "unanswered questions",
      );
      assert.lengthOf(yield* pending, 3);

      // Neither the asker nor another organization agent answers for the user.
      for (const actor of [chief, lead]) {
        const selfAnswer = yield* call(actor, "t3_pending_request_respond", {
          threadId: chief,
          requestId: content(first).requestId,
          answers: { release: "Ship" },
        });
        assert.equal(content(selfAnswer).code, "capability_denied", actor);
      }
      assert.lengthOf(yield* pending, 3);

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("user-answers-release"),
        threadId: chief,
        requestId: content(first).requestId as never,
        answers: { release: "Ship" },
      });
      const answered = yield* orchestrator.getThreadProjection(chief);
      assert.lengthOf(yield* pending, 2);
      assert.isTrue(
        answered.messages.some(
          (message) =>
            message.id === `async-answer:${content(first).requestId}` &&
            message.createdBy === "user",
        ),
      );
    }).pipe(Effect.provide(NativeToolkitLayer.pipe(Layer.provideMerge(taskNoticeLayer)))),
);
