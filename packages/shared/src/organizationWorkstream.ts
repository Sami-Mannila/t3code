import type { OrganizationThread, ThreadId } from "@t3tools/contracts";

/** The thread fields a workstream needs; shells and app threads both carry them. */
export interface WorkstreamThread {
  readonly id: ThreadId;
  readonly organization?: OrganizationThread | null | undefined;
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
}

/**
 * A lead and every thread whose reporting chain (`organization.parentThreadId`)
 * leads to it, deepest first, so archiving in order never leaves a child under
 * an archived parent. Deleted threads are left out.
 */
export function workstreamThreads<T extends WorkstreamThread>(
  leadThreadId: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const live = threads.filter((thread) => thread.deletedAt == null);
  const lead = live.find((thread) => thread.id === leadThreadId);
  if (lead === undefined) return [];
  const levels: Array<ReadonlyArray<T>> = [[lead]];
  const seen = new Set<ThreadId>([lead.id]);
  for (;;) {
    const parents = new Set(levels.at(-1)!.map((thread) => thread.id));
    const children = live
      .filter(
        (thread) =>
          !seen.has(thread.id) &&
          thread.organization?.parentThreadId != null &&
          parents.has(thread.organization.parentThreadId),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    if (children.length === 0) break;
    for (const child of children) seen.add(child.id);
    levels.push(children);
  }
  const ordered: Array<T> = [];
  for (let level = levels.length - 1; level >= 0; level--) ordered.push(...levels[level]!);
  return ordered;
}

/** A lead whose outcome the user accepted can be archived with its workstream. */
export function canArchiveWorkstream(thread: WorkstreamThread): boolean {
  return (
    thread.organization?.role === "lead" &&
    thread.organization.task?.state === "accepted" &&
    thread.archivedAt == null &&
    thread.deletedAt == null
  );
}

/** An archived lead can be restored with its workstream. */
export function canUnarchiveWorkstream(thread: WorkstreamThread): boolean {
  return (
    thread.organization?.role === "lead" && thread.archivedAt != null && thread.deletedAt == null
  );
}
