import { describe, expect, it } from "vite-plus/test";
import { deriveThreadRunSummary } from "./threadRunSummary.logic";

const NOW = Date.parse("2026-07-18T10:02:03.000Z");

function input(overrides: Partial<Parameters<typeof deriveThreadRunSummary>[0]> = {}) {
  return {
    thread: {
      title: "Implement banner",
      goal: "Show execution progress",
      latestTurn: {
        state: "running" as const,
        requestedAt: "2026-07-18T10:00:00.000Z",
        startedAt: "2026-07-18T10:00:03.000Z",
        completedAt: null,
      },
      session: { status: "running" },
    },
    activePlan: {
      createdAt: "2026-07-18T10:00:05.000Z",
      turnId: null,
      steps: [
        { step: "Trace state", status: "completed" as const },
        { step: "Build UI", status: "completed" as const },
        { step: "Verify", status: "inProgress" as const },
      ],
    },
    activeWorkStartedAt: "2026-07-18T10:00:03.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    isWorking: true,
    interruptAvailable: true,
    nowMs: NOW,
    ...overrides,
  };
}

describe("deriveThreadRunSummary", () => {
  it("derives the live goal, elapsed time, step count, and interrupt state", () => {
    expect(deriveThreadRunSummary(input())).toMatchObject({
      title: "Show execution progress",
      status: "working",
      elapsed: "2m",
      completedSteps: 2,
      totalSteps: 3,
      interruptAvailable: true,
      compact: false,
    });
  });

  it("keeps a completed run as a compact summary", () => {
    const live = input();
    expect(
      deriveThreadRunSummary({
        ...live,
        isWorking: false,
        interruptAvailable: false,
        thread: {
          ...live.thread,
          latestTurn: {
            ...live.thread.latestTurn!,
            state: "completed",
            completedAt: "2026-07-18T10:01:03.000Z",
          },
          session: { status: "idle" },
        },
      }),
    ).toMatchObject({ status: "completed", elapsed: "1m", compact: true });
  });

  it("prioritizes attention over a running turn", () => {
    const live = input();
    expect(deriveThreadRunSummary({ ...live, hasPendingApprovals: true })).toMatchObject({
      status: "awaiting-approval",
      attention: "approval",
      compact: false,
    });
  });

  it("derives stopped and failed terminal summaries", () => {
    const live = input();
    for (const [state, status] of [
      ["interrupted", "stopped"],
      ["error", "failed"],
    ] as const) {
      expect(
        deriveThreadRunSummary({
          ...live,
          isWorking: false,
          thread: {
            ...live.thread,
            latestTurn: {
              ...live.thread.latestTurn!,
              state,
              completedAt: "2026-07-18T10:01:03.000Z",
            },
            session: { status: "idle" },
          },
        }),
      ).toMatchObject({ status, compact: true });
    }
  });

  it("formats elapsed hours and omits unavailable or negative durations", () => {
    expect(
      deriveThreadRunSummary(input({ nowMs: Date.parse("2026-07-18T12:30:03.000Z") }))?.elapsed,
    ).toBe("2h 30m");
    expect(
      deriveThreadRunSummary(
        input({ activeWorkStartedAt: null, thread: { ...input().thread, latestTurn: null } }),
      ),
    ).toBeNull();
    expect(
      deriveThreadRunSummary(input({ nowMs: Date.parse("2026-07-18T10:00:02.000Z") }))?.elapsed,
    ).toBeNull();
  });
});
