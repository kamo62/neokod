import { describe, expect, it } from "vite-plus/test";

import { parseProjectSearch, parseProjectTab, parseWorkFilter } from "./symphonyProjectTabs";

describe("parseProjectTab", () => {
  it("accepts the current project sections", () => {
    expect(parseProjectTab("work")).toBe("work");
    expect(parseProjectTab("history")).toBe("history");
    expect(parseProjectTab("settings")).toBe("settings");
  });

  it("maps removed board, runs and attention links onto Work", () => {
    expect(parseProjectTab("board")).toBe("work");
    expect(parseProjectTab("runs")).toBe("work");
    expect(parseProjectTab("attention")).toBe("work");
  });

  it("rejects unknown, missing, and non-string values", () => {
    expect(parseProjectTab("nope")).toBeUndefined();
    expect(parseProjectTab(undefined)).toBeUndefined();
    expect(parseProjectTab(3)).toBeUndefined();
  });
});

describe("parseWorkFilter", () => {
  it("accepts the four Work filters", () => {
    expect(parseWorkFilter("all")).toBe("all");
    expect(parseWorkFilter("not_started")).toBe("not_started");
    expect(parseWorkFilter("in_progress")).toBe("in_progress");
    expect(parseWorkFilter("attention")).toBe("attention");
  });

  it("rejects unknown values", () => {
    expect(parseWorkFilter("running")).toBeUndefined();
    expect(parseWorkFilter(undefined)).toBeUndefined();
  });
});

describe("parseProjectSearch", () => {
  it("keeps a current tab and filter", () => {
    expect(parseProjectSearch({ tab: "work", filter: "in_progress" })).toEqual({
      tab: "work",
      filter: "in_progress",
    });
  });

  it("carries the attention filter from the legacy attention tab", () => {
    expect(parseProjectSearch({ tab: "attention" })).toEqual({
      tab: "work",
      filter: "attention",
    });
  });

  it("leaves absent or unknown search values unset", () => {
    expect(parseProjectSearch({})).toEqual({});
    expect(parseProjectSearch({ tab: "nope", filter: "nope" })).toEqual({});
  });
});
