import type { SymphonyOverviewMetric } from "@neokod/contracts";

import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { symphonyEnvironment } from "../../state/symphony";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { SymphonyEmptyState } from "./SymphonyEmptyState";
import {
  resolveSymphonyOverviewMetric,
  resolveSymphonyOverviewViewState,
} from "./SymphonyOverviewView.logic";

function MetricTile({
  label,
  metric,
}: {
  readonly label: string;
  readonly metric: SymphonyOverviewMetric;
}) {
  const resolved = resolveSymphonyOverviewMetric(metric);
  return (
    <div
      className="rounded-2xl border bg-card p-4"
      title={resolved.state === "unavailable" ? resolved.reason : undefined}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 font-semibold tracking-[-0.02em]",
          resolved.state === "known" ? "text-2xl text-foreground" : "text-sm text-muted-foreground",
        )}
      >
        {resolved.label}
      </p>
    </div>
  );
}

function ActiveWorkflowCount({ metric }: { readonly metric: SymphonyOverviewMetric }) {
  const resolved = resolveSymphonyOverviewMetric(metric);
  if (resolved.state === "unavailable") {
    return <span title={resolved.reason}>Active workflows unavailable</span>;
  }
  return (
    <span>
      {resolved.value} active {resolved.value === 1 ? "workflow" : "workflows"}
    </span>
  );
}

function TrackerHealthRow({
  kind,
  ok,
  lastPollAt,
}: {
  readonly kind: string;
  readonly ok: boolean;
  readonly lastPollAt: string | null;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", ok ? "bg-success" : "bg-warning")} aria-hidden />
        <span className="text-[13px] font-medium text-foreground capitalize">{kind}</span>
      </div>
      <span className="text-xs text-muted-foreground">
        {ok ? "Healthy" : "Unhealthy"}
        {lastPollAt ? ` · last poll ${new Date(lastPollAt).toLocaleTimeString()}` : ""}
      </span>
    </div>
  );
}

function OverviewSkeleton() {
  const rows = ["one", "two", "three"] as const;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {rows.map((row) => (
        <div key={row} className="rounded-2xl border bg-card p-4">
          <Skeleton className="h-3 w-16 rounded-full" />
          <Skeleton className="mt-2 h-7 w-10 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function SymphonyOverviewView() {
  const environmentId = usePrimaryEnvironmentId();
  const overviewQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.overview({ environmentId, input: {} }),
  );
  const viewState = resolveSymphonyOverviewViewState({
    hasEnvironment: environmentId !== null,
    data: overviewQuery.data,
    isPending: overviewQuery.isPending,
    error: overviewQuery.error,
  });
  const headerDescription =
    viewState.phase === "ready"
      ? viewState.overview.orchestratorPaused === null
        ? "Symphony pause status is unavailable."
        : viewState.overview.orchestratorPaused
          ? "Dispatch is paused."
          : "Symphony is watching for eligible work."
      : viewState.phase === "loading"
        ? "Loading Symphony overview data."
        : "Symphony overview data is unavailable.";

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Overview</h1>
          <p className="text-xs text-muted-foreground">{headerDescription}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={overviewQuery.refresh}
          disabled={overviewQuery.isPending || environmentId === null}
          aria-label="Refresh overview"
        >
          <RefreshCwIcon className={cn("size-3.5", overviewQuery.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {viewState.phase === "loading" ? (
          <OverviewSkeleton />
        ) : viewState.phase === "unavailable" ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Overview unavailable"
            description={viewState.message}
            action={
              environmentId === null ? undefined : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={overviewQuery.refresh}
                  disabled={overviewQuery.isPending}
                >
                  <RefreshCwIcon
                    className={cn("size-3.5", overviewQuery.isPending && "animate-spin")}
                  />
                  Retry
                </Button>
              )
            }
          />
        ) : (
          <div className="space-y-6">
            {viewState.refreshError ? (
              <div
                role="status"
                className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning-foreground"
              >
                Showing the last known overview because refresh failed: {viewState.refreshError}
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-3">
              <MetricTile label="Queued" metric={viewState.overview.queued} />
              <MetricTile label="Running" metric={viewState.overview.running} />
              <MetricTile label="Needs Attention" metric={viewState.overview.needsAttention} />
            </div>

            <div className="rounded-2xl border bg-card">
              <div className="flex items-center justify-between px-4 pt-4 sm:px-5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                  Tracker health
                </h2>
                <span className="text-xs text-muted-foreground">
                  <ActiveWorkflowCount metric={viewState.overview.activeWorkflowCount} />
                </span>
              </div>
              {Object.keys(viewState.overview.trackerHealth).length === 0 ? (
                <p className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                  No trackers polled yet. Enable a tracker in Settings, add a WORKFLOW.md, and
                  activate it.
                </p>
              ) : (
                Object.entries(viewState.overview.trackerHealth).map(([kind, health]) => (
                  <TrackerHealthRow
                    key={kind}
                    kind={kind}
                    ok={health.ok}
                    lastPollAt={health.lastPollAt}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
