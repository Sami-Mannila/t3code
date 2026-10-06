import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, OrganizationTask, ProjectId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useThreadShellsForProjectRefs } from "~/state/entities";
import { CheckIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { canArchiveWorkstream } from "@t3tools/shared/organizationWorkstream";
import { OrganizationArchiveDialog } from "./OrganizationArchiveDialog";
import { fitOrganization, resizeOrganization, zoomOrganization } from "./organizationCamera";
import {
  ROLE_LABELS,
  organizationModel,
  threadActivity,
  threadIsActive,
  threadModelLabel,
  type OrganizationLeadCard,
  type OrganizationReview,
  type OrganizationReviewRound,
  type OrganizationSubtask,
} from "./organizationLayout";
import styles from "./organization.module.css";

type Shell = EnvironmentThreadShell;

const STATE_LABELS: Record<OrganizationTask["state"], string> = {
  queued: "queued",
  working: "working",
  blocked: "blocked",
  awaiting_review: "in review",
  changes_requested: "changes requested",
  accepted: "accepted",
};
const STATE_PILLS: Record<OrganizationTask["state"], string | undefined> = {
  queued: undefined,
  working: styles["org-pill-working"],
  blocked: styles["org-pill-blocked"],
  awaiting_review: styles["org-pill-review"],
  changes_requested: styles["org-pill-review"],
  accepted: styles["org-pill-accepted"],
};
const CHECKS: Record<OrganizationTask["state"], string | undefined> = {
  queued: undefined,
  working: styles["org-check-wip"],
  blocked: styles["org-check-blocked"],
  awaiting_review: styles["org-check-wip"],
  changes_requested: styles["org-check-wip"],
  accepted: styles["org-check-done"],
};

/** One truncated line; hovering shows the whole value. */
function Truncated(props: { className: string | undefined; text: string; children?: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={props.className}>{props.children ?? props.text}</span>}
      />
      <TooltipPopup>{props.text}</TooltipPopup>
    </Tooltip>
  );
}

const shortRevision = (revision: string | null) => (revision ? `${revision.slice(0, 4)}…` : "");

function Dot({ thread }: { thread: Shell | undefined }) {
  return (
    <span
      className={cn(
        styles["org-dot"],
        thread && threadIsActive(thread) && styles["org-dot-active"],
      )}
    />
  );
}

function Pill({ state, label }: { state: OrganizationTask["state"]; label?: string }) {
  return (
    <span className={cn(styles["org-pill"], STATE_PILLS[state])}>
      {label ?? STATE_LABELS[state]}
    </span>
  );
}

/** "provider · model · activity", truncated with the full value on hover. */
function Meta({ thread }: { thread: Shell }) {
  const text = `${threadModelLabel(thread)} · ${threadActivity(thread)}`;
  return <Truncated className={cn("block", styles["org-meta"])} text={text} />;
}

function ReviewLine(props: {
  label: string;
  review: OrganizationReview;
  onOpenThread: (thread: Shell) => void;
  highlightThreadId: string | null;
}) {
  const { review } = props;
  const reviewer = review.reviewer;
  const verdict =
    review.state === "awaiting_reviewer" ? (
      "awaiting reviewer"
    ) : review.state === "inspecting" ? (
      `inspecting rev ${shortRevision(review.revision)}`
    ) : review.state === "accepted" ? (
      <b className={styles["org-review-accepted"]}>accepted rev {shortRevision(review.revision)}</b>
    ) : (
      <b className={styles["org-review-rejected"]}>
        changes requested{review.notes ? `: “${review.notes}”` : ""}
      </b>
    );
  const content = (
    <>
      <Dot thread={reviewer} />
      <span className={styles["org-review-who"]}>
        {props.label}
        {reviewer ? ` · ${threadModelLabel(reviewer)}` : ""} ·
      </span>
      <span className={styles["org-review-verdict"]}>{verdict}</span>
    </>
  );
  return reviewer ? (
    <button
      type="button"
      className={cn(
        styles["org-review"],
        reviewer.id === props.highlightThreadId && styles["org-current"],
      )}
      onClick={() => props.onOpenThread(reviewer)}
    >
      {content}
    </button>
  ) : (
    <div className={styles["org-review"]}>{content}</div>
  );
}

function EarlierRounds(props: {
  rounds: ReadonlyArray<OrganizationReviewRound>;
  onOpenThread: (thread: Shell) => void;
}) {
  if (props.rounds.length === 0) return null;
  return (
    <details className={styles["org-rounds"]}>
      <summary>
        {props.rounds.length === 1 ? "1 earlier review" : `${props.rounds.length} earlier reviews`}
      </summary>
      {props.rounds.map((round) => (
        <button
          key={round.reviewer.id}
          type="button"
          className={styles["org-review"]}
          onClick={() => props.onOpenThread(round.reviewer)}
        >
          <span className={styles["org-sub-truncate"]}>
            round {round.round} ·{" "}
            {round.verdict === "changes_requested"
              ? `changes requested${round.notes ? `: “${round.notes}”` : ""}`
              : threadModelLabel(round.reviewer)}
          </span>
        </button>
      ))}
    </details>
  );
}

function RoleCard(props: {
  thread: Shell;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
}) {
  const { thread } = props;
  return (
    <article
      className={cn(
        styles["org-card"],
        thread.id === props.highlightThreadId && styles["org-current"],
      )}
      data-org-thread={thread.id}
    >
      <button
        type="button"
        className={styles["org-header"]}
        onClick={() => props.onOpenThread(thread)}
      >
        <span className={styles["org-role"]}>
          <Dot thread={thread} />
          {ROLE_LABELS[thread.source.organization!.role]}
        </span>
        <span className={styles["org-title"]}>{thread.title}</span>
        <Meta thread={thread} />
      </button>
    </article>
  );
}

function SubtaskRow(props: {
  subtask: OrganizationSubtask;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
}) {
  const { subtask } = props;
  const executor = subtask.thread;
  return (
    <div
      className={cn(
        styles["org-item"],
        executor.id === props.highlightThreadId && styles["org-current"],
      )}
      data-org-thread={executor.id}
    >
      <div className={cn(styles["org-check"], CHECKS[subtask.task.state])}>
        {subtask.task.state === "accepted" ? (
          <CheckIcon className="size-3" strokeWidth={3} />
        ) : null}
      </div>
      <div className="min-w-0">
        <button
          type="button"
          className={styles["org-item-main"]}
          onClick={() => props.onOpenThread(executor)}
        >
          <span className={styles["org-item-title"]}>
            {subtask.number} · {subtask.task.title}
          </span>
          <span className={styles["org-sub"]}>
            <Dot thread={executor} />
            <Truncated
              className={styles["org-sub-truncate"]}
              text={`Executor · ${threadModelLabel(executor)} · ${threadActivity(executor)}`}
            />
          </span>
          <span className={styles["org-sub"]}>
            <Truncated
              className={styles["org-sub-truncate"]}
              text={`${subtask.repository} · ${subtask.branch ?? "worktree not prepared"}`}
            />
          </span>
          {subtask.needs.length > 0 || subtask.inCycle ? (
            <span className={styles["org-sub"]}>
              {subtask.needs.map((need) => (
                <span
                  key={need.threadId}
                  className={cn(styles["org-dep"], subtask.inCycle && styles["org-dep-cycle"])}
                >
                  needs {need.label}
                </span>
              ))}
              {subtask.inCycle ? (
                <span className={styles["org-dep-cycle"]}>dependency cycle</span>
              ) : null}
            </span>
          ) : null}
        </button>
        {subtask.review ? (
          <ReviewLine
            label="Review"
            review={subtask.review}
            onOpenThread={props.onOpenThread}
            highlightThreadId={props.highlightThreadId}
          />
        ) : null}
        <EarlierRounds rounds={subtask.earlierRounds} onOpenThread={props.onOpenThread} />
      </div>
      <Pill state={subtask.task.state} />
    </div>
  );
}

function LeadCard(props: {
  card: OrganizationLeadCard;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
  onArchive: (lead: Shell) => void;
}) {
  const { card } = props;
  const { lead, outcome } = card;
  return (
    <article
      className={cn(
        styles["org-card"],
        lead.id === props.highlightThreadId && styles["org-current"],
      )}
      data-org-thread={lead.id}
    >
      <button
        type="button"
        className={styles["org-header"]}
        onClick={() => props.onOpenThread(lead)}
      >
        <span className={styles["org-role"]}>
          <Dot thread={lead} />
          Project lead
        </span>
        <span className={styles["org-title"]}>{lead.title}</span>
        <Meta thread={lead} />
      </button>
      {outcome ? (
        <div className={styles["org-outcome"]}>
          Outcome
          <Pill state={outcome.state} {...(card.outcomeWait ? { label: card.outcomeWait } : {})} />
          {outcome.title !== lead.title ? (
            <Truncated className={styles["org-outcome-title"]} text={outcome.title} />
          ) : null}
        </div>
      ) : null}
      {card.outcomeReview ? (
        <ReviewLine
          label="Outcome review"
          review={card.outcomeReview}
          onOpenThread={props.onOpenThread}
          highlightThreadId={props.highlightThreadId}
        />
      ) : null}
      <EarlierRounds rounds={card.outcomeEarlierRounds} onOpenThread={props.onOpenThread} />
      {canArchiveWorkstream(lead.source) ? (
        <div className={styles["org-accept"]}>
          <Button size="sm" variant="outline" onClick={() => props.onArchive(lead)}>
            Archive workstream
          </Button>
        </div>
      ) : null}
      <div className={styles["org-todo"]}>
        {card.subtasks.length === 0 ? (
          <div className={styles["org-empty-list"]}>No subtasks yet — the lead is planning.</div>
        ) : (
          card.subtasks.map((subtask) => (
            <SubtaskRow
              key={subtask.thread.id}
              subtask={subtask}
              highlightThreadId={props.highlightThreadId}
              onOpenThread={props.onOpenThread}
            />
          ))
        )}
      </div>
    </article>
  );
}

function UnassignedCard(props: {
  subtasks: ReadonlyArray<OrganizationSubtask>;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
}) {
  return (
    <article className={styles["org-card"]}>
      <div className={styles["org-role"]}>Unassigned</div>
      <div className={styles["org-title"]}>Executors without a project lead in view</div>
      <div className={styles["org-todo"]}>
        {props.subtasks.map((subtask) => (
          <SubtaskRow
            key={subtask.thread.id}
            subtask={subtask}
            highlightThreadId={props.highlightThreadId}
            onOpenThread={props.onOpenThread}
          />
        ))}
      </div>
    </article>
  );
}

/**
 * One project's organization: Chief and Advisor on top, then a card per project lead with its
 * outcome and its executors' tasks as a checklist. `compact` stacks the cards for the narrow
 * right panel; the full view pans and zooms.
 */
export function OrganizationCanvas(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workstream?: string;
  compact?: boolean;
  /** The conversation beside the panel, outlined where it appears. */
  highlightThreadId?: string | null;
  onOpenThread: (thread: Shell) => void;
}) {
  const refs = useMemo(
    () => [scopeProjectRef(props.environmentId, props.projectId)],
    [props.environmentId, props.projectId],
  );
  const threads = useThreadShellsForProjectRefs(refs);
  const model = useMemo(
    () => organizationModel(threads, props.environmentId, props.projectId, props.workstream ?? ""),
    [threads, props.environmentId, props.projectId, props.workstream],
  );
  const [archiving, setArchiving] = useState<Shell | null>(null);
  const highlight = props.highlightThreadId ?? null;
  // Up to three lead cards per row; more wrap onto the next.
  const columns = Math.min(3, Math.max(1, model.leads.length + (model.unassigned.length ? 1 : 0)));

  const cards = (
    <>
      {model.roots.length > 0 ? (
        <div className={props.compact ? undefined : styles["org-roots"]}>
          {model.roots.map((thread) => (
            <RoleCard
              key={thread.id}
              thread={thread}
              highlightThreadId={highlight}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </div>
      ) : null}
      {!props.compact && model.roots.length > 0 && columns > 0 ? (
        <div className={styles["org-connector"]} />
      ) : null}
      <div
        className={props.compact ? undefined : styles["org-leads"]}
        style={props.compact ? undefined : ({ "--org-columns": columns } as CSSProperties)}
      >
        {model.leads.map((card) => (
          <LeadCard
            key={card.lead.id}
            card={card}
            highlightThreadId={highlight}
            onOpenThread={props.onOpenThread}
            onArchive={setArchiving}
          />
        ))}
        {model.unassigned.length > 0 ? (
          <UnassignedCard
            subtasks={model.unassigned}
            highlightThreadId={highlight}
            onOpenThread={props.onOpenThread}
          />
        ) : null}
      </div>
    </>
  );

  return (
    <div className={styles["org-canvas"]}>
      {model.warnings.map((warning) => (
        <p className={styles["org-notice"]} key={warning}>
          {warning}
        </p>
      ))}
      {model.empty ? (
        <div className={styles["org-empty"]}>
          <h2>Start with your Chief of staff</h2>
          <p>
            Add a role, choose its provider and model, then open its conversation. Delegated tasks
            appear here as native threads update.
          </p>
        </div>
      ) : props.compact ? (
        <CompactStack highlightThreadId={highlight}>{cards}</CompactStack>
      ) : (
        <PannableWorld key={`${props.environmentId}:${props.projectId}:${props.workstream ?? ""}`}>
          {cards}
        </PannableWorld>
      )}
      <OrganizationArchiveDialog
        lead={archiving}
        threads={threads}
        onClose={() => setArchiving(null)}
      />
    </div>
  );
}

/** The narrow panel scrolls; the highlighted conversation is brought into view once. */
function CompactStack(props: { highlightThreadId: string | null; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.highlightThreadId) return;
    container.current
      ?.querySelector(`[data-org-thread="${CSS.escape(props.highlightThreadId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.highlightThreadId]);
  return (
    <div className={styles["org-stack"]} ref={container}>
      {props.children}
    </div>
  );
}

/** Drag to pan, Ctrl/⌘ + scroll to zoom; a live update never moves the camera. */
function PannableWorld(props: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState({ x: 30, y: 30, scale: 0.85 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const worldSize = () => ({
    width: world.current?.offsetWidth ?? 1000,
    height: world.current?.offsetHeight ?? 600,
  });
  const fit = () => {
    const rect = viewport.current?.getBoundingClientRect();
    if (rect) setCamera(fitOrganization(rect, worldSize()));
  };
  const onViewportResize = useEffectEvent(
    (before: { width: number; height: number } | null, rect: DOMRect) => {
      setCamera((current) =>
        before ? resizeOrganization(current, before, rect) : fitOrganization(rect, worldSize()),
      );
    },
  );
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let before: { width: number; height: number } | null = null;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      onViewportResize(before, rect);
      before = { width: rect.width, height: rect.height };
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey)
        setCamera((current) =>
          zoomOrganization(
            current,
            event.clientX - rect.left,
            event.clientY - rect.top,
            event.deltaY,
          ),
        );
      else
        setCamera((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div
      className={styles["org-viewport"]}
      ref={viewport}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("a,button,summary")) return;
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x;
        const dy = event.clientY - drag.current.y;
        drag.current = { x: event.clientX, y: event.clientY };
        setCamera((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <div className={styles["org-controls"]}>
        <Button variant="outline" size="compact" onClick={fit}>
          Fit
        </Button>
        <Button
          variant="outline"
          size="compact"
          aria-label="Zoom in"
          onClick={() => setCamera((c) => ({ ...c, scale: Math.min(1.5, c.scale * 1.2) }))}
        >
          +
        </Button>
        <Button
          variant="outline"
          size="compact"
          aria-label="Zoom out"
          onClick={() => setCamera((c) => ({ ...c, scale: Math.max(0.15, c.scale / 1.2) }))}
        >
          −
        </Button>
      </div>
      <div
        ref={world}
        className={styles["org-world"]}
        style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})` }}
      >
        {props.children}
      </div>
    </div>
  );
}
