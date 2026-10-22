import { describe, expect, it } from "vite-plus/test";

import {
  dispatchStateLabel,
  globalActionFailureMessage,
  resolveDispatchDisplayState,
  stopAllMessage,
  type DispatchDisplayState,
  type DispatchOverviewSnapshot,
} from "./globalControls.logic";

const expectUnknown = (display: DispatchDisplayState) => {
  expect(display.state).toBe("unknown");
  if (display.state !== "unknown") throw new Error("expected an unknown dispatch state");
  return display;
};

const overview = (
  orchestratorPaused: boolean | null,
  generatedAt = "2026-10-22T10:00:00.000Z",
): DispatchOverviewSnapshot => ({ orchestratorPaused, generatedAt });

describe("dispatchStateLabel", () => {
  it("keeps an unknown dispatch state explicit", () => {
    expect(dispatchStateLabel(null)).toBe("Dispatch state is unknown.");
  });

  it("explains paused dispatch", () => {
    expect(dispatchStateLabel(true)).toBe("Dispatch is paused. No new work will be picked up.");
  });

  it("explains active dispatch", () => {
    expect(dispatchStateLabel(false)).toBe(
      "Dispatch is active. Eligible work is picked up automatically.",
    );
  });
});

describe("resolveDispatchDisplayState", () => {
  it("reports the latest confirmed dispatch state", () => {
    expect(
      resolveDispatchDisplayState({
        overview: overview(false),
        overviewError: null,
        isReconciling: false,
      }),
    ).toEqual({
      state: "known",
      paused: false,
      label: dispatchStateLabel(false),
      observedAt: "2026-10-22T10:00:00.000Z",
    });
  });

  it("never presents a stale snapshot as current when the overview refresh fails", () => {
    const display = expectUnknown(
      resolveDispatchDisplayState({
        overview: overview(true),
        overviewError: "Symphony is unavailable.",
        isReconciling: false,
      }),
    );

    expect(display.label).toBe(dispatchStateLabel(null));
    expect(display.lastConfirmed).toEqual({
      paused: true,
      observedAt: "2026-10-22T10:00:00.000Z",
    });
    expect(display.error).toBe("Symphony is unavailable.");
    expect(display.label).not.toBe(dispatchStateLabel(true));
    expect(display.label).not.toBe(dispatchStateLabel(false));
  });

  it("stays unknown while reconciliation is outstanding after a mutation", () => {
    const display = expectUnknown(
      resolveDispatchDisplayState({
        overview: overview(true),
        overviewError: null,
        isReconciling: true,
      }),
    );

    expect(display.label).toBe("Dispatch state is unknown until the refresh completes.");
    expect(display.lastConfirmed).toEqual({
      paused: true,
      observedAt: "2026-10-22T10:00:00.000Z",
    });
    expect(display.error).toBeNull();
  });

  it("reports unknown without a last confirmed state when no overview ever loaded", () => {
    expect(
      resolveDispatchDisplayState({
        overview: null,
        overviewError: "Symphony is unavailable.",
        isReconciling: false,
      }),
    ).toEqual({
      state: "unknown",
      label: dispatchStateLabel(null),
      lastConfirmed: null,
      error: "Symphony is unavailable.",
    });
  });

  it("treats an unreported paused flag as unknown rather than active", () => {
    const display = expectUnknown(
      resolveDispatchDisplayState({
        overview: overview(null),
        overviewError: null,
        isReconciling: false,
      }),
    );

    expect(display.lastConfirmed).toBeNull();
  });
});

describe("stopAllMessage", () => {
  it("reports stopped work", () => {
    expect(stopAllMessage(true)).toBe("Stopped the running work.");
  });

  it("reports an idle stop-all as nothing running rather than an error", () => {
    expect(stopAllMessage(false)).toBe("No runs were running.");
  });
});

describe("globalActionFailureMessage", () => {
  it("names the failed action and surfaces the command failure", () => {
    expect(
      globalActionFailureMessage("pause", {
        interrupted: false,
        cause: new Error("Symphony is unavailable."),
      }),
    ).toBe("Pause all failed: Symphony is unavailable.");
  });

  it("distinguishes an interrupted command from a successful outcome", () => {
    expect(
      globalActionFailureMessage("stop", {
        interrupted: true,
        cause: null,
      }),
    ).toBe("Stop all runs did not complete because the request was interrupted. Try again.");
  });

  it("keeps a visible retry when the failure has no message", () => {
    expect(
      globalActionFailureMessage("resume", {
        interrupted: false,
        cause: {},
      }),
    ).toBe("Resume all failed. Try again.");
  });
});
