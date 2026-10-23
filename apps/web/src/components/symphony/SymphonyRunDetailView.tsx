import { Link } from "@tanstack/react-router";
import { ActivityIcon, ArrowLeftIcon, RefreshCwIcon, SquareIcon } from "lucide-react";

import { RunAttemptId } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { symphonyEnvironment } from "../../state/symphony";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/utils";
import { PullRequestPanel } from "./PullRequestPanel";
import { SymphonyApprovalActions } from "./SymphonyApprovalActions";
import { SymphonyEmptyState } from "./SymphonyEmptyState";
import { EvidencePanel, Timeline } from "./SymphonyWorkDetail";
import { approvalRequestMode, attentionMode } from "./attention.logic";
import { ACTIVE_RUN_STATUSES } from "./symphonyRuns.logic";

export function SymphonyRunDetailView({ runId }: { readonly runId: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const detail = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyEnvironment.getRun({
          environmentId,
          input: { runAttemptId: RunAttemptId.make(runId) },
        }),
  );
  const cancelRun = useAtomCommand(symphonyEnvironment.cancelRun);
  const details = detail.data ?? null;
  // Pending requests arrive as the attention projection (the run page answers
  // there); the raw approval list carries the decided history.
  const decidedApprovals =
    details === null
      ? []
      : details.approvalRequests.filter((request) => request.state !== "pending");

  const active = details !== null && ACTIVE_RUN_STATUSES.has(details.runAttempt.status);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          {details?.workItem.projectId === undefined ? (
            <Link
              to="/symphony"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"
            >
              <ArrowLeftIcon className="size-3.5" />
              Projects
            </Link>
          ) : (
            <Link
              to="/symphony/projects/$projectId"
              params={{ projectId: details.workItem.projectId }}
              search={{ tab: "work" }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"
            >
              <ArrowLeftIcon className="size-3.5" />
              Work
            </Link>
          )}
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Run {runId}
          </h1>
          <p className="text-xs text-muted-foreground">
            {details === null ? "Loading run details." : details.workItem.objective}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {active ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-3 text-xs"
              onClick={() =>
                environmentId === null
                  ? undefined
                  : void cancelRun({
                      environmentId,
                      input: { runAttemptId: RunAttemptId.make(runId) },
                    })
              }
              aria-label="Cancel run"
            >
              <SquareIcon className="size-3.5" />
              Cancel
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={detail.refresh}
            disabled={detail.isPending}
            aria-label="Refresh run details"
          >
            <RefreshCwIcon className={cn("size-3.5", detail.isPending && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-6 sm:p-8">
        {detail.isPending && details === null ? (
          <div className="rounded-2xl border bg-card p-5">
            <Skeleton className="h-4 w-1/3 rounded-full" />
            <Skeleton className="mt-3 h-3 w-1/2 rounded-full" />
          </div>
        ) : detail.error && detail.data === null ? (
          <SymphonyEmptyState
            icon={ActivityIcon}
            title="Could not load run"
            description={detail.error}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={detail.refresh}
                disabled={detail.isPending}
              >
                <RefreshCwIcon className={cn("size-3.5", detail.isPending && "animate-spin")} />
                Retry
              </Button>
            }
          />
        ) : details === null ? (
          <Empty className="min-h-88 rounded-2xl border bg-card">
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Run not found</EmptyTitle>
              <EmptyDescription>
                No run with id {runId} exists, or the run was cleared.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card px-4 py-3">
              <Badge variant="default" size="sm">
                {details.runAttempt.status}
              </Badge>
              <Badge variant="secondary" size="sm">
                Attempt {details.runAttempt.attemptNumber}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {details.runAttempt.workspacePath}
              </span>
            </div>
            {details.workItem.evidence !== null && details.workItem.evidence !== undefined ? (
              <EvidencePanel evidence={details.workItem.evidence} />
            ) : null}
            {environmentId !== null &&
            details.workItem.evidence !== null &&
            details.workItem.evidence !== undefined &&
            details.workItem.evidence.pullRequest !== null ? (
              <PullRequestPanel
                environmentId={environmentId}
                workItemId={details.workItem.id}
                lifecycle={details.workItem.lifecycle}
                pullRequest={details.workItem.evidence.pullRequest}
                modelReview={details.workItem.evidence.modelReview}
                onRefresh={detail.refresh}
                isRefreshing={detail.isPending}
              />
            ) : null}
            {details.attentionItems.length > 0 ? (
              <div className="rounded-2xl border bg-card px-4 py-3">
                <h2 className="mb-2 text-[12px] font-semibold text-foreground">Waiting for you</h2>
                <ul className="divide-y divide-border/60">
                  {details.attentionItems.map((item) => {
                    const mode = attentionMode(item);
                    return (
                      <li key={item.id} className="space-y-2 py-2.5 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <span className="min-w-0 flex-1 text-xs text-foreground">
                            {item.whatHappened}
                          </span>
                          <Badge variant="warning" size="sm">
                            {item.kind.replaceAll("_", " ")}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground">{item.whyHuman}</p>
                        {mode !== "info" && environmentId !== null ? (
                          <SymphonyApprovalActions
                            environmentId={environmentId}
                            requestId={item.id}
                            mode={mode}
                            onDone={detail.refresh}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {decidedApprovals.length > 0 ? (
              <div className="rounded-2xl border bg-card px-4 py-3">
                <h2 className="mb-2 text-[12px] font-semibold text-foreground">
                  Decided approvals
                </h2>
                <ul className="divide-y divide-border/60">
                  {decidedApprovals.map((request) => {
                    const mode = approvalRequestMode(request);
                    return (
                      <li key={request.id} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[11px] text-muted-foreground">
                            {mode === "question" ? "question" : request.action}
                            {request.command !== undefined ? ` · ${request.command}` : ""}
                          </span>
                          <Badge
                            variant={request.state === "approved" ? "success" : "secondary"}
                            size="sm"
                          >
                            {request.state}
                          </Badge>
                        </div>
                        {mode === "question" && request.reason !== undefined ? (
                          <p className="text-xs text-foreground">{request.reason}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            <Timeline details={details} />
          </>
        )}
      </div>
    </div>
  );
}
