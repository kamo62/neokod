import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  classifyEvidenceResponse,
  EvidenceSinkPermanentError,
  EvidenceSinkRetryableError,
  isPermanentHttpStatus,
  parseRetryAfterMs,
} from "./EvidenceSink.ts";

describe("isPermanentHttpStatus", () => {
  it("treats 408 and 429 as retryable despite being 4xx", () => {
    NodeAssert.equal(isPermanentHttpStatus(408), false);
    NodeAssert.equal(isPermanentHttpStatus(429), false);
  });

  it("treats every other 4xx as permanent", () => {
    NodeAssert.equal(isPermanentHttpStatus(400), true);
    NodeAssert.equal(isPermanentHttpStatus(401), true);
    NodeAssert.equal(isPermanentHttpStatus(404), true);
  });

  it("treats 5xx and 2xx/3xx as not-permanent", () => {
    NodeAssert.equal(isPermanentHttpStatus(500), false);
    NodeAssert.equal(isPermanentHttpStatus(503), false);
    NodeAssert.equal(isPermanentHttpStatus(200), false);
  });
});

describe("parseRetryAfterMs", () => {
  const nowMs = Date.parse("2026-07-02T10:00:00.000Z");

  it("returns undefined when the header is absent or blank", () => {
    NodeAssert.equal(parseRetryAfterMs(undefined, nowMs), undefined);
    NodeAssert.equal(parseRetryAfterMs("  ", nowMs), undefined);
  });

  it("parses delay-seconds", () => {
    NodeAssert.equal(parseRetryAfterMs("120", nowMs), 120_000);
    NodeAssert.equal(parseRetryAfterMs("0", nowMs), 0);
  });

  it("parses an HTTP-date relative to now", () => {
    NodeAssert.equal(parseRetryAfterMs("2026-07-02T10:02:00.000Z", nowMs), 120_000);
  });

  it("clamps a past HTTP-date to zero instead of a negative delay", () => {
    NodeAssert.equal(parseRetryAfterMs("2026-07-02T09:00:00.000Z", nowMs), 0);
  });

  it("returns undefined for an unparseable value", () => {
    NodeAssert.equal(parseRetryAfterMs("not-a-date-or-number", nowMs), undefined);
  });
});

const fakeRequest = HttpClientRequest.post("https://example.com");
const responseFor = (response: Response) =>
  Effect.succeed(HttpClientResponse.fromWeb(fakeRequest, response));

function assertPermanentError(error: unknown, status: number): void {
  NodeAssert.ok(error instanceof EvidenceSinkPermanentError, "expected EvidenceSinkPermanentError");
  if (error instanceof EvidenceSinkPermanentError) {
    NodeAssert.equal(error.status, status);
  }
}

function assertRetryableError(
  error: unknown,
  expected: { readonly status?: number; readonly retryAfterMs?: number },
): void {
  NodeAssert.ok(error instanceof EvidenceSinkRetryableError, "expected EvidenceSinkRetryableError");
  if (error instanceof EvidenceSinkRetryableError) {
    NodeAssert.equal(error.status, expected.status);
    NodeAssert.equal(error.retryAfterMs, expected.retryAfterMs);
  }
}

describe("classifyEvidenceResponse", () => {
  it("passes success through untouched", () =>
    classifyEvidenceResponse({
      sink: "test-sink",
      response: responseFor(Response.json({ ok: true })),
    }).pipe(Effect.runPromise));

  it("classifies a 400 as permanent", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        classifyEvidenceResponse({
          sink: "test-sink",
          response: responseFor(new Response(null, { status: 400 })),
        }),
      );
      NodeAssert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assertPermanentError(Cause.squash(exit.cause), 400);
      }
    }).pipe(Effect.runPromise));

  it("classifies a 500 as retryable", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        classifyEvidenceResponse({
          sink: "test-sink",
          response: responseFor(new Response(null, { status: 500 })),
        }),
      );
      NodeAssert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assertRetryableError(Cause.squash(exit.cause), { status: 500 });
      }
    }).pipe(Effect.runPromise));

  it("treats 408/429 as retryable rather than permanent", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        classifyEvidenceResponse({
          sink: "test-sink",
          response: responseFor(new Response(null, { status: 429 })),
        }),
      );
      NodeAssert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assertRetryableError(Cause.squash(exit.cause), { status: 429 });
      }
    }).pipe(Effect.runPromise));

  it("extracts Retry-After from a 429/503 response as retryAfterMs", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        classifyEvidenceResponse({
          sink: "test-sink",
          response: responseFor(
            new Response(null, { status: 429, headers: { "retry-after": "30" } }),
          ),
        }),
      );
      NodeAssert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assertRetryableError(Cause.squash(exit.cause), { status: 429, retryAfterMs: 30_000 });
      }
    }).pipe(Effect.runPromise));

  it("treats a failure that isn't an HttpClientError (e.g. transport/encode) as retryable with no status", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        classifyEvidenceResponse({
          sink: "test-sink",
          response: Effect.fail("network down") as Effect.Effect<
            HttpClientResponse.HttpClientResponse,
            string
          >,
        }),
      );
      NodeAssert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assertRetryableError(Cause.squash(exit.cause), {});
      }
    }).pipe(Effect.runPromise));
});
