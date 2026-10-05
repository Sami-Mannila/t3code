import { describe, it, expect } from "vite-plus/test";
import { ThreadId, RunId } from "@t3tools/contracts";
import { hasNewPilotFailure, type PilotFailureReceipt } from "./organizationPilotObservation.ts";
const baseline: PilotFailureReceipt = {
  task: {
    state: "blocked",
    revision: "r1",
    ownerThreadId: ThreadId.make("lead"),
    notes: "Old review lookup defect",
  },
  runId: RunId.make("old-run"),
  status: "completed",
  requestId: null,
};
describe("pilot recovery failure observations", () => {
  it("does not treat a new starting/running recovery turn as a fresh task blocker", () => {
    for (const status of ["starting", "running"] as const)
      expect(
        hasNewPilotFailure({ ...baseline, runId: RunId.make("recovery"), status }, baseline),
      ).toBe(false);
  });
  it("stops on changed blocker notes, owner or revision independently of native run", () => {
    for (const change of [
      { notes: "New defect" },
      { ownerThreadId: ThreadId.make("reviewer") },
      { revision: "r2" },
    ])
      expect(
        hasNewPilotFailure({ ...baseline, task: { ...baseline.task!, ...change } }, baseline),
      ).toBe(true);
  });
  it("stops on a new terminal runtime failure even when task blockage is unchanged", () => {
    expect(
      hasNewPilotFailure(
        { ...baseline, runId: RunId.make("recovery"), status: "failed" },
        baseline,
      ),
    ).toBe(true);
    const failed = { ...baseline, status: "failed" as const };
    expect(hasNewPilotFailure(failed, failed)).toBe(false);
  });
  it("detects newly blocked tasks and new input requests, but not recovered task state", () => {
    expect(hasNewPilotFailure(baseline)).toBe(true);
    expect(
      hasNewPilotFailure({ ...baseline, task: { ...baseline.task!, state: "working" } }, baseline),
    ).toBe(false);
    expect(hasNewPilotFailure({ ...baseline, requestId: "new-request" }, baseline)).toBe(true);
  });
});
