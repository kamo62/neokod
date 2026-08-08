import * as Schema from "effect/Schema";
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
  UnplugIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { deriveSubagentCards } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import ChatMarkdown from "./ChatMarkdown";
import {
  cleanSubagentProgressLabel,
  deriveSubagentTabs,
  formatSubagentUsage,
  resolveSelectedSubagent,
  resolveSubagentCards,
  subagentSecondaryLabel,
  visibleSubagentCards,
  type ResolvedSubagentCard,
  type SubagentIconStatus,
} from "./SubagentsPanel.logic";
import { deriveToolIconKindFromName, type ToolCallIconKind } from "./chat/ToolCallLabel.logic";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

const EMPTY_DISMISSED: ReadonlySet<string> = new Set();
const SUBAGENT_DENSITY_STORAGE_KEY = "neokod:subagent-card-density:v1";
const SubagentCardDensitySchema = Schema.Literals(["compact", "expanded"]);
type SubagentCardDensity = typeof SubagentCardDensitySchema.Type;

function toPlainPreview(text: string): string {
  return text.replace(/`+/g, "").trim();
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

function subagentStatusIcon(status: SubagentIconStatus): React.ReactNode {
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
  if (status === "orphaned") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning-foreground">
        <UnplugIcon className="size-3" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/50" />
    </span>
  );
}

function timingLabel(card: ResolvedSubagentCard, timestampFormat: TimestampFormat): string {
  const { timing } = card.lifecycle;
  if (timing.elapsed !== null) {
    return card.lifecycle.phase === "orphaned" ? `Observed ${timing.elapsed}` : timing.elapsed;
  }
  const fallback =
    timing.kind === "exact"
      ? timing.endedAt
      : timing.kind === "last-observed"
        ? timing.observedAt
        : timing.startedAt;
  return formatTimestamp(fallback, timestampFormat);
}

interface SubagentsPanelProps {
  activities: readonly OrchestrationThreadActivity[];
  timestampFormat: TimestampFormat;
  threadRef?: ScopedThreadRef | undefined;
  markdownCwd?: string | undefined;
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
  const visibleCards = useMemo(() => visibleSubagentCards(cards, dismissed), [cards, dismissed]);
  const [density, setDensity] = useLocalStorage<SubagentCardDensity, SubagentCardDensity>(
    SUBAGENT_DENSITY_STORAGE_KEY,
    "expanded",
    SubagentCardDensitySchema,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const resolvedCards = useMemo(
    () => resolveSubagentCards(visibleCards, { nowMs, turnSettled }),
    [nowMs, turnSettled, visibleCards],
  );
  const selected = resolveSelectedSubagent(resolvedCards, selectedTaskId);
  const tabs = useMemo(() => deriveSubagentTabs(visibleCards), [visibleCards]);
  const labelsByTaskId = useMemo(
    () => new Map(tabs.map((tab) => [tab.taskId, tab] as const)),
    [tabs],
  );
  const timerActive = resolvedCards.some((card) => card.lifecycle.phase === "active");

  useEffect(() => {
    setNowMs(Date.now());
    if (!timerActive) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timerActive]);

  useEffect(() => {
    if (density !== "expanded" || resolvedCards.length === 0) return;
    if (!resolvedCards.some((card) => card.taskId === selectedTaskId)) {
      setSelectedTaskId(resolvedCards[0]?.taskId ?? null);
    }
  }, [density, resolvedCards, selectedTaskId]);

  const dismissWorker = (taskId: string) => {
    onDismiss?.(taskId);
    setSelectedTaskId((current) => (current === taskId ? null : current));
  };

  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const progressCount = selected?.progress.length ?? 0;
  useEffect(() => {
    if (density === "expanded" && selected) {
      streamEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [density, selected, progressCount]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-surface-panel",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-surface-divider"
          : "h-full w-full",
      )}
    >
      <div className="right-panel-pane-header justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            Subagents
          </Badge>
          {resolvedCards.length > 0 ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {resolvedCards.length}
            </span>
          ) : null}
        </div>
        <ToggleGroup
          aria-label="Subagent card density"
          className="shrink-0"
          variant="outline"
          size="xs"
          value={[density]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "compact" || next === "expanded") setDensity(next);
          }}
        >
          <Toggle value="compact" aria-label="Compact subagent cards">
            Compact
          </Toggle>
          <Toggle value="expanded" aria-label="Expanded subagent cards">
            Expanded
          </Toggle>
        </ToggleGroup>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("p-2.5", density === "compact" ? "space-y-1" : "space-y-1.5")}>
          {resolvedCards.map((card) => {
            const tab = labelsByTaskId.get(card.taskId);
            const isSelected = card.taskId === selected?.taskId;
            const secondary = subagentSecondaryLabel(card);
            return (
              <div key={card.taskId} className="group relative">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedTaskId(card.taskId)}
                  className={cn(
                    "relative grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-lg border border-border/50 bg-background/45 pr-8 text-left transition-colors hover:border-border hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    density === "compact" ? "px-2 py-1.5" : "px-2.5 py-2",
                    isSelected && "border-primary/40 bg-primary/7",
                  )}
                >
                  {subagentStatusIcon(card.lifecycle.iconStatus)}
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-foreground/90">
                      {tab?.label ?? card.name}
                    </span>
                    {density === "expanded" && secondary ? (
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/55">
                        {secondary}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-right text-[10px] leading-tight tabular-nums">
                    <span className="block text-muted-foreground/80">{card.lifecycle.label}</span>
                    <span className="mt-0.5 block text-muted-foreground/50">
                      {timingLabel(card, timestampFormat)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Hide ${tab?.label ?? card.name}`}
                  onClick={() => dismissWorker(card.taskId)}
                  className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/45 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            );
          })}

          {density === "expanded" && selected ? (
            <section className="mt-2 rounded-xl border border-border/60 bg-background/55 p-3">
              <div className="flex items-start gap-2.5">
                {subagentStatusIcon(selected.lifecycle.iconStatus)}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-[13px] font-medium text-foreground/95">
                        {labelsByTaskId.get(selected.taskId)?.label ?? selected.name}
                      </h3>
                      {subagentSecondaryLabel(selected) ? (
                        <p className="truncate text-[10px] text-muted-foreground/55">
                          {subagentSecondaryLabel(selected)}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-right text-[10px] text-muted-foreground/60 tabular-nums">
                      {selected.lifecycle.label} · {timingLabel(selected, timestampFormat)}
                    </span>
                  </div>

                  {selected.lifecycle.phase === "orphaned" ? (
                    <div className="mt-2 rounded-lg border border-warning/25 bg-warning/5 px-2.5 py-2">
                      <p className="text-[9px] font-semibold tracking-wide text-warning-foreground uppercase">
                        Tracking lost
                      </p>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">
                        This worker may still be running outside the parent session.
                      </p>
                    </div>
                  ) : selected.currentActivity ? (
                    <div className="mt-2 rounded-lg border border-border/50 bg-muted/25 px-2.5 py-2">
                      <p className="text-[9px] font-semibold tracking-wide text-muted-foreground/55 uppercase">
                        Working on
                      </p>
                      <p className="mt-1 text-[11px] leading-snug text-foreground/85">
                        {toPlainPreview(cleanSubagentProgressLabel(selected.currentActivity))}
                      </p>
                    </div>
                  ) : null}

                  {selected.summary ? (
                    <div className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
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

              <div className="mt-3 space-y-2 border-l border-border/60 pl-3">
                {selected.progress.length > 0 ? (
                  selected.progress.map((entry, index) => {
                    const text = cleanSubagentProgressLabel(entry.summary ?? entry.description);
                    return (
                      <div
                        key={`${selected.taskId}:${entry.at}:${entry.lastToolName ?? entry.summary ?? entry.description ?? index}`}
                        className="relative flex gap-1.5 text-[11px] leading-snug text-muted-foreground/75 before:absolute before:top-1.5 before:-left-[15px] before:size-1.5 before:rounded-full before:border before:border-muted-foreground/50 before:bg-surface-panel"
                      >
                        {subagentProgressIcon(deriveToolIconKindFromName(entry.lastToolName))}
                        <div className="min-w-0 flex-1">
                          <ChatMarkdown
                            text={text}
                            cwd={markdownCwd}
                            threadRef={threadRef}
                            isStreaming={false}
                          />
                        </div>
                        <span className="shrink-0 text-[9px] text-muted-foreground/40 tabular-nums">
                          {formatTimestamp(entry.at, timestampFormat)}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-[10px] text-muted-foreground/40">No progress events yet.</p>
                )}
                <div ref={streamEndRef} />
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2 text-[10px] text-muted-foreground/55 tabular-nums">
                <span>
                  {formatSubagentUsage(selected.usage)
                    ? `Σ ${formatSubagentUsage(selected.usage)}`
                    : "Usage unavailable"}
                </span>
                <span>
                  {selected.progress.length} {selected.progress.length === 1 ? "update" : "updates"}
                </span>
              </div>
            </section>
          ) : null}

          {resolvedCards.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/45">No subagents yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/35">
                Subagent activity will appear here when delegated work starts.
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
