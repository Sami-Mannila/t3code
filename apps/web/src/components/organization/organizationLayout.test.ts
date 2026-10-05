import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type OrganizationThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { canAcceptOrganizationOutcome, organizationLayout } from "./organizationLayout";
const env = EnvironmentId.make("remote"),
  project = ProjectId.make("project");
function role(
  id: string,
  organization: OrganizationThread,
  environmentId = env,
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: project,
    title: id,
    deletedAt: null,
    archivedAt: null,
    runtime: null,
    source: { organization },
  } as unknown as EnvironmentThreadShell;
}
function task(
  id: string,
  owner: string,
  deps: string[] = [],
  state: "queued" | "awaiting_review" = "queued",
) {
  return role(id, {
    role: "executor",
    parentThreadId: ThreadId.make("lead"),
    task: {
      title: id,
      ownerThreadId: ThreadId.make(owner),
      dependencyThreadIds: deps.map((id) => ThreadId.make(id)),
      state,
      revision: "r1",
      reviewedRevision: state === "awaiting_review" ? "r1" : null,
      reviewerThreadId: state === "awaiting_review" ? ThreadId.make(owner) : null,
      notes: null,
    },
  });
}
const chief = role("chief", { role: "chief", parentThreadId: null });
const lead = role("lead", { role: "lead", parentThreadId: chief.id });
describe("native organization projection", () => {
  it("scopes role authority and routes to the selected environment", () => {
    const result = organizationLayout(
      [
        chief,
        lead,
        task("work", "lead"),
        role("lead", { role: "reviewer", parentThreadId: null }, EnvironmentId.make("other")),
      ],
      env,
      project,
    );
    expect(result.nodes.find((n) => n.id === "task:work")?.owner?.source.organization?.role).toBe(
      "lead",
    );
    expect(result.nodes.every((n) => !n.thread || n.thread.environmentId === env)).toBe(true);
  });
  it("places each ticket once, beside its reviewer, retaining its exact executor origin", () => {
    const reviewer = role("reviewer", { role: "reviewer", parentThreadId: lead.id });
    const result = organizationLayout(
      [chief, lead, reviewer, task("submitted", "reviewer", [], "awaiting_review")],
      env,
      project,
    );
    expect(result.nodes.filter((n) => n.id === "task:submitted")).toHaveLength(1);
    const ticket = result.nodes.find((n) => n.id === "task:submitted")!;
    expect(ticket.owner?.id).toBe("reviewer");
    expect(result.nodes.find((n) => n.id === "role:submitted")!.x).toBeLessThan(ticket.x);
    expect(result.nodes.find((n) => n.id === "role:reviewer")!.x).toBeGreaterThan(ticket.x);
    expect(result.edges).toContainEqual({
      from: "role:reviewer",
      to: "role:submitted",
      kind: "review",
    });
  });
  it("preserves all shared-root and chain links with vertically spread backlog", () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      task(`t${i}`, "lead", i === 0 ? [] : i === 1 ? ["t0"] : ["t0", `t${i - 1}`]),
    );
    const result = organizationLayout([chief, lead, ...tasks], env, project);
    expect(result.edges.filter((e) => e.kind === "dependency")).toHaveLength(11);
    expect(new Set(result.nodes.filter((n) => n.kind === "task").map((n) => n.y)).size).toBe(7);
    expect(
      result.nodes
        .filter((n) => n.kind === "task")
        .every((n) => n.x < result.nodes.find((n) => n.id === "role:lead")!.x),
    ).toBe(true);
  });
  it("contains cyclic data and represents missing prerequisites without inventing owners", () => {
    const result = organizationLayout(
      [chief, lead, task("a", "lead", ["b", "external", "external"]), task("b", "lead", ["a"])],
      env,
      project,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.nodes.filter((n) => n.kind === "boundary")).toHaveLength(1);
    expect(result.edges.filter((e) => e.kind === "dependency")).toHaveLength(3);
    expect(result.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });
  it("filters a lead workstream but keeps cross-workstream dependencies as boundaries", () => {
    const other = role("other-lead", { role: "lead", parentThreadId: chief.id });
    const external = {
      ...task("external", "other-lead"),
      source: {
        ...task("external", "other-lead").source,
        organization: {
          ...task("external", "other-lead").source.organization!,
          parentThreadId: other.id,
        },
      },
    };
    const result = organizationLayout(
      [chief, lead, other, external, task("local", "lead", ["external"])],
      env,
      project,
      "lead",
    );
    expect(result.nodes.some((n) => n.id === "role:other-lead")).toBe(false);
    expect(result.nodes.find((n) => n.id === "task:external")?.kind).toBe("boundary");
    expect(result.edges.filter((e) => e.kind === "dependency")).toHaveLength(1);
  });
  it("does not display an executor for a task still owned by the lead", () => {
    const result = organizationLayout([chief, lead, task("queued", "lead")], env, project);
    expect(result.nodes.some((n) => n.id === "role:queued")).toBe(false);
    expect(result.nodes.find((n) => n.id === "task:queued")?.owner?.id).toBe("lead");
  });
  it("excludes archived and unrelated idle workers", () => {
    const idle = role("historical", { role: "executor", parentThreadId: lead.id });
    const result = organizationLayout(
      [chief, lead, idle, { ...task("old", "lead"), archivedAt: "2026-01-01" }],
      env,
      project,
    );
    expect(result.nodes.map((n) => n.id)).toEqual(["role:chief", "role:lead"]);
  });
});

describe("final outcome approval eligibility", () => {
  it("requires a lead outcome and independently reviewed current files", () => {
    const outcome = role("outcome", {
      role: "lead",
      parentThreadId: chief.id,
      task: {
        ...task("t", "reviewer", [], "awaiting_review").source.organization!.task!,
        files: [{ path: "task/file.ts", sha256: "abc", bytes: 1 }],
      },
    });
    expect(canAcceptOrganizationOutcome(outcome)).toBe(true);
    for (const changed of [
      { role: "executor" as const },
      { task: { ...outcome.source.organization!.task!, reviewedRevision: "stale" } },
      { task: { ...outcome.source.organization!.task!, reviewerThreadId: outcome.id } },
      { task: { ...outcome.source.organization!.task!, files: [] } },
    ]) {
      expect(
        canAcceptOrganizationOutcome({
          ...outcome,
          source: {
            ...outcome.source,
            organization: { ...outcome.source.organization!, ...changed },
          },
        }),
      ).toBe(false);
    }
  });
});

it("retains rejected submission reviewer only for matching correction revision, without approval eligibility", () => {
  const reviewer = role("reviewer", { role: "reviewer", parentThreadId: lead.id });
  const correcting = task("correction", "correction");
  const meta = correcting.source.organization!.task!;
  const changed = {
    ...correcting,
    source: {
      ...correcting.source,
      organization: {
        ...correcting.source.organization!,
        task: {
          ...meta,
          state: "changes_requested" as const,
          lastReview: {
            reviewerThreadId: reviewer.id,
            revision: meta.revision!,
            verdict: "changes_requested" as const,
          },
        },
      },
    },
  };
  const result = organizationLayout([chief, lead, reviewer, changed], env, project);
  expect(result.edges).toContainEqual({
    from: "role:reviewer",
    to: "role:correction",
    kind: "review",
  });
  expect(canAcceptOrganizationOutcome(changed)).toBe(false);
  const revised = {
    ...changed,
    source: {
      ...changed.source,
      organization: {
        ...changed.source.organization,
        task: { ...changed.source.organization.task, revision: "new" },
      },
    },
  };
  expect(
    organizationLayout([chief, lead, reviewer, revised], env, project).nodes.some(
      (n) => n.id === "role:reviewer",
    ),
  ).toBe(false);
});
