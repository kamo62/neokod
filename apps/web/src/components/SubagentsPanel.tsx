import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { OrchestrationThreadActivity, ScopedThreadRef } from "@neokod/contracts";
import { type TimestampFormat } from "@neokod/contracts/settings";
import {
  CheckIcon,
  EyeIcon,
  LoaderIcon,
  SearchIcon,
  SparklesIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import ChatMarkdown from "./ChatMarkdown";
import { ScrollArea } from "./ui/scroll-area";
import { deriveSubagentCards, formatElapsed, type SubagentCard } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import { deriveToolIconKindFromName, type ToolCallIconKind } from "./chat/ToolCallLabel.logic";

const EMPTY_DISMISSED: ReadonlySet<string> = new Set();

/**
 * Plain-text preview of a progress/summary line for the compact card list,
 * where the clickable card can't host rich markdown (code fences, links). The
 * selected-worker view renders the same text through ChatMarkdown instead, so
 * inline-code commands there show in monospace; here we just drop the backticks.
 */
function toPlainPreview(text: string): string {
  return text.replace(/`+/g, "").trim();
}

export function cleanSubagentProgressLabel(label: string | null | undefined): string {
  return label?.replace(/^(?:Running|Ran)\s+/u, "").trim() || "Working…";
}

function subagentProgressIcon(iconKind: ToolCallIconKind): React.ReactNode {
  const className = "mt-0.5 size-3 shrink-0 text-muted-foreground/50";
  if (iconKind === "terminal") return <TerminalIcon className={className} aria-hidden />;
  if (iconKind === "search") return <SearchIcon className={className} aria-hidden />;
  if (iconKind === "eye") return <EyeIcon className={className} aria-hidden />;
  if (iconKind === "square-pen") return <SquarePenIcon className={className} aria-hidden />;
  if (iconKind === "sparkles") return <SparklesIcon className={className} aria-hidden />;
  return <WrenchIcon className={className} aria-hidden />;
}

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

/** A worker whose provider lifecycle has reached a terminal status. Pure. */
export function isFinishedWorker(card: SubagentCard): boolean {
  return card.status === "completed" || card.status === "failed" || card.status === "stopped";
}

/**
 * An empty terminal worker can be auto-hidden because it gives the user
 * nothing to review. Workers with either streamed progress or a final summary
 * remain visible until the user hides them. Pure.
 */
export function isDismissableEmptyWorker(card: SubagentCard): boolean {
  return isFinishedWorker(card) && card.progress.length === 0 && card.summary === null;
}

/**
 * The workers a user should see: workers persist until manually hidden, except
 * finished workers with no progress or summary. Pure.
 */
export function visibleSubagentCards(
  cards: readonly SubagentCard[],
  dismissed: ReadonlySet<string>,
): SubagentCard[] {
  return cards.filter((card) => !dismissed.has(card.taskId) && !isDismissableEmptyWorker(card));
}

function subagentStatusLabel(status: SubagentCard["status"]): string {
  if (status === "inProgress") return "In progress";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Stopped";
}

export function displayStatus(
  card: SubagentCard,
  turnSettled: boolean,
): { label: string; iconStatus: SubagentCard["status"] } {
  if (card.status === "inProgress" && turnSettled) {
    return { label: "Ended", iconStatus: "stopped" };
  }
  return { label: subagentStatusLabel(card.status), iconStatus: card.status };
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
  threadRef?: ScopedThreadRef | undefined;
  markdownCwd?: string | undefined;
  /** Hidden worker task ids, owned by the parent so they survive remounts. */
  dismissed?: ReadonlySet<string>;
  onDismiss?: (taskId: string) => void;
  turnSettled?: boolean;
  mode?: "sheet" | "sidebar" | "embedded";
}

const SubagentsPanel = memo(function SubagentsPanel({
  activities,
  timestampFormat,
  threadRef,
  markdownCwd,
  dismissed = EMPTY_DISMISSED,
  onDismiss,
  turnSettled = false,
  mode = "sidebar",
}: SubagentsPanelProps) {
  const cards = useMemo(() => deriveSubagentCards(activities), [activities]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const visibleCards = useMemo(() => visibleSubagentCards(cards, dismissed), [cards, dismissed]);
  const selected = resolveSelectedSubagent(visibleCards, selectedTaskId);
  const tabs = useMemo(() => deriveSubagentTabs(visibleCards), [visibleCards]);

  const dismissWorker = (taskId: string) => {
    onDismiss?.(taskId);
    setSelectedTaskId((current) => (current === taskId ? null : current));
  };

  // Auto-follow the selected worker's progress stream.
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const progressCount = selected?.progress.length ?? 0;
  useEffect(() => {
    if (selected) streamEndRef.current?.scrollIntoView({ block: "end" });
  }, [selected, progressCount]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-surface-panel",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-surface-divider"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="right-panel-pane-header justify-between px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            Subagents
          </Badge>
          {visibleCards.length > 0 ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {visibleCards.length}
            </span>
          ) : null}
        </div>
        {selected ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => dismissWorker(selected.taskId)}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Hide
            </button>
            <button
              type="button"
              onClick={() => setSelectedTaskId(null)}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              All workers
            </button>
          </div>
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
            const status = displayStatus(
              visibleCards.find((card) => card.taskId === tab.taskId)!,
              turnSettled,
            );
            return (
              <div key={tab.taskId} className="group relative flex shrink-0 items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-label={tab.hint ? `${tab.label} (${tab.hint})` : tab.label}
                  title={tab.hint ? `${tab.label} · ${tab.hint}` : tab.label}
                  onClick={() =>
                    setSelectedTaskId((current) => (current === tab.taskId ? null : tab.taskId))
                  }
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border py-1 pr-6 pl-2 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    isSelected
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border/50 text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {subagentStatusIcon(status.iconStatus)}
                  <span className="max-w-[120px] truncate">{tab.label}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Hide ${tab.label}`}
                  title="Hide worker"
                  onClick={() => dismissWorker(tab.taskId)}
                  className="absolute top-1/2 right-1 flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
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
              {subagentStatusIcon(displayStatus(selected, turnSettled).iconStatus)}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[13px] font-medium text-foreground/90">
                    {selected.name}
                  </p>
                  <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums">
                    {displayStatus(selected, turnSettled).label} ·{" "}
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
                  <div className="mt-1.5 text-[12px] leading-snug text-muted-foreground/80">
                    <ChatMarkdown
                      text={selected.summary}
                      cwd={markdownCwd}
                      threadRef={threadRef}
                      isStreaming={false}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            {/* Auto-following progress stream */}
            <div className="mt-3 space-y-2 border-l border-border/50 pl-2.5">
              {selected.progress.length > 0 ? (
                selected.progress.map((entry, index) => {
                  const text = cleanSubagentProgressLabel(entry.summary ?? entry.description);
                  return (
                    <div
                      key={`${selected.taskId}:${entry.at}:${entry.lastToolName ?? entry.summary ?? entry.description ?? index}`}
                      className="flex gap-1.5 text-[12px] leading-snug text-muted-foreground/80"
                    >
                      {subagentProgressIcon(deriveToolIconKindFromName(entry.lastToolName))}
                      <div className="min-w-0">
                        <ChatMarkdown
                          text={text}
                          cwd={markdownCwd}
                          threadRef={threadRef}
                          isStreaming={false}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-[11px] text-muted-foreground/40">No progress yet.</p>
              )}
              <div ref={streamEndRef} />
            </div>
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {visibleCards.map((card) => {
              const elapsed = formatElapsed(card.startedAt, card.completedAt ?? undefined);
              const secondary = subagentSecondaryLabel(card);
              const status = displayStatus(card, turnSettled);
              return (
                <div key={card.taskId} className="group relative">
                  <button
                    type="button"
                    onClick={() => setSelectedTaskId(card.taskId)}
                    className={cn(
                      "w-full rounded-lg border border-border/50 bg-background/50 p-3 text-left transition-colors duration-200 hover:border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      status.iconStatus === "inProgress" && "bg-blue-500/5",
                      status.iconStatus === "completed" && "bg-emerald-500/5",
                      status.iconStatus === "failed" && "bg-destructive/5",
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      {subagentStatusIcon(status.iconStatus)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="truncate text-[13px] font-medium text-foreground/90">
                            {card.name}
                          </p>
                          <span className="shrink-0 pr-5 text-[11px] text-muted-foreground/50 tabular-nums">
                            {status.label} ·{" "}
                            {elapsed ?? formatTimestamp(card.startedAt, timestampFormat)}
                          </span>
                        </div>
                        {secondary ? (
                          <p className="truncate text-[11px] text-muted-foreground/60">
                            {secondary}
                          </p>
                        ) : null}
                        {card.summary ? (
                          <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground/80">
                            {toPlainPreview(card.summary)}
                          </p>
                        ) : null}
                        {card.progress.length > 0 ? (
                          <div className="mt-2 space-y-1 border-l border-border/50 pl-2.5">
                            {card.progress.map((entry, index) => (
                              <div
                                key={`${card.taskId}:${entry.at}:${entry.lastToolName ?? entry.summary ?? entry.description ?? index}`}
                                className="flex gap-1.5 text-[11px]"
                              >
                                {subagentProgressIcon(
                                  deriveToolIconKindFromName(entry.lastToolName),
                                )}
                                <p className="min-w-0 leading-snug text-muted-foreground/70">
                                  {toPlainPreview(
                                    cleanSubagentProgressLabel(entry.summary ?? entry.description),
                                  )}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Hide ${card.name}`}
                    title="Hide worker"
                    onClick={() => dismissWorker(card.taskId)}
                    className="absolute top-2 right-2 flex size-5 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              );
            })}

            {/* Empty state */}
            {visibleCards.length === 0 ? (
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
