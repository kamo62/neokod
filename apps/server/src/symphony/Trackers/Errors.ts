import * as Schema from "effect/Schema";

import { TrackerKindSchema } from "@neokod/contracts";

/**
 * Tracker adapter error algebra (SPEC 11.4).
 *
 * The orchestrator only branches on success vs failure; `retryable` and
 * `retryAfterMs` drive the poll backoff for candidate fetch. Every adapter
 * maps its public error forms onto these stable categories and a
 * human-readable message.
 */
export const TrackerAdapterErrorCode = Schema.Literals([
  "unsupported_tracker_kind",
  "invalid_tracker_config",
  "missing_tracker_secret",
  "tracker_request",
  "tracker_status",
  "tracker_response",
  "tracker_not_found",
  "tracker_pagination",
  "tracker_rate_limited",
]);
export type TrackerAdapterErrorCode = typeof TrackerAdapterErrorCode.Type;

export class TrackerAdapterError extends Schema.TaggedErrorClass<TrackerAdapterError>()(
  "TrackerAdapterError",
  {
    code: TrackerAdapterErrorCode,
    message: Schema.String,
    retryable: Schema.optionalKey(Schema.Boolean),
    retryAfterMs: Schema.optionalKey(Schema.Int),
    kind: Schema.optional(TrackerKindSchema),
  },
) {}

export const isTrackerAdapterError = Schema.is(TrackerAdapterError);

export const unsupportedTrackerKind = (kind: string): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "unsupported_tracker_kind",
    message: `Unsupported tracker kind: ${kind}`,
  });

export const invalidTrackerConfig = (message: string): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "invalid_tracker_config",
    message,
    retryable: false,
  });

export const missingTrackerSecret = (name: string): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "missing_tracker_secret",
    message: `Missing tracker secret: ${name}`,
    retryable: false,
  });

export const trackerRequestError = (message: string, retryAfterMs?: number): TrackerAdapterError =>
  retryAfterMs === undefined
    ? new TrackerAdapterError({
        code: "tracker_request",
        message,
        retryable: true,
      })
    : new TrackerAdapterError({
        code: "tracker_request",
        message,
        retryable: true,
        retryAfterMs,
      });

export const trackerStatusError = (message: string, retryable = false): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "tracker_status",
    message,
    retryable,
  });

export const trackerResponseError = (message: string): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "tracker_response",
    message,
    retryable: false,
  });

/**
 * A requested record no longer exists or is out of scope (e.g. an issue was
 * deleted or moved off the tracked repository). `refreshIssues` treats this as
 * an omission, not a batch failure (plan 5.1): the orchestrator interprets the
 * absence as no-longer-visible.
 */
export const trackerNotFoundError = (message: string): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "tracker_not_found",
    message,
    retryable: false,
  });

export const trackerPaginationError = (message: string): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "tracker_pagination",
    message,
    retryable: true,
  });

export const trackerRateLimitedError = (
  message: string,
  retryAfterMs: number,
): TrackerAdapterError =>
  new TrackerAdapterError({
    code: "tracker_rate_limited",
    message,
    retryable: true,
    retryAfterMs,
  });
