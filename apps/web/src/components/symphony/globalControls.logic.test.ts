import { describe, expect, it } from "vite-plus/test";

import { dispatchStateLabel, stopAllMessage } from "./globalControls.logic";

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

describe("stopAllMessage", () => {
  it("reports stopped work", () => {
    expect(stopAllMessage(true)).toBe("Stopped the running work.");
  });

  it("reports an idle stop-all as nothing running rather than an error", () => {
    expect(stopAllMessage(false)).toBe("No runs were running.");
  });
});
