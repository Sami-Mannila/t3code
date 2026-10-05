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

export const OrganizationTask = Schema.Struct({
  title: TrimmedNonEmptyString,
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
