import type { WorkLifecycle } from "@neokod/contracts";

const TERMINAL_LIFECYCLES: ReadonlySet<WorkLifecycle> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

/**
 * Lifecycles a terminal item passes through when the server requeues it before
 * refusing the admission. The refusal must stay visible through that expected
 * transition.
 */
const EXPECTED_REQUEUE_LIFECYCLES: ReadonlySet<WorkLifecycle> = new Set([
  "queued",
  "retry_scheduled",
  "changes_requested",
  "validation_failed",
]);

/**
 * Decide whether the last client-observed refusal is no longer explanatory.
 *
 * A refresh alone never clears it. It clears only on project policy/status
 * changes, a different authoritative attempt, or a lifecycle outside the
 * terminal -> requeue transition. Unknown lifecycle/attempt evidence keeps the
 * explanation rather than guessing that policy changed.
 */
export const shouldClearWorkRefusal = (input: {
  readonly priorLifecycle: WorkLifecycle | null;
  readonly currentLifecycle: WorkLifecycle | null;
  readonly priorAttemptId: string | null;
  readonly currentAttemptId: string | null;
  readonly currentAttemptStartedAt: string | null;
  readonly recordedAt: string;
  readonly projectRevisionChanged: boolean;
  readonly projectStatusChanged: boolean;
}): boolean => {
  if (input.projectRevisionChanged || input.projectStatusChanged) return true;

  if (input.currentAttemptId !== null) {
    if (input.priorAttemptId !== null && input.currentAttemptId !== input.priorAttemptId) {
      return true;
    }
    if (input.priorAttemptId === null) {
      // The prior attempt identity was unknown/capped. Only a positively later
      // attempt can be treated as a new receipt.
      return (
        input.currentAttemptStartedAt !== null &&
        new Date(input.currentAttemptStartedAt).getTime() > new Date(input.recordedAt).getTime()
      );
    }
  }

  if (input.currentLifecycle === null) return false;

  if (
    input.priorLifecycle !== null &&
    TERMINAL_LIFECYCLES.has(input.priorLifecycle) &&
    EXPECTED_REQUEUE_LIFECYCLES.has(input.currentLifecycle)
  ) {
    return false;
  }

  return input.currentLifecycle !== input.priorLifecycle;
};
