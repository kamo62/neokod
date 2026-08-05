import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import type { AttentionItem, EnvironmentId } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { symphonyEnvironment } from "../../state/symphony";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/utils";

const SEVERITY_BADGE: Record<string, "default" | "secondary" | "success" | "warning" | "info"> = {
  critical: "warning",
  high: "warning",
  medium: "info",
  low: "secondary",
};

function AttentionRow({
  item,
  environmentId,
}: {
  readonly item: AttentionItem;
  readonly environmentId: EnvironmentId;
}) {
  const approve = useAtomCommand(symphonyEnvironment.approve);
  const reject = useAtomCommand(symphonyEnvironment.reject);

  const resolve = (decision: "approve" | "reject") => {
    if (decision === "approve") {
      void approve({
        environmentId,
        input: {
          requestId: item.id,
          scope: item.kind === "merge_approval" ? "current_run" : "once",
        },
      });
    } else {
      void reject({ environmentId, input: { requestId: item.id, reason: "Rejected by user" } });
    }
  };

  return (
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {item.whatHappened}
            </span>
            <Badge variant={SEVERITY_BADGE[item.severity] ?? "secondary"} size="sm">
              {item.severity}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground/80">{item.whyHuman}</p>
          {item.recommendedResponse ? (
            <p className="text-[11px] text-muted-foreground">{item.recommendedResponse}</p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {item.availableActions.includes("approve") ? (
            <Button
              size="sm"
              variant="default"
              className="h-7 px-2 text-[11px]"
              onClick={() => resolve("approve")}
              aria-label="Approve request"
            >
              Approve
            </Button>
          ) : null}
          {item.availableActions.includes("reject") ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => resolve("reject")}
              aria-label="Reject request"
            >
              Reject
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AttentionSkeleton() {
  const rows = ["one", "two", "three"] as const;
  return (
    <>
      {rows.map((row) => (
        <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3 rounded-full" />
            <Skeleton className="h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </>
  );
}

export function SymphonyAttentionView() {
  const environmentId = usePrimaryEnvironmentId();
  const attention = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.attention({ environmentId, input: {} }),
  );
  const items = attention.data ?? [];
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Needs attention
          </h1>
          <p className="text-xs text-muted-foreground">
            Approvals and blocked runs that require a human decision.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={attention.refresh}
          disabled={attention.isPending}
          aria-label="Refresh attention items"
        >
          <RefreshCwIcon className={cn("size-3.5", attention.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {attention.isPending && items.length === 0 ? (
          <div className="rounded-2xl border bg-card">
            <AttentionSkeleton />
          </div>
        ) : items.length === 0 ? (
          <Empty className="min-h-88 rounded-2xl border bg-card">
            <EmptyMedia variant="icon">
              <TriangleAlertIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Nothing needs your attention</EmptyTitle>
              <EmptyDescription>
                Approvals and blocked runs will appear here when a human action is needed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-2xl border bg-card">
            {environmentId === null
              ? null
              : items.map((item) => (
                  <AttentionRow key={item.id} item={item} environmentId={environmentId} />
                ))}
          </div>
        )}
      </div>
    </div>
  );
}
