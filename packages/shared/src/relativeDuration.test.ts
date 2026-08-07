import { describe, expect, it } from "vite-plus/test";

import { formatRelativeDuration } from "./relativeDuration.ts";

describe("formatRelativeDuration", () => {
  it("formats zero and sub-second durations as zero seconds", () => {
    expect(formatRelativeDuration(0)).toBe("0s");
    expect(formatRelativeDuration(999)).toBe("0s");
  });

  it("formats whole seconds", () => {
    expect(formatRelativeDuration(3_000)).toBe("3s");
    expect(formatRelativeDuration(59_999)).toBe("59s");
  });

  it("formats minutes with a seconds remainder", () => {
    expect(formatRelativeDuration(60_000)).toBe("1m");
    expect(formatRelativeDuration(130_000)).toBe("2m 10s");
  });

  it("formats hours with a minutes remainder", () => {
    expect(formatRelativeDuration(3_600_000)).toBe("1h");
    expect(formatRelativeDuration(3_840_000)).toBe("1h 4m");
  });

  it("clamps negative and non-finite durations to zero", () => {
    expect(formatRelativeDuration(-1)).toBe("0s");
    expect(formatRelativeDuration(Number.NaN)).toBe("0s");
    expect(formatRelativeDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});
