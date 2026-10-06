import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type OrganizationThread } from "@t3tools/contracts";

import {
  canArchiveWorkstream,
  canUnarchiveWorkstream,
  workstreamThreads,
  type WorkstreamThread,
} from "./organizationWorkstream.ts";

type TaskState = NonNullable<OrganizationThread["task"]>["state"];

const thread = (
  id: string,
  role: OrganizationThread["role"] | null,
  parent: string | null = null,
  state?: TaskState,
  extra: Partial<WorkstreamThread> = {},
): WorkstreamThread => ({
  id: ThreadId.make(id),
  organization:
    role === null
      ? null
      : {
          role,
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          ...(state === undefined
            ? {}
            : {
                task: {
                  title: id,
                  ownerThreadId: ThreadId.make(id),
                  dependencyThreadIds: [],
                  state,
                  revision: null,
                  reviewedRevision: null,
                  reviewerThreadId: null,
                  notes: null,
                },
              }),
        },
  archivedAt: null,
  deletedAt: null,
  ...extra,
});

describe("workstreamThreads", () => {
  it("returns a lead and its reporting subtree, deepest first", () => {
    const threads = [
      thread("chief", "chief"),
      thread("lead", "lead", "chief", "accepted"),
      thread("executor-b", "executor", "lead", "accepted"),
      thread("executor-a", "executor", "lead", "accepted"),
      thread("reviewer", "reviewer", "lead"),
      thread("deleted", "executor", "lead", "accepted", { deletedAt: "2026-10-06" }),
      thread("other-lead", "lead", "chief", "accepted"),
      thread("other-executor", "executor", "other-lead", "working"),
      thread("plain", null),
    ];
    expect(workstreamThreads(ThreadId.make("lead"), threads).map((item) => item.id)).toEqual([
      "executor-a",
      "executor-b",
      "reviewer",
      "lead",
    ]);
    expect(workstreamThreads(ThreadId.make("missing"), threads)).toEqual([]);
  });
});

describe("workstream actions", () => {
  it("offers archiving only for a live lead whose outcome is accepted", () => {
    expect(canArchiveWorkstream(thread("lead", "lead", "chief", "accepted"))).toBe(true);
    expect(canArchiveWorkstream(thread("lead", "lead", "chief", "awaiting_review"))).toBe(false);
    expect(canArchiveWorkstream(thread("executor", "executor", "lead", "accepted"))).toBe(false);
    expect(
      canArchiveWorkstream(
        thread("lead", "lead", "chief", "accepted", { archivedAt: "2026-10-06" }),
      ),
    ).toBe(false);
  });

  it("offers restoring for an archived lead", () => {
    expect(
      canUnarchiveWorkstream(thread("lead", "lead", "chief", "accepted", { archivedAt: "x" })),
    ).toBe(true);
    expect(canUnarchiveWorkstream(thread("lead", "lead", "chief", "accepted"))).toBe(false);
    expect(
      canUnarchiveWorkstream(
        thread("executor", "executor", "lead", "accepted", { archivedAt: "x" }),
      ),
    ).toBe(false);
  });
});
