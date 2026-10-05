import { useNavigate } from "@tanstack/react-router";
import {
  defaultInstanceIdForDriver,
  type OrganizationRole,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveOrganizationRoleModelSelection } from "@t3tools/shared/serverSettings";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ROLE_LABELS } from "../organization/organizationLayout";
import { roleModelLabel, roleModelProvider } from "../organization/organizationRoleModels";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const ROLES = [
  "chief",
  "advisor",
  "lead",
  "executor",
  "reviewer",
] as const satisfies ReadonlyArray<OrganizationRole>;

/** Server-wide: delegate_task and the organization page start each role on this model. */
export function OrganizationRoleModelsSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment } = useSettingsScope();
  // The scoped environment supplies the providers; it must also be the one with organizations.
  const supported = environment?.serverConfig?.environment.capabilities.organizationV1 === true;
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  if (!supported) return null;
  const environmentId = environment?.environmentId ?? null;

  return (
    <SettingsSection id="organization-role-models" title="Organization role models">
      {ROLES.map((role, index) => {
        const roleModel = resolveOrganizationRoleModelSelection(settings, role);
        const active =
          roleModel.source === "configured"
            ? roleModel.selection
            : {
                instanceId:
                  (roleModelProvider(roleModel, providers)?.instanceId as
                    | ProviderInstanceId
                    | undefined) ?? defaultInstanceIdForDriver(roleModel.driverKind),
                model: roleModel.model,
              };
        return (
          <SettingsRow
            key={role}
            serverScoped
            settingKeys={["organizationRoleModelSelections"]}
            {...(index === 0
              ? searchableSetting("organization-role-models")
              : { title: ROLE_LABELS[role] })}
            {...(index === 0 ? { title: ROLE_LABELS[role] } : {})}
            description={
              roleModel.source === "default"
                ? `Default: ${roleModelLabel(roleModel)}. An unavailable model is reported, never replaced.`
                : "An unavailable model is reported, never replaced."
            }
            resetAction={
              roleModel.source === "configured" ? (
                <SettingResetButton
                  label={`${ROLE_LABELS[role]} model`}
                  onClick={() =>
                    updateSettings({ organizationRoleModelSelections: { [role]: null } })
                  }
                />
              ) : null
            }
            control={
              <ProviderModelPicker
                activeInstanceId={active.instanceId}
                model={active.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  active.instanceId,
                  active.model,
                )}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel={`${ROLE_LABELS[role]} model`}
                getModelDisabledReason={disabledReason}
                {...(environmentId
                  ? {
                      onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId, instanceId },
                        });
                      },
                    }
                  : {})}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: `${ROLE_LABELS[role]} model not saved`,
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({
                    organizationRoleModelSelections: {
                      [role]: createModelSelection(instanceId, model),
                    },
                  });
                }}
              />
            }
          />
        );
      })}
    </SettingsSection>
  );
}
