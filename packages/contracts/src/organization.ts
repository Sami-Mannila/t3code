import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
