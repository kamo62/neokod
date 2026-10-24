import { scopeThreadRef, scopedThreadKey } from "@neokod/client-runtime/environment";
import { ThreadId } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SubagentCard } from "../session-logic";
import {
  HIDDEN_SUBAGENT_MAX_AGE_MS,
  MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES,
  migratePersistedSubagentUiState,
  pruneHiddenSubagentTaskIds,
  selectHiddenSubagentTaskIds,
} from "../subagentUiStore";
import {
  cleanSubagentProgressLabel,
  deriveSubagentTabs,
  formatSubagentUsage,
  resolveSelectedSubagent,
  resolveSubagentCard,
  subagentSecondaryLabel,
  visibleSubagentCards,
} from "./SubagentsPanel.logic";

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

const FIVE_SECONDS_MS = Date.parse("2026-07-04T00:00:05.000Z");

function resolveCard(card: SubagentCard, options: { nowMs?: number; turnSettled?: boolean } = {}) {
  return resolveSubagentCard({
    card,
    nowMs: options.nowMs ?? FIVE_SECONDS_MS,
    turnSettled: options.turnSettled ?? false,
  });
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
    // Grouping is the runtime locale's call: en-US gives "1,234", de-DE
    // "1.234", fr-FR a narrow no-break space, and es-ES does not group four
    // digits at all. Pin the digits, units, and joiner while allowing the mark.
    const formatted = formatSubagentUsage({ totalTokens: 1234, totalNanoAiu: 56 });
    expect(formatted).toMatch(/^1[,.\s]?234 tok · 56 nAIU$/);
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

  it("returns null when nothing is selected", () => {
    expect(resolveSelectedSubagent(cards, null)).toBe(null);
  });

  it("returns the matching card when selected", () => {
    expect(resolveSelectedSubagent(cards, "b")?.taskId).toBe("b");
  });

  it("returns null when the selection is unknown", () => {
    expect(resolveSelectedSubagent(cards, "ghost")).toBe(null);
  });
});

describe("resolveSubagentCard", () => {
  it("keeps an in-progress worker active with live timing", () => {
    const resolved = resolveCard(makeCard({ taskId: "active" }));

    expect(resolved.lifecycle).toEqual({
      phase: "active",
      label: "Active",
      iconStatus: "inProgress",
      timing: {
        kind: "live",
        startedAt: "2026-07-04T00:00:00.000Z",
        elapsed: "5.0s",
      },
    });
  });

  it("projects an unmatched in-progress worker as potentially-running orphaned work", () => {
    const resolved = resolveCard(makeCard({ taskId: "orphan" }), { turnSettled: true });

    expect(resolved.lifecycle).toEqual({
      phase: "orphaned",
      label: "Orphaned",
      iconStatus: "orphaned",
      mayStillBeRunning: true,
      timing: {
        kind: "last-observed",
        startedAt: "2026-07-04T00:00:00.000Z",
        observedAt: "2026-07-04T00:00:00.000Z",
        elapsed: null,
      },
    });
  });

  it("freezes completed timing at its exact terminal timestamp", () => {
    const card = makeCard({
      taskId: "completed",
      status: "completed",
      completedAt: "2026-07-04T00:00:02.000Z",
    });

    const first = resolveCard(card, { nowMs: FIVE_SECONDS_MS });
    const later = resolveCard(card, { nowMs: Date.parse("2026-07-05T00:00:00.000Z") });

    expect(first.lifecycle).toEqual(later.lifecycle);
    expect(first.lifecycle).toEqual({
      phase: "terminal",
      outcome: "completed",
      label: "Completed",
      iconStatus: "completed",
      timing: {
        kind: "exact",
        startedAt: "2026-07-04T00:00:00.000Z",
        endedAt: "2026-07-04T00:00:02.000Z",
        elapsed: "2.0s",
      },
    });
  });

  it("keeps terminal timing unknown when no terminal timestamp exists", () => {
    const resolved = resolveCard(makeCard({ taskId: "failed", status: "failed" }));

    expect(resolved.lifecycle).toEqual({
      phase: "terminal",
      outcome: "failed",
      label: "Failed",
      iconStatus: "failed",
      timing: {
        kind: "unknown",
        startedAt: "2026-07-04T00:00:00.000Z",
        elapsed: null,
      },
    });
  });

  it("preserves an explicit raw orphaned status", () => {
    const resolved = resolveCard(
      makeCard({
        taskId: "explicit-orphan",
        status: "orphaned",
        completedAt: "2026-07-04T00:00:04.000Z",
        progress: [
          {
            description: "First observation",
            summary: null,
            lastToolName: null,
            at: "2026-07-04T00:00:02.000Z",
          },
          {
            description: "Latest observation",
            summary: null,
            lastToolName: null,
            at: "2026-07-04T00:00:03.000Z",
          },
        ],
      }),
    );

    expect(resolved.lifecycle).toEqual({
      phase: "orphaned",
      label: "Orphaned",
      iconStatus: "orphaned",
      mayStillBeRunning: true,
      timing: {
        kind: "last-observed",
        startedAt: "2026-07-04T00:00:00.000Z",
        observedAt: "2026-07-04T00:00:03.000Z",
        elapsed: "3.0s",
      },
    });
  });
});

describe("visibleSubagentCards", () => {
  it("keeps every real task card regardless of content or terminal status", () => {
    const cards = [
      makeCard({ taskId: "running", status: "inProgress" }),
      makeCard({ taskId: "done", status: "completed", summary: "ok" }),
      makeCard({
        taskId: "failed",
        status: "failed",
        progress: [{ at: "now", description: null, summary: "Done", lastToolName: null }],
      }),
      makeCard({ taskId: "stopped-empty", status: "stopped" }),
      makeCard({ taskId: "orphaned-empty", status: "orphaned" }),
      makeCard({
        taskId: "usage-only",
        status: "completed",
        usage: { totalTokens: 0, totalNanoAiu: null },
      }),
    ];
    expect(visibleSubagentCards(cards, new Set()).map((card) => card.taskId)).toEqual([
      "running",
      "done",
      "failed",
      "stopped-empty",
      "orphaned-empty",
      "usage-only",
    ]);
  });

  it("keeps a real completed task whose completion repeats its name", () => {
    // Copilot starts a native worker and completes it with the agent display
    // name as the summary. With no progress events that summary is deduped to
    // null, but the task itself is real evidence and must stay visible.
    const copilotTask = makeCard({
      taskId: "call_copilot_task",
      name: "Task Agent",
      model: "mai-code-1.1-flash",
      kind: "task",
      agentId: "call_copilot_task",
      status: "completed",
      completedAt: "2026-07-04T00:00:02.000Z",
      usage: { totalTokens: 0, totalNanoAiu: null },
    });

    expect(visibleSubagentCards([copilotTask], new Set()).map((card) => card.taskId)).toEqual([
      "call_copilot_task",
    ]);
  });

  it("removes only explicitly dismissed cards", () => {
    const cards = [
      makeCard({ taskId: "running", status: "inProgress" }),
      makeCard({ taskId: "dismissed-empty", status: "stopped" }),
      makeCard({ taskId: "dismissed-completed", status: "completed", summary: "ok" }),
    ];

    expect(
      visibleSubagentCards(cards, new Set(["dismissed-empty", "dismissed-completed"])).map(
        (card) => card.taskId,
      ),
    ).toEqual(["running"]);
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
