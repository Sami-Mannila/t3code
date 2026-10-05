import { UsageLimitSourceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

it.effect("does not contact a configured quota hub during explicit refresh", () => {
  let requests = 0;
  const noHttp = HttpClient.make(() =>
    Effect.sync(() => {
      requests++;
    }).pipe(Effect.andThen(Effect.die("quota network request"))),
  );
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.UsageLimitSources;
    yield* sources.refresh;
    yield* sources.refresh;
    assert.deepStrictEqual(yield* sources.current, []);
    assert.strictEqual(requests, 0);
  }).pipe(
    Effect.provide(
      UsageLimitSources.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, noHttp),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(true),
            }),
            ServerSettings.layerTest({
              usageLimitSources: {
                [UsageLimitSourceId.make("fixture")]: {
                  kind: "cliproxy",
                  url: "https://quota.invalid",
                  managementKey: "fixture",
                  enabled: true,
                },
              },
            }),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
});
