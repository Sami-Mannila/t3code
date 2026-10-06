import { organizationTaskContext } from "../../../orchestration-v2/OrganizationTaskContext.ts";
import { userFacingDispatchErrorMessage } from "../../../orchestration-v2/UserFacingErrors.ts";
import {
  isServerUserInputRequest,
  SERVER_QUESTION_ID_PREFIX,
} from "../../../orchestration-v2/Orchestrator.ts";
import {
  CommandId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@t3tools/shared/model";

import {
  newCommandId,
  readCaller,
  readMutationCaller,
  readThread,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readWritableThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(unavailable));
  return { sequence: result.sequence };
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (
  input: {
    threadId?: ThreadId | undefined;
    requestId: RuntimeRequestId;
  },
  writable = false,
) {
  const context = yield* writable
    ? readWritableThread(input.threadId, ["runtimeRequests", "turnItems"])
    : readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) =>
      request.id === input.requestId &&
      request.kind === "user_input" &&
      request.status === "pending",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  return { ...context, request, item };
});
/** Surfaces the orchestrator's refusal reason, which agents need to correct the call. */
const orchestrationFailure = (error: { readonly message: string; readonly cause?: unknown }) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: userFacingDispatchErrorMessage(error) ?? error.message,
  });

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  t3_organization_task: (input) =>
    Effect.gen(function* () {
      const { caller: source } = yield* readCaller();
      let target = input.threadId ?? source.id;
      if (source.organization?.role === "reviewer") {
        const assigned = source.organization.reviewTaskThreadId;
        if (!assigned)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "This reviewer has no explicitly assigned submission. Ask the outcome lead to delegate its review target.",
          });
        if (target === source.id) target = assigned;
        if (target !== assigned)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A reviewer may access only its explicitly assigned task through this tool.",
          });
      }
      const context = yield* input.action === "read"
        ? readThread(target)
        : readWritableThread(target);
      const { projection, caller, threads } = context;
      const organization = projection.thread.organization;
      if (!organization?.task)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This conversation has no organization task.",
        });
      if (input.action === "read") {
        const snapshot = yield* threads.getShellSnapshot().pipe(Effect.mapError(unavailable));
        return {
          threadId: projection.thread.id,
          organization,
          workspace: projection.thread.worktreePath,
          ...organizationTaskContext(projection.thread, snapshot.threads),
        };
      }
      if (input.action === "adopt") {
        if (caller.organization?.role !== "lead")
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only a lead can adopt an executor task.",
          });
        if (organization.role !== "executor")
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Adoption applies to an executor task; this conversation is a ${organization.role}.`,
          });
        if (projection.thread.id === caller.id)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A lead cannot adopt its own task.",
          });
        const currentParent = organization.parentThreadId
          ? yield* threads
              .getThreadShell(organization.parentThreadId)
              .pipe(Effect.mapError(unavailable))
          : null;
        if (currentParent === null)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Adoption requires the task's current parent lead; ${organization.parentThreadId ?? "(none)"} could not be resolved.`,
          });
        if (currentParent.archivedAt === null && currentParent.deletedAt === null)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Adoption requires the task's current parent lead to be archived or deleted; ${organization.parentThreadId ?? "(none)"} is still active.`,
          });
        if (currentParent.organization?.parentThreadId !== caller.organization.parentThreadId)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Adoption requires the retired lead and the adopting lead to report to the same Chief.",
          });
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`organization:${caller.id}:${input.clientRequestId}`),
            threadId: projection.thread.id,
            organizationActorThreadId: caller.id,
            organization: { ...organization, parentThreadId: caller.id },
          })
          .pipe(Effect.mapError(orchestrationFailure));
        const adopted = yield* threads
          .getThreadShell(projection.thread.id)
          .pipe(Effect.mapError(unavailable));
        const snapshot = yield* threads.getShellSnapshot().pipe(Effect.mapError(unavailable));
        return {
          ...organizationTaskContext(adopted ?? projection.thread, snapshot.threads),
          threadId: projection.thread.id,
          organization: adopted?.organization ?? null,
          workspace: projection.thread.worktreePath,
        };
      }
      const old = organization.task;
      if (
        (input.action === "accept_review" ||
          (input.action === "request_changes" && source.organization?.role === "reviewer")) &&
        (!input.revision || input.revision !== old.revision)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Supply the exact submitted revision you inspected from t3_organization_task read. The submission may have changed; read and inspect it again before reviewing.",
        });
      const task = {
        ...old,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.manifest ? { manifest: input.manifest } : {}),
      };
      switch (input.action) {
        case "plan":
          if (input.title) task.title = input.title;
          if (input.dependencyThreadIds) task.dependencyThreadIds = input.dependencyThreadIds;
          break;
        case "claim":
          task.state = "working";
          task.ownerThreadId = projection.thread.id;
          break;
        case "block":
          task.state = "blocked";
          break;
        case "submit":
          task.state = "awaiting_review";
          task.reviewedRevision = null;
          task.reviewerThreadId = null;
          break;
        case "assign_review":
          if (!input.reviewerThreadId)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Choose an explicit reviewer conversation.",
            });
          task.ownerThreadId = input.reviewerThreadId;
          break;
        case "accept_review":
          task.state = organization.role === "lead" ? "awaiting_review" : "accepted";
          task.reviewedRevision = old.revision;
          task.reviewerThreadId = caller.id;
          break;
        case "request_changes":
          if (caller.organization?.role === "reviewer" && old.revision)
            task.lastReview = {
              reviewerThreadId: caller.id,
              revision: old.revision,
              verdict: "changes_requested",
              ...(input.notes ? { notes: input.notes } : {}),
            };
          task.state = "changes_requested";
          task.ownerThreadId = projection.thread.id;
          task.reviewedRevision = null;
          task.reviewerThreadId = null;
          break;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`organization:${caller.id}:${input.clientRequestId}`),
          threadId: projection.thread.id,
          organizationActorThreadId: caller.id,
          organization: { ...organization, task },
        })
        .pipe(Effect.mapError(orchestrationFailure));
      const updated = yield* threads
        .getThreadShell(projection.thread.id)
        .pipe(Effect.mapError(unavailable));
      const snapshot = yield* threads.getShellSnapshot().pipe(Effect.mapError(unavailable));
      return {
        ...organizationTaskContext(updated ?? projection.thread, snapshot.threads),
        threadId: projection.thread.id,
        organization: updated?.organization ?? null,
        workspace: projection.thread.worktreePath,
      };
    }),

  t3_organization_ask_user: (input) =>
    Effect.gen(function* () {
      const { caller, threads } = yield* readMutationCaller();
      const role = caller.organization?.role;
      if (role !== "chief" && role !== "lead")
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only the Chief or a lead can ask the user; report the decision to your lead.",
        });
      const snapshot = yield* threads.getShellSnapshot().pipe(Effect.mapError(unavailable));
      const chief =
        role === "chief"
          ? caller
          : snapshot.threads.find(
              (thread) =>
                thread.projectId === caller.projectId &&
                thread.organization?.role === "chief" &&
                thread.archivedAt === null &&
                thread.deletedAt === null,
            );
      if (chief === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This project has no active Chief conversation to ask the user from.",
        });
      const requestId = RuntimeRequestId.make(
        `${SERVER_QUESTION_ID_PREFIX}organization:${caller.id}:${input.clientRequestId}`,
      );
      const { runtimeRequests } = yield* threads
        .getThreadRecords(chief.id, ["runtimeRequests"])
        .pipe(Effect.mapError(unavailable));
      if (runtimeRequests.some((request) => request.id === requestId))
        return { requestId, threadId: chief.id };
      yield* threads
        .dispatch({
          type: "thread.user-input.request",
          commandId: CommandId.make(requestId),
          threadId: chief.id,
          requestId,
          questions: input.questions,
        })
        .pipe(Effect.mapError(orchestrationFailure));
      return { requestId, threadId: chief.id };
    }),

  run_scheduled_task_now: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readMutationCaller();
      if (
        caller.archivedAt !== null ||
        caller.runtimeMode !== "full-access" ||
        caller.interactionMode !== "default"
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Running a scheduled task requires a live full-access/default thread.",
        });
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId && task.projectId === caller.projectId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The task was not found in the calling project.",
        });
      const { task } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: task.id,
        threadId: task.threadId,
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  t3_thread_search: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const result = yield* threadSearch.search(input).pipe(Effect.mapError(unavailable));
      return { matches: result.matches.filter((match) => match.projectId === caller.projectId) };
    }),
  t3_thread_fork: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readWritableThread();
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence, targetThreadId };
    }),
  t3_thread_merge_back: (input) =>
    Effect.gen(function* () {
      const { threads, caller } = yield* readWritableThread(input.targetThreadId);
      const result = yield* threads
        .dispatch({
          type: "thread.merge_back",
          commandId: yield* newCommandId(),
          sourceThreadId: caller.id,
          targetThreadId: input.targetThreadId,
          sourcePoint: input.sourcePoint,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence, targetThreadId: input.targetThreadId };
    }),
  t3_thread_transfers: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  t3_thread_configuration: (input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  t3_thread_configure: (input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readWritableThread();
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
  t3_pending_request_list: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  t3_pending_request_read: (input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  t3_pending_request_respond: (input) =>
    Effect.gen(function* () {
      const { threads, projection, caller, request } = yield* readQuestion(input, true);
      // Agents never answer the user's questions for them: no agent answers a question the
      // server opened for the user, and organization agents none on their own conversation.
      if (
        isServerUserInputRequest(request) ||
        (caller.organization && projection.thread.id === caller.id)
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only the user can answer this question.",
        });
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          answers: input.answers,
          respondedByThreadId: caller.id,
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
  t3_queue_list: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  t3_queue_read: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  t3_queue_edit: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  t3_queue_cancel: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  t3_queue_reorder: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  t3_queue_promote_to_steer: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  t3_thread_organize: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readWritableThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
});
