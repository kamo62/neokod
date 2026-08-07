import { GitPullRequestIcon, HistoryIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import type { RunSummary } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { symphonyExtras } from "../../state/symphonyExtras";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/utils";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

/**
 * Run attempt statuses that mean the attempt is over (mirrors the
 * server's RUN_TERMINAL_STATUSES in SymphonyOrchestratorLive.ts). History
 * only makes sense for finished attempts, since "finished time" is derived
 * from `startedAt + elapsedMs`.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
  "user_cancelled",
  "tracker_cancelled",
  "process_failed",
  "validation_failed",
  "workflow_error",
  "provider_error",
  "interrupted",
  "retries_exhausted",
]);

const OUTCOME_BADGE: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "error" | "info"
> = {
  succeeded: "success",
  failed: "error",
  timed_out: "warning",
  stalled: "warning",
  canceled_by_reconciliation: "secondary",
  user_cancelled: "secondary",
  tracker_cancelled: "secondary",
  process_failed: "error",
  validation_failed: "error",
  workflow_error: "error",
  provider_error: "error",
  interrupted: "warning",
  retries_exhausted: "error",
};

// Mirrors symphony.reviews.tsx's PrBadge rendering so the same pullRequest
// value reads identically wherever a run summary appears.
function PrBadge({
  pullRequest,
}: {
  readonly pullRequest: NonNullable<RunSummary["pullRequest"]>;
}) {
  const { number, url, status } = pullRequest;
  const variant =
    status === "open"
      ? "success"
      : status === "merged"
        ? "info"
        : status === "closed"
          ? "error"
          : "secondary";
  return (
    <Badge
      variant={variant}
      size="sm"
      render={
        url === undefined ? (
          <span />
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              window.open(url, "_blank", "noopener,noreferrer");
            }}
            aria-label={`Open PR #${number}`}
          />
        )
      }
    >
      <GitPullRequestIcon />#{number}
    </Badge>
  );
}

// Mirrors symphony.reviews.tsx's AssessmentBadge rendering so the same
// overallAssessment value reads identically wherever a run summary appears.
function AssessmentBadge({ assessment }: { readonly assessment: string }) {
  const variant =
    assessment === "ready_for_review"
      ? "success"
      : assessment === "ready_with_warnings"
        ? "warning"
        : assessment === "failed"
          ? "error"
          : "secondary";
  return (
    <Badge variant={variant} size="sm">
      {assessment}
    </Badge>
  );
}

function formatFinishedAt(run: RunSummary): string {
  if (run.elapsedMs === undefined) return "unknown";
  const finishedAtMs = Date.parse(run.startedAt) + run.elapsedMs;
  return Number.isNaN(finishedAtMs) ? "unknown" : new Date(finishedAtMs).toLocaleString();
}

function HistoryCard({ run }: { readonly run: RunSummary }) {
  return (
    <Link
      to="/symphony/$runId"
      params={{ runId: run.runAttemptId }}
      className="group flex items-center gap-4 rounded-2xl border bg-card p-4 transition-colors hover:border-border hover:bg-muted/40"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {run.issueTitle ?? "Untitled run"}
          </span>
          {run.trackerIdentifier !== undefined ? (
            <Badge variant="secondary" size="sm">
              {run.trackerIdentifier}
            </Badge>
          ) : null}
          <Badge variant={OUTCOME_BADGE[run.status] ?? "secondary"} size="sm">
            {run.status}
          </Badge>
          {run.pullRequest !== undefined ? <PrBadge pullRequest={run.pullRequest} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {run.repositoryPath !== undefined ? <span>{run.repositoryPath}</span> : null}
          <span>Finished {formatFinishedAt(run)}</span>
        </div>
      </div>
      {run.overallAssessment !== undefined ? (
        <AssessmentBadge assessment={run.overallAssessment} />
      ) : null}
    </Link>
  );
}

function HistorySkeleton() {
  return (
    <>
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-2xl border bg-card p-5">
          <Skeleton className="h-4 w-1/3 rounded-full" />
          <Skeleton className="mt-3 h-3 w-1/2 rounded-full" />
        </div>
      ))}
    </>
  );
}

export function SymphonyHistoryView() {
  const environmentId = usePrimaryEnvironmentId();
  const history = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyExtras.history({ environmentId, input: { limit: 100 } }),
  );
  const runs = (history.data ?? [])
    .filter((run) => TERMINAL_RUN_STATUSES.has(run.status))
    .sort((a, b) => {
      const finishedA =
        a.elapsedMs === undefined ? Date.parse(a.startedAt) : Date.parse(a.startedAt) + a.elapsedMs;
      const finishedB =
        b.elapsedMs === undefined ? Date.parse(b.startedAt) : Date.parse(b.startedAt) + b.elapsedMs;
      return finishedB - finishedA;
    });

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">History</h1>
          <p className="text-xs text-muted-foreground">
            Completed and failed Symphony runs, newest first.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={history.refresh}
          disabled={history.isPending}
          aria-label="Refresh history"
        >
          <RefreshCwIcon className={cn("size-3.5", history.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-6 sm:p-8">
        {history.isPending && history.data === null ? (
          <HistorySkeleton />
        ) : history.error && history.data === null ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Could not load history"
            description={history.error}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={history.refresh}
                disabled={history.isPending}
              >
                <RefreshCwIcon className={cn("size-3.5", history.isPending && "animate-spin")} />
                Retry
              </Button>
            }
          />
        ) : runs.length === 0 ? (
          <Empty className="min-h-88 rounded-2xl border bg-card">
            <EmptyMedia variant="icon">
              <HistoryIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No run history yet</EmptyTitle>
              <EmptyDescription>
                Completed and failed Symphony runs will appear here once the mode has activity.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          runs.map((run) => <HistoryCard key={run.runAttemptId} run={run} />)
        )}
      </div>
    </div>
  );
}
