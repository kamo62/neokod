import { Link } from "@tanstack/react-router";
import { ActivityIcon, ArrowLeftIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { RunAttemptId } from "@neokod/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { symphonyEnvironment } from "../../state/symphony";
import { projectSymphonyWorkItem, type SymphonyWorkAttemptFact } from "../../symphonyWork.logic";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/utils";
import { PullRequestPanel } from "./PullRequestPanel";
import { SymphonyEmptyState } from "./SymphonyEmptyState";
import {
  ApprovalRequestHistoryList,
  AttemptAttribution,
  AttemptOutcomeBadge,
  EvidencePanel,
  RequestActions,
  stopAcknowledgementNote,
  Timeline,
  workLifecyclePresentation,
} from "./SymphonyWorkDetail";
import { runAttemptStatusBadgeVariant } from "./runAttemptStatus.logic";

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
  const cancelRun = useAtomCommand(symphonyEnvironment.cancelRun, { reportFailure: false });
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const details = detail.data ?? null;

  // The opened attempt is explicit history here. It is not promoted to
  // "current" without an authoritative latest-attempt id.
  const projected = useMemo(() => {
    if (environmentId === null || details === null) return null;
    const attempt = details.runAttempt;
    const fact: SymphonyWorkAttemptFact = {
      runAttemptId: attempt.id,
      workItemId: attempt.workItemId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      provider: attempt.provider,
      ...(attempt.model === undefined ? {} : { model: attempt.model }),
    };
    const closures: Array<{
      workItemId: typeof details.workItem.id;
      runAttemptId?: typeof attempt.id;
      observedAt: string;
      source: string;
    }> = [];
    if (detail.error === null && attempt.stopClosure !== undefined) {
      closures.push({
        workItemId: details.workItem.id,
        runAttemptId: attempt.stopClosure.runAttemptId,
        observedAt: attempt.stopClosure.observedAt,
        source: attempt.stopClosure.source,
      });
    }
    if (detail.error === null && details.workItem.stopClosure !== undefined) {
      closures.push({
        workItemId: details.workItem.id,
        runAttemptId: details.workItem.stopClosure.runAttemptId,
        observedAt: details.workItem.stopClosure.observedAt,
        source: details.workItem.stopClosure.source,
      });
    }
    return projectSymphonyWorkItem({
      environmentId,
      workItemId: details.workItem.id,
      ...(details.workItem.projectId === undefined
        ? {}
        : { projectId: details.workItem.projectId }),
      workItem: {
        state: "known",
        value: details.workItem,
        ...(detail.error === null ? {} : { staleReason: detail.error }),
      },
      runs: {
        state: "known",
        value: {
          runs: [fact],
          coverage: {
            state: "bounded",
            reason:
              "Only the exact run attempt is loaded; older and newer attempts are not included.",
          },
        },
        ...(detail.error === null ? {} : { staleReason: detail.error }),
      },
      attention: {
        state: "known",
        value: {
          items: details.attentionItems,
          coverage: {
            state: "unknown",
            reason:
              "Only pending requests for this attempt are loaded; some read failures are returned as an empty list.",
          },
        },
        ...(detail.error === null ? {} : { staleReason: detail.error }),
      },
      ...(closures.length === 0 ? {} : { closures }),
    });
  }, [details, detail.error, environmentId]);

  const lifecycle = projected === null ? null : workLifecyclePresentation(projected);
  const cancelAction = projected?.actions.find((action) => action.kind === "cancel") ?? null;
  const attentionEntries =
    projected !== null && projected.attention.state === "needs_attention"
      ? projected.attention.items
      : [];

  const requestCancel = async () => {
    if (environmentId === null || cancelAction?.runAttemptId === undefined || cancelPending) {
      return;
    }
    setCancelPending(true);
    setCancelNote(null);
    try {
      const result = await cancelRun({
        environmentId,
        input: { runAttemptId: cancelAction.runAttemptId },
      });
      if (result._tag === "Success") {
        setCancelNote(stopAcknowledgementNote(result.value, cancelAction.runAttemptId));
      } else if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setCancelNote(
          `Stop acknowledgement unknown. The attempt may still be running; check the exact run before requesting another stop.${
            cause instanceof Error ? ` ${cause.message}` : ""
          }`,
        );
      }
    } finally {
      setCancelPending(false);
      detail.refresh();
    }
  };

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
          {cancelAction === null ? null : (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-3 text-xs"
              onClick={() => void requestCancel()}
              disabled={cancelAction.state !== "available" || cancelPending}
              title={cancelAction.reason}
              aria-label="Cancel run"
            >
              <SquareIcon className="size-3.5" />
              {cancelPending ? "Requesting stop" : "Cancel"}
            </Button>
          )}
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

      {cancelAction !== null && cancelAction.state !== "available" ? (
        <p className="px-6 pb-2 text-[11px] text-muted-foreground sm:px-8">{cancelAction.reason}</p>
      ) : null}
      {cancelNote === null ? null : (
        <div className="mx-6 mb-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] text-foreground sm:mx-8">
          {cancelNote}
        </div>
      )}

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
              <Badge variant={lifecycle?.tone ?? "secondary"} size="sm">
                {lifecycle?.label ?? "Lifecycle unknown"}
              </Badge>
              <Badge variant={runAttemptStatusBadgeVariant(details.runAttempt.status)} size="sm">
                Attempt: {details.runAttempt.status}
              </Badge>
              {projected?.attempts.history[0] === undefined ? null : (
                <AttemptOutcomeBadge outcome={projected.attempts.history[0].outcome} />
              )}
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
            {projected !== null && projected.attention.state !== "needs_attention" ? (
              <p className="rounded-2xl border bg-card px-4 py-3 text-[11px] text-muted-foreground">
                {projected.attention.state === "unknown" ||
                projected.attention.state === "unavailable"
                  ? projected.attention.reason
                  : "No open request is loaded for this attempt."}
              </p>
            ) : null}
            {attentionEntries.length > 0 ? (
              <div className="rounded-2xl border bg-card px-4 py-3">
                <h2 className="mb-2 text-[12px] font-semibold text-foreground">Waiting for you</h2>
                <ul className="divide-y divide-border/60">
                  {attentionEntries.map((entry) => (
                    <li key={entry.item.id} className="space-y-2 py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 flex-1 text-xs text-foreground">
                          {entry.item.whatHappened}
                        </span>
                        <Badge variant="warning" size="sm">
                          {entry.item.kind.replaceAll("_", " ")}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{entry.item.whyHuman}</p>
                      <AttemptAttribution attempt={details.runAttempt} />
                      {environmentId === null ? null : (
                        <RequestActions
                          environmentId={environmentId}
                          entry={entry}
                          request={
                            details.approvalRequests.find(
                              (request) => String(request.id) === String(entry.item.id),
                            ) ?? null
                          }
                          {...(projected === null ? {} : { actions: projected.actions })}
                          onRefresh={detail.refresh}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ApprovalRequestHistoryList requests={details.approvalRequests} />
            <Timeline details={details} />
          </>
        )}
      </div>
    </div>
  );
}
