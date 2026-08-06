import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import type { SymphonyOverview } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { symphonyEnvironment } from "../../state/symphony";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

function MetricTile({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">{value}</p>
    </div>
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

const EMPTY_OVERVIEW: SymphonyOverview = {
  running: 0,
  queued: 0,
  needsAttention: 0,
  readyForReview: 0,
  retrying: 0,
  failedToday: 0,
  orchestratorPaused: false,
  activeWorkflowCount: 0,
  providerHealth: {},
  trackerHealth: {},
  lastTrackerPollAt: null,
  activeAgentCount: 0,
  generatedAt: new Date().toISOString(),
};

export function SymphonyOverviewView() {
  const environmentId = usePrimaryEnvironmentId();
  const overviewQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.overview({ environmentId, input: {} }),
  );
  const overview = overviewQuery.data ?? EMPTY_OVERVIEW;
  const trackerHealth = Object.entries(overview.trackerHealth);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Overview</h1>
          <p className="text-xs text-muted-foreground">
            {overview.orchestratorPaused
              ? "Dispatch is paused."
              : "Symphony is watching for eligible work."}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={overviewQuery.refresh}
          disabled={overviewQuery.isPending}
          aria-label="Refresh overview"
        >
          <RefreshCwIcon className={cn("size-3.5", overviewQuery.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {overviewQuery.isPending && overviewQuery.data === null ? (
          <OverviewSkeleton />
        ) : overviewQuery.error && overviewQuery.data === null ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Could not load overview"
            description={overviewQuery.error}
            action={
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
            }
          />
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <MetricTile label="Queued" value={overview.queued} />
              <MetricTile label="Running" value={overview.running} />
              <MetricTile label="Needs Attention" value={overview.needsAttention} />
            </div>

            <div className="rounded-2xl border bg-card">
              <div className="flex items-center justify-between px-4 pt-4 sm:px-5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                  Tracker health
                </h2>
                <span className="text-xs text-muted-foreground">
                  {overview.activeWorkflowCount} active{" "}
                  {overview.activeWorkflowCount === 1 ? "workflow" : "workflows"}
                </span>
              </div>
              {trackerHealth.length === 0 ? (
                <p className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                  No trackers polled yet. Enable a tracker in Settings, add a WORKFLOW.md, and
                  activate it.
                </p>
              ) : (
                trackerHealth.map(([kind, health]) => (
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
