import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointRef,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@neokod/contracts";
import { applyThreadDetailEvent } from "@neokod/client-runtime/state/threads";
import { deriveThreadRunSummary } from "./threadRunSummary.logic";

const NOW = Date.parse("2026-07-18T10:02:03.000Z");

function input(
  overrides: Partial<Parameters<typeof deriveThreadRunSummary>[0]> = {},
): Parameters<typeof deriveThreadRunSummary>[0] {
  return {
    thread: {
      title: "Implement banner",
      goal: "Show execution progress",
      latestTurn: {
        state: "running" as const,
        requestedAt: "2026-07-18T10:00:00.000Z",
        startedAt: "2026-07-18T10:00:03.000Z",
        completedAt: null,
      },
      session: { status: "running" },
    },
    activePlan: {
      createdAt: "2026-07-18T10:00:05.000Z",
      turnId: null,
      steps: [
        { step: "Trace state", status: "completed" as const },
        { step: "Build UI", status: "completed" as const },
        { step: "Verify", status: "inProgress" as const },
      ],
    },
    activeWorkStartedAt: "2026-07-18T10:00:03.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    isWorking: true,
    interruptAvailable: true,
    nowMs: NOW,
    ...overrides,
  };
}

describe("deriveThreadRunSummary", () => {
  it("derives the live goal, elapsed time, step count, and interrupt state", () => {
    expect(deriveThreadRunSummary(input())).toMatchObject({
      title: "Show execution progress",
      status: "working",
      elapsed: "2m",
      completedSteps: 2,
      totalSteps: 3,
      interruptAvailable: true,
      compact: false,
    });
  });

  it("adds the active tool to a working status only", () => {
    expect(deriveThreadRunSummary(input({ activeToolLabel: "Running pytest" }))?.statusLabel).toBe(
      "Working · Running pytest",
    );
    expect(
      deriveThreadRunSummary(
        input({
          activeToolLabel: "Running pytest",
          isWorking: false,
          thread: {
            ...input().thread,
            session: { status: "idle" },
            latestTurn: {
              ...input().thread.latestTurn!,
              state: "completed",
              completedAt: "2026-07-18T10:01:03.000Z",
            },
          },
        }),
      )?.statusLabel,
    ).toBe("Completed");
  });

  it("matches the shared lifecycle when only the latest turn reports running", () => {
    const live = input();
    expect(
      deriveThreadRunSummary({
        ...live,
        isWorking: false,
        thread: { ...live.thread, session: null },
      }),
    ).toMatchObject({ status: "working", compact: false });
  });

  it("keeps a completed run as a compact summary", () => {
    const live = input();
    expect(
      deriveThreadRunSummary({
        ...live,
        isWorking: false,
        interruptAvailable: false,
        thread: {
          ...live.thread,
          latestTurn: {
            ...live.thread.latestTurn!,
            state: "completed",
            completedAt: "2026-07-18T10:01:03.000Z",
          },
          session: { status: "idle" },
        },
      }),
    ).toMatchObject({ status: "completed", elapsed: "1m", compact: true });
  });

  it("prioritizes attention over a running turn", () => {
    const live = input();
    expect(deriveThreadRunSummary({ ...live, hasPendingApprovals: true })).toMatchObject({
      status: "awaiting-approval",
      attention: "approval",
      compact: false,
    });
  });

  it("derives stopped and failed terminal summaries", () => {
    const live = input();
    for (const [state, status] of [
      ["interrupted", "stopped"],
      ["error", "failed"],
    ] as const) {
      expect(
        deriveThreadRunSummary({
          ...live,
          isWorking: false,
          thread: {
            ...live.thread,
            latestTurn: {
              ...live.thread.latestTurn!,
              state,
              completedAt: "2026-07-18T10:01:03.000Z",
            },
            session: { status: "idle" },
          },
        }),
      ).toMatchObject({ status, compact: true });
    }
  });

  it("does not tick a terminal run whose completion is unknown", () => {
    const live = input();
    for (const state of ["completed", "interrupted", "error"] as const) {
      const summary = deriveThreadRunSummary({
        ...live,
        isWorking: false,
        interruptAvailable: false,
        thread: {
          ...live.thread,
          latestTurn: {
            ...live.thread.latestTurn!,
            state,
            completedAt: null,
          },
          session: { status: "idle" },
        },
      });
      expect(summary?.status).not.toBe("working");
      expect(summary?.elapsed).toBeNull();
    }
  });

  it("formats elapsed hours and omits unavailable or negative durations", () => {
    expect(
      deriveThreadRunSummary(input({ nowMs: Date.parse("2026-07-18T12:30:03.000Z") }))?.elapsed,
    ).toBe("2h 30m");
    expect(
      deriveThreadRunSummary(
        input({ activeWorkStartedAt: null, thread: { ...input().thread, latestTurn: null } }),
      ),
    ).toBeNull();
    expect(
      deriveThreadRunSummary(input({ nowMs: Date.parse("2026-07-18T10:00:02.000Z") }))?.elapsed,
    ).toBeNull();
  });

  it("keeps the settled duration when a late checkpoint arrives", () => {
    const threadId = ThreadId.make("thread-late-checkpoint");
    const turnId = TurnId.make("turn-late-checkpoint");
    const startedAt = "2026-07-18T10:00:00.000Z";

    for (const settledAt of ["2026-07-18T10:01:00.000Z", null] as const) {
      const settled: OrchestrationThread = {
        id: threadId,
        projectId: ProjectId.make("project-late-checkpoint"),
        title: "Recovered thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId,
          state: "interrupted",
          requestedAt: startedAt,
          startedAt,
          completedAt: settledAt,
          assistantMessageId: null,
        },
        settledTurnCompletions: { [turnId]: settledAt },
        createdAt: startedAt,
        updatedAt: startedAt,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      };

      const result = applyThreadDetailEvent(settled, {
        eventId: EventId.make("event-late-checkpoint"),
        sequence: 1,
        occurredAt: "2026-07-19T10:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.turn-diff-completed",
        payload: {
          threadId,
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-late"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-07-19T10:00:00.000Z",
        },
      });
      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") continue;

      const summary = deriveThreadRunSummary({
        thread: result.thread,
        activePlan: null,
        activeWorkStartedAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        isWorking: false,
        interruptAvailable: false,
        nowMs: Date.parse("2026-07-19T10:05:00.000Z"),
      });
      // The settlement owns the duration; the late checkpoint only adds
      // checkpoint metadata.
      expect(summary?.elapsed).toBe(settledAt === null ? null : "1m");
    }
  });
});
