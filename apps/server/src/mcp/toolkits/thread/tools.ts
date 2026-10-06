import {
  ScheduledTaskId,
  OrganizationThread,
  OrganizationRole,
  OrchestrationV2UserInputQuestion,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread unread in the calling project. Omit threadId for this thread. snooze requires snoozedUntil. Existing thread lifecycle rules apply; this does not schedule a future action.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QueueListTool = Tool.make("t3_queue_list", {
  ...commandTool,
  description:
    "List queued messages in delivery order. Results are a live offset page; use t3_thread_read for full thread history.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueReadTool = Tool.make("t3_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 characters of a queued message in the calling project.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("t3_queue_edit", {
  ...commandTool,
  description:
    "Replace a queued message's text, preserving its attachments. The service rejects runs that are no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
const QueueCancelTool = Tool.make("t3_queue_cancel", {
  ...commandTool,
  description: "Cancel a queued run using the existing queue command.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("t3_queue_reorder", {
  ...commandTool,
  description: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
const QueuePromoteTool = Tool.make("t3_queue_promote_to_steer", {
  ...commandTool,
  description:
    "Deliver a queued message as steering to the specified active run. Existing provider and run-state rules apply.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, true);

const requestTarget = { threadId: Schema.optional(ThreadId), requestId: RuntimeRequestId };
const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
});
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(question),
});
const PendingRequestListTool = Tool.make("t3_pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions in a thread in the calling project. Approval requests are not included.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("t3_pending_request_read", {
  ...commandTool,
  description:
    "Read a pending user question. Answer with t3_pending_request_respond; existing live or message response handling is used.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("t3_pending_request_respond", {
  ...commandTool,
  description:
    "Answer a pending user-input request using the existing runtime response command. This cannot approve a permission request.",
  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadConfigurationTool = Tool.make("t3_thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider/model selection and modes in the calling project. orchestrator_capabilities lists available providers and models.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Set this calling thread's provider, model and options with the existing selection command. This does not change permission modes or other threads. Use orchestrator_capabilities to choose a selection.",
  parameters: Schema.Struct({ modelSelection: ModelSelection }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("t3_thread_fork", {
  ...commandTool,
  description:
    "Fork this thread from a stable run or checkpoint using the existing fork command. The fork inherits the source configuration. Acceptance does not mean a provider turn has completed.",
  parameters: Schema.Struct({
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadMergeBackTool = Tool.make("t3_thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from this thread back to a related thread in the same project. Existing lineage and transfer rules apply.",
  parameters: Schema.Struct({
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadTransfersTool = Tool.make("t3_thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread in the calling project.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active thread titles and content with the app's existing bounded search. Returns matches in the calling project from the global top matches; other-project matches are omitted, so this may return fewer than limit. No pagination or exhaustive-result guarantee.",
  parameters: OrchestrationSearchThreadsInput,
  success: OrchestrationSearchThreadsResult,
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run a scheduled task in the calling project now through the existing scheduler. Requires a full-access/default caller. Each call is a new manual run; completion means dispatch/bookkeeping completed, not that the provider turn finished.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const OrganizationTaskTool = Tool.make("t3_organization_task", {
  ...commandTool,
  description:
    "Read or update a canonical organization task. Actor identity is bound to this conversation. Omit threadId to use your task; reviewers automatically target their explicitly assigned submission (their own conversation ID is an alias for that target). Other reviewer targets are rejected. Submit hashes actual manifest files; reviewers must supply the exact revision returned by read when calling accept_review or request_changes; mismatched revisions are rejected; the server accepts a reviewed lead outcome when every pull request it opened has merged, or after that review when it opened none; agents never accept outcomes. Read results distinguish reviewAssignment (current assigned reviewer) from reviewAttestation (completed review); null task.reviewerThreadId is normal before acceptance. artifactSources gives each source's repository (relative to the project root), branch and physical worktree location, including child sources for a consolidated outcome. Keep user-facing updates in the Chief conversation.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "read",
      "plan",
      "claim",
      "block",
      "submit",
      "assign_review",
      "accept_review",
      "request_changes",
    ]),
    revision: Schema.optional(TrimmedNonEmptyString),
    manifest: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    title: Schema.optional(TrimmedNonEmptyString),
    dependencyThreadIds: Schema.optional(Schema.Array(ThreadId)),
    reviewerThreadId: Schema.optional(ThreadId),
    notes: Schema.optional(TrimmedNonEmptyString),
    clientRequestId: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    organization: Schema.NullOr(OrganizationThread),
    workspace: Schema.NullOr(Schema.String),
    /** The task's repository; null for a conversation without a task. */
    repository: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    currentOwner: Schema.NullOr(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.String,
        role: Schema.NullOr(OrganizationRole),
      }),
    ),
    reviewAssignment: Schema.NullOr(
      Schema.Struct({
        reviewerThreadId: ThreadId,
        taskThreadId: ThreadId,
        revision: Schema.String,
      }),
    ),
    reviewAttestation: Schema.NullOr(
      Schema.Struct({ reviewerThreadId: ThreadId, revision: Schema.String }),
    ),
    protocol: Schema.String,
    artifactSources: Schema.Array(
      Schema.Struct({
        taskThreadId: ThreadId,
        repository: Schema.String,
        branch: Schema.NullOr(Schema.String),
        workspace: Schema.NullOr(Schema.String),
        manifest: Schema.Array(Schema.String),
        submittedRevision: Schema.NullOr(Schema.String),
        acceptedRevision: Schema.NullOr(Schema.String),
        files: Schema.Array(
          Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.Number }),
        ),
      }),
    ),
  }),
}).annotate(Tool.Destructive, true);

const OrganizationAskUserTool = Tool.make("t3_organization_ask_user", {
  ...commandTool,
  description:
    "Ask the user a decision question in the Chief conversation. The user sees a question box that stays open across turns and restarts until they answer or dismiss it; the answer arrives in the Chief conversation as their message. Use only when the user must decide; end your turn after asking instead of restating the question. Chief and leads may ask; a lead's question opens in its Chief's conversation. At most 3 questions may be open per conversation. Reusing clientRequestId returns the same question.",
  parameters: Schema.Struct({
    questions: Schema.NonEmptyArray(OrchestrationV2UserInputQuestion),
    clientRequestId: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ requestId: RuntimeRequestId, threadId: ThreadId }),
}).annotate(Tool.Destructive, false);

export const ThreadToolkit = Toolkit.make(
  OrganizationTaskTool,
  OrganizationAskUserTool,
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadForkTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
);
