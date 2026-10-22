import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import type { OrchestrationThread } from "@neokod/contracts";

import { applyThreadDetailEvent, withSnapshotSettlementEvidence } from "./threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

describe("applyThreadDetailEvent", () => {
  describe("project events", () => {
    it("returns unchanged for project.created", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        type: "project.created",
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Neokod",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
          deletedAt: null,
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.created", () => {
    it("creates a fresh thread", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-2"),
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "New Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.id).toBe("thread-2");
        expect(result.thread.title).toBe("New Thread");
        expect(result.thread.branch).toBe("main");
        expect(result.thread.messages).toEqual([]);
        expect(result.thread.session).toBeNull();
      }
    });
  });

  describe("thread.deleted", () => {
    it("returns deleted signal", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T02:00:00.000Z",
        },
      });
      expect(result.kind).toBe("deleted");
    });
  });

  describe("thread.archived / thread.unarchived", () => {
    it("sets archivedAt", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T03:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.archived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          archivedAt: "2026-04-01T03:00:00.000Z",
          updatedAt: "2026-04-01T03:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBe("2026-04-01T03:00:00.000Z");
      }
    });

    it("clears archivedAt", () => {
      const archivedThread = { ...baseThread, archivedAt: "2026-04-01T03:00:00.000Z" };
      const result = applyThreadDetailEvent(archivedThread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unarchived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt: "2026-04-01T04:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBeNull();
      }
    });
  });

  describe("thread.meta-updated", () => {
    it("patches title and branch", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          title: "Updated Title",
          branch: "feature/demo",
          updatedAt: "2026-04-01T05:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.title).toBe("Updated Title");
        expect(result.thread.branch).toBe("feature/demo");
        // Model selection should be unchanged since it wasn't in the payload
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection);
      }
    });
  });

  describe("thread.message-sent", () => {
    it("appends a new message", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Hello, world!",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("appends text for streaming messages", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world!",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("settles a streaming message without replacing its text or last observation", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "partial answer",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:03:01.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: "",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T06:03:01.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages[0]).toMatchObject({
          text: "partial answer",
          streaming: false,
          updatedAt: "2026-04-01T06:03:01.000Z",
        });
      }
    });

    it("does not move a settled turn completion backwards when a synthetic message closes", () => {
      const threadWithRecoveredTurn: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "interrupted",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "interrupted",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: "2026-04-01T07:03:00.000Z",
          assistantMessageId: MessageId.make("msg-1"),
        },
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "assistant",
            text: "partial answer",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T07:00:00.000Z",
            updatedAt: "2026-04-01T07:01:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithRecoveredTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "assistant",
          text: "",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T07:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("interrupted");
        // The recovered completion came from later turn evidence, not from the
        // message's own last update.
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T07:03:00.000Z");
        expect(result.thread.messages[0]).toMatchObject({
          text: "partial answer",
          streaming: false,
          updatedAt: "2026-04-01T07:01:00.000Z",
        });
      }
    });

    it("keeps an explicitly unknown settled completion null when a synthetic message closes", () => {
      const threadWithUnknownTurn: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "interrupted",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "interrupted",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-1"),
        },
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "assistant",
            text: "partial answer",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T07:00:00.000Z",
            updatedAt: "2026-04-01T07:01:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithUnknownTurn, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "assistant",
          text: "",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T07:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });

    it("updates latestTurn for assistant messages with a turn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Done.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-3");
      }
    });

    it("keeps latestTurn running for interim assistant messages while the session runs the turn", () => {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Interim commentary between tool calls.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.turn-interrupt-requested", () => {
    const runningTurnThread = (): OrchestrationThread => ({
      ...baseThread,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-04-01T07:00:00.000Z",
        startedAt: "2026-04-01T07:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      checkpoints: [
        {
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-1"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-04-01T07:00:05.000Z",
        },
      ],
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-1"),
        lastError: null,
        updatedAt: "2026-04-01T07:00:00.000Z",
      },
    });
    const interruptRequested = (thread: OrchestrationThread, requestedAt: string) =>
      applyThreadDetailEvent(thread, {
        ...baseEventFields,
        sequence: 30,
        occurredAt: requestedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          createdAt: requestedAt,
        },
      });

    it("keeps an interrupt request provisional until the session settles", () => {
      const requestedAt = "2026-04-01T07:00:10.000Z";
      const stoppedAt = "2026-04-01T07:01:00.000Z";

      const interrupted = interruptRequested(runningTurnThread(), requestedAt);
      expect(interrupted.kind).toBe("updated");
      if (interrupted.kind !== "updated") return;
      // Intent is not evidence: only the provisional latest-turn boundary moves.
      expect(interrupted.thread.settledTurnCompletions).toBeUndefined();
      expect(interrupted.thread.latestTurn?.completedAt).toBe(requestedAt);
      expect(interrupted.thread.checkpoints[0]?.completedAt).toBe("2026-04-01T07:00:05.000Z");

      const stopped = applyThreadDetailEvent(interrupted.thread, {
        ...baseEventFields,
        sequence: 31,
        occurredAt: stoppedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "stopped",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: stoppedAt,
          },
          interruptedTurnId: TurnId.make("turn-1"),
        },
      });
      expect(stopped.kind).toBe("updated");
      if (stopped.kind !== "updated") return;
      // The server-observed stop settles the turn, not the earlier request.
      expect(stopped.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: stoppedAt,
      });
      expect(stopped.thread.checkpoints[0]?.completedAt).toBe(stoppedAt);
    });

    it("records the real completion when an interrupt request does not settle the turn", () => {
      const requestedAt = "2026-04-01T07:00:10.000Z";
      const completedAt = "2026-04-01T07:00:30.000Z";

      // The interrupt request fails; the provider keeps streaming the turn.
      const interrupted = interruptRequested(runningTurnThread(), requestedAt);
      expect(interrupted.kind).toBe("updated");
      if (interrupted.kind !== "updated") return;
      expect(interrupted.thread.settledTurnCompletions).toBeUndefined();

      const streaming = applyThreadDetailEvent(interrupted.thread, {
        ...baseEventFields,
        sequence: 31,
        occurredAt: "2026-04-01T07:00:20.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-4"),
          role: "assistant",
          text: "Still working.",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T07:00:20.000Z",
          updatedAt: "2026-04-01T07:00:20.000Z",
        },
      });
      expect(streaming.kind).toBe("updated");
      if (streaming.kind !== "updated") return;
      expect(streaming.thread.latestTurn?.state).toBe("running");

      const settled = applyThreadDetailEvent(streaming.thread, {
        ...baseEventFields,
        sequence: 32,
        occurredAt: completedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "idle",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
        },
      });
      expect(settled.kind).toBe("updated");
      if (settled.kind !== "updated") return;
      expect(settled.thread.latestTurn?.completedAt).toBe(completedAt);
      // The request timestamp never becomes the turn's completion.
      expect(settled.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: completedAt,
      });
      expect(settled.thread.checkpoints[0]?.completedAt).toBe(completedAt);
    });

    it("settles a provisional interrupt at the authoritative session time", () => {
      const requestedAt = "2026-04-01T07:00:10.000Z";
      const stoppedAt = "2026-04-01T07:00:12.000Z";

      const interrupted = interruptRequested(runningTurnThread(), requestedAt);
      expect(interrupted.kind).toBe("updated");
      if (interrupted.kind !== "updated") return;

      // The provider confirms the stop without pinning a turn id; the session
      // timestamp is the settlement, not the earlier request.
      const settled = applyThreadDetailEvent(interrupted.thread, {
        ...baseEventFields,
        sequence: 31,
        occurredAt: stoppedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: stoppedAt,
          },
        },
      });
      expect(settled.kind).toBe("updated");
      if (settled.kind !== "updated") return;
      expect(settled.thread.latestTurn?.completedAt).toBe(stoppedAt);
      expect(settled.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: stoppedAt,
      });
    });

    it("does not promote a provisional interrupt boundary when the next turn starts", () => {
      const interrupted = interruptRequested(runningTurnThread(), "2026-04-01T07:00:10.000Z");
      expect(interrupted.kind).toBe("updated");
      if (interrupted.kind !== "updated") return;

      // The session still runs the turn, so the new turn supersedes it without
      // freezing the interrupt request as the turn's completion.
      const next = applyThreadDetailEvent(interrupted.thread, {
        ...baseEventFields,
        sequence: 32,
        occurredAt: "2026-04-01T07:00:15.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-2"),
            lastError: null,
            updatedAt: "2026-04-01T07:00:15.000Z",
          },
        },
      });
      expect(next.kind).toBe("updated");
      if (next.kind !== "updated") return;
      expect(next.thread.latestTurn?.turnId).toBe(TurnId.make("turn-2"));
      expect(next.thread.settledTurnCompletions).toBeUndefined();
    });

    it("keeps a pending interrupt provisional across a snapshot reload", () => {
      const requestedAt = "2026-04-01T07:00:10.000Z";
      const completedAt = "2026-04-01T07:00:30.000Z";

      const interrupted = interruptRequested(runningTurnThread(), requestedAt);
      expect(interrupted.kind).toBe("updated");
      if (interrupted.kind !== "updated") return;

      // A cache or server snapshot taken while the interruption is pending
      // still reports the session as running the turn.
      const reloaded = withSnapshotSettlementEvidence(interrupted.thread, null);
      expect(reloaded.settledTurnCompletions).toBeUndefined();

      // The interrupt fails and the provider keeps streaming the turn.
      const streaming = applyThreadDetailEvent(reloaded, {
        ...baseEventFields,
        sequence: 31,
        occurredAt: "2026-04-01T07:00:20.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-5"),
          role: "assistant",
          text: "Still working.",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T07:00:20.000Z",
          updatedAt: "2026-04-01T07:00:20.000Z",
        },
      });
      expect(streaming.kind).toBe("updated");
      if (streaming.kind !== "updated") return;

      const settled = applyThreadDetailEvent(streaming.thread, {
        ...baseEventFields,
        sequence: 32,
        occurredAt: completedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "idle",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
        },
      });
      expect(settled.kind).toBe("updated");
      if (settled.kind !== "updated") return;
      // The reloaded provisional boundary must not shadow the real completion.
      expect(settled.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: completedAt,
      });
      expect(settled.thread.latestTurn?.completedAt).toBe(completedAt);
    });
  });

  describe("thread.session-set", () => {
    it("settles a running latestTurn when the session leaves the running status", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T08:00:00.000Z");
      }
    });

    it("uses the recovered turn completion instead of the session update time", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-02T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "interrupted",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-02T08:00:00.000Z",
          },
          latestTurnCompletedAt: "2026-04-01T08:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("interrupted");
        // The turn ends at the last observation, not when recovery ran.
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T08:00:00.000Z");
        expect(result.thread.session?.updatedAt).toBe("2026-04-02T08:00:00.000Z");
      }
    });

    it("keeps an explicitly unknown recovered completion null", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-02T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "interrupted",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-02T08:00:00.000Z",
          },
          latestTurnCompletedAt: null,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("interrupted");
        // Explicit null means no observation; the session update time is not
        // allowed to stand in for completion.
        expect(result.thread.latestTurn?.completedAt).toBeNull();
        expect(result.thread.session?.updatedAt).toBe("2026-04-02T08:00:00.000Z");
      }
    });

    it("records known settlement per turn and preserves it when a later turn starts", () => {
      const startedAt = "2026-04-01T07:00:00.000Z";
      const checkpointAt = "2026-04-01T07:00:10.000Z";
      const completedAt = "2026-04-01T07:01:00.000Z";
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: checkpointAt,
          },
        ],
      };

      const recovered = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T07:02:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
          interruptedTurnId: TurnId.make("turn-1"),
          latestTurnCompletedAt: completedAt,
        },
      });
      expect(recovered.kind).toBe("updated");
      if (recovered.kind !== "updated") return;
      expect(recovered.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: completedAt,
      });
      expect(recovered.thread.checkpoints[0]?.completedAt).toBe(completedAt);

      const next = applyThreadDetailEvent(recovered.thread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-01T07:03:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-2"),
            lastError: null,
            updatedAt: "2026-04-01T07:03:00.000Z",
          },
        },
      });
      expect(next.kind).toBe("updated");
      if (next.kind !== "updated") return;
      expect(next.thread.latestTurn?.turnId).toBe("turn-2");
      expect(next.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: completedAt,
      });
    });

    it("records explicit unknown settlement per turn and preserves it when a later turn starts", () => {
      const startedAt = "2026-04-01T07:00:00.000Z";
      const checkpointAt = "2026-04-01T07:00:10.000Z";
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: checkpointAt,
          },
        ],
      };

      const recovered = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T07:02:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-01T07:02:00.000Z",
          },
          interruptedTurnId: TurnId.make("turn-1"),
          latestTurnCompletedAt: null,
        },
      });
      expect(recovered.kind).toBe("updated");
      if (recovered.kind !== "updated") return;
      expect(recovered.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: null,
      });
      expect(recovered.thread.checkpoints[0]?.completedAt).toBe(checkpointAt);

      const next = applyThreadDetailEvent(recovered.thread, {
        ...baseEventFields,
        sequence: 13,
        occurredAt: "2026-04-01T07:03:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-2"),
            lastError: null,
            updatedAt: "2026-04-01T07:03:00.000Z",
          },
        },
      });
      expect(next.kind).toBe("updated");
      if (next.kind !== "updated") return;
      expect(next.thread.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: null,
      });
    });

    it("preserves a snapshot-loaded settled turn when a later turn starts", () => {
      for (const completedAt of ["2026-04-01T07:01:00.000Z", null] as const) {
        const checkpointAt = "2026-04-01T07:00:10.000Z";
        // Server snapshots carry the latest turn's authoritative completion
        // (possibly an explicit unknown) but not the client settlement record.
        const snapshotThread: OrchestrationThread = {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "interrupted",
            requestedAt: "2026-04-01T07:00:00.000Z",
            startedAt: "2026-04-01T07:00:00.000Z",
            completedAt,
            assistantMessageId: null,
          },
          checkpoints: [
            {
              turnId: TurnId.make("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("checkpoint-1"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: checkpointAt,
            },
          ],
        };

        const next = applyThreadDetailEvent(snapshotThread, {
          ...baseEventFields,
          sequence: 20,
          occurredAt: "2026-04-01T07:03:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.session-set",
          payload: {
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-2"),
              lastError: null,
              updatedAt: "2026-04-01T07:03:00.000Z",
            },
          },
        });

        expect(next.kind).toBe("updated");
        if (next.kind !== "updated") continue;
        expect(next.thread.latestTurn?.turnId).toBe("turn-2");
        expect(next.thread.settledTurnCompletions).toEqual({
          [TurnId.make("turn-1")]: completedAt,
        });
        expect(next.thread.checkpoints[0]?.completedAt).toBe(completedAt ?? checkpointAt);
      }
    });

    it("does not rewrite an already-settled turn when its idle session is stopped", () => {
      for (const settledAt of ["2026-04-01T07:01:00.000Z", null] as const) {
        const checkpointAt = "2026-04-01T07:00:10.000Z";
        const recovered: OrchestrationThread = {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "interrupted",
            requestedAt: "2026-04-01T07:00:00.000Z",
            startedAt: "2026-04-01T07:00:00.000Z",
            completedAt: settledAt,
            assistantMessageId: null,
          },
          settledTurnCompletions: { [TurnId.make("turn-1")]: settledAt },
          checkpoints: [
            {
              turnId: TurnId.make("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("checkpoint-1"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: checkpointAt,
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-01T07:02:00.000Z",
          },
        };

        // Stopping an idle thread pins the latest turn id, but the turn was
        // already settled: the later session timestamp must not supersede it.
        const result = applyThreadDetailEvent(recovered, {
          ...baseEventFields,
          sequence: 21,
          occurredAt: "2026-04-02T00:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.session-set",
          payload: {
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-04-02T00:00:00.000Z",
            },
            interruptedTurnId: TurnId.make("turn-1"),
          },
        });

        expect(result.kind).toBe("updated");
        if (result.kind !== "updated") continue;
        expect(result.thread.settledTurnCompletions).toEqual({
          [TurnId.make("turn-1")]: settledAt,
        });
        expect(result.thread.latestTurn?.completedAt).toBe(settledAt);
        expect(result.thread.checkpoints[0]?.completedAt).toBe(checkpointAt);
      }
    });

    it("updates session and latestTurn for a running session", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("running");
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("running");
      }
    });
  });

  describe("withSnapshotSettlementEvidence", () => {
    const settledTurn = (
      turnId: TurnId,
      state: "interrupted" | "running",
      completedAt: string | null,
    ): OrchestrationThread["latestTurn"] => ({
      turnId,
      state,
      requestedAt: "2026-04-01T07:00:00.000Z",
      startedAt: "2026-04-01T07:00:00.000Z",
      completedAt,
      assistantMessageId: null,
    });

    it("records the latest turn's authoritative completion when a snapshot loads", () => {
      for (const completedAt of ["2026-04-01T07:01:00.000Z", null] as const) {
        const snapshotThread: OrchestrationThread = {
          ...baseThread,
          latestTurn: settledTurn(TurnId.make("turn-1"), "interrupted", completedAt),
        };

        const hydrated = withSnapshotSettlementEvidence(snapshotThread, null);

        expect(hydrated.settledTurnCompletions).toEqual({
          [TurnId.make("turn-1")]: completedAt,
        });
      }
    });

    it("does not record a running latest turn as settled", () => {
      const snapshotThread: OrchestrationThread = {
        ...baseThread,
        latestTurn: settledTurn(TurnId.make("turn-1"), "running", null),
      };

      expect(withSnapshotSettlementEvidence(snapshotThread, null)).toBe(snapshotThread);
    });

    it("does not seed a provisional interrupt boundary its session still runs", () => {
      const snapshotThread: OrchestrationThread = {
        ...baseThread,
        latestTurn: settledTurn(TurnId.make("turn-1"), "interrupted", "2026-04-01T07:00:10.000Z"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      };

      expect(withSnapshotSettlementEvidence(snapshotThread, null)).toBe(snapshotThread);
    });

    it("keeps settlement evidence that a fresh snapshot no longer names", () => {
      const settledAt = "2026-04-01T07:01:00.000Z";
      const previous: OrchestrationThread = {
        ...baseThread,
        latestTurn: settledTurn(TurnId.make("turn-1"), "interrupted", settledAt),
        settledTurnCompletions: { [TurnId.make("turn-1")]: settledAt },
      };
      const freshSnapshot: OrchestrationThread = {
        ...baseThread,
        latestTurn: settledTurn(TurnId.make("turn-2"), "running", null),
        updatedAt: "2026-04-01T07:03:00.000Z",
      };

      const hydrated = withSnapshotSettlementEvidence(freshSnapshot, previous);

      expect(hydrated.settledTurnCompletions).toEqual({
        [TurnId.make("turn-1")]: settledAt,
      });
      expect(hydrated.latestTurn?.turnId).toBe(TurnId.make("turn-2"));
    });
  });

  describe("thread.session-stop-requested", () => {
    it("marks session as stopped", () => {
      const threadWithSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
      };

      const result = applyThreadDetailEvent(threadWithSession, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("stopped");
        expect(result.thread.session?.activeTurnId).toBeNull();
      }
    });

    it("returns unchanged when no session exists", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.proposed-plan-upserted", () => {
    it("adds a proposed plan", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-01T10:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          proposedPlan: {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "## Plan\n- Do stuff",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T10:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans).toHaveLength(1);
        expect(result.thread.proposedPlans[0]?.id).toBe("plan-1");
      }
    });
  });

  describe("thread.activity-appended", () => {
    it("adds an activity", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.kind).toBe("file-edit");
      }
    });

    it("preserves the complete activity history when live events arrive", () => {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-129"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 129",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 129,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(130);
        expect(result.thread.activities[0]?.id).toBe("activity-0");
      }
    });
  });

  describe("thread.turn-diff-completed", () => {
    it("adds a checkpoint and updates latestTurn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 13,
        occurredAt: "2026-04-01T12:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("msg-3"),
          completedAt: "2026-04-01T12:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
      }
    });
  });

  describe("thread.reverted", () => {
    it("filters entities to retained turns", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Response 1",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "assistant",
            text: "Response 2",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-3"),
            completedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // turn-2 checkpoint is filtered out (turnCount 2 > revert target 1)
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.checkpoints[0]?.turnId).toBe("turn-1");
        // msg-3 (turn-2) is filtered, msg-1 (no turn) and msg-2 (turn-1) remain
        expect(result.thread.messages).toHaveLength(2);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
      }
    });
  });

  describe("no-op events", () => {
    it("returns unchanged for approval-response-requested", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T13:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.approval-response-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          requestId: "req-1",
          decision: "approve",
          createdAt: "2026-04-01T13:00:00.000Z",
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });
});
