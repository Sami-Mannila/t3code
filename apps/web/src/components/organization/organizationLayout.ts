import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId, OrganizationRole } from "@t3tools/contracts";

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  advisor: "Advisor",
  chief: "Chief of staff",
  lead: "Project lead",
  executor: "Executor",
  reviewer: "Reviewer",
};
export type OrganizationNode = {
  id: string;
  kind: "role" | "task" | "boundary";
  x: number;
  y: number;
  width: number;
  height: number;
  thread?: EnvironmentThreadShell;
  label: string;
  owner?: EnvironmentThreadShell | undefined;
};
export type OrganizationEdge = {
  from: string;
  to: string;
  kind: "command" | "dependency" | "review";
};
/** Scope before indexing: thread IDs from another environment can never acquire local authority. */
export function organizationLayout(
  all: readonly EnvironmentThreadShell[],
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workstream = "",
) {
  const projectThreads = all.filter(
    (t) =>
      t.environmentId === environmentId &&
      t.projectId === projectId &&
      !t.deletedAt &&
      !t.archivedAt &&
      t.source.organization,
  );
  const projectById = new Map<string, EnvironmentThreadShell>(projectThreads.map((t) => [t.id, t]));
  const threads = workstream
    ? projectThreads.filter((t) => {
        if (["chief", "advisor"].includes(t.source.organization!.role)) return true;
        let cursor: EnvironmentThreadShell | undefined = t;
        const visited = new Set<string>();
        while (cursor && !visited.has(cursor.id)) {
          if (cursor.id === workstream) return true;
          visited.add(cursor.id);
          cursor = projectById.get(cursor.source.organization!.parentThreadId ?? "");
        }
        return false;
      })
    : projectThreads;
  const byId = new Map<string, EnvironmentThreadShell>(threads.map((t) => [t.id, t]));
  const tasks = threads.filter((t) => t.source.organization?.task);
  const needed = new Set(
    tasks.flatMap((t) => [
      t.source.organization!.task!.ownerThreadId,
      ...(byId.get(t.source.organization!.task!.ownerThreadId)?.source.organization?.role ===
      "reviewer"
        ? [t.id]
        : []),
      ...(t.source.organization!.task!.state === "changes_requested" &&
      t.source.organization!.task!.lastReview?.revision === t.source.organization!.task!.revision
        ? [t.source.organization!.task!.lastReview!.reviewerThreadId]
        : []),
      ...(["awaiting_review", "changes_requested"].includes(t.source.organization!.task!.state) &&
      t.source.organization!.task!.reviewerThreadId
        ? [t.source.organization!.task!.reviewerThreadId!]
        : []),
    ]),
  );
  const roles = threads.filter(
    (t) =>
      ["advisor", "chief", "lead"].includes(t.source.organization!.role) ||
      needed.has(t.id) ||
      t.runtime?.activeRunId != null,
  );
  const nodes: OrganizationNode[] = [];
  const edges: OrganizationEdge[] = [];
  const warnings: string[] = [];
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) {
      warnings.push("Dependency cycle: inspect the linked conversations.");
      return 0;
    }
    visiting.add(id);
    const t = tasks.find((t) => t.id === id);
    const deps = t?.source.organization?.task?.dependencyThreadIds ?? [];
    const value = deps.length ? 1 + Math.max(...deps.map((d) => (byId.has(d) ? depth(d) : 0))) : 0;
    visiting.delete(id);
    rank.set(id, value);
    return value;
  }
  tasks.forEach((t) => depth(t.id));
  const leadOwned = tasks.filter((t) =>
    ["chief", "lead", "advisor"].includes(
      byId.get(t.source.organization!.task!.ownerThreadId)?.source.organization?.role ?? "",
    ),
  );
  const maxRank = Math.max(0, ...leadOwned.map((t) => rank.get(t.id) ?? 0));
  const leadX = (maxRank + 1) * 280 + 80;
  let top = 50;
  for (const role of roles.filter((t) =>
    ["chief", "advisor"].includes(t.source.organization!.role),
  )) {
    nodes.push({
      id: `role:${role.id}`,
      kind: "role",
      x: leadX,
      y: top,
      width: 220,
      height: 116,
      thread: role,
      label: ROLE_LABELS[role.source.organization!.role],
    });
    top += 145;
  }
  const leads = roles.filter((t) => t.source.organization!.role === "lead");
  const groupFor = (t: EnvironmentThreadShell): string => {
    let cursor: EnvironmentThreadShell | undefined = t;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.source.organization?.role === "lead") return cursor.id;
      cursor = byId.get(cursor.source.organization?.parentThreadId ?? "");
    }
    return "unassigned";
  };
  const groups = [...leads.map((t) => t.id as string), "unassigned"];
  for (const group of groups) {
    const groupTasks = tasks.filter((t) => groupFor(t) === group);
    const lead = byId.get(group);
    if (!lead && !groupTasks.length) continue;
    const y = top;
    let backlog = 0;
    let row = 0;
    if (lead)
      nodes.push({
        id: `role:${lead.id}`,
        kind: "role",
        x: leadX,
        y,
        width: 220,
        height: 116,
        thread: lead,
        label: "Project lead",
      });
    const placed = new Set<string>();
    for (const task of groupTasks) {
      const meta = task.source.organization!.task!;
      const owner = byId.get(meta.ownerThreadId);
      const management =
        !owner || ["chief", "advisor", "lead"].includes(owner.source.organization!.role);
      let tx: number, ty: number;
      if (management) {
        tx = (rank.get(task.id) ?? 0) * 280;
        ty = y + backlog++ * 148;
      } else {
        ty = y + row++ * 180;
        tx = leadX + 520;
        const executor =
          task.source.organization!.role === "executor"
            ? task
            : owner.source.organization!.role === "executor"
              ? owner
              : undefined;
        const reviewer =
          meta.state === "changes_requested" && meta.lastReview?.revision === meta.revision
            ? byId.get(meta.lastReview!.reviewerThreadId)
            : meta.reviewerThreadId && meta.reviewedRevision === meta.revision
              ? byId.get(meta.reviewerThreadId)
              : owner.source.organization!.role === "reviewer"
                ? owner
                : undefined;
        for (const [person, rx] of [
          [executor, leadX + 270],
          [reviewer, leadX + 790],
          [!executor && !reviewer ? owner : undefined, leadX + 270],
        ] as const) {
          if (person && !placed.has(person.id)) {
            placed.add(person.id);
            nodes.push({
              id: `role:${person.id}`,
              kind: "role",
              x: rx,
              y: ty,
              width: 220,
              height: 116,
              thread: person,
              label: ROLE_LABELS[person.source.organization!.role],
            });
          }
        }
        if (executor && reviewer)
          edges.push({ from: `role:${reviewer.id}`, to: `role:${executor.id}`, kind: "review" });
      }
      nodes.push({
        id: `task:${task.id}`,
        kind: "task",
        x: tx,
        y: ty,
        width: 240,
        height: canAcceptOrganizationOutcome(task) ? 160 : 116,
        thread: task,
        owner,
        label: meta.title,
      });
    }
    top += Math.max(1, backlog, row) * 180 + 80;
  }
  // Native role conversations without tasks remain addressable, without inventing workers.
  for (const role of roles)
    if (!nodes.some((n) => n.id === `role:${role.id}`)) {
      nodes.push({
        id: `role:${role.id}`,
        kind: "role",
        x: leadX + 270,
        y: top,
        width: 220,
        height: 116,
        thread: role,
        label: ROLE_LABELS[role.source.organization!.role],
      });
      top += 145;
    }
  for (const task of tasks)
    for (const dependency of new Set(task.source.organization!.task!.dependencyThreadIds)) {
      const from = `task:${dependency}`;
      if (!nodes.some((n) => n.id === from)) {
        nodes.push({
          id: from,
          kind: "boundary",
          x: 0,
          y: top,
          width: 240,
          height: 70,
          label: "Prerequisite outside this view",
        });
        top += 95;
      }
      edges.push({ from, to: `task:${task.id}`, kind: "dependency" });
    }
  for (const role of roles) {
    const parent = role.source.organization!.parentThreadId;
    if (parent && nodes.some((n) => n.id === `role:${parent}`))
      edges.push({ from: `role:${parent}`, to: `role:${role.id}`, kind: "command" });
  }
  return {
    nodes,
    edges: [
      ...new Map(edges.map((edge) => [`${edge.kind}:${edge.from}:${edge.to}`, edge])).values(),
    ],
    warnings: [...new Set(warnings)],
    width: Math.max(1000, ...nodes.map((n) => n.x + n.width)) + 80,
    height: Math.max(400, ...nodes.map((n) => n.y + n.height)) + 80,
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
