import { RefreshCwIcon, TagsIcon, TriangleAlertIcon } from "lucide-react";

import type { TrackerHealth, TrackerKind } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { symphonyExtras } from "../../state/symphonyExtras";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/utils";
import {
  AsanaIcon,
  AzureDevOpsIcon,
  GitHubIcon,
  GitHubProjectsIcon,
  GitLabIcon,
  JiraIcon,
  LinearIcon,
  type Icon,
} from "../Icons";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

const TRACKER_KIND_ICONS: Record<TrackerKind, Icon> = {
  github: GitHubIcon,
  jira: JiraIcon,
  linear: LinearIcon,
  gitlab: GitLabIcon,
  azure_boards: AzureDevOpsIcon,
  asana: AsanaIcon,
  github_projects: GitHubProjectsIcon,
};

function TrackerRow({ tracker }: { readonly tracker: TrackerHealth }) {
  const KindIcon = TRACKER_KIND_ICONS[tracker.kind];
  return (
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={cn("size-2 rounded-full", tracker.ok ? "bg-success" : "bg-warning")}
              aria-hidden
            />
            <KindIcon className="size-4 text-foreground/80" />
            <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground capitalize">
              {tracker.kind.replace(/_/g, " ")}
            </span>
            <Badge variant={tracker.ok ? "success" : "warning"} size="sm">
              {tracker.ok ? "Healthy" : "Unhealthy"}
            </Badge>
          </div>
          {tracker.error !== null ? (
            <p className="text-[11px] text-warning">{tracker.error}</p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <span className="text-xs text-muted-foreground">
            {tracker.lastPollAt !== null
              ? `Last poll ${new Date(tracker.lastPollAt).toLocaleString()}`
              : "Not polled yet"}
          </span>
        </div>
      </div>
    </div>
  );
}

function TrackersSkeleton() {
  const rows = ["one", "two", "three"] as const;
  return (
    <>
      {rows.map((row) => (
        <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3 rounded-full" />
            <Skeleton className="h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </>
  );
}

export function SymphonyTrackersView() {
  const environmentId = usePrimaryEnvironmentId();
  const trackers = useEnvironmentQuery(
    environmentId === null ? null : symphonyExtras.trackers({ environmentId, input: {} }),
  );
  const items = trackers.data ?? [];

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Trackers</h1>
          <p className="text-xs text-muted-foreground">
            Connection health for every tracker a Symphony workflow polls.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={trackers.refresh}
          disabled={trackers.isPending}
          aria-label="Refresh trackers"
        >
          <RefreshCwIcon className={cn("size-3.5", trackers.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {trackers.isPending && trackers.data === null ? (
          <div className="rounded-2xl border bg-card">
            <TrackersSkeleton />
          </div>
        ) : trackers.error && trackers.data === null ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Could not load trackers"
            description={trackers.error}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={trackers.refresh}
                disabled={trackers.isPending}
              >
                <RefreshCwIcon className={cn("size-3.5", trackers.isPending && "animate-spin")} />
                Retry
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <Empty className="min-h-88 rounded-2xl border bg-card">
            <EmptyMedia variant="icon">
              <TagsIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No trackers connected</EmptyTitle>
              <EmptyDescription>
                No trackers polled yet. Add a WORKFLOW.md to a tracked repository and activate it to
                connect a tracker.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-2xl border bg-card">
            {items.map((tracker) => (
              <TrackerRow key={tracker.kind} tracker={tracker} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
