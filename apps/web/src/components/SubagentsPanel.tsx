import { memo, useMemo } from "react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { CheckIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { deriveSubagentCards, formatElapsed, type SubagentCard } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";

function subagentStatusIcon(status: SubagentCard["status"]): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlertIcon className="size-3" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

interface SubagentsPanelProps {
  activities: readonly OrchestrationThreadActivity[];
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar" | "embedded";
}

const SubagentsPanel = memo(function SubagentsPanel({
  activities,
  timestampFormat,
  mode = "sidebar",
}: SubagentsPanelProps) {
  const cards = useMemo(() => deriveSubagentCards(activities), [activities]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            Subagents
          </Badge>
          {cards.length > 0 ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {cards.length}
            </span>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {cards.map((card) => {
            const elapsed = formatElapsed(card.startedAt, card.completedAt ?? undefined);
            return (
              <div
                key={card.taskId}
                className={cn(
                  "rounded-lg border border-border/50 bg-background/50 p-3 transition-colors duration-200",
                  card.status === "inProgress" && "bg-blue-500/5",
                  card.status === "completed" && "bg-emerald-500/5",
                  card.status === "failed" && "bg-destructive/5",
                )}
              >
                <div className="flex items-start gap-2.5">
                  {subagentStatusIcon(card.status)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-[13px] font-medium text-foreground/90">
                        {card.name}
                      </p>
                      <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums">
                        {elapsed ?? formatTimestamp(card.startedAt, timestampFormat)}
                      </span>
                    </div>
                    {card.model ? (
                      <p className="truncate text-[11px] text-muted-foreground/60">{card.model}</p>
                    ) : null}
                    {card.summary ? (
                      <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground/80">
                        {card.summary}
                      </p>
                    ) : null}
                    {card.progress.length > 0 ? (
                      <div className="mt-2 space-y-1 border-l border-border/50 pl-2.5">
                        {card.progress.map((entry, index) => (
                          <div key={`${card.taskId}:${index}`} className="text-[11px]">
                            <p className="leading-snug text-muted-foreground/70">
                              {entry.summary ?? entry.description ?? "Working…"}
                            </p>
                            {entry.lastToolName ? (
                              <p className="text-[10px] text-muted-foreground/40">
                                {entry.lastToolName}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Empty state */}
          {cards.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No subagents yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Sub-agent activity will appear here when tasks run.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default SubagentsPanel;
export type { SubagentsPanelProps };
