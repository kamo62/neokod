import {
  CheckCircle2Icon,
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
function approveMergeBlockers(
  pullRequest: PullRequestEvidence,
  lifecycle: WorkItem["lifecycle"],
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
  if ((pullRequest.unresolvedComments ?? 0) > 0) {
    const count = pullRequest.unresolvedComments ?? 0;
    reasons.push(`${count} unresolved comment${count === 1 ? "" : "s"}`);
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

export interface PullRequestPanelProps {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId;
  readonly lifecycle: WorkItem["lifecycle"];
  readonly pullRequest: PullRequestEvidence;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}

export function PullRequestPanel({
  environmentId,
  workItemId,
  lifecycle,
  pullRequest,
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
  const approveBlockers = approveMergeBlockers(pullRequest, lifecycle);
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
