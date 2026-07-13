import { EventId, TurnId, type OrchestrationThreadActivity } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentCards, formatElapsed } from "./session-logic";

let nextActivityId = 0;

function makeActivity(overrides: {
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(`sub-activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "task.started",
    summary: overrides.summary ?? "Task",
    tone: overrides.tone ?? "info",
    payload: overrides.payload ?? {},
    turnId: TurnId.make("turn-1"),
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("deriveSubagentCards", () => {
  it("creates one card per started task", () => {
    const cards = deriveSubagentCards([
      makeActivity({
        kind: "task.started",
        sequence: 0,
        payload: {
          taskId: "task-a",
          description: "Explorer",
          taskType: "reviewer",
          model: "gpt-5-codex",
          agentId: "agent-a",
        },
      }),
      makeActivity({
        kind: "task.started",
        sequence: 1,
        payload: { taskId: "task-b", description: "Builder", taskType: "codex" },
      }),
    ]);
    expect(cards.length).toBe(2);
    expect(cards[0]?.taskId).toBe("task-a");
    expect(cards[0]?.name).toBe("Explorer");
    expect(cards[0]?.model).toBe("gpt-5-codex");
    expect(cards[0]?.kind).toBe("reviewer");
    expect(cards[0]?.agentId).toBe("agent-a");
    expect(cards[0]?.status).toBe("inProgress");
    expect(cards[1]?.taskId).toBe("task-b");
    // No model on task-b: kind is the fallback label, model stays null.
    expect(cards[1]?.model).toBe(null);
    expect(cards[1]?.kind).toBe("codex");
  });

  it("falls back to defaults when optional fields are absent", () => {
    const [card] = deriveSubagentCards([
      makeActivity({ kind: "task.started", payload: { taskId: "task-x" } }),
    ]);
    expect(card?.name).toBe("Subagent");
    expect(card?.model).toBe(null);
    expect(card?.kind).toBe(null);
    expect(card?.agentId).toBe(null);
  });

  it("marks a completed task with status/summary and computes elapsed", () => {
    const [card] = deriveSubagentCards([
      makeActivity({
        kind: "task.started",
        createdAt: "2026-02-23T00:00:00.000Z",
        sequence: 0,
        payload: { taskId: "task-a", description: "Explorer" },
      }),
      makeActivity({
        kind: "task.completed",
        createdAt: "2026-02-23T00:00:05.000Z",
        sequence: 1,
        payload: { taskId: "task-a", status: "completed", summary: "Done exploring" },
      }),
    ]);
    expect(card?.status).toBe("completed");
    expect(card?.summary).toBe("Done exploring");
    expect(card?.completedAt).toBe("2026-02-23T00:00:05.000Z");
    expect(formatElapsed(card!.startedAt, card!.completedAt ?? undefined)).toBe("5.0s");
  });

  it("propagates a failed status", () => {
    const [card] = deriveSubagentCards([
      makeActivity({ kind: "task.started", sequence: 0, payload: { taskId: "task-a" } }),
      makeActivity({
        kind: "task.completed",
        sequence: 1,
        payload: { taskId: "task-a", status: "failed", summary: "Boom" },
      }),
    ]);
    expect(card?.status).toBe("failed");
    expect(card?.summary).toBe("Boom");
  });

  it("accumulates progress entries in order", () => {
    const [card] = deriveSubagentCards([
      makeActivity({ kind: "task.started", sequence: 0, payload: { taskId: "task-a" } }),
      makeActivity({
        kind: "task.progress",
        sequence: 1,
        payload: { taskId: "task-a", description: "Step 1", lastToolName: "grep" },
      }),
      makeActivity({
        kind: "task.progress",
        sequence: 2,
        payload: { taskId: "task-a", description: "Step 2", summary: "halfway" },
      }),
    ]);
    expect(card?.progress.length).toBe(2);
    expect(card?.progress[0]?.description).toBe("Step 1");
    expect(card?.progress[0]?.lastToolName).toBe("grep");
    expect(card?.progress[1]?.summary).toBe("halfway");
  });

  it("reads the stored ingestion shape (detail, not description)", () => {
    // Mirrors what ProviderRuntimeIngestion actually writes: task text lands
    // under `detail`, not `description`.
    const [card] = deriveSubagentCards([
      makeActivity({
        kind: "task.started",
        sequence: 0,
        payload: { taskId: "task-a", detail: "Explorer", taskType: "reviewer", model: "gpt-5" },
      }),
      makeActivity({
        kind: "task.progress",
        sequence: 1,
        payload: { taskId: "task-a", detail: "Inspecting the diff", lastToolName: "grep" },
      }),
      makeActivity({
        kind: "task.completed",
        sequence: 2,
        payload: { taskId: "task-a", status: "completed", detail: "Done" },
      }),
    ]);
    expect(card?.name).toBe("Explorer");
    expect(card?.model).toBe("gpt-5");
    expect(card?.kind).toBe("reviewer");
    expect(card?.progress[0]?.description).toBe("Inspecting the diff");
    expect(card?.progress[0]?.lastToolName).toBe("grep");
    expect(card?.summary).toBe("Done");
  });

  it("ignores progress/completed events without a matching started event", () => {
    const cards = deriveSubagentCards([
      makeActivity({
        kind: "task.progress",
        sequence: 0,
        payload: { taskId: "orphan", description: "no card" },
      }),
      makeActivity({
        kind: "task.completed",
        sequence: 1,
        payload: { taskId: "orphan", status: "completed" },
      }),
    ]);
    expect(cards.length).toBe(0);
  });
});
