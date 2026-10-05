import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrganizationTask,
  type OrganizationThread,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  canAcceptOrganizationOutcome,
  organizationModel,
  outcomeFileGroups,
} from "./organizationLayout";
const env = EnvironmentId.make("remote"),
  project = ProjectId.make("project");
let created = 0;
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
    createdAt: `2026-01-01T00:00:${String(created++ % 60).padStart(2, "0")}.000Z`,
    deletedAt: null,
    archivedAt: null,
    branch: null,
    runtime: null,
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    source: { organization },
  } as unknown as EnvironmentThreadShell;
}
function task(
  id: string,
  owner: string,
  deps: string[] = [],
  state: "queued" | "awaiting_review" = "queued",
  parent = "lead",
) {
  return role(id, {
    role: "executor",
    parentThreadId: ThreadId.make(parent),
    task: {
      title: `${id} work`,
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
/** The same shell with its task changed. */
function withTask(thread: EnvironmentThreadShell, patch: Partial<OrganizationTask>) {
  const organization = thread.source.organization!;
  return {
    ...thread,
    source: {
      ...thread.source,
      organization: { ...organization, task: { ...organization.task!, ...patch } },
    },
  } as EnvironmentThreadShell;
}
const reviewerOf = (id: string, target: string, parent = "lead") =>
  role(id, {
    role: "reviewer",
    parentThreadId: ThreadId.make(parent),
    reviewTaskThreadId: ThreadId.make(target),
  });
const chief = role("chief", { role: "chief", parentThreadId: null });
const advisor = role("advisor", { role: "advisor", parentThreadId: null });
const lead = role("lead", { role: "lead", parentThreadId: chief.id });
const model = (threads: EnvironmentThreadShell[], workstream = "") =>
  organizationModel(threads, env, project, workstream);

describe("organization cards", () => {
  it("puts Chief before Advisor and scopes every card to the selected environment", () => {
    const result = model([
      advisor,
      chief,
      lead,
      task("work", "work"),
      role("lead", { role: "lead", parentThreadId: null }, EnvironmentId.make("other")),
    ]);
    expect(result.roots.map((t) => t.id)).toEqual(["chief", "advisor"]);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]!.subtasks.map((s) => s.thread.id)).toEqual(["work"]);
    expect(result.empty).toBe(false);
  });

  it("orders a lead's subtasks by dependency and labels what each needs", () => {
    const result = model([
      chief,
      lead,
      task("c", "c", ["b", "a"]),
      task("b", "b", ["a"]),
      task("a", "a"),
      task("d", "d", ["external"]),
    ]);
    const subtasks = result.leads[0]!.subtasks;
    expect(subtasks.map((s) => `${s.number}:${s.thread.id}`)).toEqual(["1:a", "2:b", "3:c", "4:d"]);
    expect(subtasks[2]!.needs.map((need) => need.label)).toEqual(["2", "1"]);
    expect(subtasks[3]!.needs.map((need) => need.label)).toEqual(["a task outside this view"]);
    expect(result.warnings).toEqual([]);
  });

  it("flags a dependency cycle without losing its tasks", () => {
    const result = model([
      chief,
      lead,
      task("a", "a", ["b"]),
      task("b", "b", ["a"]),
      task("c", "c"),
    ]);
    const subtasks = result.leads[0]!.subtasks;
    expect(subtasks.map((s) => s.thread.id)).toEqual(["c", "a", "b"]);
    expect(subtasks.filter((s) => s.inCycle).map((s) => s.thread.id)).toEqual(["a", "b"]);
    expect(result.warnings).toHaveLength(1);
  });

  it("shows executors whose lead is not in view as unassigned, and hides them in a workstream", () => {
    const orphan = task("orphan", "orphan", [], "queued", "gone-lead");
    expect(model([chief, lead, orphan]).unassigned.map((s) => s.thread.id)).toEqual(["orphan"]);
    const other = role("other-lead", { role: "lead", parentThreadId: chief.id });
    const scoped = model([chief, lead, other, orphan, task("local", "local")], "lead");
    expect(scoped.leads.map((card) => card.lead.id)).toEqual(["lead"]);
    expect(scoped.unassigned).toEqual([]);
    expect(scoped.roots.map((t) => t.id)).toEqual(["chief"]);
  });

  it("leaves archived conversations and idle executors without tasks out", () => {
    const idle = role("historical", { role: "executor", parentThreadId: lead.id });
    const result = model([chief, lead, idle, { ...task("old", "old"), archivedAt: "2026-01-01" }]);
    expect(result.leads[0]!.subtasks).toEqual([]);
    expect(result.unassigned).toEqual([]);
  });

  it("reports an empty organization", () => {
    expect(model([]).empty).toBe(true);
  });
});

describe("review lines", () => {
  it("follows a submission from awaiting a reviewer through inspection to acceptance", () => {
    const submitted = withTask(task("work", "work"), {
      state: "awaiting_review",
      revision: "abcdef",
    });
    expect(model([chief, lead, submitted]).leads[0]!.subtasks[0]!.review).toMatchObject({
      state: "awaiting_reviewer",
      reviewer: undefined,
      revision: "abcdef",
    });
    const reviewer = reviewerOf("reviewer", "work");
    const inspecting = withTask(submitted, { ownerThreadId: reviewer.id });
    expect(model([chief, lead, reviewer, inspecting]).leads[0]!.subtasks[0]!.review).toMatchObject({
      state: "inspecting",
      reviewer: { id: "reviewer" },
    });
    const accepted = withTask(inspecting, {
      state: "accepted",
      reviewedRevision: "abcdef",
      reviewerThreadId: reviewer.id,
    });
    expect(model([chief, lead, reviewer, accepted]).leads[0]!.subtasks[0]!.review).toMatchObject({
      state: "accepted",
      reviewer: { id: "reviewer" },
      revision: "abcdef",
    });
  });

  it("shows changes requested on the current revision and collapses earlier rounds", () => {
    const first = reviewerOf("first", "work");
    const second = reviewerOf("second", "work");
    const rejected = withTask(task("work", "work"), {
      state: "changes_requested",
      revision: "r1",
      lastReview: {
        reviewerThreadId: second.id,
        revision: "r1",
        verdict: "changes_requested",
        notes: "manifest missing pilot.json",
      },
    });
    const subtask = model([chief, lead, first, second, rejected]).leads[0]!.subtasks[0]!;
    expect(subtask.review).toMatchObject({
      state: "changes_requested",
      reviewer: { id: "second" },
      notes: "manifest missing pilot.json",
    });
    expect(
      subtask.earlierRounds.map((round) => [round.round, round.reviewer.id, round.verdict]),
    ).toEqual([[1, "first", null]]);
    // Resubmitted: the rejection becomes an earlier round with its recorded feedback.
    const third = reviewerOf("third", "work");
    const resubmitted = withTask(rejected, {
      state: "awaiting_review",
      revision: "r2",
      ownerThreadId: third.id,
    });
    const again = model([chief, lead, first, second, third, resubmitted]).leads[0]!.subtasks[0]!;
    expect(again.review).toMatchObject({ state: "inspecting", reviewer: { id: "third" } });
    expect(
      again.earlierRounds.map((round) => [
        round.round,
        round.reviewer.id,
        round.verdict,
        round.notes,
      ]),
    ).toEqual([
      [1, "first", null, null],
      [2, "second", "changes_requested", "manifest missing pilot.json"],
    ]);
  });

  it("puts the outcome review on the lead card and offers acceptance once it is reviewed", () => {
    const outcomeReviewer = reviewerOf("outcome-reviewer", "lead");
    const reviewed = role("lead", {
      role: "lead",
      parentThreadId: chief.id,
      task: {
        title: "Outcome",
        ownerThreadId: ThreadId.make("lead"),
        dependencyThreadIds: [],
        state: "awaiting_review",
        revision: "04dc99",
        reviewedRevision: "04dc99",
        reviewerThreadId: outcomeReviewer.id,
        notes: null,
        files: [{ path: "work/file.ts", sha256: "abc", bytes: 1 }],
      },
    });
    const card = model([chief, reviewed, outcomeReviewer]).leads[0]!;
    expect(card.outcomeReview).toMatchObject({
      state: "accepted",
      reviewer: { id: "outcome-reviewer" },
    });
    expect(card.canAccept).toBe(true);
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

it("groups a lead outcome's files by the executor whose branch the user merges", () => {
  const base = task("executor-b", "executor-b");
  const organization = base.source.organization!;
  const executor = {
    ...base,
    branch: "t3/organization/abc",
    worktreePath: "/worktrees/abc",
    source: { organization: { ...organization, task: { ...organization.task!, repository: "b" } } },
  } as unknown as EnvironmentThreadShell;
  const file = (path: string) => ({ path, sha256: "hash", bytes: 1 });
  expect(
    outcomeFileGroups(
      [file("executor-b/src/a.ts"), file("executor-b/README.md"), file("unknown/x.ts")],
      [chief, lead, executor],
    ),
  ).toEqual([
    {
      child: executor,
      repository: "b",
      branch: "t3/organization/abc",
      worktreePath: "/worktrees/abc",
      files: [file("src/a.ts"), file("README.md")],
    },
    {
      child: undefined,
      repository: ".",
      branch: null,
      worktreePath: null,
      files: [file("unknown/x.ts")],
    },
  ]);
});
