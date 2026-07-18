import { describe, expect, it, vi } from "vite-plus/test";

const hook = vi.hoisted(() => ({
  effect: null as (() => void | (() => void)) | null,
  nowMs: 0,
}));

vi.mock("react", () => ({
  useState: (initial: number | (() => number)) => [
    hook.nowMs || (typeof initial === "function" ? initial() : initial),
    (next: number) => {
      hook.nowMs = next;
    },
  ],
  useEffect: (effect: () => void | (() => void)) => {
    hook.effect = effect;
  },
}));

import { useThreadRunSummary } from "./useThreadRunSummary";

const thread = {
  title: "Run",
  latestTurn: {
    state: "running" as const,
    requestedAt: "2026-07-18T10:00:00.000Z",
    startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: null,
  },
  session: { status: "running" },
};

function render(overrides: Partial<Parameters<typeof useThreadRunSummary>[0]> = {}) {
  useThreadRunSummary({
    thread,
    activePlan: null,
    activeWorkStartedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    isWorking: true,
    interruptAvailable: true,
    ...overrides,
  });
  return hook.effect!();
}

describe("useThreadRunSummary", () => {
  it("resets its clock and cleans up intervals on run changes and unmount", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(42 as never);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    const cleanup = render();
    expect(hook.nowMs).toBe(10_000);
    expect(setIntervalSpy).toHaveBeenCalledOnce();

    cleanup?.();
    expect(clearIntervalSpy).toHaveBeenCalledWith(42);

    vi.spyOn(Date, "now").mockReturnValue(20_000);
    const stoppedCleanup = render({ isWorking: false });
    expect(hook.nowMs).toBe(20_000);
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(stoppedCleanup).toBeUndefined();

    vi.restoreAllMocks();
  });

  it("resets the clock when switching to a newly started thread", () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000);
    const cleanup = render({
      thread: {
        ...thread,
        latestTurn: { ...thread.latestTurn, startedAt: "2026-07-18T10:00:20.000Z" },
      },
    });

    expect(hook.nowMs).toBe(30_000);
    cleanup?.();
    vi.restoreAllMocks();
  });
});
