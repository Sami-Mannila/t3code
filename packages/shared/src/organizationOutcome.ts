import type { OrganizationThread, ThreadId, ThreadPullRequestLink } from "@t3tools/contracts";

import { threadPullRequestKeyOf, visibleThreadPullRequests } from "./threadPullRequests.ts";

/** The thread fields an outcome's acceptance reads; server and client shells both map to it. */
export interface OutcomeThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly organization?: OrganizationThread | null | undefined;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  /** When the thread was created. A link older than its thread was inherited, not opened by it. */
  readonly createdAtMs: number;
}

export interface OutcomePullRequest {
  readonly key: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged" | "unknown";
}

/** What a lead's outcome waits on before the server accepts it. */
export type OrganizationOutcomeGate =
  | { readonly kind: "accepted" }
  /** Not submitted, or its submission has no independent review yet. */
  | { readonly kind: "in_progress" }
  | {
      readonly kind: "waiting_for_task";
      readonly threadId: ThreadId;
      readonly title: string;
      readonly state: string;
    }
  | { readonly kind: "waiting_for_pull_requests"; readonly pullRequests: OutcomePullRequest[] }
  | { readonly kind: "closed_pull_request"; readonly pullRequest: OutcomePullRequest }
  | {
      readonly kind: "ready";
      readonly reason: "merged" | "reviewed";
      readonly pullRequests: OutcomePullRequest[];
    };

/**
 * Pull requests the outcome owns: links on the lead and on the implementation tasks its reviewed
 * revision was built from, opened after each thread was created. Children used to copy their
 * parent's links, so an older link says nothing about this work.
 */
export function ownedOutcomePullRequests(
  lead: OutcomeThread,
  threads: ReadonlyArray<OutcomeThread>,
): OutcomePullRequest[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const owners = [
    lead,
    ...(lead.organization?.task?.dependencyThreadIds ?? []).flatMap((id) => {
      const thread = byId.get(id);
      return thread ? [thread] : [];
    }),
  ];
  const pullRequests = new Map<string, OutcomePullRequest>();
  for (const owner of owners)
    for (const link of visibleThreadPullRequests(owner.pullRequests ?? [])) {
      if (Date.parse(link.linkedAt) < owner.createdAtMs) continue;
      const key = threadPullRequestKeyOf(link);
      if (!pullRequests.has(key))
        pullRequests.set(key, {
          key,
          number: link.number,
          state: link.snapshot?.state ?? "unknown",
        });
    }
  // `sort` on a copy, not `toSorted`: shared code also runs on Hermes.
  return [...pullRequests.values()].sort((a, b) => a.number - b.number);
}

/**
 * A lead's outcome is accepted by the server, never by an agent or a user checkbox: once its
 * reviewed revision's implementation tasks are all accepted and an independent reviewer attested
 * that revision, it waits for every pull request it owns to merge. Work with no pull request is
 * accepted on the review alone; a pull request closed without merging holds it.
 */
export function organizationOutcomeGate(
  lead: OutcomeThread,
  threads: ReadonlyArray<OutcomeThread>,
): OrganizationOutcomeGate {
  const task = lead.organization?.task;
  if (lead.organization?.role !== "lead" || !task) return { kind: "in_progress" };
  if (task.state === "accepted") return { kind: "accepted" };
  if (
    task.state !== "awaiting_review" ||
    !task.revision ||
    task.reviewedRevision !== task.revision ||
    !task.reviewerThreadId
  )
    return { kind: "in_progress" };
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  for (const id of task.dependencyThreadIds) {
    const child = byId.get(id);
    const childTask = child?.organization?.task;
    if (
      childTask?.state !== "accepted" ||
      !childTask.revision ||
      childTask.reviewedRevision !== childTask.revision
    )
      return {
        kind: "waiting_for_task",
        threadId: id,
        title: childTask?.title ?? child?.title ?? id,
        state: childTask?.state ?? "missing",
      };
  }
  const pullRequests = ownedOutcomePullRequests(lead, threads);
  const closed = pullRequests.find((pullRequest) => pullRequest.state === "closed");
  if (closed) return { kind: "closed_pull_request", pullRequest: closed };
  const unmerged = pullRequests.filter((pullRequest) => pullRequest.state !== "merged");
  if (unmerged.length > 0) return { kind: "waiting_for_pull_requests", pullRequests: unmerged };
  return {
    kind: "ready",
    reason: pullRequests.length > 0 ? "merged" : "reviewed",
    pullRequests,
  };
}

/** The note the server records on an outcome it accepts; the Chief reads it in its update. */
export function organizationAcceptanceNote(
  gate: Extract<OrganizationOutcomeGate, { kind: "ready" }>,
): string {
  return gate.reason === "merged"
    ? `Accepted after merge of ${gate.pullRequests.map((pullRequest) => `#${pullRequest.number}`).join(", ")}.`
    : "Accepted after independent review; no pull request was opened.";
}
