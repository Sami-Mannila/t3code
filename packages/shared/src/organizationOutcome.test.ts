import { ProjectId, ThreadId, type OrganizationTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { organizationOutcomeGate, type OutcomeThread } from "./organizationOutcome.ts";

const chief = ThreadId.make("chief"),
  lead = ThreadId.make("lead"),
  executor = ThreadId.make("executor");
const task = (patch: Partial<OrganizationTask>): OrganizationTask => ({
  title: "Work",
  ownerThreadId: lead,
  dependencyThreadIds: [executor],
  state: "awaiting_review",
  revision: "r1",
  reviewedRevision: "r1",
  reviewerThreadId: ThreadId.make("reviewer"),
  notes: null,
  ...patch,
});
const legacyLink = {
  projectId: ProjectId.make("project"),
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
};
const threads = (leadPatch: Partial<OutcomeThread>, chiefPatch: Partial<OutcomeThread> = {}) => {
  const all: OutcomeThread[] = [
    {
      id: chief,
      title: "Chief",
      organization: { role: "chief", parentThreadId: null },
      createdAtMs: 0,
      ...chiefPatch,
    },
    {
      id: lead,
      title: "Lead",
      organization: { role: "lead", parentThreadId: chief, task: task({}) },
      createdAtMs: 1_000,
      ...leadPatch,
    },
    {
      id: executor,
      title: "Executor",
      organization: {
        role: "executor",
        parentThreadId: lead,
        task: task({ state: "accepted", ownerThreadId: executor, dependencyThreadIds: [] }),
      },
      pullRequests: [],
      createdAtMs: 2_000,
    },
  ];
  return { lead: all[1]!, all };
};

describe("organization outcome gate", () => {
  it("counts a legacy single link on the lead as owned until it is known merged", () => {
    const { lead: leadThread, all } = threads({ linkedPullRequest: legacyLink });
    expect(organizationOutcomeGate(leadThread, all)).toMatchObject({
      kind: "waiting_for_pull_requests",
      pullRequests: [{ number: 7, state: "unknown" }],
    });
  });

  it("ignores a legacy link the lead shares with its parent: it was inherited", () => {
    const { lead: leadThread, all } = threads(
      { linkedPullRequest: legacyLink },
      { linkedPullRequest: legacyLink },
    );
    expect(organizationOutcomeGate(leadThread, all)).toMatchObject({
      kind: "ready",
      reason: "reviewed",
    });
  });

  it("treats a server shell's epoch-dated legacy entry as a link of unknown time", () => {
    // Server shells always fill pullRequests; a legacy link appears there linked at the epoch.
    const entry = {
      host: "github.com",
      repository: "acme/app",
      number: 7,
      url: legacyLink.url,
      source: "manual" as const,
      linkedAt: "1970-01-01T00:00:00.000Z",
      snapshot: null,
      stack: null,
    };
    const owned = threads({ pullRequests: [entry] }, { pullRequests: [] });
    expect(organizationOutcomeGate(owned.lead, owned.all)).toMatchObject({
      kind: "waiting_for_pull_requests",
      pullRequests: [{ number: 7 }],
    });
    const inherited = threads({ pullRequests: [entry] }, { pullRequests: [entry] });
    expect(organizationOutcomeGate(inherited.lead, inherited.all)).toMatchObject({
      kind: "ready",
    });
  });

  it("holds the outcome on an executor branch's pull request nobody linked", () => {
    const { lead: leadThread, all } = threads({ pullRequests: [] });
    const withBranch = all.map((thread) =>
      thread.id === executor
        ? {
            ...thread,
            branchPullRequest: { key: "github.com/acme/app#9", number: 9, state: "open" as const },
          }
        : thread,
    );
    expect(organizationOutcomeGate(leadThread, withBranch)).toMatchObject({
      kind: "waiting_for_pull_requests",
      pullRequests: [{ number: 9 }],
    });
  });
});
