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
  it("reports confirmed and held work without hiding ownership", () => {
    const message = stopAllMessage({ ok: false, confirmed: 1, held: 1 });
    expect(message).toContain("1 run confirmed stopped");
    expect(message).toContain("1 run held with ownership retained");
    expect(message).not.toContain("No runs");
  });

  it("never reports held-only work as nothing running", () => {
    const message = stopAllMessage({ ok: false, held: 1 });
    expect(message).toContain("held with ownership retained");
    expect(message).toContain("confirmed count not reported");
    expect(message).not.toContain("No runs were running");
  });

  it("never claims a legacy boolean proved closure", () => {
    expect(stopAllMessage({ ok: true })).toContain("legacy acknowledgement");
    expect(stopAllMessage({ ok: true })).toContain("Closure is unknown");
    expect(stopAllMessage({ ok: false })).toContain("no confirmed closure");
    expect(stopAllMessage({ ok: true })).not.toContain("Stopped");
  });

  it("reports an explicitly empty result as nothing needing a stop", () => {
    expect(stopAllMessage({ ok: true, confirmed: 0, held: 0 })).toBe("No runs needed stopping.");
  });

  it("keeps a missing count explicit rather than assuming zero", () => {
    const message = stopAllMessage({ ok: true, confirmed: 2 });
    expect(message).toContain("2 runs confirmed stopped");
    expect(message).toContain("held count not reported");
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
