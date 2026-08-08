import { describe, expect, it } from "vite-plus/test";

import { deriveThreadLifecycle } from "./threadLifecycle.logic";

const idleFacts = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} as const;

describe("deriveThreadLifecycle", () => {
  it("prioritizes actionable attention over live execution", () => {
    expect(
      deriveThreadLifecycle({
        ...idleFacts,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        latestTurnState: "running",
        sessionStatus: "running",
      }),
    ).toEqual({ phase: "awaiting", reason: "approval" });
  });

  it("treats a running latest turn as working even when the session is absent", () => {
    expect(deriveThreadLifecycle({ ...idleFacts, latestTurnState: "running" })).toEqual({
      phase: "working",
    });
  });

  it("keeps plan-ready below live work and above terminal completion", () => {
    expect(
      deriveThreadLifecycle({
        ...idleFacts,
        latestTurnState: "completed",
        planReady: true,
        sessionStatus: "ready",
      }),
    ).toEqual({ phase: "plan-ready" });
  });

  it.each([
    [{ latestTurnState: "completed" as const }, { phase: "terminal", outcome: "completed" }],
    [{ latestTurnState: "interrupted" as const }, { phase: "terminal", outcome: "stopped" }],
    [{ latestTurnState: "error" as const }, { phase: "terminal", outcome: "failed" }],
    [{ sessionStatus: "stopped" as const }, { phase: "terminal", outcome: "stopped" }],
    [{ sessionStatus: "error" as const }, { phase: "terminal", outcome: "failed" }],
  ])("derives terminal outcome from %o", (overrides, expected) => {
    expect(deriveThreadLifecycle({ ...idleFacts, ...overrides })).toEqual(expected);
  });

  it("preserves unknown when no authoritative lifecycle fact exists", () => {
    expect(deriveThreadLifecycle(idleFacts)).toEqual({ phase: "unknown" });
  });
});
