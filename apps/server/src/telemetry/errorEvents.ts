/**
 * Process-local hand-off between the logger and AnalyticsService.
 *
 * The logger must stay free of service dependencies (it is constructed before
 * the analytics layer and adding a dependency would reshape the launch
 * graph), so error-level log entries are reduced to a privacy-safe shape here
 * and drained by the analytics flush loop.
 *
 * Only the error's class/tag name and the log level travel. Messages and
 * stacks never do: both can embed user repository paths, prompt fragments, or
 * other content the Analytics privacy copy promises we do not collect.
 */

export interface AnalyticsErrorEvent {
  readonly errorName: string;
  readonly level: string;
}

const MAX_PENDING_ERROR_EVENTS = 200;

const pending: Array<AnalyticsErrorEvent> = [];

/** Called from the logger tap. Bounded: beyond the cap the oldest entry is
 * dropped, so an error loop cannot grow memory while analytics is disabled
 * or the flush loop is behind. Never throws. */
export function publishAnalyticsErrorEvent(event: AnalyticsErrorEvent): void {
  if (pending.length >= MAX_PENDING_ERROR_EVENTS) {
    pending.shift();
  }
  pending.push(event);
}

/** Called from the analytics flush loop; empties the queue. */
export function drainAnalyticsErrorEvents(): ReadonlyArray<AnalyticsErrorEvent> {
  return pending.splice(0, pending.length);
}

/**
 * Derive a privacy-safe error identifier from a logged cause. Walks the
 * cause's failures for a tagged error (`_tag`) or an Error subclass name and
 * falls back to a constant. Defensive against Cause API drift: never throws,
 * returns only class-name-shaped strings.
 */
export function extractErrorName(cause: unknown): string {
  try {
    const failures = (cause as { failures?: unknown } | null | undefined)?.failures;
    if (Array.isArray(failures)) {
      for (const failure of failures) {
        const wrapper = failure as { error?: unknown; defect?: unknown } | null | undefined;
        const inner = wrapper?.error ?? wrapper?.defect;
        if (inner !== null && typeof inner === "object") {
          const tag = (inner as { _tag?: unknown })._tag;
          if (typeof tag === "string" && tag.length > 0) {
            return tag;
          }
          const name = (inner as { name?: unknown }).name;
          if (typeof name === "string" && name.length > 0) {
            return name;
          }
          return inner.constructor?.name ?? "Error";
        }
      }
    }
  } catch {
    // Fall through to the constant: a logger tap must never throw.
  }
  return "LogError";
}
