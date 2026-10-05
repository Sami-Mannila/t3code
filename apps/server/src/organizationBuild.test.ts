import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient } from "effect/unstable/http";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "./config.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ProcessRunner from "./processRunner.ts";
import { make } from "./cloud/selfUpdate.ts";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import packageJson from "../package.json" with { type: "json" };
import { resolveServerSelfUpdateCapability } from "./cloud/selfUpdate.ts";
import { ORGANIZATION_BUILD, ORGANIZATION_UPDATE_MESSAGE } from "./organizationBuild.ts";
describe("organization release identity", () => {
  it("identifies its distinct server release", () => {
    expect(ORGANIZATION_BUILD).toBe(true);
    expect(packageJson.version).toContain("-organization.");
    expect(ORGANIZATION_UPDATE_MESSAGE).toContain("upstream updates are disabled");
  });
  it("never advertises stock updates from either service or desktop installations", () => {
    for (const desktopManaged of [false, true])
      for (const launcherManaged of [false, true])
        expect(resolveServerSelfUpdateCapability({ desktopManaged, launcherManaged })).toBeNull();
  });
});

it.effect("rejects both remote update and desktop commit before invoking installer services", () =>
  Effect.gen(function* () {
    const service = yield* make().pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layerTest(
            "/tmp/t3-fork-updater-regression",
            "/tmp/t3-fork-updater-regression/state",
          ).pipe(Layer.provide(NodeServices.layer)),
          Layer.mock(DesktopAppUpdate.DesktopAppUpdate)({ available: true }),
          Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({ managed: true }),
          Layer.mock(ProcessRunner.ProcessRunner)({}),
          Layer.succeed(HostProcessPlatform, "linux"),
          Layer.succeed(HostProcessArchitecture, "x64"),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected upstream download")),
          ),
        ),
      ),
    );
    const update = yield* service.update({ targetVersion: "1.2.3" }).pipe(Effect.flip);
    const commit = yield* service.commitDesktopUpdate("not-an-updater-request").pipe(Effect.flip);
    expect(update.reason).toContain("upstream updates are disabled");
    expect(commit.reason).toContain("upstream updates are disabled");
  }),
);
