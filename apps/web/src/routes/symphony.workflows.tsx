import { RefreshCwIcon, TriangleAlertIcon, WorkflowIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { symphonyEnvironment } from "../state/symphony";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

const STATUS_BADGE: Record<string, "default" | "secondary" | "success" | "warning" | "info"> = {
  active: "success",
  paused: "warning",
  invalid: "secondary",
  draft: "secondary",
};

function WorkflowSkeleton() {
  const rows = ["one", "two"] as const;
  return (
    <div className="rounded-2xl border bg-card">
      {rows.map((row) => (
        <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3 rounded-full" />
            <Skeleton className="h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SymphonyWorkflowsRoute() {
  const environmentId = usePrimaryEnvironmentId();
  const workflowsQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.workflows({ environmentId, input: {} }),
  );
  const workflows = workflowsQuery.data ?? [];

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Workflows
          </h1>
          <p className="text-xs text-muted-foreground">
            Active WORKFLOW.md definitions per repository.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={workflowsQuery.refresh}
          disabled={workflowsQuery.isPending}
          aria-label="Refresh workflows"
        >
          <RefreshCwIcon className={cn("size-3.5", workflowsQuery.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {workflowsQuery.isPending && workflowsQuery.data === null ? (
          <WorkflowSkeleton />
        ) : workflowsQuery.error && workflowsQuery.data === null ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Could not load workflows"
            description={workflowsQuery.error}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={workflowsQuery.refresh}
                disabled={workflowsQuery.isPending}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", workflowsQuery.isPending && "animate-spin")}
                />
                Retry
              </Button>
            }
          />
        ) : workflows.length === 0 ? (
          <Empty className="min-h-88 rounded-2xl border bg-card">
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No workflows configured</EmptyTitle>
              <EmptyDescription>
                Add a WORKFLOW.md to a tracked repository to define a Symphony workflow. It appears
                here once the server discovers it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-4">
            {workflows.map((workflow) => (
              <div key={workflow.id} className="rounded-2xl border bg-card px-4 py-3.5 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <code className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                        {workflow.workflowPath}
                      </code>
                      <Badge variant={STATUS_BADGE[workflow.status] ?? "secondary"} size="sm">
                        {workflow.status}
                      </Badge>
                      <Badge variant="outline" size="sm">
                        {workflow.autonomy}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground/80">
                      {workflow.repositoryPath}
                    </p>
                    {workflow.validationError ? (
                      <p className="text-[11px] text-warning">{workflow.validationError}</p>
                    ) : null}
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                    <span className="text-xs text-muted-foreground">
                      {workflow.effectiveConfig?.trackerKind ?? "no tracker"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/symphony/workflows")({
  component: SymphonyWorkflowsRoute,
});
