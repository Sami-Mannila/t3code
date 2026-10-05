import type { OrganizationRoleModel } from "@t3tools/shared/serverSettings";

export const roleModelSlug = (model: OrganizationRoleModel) =>
  model.source === "default" ? model.model : model.selection.model;

/** "codex · gpt-6.1-sol" for a default, the instance for a configured choice. */
export const roleModelLabel = (model: OrganizationRoleModel) =>
  model.source === "default"
    ? `${model.driverKind} · ${model.model}`
    : `${model.selection.instanceId} · ${model.selection.model}`;

/**
 * The provider that serves a role's model: the configured instance, or for a default the first
 * instance of its driver advertising the model. Nothing else is offered in its place.
 */
export function roleModelProvider<
  P extends {
    readonly instanceId: string;
    readonly driver: string;
    readonly models: ReadonlyArray<{ readonly slug: string }>;
  },
>(model: OrganizationRoleModel, providers: ReadonlyArray<P>): P | undefined {
  const slug = roleModelSlug(model);
  return providers.find(
    (provider) =>
      (model.source === "default"
        ? provider.driver === model.driverKind
        : provider.instanceId === model.selection.instanceId) &&
      provider.models.some((candidate) => candidate.slug === slug),
  );
}
