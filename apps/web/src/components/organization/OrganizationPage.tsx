import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "~/providerInstances";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ThreadId, type OrganizationRole } from "@t3tools/contracts";
import {
  createThread,
  updateThreadMetadata,
  type UpdateThreadMetadataInput,
  type CreateThreadInput,
} from "@t3tools/client-runtime/operations";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { useEnvironments } from "~/state/environments";
import { useProjects, useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { connectionAtomRuntime } from "~/connection/runtime";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { fitOrganization, resizeOrganization, zoomOrganization } from "./organizationCamera";
import {
  organizationLayout,
  ROLE_LABELS,
  canAcceptOrganizationOutcome,
} from "./organizationLayout";
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

const acceptOutcome = createEnvironmentCommand(connectionAtomRuntime, {
  label: "organization:accept-outcome",
  execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
});

export function OrganizationPage() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const [projectKey, setProjectKey] = useState("");
  const project = projectKey
    ? projects.find((p) => `${p.environmentId}:${p.id}` === projectKey)
    : projects[0];
  const environment = environments.find((e) => e.environmentId === project?.environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.organizationV1 === true;
  const connected = environment?.connection.phase === "connected";
  const [workstream, setWorkstream] = useState("");
  const [setup, setSetup] = useState(false);
  const [role, setRole] = useState<OrganizationRole>("chief");
  const [parent, setParent] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [accepting, setAccepting] = useState<{ id: string; revision: string } | null>(null);
  const [acceptError, setAcceptError] = useState("");
  const [acceptPending, setAcceptPending] = useState(false);
  const runAccept = useAtomCommand(acceptOutcome, { reportFailure: false });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const providers = deriveProviderInstanceEntries(environment?.serverConfig?.providers ?? [])
    .filter(isProviderInstancePickerReady)
    .map((p) => p.snapshot);
  const defaultDriver = role === "executor" ? "opencode" : "codex";
  const defaultModel =
    role === "executor"
      ? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash"
      : "gpt-6.1-sol";
  const selectedProvider = provider
    ? providers.find((p) => p.instanceId === provider)
    : providers.find(
        (p) => p.driver === defaultDriver && p.models.some((m) => m.slug === defaultModel),
      );
  const selectedModel =
    selectedProvider?.models.find((m) => m.slug === (model || defaultModel))?.slug ?? "";
  const scoped = threads.filter(
    (t) =>
      t.environmentId === project?.environmentId &&
      t.projectId === project?.id &&
      !t.deletedAt &&
      !t.archivedAt,
  );
  const parentRole =
    role === "lead" ? "chief" : role === "executor" || role === "reviewer" ? "lead" : null;
  const parents = scoped.filter((t) => t.source.organization?.role === parentRole);
  const selectedParent = parent ? parents.find((t) => t.id === parent) : parents[0];
  const acceptedThread = scoped.find((t) => t.id === accepting?.id);
  const acceptedTask = acceptedThread?.source.organization?.task;
  const chief = scoped.find(
    (t) =>
      t.id === acceptedThread?.source.organization?.parentThreadId &&
      t.source.organization?.role === "chief",
  );
  async function confirmOutcome() {
    if (
      !supported ||
      !connected ||
      !acceptedThread ||
      !canAcceptOrganizationOutcome(acceptedThread) ||
      acceptedTask?.revision !== accepting?.revision
    )
      return;
    setAcceptPending(true);
    setAcceptError("");
    try {
      const result = await runAccept({
        environmentId: acceptedThread.environmentId,
        input: {
          threadId: acceptedThread.id,
          organization: {
            ...acceptedThread.source.organization!,
            task: { ...acceptedTask!, state: "accepted" },
          },
        },
      });
      if (result._tag === "Success") setAccepting(null);
      else
        setAcceptError(
          "The server could not accept this exact outcome. Its review or files may have changed; inspect the conversation before retrying.",
        );
    } catch {
      setAcceptError("Acceptance failed. Check the selected server connection.");
    } finally {
      setAcceptPending(false);
    }
  }
  const runCreate = useAtomCommand(createRole, { reportFailure: false });
  const layout = useMemo(
    () =>
      project
        ? organizationLayout(threads, project.environmentId, project.id, workstream)
        : { nodes: [], edges: [], warnings: [], width: 1000, height: 600 },
    [threads, project, workstream],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState({ x: 30, y: 30, scale: 0.75 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  function fit() {
    const rect = viewport.current?.getBoundingClientRect();
    if (rect) setCamera(fitOrganization(rect, layout));
  }
  const onViewportResize = useEffectEvent(
    (before: { width: number; height: number } | null, rect: DOMRect) => {
      setCamera((camera) =>
        before ? resizeOrganization(camera, before, rect) : fitOrganization(rect, layout),
      );
    },
  );
  const cameraScope = `${project?.environmentId ?? ""}:${project?.id ?? ""}:${workstream}`;
  const measuredViewport = useRef<{
    scope: string;
    size: { width: number; height: number };
  } | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let before =
      measuredViewport.current?.scope === cameraScope ? measuredViewport.current.size : null;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      onViewportResize(before, rect);
      before = { width: rect.width, height: rect.height };
      measuredViewport.current = { scope: cameraScope, size: before };
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [cameraScope]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey)
        setCamera((camera) =>
          zoomOrganization(
            camera,
            event.clientX - rect.left,
            event.clientY - rect.top,
            event.deltaY,
          ),
        );
      else
        setCamera((camera) => ({
          ...camera,
          x: camera.x - event.deltaX,
          y: camera.y - event.deltaY,
        }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);
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
          modelSelection: { instanceId: selectedProvider.instanceId, model: selectedModel },
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
        <Button variant="outline" size="sm" onClick={fit}>
          Fit
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCamera((c) => ({ ...c, scale: Math.min(1.5, c.scale * 1.2) }))}
        >
          +
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCamera((c) => ({ ...c, scale: Math.max(0.15, c.scale / 1.2) }))}
        >
          −
        </Button>
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
              The role default ({defaultDriver} · {defaultModel}) is unavailable. Select an
              available provider and model explicitly.
            </p>
          )}
          <p>
            Creates an explicit role conversation; no model turn starts until you send a message.
            Runtime: full access within the selected server.
          </p>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      {layout.warnings.map((w) => (
        <p className={styles["org-notice"]} key={w}>
          {w}
        </p>
      ))}
      <div
        className={styles["org-viewport"]}
        ref={viewport}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("a,button")) return;
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x,
            dy = e.clientY - drag.current.y;
          drag.current = { x: e.clientX, y: e.clientY };
          setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {!layout.nodes.length && (
          <div className={styles["org-empty"]}>
            <h2>Start with your Chief of staff</h2>
            <p>
              Add a role, choose its provider and model, then open its conversation. Delegated tasks
              appear here as native threads update.
            </p>
          </div>
        )}
        <div
          className={styles["org-world"]}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`,
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            className={styles["org-edges"]}
            aria-label="Dependency and reporting relationships"
          >
            <defs>
              <marker
                id="org-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const a = layout.nodes.find((n) => n.id === edge.from),
                b = layout.nodes.find((n) => n.id === edge.to);
              if (!a || !b) return null;
              const x = a.x + a.width,
                y = a.y + a.height / 2,
                bx = b.x,
                by = b.y + b.height / 2;
              return (
                <path
                  key={`${edge.kind}:${edge.from}:${edge.to}`}
                  className={`${styles["org-edge"]} ${styles[`org-edge-${edge.kind}`]}`}
                  markerEnd="url(#org-arrow)"
                  d={`M${x},${y} C${x + 45},${y} ${bx - 45},${by} ${bx},${by}`}
                >
                  <title>
                    {edge.kind}: {a.label} → {b.label}
                  </title>
                </path>
              );
            })}
          </svg>
          {layout.nodes.map((node) => (
            <article
              key={node.id}
              className={`${styles["org-node"]} ${styles[`org-node-${node.kind}`]} ${node.thread?.runtime?.status === "running" && node.thread.runtime.activeRunId ? styles["org-node-running"] : ""} ${node.thread?.source.organization?.task?.state === "blocked" ? styles["org-node-blocked"] : ""}`}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            >
              {node.thread ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: node.thread.environmentId, threadId: node.thread.id }}
                >
                  <strong>{node.label}</strong>
                  <span>
                    {node.kind === "role"
                      ? node.thread.title
                      : node.thread.source.organization?.task?.state.replaceAll("_", " ")}
                  </span>
                  {node.kind === "role" ? (
                    <>
                      <small>
                        {node.thread.modelSelection.instanceId} · {node.thread.modelSelection.model}
                      </small>
                      <small>{node.thread.runtime?.status ?? "idle"} · Open conversation</small>
                    </>
                  ) : (
                    <small>
                      Owner:{" "}
                      {node.owner
                        ? `${ROLE_LABELS[node.owner.source.organization!.role]} · ${node.owner.title}`
                        : "Unavailable in this view"}
                    </small>
                  )}
                </Link>
              ) : (
                <strong>{node.label}</strong>
              )}
              {node.kind === "task" && node.thread && canAcceptOrganizationOutcome(node.thread) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!supported || !connected}
                  onClick={() => {
                    setAccepting({
                      id: node.thread!.id,
                      revision: node.thread!.source.organization!.task!.revision!,
                    });
                    setAcceptError("");
                  }}
                >
                  Accept reviewed outcome
                </Button>
              )}
            </article>
          ))}
        </div>
      </div>
      <AlertDialog
        open={accepting !== null}
        onOpenChange={(open) => {
          if (!open && !acceptPending) setAccepting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Accept reviewed outcome?</AlertDialogTitle>
            <AlertDialogDescription>
              Approve the current reviewed result. The server verifies these artifacts and their
              child reviews again before accepting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 p-4 text-sm">
            <p>{acceptedTask?.title}</p>
            <p className="break-all">Reviewed revision: {accepting?.revision ?? "Unavailable"}</p>
            <ul className="max-h-52 overflow-auto">
              {acceptedTask?.files?.map((file) => (
                <li key={file.path} className="break-all">
                  {file.path} · {file.bytes} bytes
                  <br />
                  <span className="text-xs text-muted-foreground">{file.sha256}</span>
                </li>
              ))}
            </ul>
            {chief && (
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: chief.environmentId, threadId: chief.id }}
              >
                Open Chief of staff conversation
              </Link>
            )}
            {acceptedTask?.revision !== accepting?.revision && (
              <p role="alert">
                This outcome changed after the confirmation opened. Close it and inspect the new
                review.
              </p>
            )}
            {acceptError && <p role="alert">{acceptError}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={acceptPending} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={
                acceptPending ||
                !acceptedThread ||
                !canAcceptOrganizationOutcome(acceptedThread) ||
                acceptedTask?.revision !== accepting?.revision ||
                !connected
              }
              onClick={() => {
                void confirmOutcome();
              }}
            >
              Accept this reviewed revision
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <p className={styles["org-legend"]}>
        Drag to pan · Ctrl/⌘ + scroll to zoom · Solid: prerequisites · Dashed: reporting · Dotted:
        review feedback. Click a card to open its native conversation.
      </p>
    </SidebarInset>
  );
}
