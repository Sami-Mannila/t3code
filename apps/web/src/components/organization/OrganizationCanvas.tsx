import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type OrganizationTask,
  type ProjectId,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShellsForProjectRefs } from "~/state/entities";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronRightIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UserRoundXIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { canArchiveWorkstream } from "@t3tools/shared/organizationWorkstream";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { resolvePullRequestState } from "~/components/pullRequest/pullRequestPresentation";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { OrganizationArchiveDialog } from "./OrganizationArchiveDialog";
import { fitOrganization, resizeOrganization, zoomOrganization } from "./organizationCamera";
import {
  ROLE_LABELS,
  organizationModel,
  threadActivity,
  threadIsActive,
  threadModelLabel,
  type OrganizationLeadCard,
  type OrganizationPullRequest,
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

/** The provider's configured instances for the environment the canvas draws. */
function useProviderEntryByInstanceId(
  environmentId: EnvironmentId,
): ReadonlyMap<string, ProviderInstanceEntry> {
  const configs = useServerConfigs();
  return useMemo(() => {
    const config = configs.get(environmentId);
    if (!config) return new Map<string, ProviderInstanceEntry>();
    const entries = applyProviderInstanceSettings(
      deriveProviderInstanceEntries(config.providers),
      config.settings,
    );
    return new Map(entries.map((entry) => [entry.instanceId, entry]));
  }, [configs, environmentId]);
}

const instanceIdOf = (thread: Shell) =>
  thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;

/** The provider glyph; model and activity live in its tooltip, never as card text. */
function ProviderIcon(props: { thread: Shell; entry: ProviderInstanceEntry | undefined }) {
  const { thread, entry } = props;
  const instanceId = instanceIdOf(thread);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={styles["org-provider"]} />}>
        <ProviderInstanceIcon
          driverKind={entry?.driverKind ?? ProviderDriverKind.make(instanceId)}
          displayName={entry?.displayName ?? instanceId}
          accentColor={entry?.accentColor}
          acpRegistryAgentId={entry?.acpRegistryAgentId}
          acpRegistryIconUrl={entry?.acpRegistryIconUrl}
          indicatorBackground="var(--background)"
          iconClassName="size-4"
          statusDotClassName={threadIsActive(thread) ? "bg-success" : "bg-muted-foreground/40"}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {threadModelLabel(thread)} · {threadActivity(thread)}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Role caption, title and the hover-only archive action; the header opens the conversation. */
function CardHeader(props: {
  thread: Shell;
  role: string;
  entry: ProviderInstanceEntry | undefined;
  onOpen: () => void;
  onArchive?: (() => void) | undefined;
}) {
  return (
    <div className={styles["org-header-wrap"]}>
      <button type="button" className={styles["org-header"]} onClick={props.onOpen}>
        <span className={styles["org-role"]}>
          <ProviderIcon thread={props.thread} entry={props.entry} />
          {props.role}
        </span>
        <span className={styles["org-title"]}>{props.thread.title}</span>
      </button>
      {props.onArchive ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={styles["org-archive"]}
                aria-label="Archive workstream"
                onClick={props.onArchive}
              />
            }
          >
            <ArchiveIcon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>Archive workstream</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * One pull request as a chip: state glyph, number and (unless compact) a short title. Compact
 * chips keep only the glyph and number so a narrow subtask row still has room for its title.
 */
function PullRequestChip(props: {
  pullRequest: OrganizationPullRequest;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
  compact?: boolean;
}) {
  const { pullRequest } = props;
  const presentation = resolvePullRequestState({
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
  });
  const label = `Pull request #${pullRequest.number}${
    pullRequest.title ? `: ${pullRequest.title}` : ""
  }`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            className={styles["org-pr-chip"]}
            href={pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            onClick={(event) => props.onOpen(event, pullRequest.url)}
          />
        }
      >
        <presentation.Icon
          className={cn("size-3 shrink-0", presentation.toneClassName)}
          aria-hidden
        />
        <span className={styles["org-pr-number"]}>#{pullRequest.number}</span>
        {!props.compact && pullRequest.title ? (
          <span className={styles["org-pr-title"]}>{pullRequest.title}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {pullRequest.title
          ? `#${pullRequest.number}: ${pullRequest.title}`
          : `Pull request #${pullRequest.number}`}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Earlier-round merged pull requests as one chip that toggles the history list. */
function MergedHistoryChip(props: {
  count: number;
  expanded: boolean;
  onToggleHistory: () => void;
}) {
  const presentation = resolvePullRequestState({ state: "merged", isDraft: false });
  return (
    <button
      type="button"
      className={cn(styles["org-pr-chip"], styles["org-pr-merged"])}
      aria-expanded={props.expanded}
      onClick={props.onToggleHistory}
    >
      <presentation.Icon
        className={cn("size-3 shrink-0", presentation.toneClassName)}
        aria-hidden
      />
      {props.count} merged
    </button>
  );
}

function reviewerPresentation(review: OrganizationReview | null): {
  Icon: typeof UserRoundIcon;
  className: string;
  label: string;
} {
  switch (review?.state) {
    case "accepted":
      return {
        Icon: UserRoundCheckIcon,
        className: "text-success",
        label: `Accepted rev ${shortRevision(review.revision)}`,
      };
    case "changes_requested":
      return {
        Icon: UserRoundXIcon,
        className: "text-warning-foreground",
        label: review.notes ? `Changes requested: “${review.notes}”` : "Changes requested",
      };
    case "inspecting":
      return {
        Icon: UserRoundIcon,
        className: "text-warning-foreground",
        label: `Inspecting rev ${shortRevision(review.revision)}`,
      };
    case "awaiting_reviewer":
      return {
        Icon: UserRoundIcon,
        className: "text-warning-foreground",
        label: "Awaiting reviewer",
      };
    default:
      return { Icon: UserRoundIcon, className: "text-muted-foreground/50", label: "No review yet" };
  }
}

/** Green when accepted, amber while under review, grey with none; the verdict is the tooltip. */
function ReviewerGlyph(props: {
  review: OrganizationReview | null;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
}) {
  const presentation = reviewerPresentation(props.review);
  const reviewer = props.review?.reviewer;
  const glyph = <presentation.Icon className="size-3.5" aria-hidden />;
  const triggerClassName = cn(styles["org-reviewer"], presentation.className);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          reviewer ? (
            <button
              type="button"
              className={cn(
                triggerClassName,
                styles["org-reviewer-button"],
                reviewer.id === props.highlightThreadId && styles["org-current"],
              )}
              aria-label={presentation.label}
              onClick={(event) => {
                event.stopPropagation();
                props.onOpenThread(reviewer);
              }}
            />
          ) : (
            <span className={triggerClassName} />
          )
        }
      >
        {glyph}
      </TooltipTrigger>
      <TooltipPopup side="top">{presentation.label}</TooltipPopup>
    </Tooltip>
  );
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
      <span className={styles["org-review-who"]}>{props.label} ·</span>
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

const reviewVerdict = (round: OrganizationReviewRound) =>
  round.verdict === "changes_requested"
    ? `changes requested${round.notes ? `: “${round.notes}”` : ""}`
    : "reviewed";

/** One disclosure per card: finished rounds, earlier reviewer verdicts and their pull requests. */
function History(props: {
  card: OrganizationLeadCard;
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpenThread: (thread: Shell) => void;
  onOpenPullRequest: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const { card } = props;
  const subtaskRounds = card.subtasks.flatMap((subtask) =>
    subtask.earlierRounds.map((round) => ({ subtask, round })),
  );
  return (
    <div className={styles["org-history"]}>
      <button
        type="button"
        className={styles["org-history-toggle"]}
        aria-expanded={props.open}
        onClick={() => props.onToggle(!props.open)}
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", props.open && "rotate-90")}
          aria-hidden
        />
        History
      </button>
      {props.open ? (
        <div className={styles["org-history-body"]}>
          {card.rounds.map((round) => (
            <div key={round.round} className={styles["org-history-row"]}>
              <span className={styles["org-history-label"]}>
                Round {round.round} · {round.state.replaceAll("_", " ")}
              </span>
              {round.pullRequests.map((pullRequest) => (
                <PullRequestChip
                  key={pullRequest.url}
                  pullRequest={pullRequest}
                  onOpen={props.onOpenPullRequest}
                />
              ))}
            </div>
          ))}
          {card.outcomeEarlierRounds.map((round) => (
            <button
              key={round.reviewer.id}
              type="button"
              className={cn(styles["org-history-row"], styles["org-history-link"])}
              onClick={() => props.onOpenThread(round.reviewer)}
            >
              <span className={styles["org-history-label"]}>
                Outcome · round {round.round} · {reviewVerdict(round)}
              </span>
            </button>
          ))}
          {subtaskRounds.map(({ subtask, round }) => (
            <button
              key={`${subtask.thread.id}:${round.reviewer.id}`}
              type="button"
              className={cn(styles["org-history-row"], styles["org-history-link"])}
              onClick={() => props.onOpenThread(round.reviewer)}
            >
              <span className={styles["org-history-label"]}>
                {subtask.task.title} · round {round.round} · {reviewVerdict(round)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RoleCard(props: {
  thread: Shell;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
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
      <CardHeader
        thread={thread}
        role={ROLE_LABELS[thread.source.organization!.role]}
        entry={props.providerEntryByInstanceId.get(instanceIdOf(thread))}
        onOpen={() => props.onOpenThread(thread)}
      />
    </article>
  );
}

function SubtaskRow(props: {
  subtask: OrganizationSubtask;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
  onOpenPullRequest: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
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
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={styles["org-item-main"]}
              onClick={() => props.onOpenThread(executor)}
            />
          }
        >
          <span className={styles["org-item-line"]}>
            <span className={styles["org-item-title"]}>
              {subtask.number} · {subtask.task.title}
            </span>
            {subtask.needs.length > 0 || subtask.inCycle ? (
              <span className={styles["org-needs"]}>
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
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className={styles["org-tooltip-line"]}>
            Executor · {threadModelLabel(executor)} · {threadActivity(executor)}
          </div>
          <div className={styles["org-tooltip-line"]}>
            {subtask.repository} · {subtask.branch ?? "worktree not prepared"}
          </div>
        </TooltipPopup>
      </Tooltip>
      <div className={styles["org-item-trailing"]}>
        <ProviderIcon
          thread={executor}
          entry={props.providerEntryByInstanceId.get(instanceIdOf(executor))}
        />
        <ReviewerGlyph
          review={subtask.review}
          highlightThreadId={props.highlightThreadId}
          onOpenThread={props.onOpenThread}
        />
        {subtask.pullRequests.map((pullRequest) => (
          <PullRequestChip
            key={pullRequest.url}
            pullRequest={pullRequest}
            onOpen={props.onOpenPullRequest}
            compact
          />
        ))}
        <Pill state={subtask.task.state} />
      </div>
    </div>
  );
}

function LeadCard(props: {
  card: OrganizationLeadCard;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
  onOpenPullRequest: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
  onArchive: (lead: Shell) => void;
}) {
  const { card } = props;
  const { lead, outcome } = card;
  const [historyOpen, setHistoryOpen] = useState(false);
  const hasHistory =
    card.rounds.length > 0 ||
    card.outcomeEarlierRounds.length > 0 ||
    card.subtasks.some((subtask) => subtask.earlierRounds.length > 0);
  return (
    <article
      className={cn(
        styles["org-card"],
        lead.id === props.highlightThreadId && styles["org-current"],
      )}
      data-org-thread={lead.id}
    >
      <CardHeader
        thread={lead}
        role={ROLE_LABELS.lead}
        entry={props.providerEntryByInstanceId.get(instanceIdOf(lead))}
        onOpen={() => props.onOpenThread(lead)}
        onArchive={canArchiveWorkstream(lead.source) ? () => props.onArchive(lead) : undefined}
      />
      {outcome ? (
        <div className={styles["org-outcome"]}>
          <span className={styles["org-outcome-round"]}>
            Round {(outcome.rounds?.length ?? 0) + 1}
          </span>
          <Pill state={outcome.state} {...(card.outcomeWait ? { label: card.outcomeWait } : {})} />
          {outcome.title !== lead.title ? (
            <Truncated className={styles["org-outcome-title"]} text={outcome.title} />
          ) : null}
        </div>
      ) : null}
      {card.pullRequests.length > 0 || card.mergedHistory.length > 0 ? (
        <div className={styles["org-pr-row"]}>
          {card.pullRequests.map((pullRequest) => (
            <PullRequestChip
              key={pullRequest.url}
              pullRequest={pullRequest}
              onOpen={props.onOpenPullRequest}
            />
          ))}
          {card.mergedHistory.length > 0 ? (
            <MergedHistoryChip
              count={card.mergedHistory.length}
              expanded={historyOpen}
              onToggleHistory={() => setHistoryOpen((open) => !open)}
            />
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
      {hasHistory ? (
        <History
          card={card}
          open={historyOpen}
          onToggle={setHistoryOpen}
          onOpenThread={props.onOpenThread}
          onOpenPullRequest={props.onOpenPullRequest}
        />
      ) : null}
      <div className={styles["org-todo"]}>
        {card.subtasks.length === 0 ? (
          <div className={styles["org-empty-list"]}>No subtasks yet — the lead is planning.</div>
        ) : (
          card.subtasks.map((subtask) => (
            <SubtaskRow
              key={subtask.thread.id}
              subtask={subtask}
              providerEntryByInstanceId={props.providerEntryByInstanceId}
              highlightThreadId={props.highlightThreadId}
              onOpenThread={props.onOpenThread}
              onOpenPullRequest={props.onOpenPullRequest}
            />
          ))
        )}
      </div>
    </article>
  );
}

function UnassignedCard(props: {
  subtasks: ReadonlyArray<OrganizationSubtask>;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  highlightThreadId: string | null;
  onOpenThread: (thread: Shell) => void;
  onOpenPullRequest: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
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
            providerEntryByInstanceId={props.providerEntryByInstanceId}
            highlightThreadId={props.highlightThreadId}
            onOpenThread={props.onOpenThread}
            onOpenPullRequest={props.onOpenPullRequest}
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
  const providerEntryByInstanceId = useProviderEntryByInstanceId(props.environmentId);
  const openPullRequest = useOpenPrLink();
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
              providerEntryByInstanceId={providerEntryByInstanceId}
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
            providerEntryByInstanceId={providerEntryByInstanceId}
            highlightThreadId={highlight}
            onOpenThread={props.onOpenThread}
            onOpenPullRequest={openPullRequest}
            onArchive={setArchiving}
          />
        ))}
        {model.unassigned.length > 0 ? (
          <UnassignedCard
            subtasks={model.unassigned}
            providerEntryByInstanceId={providerEntryByInstanceId}
            highlightThreadId={highlight}
            onOpenThread={props.onOpenThread}
            onOpenPullRequest={openPullRequest}
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
