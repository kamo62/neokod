import { describe, expect, it } from "vite-plus/test";

import type { SubagentCard } from "../session-logic";
import {
  deriveSubagentTabs,
  resolveSelectedSubagent,
  subagentSecondaryLabel,
} from "./SubagentsPanel";

function makeCard(overrides: Partial<SubagentCard> & { taskId: string }): SubagentCard {
  return {
    name: "Worker",
    model: null,
    kind: null,
    agentId: null,
    status: "inProgress",
    startedAt: "2026-07-04T00:00:00.000Z",
    completedAt: null,
    summary: null,
    progress: [],
    ...overrides,
  };
}

describe("subagentSecondaryLabel", () => {
  it("prefers the model when present", () => {
    expect(
      subagentSecondaryLabel(makeCard({ taskId: "a", model: "gpt-5", kind: "reviewer" })),
    ).toBe("gpt-5");
  });

  it("falls back to kind when the model is absent (Claude case)", () => {
    expect(subagentSecondaryLabel(makeCard({ taskId: "a", model: null, kind: "explorer" }))).toBe(
      "explorer",
    );
  });

  it("returns null when neither is known", () => {
    expect(subagentSecondaryLabel(makeCard({ taskId: "a" }))).toBe(null);
  });
});

describe("deriveSubagentTabs", () => {
  it("emits one tab per card in order, carrying label and status", () => {
    const tabs = deriveSubagentTabs([
      makeCard({ taskId: "a", name: "Explorer", status: "inProgress" }),
      makeCard({ taskId: "b", name: "Builder", status: "completed" }),
    ]);
    expect(tabs).toEqual([
      { taskId: "a", label: "Explorer", status: "inProgress" },
      { taskId: "b", label: "Builder", status: "completed" },
    ]);
  });
});

describe("resolveSelectedSubagent", () => {
  const cards = [makeCard({ taskId: "a" }), makeCard({ taskId: "b" })];

  it("returns null (card-list view) when nothing is selected", () => {
    expect(resolveSelectedSubagent(cards, null)).toBe(null);
  });

  it("returns the matching card when selected", () => {
    expect(resolveSelectedSubagent(cards, "b")?.taskId).toBe("b");
  });

  it("returns null when the selection is unknown", () => {
    expect(resolveSelectedSubagent(cards, "ghost")).toBe(null);
  });
});
