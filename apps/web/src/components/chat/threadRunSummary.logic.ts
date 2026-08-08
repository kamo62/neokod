import type { OrchestrationSessionStatus } from "@neokod/contracts";
import type { ActivePlanState } from "../../session-logic";
import {
  deriveThreadLifecycle,
  isTerminalThreadLifecycle,
  type ThreadLifecycle,
} from "../threadLifecycle.logic";

type RunThread = {
  readonly title: string;
  readonly goal?: string | null | undefined;
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: { readonly status: OrchestrationSessionStatus } | null;
};

export type ThreadRunStatus =
  | "working"
  | "connecting"
  | "awaiting-approval"
  | "awaiting-input"
  | "completed"
  | "stopped"
  | "failed"
  | "plan-ready"
  | "unknown";

export interface ThreadRunSummary {
  readonly title: string;
  readonly status: ThreadRunStatus;
  readonly statusLabel: string;
  readonly startedAt: string | null;
  readonly elapsed: string | null;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly attention: "approval" | "input" | null;
  readonly interruptAvailable: boolean;
  readonly compact: boolean;
}

export interface ThreadRunSummaryInput {
  readonly thread: RunThread;
  readonly activePlan: ActivePlanState | null;
  readonly activeWorkStartedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly isWorking: boolean;
  readonly interruptAvailable: boolean;
  readonly activeToolLabel?: string | undefined;
  readonly nowMs: number;
}

export function deriveThreadRunSummary(input: ThreadRunSummaryInput): ThreadRunSummary | null {
  const { thread } = input;
  const latestTurn = thread.latestTurn;
  const startedAt =
    input.activeWorkStartedAt ?? latestTurn?.startedAt ?? latestTurn?.requestedAt ?? null;
  if (startedAt === null) return null;

  const attention = input.hasPendingApprovals
    ? "approval"
    : input.hasPendingUserInput
      ? "input"
      : null;
  const lifecycle = deriveThreadLifecycle({
    hasPendingApprovals: input.hasPendingApprovals,
    hasPendingUserInput: input.hasPendingUserInput,
    isWorking: input.isWorking,
    latestTurnState: latestTurn?.state,
    sessionStatus: thread.session?.status,
  });
  const status = runStatusFromLifecycle(lifecycle);
  const totalSteps = input.activePlan?.steps.length ?? 0;
  const completedSteps =
    input.activePlan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const endedAt = isTerminalThreadLifecycle(lifecycle) ? (latestTurn?.completedAt ?? null) : null;

  return {
    title: thread.goal ?? thread.title,
    status,
    statusLabel: statusLabel(status, input.activeToolLabel),
    startedAt,
    elapsed: formatElapsed(startedAt, endedAt, input.nowMs),
    completedSteps,
    totalSteps,
    attention,
    interruptAvailable: input.interruptAvailable,
    compact: attention === null && !input.isWorking && isTerminalStatus(status),
  };
}

function runStatusFromLifecycle(lifecycle: ThreadLifecycle): ThreadRunStatus {
  switch (lifecycle.phase) {
    case "awaiting":
      return lifecycle.reason === "approval" ? "awaiting-approval" : "awaiting-input";
    case "connecting":
      return "connecting";
    case "working":
      return "working";
    case "plan-ready":
      return "plan-ready";
    case "terminal":
      return lifecycle.outcome;
    case "unknown":
      return "unknown";
    default:
      return lifecycle satisfies never;
  }
}

function statusLabel(status: ThreadRunStatus, activeToolLabel: string | undefined): string {
  switch (status) {
    case "awaiting-approval":
      return "Pending approval";
    case "awaiting-input":
      return "Awaiting input";
    case "connecting":
      return "Connecting";
    case "completed":
      return "Completed";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "plan-ready":
      return "Plan ready";
    case "unknown":
      return "Status unavailable";
    default:
      return activeToolLabel ? `Working · ${activeToolLabel}` : "Working";
  }
}

function isTerminalStatus(status: ThreadRunStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

function formatElapsed(startedAt: string, endedAt: string | null, nowMs: number): string | null {
  const startMs = Date.parse(startedAt);
  const endMs = endedAt ? Date.parse(endedAt) : nowMs;
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  const seconds = Math.floor((endMs - startMs) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) {
    return remainderSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainderSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
}
