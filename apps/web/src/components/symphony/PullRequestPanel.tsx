import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleHelpIcon,
  ClockIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react";
import type { VariantProps } from "class-variance-authority";
import { useState } from "react";

import { createEnvironmentRpcCommand } from "@neokod/client-runtime/state/runtime";
import {
  SYMPHONY_WS_METHODS,
  type EnvironmentId,
  type ModelReviewArtefact,
  type ModelReviewerResult,
  type PullRequestEvidence,
  type WorkItem,
  type WorkItemId,
} from "@neokod/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Badge, badgeVariants } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

/**
 * `requestChanges` / `approveMerge` are wired server-side
 * (apps/server/src/ws.ts) but are not yet exposed from the shared
 * `createSymphonyEnvironmentAtoms` map in `@neokod/client-runtime`, so the
 * panel builds command atoms directly from the generic RPC factory rather
 * than hand-rolling a fetch call. These are stable module-level atoms, not
 * created per render.
 */
const requestChangesCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:symphony:requestChanges",
  tag: SYMPHONY_WS_METHODS.requestChanges,
});
const approveMergeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:symphony:approveMerge",
  tag: SYMPHONY_WS_METHODS.approveMerge,
});
const refreshPullRequestCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:symphony:refreshPullRequest",
  tag: SYMPHONY_WS_METHODS.refreshPullRequest,
});

interface StatusPresentation {
  readonly label: string;
  readonly variant: BadgeVariant;
  readonly Icon: typeof CheckCircle2Icon;
}

const UNKNOWN_PRESENTATION: StatusPresentation = {
  label: "Unknown",
  variant: "secondary",
  Icon: CircleHelpIcon,
};

function prStatusPresentation(status: PullRequestEvidence["status"]): StatusPresentation {
  switch (status) {
    case "open":
      return { label: "Open", variant: "success", Icon: GitPullRequestIcon };
    case "draft":
      return { label: "Draft", variant: "secondary", Icon: GitPullRequestDraftIcon };
    case "merged":
      return { label: "Merged", variant: "info", Icon: GitMergeIcon };
    case "closed":
      return { label: "Closed", variant: "error", Icon: GitPullRequestClosedIcon };
    default:
      return UNKNOWN_PRESENTATION;
  }
}

function ciStatusPresentation(ciStatus: PullRequestEvidence["ciStatus"]): StatusPresentation {
  switch (ciStatus) {
    case "success":
      return { label: "Passing", variant: "success", Icon: CheckCircle2Icon };
    case "failure":
      return { label: "Failing", variant: "error", Icon: XCircleIcon };
    case "pending":
      return { label: "Pending", variant: "info", Icon: ClockIcon };
    default:
      // "unknown" and absent (unenriched host) render identically: an
      // honest "Unknown", never a silent pass or a fabricated failure.
      return UNKNOWN_PRESENTATION;
  }
}

function reviewStatePresentation(
  reviewState: PullRequestEvidence["reviewState"],
): StatusPresentation {
  switch (reviewState) {
    case "approved":
      return { label: "Approved", variant: "success", Icon: CheckCircle2Icon };
    case "changes_requested":
      return { label: "Changes requested", variant: "error", Icon: XCircleIcon };
    case "review_required":
      return { label: "Review required", variant: "warning", Icon: MessageSquareIcon };
    case "none":
      return { label: "No reviews yet", variant: "secondary", Icon: CircleHelpIcon };
    default:
      return UNKNOWN_PRESENTATION;
  }
}

function mergeablePresentation(mergeable: PullRequestEvidence["mergeable"]): StatusPresentation {
  switch (mergeable) {
    case "mergeable":
      return { label: "Mergeable", variant: "success", Icon: CheckCircle2Icon };
    case "conflicting":
      return { label: "Conflicting", variant: "error", Icon: XCircleIcon };
    default:
      // Tri-state: "unknown" (and absent) is distinct from a confirmed
      // conflict and must never render as a failure (audit item 5).
      return UNKNOWN_PRESENTATION;
  }
}

/** The five fields that make up host enrichment (plan 10.1, Phase 5). When
 * none of them are present the host has not enriched this PR at all (a
 * non-GitHub host, or GitHub before the first refresh), and the panel says
 * so rather than rendering a row of blank "Unknown" badges. */
function hasEnrichment(pullRequest: PullRequestEvidence): boolean {
  return (
    pullRequest.ciStatus !== undefined ||
    pullRequest.reviewState !== undefined ||
    pullRequest.mergeable !== undefined ||
    pullRequest.unresolvedComments !== undefined ||
    pullRequest.latestCommit !== undefined
  );
}

/** Mirrors the server's `approveMerge` gate exactly (plan 14, FR-095;
 * apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts)
 * so the UI never enables an action the server will refuse. Order matches
 * the server: lifecycle, CI, review, mergeability, unresolved comments. */
export function approveMergeBlockers(
  pullRequest: PullRequestEvidence,
  lifecycle: WorkItem["lifecycle"],
  modelReview: ModelReviewArtefact | null,
): string[] {
  const reasons: string[] = [];
  if (lifecycle !== "ready_for_review") {
    reasons.push(`run is ${lifecycle.replaceAll("_", " ")}, not ready for review`);
  }
  if (pullRequest.ciStatus !== "success") {
    reasons.push(
      pullRequest.ciStatus === undefined
        ? "CI status is not reported"
        : `CI is ${pullRequest.ciStatus}`,
    );
  }
  if (pullRequest.reviewState === undefined || pullRequest.reviewState === "changes_requested") {
    reasons.push(
      pullRequest.reviewState === "changes_requested"
        ? "changes have been requested"
        : "no review decision yet",
    );
  }
  if (pullRequest.mergeable !== "mergeable") {
    reasons.push(
      pullRequest.mergeable === "conflicting"
        ? "branch has merge conflicts"
        : "mergeability is unknown",
    );
  }
  if (pullRequest.unresolvedComments === undefined) {
    reasons.push("unresolved comment count is not reported");
  } else if (pullRequest.unresolvedComments > 0) {
    const count = pullRequest.unresolvedComments;
    reasons.push(`${count} unresolved comment${count === 1 ? "" : "s"}`);
  }
  if (modelReview !== null && modelReview.require !== "advisory") {
    if (!modelReview.passed) {
      reasons.push(`model review did not satisfy ${modelReview.require.replaceAll("-", " ")}`);
    }
    if (
      modelReview.headSha === undefined ||
      pullRequest.latestCommit === undefined ||
      modelReview.headSha !== pullRequest.latestCommit
    ) {
      reasons.push("model review is not current for the latest commit");
    }
  }
  return reasons;
}

/** `requestChanges` only requires the item to still be ready for review
 * server-side; mirror that single gate. */
function requestChangesBlockers(lifecycle: WorkItem["lifecycle"]): string[] {
  return lifecycle === "ready_for_review"
    ? []
    : [`run is ${lifecycle.replaceAll("_", " ")}, not ready for review`];
}

function StatusBadge({ presentation }: { readonly presentation: StatusPresentation }) {
  const Icon = presentation.Icon;
  return (
    <Badge variant={presentation.variant} size="sm">
      <Icon />
      {presentation.label}
    </Badge>
  );
}

function EnrichmentField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </dt>
      <dd className="text-[11px] text-foreground">{children}</dd>
    </div>
  );
}

/** A disabled action wrapped so its explanatory tooltip still fires: the
 * underlying `disabled` attribute makes the button itself
 * `pointer-events-none`, so the tooltip trigger anchors on a plain
 * (non-disabled) wrapping span instead. */
function GatedAction({
  blocked,
  reasons,
  children,
}: {
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly children: React.ReactElement;
}) {
  if (!blocked) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top" align="start" className="max-w-64">
        Blocked: {reasons.join(", ")}.
      </TooltipPopup>
    </Tooltip>
  );
}

function reviewerPresentation(reviewer: ModelReviewerResult): StatusPresentation {
  if (reviewer.status !== "completed") {
    return {
      label: reviewer.status === "interrupted" ? "Interrupted" : "Failed",
      variant: "warning",
      Icon: AlertTriangleIcon,
    };
  }
  return reviewer.verdict === "approve"
    ? { label: "Approve", variant: "success", Icon: CheckCircle2Icon }
    : { label: "Changes", variant: "error", Icon: XCircleIcon };
}

function aggregateReviewPresentation(modelReview: ModelReviewArtefact): StatusPresentation {
  if (modelReview.require === "advisory") {
    return { label: "Advisory", variant: "info", Icon: CircleHelpIcon };
  }
  return modelReview.passed
    ? { label: "Review passed", variant: "success", Icon: CheckCircle2Icon }
    : { label: "Review blocked", variant: "error", Icon: XCircleIcon };
}

export function ModelReviewStrip({ modelReview }: { readonly modelReview: ModelReviewArtefact }) {
  const [expandedReviewer, setExpandedReviewer] = useState<string | null>(null);
  const presentation = aggregateReviewPresentation(modelReview);
  const approvals = modelReview.reviewers.filter(
    (reviewer) => reviewer.status === "completed" && reviewer.verdict === "approve",
  ).length;

  return (
    <section className="mt-3 border-t border-border/60 pt-3" aria-labelledby="model-review-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <BotIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 id="model-review-title" className="text-[11px] font-semibold text-foreground">
            Model review
          </h3>
          <span className="text-[10px] text-muted-foreground">
            {modelReview.require.replaceAll("-", " ")}
          </span>
        </div>
        <Badge variant={presentation.variant} size="sm">
          <presentation.Icon />
          {presentation.label} · {approvals} of {modelReview.reviewers.length} approve
        </Badge>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Reviewer verdicts">
        {modelReview.reviewers.map((reviewer, index) => {
          const key = `${reviewer.provider}:${reviewer.model}:${index}`;
          const reviewerStatus = reviewerPresentation(reviewer);
          const ReviewerIcon = reviewerStatus.Icon;
          const expanded = expandedReviewer === key;
          return (
            <button
              key={key}
              type="button"
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1",
                "text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                expanded && "bg-muted/60",
              )}
              aria-expanded={expanded}
              aria-controls={`model-review-${index}`}
              aria-label={`${reviewer.model}: ${reviewerStatus.label}`}
              onClick={() => setExpandedReviewer(expanded ? null : key)}
            >
              <ReviewerIcon
                className={cn(
                  "size-3",
                  reviewerStatus.variant === "success" && "text-success-foreground",
                  reviewerStatus.variant === "error" && "text-destructive-foreground",
                  reviewerStatus.variant === "warning" && "text-warning-foreground",
                )}
                aria-hidden="true"
              />
              <span>{reviewer.model}</span>
              <span className="text-muted-foreground">· {reviewerStatus.label}</span>
              <ChevronDownIcon
                className={cn(
                  "size-3 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      {modelReview.reviewers.map((reviewer, index) => {
        const key = `${reviewer.provider}:${reviewer.model}:${index}`;
        if (expandedReviewer !== key) {
          return null;
        }
        return (
          <div
            key={key}
            id={`model-review-${index}`}
            className="mt-2 rounded-lg border border-border/60 bg-muted/30 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-medium text-foreground">{reviewer.model}</p>
              <span className="text-[10px] text-muted-foreground">{reviewer.provider}</span>
            </div>
            {reviewer.summary.length > 0 ? (
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {reviewer.summary}
              </p>
            ) : null}
            {reviewer.error !== undefined ? (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning-foreground">
                <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                {reviewer.error}
              </p>
            ) : null}
            {reviewer.findings.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {reviewer.findings.map((finding, findingIndex) => (
                  <li
                    key={`${finding.title}:${findingIndex}`}
                    className="border-t border-border/50 pt-2 first:border-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={
                          finding.severity === "blocking"
                            ? "error"
                            : finding.severity === "warning"
                              ? "warning"
                              : "secondary"
                        }
                        size="sm"
                      >
                        {finding.severity}
                      </Badge>
                      <span className="text-[11px] font-medium text-foreground">
                        {finding.title}
                      </span>
                      {finding.path !== undefined ? (
                        <code className="text-[10px] text-muted-foreground">{finding.path}</code>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {finding.detail}
                    </p>
                  </li>
                ))}
              </ul>
            ) : reviewer.status === "completed" ? (
              <p className="mt-2 text-[11px] text-muted-foreground">No actionable findings.</p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

export interface PullRequestPanelProps {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId;
  readonly lifecycle: WorkItem["lifecycle"];
  readonly pullRequest: PullRequestEvidence;
  readonly modelReview: ModelReviewArtefact | null;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}

export function PullRequestPanel({
  environmentId,
  workItemId,
  lifecycle,
  pullRequest,
  modelReview,
  onRefresh,
  isRefreshing,
}: PullRequestPanelProps) {
  const requestChanges = useAtomCommand(requestChangesCommand);
  const refreshPullRequest = useAtomCommand(refreshPullRequestCommand);

  const handleRefresh = async () => {
    // Fresh host query first (best-effort: an unenriched host or transient
    // failure still falls through to re-syncing the stored evidence), then
    // re-read the run so the panel shows what the server now holds.
    await refreshPullRequest({ environmentId, input: { workItemId } }).catch(() => null);
    onRefresh();
  };
  const approveMerge = useAtomCommand(approveMergeCommand);
  const [pendingAction, setPendingAction] = useState<"requestChanges" | "approveMerge" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const enriched = hasEnrichment(pullRequest);
  const statusPresentation = prStatusPresentation(pullRequest.status);
  const approveBlockers = approveMergeBlockers(pullRequest, lifecycle, modelReview);
  const requestBlockers = requestChangesBlockers(lifecycle);

  const applyGateOutcome = (ok: boolean) => {
    if (!ok) {
      setActionError(
        "The server refused the request — the run's state may have changed. Refresh and try again.",
      );
      return;
    }
    onRefresh();
  };

  const handleRequestChanges = async () => {
    setPendingAction("requestChanges");
    setActionError(null);
    try {
      const result = await requestChanges({
        environmentId,
        input: { workItemId, reason: undefined },
      });
      if (result._tag === "Success") {
        applyGateOutcome(result.value.ok);
      } else {
        setActionError("The request failed. Refresh and try again.");
      }
    } finally {
      setPendingAction(null);
    }
  };

  const handleApproveMerge = async () => {
    setPendingAction("approveMerge");
    setActionError(null);
    try {
      const result = await approveMerge({ environmentId, input: { workItemId } });
      if (result._tag === "Success") {
        applyGateOutcome(result.value.ok);
      } else {
        setActionError("The request failed. Refresh and try again.");
      }
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section className="rounded-2xl border bg-card px-4 py-4" aria-label="Pull request">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "inline-flex items-center gap-1.5 text-[13px] font-semibold text-foreground",
            pullRequest.url !== undefined && "hover:underline",
          )}
        >
          <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
          PR #{pullRequest.number}
          {pullRequest.url !== undefined ? (
            <ExternalLinkIcon className="size-3 text-muted-foreground" />
          ) : null}
        </a>
        <StatusBadge presentation={statusPresentation} />
      </div>

      <p className="mt-1 truncate text-[12px] text-muted-foreground">{pullRequest.title}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground">{pullRequest.branch}</span>
        <span aria-hidden="true">→</span>
        <span className="font-mono text-foreground">{pullRequest.baseBranch}</span>
      </div>

      {enriched ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border/60 pt-3 sm:grid-cols-3">
          <EnrichmentField label="CI">
            <StatusBadge presentation={ciStatusPresentation(pullRequest.ciStatus)} />
          </EnrichmentField>
          <EnrichmentField label="Review">
            <StatusBadge presentation={reviewStatePresentation(pullRequest.reviewState)} />
          </EnrichmentField>
          <EnrichmentField label="Mergeable">
            <StatusBadge presentation={mergeablePresentation(pullRequest.mergeable)} />
          </EnrichmentField>
          <EnrichmentField label="Comments">
            {pullRequest.unresolvedComments === undefined ? (
              "Unknown"
            ) : pullRequest.unresolvedComments === 0 ? (
              "None unresolved"
            ) : (
              <span className="text-warning-foreground">
                {pullRequest.unresolvedComments} unresolved
              </span>
            )}
          </EnrichmentField>
          <EnrichmentField label="Commit">
            {pullRequest.latestCommit === undefined ? (
              "Unknown"
            ) : (
              <span className="inline-flex items-center gap-1 font-mono">
                <GitCommitHorizontalIcon className="size-3 text-muted-foreground" />
                {pullRequest.latestCommit.slice(0, 7)}
              </span>
            )}
          </EnrichmentField>
        </dl>
      ) : (
        <p className="mt-3 border-t border-border/60 pt-3 text-[11px] italic text-muted-foreground">
          Host enrichment unavailable — merge readiness caps at ready for review.
        </p>
      )}

      {modelReview !== null ? <ModelReviewStrip modelReview={modelReview} /> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => void handleRefresh()}
          disabled={isRefreshing}
          aria-label="Refresh pull request"
        >
          <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          Refresh
        </Button>

        <GatedAction blocked={requestBlockers.length > 0} reasons={requestBlockers}>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => void handleRequestChanges()}
            disabled={requestBlockers.length > 0 || pendingAction !== null}
            aria-label="Request changes"
          >
            {pendingAction === "requestChanges" ? "Requesting…" : "Request changes"}
          </Button>
        </GatedAction>

        <GatedAction blocked={approveBlockers.length > 0} reasons={approveBlockers}>
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2 text-[11px]"
            onClick={() => void handleApproveMerge()}
            disabled={approveBlockers.length > 0 || pendingAction !== null}
            aria-label="Approve merge"
          >
            {pendingAction === "approveMerge" ? "Approving…" : "Approve merge"}
          </Button>
        </GatedAction>
      </div>

      {actionError !== null ? (
        <p className="mt-2 text-[11px] text-destructive-foreground">{actionError}</p>
      ) : null}
    </section>
  );
}
