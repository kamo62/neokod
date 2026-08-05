/**
 * Retry policy helpers (plan 9.5, SPEC 8.4, PRD FR-060 to FR-062).
 *
 * Pure functions: retry-class membership and backoff computation. The
 * orchestrator's retry sweep (poll-based, restart-safe because the decision
 * state lives in the work item's `retry_scheduled` lifecycle) uses these to
 * decide when a failed run attempt may be re-dispatched.
 */

/** Error categories that are never retryable (plan 9.5). */
const NON_RETRYABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "user_cancelled",
  "tracker_cancelled",
  "workflow_error",
]);

/** Error categories that are retryable (plan 9.5: timeout, process failure,
 * provider error, stall, and validation failure). */
const RETRYABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "agent",
  "timed_out",
  "process_failed",
  "provider_error",
  "stalled",
  "validation_failed",
  "interrupted",
]);

export const isRetryableCategory = (category: string): boolean => {
  if (NON_RETRYABLE_CATEGORIES.has(category)) {
    return false;
  }
  return RETRYABLE_CATEGORIES.has(category);
};

/** Normal continuation retry after a clean worker exit (plan 9.5). */
export const CONTINUATION_RETRY_DELAY_MS = 1_000;

/**
 * Failure-driven backoff: `min(10000 * 2^(attempt-1), maxRetryBackoffMs)`.
 * `attemptNumber` is 1-based; the first retry (attempt 2) waits 10 s.
 */
export const failureBackoffMs = (attemptNumber: number, maxRetryBackoffMs: number): number => {
  const exponential = 10_000 * 2 ** Math.max(0, attemptNumber - 1);
  return Math.min(exponential, maxRetryBackoffMs);
};

/**
 * Due time (epoch ms) for a retry scheduled after a failed attempt: the
 * attempt's finish time plus the failure backoff.
 */
export const retryDueAtMs = (input: {
  readonly finishedAt: string;
  readonly attemptNumber: number;
  readonly maxRetryBackoffMs: number;
}): number | null => {
  const finished = Date.parse(input.finishedAt);
  if (Number.isNaN(finished)) {
    return null;
  }
  return finished + failureBackoffMs(input.attemptNumber, input.maxRetryBackoffMs);
};
