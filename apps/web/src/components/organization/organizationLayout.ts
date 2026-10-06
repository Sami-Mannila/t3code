import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  OrganizationRole,
  OrganizationTask,
  PullRequestState,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  organizationOutcomeGate,
  type OrganizationOutcomeGate,
  type OutcomeThread,
} from "@t3tools/shared/organizationOutcome";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

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

/** One pull request as a card draws it: state and title are already resolved from its snapshot. */
export interface OrganizationPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
}

/** A lead's finished round, its pull requests resolved for display. */
export interface OrganizationRound {
  readonly round: number;
  readonly state: string;
  readonly pullRequests: ReadonlyArray<OrganizationPullRequest>;
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
  /**
   * The executor's visible pull request links, with earlier-round merged ones collapsed into the
   * card's merged history instead.
   */
  readonly pullRequests: ReadonlyArray<OrganizationPullRequest>;
}

export interface OrganizationLeadCard {
  readonly lead: Shell;
  readonly outcome: OrganizationTask | undefined;
  readonly outcomeReview: OrganizationReview | null;
  readonly outcomeEarlierRounds: ReadonlyArray<OrganizationReviewRound>;
  readonly subtasks: ReadonlyArray<OrganizationSubtask>;
  /** What a reviewed outcome still waits on before the server accepts it; null otherwise. */
  readonly outcomeWait: string | null;
  /** The lead's own visible pull requests, minus earlier-round merged ones. */
  readonly pullRequests: ReadonlyArray<OrganizationPullRequest>;
  /** Merged pull requests from finished rounds, shown as one collapsed chip. */
  readonly mergedHistory: ReadonlyArray<OrganizationPullRequest>;
  /** The outcome's finished rounds with their pull requests resolved for the history list. */
  readonly rounds: ReadonlyArray<OrganizationRound>;
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

/** "running", "idle", "awaiting input", …: the conversation's live activity. */
export const threadActivity = (thread: Shell) =>
  thread.hasPendingUserInput ? "awaiting input" : (thread.runtime?.status ?? "idle");
export const threadIsActive = (thread: Shell) => thread.runtime?.activeRunId != null;
export const threadModelLabel = (thread: Shell) =>
  `${thread.modelSelection.instanceId} · ${thread.modelSelection.model}`;

const outcomeThread = (thread: Shell): OutcomeThread => ({
  id: thread.id,
  title: thread.title,
  organization: thread.source.organization,
  pullRequests: thread.source.pullRequests,
  linkedPullRequest: thread.source.linkedPullRequest,
  createdAtMs: Date.parse(thread.createdAt),
});

const pullRequestNumbers = (pullRequests: ReadonlyArray<{ readonly number: number }>) =>
  pullRequests.map((pullRequest) => `#${pullRequest.number}`).join(", ");

/** A thread's live pull request links, tombstones dropped, ready to map for display. */
const visiblePullRequestLinks = (thread: Shell): ReadonlyArray<ThreadPullRequestLink> =>
  visibleThreadPullRequests(thread.pullRequests ?? thread.source.pullRequests ?? []);

const toPullRequest = (link: ThreadPullRequestLink): OrganizationPullRequest => ({
  number: link.number,
  url: link.url,
  title: link.snapshot?.title ?? "",
  state: link.snapshot?.state ?? "open",
  isDraft: link.snapshot?.isDraft ?? false,
});

const byPullRequestNumber = (left: OrganizationPullRequest, right: OrganizationPullRequest) =>
  left.number - right.number;

/**
 * A lead's finished rounds own pull requests that are already merged; showing them as individual
 * chips would bury the current round. They collapse into one merged count, so this returns the
 * merged history plus the link keys the rows must hide.
 *
 * A round only owns what its own participants linked: the lead and the round's
 * `dependencyThreadIds`. Resolving a round's recorded number against every executor would let a
 * multi-repo project collapse another repository's same-numbered pull request.
 */
function collapseMergedHistory(
  lead: Shell,
  byId: ReadonlyMap<string, Shell>,
  task: OrganizationTask | undefined,
): {
  readonly mergedHistory: ReadonlyArray<OrganizationPullRequest>;
  readonly collapsed: ReadonlySet<string>;
  readonly rounds: ReadonlyArray<OrganizationRound>;
} {
  const mergedHistory: OrganizationPullRequest[] = [];
  const collapsed = new Set<string>();
  const rounds: OrganizationRound[] = [];
  for (const round of task?.rounds ?? []) {
    const owners = [lead, ...round.dependencyThreadIds.map((id) => byId.get(id))].filter(
      (thread): thread is Shell => thread !== undefined,
    );
    const ownerLinks = new Map<string, ThreadPullRequestLink>();
    for (const thread of owners) {
      for (const link of visiblePullRequestLinks(thread)) {
        const key = threadPullRequestKeyOf(link);
        if (!ownerLinks.has(key)) ownerLinks.set(key, link);
      }
    }
    const roundPullRequests: OrganizationPullRequest[] = [];
    for (const number of round.pullRequests) {
      for (const link of ownerLinks.values()) {
        if (link.number !== number) continue;
        roundPullRequests.push(toPullRequest(link));
        if (link.snapshot?.state !== "merged") continue;
        const key = threadPullRequestKeyOf(link);
        if (collapsed.has(key)) continue;
        collapsed.add(key);
        mergedHistory.push(toPullRequest(link));
      }
    }
    rounds.push({ round: round.round, state: round.state, pullRequests: roundPullRequests });
  }
  mergedHistory.sort(byPullRequestNumber);
  return { mergedHistory, collapsed, rounds };
}

/** The server accepts outcomes; the card says what a reviewed one is waiting for. */
export function outcomeWaitLabel(gate: OrganizationOutcomeGate): string | null {
  switch (gate.kind) {
    case "waiting_for_task":
      return `reviewed · waiting for ${gate.title}`;
    case "waiting_for_pull_requests":
      return `reviewed · waiting for PR ${pullRequestNumbers(gate.pullRequests)} to merge`;
    case "closed_pull_request":
      return `PR #${gate.pullRequest.number} closed without merging`;
    case "ready":
      return "reviewed · accepting";
    default:
      return null;
  }
}

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
  const checklist = (
    executors: Shell[],
    collapsed: ReadonlySet<string> = new Set(),
  ): OrganizationSubtask[] => {
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
        pullRequests: visiblePullRequestLinks(thread)
          .filter((link) => !collapsed.has(threadPullRequestKeyOf(link)))
          .map(toPullRequest),
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
  const outcomeThreads = threads.map(outcomeThread);
  const leads = threads
    .filter((t) => role(t) === "lead" && (!workstream || t.id === workstream))
    .sort(createdOrder)
    .map((lead) => {
      const { review, earlier } = reviewOf(lead);
      const outcome = lead.source.organization!.task;
      const executorThreads = executorsByLead.get(lead.id) ?? [];
      const { mergedHistory, collapsed, rounds } = collapseMergedHistory(lead, byId, outcome);
      // A lead that inherited an executor's link should not draw it twice; the row owns it.
      const executorKeys = new Set(
        executorThreads.flatMap((thread) =>
          visiblePullRequestLinks(thread).map(threadPullRequestKeyOf),
        ),
      );
      return {
        lead,
        outcome,
        outcomeReview: review,
        outcomeEarlierRounds: earlier,
        subtasks: checklist(executorThreads, collapsed),
        outcomeWait: outcomeWaitLabel(organizationOutcomeGate(outcomeThread(lead), outcomeThreads)),
        pullRequests: visiblePullRequestLinks(lead)
          .filter(
            (link) =>
              !collapsed.has(threadPullRequestKeyOf(link)) &&
              !executorKeys.has(threadPullRequestKeyOf(link)),
          )
          .map(toPullRequest),
        mergedHistory,
        rounds,
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
