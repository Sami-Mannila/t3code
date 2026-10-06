import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OrganizationRole = Schema.Literals([
  "advisor",
  "chief",
  "lead",
  "executor",
  "reviewer",
]);
export type OrganizationRole = typeof OrganizationRole.Type;

/**
 * A Git repository directory relative to the project root, in normalized POSIX form.
 * "." is the project root itself; a root can also be a plain folder of repositories.
 */
export const OrganizationRepositoryPath = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value: string) =>
      value === "." ||
      (!/[\\\0]/.test(value) &&
        !/^[A-Za-z]:/.test(value) &&
        value
          .split("/")
          .every(
            (segment) =>
              segment !== "" && segment !== "." && segment !== ".." && segment !== ".git",
          )) ||
      'Repository must be "." or a normalized path relative to the project root, such as "tt-analytics".',
  ),
);
export type OrganizationRepositoryPath = typeof OrganizationRepositoryPath.Type;

/** A lead's finished round, recorded when its Chief extends the lead with new work. */
export const OrganizationTaskRound = Schema.Struct({
  round: Schema.Number,
  state: TrimmedNonEmptyString,
  revision: Schema.NullOr(TrimmedNonEmptyString),
  reviewedRevision: Schema.NullOr(TrimmedNonEmptyString),
  /** The implementation tasks that round's outcome was built from. */
  dependencyThreadIds: Schema.Array(ThreadId),
  /** Pull request numbers the round owned. */
  pullRequests: Schema.Array(Schema.Number),
  summary: Schema.NullOr(TrimmedNonEmptyString),
  endedAt: IsoDateTime,
});
export type OrganizationTaskRound = typeof OrganizationTaskRound.Type;

/** Earlier rounds a lead keeps; older ones are dropped. */
export const ORGANIZATION_TASK_ROUND_LIMIT = 10;

export const OrganizationTask = Schema.Struct({
  title: TrimmedNonEmptyString,
  /** Repository the task's work belongs to. Absent means ".". Fixed once delegated. */
  repository: Schema.optional(OrganizationRepositoryPath),
  manifest: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyString,
        sha256: TrimmedNonEmptyString,
        bytes: Schema.Number,
      }),
    ),
  ),
  ownerThreadId: ThreadId,
  dependencyThreadIds: Schema.Array(ThreadId),
  /**
   * A research-only lead outcome's artifact: its findings text. Submitted when a lead has no
   * implementation tasks, and the outcome's revision is a hash of it. Absent on other tasks.
   */
  findings: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(20_000))),
  state: Schema.Literals([
    "queued",
    "working",
    "blocked",
    "awaiting_review",
    "changes_requested",
    "accepted",
  ]),
  revision: Schema.NullOr(TrimmedNonEmptyString),
  reviewedRevision: Schema.NullOr(TrimmedNonEmptyString),
  reviewerThreadId: Schema.NullOr(ThreadId),
  notes: Schema.NullOr(TrimmedNonEmptyString),
  lastReview: Schema.optional(
    Schema.Struct({
      reviewerThreadId: ThreadId,
      revision: TrimmedNonEmptyString,
      verdict: Schema.Literal("changes_requested"),
      notes: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  /**
   * When the current round of a lead's task started; absent for its first round. Pull requests
   * the lead linked before it belong to earlier rounds.
   */
  roundStartedAt: Schema.optional(IsoDateTime),
  /** A lead's finished rounds, oldest first, capped. The current round is rounds.length + 1. */
  rounds: Schema.optional(Schema.Array(OrganizationTaskRound)),
});
export type OrganizationTask = typeof OrganizationTask.Type;

/** A role is explicit thread identity; a task has exactly one current owner. */
export const OrganizationThread = Schema.Struct({
  role: OrganizationRole,
  reviewTaskThreadId: Schema.optional(ThreadId),
  parentThreadId: Schema.NullOr(ThreadId),
  task: Schema.optional(OrganizationTask),
});
export type OrganizationThread = typeof OrganizationThread.Type;
