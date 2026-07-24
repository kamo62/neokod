import { describe, expect, it } from "vite-plus/test";

import type { SubagentCard } from "../session-logic";
import {
  deriveSubagentTabs,
  cleanSubagentProgressLabel,
  displayStatus,
  formatSubagentUsage,
  isDismissableEmptyWorker,
  isFinishedWorker,
  resolveSelectedSubagent,
  subagentSecondaryLabel,
  visibleSubagentCards,
} from "./SubagentsPanel";
import {
  HIDDEN_SUBAGENT_MAX_AGE_MS,
  MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES,
  migratePersistedSubagentUiState,
  pruneHiddenSubagentTaskIds,
  selectHiddenSubagentTaskIds,
} from "../subagentUiStore";
import { scopeThreadRef, scopedThreadKey } from "@neokod/client-runtime/environment";
import { ThreadId } from "@neokod/contracts";

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
    currentActivity: null,
    usage: null,
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

describe("cleanSubagentProgressLabel", () => {
  it("strips running prefixes and falls back for missing labels", () => {
    expect(cleanSubagentProgressLabel("Running List root and read Package.swift")).toBe(
      "List root and read Package.swift",
    );
    expect(cleanSubagentProgressLabel("Ran Bun test")).toBe("Bun test");
    expect(cleanSubagentProgressLabel(null)).toBe("Working…");
    expect(cleanSubagentProgressLabel("")).toBe("Working…");
  });
});

describe("formatSubagentUsage", () => {
  it("formats token and Copilot AIU usage", () => {
    expect(formatSubagentUsage({ totalTokens: 1234, totalNanoAiu: 56 })).toBe(
      "1,234 tok · 56 nAIU",
    );
  });

  it("returns null when usage is unavailable", () => {
    expect(formatSubagentUsage(null)).toBe(null);
  });
});

describe("deriveSubagentTabs", () => {
  it("emits one tab per card in order, carrying label, hint, and status", () => {
    const tabs = deriveSubagentTabs([
      makeCard({
        taskId: "a",
        name: "Explorer",
        model: "gpt-5",
        status: "inProgress",
      }),
      makeCard({
        taskId: "b",
        name: "Builder",
        kind: "codex",
        status: "completed",
      }),
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
  it("keeps finished workers with content until they are hidden", () => {
    const cards = [
      makeCard({ taskId: "running", status: "inProgress" }),
      makeCard({ taskId: "done", status: "completed", summary: "ok" }),
      makeCard({
        taskId: "failed",
        status: "failed",
        progress: [{ at: "now", description: null, summary: "Done", lastToolName: null }],
      }),
      makeCard({ taskId: "empty", status: "stopped" }),
      makeCard({ taskId: "dismissed", status: "inProgress" }),
    ];
    const visible = visibleSubagentCards(cards, new Set(["dismissed"]));
    expect(visible.map((card) => card.taskId)).toEqual(["running", "done", "failed"]);
  });

  it("keeps in-progress workers after the parent turn settles", () => {
    const cards = [makeCard({ taskId: "orphan", status: "inProgress" })];
    expect(visibleSubagentCards(cards, new Set()).map((card) => card.taskId)).toEqual(["orphan"]);
  });
});

describe("isDismissableEmptyWorker", () => {
  it("is true only for finished workers with no progress or summary", () => {
    expect(isDismissableEmptyWorker(makeCard({ taskId: "a", status: "completed" }))).toBe(true);
    expect(
      isDismissableEmptyWorker(makeCard({ taskId: "a", status: "failed", summary: "Boom" })),
    ).toBe(false);
    expect(
      isDismissableEmptyWorker(
        makeCard({
          taskId: "a",
          status: "stopped",
          progress: [
            {
              at: "now",
              description: null,
              summary: "Stopped",
              lastToolName: null,
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(isDismissableEmptyWorker(makeCard({ taskId: "a", status: "inProgress" }))).toBe(false);
  });
});

describe("displayStatus", () => {
  it("keeps a live in-progress worker spinning", () => {
    expect(displayStatus(makeCard({ taskId: "a", status: "inProgress" }), false)).toEqual({
      label: "In progress",
      iconStatus: "inProgress",
    });
  });

  it("shows an orphaned in-progress worker as ended after the turn settles", () => {
    expect(displayStatus(makeCard({ taskId: "a", status: "inProgress" }), true)).toEqual({
      label: "Ended",
      iconStatus: "stopped",
    });
  });

  it("leaves terminal statuses unchanged when the turn settles", () => {
    expect(displayStatus(makeCard({ taskId: "a", status: "completed" }), true)).toEqual({
      label: "Completed",
      iconStatus: "completed",
    });
  });
});

describe("hidden worker persistence helpers", () => {
  it("rehydrates hidden ids only for their scoped environment and thread", () => {
    const threadId = ThreadId.make("shared-thread");
    const primaryRef = scopeThreadRef("environment-a" as never, threadId);
    const otherEnvironmentRef = scopeThreadRef("environment-b" as never, threadId);
    const persisted = migratePersistedSubagentUiState(
      {
        hiddenTaskIdsByThreadKey: {
          [scopedThreadKey(primaryRef)]: {
            taskIds: ["task-a"],
            updatedAt: Date.now(),
          },
        },
      },
      1,
    );

    expect(
      selectHiddenSubagentTaskIds(persisted.hiddenTaskIdsByThreadKey ?? {}, primaryRef),
    ).toEqual(["task-a"]);
    expect(
      selectHiddenSubagentTaskIds(persisted.hiddenTaskIdsByThreadKey ?? {}, otherEnvironmentRef),
    ).toEqual([]);
  });

  it("prunes old entries and caps persisted scoped thread entries", () => {
    const now = 1_000_000_000;
    const entries = Object.fromEntries(
      Array.from({ length: MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES + 1 }, (_, index) => [
        scopedThreadKey(
          scopeThreadRef(`environment-${index}` as never, ThreadId.make(`thread-${index}`)),
        ),
        { taskIds: [`task-${index}`], updatedAt: now - index },
      ]),
    );
    const oldRef = scopeThreadRef("old" as never, ThreadId.make("old"));
    const oldKey = scopedThreadKey(oldRef);
    entries[oldKey] = {
      taskIds: ["old-task"],
      updatedAt: now - HIDDEN_SUBAGENT_MAX_AGE_MS - 1,
    };

    const pruned = pruneHiddenSubagentTaskIds(entries, now);

    expect(Object.keys(pruned)).toHaveLength(MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES);
    expect(pruned[oldKey]).toBeUndefined();
  });
});
