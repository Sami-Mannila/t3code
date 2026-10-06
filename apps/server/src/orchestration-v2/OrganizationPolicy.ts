import * as Equal from "effect/Equal";
import { resolveOrganizationRoleModelSelection } from "@t3tools/shared/serverSettings";
import {
  DEFAULT_SERVER_SETTINGS,
  ORGANIZATION_TASK_ROUND_LIMIT,
  type OrganizationRepositoryPath,
  type OrganizationRole,
  type OrganizationTask,
  type OrganizationThread,
  type OrchestrationV2AppThread,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

/** A lead whose current round is in none of these is still working on it. */
export const ORGANIZATION_EXTENDABLE_STATES: ReadonlySet<string> = new Set([
  "accepted",
  "awaiting_review",
  "blocked",
  "changes_requested",
  "queued",
]);

/**
 * A lead's task for its next round: the finished round is recorded (bounded) as it was, and the
 * new one starts unreviewed with the brief and no implementation tasks of its own yet.
 */
export function organizationExtendedTask(
  task: OrganizationTask,
  input: {
    readonly leadThreadId: ThreadId;
    readonly brief: string;
    readonly now: string;
    readonly pullRequests: ReadonlyArray<number>;
  },
): OrganizationTask {
  const round = (task.rounds?.at(-1)?.round ?? 0) + 1;
  const { lastReview: _lastReview, files: _files, manifest: _manifest, ...kept } = task;
  return {
    ...kept,
    state: "working",
    ownerThreadId: input.leadThreadId,
    revision: null,
    reviewedRevision: null,
    reviewerThreadId: null,
    dependencyThreadIds: [],
    notes: `Round ${round + 1}: ${input.brief.trim()}`.slice(0, 2_000),
    roundStartedAt: input.now,
    rounds: [
      ...(task.rounds ?? []),
      {
        round,
        state: task.state,
        revision: task.revision,
        reviewedRevision: task.reviewedRevision,
        dependencyThreadIds: task.dependencyThreadIds,
        pullRequests: [...input.pullRequests],
        summary: task.notes,
        endedAt: input.now,
      },
    ].slice(-ORGANIZATION_TASK_ROUND_LIMIT),
  };
}

/**
 * New instructions to a blocked lead or executor unblock it at once, so its label never lags the
 * brief it was given: a message from the user (including an answer to its question), or one its
 * own coordinator sent. Server notices, notifications, delegated results, scheduled runs and the
 * agent's own or other agents' messages do not. Returns the unblocked task and who acted, or
 * null when nothing changes.
 */
export function organizationInstructionUnblock(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "organization">;
  readonly message: {
    readonly messageId: string;
    readonly createdBy: string;
    readonly creationSource: string;
    readonly senderThreadId?: ThreadId | undefined;
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly scheduledTaskId?: unknown;
    readonly usageLimitContinuationOfRunId?: unknown;
    readonly restartContinuationOfRunId?: unknown;
  };
  readonly coordinatorLabel: string;
  readonly queued: boolean;
}): { readonly task: OrganizationTask; readonly actorThreadId: ThreadId | undefined } | null {
  const org = input.thread.organization;
  const task = org?.task;
  if (!task || task.state !== "blocked" || (org.role !== "lead" && org.role !== "executor"))
    return null;
  const { message } = input;
  if (
    isOrganizationNoticeMessageId(message.messageId) ||
    message.notification !== undefined ||
    message.delegatedCompletion !== undefined ||
    message.scheduledTaskId !== undefined ||
    // Recovery resumes the same work; it is not a new instruction.
    message.usageLimitContinuationOfRunId !== undefined ||
    message.restartContinuationOfRunId !== undefined
  )
    return null;
  // An answer to the conversation's question unblocks only when the user gave it.
  if (message.messageId.startsWith("async-answer:") && message.createdBy !== "user") return null;
  const fromUser = message.createdBy === "user";
  const fromCoordinator =
    message.createdBy === "agent" &&
    message.creationSource !== "server" &&
    message.senderThreadId !== undefined &&
    message.senderThreadId === org.parentThreadId;
  if (!fromUser && !fromCoordinator) return null;
  return {
    actorThreadId: fromUser ? undefined : org.parentThreadId!,
    task: {
      ...task,
      ownerThreadId: input.thread.id,
      // A correction round resumes as one; otherwise the work runs or waits its turn.
      state:
        task.lastReview !== undefined && task.lastReview.revision === task.revision
          ? "changes_requested"
          : input.queued
            ? "queued"
            : "working",
      notes: `Unblocked by new instructions from ${fromUser ? "the user" : input.coordinatorLabel}.`,
    },
  };
}

/** Shared by every canonical command, including commands originating through MCP. */
export function organizationProblem(input: {
  thread: OrchestrationV2AppThread;
  next: OrganizationThread | null;
  threads: ReadonlyArray<
    Pick<OrchestrationV2AppThread, "id" | "projectId" | "organization" | "deletedAt" | "archivedAt">
  >;
  /** Archived conversations, which the active snapshot omits; adoption resolves its old parent here. */
  archivedThreads?: ReadonlyArray<
    Pick<OrchestrationV2AppThread, "id" | "projectId" | "organization" | "deletedAt" | "archivedAt">
  >;
  actorThreadId?: ThreadId;
  checkpointRefs?: ReadonlyArray<string>;
}): string | null {
  const { thread, next, actorThreadId } = input;
  const previous = thread.organization;
  const threads = new Map(input.threads.map((item) => [item.id, item]));
  threads.set(thread.id, { ...thread, organization: next });
  const archived = new Map((input.archivedThreads ?? []).map((item) => [item.id, item]));
  const related = (id: ThreadId) => {
    const item = threads.get(id);
    return item?.projectId === thread.projectId && item.deletedAt === null ? item : undefined;
  };
  const actor = actorThreadId ? related(actorThreadId) : undefined;
  if (actorThreadId && !actor?.organization)
    return "The acting conversation has no organization role in this project.";
  const parent = next?.parentThreadId ? related(next.parentThreadId) : undefined;
  // A lead may adopt an executor task from a retired parent lead under the same Chief. Only the
  // reporting parent moves: the task must be structurally unchanged, and the retired lead must
  // still resolve so its Chief can be checked.
  const previousParent = previous?.parentThreadId
    ? (threads.get(previous.parentThreadId) ?? archived.get(previous.parentThreadId))
    : undefined;
  const adopting =
    previous?.role === "executor" &&
    next?.role === "executor" &&
    next.parentThreadId !== previous.parentThreadId &&
    next.parentThreadId === actorThreadId &&
    actor?.organization?.role === "lead" &&
    previousParent !== undefined &&
    previousParent.projectId === thread.projectId &&
    previousParent.organization?.role === "lead" &&
    (previousParent.archivedAt !== null || previousParent.deletedAt !== null) &&
    previousParent.organization.parentThreadId === parent?.organization?.parentThreadId &&
    previous.task !== undefined &&
    next.task !== undefined &&
    Equal.equals(previous.task, next.task);
  if (!next)
    return previous
      ? "Organization identity is retained for its recorded work; archive the conversation instead."
      : null;
  if (
    previous &&
    (previous.role !== next.role || (previous.parentThreadId !== next.parentThreadId && !adopting))
  )
    return "A recorded role and its reporting parent cannot be reassigned.";
  if (!previous && actorThreadId)
    return "Only the user can enroll existing conversations; delegate_task creates agent roles.";
  const requiredParent =
    next.role === "lead" ? "chief" : ["executor", "reviewer"].includes(next.role) ? "lead" : null;
  if (requiredParent ? parent?.organization?.role !== requiredParent : next.parentThreadId !== null)
    return "Reporting chain must be Chief → lead → executor or reviewer; Advisor and Chief are root roles.";
  if (
    next.role === "chief" &&
    input.threads.some(
      (item) =>
        item.id !== thread.id &&
        item.projectId === thread.projectId &&
        item.deletedAt === null &&
        item.archivedAt === null &&
        item.organization?.role === "chief",
    )
  )
    return "This project already has a Chief conversation.";
  const task = next.task;
  const old = previous?.task;
  if (!task) return old ? "Recorded tasks cannot be removed." : null;
  if (["advisor", "chief", "reviewer"].includes(next.role))
    return "Tasks belong to lead or executor conversations; reviewer ownership references that original task.";
  if (
    actor &&
    actor.id !== thread.id &&
    actor.id !== next.parentThreadId &&
    actor.id !== old?.ownerThreadId
  )
    return "Only the task's owner or direct coordinator can update this work.";
  if (old && (old.repository ?? ".") !== (task.repository ?? "."))
    return "A task's repository is fixed when it is delegated; delegate a new task for another repository.";
  const lastRound = (value: OrganizationTask | undefined) => value?.rounds?.at(-1)?.round ?? 0;
  // A lead extended by its Chief starts a new round; the finished one is recorded, not undone.
  const extending = !!old && lastRound(task) === lastRound(old) + 1;
  if (extending) {
    if (next.role !== "lead" || !actor || actor.id !== next.parentThreadId)
      return "Only a lead's Chief can extend it with a new round.";
    if (!ORGANIZATION_EXTENDABLE_STATES.has(old.state))
      return "A lead can be extended once its current round is not in progress.";
    if (
      !["queued", "working"].includes(task.state) ||
      task.ownerThreadId !== thread.id ||
      task.revision !== null ||
      task.reviewedRevision !== null ||
      task.reviewerThreadId !== null ||
      task.dependencyThreadIds.length > 0
    )
      return "A new round starts unreviewed, owned by the lead, with no implementation tasks yet.";
  } else if (
    old &&
    (!Equal.equals(old.rounds, task.rounds) || old.roundStartedAt !== task.roundStartedAt)
  )
    return "Earlier rounds are recorded only when the Chief extends a lead.";
  if (
    old &&
    (old.title !== task.title ||
      !Equal.equals(old.dependencyThreadIds, task.dependencyThreadIds)) &&
    next.role !== "lead" &&
    !(
      actor?.id === next.parentThreadId &&
      ["queued", "blocked", "changes_requested"].includes(old.state)
    )
  )
    return "Only the coordinator can change the plan before execution or during correction.";
  if (old?.state === "accepted" && task.state === "accepted" && !Equal.equals(old, task))
    return "Accepted evidence is immutable until its coordinator explicitly reopens it.";
  if (
    task.lastReview &&
    !Equal.equals(task.lastReview, old?.lastReview) &&
    !(
      actor?.organization?.role === "reviewer" &&
      actor.id === old?.ownerThreadId &&
      task.lastReview.reviewerThreadId === actor.id &&
      task.lastReview.revision === old?.revision &&
      task.state === "changes_requested"
    )
  )
    return "Review feedback must come from the assigned reviewer of this revision.";
  const owner = related(task.ownerThreadId);
  if (!owner?.organization)
    return "Task owner must be an organization conversation in this project.";
  if (
    task.ownerThreadId !== thread.id &&
    !adopting &&
    !(task.ownerThreadId === next.parentThreadId && ["queued", "blocked"].includes(task.state)) &&
    !(
      owner.organization.role === "reviewer" &&
      owner.organization.parentThreadId === (next.role === "lead" ? thread.id : next.parentThreadId)
    )
  )
    return "Task ownership may move only to its original worker or an independent reviewer under the same lead.";
  if (new Set(task.dependencyThreadIds).size !== task.dependencyThreadIds.length)
    return "Dependencies must be unique.";
  for (const id of task.dependencyThreadIds) {
    const dependency = related(id);
    if (id === thread.id || !dependency?.organization?.task)
      return "Dependencies must reference other organization tasks in this project.";
    const seen = new Set<ThreadId>();
    const visits = (cursor: ThreadId): boolean => {
      if (cursor === thread.id) return true;
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      return threads.get(cursor)?.organization?.task?.dependencyThreadIds.some(visits) ?? false;
    };
    if (visits(id)) return "Task dependencies cannot form a cycle.";
  }
  const unaccepted = ["working", "awaiting_review", "accepted"].includes(task.state)
    ? task.dependencyThreadIds.find((id) => related(id)?.organization?.task?.state !== "accepted")
    : undefined;
  if (unaccepted)
    return `All dependencies must be accepted before this task can execute or be accepted; ${unaccepted} is ${related(unaccepted)?.organization?.task?.state.replaceAll("_", " ") ?? "missing"}.`;
  if (task.state === "working" && task.ownerThreadId !== thread.id)
    return "Implementation work remains with the original worker, not the reviewer or coordinator.";
  if (task.revision !== old?.revision && task.reviewedRevision !== null)
    return "A new submission invalidates the previous review.";
  if (
    ["awaiting_review", "accepted"].includes(task.state) &&
    !adopting &&
    (!task.revision || !input.checkpointRefs?.includes(task.revision))
  )
    return "Submit and verify actual manifest files before review or acceptance.";
  if (task.reviewedRevision !== null && task.reviewedRevision !== old?.reviewedRevision) {
    if (
      !actor ||
      actor.organization?.role !== "reviewer" ||
      actor.id !== old?.ownerThreadId ||
      actor.id === thread.id ||
      task.reviewerThreadId !== actor.id ||
      task.reviewedRevision !== old?.revision ||
      task.revision !== old?.revision
    )
      return "Only the assigned independent reviewer can attest the exact submitted revision.";
  }
  if (task.state === "accepted" && old?.state !== "accepted") {
    if (next.role === "lead") {
      // The server accepts an outcome after its pull requests merge, or after review when it
      // has none; agents never do. Its reviewed set is the dependencies checked above, so work
      // the lead started after review is separate scope and does not block it.
      if (actorThreadId) return "Final outcome acceptance belongs to the server, not an agent.";
      if (task.dependencyThreadIds.length === 0)
        return "An outcome is accepted only with the implementation tasks it was reviewed with.";
    } else if (!actor || actor.organization?.role !== "reviewer" || actor.id !== old?.ownerThreadId)
      return "Only the assigned independent reviewer accepts an executor submission.";
    if (
      !task.revision ||
      task.reviewedRevision !== task.revision ||
      !task.reviewerThreadId ||
      old?.state !== "awaiting_review"
    )
      return "Acceptance requires independent review of the current submitted revision.";
  }
  if (
    old?.state === "accepted" &&
    task.state !== "accepted" &&
    !extending &&
    !(
      actor?.id === next.parentThreadId &&
      task.state === "changes_requested" &&
      task.reviewedRevision === null &&
      task.reviewerThreadId === null &&
      task.ownerThreadId === thread.id
    )
  )
    return "Only the coordinator can reopen accepted implementation work, clearing its old review.";
  return null;
}

/** The repository a thread's task works in, relative to the project root. Absent means ".". */
export function organizationRepository(thread: Pick<OrchestrationV2AppThread, "organization">) {
  return thread.organization?.task?.repository ?? ".";
}

/** Git working directory of a thread's repository; repository paths are normalized POSIX. */
export function organizationRepositoryRoot(
  workspaceRoot: string,
  thread: Pick<OrchestrationV2AppThread, "organization">,
) {
  const repository = organizationRepository(thread);
  return repository === "."
    ? workspaceRoot
    : `${workspaceRoot.replace(/[\\/]+$/, "")}/${repository}`;
}

/**
 * Only executors write files, so only they get an isolated worktree and branch. Chief, Advisor,
 * leads and reviewers run in the project root, which may be a plain folder of repositories.
 */
export function organizationNeedsWorktree(role: OrganizationRole | undefined) {
  return role === "executor";
}

/** Prefix of the branch OrganizationWorkspace.prepare checks out for each executor task. */
export const ORGANIZATION_EXECUTOR_BRANCH_PREFIX = "t3/organization/";

/**
 * An executor's task branch stays local: the organization reviews and integrates it without a
 * pull request, so pull request discovery and status lookups skip it.
 */
export function isOrganizationExecutorBranch(thread: {
  readonly organization?: OrganizationThread | null | undefined;
  readonly branch: string | null;
}) {
  return (
    thread.organization != null &&
    thread.branch !== null &&
    thread.branch.startsWith(ORGANIZATION_EXECUTOR_BRANCH_PREFIX)
  );
}

/**
 * Delegated children are admitted by the organization's own preparation, which a Retry re-runs.
 * Chief and Advisor are user conversations whose runs use the generic workspace preparation.
 */
export function organizationPreparesRuns(role: OrganizationRole | undefined) {
  return role === "lead" || role === "executor" || role === "reviewer";
}

const PREPARATION_BLOCK_NOTES = "Workspace preparation failed: ";

/**
 * A preparation failure blocks only work that was about to run. A submission awaiting review or
 * an accepted task keeps its state: the failed run is a follow-up, not a change to that work.
 */
export function organizationPreparationBlock(
  task: OrganizationTask,
  message: string,
): OrganizationTask | null {
  return ["queued", "working", "changes_requested"].includes(task.state)
    ? {
        ...task,
        state: "blocked",
        notes: `${PREPARATION_BLOCK_NOTES}${message.slice(0, 1_200)}\nFix the cause, then retry the run or delegate again.`,
      }
    : null;
}

/**
 * Retrying the failed preparation lifts only the block that preparation recorded; any other
 * block stays for the coordinator. A correction round (review feedback on the current
 * revision) resumes as changes_requested, anything else as queued.
 */
export function organizationPreparationUnblock(task: OrganizationTask): OrganizationTask | null {
  if (task.state !== "blocked" || !task.notes?.startsWith(PREPARATION_BLOCK_NOTES)) return null;
  return {
    ...task,
    state:
      task.lastReview !== undefined && task.lastReview.revision === task.revision
        ? "changes_requested"
        : "queued",
    notes: null,
  };
}

/**
 * The task update for a failed worker run. A failed reviewer must not block the submission it
 * was reviewing: it stays awaiting review, owned by that reviewer, so the lead can resume it or
 * delegate a new review. A failed executor or lead blocks its own task as before; accepted
 * evidence is immutable.
 */
export function organizationFailedRunTaskUpdate(input: {
  readonly role: OrganizationRole | undefined;
  readonly task: OrganizationTask;
  readonly failureMessage: string | undefined;
}): OrganizationTask | null {
  if (input.role === "reviewer" || input.task.state === "accepted") return null;
  return {
    ...input.task,
    state: "blocked",
    notes:
      input.failureMessage ??
      "The native worker failed before finishing this task. Inspect its conversation and choose an explicit recovery.",
  };
}

export function delegatedOrganization(
  parent: OrchestrationV2AppThread,
  childId: ThreadId,
  title: string,
  review = false,
  repository?: OrganizationRepositoryPath,
): OrganizationThread | undefined {
  if (!parent.organization) return undefined;
  const role =
    parent.organization.role === "chief"
      ? "lead"
      : parent.organization.role === "lead"
        ? review
          ? "reviewer"
          : "executor"
        : null;
  if (!role) throw new Error("Only Chief and outcome leads may delegate organization work.");
  if (role === "reviewer") return { role, parentThreadId: parent.id };
  return {
    role,
    parentThreadId: parent.id,
    task: {
      title,
      ...(repository === undefined ? {} : { repository }),
      ownerThreadId: childId,
      dependencyThreadIds: [],
      state: "queued",
      revision: null,
      reviewedRevision: null,
      reviewerThreadId: null,
      notes: null,
    },
  };
}

/** Execution authorization is checked again when a deferred provider turn actually starts. */
export function organizationExecutionProblem(
  thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "organization" | "worktreePath">,
  threads: ReadonlyArray<
    Pick<OrchestrationV2AppThread, "id" | "projectId" | "organization" | "deletedAt">
  >,
  requireWorkspace = true,
): string | null {
  const org = thread.organization;
  if (!org) return null;
  if (organizationNeedsWorktree(org.role) && requireWorkspace && !thread.worktreePath)
    return "Organization workers require their prepared worktree before execution.";
  if (org.role === "reviewer") {
    const target = threads.find(
      (item) =>
        item.id === org.reviewTaskThreadId &&
        item.projectId === thread.projectId &&
        item.deletedAt === null,
    );
    if (
      !target?.organization?.task ||
      target.organization.task.state !== "awaiting_review" ||
      target.organization.task.ownerThreadId !== thread.id
    )
      return "This reviewer is not the current owner of an awaiting-review submission.";
  }
  if (org.role !== "executor" || !org.task) return null;
  if (
    org.task.ownerThreadId !== thread.id ||
    !["queued", "working", "changes_requested"].includes(org.task.state)
  )
    return "This executor does not own executable work; its coordinator must explicitly unblock or return the task.";
  if (
    org.task.dependencyThreadIds.some(
      (id) =>
        !threads.some(
          (item) =>
            item.id === id &&
            item.projectId === thread.projectId &&
            item.deletedAt === null &&
            item.organization?.task?.state === "accepted" &&
            item.organization.task.revision === item.organization.task.reviewedRevision,
        ),
    )
  )
    return "Task execution is waiting for independently accepted dependencies.";
  return null;
}

const roleModels = (
  settings: Pick<ServerSettings, "organizationRoleModelSelections">,
  roles: ReadonlyArray<OrganizationRole>,
) =>
  roles
    .map((role) => {
      const model = resolveOrganizationRoleModelSelection(settings, role);
      return model.source === "default"
        ? `${role} ${model.driverKind} ${model.model}`
        : `${role} ${model.selection.instanceId} ${model.selection.model}`;
    })
    .join(", ");

/**
 * Whether a task update is news for the Chief. The Chief hears its direct leads' state changes
 * and newly reviewed outcomes, and any task in the project becoming blocked (or re-blocked with
 * new notes). Notes, manifest, ownership and executor churn reach the parent lead instead.
 */
export function organizationChiefNoticeRelevant(
  previous: OrganizationTask | undefined,
  next: OrganizationTask,
  reportsToChief: boolean,
): boolean {
  if (next.state === "blocked" && (previous?.state !== "blocked" || previous.notes !== next.notes))
    return true;
  if (!reportsToChief) return false;
  return (
    previous?.state !== next.state ||
    (next.reviewedRevision !== null && previous.reviewedRevision !== next.reviewedRevision)
  );
}

/** Chief notice ids; a queued notice is merged into rather than followed by another turn. */
export const ORGANIZATION_CHIEF_NOTICE_PREFIX = "organization:";
/** A pull request that closed without merging and holds an outcome. */
export const ORGANIZATION_PULL_REQUEST_NOTICE_PREFIX = "organization-pr:";
/** An outcome the server could not accept, for a reason the Chief should hear once. */
export const ORGANIZATION_ACCEPTANCE_NOTICE_PREFIX = "organization-acceptance:";
const ORGANIZATION_NOTICE_PREFIXES = [
  ORGANIZATION_CHIEF_NOTICE_PREFIX,
  "organization-parent:",
  ORGANIZATION_PULL_REQUEST_NOTICE_PREFIX,
  ORGANIZATION_ACCEPTANCE_NOTICE_PREFIX,
];

/** Organization notices reach the provider as organization updates, never as user messages. */
export function isOrganizationNoticeMessageId(messageId: string): boolean {
  return ORGANIZATION_NOTICE_PREFIXES.some((prefix) => messageId.startsWith(prefix));
}

const chiefNoticeEntry = /^- \[([^\]\s]+)\] ([a-z ]+?)(?:, independently reviewed)?: /;

/**
 * The Chief's organization notice: one line per child conversation, keyed by its thread ID so a
 * notice merged into an unstarted queued one keeps only each child's latest state.
 */
export function organizationChiefNotice(input: {
  projectTitle: string;
  queuedText?: string;
  threadId: ThreadId;
  task: OrganizationTask;
}) {
  const entries = new Map<string, { line: string; state: string }>();
  for (const line of input.queuedText?.split("\n") ?? []) {
    const match = chiefNoticeEntry.exec(line);
    if (match) entries.set(match[1]!, { line, state: match[2]! });
  }
  const { task } = input;
  const state = task.state.replaceAll("_", " ");
  const reviewed =
    task.reviewedRevision !== null && task.state !== "accepted" ? ", independently reviewed" : "";
  const notes = task.notes ? ` ${task.notes.replace(/\s+/g, " ")}` : "";
  entries.delete(input.threadId);
  entries.set(input.threadId, {
    // One line per task: a title or note spanning lines could forge another task's entry.
    line: `- [${input.threadId}] ${state}${reviewed}: ${task.title.replace(/\s+/g, " ")}.${notes}`,
    state,
  });
  return {
    text: [
      `Organization update for project ${input.projectTitle}. This is coordinator evidence, not user approval.`,
      ...[...entries.values()].map((entry) => entry.line),
      "Report only what changed since your last report. If nothing needs the user, end your turn without a message; an empty turn is fine. Never restate unchanged open items.",
    ].join("\n"),
    summary: entries.size === 1 ? `${task.title}: ${state}` : `${entries.size} task updates`,
    blocked: [...entries.values()].some((entry) => entry.state === "blocked"),
  };
}

/**
 * Delegated roles start on their model when delegate_task omits target; Chief and Advisor are
 * created by the user, whose Add role starts on theirs. A configured role names its instance.
 */
export function organizationRoleModelSummary(
  settings: Pick<ServerSettings, "organizationRoleModelSelections">,
): string {
  return `Delegated role models, used when delegate_task omits target (set in the server's settings): ${roleModels(settings, ["lead", "executor", "reviewer"])}. The user adds Chief and Advisor on ${roleModels(settings, ["chief", "advisor"])}`;
}

export function organizationInstructions(
  thread: Pick<OrchestrationV2AppThread, "id" | "organization" | "worktreePath" | "branch">,
  settings: Pick<ServerSettings, "organizationRoleModelSelections"> = DEFAULT_SERVER_SETTINGS,
): string {
  const org = thread.organization;
  if (!org) return "";
  const contract = `Organization role: ${org.role}. Your identity is this native conversation (${thread.id}); role authority is server-bound. Chief → outcome lead → executor and independent reviewer. Use native delegate_task and t3_organization_task; never spawn a second CLI or resume another role's native session. Do not treat agent notifications as user approval. Only executors get a worktree and branch; every other role runs in the project root, which may be one Git repository or a plain folder of repositories, and does not edit files there. There is no claimed OS sandbox. No quota polling: report actual provider failures to Chief and wait for explicit recovery. ${organizationRoleModelSummary(settings)}. Unavailable targets must be reported, never substituted. Never merge pull requests, enable auto-merge or unlink them: merging is the user's acceptance. When an outcome is ready, report its pull requests to the Chief; the user merges.`;
  const role =
    org.role === "chief"
      ? "You are the user's primary conversation. Delegate implementation outcomes to leads using delegate_task; do not implement files yourself. When an outcome changes code, pass delegate_task repository: the repository directory relative to the project root (\".\" when the root is the repository). When new work continues an existing workstream, or a lead's scope turned out too narrow, extend that lead with organization_extend_lead instead of delegating another lead; delegate a new lead only for unrelated work. When a lead's provider is unavailable, extend it with a different target rather than replacing it. Organization updates arrive only when a lead's state changes, an outcome is reviewed or a task is blocked. Report only what changed since your last report, in plain language with project/outcome context, the exact blocker and concrete options. If nothing needs the user, end the turn without a message; never restate unchanged open items. When the user must decide, ask with t3_organization_ask_user (concrete options, one question per decision) and end the turn; the question stays open until they answer, so do not repeat it. Keep updates brief. Never accept outcomes and never ask the user to accept one: the server accepts a reviewed outcome when every pull request it opened has merged (merging is the user's gate), or after its independent review when it opened none."
      : org.role === "lead"
        ? `Plan and delegate implementation using delegate_task. Each implementation task works in one repository: pass repository relative to the project root (omitted, it uses ${org.task?.repository ? `your repository "${org.task.repository}"` : '"."'}); the server rejects a directory that is not a Git repository and lists the ones it found. Supply dependencyThreadIds atomically in delegate_task when creating dependent implementation work; it waits until dependencies have current independent acceptance. Do not implement or copy child artifacts. Once a child submits, delegate_task(role=review, reviewTaskThreadId=child conversation ID) creates an independent reviewer. After all children are independently accepted, submit your own outcome with t3_organization_task(action=submit); the server aggregates their current manifests. Delegate an independent outcome review targeting your own conversation. Never accept an outcome yourself and do not ask for acceptance: after the independent outcome review the server accepts it once every pull request your outcome opened has merged, or on that review alone when it opened none. Work you start after the review is separate scope with its own review. Your Chief may extend you with a new round and brief: plan and delegate new executors for it; earlier rounds' accepted work stays as it is. If a parent lead was archived or deleted under the same Chief, adopt its executor task with t3_organization_task(action=adopt) so you can review it and add it to your plan; its submission and review evidence stay as they are.`
        : org.role === "executor"
          ? `Implement only your delegated task in your worktree${thread.worktreePath ? ` ${thread.worktreePath}` : ""}${thread.branch ? ` on branch ${thread.branch}` : ""}, created from repository "${organizationRepository(thread)}" under the project root. Manifest paths are relative to that worktree. Read/claim your task using t3_organization_task, then submit with action=submit and manifest of relative files. A prose completion is not a submission. If blocked, action=block with exact reason. Do not self-review or delegate.`
          : org.role === "reviewer"
            ? `Review the actual submitted files of task ${org.reviewTaskThreadId ?? "assigned by your lead"}; t3_organization_task(action=read) with omitted threadId returns the assigned task ID, manifest, revision and artifactSources with each source's repository, branch and workspace. You have no worktree of your own: inspect the files in place at artifactSources[].workspace. Your own conversation ID also resolves to that assigned task; never substitute another target. Do not implement fixes. Pass the inspected task.revision as revision when calling accept_review or request_changes; the server rejects missing or stale revisions. Use accept_review only for the exact independently inspected submission, or request_changes with actionable findings. Your native session must differ from the submitter's.`
            : "Advise on goals and portfolio decisions. Do not implement, delegate implementation, or claim user acceptance.";
  return `${contract}\n${role}\nTask protocol: ownerThreadId is current ownership. On t3_organization_task read, reviewAssignment is the server-validated assigned reviewer; reviewerThreadId/reviewedRevision are completed attestations and are normally null before review acceptance. Do not declare assignment broken because those attestation fields are null. Resume a validated existing reviewer on its unchanged assigned revision after a tooling failure using t3_thread_send; a new review round uses delegate_task. Review artifactSources in their actual source worktrees, especially lead outcomes, whose aggregate paths are prefixed with child task IDs and are not files in the project root.`;
}
