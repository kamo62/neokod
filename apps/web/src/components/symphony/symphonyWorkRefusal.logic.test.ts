import { describe, expect, it } from "vite-plus/test";

import { shouldClearWorkRefusal } from "./symphonyWorkRefusal.logic";

const base = {
  priorLifecycle: "failed" as const,
  currentLifecycle: "queued" as const,
  priorAttemptId: "attempt-1",
  currentAttemptId: "attempt-1",
  currentAttemptStartedAt: "2026-10-23T09:00:00.000Z",
  recordedAt: "2026-10-23T09:05:00.000Z",
  projectRevisionChanged: false,
  projectStatusChanged: false,
};

describe("shouldClearWorkRefusal", () => {
  it("keeps the refusal through the terminal -> queued expected transition", () => {
    expect(shouldClearWorkRefusal(base)).toBe(false);
  });

  it("keeps the refusal while the same terminal lifecycle is reported", () => {
    expect(
      shouldClearWorkRefusal({
        ...base,
        currentLifecycle: "failed",
      }),
    ).toBe(false);
  });

  it("clears when the lifecycle moves outside the expected transition", () => {
    expect(
      shouldClearWorkRefusal({
        ...base,
        currentLifecycle: "running",
      }),
    ).toBe(true);
  });

  it("keeps the refusal when lifecycle evidence is unknown", () => {
    expect(
      shouldClearWorkRefusal({
        ...base,
        currentLifecycle: null,
      }),
    ).toBe(false);
  });

  it("clears on an authoritative attempt change", () => {
    expect(
      shouldClearWorkRefusal({
        ...base,
        currentAttemptId: "attempt-2",
        currentAttemptStartedAt: "2026-10-23T09:10:00.000Z",
      }),
    ).toBe(true);
  });

  it("clears on project revision or status change", () => {
    expect(
      shouldClearWorkRefusal({
        ...base,
        projectRevisionChanged: true,
      }),
    ).toBe(true);
    expect(
      shouldClearWorkRefusal({
        ...base,
        projectStatusChanged: true,
      }),
    ).toBe(true);
  });

  it("does not invent a new attempt from a pre-send attempt when the prior identity was unknown", () => {
    expect(
      shouldClearWorkRefusal({
        ...base,
        priorAttemptId: null,
        currentAttemptId: "old-attempt",
        currentAttemptStartedAt: "2026-10-23T08:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("treats a positively later attempt as a new receipt when the prior identity was unknown", () => {
    expect(
      shouldClearWorkRefusal({
        ...base,
        priorAttemptId: null,
        currentAttemptId: "new-attempt",
        currentAttemptStartedAt: "2026-10-23T09:10:00.000Z",
      }),
    ).toBe(true);
  });
});
