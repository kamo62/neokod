import type {
  OrchestrationLatestTurn,
  OrchestrationLatestTurnOutcome,
  OrchestrationSessionStatus,
} from "@neokod/contracts";

/**
 * Durable turn state seen by a projection. `pending` belongs to the SQL turn
 * projection before a turn id exists; the other values match the shared
 * latest-turn contract.
 */
export type TurnProjectionState = OrchestrationLatestTurn["state"] | "pending";

export interface TurnProjectionIdentity {
  readonly turnId: string | null;
  readonly state: TurnProjectionState;
}

export function isTerminalTurnState(
  state: TurnProjectionState,
): state is OrchestrationLatestTurnOutcome {
  return state === "completed" || state === "interrupted" || state === "error";
}

/**
 * Legacy settlement inference for session updates without an explicit
 * provider outcome. Callers that persist every turn may still restrict this to
 * turns that are currently running.
 */
export function resolveSettledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): OrchestrationLatestTurnOutcome | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

/**
 * Provider-authoritative outcome for the turn named by `targetTurnId`.
 *
 * The outcome only applies to its pinned turn. It settles a running turn, and
 * an authoritative interrupted/error outcome may correct an inferred
 * completed state when a final message settled the turn first. A different
 * terminal state is never reopened by a later explicit outcome.
 */
export function resolveExplicitSettledTurnState(input: {
  readonly outcome: OrchestrationLatestTurnOutcome;
  readonly targetTurnId: string | undefined;
  readonly turn: TurnProjectionIdentity | null;
}): OrchestrationLatestTurnOutcome | null {
  const turn = input.turn;
  if (input.targetTurnId === undefined || turn === null || turn.turnId !== input.targetTurnId) {
    return null;
  }
  if (turn.state === "running") {
    return input.outcome;
  }
  if (turn.state === "completed" && input.outcome !== "completed") {
    return input.outcome;
  }
  if (turn.state === input.outcome && input.outcome !== "completed") {
    return input.outcome;
  }
  return null;
}

/**
 * Resolve the settled state for one turn. With no explicit outcome this keeps
 * the legacy session-status inference; with one it applies the provider
 * outcome only to the pinned turn.
 */
export function resolveSettledTurnState(input: {
  readonly sessionStatus: OrchestrationSessionStatus;
  readonly outcome: OrchestrationLatestTurnOutcome | undefined;
  readonly targetTurnId: string | undefined;
  readonly turn: TurnProjectionIdentity | null;
}): OrchestrationLatestTurnOutcome | null {
  return input.outcome === undefined
    ? resolveSettledTurnStateForSessionStatus(input.sessionStatus)
    : resolveExplicitSettledTurnState({
        outcome: input.outcome,
        targetTurnId: input.targetTurnId,
        turn: input.turn,
      });
}

/**
 * A delayed outcome for an older turn must not replace a newer running session
 * binding or clear its active turn. Legacy session updates without an explicit
 * outcome keep their existing behaviour.
 */
export function shouldApplySessionUpdate(input: {
  readonly currentSession: {
    readonly status: OrchestrationSessionStatus;
    readonly activeTurnId: string | null;
  } | null;
  readonly incomingSession: {
    readonly status: OrchestrationSessionStatus;
    readonly activeTurnId: string | null;
  };
  readonly outcome: OrchestrationLatestTurnOutcome | undefined;
  readonly targetTurnId: string | undefined;
}): boolean {
  if (input.outcome === undefined) {
    return true;
  }
  const currentActiveTurnId = input.currentSession?.activeTurnId ?? null;
  if (currentActiveTurnId === null || input.targetTurnId === currentActiveTurnId) {
    return true;
  }
  return input.incomingSession.activeTurnId === currentActiveTurnId;
}
