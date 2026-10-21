/**
 * Pure projections for Claude allowance and API failures.
 *
 * The Claude CLI reports an allowance or API failure as a `result` message with
 * `subtype: "success"`, `is_error: true`, and (for allowance limits) a preceding
 * `rate_limit_event`. These helpers keep that evidence intact: they classify the
 * failure, preserve the CLI's own text, and derive a structured limit only from
 * reports that actually name a rejected window. They do not import the SDK or
 * Effect so the text-generation path can reuse them.
 *
 * @module provider/Layers/ClaudeUsageLimit
 */
import type { ServerProvider, ServerProviderLimit } from "@neokod/contracts";

export interface ClaudeResultLike {
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly api_error_status?: number | null;
  readonly terminal_reason?: string | null;
  readonly result?: string;
}

export type ClaudeFailureKind = "usage_limit" | "auth" | "overloaded" | "provider_error";

export interface ClaudeResultFailure {
  readonly kind: ClaudeFailureKind;
  readonly message: string;
  /** ISO timestamp derived from a rate-limit report, never from a bare 429. */
  readonly resetsAt?: string;
  readonly apiErrorStatus?: number;
  readonly terminalReason?: string;
}

export interface ClaudeFailureHints {
  readonly assistantError?: { readonly code: string; readonly text: string | undefined };
  readonly resetsAtEpochSeconds?: number;
}

/**
 * Terminal reasons that mean the turn ended without completing its work.
 * Abort reasons are deliberately excluded: an explicit abort is an
 * interruption, not a provider failure.
 */
export const FAILING_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "image_error",
  "model_error",
  "api_error",
  "malformed_tool_use_exhausted",
  "budget_exhausted",
  "structured_output_retry_exhausted",
  "tool_deferred_unavailable",
  "turn_setup_failed",
]);

const ABORTED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "aborted_streaming",
  "aborted_tools",
]);

const DEFAULT_FAILURE_MESSAGES: Record<ClaudeFailureKind, string> = {
  usage_limit: "Claude usage limit reached.",
  auth: "Claude authentication failed. Sign in again with the Claude CLI.",
  overloaded: "Claude is overloaded (529). Try again shortly.",
  provider_error: "Claude turn failed.",
};

function nonEmptyText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

/**
 * Deterministic UTC rendering of epoch milliseconds without the ambient
 * `Date` constructor, so the projection stays pure.
 */
function toIsoUtc(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = ((ms % 1000) + 1000) % 1000;
  const days = Math.floor(totalSeconds / 86_400);
  const secondsOfDay = totalSeconds - days * 86_400;
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
  const calendarYear = month <= 2 ? year + 1 : year;
  const hour = Math.floor(secondsOfDay / 3_600);
  const minute = Math.floor((secondsOfDay % 3_600) / 60);
  const second = secondsOfDay % 60;

  return `${pad(calendarYear, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(milliseconds, 3)}Z`;
}

export function isAbortedClaudeResult(result: ClaudeResultLike): boolean {
  return result.terminal_reason !== null && result.terminal_reason !== undefined
    ? ABORTED_TERMINAL_REASONS.has(result.terminal_reason)
    : false;
}

function isoMinuteUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function failureKind(
  result: ClaudeResultLike,
  assistantErrorCode: string | undefined,
): ClaudeFailureKind {
  if (
    result.api_error_status === 429 ||
    result.terminal_reason === "blocking_limit" ||
    assistantErrorCode === "rate_limit"
  ) {
    return "usage_limit";
  }
  if (
    result.api_error_status === 401 ||
    assistantErrorCode === "authentication_failed" ||
    assistantErrorCode === "oauth_org_not_allowed"
  ) {
    return "auth";
  }
  if (result.api_error_status === 529 || assistantErrorCode === "overloaded") {
    return "overloaded";
  }
  return "provider_error";
}

function resetsAtFromHint(hints: ClaudeFailureHints | undefined): string | undefined {
  const seconds = hints?.resetsAtEpochSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return undefined;
  }
  return toIsoUtc(seconds * 1000);
}

export function claudeResultFailure(
  result: ClaudeResultLike,
  hints?: ClaudeFailureHints,
): ClaudeResultFailure | undefined {
  if (result.subtype !== "success") {
    return undefined;
  }
  if (isAbortedClaudeResult(result)) {
    return undefined;
  }

  const status = result.api_error_status;
  const terminalReason = result.terminal_reason ?? undefined;
  const assistantErrorCode = hints?.assistantError?.code;
  const failing =
    result.is_error === true ||
    status === 401 ||
    status === 429 ||
    status === 529 ||
    (terminalReason !== undefined && FAILING_TERMINAL_REASONS.has(terminalReason));
  if (!failing) {
    return undefined;
  }

  const kind = failureKind(result, assistantErrorCode);
  const text =
    nonEmptyText(hints?.assistantError?.text) ??
    (result.is_error === true ? nonEmptyText(result.result) : undefined) ??
    DEFAULT_FAILURE_MESSAGES[kind];
  const resetsAt = kind === "usage_limit" ? resetsAtFromHint(hints) : undefined;
  const message =
    resetsAt !== undefined && !/reset/i.test(text)
      ? `${text} Resets ${isoMinuteUtc(resetsAt)}.`
      : text;

  return {
    kind,
    message,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(typeof status === "number" ? { apiErrorStatus: status } : {}),
    ...(terminalReason !== undefined ? { terminalReason } : {}),
  };
}

/**
 * Reads the `claude -p --output-format json` envelope and returns the failure
 * message when the reply itself reports an error, so callers do not decode a
 * failed turn as structured output.
 */
export function describeClaudeCliResultFailure(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as { readonly type?: unknown } & ClaudeResultLike;
  if (record.type !== "result") {
    return undefined;
  }
  return claudeResultFailure(record)?.message;
}

/** Key: `rateLimitType`, or `"unknown"` when the CLI omitted it. */
export type RejectedRateLimits = ReadonlyMap<string, number | undefined>;

export function updateRejectedRateLimits(
  previous: RejectedRateLimits,
  info: {
    status: string;
    rateLimitType?: string | undefined;
    resetsAt?: number | undefined;
  },
): RejectedRateLimits {
  const next = new Map(previous);
  const key = info.rateLimitType ?? "unknown";
  if (info.status === "rejected") {
    next.set(key, info.resetsAt);
  } else if (info.status === "allowed" || info.status === "allowed_warning") {
    next.delete(key);
  }
  return next;
}

/** Latest known reset strictly after `nowSeconds`. Unknown resets are ignored. */
export function latestRejectedResetSeconds(
  rejected: RejectedRateLimits,
  nowSeconds: number,
): number | undefined {
  let latest: number | undefined;
  for (const resetsAt of rejected.values()) {
    if (typeof resetsAt === "number" && resetsAt > nowSeconds) {
      latest = latest === undefined ? resetsAt : Math.max(latest, resetsAt);
    }
  }
  return latest;
}

/**
 * Projects rejected rate-limit reports into a provider limit. A report with an
 * unknown reset still proves the window is rejected; it does not prove when the
 * window resets, so `resetsAt` stays absent.
 */
export function providerLimitFromRejected(
  rejected: RejectedRateLimits,
  nowMs: number,
): ServerProviderLimit | null {
  const nowSeconds = nowMs / 1000;
  const live = [...rejected].filter(
    ([, resetsAt]) => resetsAt === undefined || resetsAt > nowSeconds,
  );
  if (live.length === 0) {
    return null;
  }
  const [first] = live;
  if (first === undefined) {
    return null;
  }

  let latest: { readonly rateLimitType: string; readonly resetsAt: number } | undefined;
  for (const [rateLimitType, resetsAt] of live) {
    if (typeof resetsAt === "number" && (latest === undefined || resetsAt > latest.resetsAt)) {
      latest = { rateLimitType, resetsAt };
    }
  }

  return {
    kind: "usage_limit",
    window: latest?.rateLimitType ?? first[0],
    ...(latest !== undefined ? { resetsAt: toIsoUtc(latest.resetsAt * 1000) } : {}),
    observedAt: toIsoUtc(nowMs),
  };
}

function limitMessage(limit: ServerProviderLimit): string {
  return limit.resetsAt !== undefined
    ? `Usage limit reached. Resets ${isoMinuteUtc(limit.resetsAt)}.`
    : "Usage limit reached.";
}

/**
 * Applies a limit to the base snapshot without mutating it. Passing `null`
 * (or an expired limit) restores the base status and message, which is how the
 * driver clears the card when a window recovers. `auth` is provider-reported
 * evidence and is left untouched.
 */
export function applyClaudeLimit(
  snapshot: ServerProvider,
  limit: ServerProviderLimit | null | undefined,
  nowMs: number,
): ServerProvider {
  if (limit === null || limit === undefined) {
    return snapshot;
  }
  if (limit.resetsAt !== undefined) {
    const resetsAtMs = Date.parse(limit.resetsAt);
    if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs) {
      return snapshot;
    }
  }

  const message = limitMessage(limit);
  return {
    ...snapshot,
    limit,
    status: snapshot.status === "ready" ? "warning" : snapshot.status,
    message: snapshot.message !== undefined ? `${message} ${snapshot.message}` : message,
  };
}
