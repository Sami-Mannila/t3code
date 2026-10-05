import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  OrganizationRole,
  OrganizationTask,
  OrganizationThread,
} from "@t3tools/contracts";

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  advisor: "Advisor",
  chief: "Chief of staff",
  lead: "Project lead",
  executor: "Executor",
  reviewer: "Reviewer",
};

type Shell = EnvironmentThreadShell;

/** Where a review of the current submission stands; null when nothing is under review. */
export type OrganizationReviewState =
  | "awaiting_reviewer"
  | "inspecting"
  | "accepted"
  | "changes_requested";

export interface OrganizationReview {
  readonly state: OrganizationReviewState;
  /** The reviewer conversation, when it is in view. */
  readonly reviewer: Shell | undefined;
  readonly revision: string | null;
  readonly notes: string | null;
}

/**
 * An earlier review round: a reviewer conversation that targeted this task before the current
 * one. Only the most recent "changes requested" verdict is recorded on the task, so older rounds
 * show their reviewer without a verdict.
 */
export interface OrganizationReviewRound {
  readonly round: number;
  readonly reviewer: Shell;
  readonly verdict: "changes_requested" | null;
  readonly notes: string | null;
}

export interface OrganizationSubtask {
  readonly thread: Shell;
  readonly task: OrganizationTask;
  /** 1-based position in dependency order among its siblings. */
  readonly number: number;
  readonly repository: string;
  readonly branch: string | null;
  /** "needs n" for a sibling, otherwise the prerequisite's title or that it is out of view. */
  readonly needs: ReadonlyArray<{ readonly threadId: string; readonly label: string }>;
  readonly review: OrganizationReview | null;
  readonly earlierRounds: ReadonlyArray<OrganizationReviewRound>;
  readonly inCycle: boolean;
}

export interface OrganizationLeadCard {
  readonly lead: Shell;
  readonly outcome: OrganizationTask | undefined;
  readonly outcomeReview: OrganizationReview | null;
  readonly outcomeEarlierRounds: ReadonlyArray<OrganizationReviewRound>;
  readonly subtasks: ReadonlyArray<OrganizationSubtask>;
  readonly canAccept: boolean;
}

export interface OrganizationModel {
  /** Chief and Advisor conversations. */
  readonly roots: ReadonlyArray<Shell>;
  readonly leads: ReadonlyArray<OrganizationLeadCard>;
  /** Executor tasks whose lead is not in view. */
  readonly unassigned: ReadonlyArray<OrganizationSubtask>;
  readonly warnings: ReadonlyArray<string>;
  readonly empty: boolean;
}

const createdOrder = (a: Shell, b: Shell) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** "running", "idle", …: the conversation's live activity. */
export const threadActivity = (thread: Shell) => thread.runtime?.status ?? "idle";
export const threadIsActive = (thread: Shell) => thread.runtime?.activeRunId != null;
export const threadModelLabel = (thread: Shell) =>
  `${thread.modelSelection.instanceId} · ${thread.modelSelection.model}`;

/**
 * The organization of one project as cards: Chief and Advisor, then one card per project lead
 * with its outcome and its executors' tasks as an ordered checklist. Reviewers appear as review
 * lines under the task they review. Scoped before indexing, so a thread ID from another
 * environment never acquires a place here.
 */
export function organizationModel(
  all: readonly Shell[],
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workstream = "",
): OrganizationModel {
  const threads = all.filter(
    (t) =>
      t.environmentId === environmentId &&
      t.projectId === projectId &&
      !t.deletedAt &&
      !t.archivedAt &&
      t.source.organization,
  );
  const byId = new Map<string, Shell>(threads.map((t) => [t.id, t]));
  const role = (t: Shell | undefined) => t?.source.organization?.role;
  const reviewersByTarget = new Map<string, Shell[]>();
  for (const t of threads) {
    const target = t.source.organization!.reviewTaskThreadId;
    if (role(t) !== "reviewer" || !target) continue;
    const list = reviewersByTarget.get(target) ?? [];
    list.push(t);
    reviewersByTarget.set(target, list);
  }
  for (const list of reviewersByTarget.values()) list.sort(createdOrder);
  const warnings = new Set<string>();

  const reviewOf = (
    target: Shell,
  ): { review: OrganizationReview | null; earlier: OrganizationReviewRound[] } => {
    const task = target.source.organization?.task;
    if (!task) return { review: null, earlier: [] };
    const attested =
      task.reviewerThreadId !== null &&
      task.reviewedRevision !== null &&
      task.reviewedRevision === task.revision;
    let review: OrganizationReview | null = null;
    let reviewerId: string | null = null;
    if ((task.state === "awaiting_review" || task.state === "accepted") && attested) {
      reviewerId = task.reviewerThreadId;
      review = {
        state: "accepted",
        reviewer: byId.get(reviewerId!),
        revision: task.reviewedRevision,
        notes: null,
      };
    } else if (task.state === "awaiting_review") {
      const owner = byId.get(task.ownerThreadId);
      reviewerId = role(owner) === "reviewer" ? owner!.id : null;
      review = {
        state: reviewerId ? "inspecting" : "awaiting_reviewer",
        reviewer: reviewerId ? owner : undefined,
        revision: task.revision,
        notes: null,
      };
    } else if (
      task.state === "changes_requested" &&
      task.lastReview &&
      task.lastReview.revision === task.revision
    ) {
      reviewerId = task.lastReview.reviewerThreadId;
      review = {
        state: "changes_requested",
        reviewer: byId.get(reviewerId),
        revision: task.lastReview.revision,
        notes: task.lastReview.notes ?? null,
      };
    }
    const rounds = reviewersByTarget.get(target.id) ?? [];
    const earlier = rounds
      .map((reviewer, index) => ({ reviewer, round: index + 1 }))
      .filter(({ reviewer }) => reviewer.id !== reviewerId)
      .map(({ reviewer, round }) => {
        const rejected = task.lastReview?.reviewerThreadId === reviewer.id;
        return {
          round,
          reviewer,
          verdict: rejected ? ("changes_requested" as const) : null,
          notes: rejected ? (task.lastReview!.notes ?? null) : null,
        };
      });
    return { review, earlier };
  };

  /** Dependency order among siblings; members of a cycle keep creation order at the end. */
  const checklist = (executors: Shell[]): OrganizationSubtask[] => {
    const siblings = new Set(executors.map((t) => t.id as string));
    const pending = new Map(
      executors.map((t) => [
        t.id as string,
        new Set(
          t.source.organization!.task!.dependencyThreadIds.filter(
            (id) => siblings.has(id) && id !== t.id,
          ),
        ),
      ]),
    );
    const ordered: Shell[] = [];
    const remaining = [...executors].sort(createdOrder);
    while (remaining.length) {
      const index = remaining.findIndex((t) => pending.get(t.id)!.size === 0);
      if (index === -1) break;
      const [next] = remaining.splice(index, 1);
      ordered.push(next!);
      for (const deps of pending.values()) deps.delete(next!.id);
    }
    const cyclic = new Set(remaining.map((t) => t.id as string));
    if (cyclic.size) warnings.add("Dependency cycle: inspect the linked conversations.");
    ordered.push(...remaining);
    const numbers = new Map(ordered.map((t, index) => [t.id as string, index + 1]));
    return ordered.map((thread, index) => {
      const task = thread.source.organization!.task!;
      const { review, earlier } = reviewOf(thread);
      return {
        thread,
        task,
        number: index + 1,
        repository: task.repository ?? ".",
        branch: thread.branch,
        needs: [...new Set(task.dependencyThreadIds)].map((id) => ({
          threadId: id,
          label: numbers.has(id)
            ? String(numbers.get(id))
            : (byId.get(id)?.source.organization?.task?.title ??
              byId.get(id)?.title ??
              "a task outside this view"),
        })),
        review,
        earlierRounds: earlier,
        inCycle: cyclic.has(thread.id),
      };
    });
  };

  const executorsByLead = new Map<string, Shell[]>();
  const orphans: Shell[] = [];
  for (const t of threads) {
    if (role(t) !== "executor" || !t.source.organization!.task) continue;
    const parent = byId.get(t.source.organization!.parentThreadId ?? "");
    if (role(parent) !== "lead") {
      orphans.push(t);
      continue;
    }
    const list = executorsByLead.get(parent!.id) ?? [];
    list.push(t);
    executorsByLead.set(parent!.id, list);
  }
  const leads = threads
    .filter((t) => role(t) === "lead" && (!workstream || t.id === workstream))
    .sort(createdOrder)
    .map((lead) => {
      const { review, earlier } = reviewOf(lead);
      return {
        lead,
        outcome: lead.source.organization!.task,
        outcomeReview: review,
        outcomeEarlierRounds: earlier,
        subtasks: checklist(executorsByLead.get(lead.id) ?? []),
        canAccept: canAcceptOrganizationOutcome(lead),
      };
    });
  const roots = threads
    .filter((t) => role(t) === "chief" || role(t) === "advisor")
    .sort((a, b) => (role(a) === role(b) ? createdOrder(a, b) : role(a) === "chief" ? -1 : 1));
  const unassigned = workstream ? [] : checklist(orphans);
  return {
    roots,
    leads,
    unassigned,
    warnings: [...warnings],
    empty: roots.length === 0 && leads.length === 0 && unassigned.length === 0,
  };
}

/** Presentation eligibility only; the authenticated server revalidates the current artifact manifest. */
export function canAcceptOrganizationOutcome(thread: EnvironmentThreadShell): boolean {
  const organization = thread.source.organization;
  const task = organization?.task;
  return (
    organization?.role === "lead" &&
    task?.state === "awaiting_review" &&
    !!task.revision &&
    task.revision === task.reviewedRevision &&
    !!task.reviewerThreadId &&
    task.reviewerThreadId !== thread.id &&
    !!task.files?.length
  );
}

type OutcomeFile = NonNullable<NonNullable<OrganizationThread["task"]>["files"]>[number];

/**
 * Splits a lead outcome's aggregate files (`<child thread ID>/<path>`) by the executor that
 * produced them, so each group shows the repository and branch the user merges.
 */
export function outcomeFileGroups(
  files: readonly OutcomeFile[],
  threads: readonly EnvironmentThreadShell[],
) {
  const groups = new Map<
    string,
    { child: EnvironmentThreadShell | undefined; files: Array<OutcomeFile> }
  >();
  if (files.length === 0) return [];
  const byId = new Map<string, EnvironmentThreadShell>(threads.map((t) => [t.id, t]));
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const child = slash > 0 ? byId.get(file.path.slice(0, slash)) : undefined;
    const key = child ? child.id : "";
    const group = groups.get(key) ?? { child, files: [] };
    group.files.push(child ? { ...file, path: file.path.slice(slash + 1) } : file);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ child, files }) => ({
    child,
    repository: child?.source.organization?.task?.repository ?? ".",
    branch: child?.branch ?? null,
    worktreePath: child?.worktreePath ?? null,
    files,
  }));
}
