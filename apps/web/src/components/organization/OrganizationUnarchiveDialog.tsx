import { useState } from "react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { workstreamThreads } from "@t3tools/shared/organizationWorkstream";

import { useThreadActions } from "~/hooks/useThreadActions";
import { useThreadShellsForProjectRefs } from "~/state/entities";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

/**
 * Confirms restoring an archived lead together with every executor and reviewer reporting to it,
 * including ones archived on their own before the workstream was.
 */
export function OrganizationUnarchiveDialog(props: {
  readonly lead: EnvironmentThreadShell | null;
  /** Archived threads, from any project and environment; the lead's project is picked out. */
  readonly archivedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onClose: () => void;
  readonly onRestored: () => void;
}) {
  const { unarchiveWorkstream } = useThreadActions();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lead = props.lead;
  const active = useThreadShellsForProjectRefs(
    lead === null ? [] : [scopeProjectRef(lead.environmentId, lead.projectId)],
  );
  const archivedIds = new Set(
    props.archivedThreads
      .filter((thread) => lead !== null && thread.environmentId === lead.environmentId)
      .map((thread) => thread.id),
  );
  const members =
    lead === null
      ? []
      : workstreamThreads(lead.id, [
          ...active.filter((thread) => !archivedIds.has(thread.id)).map((thread) => thread.source),
          ...props.archivedThreads
            .filter(
              (thread) =>
                thread.environmentId === lead.environmentId && thread.projectId === lead.projectId,
            )
            .map((thread) => thread.source),
        ]);
  const restoring = members.filter((thread) => thread.archivedAt != null);
  const close = () => {
    setError("");
    props.onClose();
  };
  async function confirm() {
    if (lead === null) return;
    setPending(true);
    setError("");
    const result = await unarchiveWorkstream(scopeThreadRef(lead.environmentId, lead.id));
    setPending(false);
    if (result._tag === "Success") {
      props.onRestored();
      close();
    } else {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Unarchiving failed.");
    }
  }
  return (
    <AlertDialog
      open={lead !== null}
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Unarchive workstream?</AlertDialogTitle>
          <AlertDialogDescription>
            Restores {lead?.title ?? "this lead"} and every executor and reviewer reporting to it,
            including any archived on their own: {restoring.length}{" "}
            {restoring.length === 1 ? "thread" : "threads"}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 space-y-1 overflow-auto p-4 text-sm">
          {restoring.map((thread) => (
            <li key={thread.id} className="break-all">
              {thread.title}
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="px-4 pb-4 text-sm">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button
            disabled={pending || restoring.length === 0}
            onClick={() => {
              void confirm();
            }}
          >
            Unarchive {restoring.length} {restoring.length === 1 ? "thread" : "threads"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
