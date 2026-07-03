import { describe, expect, it } from "vite-plus/test";

import { goalDraftToPatch } from "./GoalChip";

describe("goalDraftToPatch", () => {
  it("trims surrounding whitespace and preserves the status", () => {
    expect(goalDraftToPatch("  ship the goal chip  ", "active")).toEqual({
      goal: "ship the goal chip",
      goalStatus: "active",
    });
  });

  it("clears the goal when the draft is empty or whitespace", () => {
    expect(goalDraftToPatch("   ", "done")).toEqual({ goal: null, goalStatus: "done" });
    expect(goalDraftToPatch("", "active")).toEqual({ goal: null, goalStatus: "active" });
  });
});
