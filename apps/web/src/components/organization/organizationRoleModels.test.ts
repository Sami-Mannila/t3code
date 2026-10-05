import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { resolveOrganizationRoleModelSelection } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { roleModelLabel, roleModelProvider } from "./organizationRoleModels";

const providers = [
  { instanceId: "codex", driver: "codex", models: [{ slug: "gpt-6.1-sol" }] },
  { instanceId: "opencode-work", driver: "opencode", models: [{ slug: "work-model" }] },
  {
    instanceId: "opencode",
    driver: "opencode",
    models: [{ slug: "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash" }],
  },
];

describe("organization role models", () => {
  it("finds a default's driver instance that advertises the model", () => {
    const executor = resolveOrganizationRoleModelSelection(DEFAULT_SERVER_SETTINGS, "executor");
    expect(roleModelProvider(executor, providers)?.instanceId).toBe("opencode");
    expect(roleModelLabel(executor)).toBe(
      "opencode · fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
    );
  });

  it("uses only the configured instance and offers nothing in its place", () => {
    const configured = (instanceId: string, model: string) =>
      resolveOrganizationRoleModelSelection(
        {
          organizationRoleModelSelections: {
            ...DEFAULT_SERVER_SETTINGS.organizationRoleModelSelections,
            executor: { instanceId: ProviderInstanceId.make(instanceId), model },
          },
        },
        "executor",
      );
    expect(
      roleModelProvider(configured("opencode-work", "work-model"), providers)?.instanceId,
    ).toBe("opencode-work");
    expect(roleModelProvider(configured("opencode-gone", "work-model"), providers)).toBeUndefined();
    expect(roleModelProvider(configured("opencode-work", "retired"), providers)).toBeUndefined();
  });
});
