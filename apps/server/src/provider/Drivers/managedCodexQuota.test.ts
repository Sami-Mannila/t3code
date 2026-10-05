import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { managedCodexQuotaSnapshot, applyManagedCodexQuota } from "./managedCodexQuota.ts";

it.effect(
  "managed Codex neither publishes subscription limits nor applies pushed notifications under manual control",
  () =>
    Effect.gen(function* () {
      const exhausted = { windows: [{ remainingPercent: 0 }], checkedAt: "2026-10-05T00:00:00Z" };
      assert.deepStrictEqual(managedCodexQuotaSnapshot(exhausted), {});
      let calls = 0;
      yield* applyManagedCodexQuota(exhausted, () => {
        calls++;
        return Effect.void;
      });
      assert.strictEqual(calls, 0);
    }),
);
