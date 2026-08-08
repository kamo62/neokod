import type { OrchestrationLatestTurn, OrchestrationSessionStatus } from "@neokod/contracts";

export type ThreadLifecycle =
  | { readonly phase: "awaiting"; readonly reason: "approval" | "input" }
  | { readonly phase: "connecting" }
  | { readonly phase: "working" }
  | { readonly phase: "plan-ready" }
  | {
      readonly phase: "terminal";
      readonly outcome: "completed" | "failed" | "stopped";
    }
  | { readonly phase: "unknown" };

export interface ThreadLifecycleFacts {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly isWorking?: boolean | undefined;
  readonly latestTurnState?: OrchestrationLatestTurn["state"] | null | undefined;
  readonly planReady?: boolean | undefined;
  readonly sessionStatus?: OrchestrationSessionStatus | null | undefined;
}

export function deriveThreadLifecycle(facts: ThreadLifecycleFacts): ThreadLifecycle {
  if (facts.hasPendingApprovals) {
    return { phase: "awaiting", reason: "approval" };
  }
  if (facts.hasPendingUserInput) {
    return { phase: "awaiting", reason: "input" };
  }
  if (facts.sessionStatus === "starting") {
    return { phase: "connecting" };
  }
  if (
    facts.isWorking === true ||
    facts.sessionStatus === "running" ||
    facts.latestTurnState === "running"
  ) {
    return { phase: "working" };
  }
  if (facts.planReady === true) {
    return { phase: "plan-ready" };
  }
  if (facts.latestTurnState === "error" || facts.sessionStatus === "error") {
    return { phase: "terminal", outcome: "failed" };
  }
  if (
    facts.latestTurnState === "interrupted" ||
    facts.sessionStatus === "interrupted" ||
    facts.sessionStatus === "stopped"
  ) {
    return { phase: "terminal", outcome: "stopped" };
  }
  if (facts.latestTurnState === "completed") {
    return { phase: "terminal", outcome: "completed" };
  }
  return { phase: "unknown" };
}

export function isTerminalThreadLifecycle(
  lifecycle: ThreadLifecycle,
): lifecycle is Extract<ThreadLifecycle, { readonly phase: "terminal" }> {
  return lifecycle.phase === "terminal";
}
