import { describe, expect, it } from "vite-plus/test";

import type { SubagentCard } from "../session-logic";
import {
  deriveSubagentTabs,
  isDismissableEmptyWorker,
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

describe("isDismissableEmptyWorker", () => {
  it("is true for a finished worker with no progress and no summary", () => {
    expect(isDismissableEmptyWorker(makeCard({ taskId: "a", status: "completed" }))).toBe(true);
    expect(isDismissableEmptyWorker(makeCard({ taskId: "a", status: "failed" }))).toBe(true);
  });

  it("is false while the worker is in progress", () => {
    expect(isDismissableEmptyWorker(makeCard({ taskId: "a", status: "inProgress" }))).toBe(false);
  });

  it("is false for a finished worker that has content", () => {
    expect(
      isDismissableEmptyWorker(makeCard({ taskId: "a", status: "completed", summary: "did it" })),
    ).toBe(false);
    expect(
      isDismissableEmptyWorker(
        makeCard({
          taskId: "a",
          status: "completed",
          progress: [{ description: "step", summary: null, lastToolName: null, at: "t" }],
        }),
      ),
    ).toBe(false);
  });
});

describe("visibleSubagentCards", () => {
  it("hides dismissed workers and finished-empty workers", () => {
    const cards = [
      makeCard({ taskId: "running", status: "inProgress" }),
      makeCard({ taskId: "done-empty", status: "completed" }),
      makeCard({ taskId: "done-content", status: "completed", summary: "ok" }),
      makeCard({ taskId: "dismissed", status: "inProgress" }),
    ];
    const visible = visibleSubagentCards(cards, new Set(["dismissed"]));
    expect(visible.map((card) => card.taskId)).toEqual(["running", "done-content"]);
  });
});
