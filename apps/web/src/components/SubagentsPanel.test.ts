import { describe, expect, it } from "vite-plus/test";

import type { SubagentCard } from "../session-logic";
import {
  deriveSubagentTabs,
  isFinishedWorker,
  isStaleWorker,
  resolveSelectedSubagent,
  subagentSecondaryLabel,
  visibleSubagentCards,
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
  it("emits one tab per card in order, carrying label, hint, and status", () => {
    const tabs = deriveSubagentTabs([
      makeCard({ taskId: "a", name: "Explorer", model: "gpt-5", status: "inProgress" }),
      makeCard({ taskId: "b", name: "Builder", kind: "codex", status: "completed" }),
    ]);
    expect(tabs).toEqual([
      { taskId: "a", label: "Explorer", hint: "gpt-5", status: "inProgress" },
      { taskId: "b", label: "Builder", hint: "codex", status: "completed" },
    ]);
  });

  it("disambiguates duplicate worker names with a #n suffix", () => {
    const tabs = deriveSubagentTabs([
      makeCard({ taskId: "a", name: "Subagent" }),
      makeCard({ taskId: "b", name: "Subagent" }),
      makeCard({ taskId: "c", name: "Unique" }),
    ]);
    expect(tabs.map((tab) => tab.label)).toEqual(["Subagent #1", "Subagent #2", "Unique"]);
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

describe("isFinishedWorker", () => {
  it("is true for completed/failed/stopped workers", () => {
    expect(isFinishedWorker(makeCard({ taskId: "a", status: "completed" }))).toBe(true);
    expect(isFinishedWorker(makeCard({ taskId: "a", status: "failed" }))).toBe(true);
    expect(isFinishedWorker(makeCard({ taskId: "a", status: "stopped" }))).toBe(true);
  });

  it("is false while in progress", () => {
    expect(isFinishedWorker(makeCard({ taskId: "a", status: "inProgress" }))).toBe(false);
  });
});

describe("visibleSubagentCards", () => {
  it("hides dismissed workers and any finished worker (auto-delete on finish)", () => {
    const cards = [
      makeCard({ taskId: "running", status: "inProgress" }),
      makeCard({ taskId: "done", status: "completed", summary: "ok" }),
      makeCard({ taskId: "failed", status: "failed" }),
      makeCard({ taskId: "dismissed", status: "inProgress" }),
    ];
    const visible = visibleSubagentCards(cards, new Set(["dismissed"]));
    expect(visible.map((card) => card.taskId)).toEqual(["running"]);
  });

  it("hides orphaned in-progress workers once the parent turn has settled", () => {
    const cards = [makeCard({ taskId: "orphan", status: "inProgress" })];
    expect(visibleSubagentCards(cards, new Set(), false).map((c) => c.taskId)).toEqual(["orphan"]);
    expect(visibleSubagentCards(cards, new Set(), true)).toEqual([]);
  });
});

describe("isStaleWorker", () => {
  it("is true only for in-progress workers after the turn settles", () => {
    expect(isStaleWorker(makeCard({ taskId: "a", status: "inProgress" }), true)).toBe(true);
    expect(isStaleWorker(makeCard({ taskId: "a", status: "inProgress" }), false)).toBe(false);
    expect(isStaleWorker(makeCard({ taskId: "a", status: "completed" }), true)).toBe(false);
  });
});
