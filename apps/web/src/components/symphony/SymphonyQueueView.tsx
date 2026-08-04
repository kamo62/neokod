import { ListTodoIcon, RefreshCwIcon } from "lucide-react";

import type { EnvironmentId, QueueItem } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { symphonyEnvironment } from "../../state/symphony";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/utils";

const LIFECYCLE_LABELS: Record<string, string> = {
  queued: "Queued",
  eligible: "Not eligible",
};

const LIFECYCLE_BADGE: Record<string, "default" | "secondary" | "success" | "warning" | "info"> = {
  queued: "success",
  eligible: "secondary",
};

function QueueRow({
  item,
  environmentId,
}: {
  readonly item: QueueItem;
  readonly environmentId: EnvironmentId;
}) {
  const lifecycleLabel = LIFECYCLE_LABELS[item.lifecycle] ?? item.lifecycle;
  const badgeVariant = LIFECYCLE_BADGE[item.lifecycle] ?? "secondary";

  const excludeWorkItem = useAtomCommand(symphonyEnvironment.excludeWorkItem);
  const includeWorkItem = useAtomCommand(symphonyEnvironment.includeWorkItem);
  const setLocalPriority = useAtomCommand(symphonyEnvironment.setLocalPriority);

  const toggleExcluded = () => {
    const target = { environmentId, input: { workItemId: item.workItemId } };
    if (item.excluded) {
      void includeWorkItem(target);
    } else {
      void excludeWorkItem({ ...target, input: { workItemId: item.workItemId, exclude: true } });
    }
  };

  const cyclePriority = () => {
    const next = item.priority === undefined || item.priority >= 4 ? 0 : item.priority + 1;
    void setLocalPriority({
      environmentId,
      input: { workItemId: item.workItemId, priority: next },
    });
  };

  return (
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {item.title}
            </span>
            {item.trackerIdentifier ? (
              <code className="text-xs text-muted-foreground">{item.trackerIdentifier}</code>
            ) : null}
            <Badge variant={badgeVariant} size="sm">
              {lifecycleLabel}
            </Badge>
            {item.excluded ? (
              <Badge variant="warning" size="sm">
                Excluded
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground/80">
            {item.repositoryPath ?? "Unknown repository"}
            {item.priority !== undefined ? ` · priority ${item.priority}` : ""}
          </p>
          {item.ineligibilityReasons.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {item.ineligibilityReasons.join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Badge variant={item.blocked ? "warning" : "success"} size="sm">
            {item.blocked ? "Blocked" : "Dispatchable"}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={cyclePriority}
            aria-label="Cycle local priority"
            title="Cycle local priority (0-4); persisted and survives restart"
          >
            P{item.priority ?? "–"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={toggleExcluded}
            aria-label={item.excluded ? "Include in queue" : "Exclude from queue"}
            title={
              item.excluded ? "Include this item again" : "Exclude this item; survives restart"
            }
          >
            {item.excluded ? "Include" : "Exclude"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function QueueSkeleton() {
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

export function SymphonyQueueView() {
  const environmentId = usePrimaryEnvironmentId();
  const queue = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.queue({ environmentId, input: {} }),
  );
  const items = queue.data ?? [];
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Queue</h1>
          <p className="text-xs text-muted-foreground">
            Eligible tracker work awaiting dispatch. Observe mode never dispatches.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={queue.refresh}
          disabled={queue.isPending}
          aria-label="Refresh queue"
        >
          <RefreshCwIcon className={cn("size-3.5", queue.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {queue.isPending && items.length === 0 ? (
          <div className="rounded-2xl border bg-card">
            <QueueSkeleton />
          </div>
        ) : items.length === 0 ? (
          <Empty className="min-h-88 rounded-2xl border bg-card">
            <EmptyMedia variant="icon">
              <ListTodoIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No work in the queue</EmptyTitle>
              <EmptyDescription>
                Eligible issues will appear here once a Symphony tracker is connected and an active
                workflow is polling.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-2xl border bg-card">
            {environmentId === null
              ? null
              : items.map((item) => (
                  <QueueRow key={item.workItemId} item={item} environmentId={environmentId} />
                ))}
          </div>
        )}
      </div>
    </div>
  );
}
