import { expect, it } from "@effect/vitest";

import {
  CONTINUATION_RETRY_DELAY_MS,
  failureBackoffMs,
  isRetryableCategory,
  retryDueAtMs,
} from "./Retry.ts";

it("treats user and tracker cancellation as non-retryable", () => {
  expect(isRetryableCategory("user_cancelled")).toBe(false);
  expect(isRetryableCategory("tracker_cancelled")).toBe(false);
  expect(isRetryableCategory("workflow_error")).toBe(false);
});

it("treats process, stall and validation failures as retryable", () => {
  expect(isRetryableCategory("agent")).toBe(true);
  expect(isRetryableCategory("process_failed")).toBe(true);
  expect(isRetryableCategory("provider_error")).toBe(true);
  expect(isRetryableCategory("stalled")).toBe(true);
  expect(isRetryableCategory("validation_failed")).toBe(true);
  expect(isRetryableCategory("timed_out")).toBe(true);
  expect(isRetryableCategory("interrupted")).toBe(true);
});

it("treats unknown categories as non-retryable", () => {
  expect(isRetryableCategory("mystery")).toBe(false);
});

it("uses a fixed 1s continuation delay", () => {
  expect(CONTINUATION_RETRY_DELAY_MS).toBe(1_000);
});

it("computes exponential backoff starting at 10s", () => {
  expect(failureBackoffMs(1, 300_000)).toBe(10_000);
  expect(failureBackoffMs(2, 300_000)).toBe(20_000);
  expect(failureBackoffMs(3, 300_000)).toBe(40_000);
});

it("caps backoff at the workflow maximum", () => {
  expect(failureBackoffMs(5, 30_000)).toBe(30_000);
  expect(failureBackoffMs(20, 60_000)).toBe(60_000);
});

it("computes due time from the attempt finish time", () => {
  const due = retryDueAtMs({
    finishedAt: "2026-08-05T00:00:00.000Z",
    attemptNumber: 1,
    maxRetryBackoffMs: 300_000,
  });
  expect(due).toBe(Date.parse("2026-08-05T00:00:00.000Z") + 10_000);
});

it("returns null when the finish time is unparseable", () => {
  expect(
    retryDueAtMs({ finishedAt: "garbage", attemptNumber: 1, maxRetryBackoffMs: 300_000 }),
  ).toBeNull();
});
