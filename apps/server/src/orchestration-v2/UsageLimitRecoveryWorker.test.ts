import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { workerLive } from "./UsageLimitRecoveryWorker.ts";

it.effect("does not poll failures or schedule automatic quota-reset resumes", () =>
  Effect.gen(function* () {
    let registrations = 0;
    yield* Layer.build(workerLive).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Scheduler.Scheduler, {
            register: () =>
              Effect.sync(() => {
                registrations++;
              }),
          }),
          // Any call to these services would fail: the disabled worker must not
          // inspect old persisted auto-resume preferences or failed runs.
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
        ),
      ),
    );
    assert.strictEqual(registrations, 0);
  }).pipe(Effect.scoped),
);
