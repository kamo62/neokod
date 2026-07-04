import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { CheckIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { deriveSubagentCards, formatElapsed, type SubagentCard } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";

/**
 * Secondary label under a worker's name: the model when the provider knows it
 * (Copilot/Codex), otherwise the worker kind (the Claude case), otherwise
 * nothing.
 */
export function subagentSecondaryLabel(card: SubagentCard): string | null {
  return card.model ?? card.kind;
}

export interface SubagentTab {
  taskId: string;
  /** Display label, disambiguated with `#n` when worker names collide. */
  label: string;
  /** Secondary label (model or kind), shown as a tooltip/subtext. */
  hint: string | null;
  status: SubagentCard["status"];
}

/**
 * One tab per worker card, in start order. Labels are disambiguated with a
 * `#n` suffix when multiple workers share the same name, so tabs are never
 * visually identical. Pure.
 */
export function deriveSubagentTabs(cards: readonly SubagentCard[]): SubagentTab[] {
  const nameCounts = new Map<string, number>();
  for (const card of cards) {
    nameCounts.set(card.name, (nameCounts.get(card.name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return cards.map((card) => {
    const hint = subagentSecondaryLabel(card);
    let label = card.name;
    if ((nameCounts.get(card.name) ?? 0) > 1) {
      const n = (seen.get(card.name) ?? 0) + 1;
      seen.set(card.name, n);
      label = `${card.name} #${n}`;
    }
    return { taskId: card.taskId, label, hint, status: card.status };
  });
}

/**
 * Resolve the selected worker from the current cards. Returns null (the card
 * list view) when nothing is selected or the selected worker is unknown. Pure.
 */
export function resolveSelectedSubagent(
  cards: readonly SubagentCard[],
  selectedTaskId: string | null,
): SubagentCard | null {
  if (selectedTaskId === null) return null;
  return cards.find((card) => card.taskId === selectedTaskId) ?? null;
}

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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selected = resolveSelectedSubagent(cards, selectedTaskId);
  const tabs = useMemo(() => deriveSubagentTabs(cards), [cards]);

  // Auto-follow the selected worker's progress stream.
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const progressCount = selected?.progress.length ?? 0;
  useEffect(() => {
    if (selected) streamEndRef.current?.scrollIntoView({ block: "end" });
  }, [selected, progressCount]);

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
        {selected ? (
          <button
            type="button"
            onClick={() => setSelectedTaskId(null)}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            All workers
          </button>
        ) : null}
      </div>

      {/* Worker tab strip */}
      {tabs.length > 0 ? (
        <div
          role="tablist"
          aria-label="Sub-agent workers"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-2 py-1.5"
        >
          {tabs.map((tab) => {
            const isSelected = tab.taskId === selectedTaskId;
            return (
              <button
                key={tab.taskId}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-label={tab.hint ? `${tab.label} (${tab.hint})` : tab.label}
                title={tab.hint ? `${tab.label} · ${tab.hint}` : tab.label}
                onClick={() =>
                  setSelectedTaskId((current) => (current === tab.taskId ? null : tab.taskId))
                }
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  isSelected
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border/50 text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {subagentStatusIcon(tab.status)}
                <span className="max-w-[120px] truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        {selected ? (
          <div className="flex flex-col p-3">
            {/* Selected worker header */}
            <div className="flex items-start gap-2.5">
              {subagentStatusIcon(selected.status)}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[13px] font-medium text-foreground/90">
                    {selected.name}
                  </p>
                  <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums">
                    {formatElapsed(selected.startedAt, selected.completedAt ?? undefined) ??
                      formatTimestamp(selected.startedAt, timestampFormat)}
                  </span>
                </div>
                {subagentSecondaryLabel(selected) ? (
                  <p className="truncate text-[11px] text-muted-foreground/60">
                    {subagentSecondaryLabel(selected)}
                  </p>
                ) : null}
                {selected.summary ? (
                  <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground/80">
                    {selected.summary}
                  </p>
                ) : null}
              </div>
            </div>

            {/* Auto-following progress stream */}
            <div className="mt-3 space-y-1.5 border-l border-border/50 pl-2.5">
              {selected.progress.length > 0 ? (
                selected.progress.map((entry, index) => (
                  <div
                    key={`${selected.taskId}:${entry.at}:${entry.lastToolName ?? entry.summary ?? entry.description ?? index}`}
                    className="text-[11px]"
                  >
                    <p className="leading-snug text-muted-foreground/80">
                      {entry.summary ?? entry.description ?? "Working…"}
                    </p>
                    {entry.lastToolName ? (
                      <p className="text-[10px] text-muted-foreground/40">{entry.lastToolName}</p>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-[11px] text-muted-foreground/40">No progress yet.</p>
              )}
              <div ref={streamEndRef} />
            </div>
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {cards.map((card) => {
              const elapsed = formatElapsed(card.startedAt, card.completedAt ?? undefined);
              const secondary = subagentSecondaryLabel(card);
              return (
                <button
                  type="button"
                  key={card.taskId}
                  onClick={() => setSelectedTaskId(card.taskId)}
                  className={cn(
                    "w-full rounded-lg border border-border/50 bg-background/50 p-3 text-left transition-colors duration-200 hover:border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
                      {secondary ? (
                        <p className="truncate text-[11px] text-muted-foreground/60">{secondary}</p>
                      ) : null}
                      {card.summary ? (
                        <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground/80">
                          {card.summary}
                        </p>
                      ) : null}
                      {card.progress.length > 0 ? (
                        <div className="mt-2 space-y-1 border-l border-border/50 pl-2.5">
                          {card.progress.map((entry, index) => (
                            <div
                              key={`${card.taskId}:${entry.at}:${entry.lastToolName ?? entry.summary ?? entry.description ?? index}`}
                              className="text-[11px]"
                            >
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
                </button>
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
        )}
      </ScrollArea>
    </div>
  );
});

export default SubagentsPanel;
export type { SubagentsPanelProps };
