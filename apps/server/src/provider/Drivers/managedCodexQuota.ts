import * as Effect from "effect/Effect";
import { quotaReadsEnabled } from "../organizationRuntimePolicy.ts";

/** Managed subscriptions must obey the same manual capacity policy as local Codex. */
export function managedCodexQuotaSnapshot<T>(usageLimits: T): { usageLimits?: T } {
  return quotaReadsEnabled() ? { usageLimits } : {};
}

export function applyManagedCodexQuota<T>(update: T, apply: (update: T) => Effect.Effect<void>) {
  return quotaReadsEnabled() ? apply(update) : Effect.void;
}
