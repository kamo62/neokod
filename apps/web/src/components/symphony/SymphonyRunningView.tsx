import { PlayCircleIcon, RefreshCwIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import type { EnvironmentId, RunSummary } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { symphonyEnvironment } from "../../state/symphony";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/utils";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

const STATUS_BADGE: Record<string, "default" | "secondary" | "success" | "warning" | "info"> = {
  running: "success",
  queued: "info",
  failed: "warning",
  succeeded: "secondary",
};

const RUNNING_STATUSES = new Set([
  "preparing_workspace",
  "initializing_session",
  "launching_agent",
  "building_prompt",
  "streaming_turn",
  "finishing",
]);

function RunningRow({
  run,
  environmentId,
}: {
  readonly run: RunSummary;
  readonly environmentId: EnvironmentId;
}) {
  const cancelRun = useAtomCommand(symphonyEnvironment.cancelRun);
  const active = RUNNING_STATUSES.has(run.status);

  return (
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/symphony/$runId"
          params={{ runId: run.runAttemptId }}
          className="min-w-0 flex-1 space-y-1"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {run.issueTitle ?? run.workItemId}
            </span>
            <Badge variant={STATUS_BADGE[run.lifecycle] ?? "secondary"} size="sm">
              {run.status}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground/80">
            Attempt {run.attemptNumber}
            {run.model !== undefined ? ` · ${run.model}` : ""}
            {run.elapsedMs !== undefined ? ` · ${Math.round(run.elapsedMs / 1000)}s` : ""}
          </p>
        </Link>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {active ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() =>
                void cancelRun({ environmentId, input: { runAttemptId: run.runAttemptId } })
              }
              aria-label="Cancel run"
            >
              <SquareIcon className="size-3" />
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RunningSkeleton() {
  const rows = ["one", "two", "three"] as const;
  return (
    <>
      {rows.map((row) => (
        <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2 rounded-full" />
            <Skeleton className="h-3 w-1/3 rounded-full" />
          </div>
        </div>
      ))}
    </>
  );
}

export function SymphonyRunningView() {
  const environmentId = usePrimaryEnvironmentId();
  const runs = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.runs({ environmentId, input: {} }),
  );
  const items = runs.data ?? [];
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Running</h1>
          <p className="text-xs text-muted-foreground">
            Active and recent Symphony runs, with their live timeline.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={runs.refresh}
          disabled={runs.isPending}
          aria-label="Refresh runs"
        >
          <RefreshCwIcon className={cn("size-3.5", runs.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {runs.isPending && runs.data === null ? (
          <div className="rounded-2xl border bg-card">
            <RunningSkeleton />
          </div>
        ) : runs.error && runs.data === null ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Could not load running threads"
            description={runs.error}
            action={
              <Button size="sm" variant="outline" onClick={runs.refresh} disabled={runs.isPending}>
                <RefreshCwIcon className={cn("size-3.5", runs.isPending && "animate-spin")} />
                Retry
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <Empty className="min-h-88 rounded-2xl border bg-card">
            <EmptyMedia variant="icon">
              <PlayCircleIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Nothing is running</EmptyTitle>
              <EmptyDescription>
                Active Symphony runs will appear here when work is dispatched.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-2xl border bg-card">
            {environmentId === null
              ? null
              : items.map((run) => (
                  <RunningRow key={run.runAttemptId} run={run} environmentId={environmentId} />
                ))}
          </div>
        )}
      </div>
    </div>
  );
}
