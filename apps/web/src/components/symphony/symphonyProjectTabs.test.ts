import { describe, expect, it } from "vite-plus/test";

import { parseProjectTab } from "./symphonyProjectTabs";

describe("parseProjectTab", () => {
  it("accepts the four project tabs", () => {
    expect(parseProjectTab("board")).toBe("board");
    expect(parseProjectTab("runs")).toBe("runs");
    expect(parseProjectTab("attention")).toBe("attention");
    expect(parseProjectTab("settings")).toBe("settings");
  });

  it("rejects removed, unknown, missing, and non-string values", () => {
    expect(parseProjectTab("history")).toBeUndefined();
    expect(parseProjectTab("nope")).toBeUndefined();
    expect(parseProjectTab(undefined)).toBeUndefined();
    expect(parseProjectTab(3)).toBeUndefined();
  });
});
