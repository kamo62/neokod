/**
 * Backend-pluggable sink abstraction for managed-client evidence.
 *
 * `ManagedClientEvidenceForwarder` owns queueing, batching, backoff, and the
 * permanent-vs-retryable retry decision; it hands a batch of mapped events
 * (plus an optional attached identity) to whichever `EvidenceSink` the
 * current `backend` setting selects. A sink owns only wire representation:
 * building the request body/headers for its destination and turning that
 * destination's response into one of the two typed errors below. Nothing
 * here is org-specific — `AiOrchSink`/`PostHogSink`/`OtlpSink` all implement
 * this same interface.
 *
 * @module EvidenceSink
 */
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientResponse, Headers } from "effect/unstable/http";

import type { ManagedClientEvidenceEvent, ManagedClientIdentity } from "./ManagedClientEvidence.ts";

/**
 * A batch was rejected in a way that will never succeed on retry (e.g. a 4xx
 * response other than 408/429 — an old or misconfigured endpoint rejecting a
 * field it doesn't understand). Callers must drop the batch instead of
 * retrying forever.
 */
export class EvidenceSinkPermanentError extends Data.TaggedError("EvidenceSinkPermanentError")<{
  readonly sink: string;
  readonly status?: number | undefined;
  readonly message: string;
}> {}

/**
 * A batch failed transiently (network error, 5xx, 408/429). Callers should
 * retry with backoff. `retryAfterMs` carries the destination's `Retry-After`
 * header when present, already resolved to a millisecond delay (uncapped —
 * the forwarder applies its own cap).
 */
export class EvidenceSinkRetryableError extends Data.TaggedError("EvidenceSinkRetryableError")<{
  readonly sink: string;
  readonly status?: number | undefined;
  readonly message: string;
  readonly retryAfterMs?: number | undefined;
}> {}

export type EvidenceSinkError = EvidenceSinkPermanentError | EvidenceSinkRetryableError;

/**
 * `send` posts one already-batched attempt (the forwarder owns retries, so a
 * sink implementation must not loop internally). `identity` is `undefined`
 * whenever `includeMachineIdentity` is off — the forwarder decides that gate
 * once, uniformly, before calling any sink; a sink must never derive or
 * attach a machine identifier on its own.
 */
export interface EvidenceSink {
  readonly name: string;
  readonly send: (
    events: ReadonlyArray<ManagedClientEvidenceEvent>,
    identity: ManagedClientIdentity | undefined,
  ) => Effect.Effect<void, EvidenceSinkError, HttpClient.HttpClient>;
}

/**
 * 408 (request timeout) and 429 (rate limited) are transient by definition
 * even though they're 4xx; every other 4xx is permanent (see
 * `EvidenceSinkPermanentError` above).
 */
export function isPermanentHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Parses a `Retry-After` header value (either delay-seconds or an HTTP-date)
 * into a millisecond delay, relative to the supplied `nowMs` (from Effect's
 * `Clock`, never a direct `Date.now()` read). Returns `undefined` when the
 * header is absent or unparseable. Uncapped — the forwarder's retry loop
 * applies the 5-minute cap.
 */
export function parseRetryAfterMs(
  headerValue: string | undefined,
  nowMs: number,
): number | undefined {
  if (headerValue === undefined) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return undefined;
  return Math.max(0, parsedMs - nowMs);
}

/**
 * Executes an already-built request effect and classifies the outcome into
 * the sink error model above: success passes through untouched, a
 * `filterStatusOk`-style status failure is split into permanent/retryable via
 * `isPermanentHttpStatus`, and any other failure (transport error, JSON
 * encode error) is treated as retryable with no status/retry-after — the
 * same "unknown failure keeps retrying" behavior the original forwarder had.
 */
export function classifyEvidenceResponse<E, R>(input: {
  readonly sink: string;
  readonly response: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>;
}): Effect.Effect<void, EvidenceSinkError, R> {
  return Effect.gen(function* () {
    const exit = yield* Effect.result(
      input.response.pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid),
    );
    if (exit._tag === "Success") {
      return;
    }
    const failure = exit.failure;
    const isHttpError = HttpClientError.isHttpClientError(failure);
    const status = isHttpError ? failure.response?.status : undefined;
    const retryAfterHeader =
      isHttpError && failure.response
        ? Option.getOrUndefined(Headers.get(failure.response.headers, "retry-after"))
        : undefined;

    if (status !== undefined && isPermanentHttpStatus(status)) {
      return yield* new EvidenceSinkPermanentError({
        sink: input.sink,
        status,
        message: `${input.sink} rejected the request with a permanent HTTP ${status} error.`,
      });
    }

    const nowMs = yield* Clock.currentTimeMillis;
    return yield* new EvidenceSinkRetryableError({
      sink: input.sink,
      status,
      message:
        status !== undefined
          ? `${input.sink} request failed with HTTP ${status}.`
          : `${input.sink} request failed.`,
      retryAfterMs: parseRetryAfterMs(retryAfterHeader, nowMs),
    });
  });
}
