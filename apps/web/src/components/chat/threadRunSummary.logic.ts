import type { ActivePlanState } from "../../session-logic";

type RunThread = {
  readonly title: string;
  readonly goal?: string | null | undefined;
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: { readonly status: string } | null;
};

export type ThreadRunStatus =
  | "working"
  | "connecting"
  | "awaiting-approval"
  | "awaiting-input"
  | "completed"
  | "stopped"
  | "failed";

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
  const status = resolveStatus({
    attention,
    latestTurn,
    sessionStatus: thread.session?.status,
    isWorking: input.isWorking,
  });
  const totalSteps = input.activePlan?.steps.length ?? 0;
  const completedSteps =
    input.activePlan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const endedAt = input.isWorking ? null : (latestTurn?.completedAt ?? null);

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

function resolveStatus(input: {
  readonly attention: ThreadRunSummary["attention"];
  readonly latestTurn: RunThread["latestTurn"];
  readonly sessionStatus: string | undefined;
  readonly isWorking: boolean;
}): ThreadRunStatus {
  if (input.attention === "approval") return "awaiting-approval";
  if (input.attention === "input") return "awaiting-input";
  if (input.sessionStatus === "starting") return "connecting";
  if (
    input.isWorking ||
    input.sessionStatus === "running" ||
    input.latestTurn?.state === "running"
  ) {
    return "working";
  }
  switch (input.latestTurn?.state) {
    case "interrupted":
      return "stopped";
    case "error":
      return "failed";
    case "completed":
      return "completed";
    default:
      return "working";
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
