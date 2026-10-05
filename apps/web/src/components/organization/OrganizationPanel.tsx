import { Link, useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironments } from "~/state/environments";
import { useThreadShell } from "~/state/entities";
import { OrganizationCanvas } from "./OrganizationCanvas";
import styles from "./organization.module.css";

/** The current conversation's project organization, beside the conversation. */
export function OrganizationPanel(props: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const thread = useThreadShell(props.threadRef);
  const { environments } = useEnvironments();
  const environment = environments.find((e) => e.environmentId === props.threadRef.environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.organizationV1 === true;
  const connected = environment?.connection.phase === "connected";
  if (!thread) return null;
  if (!supported)
    return (
      <p className={styles["org-notice"]}>
        This server does not support organizations. Update it to see this project&apos;s Chief,
        leads and their tasks here.
      </p>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <span className="truncate text-xs text-muted-foreground">Organization</span>
        <Link
          className={styles["org-link"]}
          to="/organization"
          search={{ project: `${thread.environmentId}:${thread.projectId}` }}
        >
          Open full view
        </Link>
      </div>
      <OrganizationCanvas
        compact
        environmentId={thread.environmentId}
        projectId={thread.projectId}
        highlightThreadId={thread.id}
        acceptDisabled={!connected}
        onOpenThread={(target) => {
          // The panel stays open beside the conversation the user moves to.
          useRightPanelStore
            .getState()
            .open(scopeThreadRef(target.environmentId, target.id), "organization");
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: target.environmentId, threadId: target.id },
          });
        }}
      />
    </div>
  );
}

export default OrganizationPanel;
