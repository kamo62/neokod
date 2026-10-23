import { AlertTriangleIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import type { WorkFilter } from "./symphonyProjectTabs";

export type WorkRowTone = "error" | "info" | "secondary" | "success" | "warning";

export type WorkCountState = "known" | "observed" | "unknown" | "unavailable";

export interface SymphonyWorkCount {
  readonly value: number;
  readonly state: WorkCountState;
}

/**
 * Presentation-only row. Lifecycle, attention membership, actions and
 * coverage are resolved by the shared work projection; this component must not
 * re-derive them.
 */
export interface SymphonyWorkRow {
  readonly workItemId: string;
  readonly trackerIdentifier?: string;
  readonly title: string;
  readonly lifecycleLabel: string;
  readonly lifecycleTone: WorkRowTone;
  readonly needsAttention: boolean;
  readonly attentionLabel?: string;
  readonly repositoryPath?: string;
  readonly machineLabel?: string;
  readonly providerLabel?: string;
  readonly attemptLabel?: string;
  readonly unknownNote?: string;
  readonly latestRunAttemptId?: string;
}

export interface SymphonyWorkCounts {
  readonly all: SymphonyWorkCount;
  readonly notStarted: SymphonyWorkCount;
  readonly inProgress: SymphonyWorkCount;
  readonly attention: SymphonyWorkCount;
}

export const EMPTY_WORK_COUNTS: SymphonyWorkCounts = {
  all: { value: 0, state: "unknown" },
  notStarted: { value: 0, state: "unknown" },
  inProgress: { value: 0, state: "unknown" },
  attention: { value: 0, state: "unknown" },
};

const FILTERS: ReadonlyArray<{ readonly value: WorkFilter; readonly label: string }> = [
  { value: "all", label: "All current" },
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "attention", label: "Needs your attention" },
];

const countFor = (counts: SymphonyWorkCounts, filter: WorkFilter): SymphonyWorkCount => {
  switch (filter) {
    case "all":
      return counts.all;
    case "not_started":
      return counts.notStarted;
    case "in_progress":
      return counts.inProgress;
    case "attention":
      return counts.attention;
  }
};

const countLabel = (count: SymphonyWorkCount): string => {
  switch (count.state) {
    case "known":
      return String(count.value);
    case "observed":
      return `${count.value}+`;
    case "unknown":
    case "unavailable":
      return "—";
  }
};

const countTitle = (count: SymphonyWorkCount): string | undefined => {
  switch (count.state) {
    case "known":
      return undefined;
    case "observed":
      return "At least this many; coverage is incomplete.";
    case "unknown":
      return "Count not reported because evidence is incomplete.";
    case "unavailable":
      return "Count unavailable because the read failed.";
  }
};

function WorkRow({
  row,
  selected,
  onSelect,
}: {
  readonly row: SymphonyWorkRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full items-start gap-3 px-5 py-3.5 text-left outline-none transition-colors",
        "hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected && "bg-muted/45",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {row.trackerIdentifier === undefined ? null : (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {row.trackerIdentifier}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-snug text-foreground">
            {row.title}
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <Badge variant={row.lifecycleTone} size="sm">
            {row.lifecycleLabel}
          </Badge>
          {row.needsAttention ? (
            <span className="inline-flex items-center gap-1 font-medium text-warning-foreground">
              <AlertTriangleIcon className="size-3" aria-hidden="true" />
              {row.attentionLabel ?? "Needs your attention"}
            </span>
          ) : null}
          {row.attemptLabel === undefined ? null : <span>{row.attemptLabel}</span>}
          {row.providerLabel === undefined ? null : <span>{row.providerLabel}</span>}
          {row.repositoryPath === undefined ? null : (
            <span className="max-w-[26rem] truncate font-mono">{row.repositoryPath}</span>
          )}
          {row.machineLabel === undefined ? null : <span>{row.machineLabel}</span>}
        </span>
        {row.unknownNote === undefined ? null : (
          <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground/85">
            {row.unknownNote}
          </span>
        )}
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground/45 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
      />
    </button>
  );
}

export function SymphonyWorkList({
  filter,
  counts,
  rows,
  selectedWorkItemId,
  onFilterChange,
  onSelect,
  loading,
  error,
  coverageNote,
  emptyTitle,
  emptyDescription,
  showFilters = true,
  footer,
  onRefresh,
}: {
  readonly filter: WorkFilter;
  readonly counts: SymphonyWorkCounts;
  readonly rows: ReadonlyArray<SymphonyWorkRow>;
  readonly selectedWorkItemId: string | null;
  readonly onFilterChange: (filter: WorkFilter) => void;
  readonly onSelect: (row: SymphonyWorkRow) => void;
  readonly loading: boolean;
  readonly error: string | null;
  readonly coverageNote: string | null;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly showFilters?: boolean;
  readonly footer?: ReactNode;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-6 py-3 sm:px-8">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
          {showFilters ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter work">
              {FILTERS.map((item) => {
                const active = filter === item.value;
                const count = countFor(counts, item.value);
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${item.label}: ${countLabel(count)}`}
                    title={countTitle(count)}
                    onClick={() => onFilterChange(item.value)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] outline-none",
                      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      active
                        ? "bg-surface-selected font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    {item.label}
                    <span
                      className={cn(
                        "tabular-nums",
                        active ? "text-muted-foreground" : "text-muted-foreground/70",
                      )}
                    >
                      {countLabel(count)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[12px] font-medium text-foreground">Finished work</p>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              <RefreshCwIcon className="size-3.5" />
              Refresh
            </Button>
          </span>
        </div>
        {showFilters ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground/80">
            Attention overlaps the lifecycle filters. A filter only changes what this list shows.
          </p>
        ) : null}
        {coverageNote === null ? null : (
          <p className="mt-1 text-[11px] text-muted-foreground/80">{coverageNote}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 sm:px-8">
        {error !== null ? (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
            <p>
              {rows.length === 0
                ? `No work is shown because the latest read failed or has not completed. ${error}`
                : `Live updates stopped. Showing the last received work. ${error}`}
            </p>
            <Button size="sm" variant="outline" onClick={onRefresh}>
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : null}

        {loading && rows.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
          </div>
        ) : rows.length === 0 && error === null ? (
          <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
            <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
              {emptyDescription}
            </p>
          </div>
        ) : rows.length === 0 ? null : (
          <div className="divide-y overflow-hidden rounded-2xl border bg-card">
            {rows.map((row) => (
              <WorkRow
                key={row.workItemId}
                row={row}
                selected={row.workItemId === selectedWorkItemId}
                onSelect={() => onSelect(row)}
              />
            ))}
          </div>
        )}
        {footer}
      </div>
    </div>
  );
}
