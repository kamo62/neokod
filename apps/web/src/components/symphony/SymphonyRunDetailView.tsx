import { ActivityIcon, RefreshCwIcon, SquareIcon } from "lucide-react";

import { RunAttemptId, type EvidenceBundle, type RunDetails } from "@neokod/contracts";
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
import { SymphonyEmptyState } from "./SymphonyEmptyState";

const RUNNING_STATUSES = new Set([
  "preparing_workspace",
  "initializing_session",
  "launching_agent",
  "building_prompt",
  "streaming_turn",
  "finishing",
]);

function Timeline({ details }: { readonly details: RunDetails }) {
  return (
    <div className="rounded-2xl border bg-card">
      {details.timeline.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No events recorded yet.
        </div>
      ) : (
        <ol className="divide-y divide-border/60">
          {details.timeline.map((event) => (
            <li key={event.sequence} className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
              <ActivityIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-foreground">{event.eventType}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleTimeString()}
                  </span>
                </div>
                {event.payload !== undefined && Object.keys(event.payload).length > 0 ? (
                  <pre className="max-h-24 overflow-y-auto rounded-md bg-muted/50 p-2 text-[10px] leading-relaxed text-muted-foreground">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EvidencePanel({ evidence }: { readonly evidence: EvidenceBundle }) {
  const assessmentVariant =
    evidence.overallAssessment === "ready_for_review"
      ? "success"
      : evidence.overallAssessment === "ready_with_warnings"
        ? "warning"
        : evidence.overallAssessment === "failed"
          ? "error"
          : "secondary";
  return (
    <div className="rounded-2xl border bg-card px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-[12px] font-semibold text-foreground">Evidence</h2>
        <Badge variant={assessmentVariant} size="sm">
          {evidence.overallAssessment}
        </Badge>
      </div>

      {evidence.implementationSummary !== undefined ? (
        <p className="mb-3 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
          {evidence.implementationSummary}
        </p>
      ) : null}

      {evidence.changedFiles.length > 0 ? (
        <div className="mb-3">
          <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">Changed files</h3>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Path</th>
                <th className="py-1 pr-3 text-right font-medium">+</th>
                <th className="py-1 text-right font-medium">-</th>
              </tr>
            </thead>
            <tbody>
              {evidence.changedFiles.map((file) => (
                <tr key={file.path} className="border-b border-border/40 last:border-0">
                  <td className="py-1 pr-3 font-mono text-foreground">{file.path}</td>
                  <td className="py-1 pr-3 text-right text-emerald-600">{file.additions ?? 0}</td>
                  <td className="py-1 text-right text-red-500">{file.deletions ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {evidence.validationResults.length > 0 ? (
        <div>
          <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">Validation</h3>
          <ul className="space-y-1">
            {evidence.validationResults.map((result) => (
              <li key={result.command} className="flex items-center gap-2">
                <Badge
                  variant={
                    result.status === "passed"
                      ? "success"
                      : result.status === "failed"
                        ? "error"
                        : "secondary"
                  }
                  size="sm"
                >
                  {result.status}
                </Badge>
                <code className="truncate font-mono text-[11px] text-muted-foreground">
                  {result.command}
                </code>
                {result.durationMs !== undefined ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {(result.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

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

  const active = details !== null && RUNNING_STATUSES.has(details.runAttempt.status);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
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
            {details.approvalRequests.length > 0 ? (
              <div className="rounded-2xl border bg-card px-4 py-3">
                <h2 className="mb-2 text-[12px] font-semibold text-foreground">Approvals</h2>
                <ul className="space-y-1.5">
                  {details.approvalRequests.map((request) => (
                    <li key={request.id} className="flex items-center justify-between gap-3">
                      <span className="text-[11px] text-muted-foreground">
                        {request.action}
                        {request.command !== undefined ? ` · ${request.command}` : ""}
                      </span>
                      <Badge
                        variant={
                          request.state === "pending"
                            ? "warning"
                            : request.state === "approved"
                              ? "success"
                              : "secondary"
                        }
                        size="sm"
                      >
                        {request.state}
                      </Badge>
                    </li>
                  ))}
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
