import { describe, it, expect } from "vite-plus/test";
import {
  ThreadId,
  RunId,
  type OrganizationRole,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { organizationWorkerCapacity } from "./OrganizationCapacity.ts";
const thread = (id: string, role: OrganizationRole) => ({
  id: ThreadId.make(id),
  organization: { role, parentThreadId: null },
});
const run = (id: string, threadId: string, status: OrchestrationV2RunStatus) => ({
  id: RunId.make(id),
  threadId: ThreadId.make(threadId),
  status,
});
describe("global native worker admission", () => {
  it("counts start reservations before provider execution and blocks the eleventh worker", () => {
    const threads = Array.from({ length: 11 }, (_, i) =>
      thread(`t${i}`, i % 2 ? "reviewer" : "executor"),
    );
    const runs = threads
      .slice(0, 10)
      .map((t, i) => run(`r${i}`, t.id, i % 2 ? "starting" : "running"));
    expect(organizationWorkerCapacity(threads, runs, threads[10]!.id)).toMatchObject({
      limit: 10,
      available: 0,
      canStart: false,
    });
  });
  it("does not count durable queued/preparing work or coordinating roles", () => {
    const threads = [
      thread("chief", "chief"),
      thread("lead", "lead"),
      thread("advisor", "advisor"),
      thread("executor", "executor"),
    ];
    const runs = [
      run("c", "chief", "running"),
      run("l", "lead", "running"),
      run("a", "advisor", "running"),
      run("q", "executor", "queued"),
      run("p", "executor", "preparing"),
    ];
    expect(organizationWorkerCapacity(threads, runs)).toMatchObject({
      available: 10,
      occupiedRunIds: [],
    });
  });
  it("retains a worker awaiting tool/user input and releases terminal slots without mutating the queue", () => {
    const threads = [thread("e", "executor")];
    const runs = [
      run("wait", "e", "waiting"),
      run("done", "e", "completed"),
      run("fail", "e", "failed"),
    ];
    expect(organizationWorkerCapacity(threads, runs).occupiedRunIds).toEqual(["wait"]);
    expect(runs.map((r) => r.status)).toEqual(["waiting", "completed", "failed"]);
  });
  it("deduplicates run receipts and leaves Chief coordination possible at capacity", () => {
    const threads = [thread("e", "executor"), thread("chief", "chief")];
    const runs = Array.from({ length: 10 }, (_, i) => run(`r${i}`, "e", "starting"));
    expect(
      organizationWorkerCapacity(threads, [...runs, runs[0]!], ThreadId.make("chief")),
    ).toMatchObject({ available: 0, canStart: true });
  });
});

it("reuses only the candidate's own existing reservation at capacity", () => {
  const threads = [thread("a", "executor"), thread("b", "executor")];
  const runs = Array.from({ length: 10 }, (_, i) => run(`r${i}`, "a", "starting"));
  expect(
    organizationWorkerCapacity(threads, runs, ThreadId.make("a"), RunId.make("r0")).canStart,
  ).toBe(true);
  expect(
    organizationWorkerCapacity(threads, runs, ThreadId.make("b"), RunId.make("r0")).canStart,
  ).toBe(false);
});
