import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  updateThreadMetadata,
  type UpdateThreadMetadataInput,
} from "@t3tools/client-runtime/operations";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { canAcceptOrganizationOutcome, outcomeFileGroups } from "./organizationLayout";

const acceptOutcome = createEnvironmentCommand(connectionAtomRuntime, {
  label: "organization:accept-outcome",
  execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
});

/** The lead outcome and the exact reviewed revision the user is accepting. */
export interface OrganizationAcceptTarget {
  readonly threadId: string;
  readonly revision: string;
}

/**
 * Final user acceptance of a reviewed lead outcome. The server verifies the artifacts and their
 * child reviews again; this only refuses what is visibly stale.
 */
export function OrganizationAcceptDialog(props: {
  readonly target: OrganizationAcceptTarget | null;
  /** The project's organization conversations. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const runAccept = useAtomCommand(acceptOutcome, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const thread = props.threads.find((t) => t.id === props.target?.threadId);
  const task = thread?.source.organization?.task;
  const environment = environments.find((e) => e.environmentId === thread?.environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.organizationV1 === true;
  const connected = environment?.connection.phase === "connected";
  const fileGroups = outcomeFileGroups(task?.files ?? [], props.threads);
  const chief = props.threads.find(
    (t) =>
      t.id === thread?.source.organization?.parentThreadId &&
      t.source.organization?.role === "chief",
  );
  const stale = task?.revision !== props.target?.revision;
  const close = () => {
    setError("");
    props.onClose();
  };
  async function confirm() {
    if (!supported || !connected || !thread || !canAcceptOrganizationOutcome(thread) || stale)
      return;
    setPending(true);
    setError("");
    try {
      const result = await runAccept({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          organization: {
            ...thread.source.organization!,
            task: { ...task!, state: "accepted" },
          },
        },
      });
      if (result._tag === "Success") close();
      else
        setError(
          "The server could not accept this exact outcome. Its review or files may have changed; inspect the conversation before retrying.",
        );
    } catch {
      setError("Acceptance failed. Check the selected server connection.");
    } finally {
      setPending(false);
    }
  }
  return (
    <AlertDialog
      open={props.target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Accept reviewed outcome?</AlertDialogTitle>
          <AlertDialogDescription>
            Approve the current reviewed result. The server verifies these artifacts and their child
            reviews again before accepting.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 p-4 text-sm">
          <p>{task?.title}</p>
          <p className="break-all">Reviewed revision: {props.target?.revision ?? "Unavailable"}</p>
          <div className="max-h-64 space-y-3 overflow-auto">
            {fileGroups.map((group) => (
              <section key={group.child?.id ?? ""} className="space-y-1">
                <p className="break-all font-medium">
                  {group.child?.title ?? "Other files"}
                  {group.child && (
                    <>
                      {" "}
                      · {group.repository} · {group.branch ?? "No branch"}
                    </>
                  )}
                </p>
                {group.worktreePath && (
                  <p className="break-all text-xs text-muted-foreground">{group.worktreePath}</p>
                )}
                <ul>
                  {group.files.map((file) => (
                    <li key={file.path} className="break-all">
                      {file.path} · {file.bytes} bytes
                      <br />
                      <span className="text-xs text-muted-foreground">{file.sha256}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p>You merge each branch in its repository.</p>
          {chief && (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: chief.environmentId, threadId: chief.id }}
            >
              Open Chief of staff conversation
            </Link>
          )}
          {stale && (
            <p role="alert">
              This outcome changed after the confirmation opened. Close it and inspect the new
              review.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button
            disabled={
              pending ||
              !thread ||
              !canAcceptOrganizationOutcome(thread) ||
              stale ||
              !supported ||
              !connected
            }
            onClick={() => {
              void confirm();
            }}
          >
            Accept this reviewed revision
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
