import { GitPullRequestIcon, ArrowUpRightIcon } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { type RunSummary } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { symphonyEnvironment } from "../state/symphony";
import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";

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

function SymphonyReviewsRoute() {
  const environmentId = usePrimaryEnvironmentId();
  const runs = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyEnvironment.runs({ environmentId, input: { limit: 100 } }),
  );
  const summaries = (runs.data ?? []).filter(
    (run) => run.lifecycle === "ready_for_review" || run.lifecycle === "validation_failed",
  );

  if (runs.isPending && summaries.length === 0) {
    return (
      <div className="space-y-3 p-6 sm:p-8">
        {[0, 1, 2].map((index) => (
          <div key={index} className="rounded-2xl border bg-card p-5">
            <Skeleton className="h-4 w-1/3 rounded-full" />
            <Skeleton className="mt-3 h-3 w-1/2 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (summaries.length === 0) {
    return (
      <SymphonyEmptyState
        icon={GitPullRequestIcon}
        title="No reviews ready"
        description="Runs that reached review-ready state with evidence will appear here."
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="px-6 pb-2 pt-6 sm:px-8">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Reviews</h1>
        <p className="text-xs text-muted-foreground">
          Runs with assembled evidence, ready for human review.
        </p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-6 sm:p-8">
        {summaries.map((run) => (
          <ReviewCard key={run.runAttemptId} run={run} />
        ))}
      </div>
    </div>
  );
}

function ReviewCard({ run }: { readonly run: RunSummary }) {
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
          <Badge variant={run.lifecycle === "ready_for_review" ? "default" : "error"} size="sm">
            {run.lifecycle}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {run.workspacePath !== undefined ? <span>{run.workspacePath}</span> : null}
          {run.model !== undefined ? <span>{run.model}</span> : null}
          <span>Attempt {run.attemptNumber}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {run.lifecycle === "ready_for_review" ? (
          <AssessmentBadge assessment="ready_for_review" />
        ) : (
          <Badge variant="error" size="sm">
            validation failed
          </Badge>
        )}
        <ArrowUpRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </div>
    </Link>
  );
}

export const Route = createFileRoute("/symphony/reviews")({
  component: SymphonyReviewsRoute,
});
