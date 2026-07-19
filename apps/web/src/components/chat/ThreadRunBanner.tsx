import { CheckIcon, CircleAlertIcon, Clock3Icon, ListTodoIcon, SquareIcon } from "lucide-react";
import type { ActivePlanState } from "../../session-logic";
import type { Thread } from "../../types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { useThreadRunSummary } from "./useThreadRunSummary";

interface ThreadRunBannerProps {
  readonly thread: Thread;
  readonly activePlan: ActivePlanState | null;
  readonly activeWorkStartedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly isWorking: boolean;
  readonly interruptAvailable: boolean;
  readonly activeToolLabel?: string | undefined;
  readonly hasPlanData: boolean;
  readonly onOpenPlan: () => void;
  readonly onInterrupt: () => void;
}

export function ThreadRunBanner(props: ThreadRunBannerProps) {
  const summary = useThreadRunSummary({
    thread: props.thread,
    activePlan: props.activePlan,
    activeWorkStartedAt: props.activeWorkStartedAt,
    hasPendingApprovals: props.hasPendingApprovals,
    hasPendingUserInput: props.hasPendingUserInput,
    isWorking: props.isWorking,
    interruptAvailable: props.interruptAvailable,
    activeToolLabel: props.activeToolLabel,
  });
  if (!summary) return null;

  const isAttention = summary.attention !== null;
  return (
    <section
      aria-label="Thread run progress"
      className={cn(
        "border-b border-border/70 bg-muted/20 px-3 py-2 sm:px-5",
        summary.compact && "bg-transparent py-1.5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full bg-sky-500",
            summary.status === "working" && "animate-pulse",
            summary.status === "completed" && "bg-emerald-500",
            summary.status === "stopped" && "bg-muted-foreground/60",
            summary.status === "failed" && "bg-destructive",
            isAttention && "bg-amber-500",
          )}
        />
        <div className="flex min-w-0 flex-1 items-center gap-x-2 gap-y-0.5 overflow-hidden">
          {summary.compact && summary.status === "completed" ? (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
          ) : isAttention ? (
            <CircleAlertIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate text-xs font-medium",
              summary.compact && "font-normal text-muted-foreground",
            )}
          >
            {summary.title}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{summary.statusLabel}</span>
          {summary.totalSteps > 0 ? (
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
              {summary.completedSteps} of {summary.totalSteps} steps
            </span>
          ) : null}
          {summary.elapsed ? (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
              <Clock3Icon className="size-3" /> {summary.elapsed}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.hasPlanData ? (
            <Button size="xs" variant="ghost" className="gap-1.5" onClick={props.onOpenPlan}>
              <ListTodoIcon className="size-3.5" />
              <span className="max-sm:sr-only">Open plan</span>
            </Button>
          ) : null}
          {summary.interruptAvailable ? (
            <Button size="xs" variant="destructive" className="gap-1.5" onClick={props.onInterrupt}>
              <SquareIcon className="size-3" fill="currentColor" /> Stop
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
