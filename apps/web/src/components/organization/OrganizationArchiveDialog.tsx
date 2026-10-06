import { useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { workstreamThreads } from "@t3tools/shared/organizationWorkstream";

import { useThreadActions } from "~/hooks/useThreadActions";
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
 * Confirms archiving a lead whose outcome the user accepted, together with its executors and
 * reviewers. The server refuses while any of them still has work in progress.
 */
export function OrganizationArchiveDialog(props: {
  readonly lead: EnvironmentThreadShell | null;
  /** The project's organization conversations. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onClose: () => void;
}) {
  const { archiveWorkstream } = useThreadActions();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const members =
    props.lead === null
      ? []
      : workstreamThreads(
          props.lead.id,
          props.threads.map((thread) => thread.source),
        );
  const close = () => {
    setError("");
    props.onClose();
  };
  async function confirm() {
    if (props.lead === null) return;
    setPending(true);
    setError("");
    const result = await archiveWorkstream(scopeThreadRef(props.lead.environmentId, props.lead.id));
    setPending(false);
    if (result._tag === "Success") close();
    else {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Archiving failed.");
    }
  }
  return (
    <AlertDialog
      open={props.lead !== null}
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive workstream?</AlertDialogTitle>
          <AlertDialogDescription>
            Archives {props.lead?.title ?? "this lead"} and every executor and reviewer reporting to
            it: {members.length} {members.length === 1 ? "thread" : "threads"}. Unarchive the lead
            from Settings → Archived to restore them together.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 space-y-1 overflow-auto p-4 text-sm">
          {members.map((thread) => (
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
            disabled={pending || members.length === 0}
            onClick={() => {
              void confirm();
            }}
          >
            Archive {members.length} {members.length === 1 ? "thread" : "threads"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
