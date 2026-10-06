import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "~/providerInstances";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { DEFAULT_SERVER_SETTINGS, ThreadId, type OrganizationRole } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveOrganizationRoleModelSelection } from "@t3tools/shared/serverSettings";
import { createThread, type CreateThreadInput } from "@t3tools/client-runtime/operations";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { useEnvironments } from "~/state/environments";
import { useProjects, useThreadShellsForProjectRefs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { connectionAtomRuntime } from "~/connection/runtime";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { OrganizationCanvas } from "./OrganizationCanvas";
import { ROLE_LABELS } from "./organizationLayout";
import { roleModelLabel, roleModelProvider, roleModelSlug } from "./organizationRoleModels";
import styles from "./organization.module.css";

const createRole = createEnvironmentCommand(connectionAtomRuntime, {
  label: "organization:create-role",
  execute: (input: Omit<CreateThreadInput, "threadId">) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      return yield* createThread({
        ...input,
        threadId: ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
      });
    }),
});

export function OrganizationPage() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const navigate = useNavigate();
  // "Open full view" from the panel names the project; the picker can change it.
  const search = useSearch({ strict: false }) as { project?: string };
  const [projectKey, setProjectKey] = useState(search.project ?? "");
  const project =
    (projectKey ? projects.find((p) => `${p.environmentId}:${p.id}` === projectKey) : undefined) ??
    projects[0];
  const environment = environments.find((e) => e.environmentId === project?.environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.organizationV1 === true;
  const connected = environment?.connection.phase === "connected";
  const [workstream, setWorkstream] = useState("");
  const [setup, setSetup] = useState(false);
  const [role, setRole] = useState<OrganizationRole>("chief");
  const [parent, setParent] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const refs = useMemo(
    () => (project ? [scopeProjectRef(project.environmentId, project.id)] : []),
    [project],
  );
  const scoped = useThreadShellsForProjectRefs(refs).filter((t) => !t.deletedAt && !t.archivedAt);
  const providers = deriveProviderInstanceEntries(environment?.serverConfig?.providers ?? [])
    .filter(isProviderInstancePickerReady)
    .map((p) => p.snapshot);
  // The same role model delegate_task uses on this server.
  const roleModel = resolveOrganizationRoleModelSelection(
    environment?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    role,
  );
  const defaultModel = roleModelSlug(roleModel);
  const selectedProvider = provider
    ? providers.find((p) => p.instanceId === provider)
    : roleModelProvider(roleModel, providers);
  const selectedModel =
    selectedProvider?.models.find((m) => m.slug === (model || defaultModel))?.slug ?? "";
  // A configured role model keeps its options when it is what the user creates.
  const selectedOptions =
    roleModel.source === "configured" &&
    selectedProvider?.instanceId === roleModel.selection.instanceId &&
    selectedModel === roleModel.selection.model
      ? roleModel.selection.options
      : undefined;
  const parentRole =
    role === "lead" ? "chief" : role === "executor" || role === "reviewer" ? "lead" : null;
  const parents = scoped.filter((t) => t.source.organization?.role === parentRole);
  const selectedParent = parent ? parents.find((t) => t.id === parent) : parents[0];
  const runCreate = useAtomCommand(createRole, { reportFailure: false });

  async function bootstrap() {
    if (
      !supported ||
      !connected ||
      !project ||
      !selectedProvider ||
      !selectedModel ||
      (parentRole && !selectedParent)
    )
      return;
    setPending(true);
    setError("");
    try {
      const result = await runCreate({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          title: ROLE_LABELS[role],
          modelSelection: {
            instanceId: selectedProvider.instanceId,
            model: selectedModel,
            ...(selectedOptions ? { options: selectedOptions } : {}),
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          organization: { role, parentThreadId: parentRole ? selectedParent!.id : null },
        },
      });
      if (result._tag === "Success") setSetup(false);
      else
        setError(
          "The server did not create this role. Check its connection and your orchestration permissions.",
        );
    } catch {
      setError("Role creation failed. Reconnect to this server and try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <h1>Organization</h1>
      </WorkspacePageHeader>
      <div className={styles["org-toolbar"]}>
        <label>
          Project{" "}
          <select
            aria-label="Organization project"
            value={project ? `${project.environmentId}:${project.id}` : ""}
            onChange={(e) => {
              setProjectKey(e.target.value);
              setWorkstream("");
              setProvider("");
              setModel("");
              setParent("");
            }}
          >
            {projects.map((p) => (
              <option key={`${p.environmentId}:${p.id}`} value={`${p.environmentId}:${p.id}`}>
                {environments.find((e) => e.environmentId === p.environmentId)?.label} · {p.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Workstream{" "}
          <select value={workstream} onChange={(e) => setWorkstream(e.target.value)}>
            <option value="">All leads</option>
            {scoped
              .filter((t) => t.source.organization?.role === "lead")
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </label>
        <span>{environment?.connection.phase ?? "No server"}</span>
        <Button size="sm" disabled={!supported || !connected} onClick={() => setSetup((s) => !s)}>
          Add role
        </Button>
      </div>
      {!supported && (
        <p className={styles["org-notice"]}>
          Select a project on an organization-enabled T3 server. Older servers remain available
          through their native conversations.
        </p>
      )}
      {setup && (
        <form
          className={styles["org-setup"]}
          onSubmit={(e) => {
            e.preventDefault();
            void bootstrap();
          }}
        >
          <label>
            Role{" "}
            <select
              value={role}
              onChange={(e) => {
                setRole(e.target.value as OrganizationRole);
                setParent("");
                setProvider("");
                setModel("");
              }}
            >
              {Object.entries(ROLE_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {parentRole && (
            <label>
              Reports to{" "}
              <select value={selectedParent?.id ?? ""} onChange={(e) => setParent(e.target.value)}>
                {parents.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Provider{" "}
            <select
              value={selectedProvider?.instanceId ?? ""}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel("");
              }}
            >
              <option value="">Choose a provider</option>
              {providers.map((p) => (
                <option key={p.instanceId} value={p.instanceId}>
                  {p.instanceId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model{" "}
            <select value={selectedModel} onChange={(e) => setModel(e.target.value)}>
              <option value="">Choose a model</option>
              {selectedProvider?.models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.slug}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            size="sm"
            disabled={pending || !selectedModel || (!!parentRole && !selectedParent)}
          >
            Create conversation
          </Button>
          {!selectedModel && (
            <p>
              The {ROLE_LABELS[role]} model ({roleModelLabel(roleModel)}) is unavailable on this
              server. Choose another in{" "}
              <Link to="/settings/general" hash="organization-role-models">
                Settings · Organization role models
              </Link>
              , or select an available provider and model explicitly.
            </p>
          )}
          <p>
            Creates an explicit role conversation; no model turn starts until you send a message.
            Runtime: full access within the selected server.
          </p>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      {project ? (
        <OrganizationCanvas
          environmentId={project.environmentId}
          projectId={project.id}
          workstream={workstream}
          onOpenThread={(thread) => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: thread.environmentId, threadId: thread.id },
            });
          }}
        />
      ) : null}
      <p className={styles["org-legend"]}>
        Drag to pan · Ctrl/⌘ + scroll to zoom · Click a card, subtask or review line to open its
        conversation.
      </p>
    </SidebarInset>
  );
}
