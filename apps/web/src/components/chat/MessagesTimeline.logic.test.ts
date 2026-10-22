import {
  CheckpointRef,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@neokod/contracts";
import {
  applyThreadDetailEvent,
  withSnapshotSettlementEvidence,
} from "@neokod/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  buildToolCallExpandedBody,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  summarizeWorkGroupActivity,
} from "./MessagesTimeline.logic";

describe("summarizeWorkGroupActivity", () => {
  it("uses the activity kinds instead of a generic tool-call count", () => {
    expect(
      summarizeWorkGroupActivity([
        { id: "read", createdAt: "", label: "", tone: "tool", requestKind: "file-read" },
        { id: "run", createdAt: "", label: "", tone: "tool", command: "pytest" },
        { id: "search", createdAt: "", label: "", tone: "tool", itemType: "web_search" },
      ]),
    ).toBe("Read files, Ran commands, Searched");
  });

  it("classifies dynamic tool names and preserves empty and mixed summaries", () => {
    expect(summarizeWorkGroupActivity([])).toBe("Worked");
    expect(
      summarizeWorkGroupActivity([
        { id: "read", createdAt: "", label: "", tone: "tool", toolName: "Read" },
      ]),
    ).toBe("Read files");
    expect(
      summarizeWorkGroupActivity([
        { id: "read", createdAt: "", label: "", tone: "tool", toolName: "Read" },
        { id: "unknown", createdAt: "", label: "", tone: "tool", toolName: "Custom" },
      ]),
    ).toBe("Read files, Worked");
  });
});

describe("buildToolCallExpandedBody", () => {
  it("keeps input-only tools expandable and includes full raw output", () => {
    expect(
      buildToolCallExpandedBody(
        {
          id: "read",
          createdAt: "",
          label: "Read",
          tone: "tool",
          toolName: "Read",
          toolInput: { path: "/outside/src/spec.py" },
          toolOutput: { content: "first\nsecond" },
        },
        "/workspace",
      ),
    ).toContain('Input\n{\n  "path": "/outside/src/spec.py"\n}');
    expect(
      buildToolCallExpandedBody(
        { id: "empty", createdAt: "", label: "Tool", tone: "tool" },
        "/workspace",
      ),
    ).toBe("No input or output provided.");
  });

  it("renders quota guidance and generic provider messages instead of the empty fallback", () => {
    const quotaMessage =
      "GitHub Copilot monthly quota exceeded. Switch to another provider (Claude or Codex) until it resets next month.";
    const genericMessage = "Copilot service unavailable";

    expect(
      buildToolCallExpandedBody(
        {
          id: "quota-error",
          createdAt: "",
          label: "Runtime error",
          tone: "error",
          detail: quotaMessage,
        },
        "/workspace",
      ),
    ).toBe(quotaMessage);
    expect(
      buildToolCallExpandedBody(
        {
          id: "provider-error",
          createdAt: "",
          label: "Runtime error",
          tone: "error",
          detail: genericMessage,
        },
        "/workspace",
      ),
    ).toBe(genericMessage);
    expect(quotaMessage).not.toBe("No input or output provided.");
    expect(genericMessage).not.toBe("No input or output provided.");
  });
});

describe("in-progress tool visibility", () => {
  it("keeps neutral in-progress tools in timeline rows", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "tool-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "tool",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Read",
            tone: "tool",
            toolLifecycleStatus: "inProgress",
          },
        },
      ],
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows).toContainEqual(expect.objectContaining({ kind: "work" }));
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          turnId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            turnId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        turnId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("settles a terminal turn with unknown completion without a false zero duration", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry-1",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "go",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:20Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const fold = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(fold?.label).toContain("You stopped");
    expect(fold?.label).not.toMatch(/\b0s\b/);

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.id === ("assistant-final" as never),
    );
    expect(assistantRow?.showAssistantMeta).toBe(true);
    expect(assistantRow?.showAssistantCopyButton).toBe(true);
    expect(assistantRow?.assistantCopyStreaming).toBe(false);
  });

  it("keeps an explicitly unknown latest turn duration-free after recovery activity", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry-recovered",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-recovered" as never,
            role: "user",
            text: "go",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-recovered",
          kind: "work",
          createdAt: "2026-01-02T08:00:00Z",
          entry: {
            id: "synthetic-recovery-activity",
            createdAt: "2026-01-02T08:00:00Z",
            turnId: "turn-recovered" as never,
            label: "Tool orphaned",
            tone: "tool" as const,
            synthetic: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-recovered" as never,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const fold = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(fold?.label).toBe("You stopped this response");
    expect(fold?.label).not.toContain("after");
  });

  it("keeps a recovered turn duration-free after a subsequent turn starts", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry-recovered-historical",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-recovered-historical" as never,
            role: "user",
            text: "go",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-recovered-historical",
          kind: "work",
          createdAt: "2026-01-02T08:00:00Z",
          entry: {
            id: "synthetic-recovery-activity-historical",
            createdAt: "2026-01-02T08:00:00Z",
            turnId: "turn-recovered" as never,
            label: "Tool orphaned",
            tone: "tool" as const,
            synthetic: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-next" as never,
        state: "running",
        startedAt: "2026-01-02T09:00:00Z",
        completedAt: null,
      },
      turnCompletionByTurnId: new Map([
        ["turn-recovered" as never, null],
        ["turn-next" as never, null],
      ]),
      isWorking: true,
      activeTurnStartedAt: "2026-01-02T09:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const fold = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(fold?.label).toBe("Worked");
    expect(fold?.label).not.toContain("for");
  });

  it("uses the reducer's per-turn settlement after later work starts", () => {
    const turnA = TurnId.make("turn-reducer-a");
    const turnB = TurnId.make("turn-reducer-b");
    const baseThread: OrchestrationThread = {
      id: ThreadId.make("thread-reducer"),
      projectId: ProjectId.make("project-reducer"),
      title: "Reducer thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId: turnA,
        state: "running",
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      settledTurnCompletions: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [
        {
          turnId: turnA,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-reducer-a"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:10.000Z",
        },
      ],
      session: {
        threadId: ThreadId.make("thread-reducer"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnA,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const baseEventFields = {
      eventId: EventId.make("event-reducer"),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    } as const;
    const completionMap = (thread: OrchestrationThread) => {
      const map = new Map<TurnId, string | null>();
      for (const turnId of Object.keys(thread.settledTurnCompletions ?? {}) as TurnId[]) {
        map.set(turnId, thread.settledTurnCompletions?.[turnId] ?? null);
      }
      const latest = thread.latestTurn;
      if (latest !== null && !map.has(latest.turnId)) {
        map.set(latest.turnId, latest.completedAt);
      }
      return map;
    };

    for (const scenario of [
      { completedAt: "2026-01-01T00:01:00.000Z", expected: "Worked for 1m" },
      { completedAt: null, expected: "Worked" },
    ] as const) {
      const recovered = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-01-01T00:02:00.000Z",
        aggregateKind: "thread",
        aggregateId: baseThread.id,
        type: "thread.session-set",
        payload: {
          threadId: baseThread.id,
          session: {
            threadId: baseThread.id,
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:02:00.000Z",
          },
          interruptedTurnId: turnA,
          latestTurnCompletedAt: scenario.completedAt,
        },
      });
      expect(recovered.kind).toBe("updated");
      if (recovered.kind !== "updated") continue;

      const next = applyThreadDetailEvent(recovered.thread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-01-01T00:03:00.000Z",
        aggregateKind: "thread",
        aggregateId: baseThread.id,
        type: "thread.session-set",
        payload: {
          threadId: baseThread.id,
          session: {
            threadId: baseThread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnB,
            lastError: null,
            updatedAt: "2026-01-01T00:03:00.000Z",
          },
        },
      });
      expect(next.kind).toBe("updated");
      if (next.kind !== "updated") continue;

      expect(next.thread.settledTurnCompletions?.[turnA]).toBe(scenario.completedAt);
      if (scenario.completedAt !== null) {
        expect(next.thread.checkpoints[0]?.completedAt).toBe(scenario.completedAt);
      }

      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "user-entry-reducer",
            kind: "message",
            createdAt: "2026-01-01T00:00:00.000Z",
            message: {
              id: "user-reducer" as never,
              role: "user",
              text: "go",
              turnId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              streaming: false,
            },
          },
          {
            id: "work-entry-reducer",
            kind: "work",
            createdAt: "2026-01-01T00:00:05.000Z",
            entry: {
              id: "work-reducer",
              createdAt: "2026-01-01T00:00:05.000Z",
              turnId: turnA,
              label: "Read file",
              tone: "tool" as const,
            },
          },
        ],
        latestTurn: next.thread.latestTurn,
        turnCompletionByTurnId: completionMap(next.thread),
        runningTurnId: turnB,
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:03:00.000Z",
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

      const fold = rows.find(
        (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
          row.kind === "turn-fold",
      );
      expect(fold?.label).toBe(scenario.expected);
    }
  });

  it("keeps a snapshot-loaded interrupted turn's duration after the next turn starts", () => {
    const turnA = TurnId.make("turn-snapshot-a");
    const turnB = TurnId.make("turn-snapshot-b");
    const snapshotThread: OrchestrationThread = {
      id: ThreadId.make("thread-snapshot"),
      projectId: ProjectId.make("project-snapshot"),
      title: "Snapshot thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      // A recovered server snapshot names the interrupted turn and its
      // authoritative completion, but the client settlement record is absent.
      latestTurn: {
        turnId: turnA,
        state: "interrupted",
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        assistantMessageId: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [
        {
          turnId: turnA,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-snapshot-a"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:10.000Z",
        },
      ],
      session: {
        threadId: ThreadId.make("thread-snapshot"),
        status: "interrupted",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:02:00.000Z",
      },
    };
    const baseEventFields = {
      eventId: EventId.make("event-snapshot"),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    } as const;
    const completionMap = (thread: OrchestrationThread) => {
      const map = new Map<TurnId, string | null>();
      for (const turnId of Object.keys(thread.settledTurnCompletions ?? {}) as TurnId[]) {
        map.set(turnId, thread.settledTurnCompletions?.[turnId] ?? null);
      }
      if (thread.latestTurn !== null && !map.has(thread.latestTurn.turnId)) {
        map.set(thread.latestTurn.turnId, thread.latestTurn.completedAt);
      }
      return map;
    };
    const timelineEntries = [
      {
        id: "user-entry-snapshot",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        message: {
          id: "user-snapshot" as never,
          role: "user" as const,
          text: "go",
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-snapshot",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:05.000Z",
        entry: {
          id: "work-snapshot",
          createdAt: "2026-01-01T00:00:05.000Z",
          turnId: turnA,
          label: "Read file",
          tone: "tool" as const,
        },
      },
    ];
    const foldLabel = (thread: OrchestrationThread, runningTurnId: TurnId | null) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn: thread.latestTurn,
        turnCompletionByTurnId: completionMap(thread),
        runningTurnId,
        isWorking: runningTurnId !== null,
        activeTurnStartedAt: runningTurnId === null ? null : (thread.latestTurn?.startedAt ?? null),
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });
      const fold = rows.find(
        (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
          row.kind === "turn-fold",
      );
      return fold?.label;
    };

    for (const scenario of [
      { completedAt: "2026-01-01T00:01:00.000Z", settled: "Worked for 1m" },
      { completedAt: null, settled: "Worked" },
    ] as const) {
      const loaded: OrchestrationThread = {
        ...snapshotThread,
        latestTurn: { ...snapshotThread.latestTurn!, completedAt: scenario.completedAt },
      };
      // Before the next turn starts, the snapshot's latest turn is the only
      // completion evidence available.
      expect(foldLabel(loaded, null)).toMatch(/^You stopped/);

      const next = applyThreadDetailEvent(loaded, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-01-01T00:03:00.000Z",
        aggregateKind: "thread",
        aggregateId: loaded.id,
        type: "thread.session-set",
        payload: {
          threadId: loaded.id,
          session: {
            threadId: loaded.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnB,
            lastError: null,
            updatedAt: "2026-01-01T00:03:00.000Z",
          },
        },
      });
      expect(next.kind).toBe("updated");
      if (next.kind !== "updated") continue;

      expect(foldLabel(next.thread, turnB)).toBe(scenario.settled);

      // A fresh snapshot taken after the next turn started no longer names the
      // recovered turn: the client record must survive the replacement.
      const refreshedSnapshot: OrchestrationThread = {
        ...snapshotThread,
        latestTurn: {
          turnId: turnB,
          state: "running",
          requestedAt: "2026-01-01T00:03:00.000Z",
          startedAt: "2026-01-01T00:03:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: snapshotThread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: turnB,
          lastError: null,
          updatedAt: "2026-01-01T00:03:00.000Z",
        },
        updatedAt: "2026-01-01T00:03:00.000Z",
      };
      const refreshed = withSnapshotSettlementEvidence(refreshedSnapshot, next.thread);
      expect(foldLabel(refreshed, turnB)).toBe(scenario.settled);
    }
  });

  it("keeps the real completion when an interrupt request fails", () => {
    const turnId = TurnId.make("turn-interrupt");
    const startedAt = "2026-01-01T00:00:00.000Z";
    const requestedAt = "2026-01-01T00:00:10.000Z";
    const completedAt = "2026-01-01T00:00:30.000Z";
    const running: OrchestrationThread = {
      id: ThreadId.make("thread-interrupt"),
      projectId: ProjectId.make("project-interrupt"),
      title: "Interrupt thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: startedAt,
        startedAt,
        completedAt: null,
        assistantMessageId: null,
      },
      createdAt: startedAt,
      updatedAt: startedAt,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [
        {
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-interrupt"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:05.000Z",
        },
      ],
      session: {
        threadId: ThreadId.make("thread-interrupt"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: startedAt,
      },
    };
    const baseEventFields = {
      eventId: EventId.make("event-interrupt"),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    } as const;
    const foldLabel = (thread: OrchestrationThread) => {
      const completions = new Map<TurnId, string | null>();
      for (const id of Object.keys(thread.settledTurnCompletions ?? {}) as TurnId[]) {
        completions.set(id, thread.settledTurnCompletions?.[id] ?? null);
      }
      if (thread.latestTurn !== null && !completions.has(thread.latestTurn.turnId)) {
        completions.set(thread.latestTurn.turnId, thread.latestTurn.completedAt);
      }
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "user-entry-interrupt",
            kind: "message",
            createdAt: startedAt,
            message: {
              id: "user-interrupt" as never,
              role: "user",
              text: "go",
              turnId: null,
              createdAt: startedAt,
              updatedAt: startedAt,
              streaming: false,
            },
          },
          {
            id: "work-entry-interrupt",
            kind: "work",
            createdAt: "2026-01-01T00:00:05.000Z",
            entry: {
              id: "work-interrupt",
              createdAt: "2026-01-01T00:00:05.000Z",
              turnId,
              label: "Read file",
              tone: "tool" as const,
            },
          },
        ],
        latestTurn: thread.latestTurn,
        turnCompletionByTurnId: completions,
        runningTurnId: thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null,
        isWorking: thread.latestTurn?.state === "running",
        activeTurnStartedAt:
          thread.latestTurn?.state === "running" ? thread.latestTurn.startedAt : null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });
      return rows.find(
        (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
          row.kind === "turn-fold",
      )?.label;
    };

    const interrupted = applyThreadDetailEvent(running, {
      ...baseEventFields,
      sequence: 1,
      occurredAt: requestedAt,
      aggregateKind: "thread",
      aggregateId: running.id,
      type: "thread.turn-interrupt-requested",
      payload: { threadId: running.id, turnId, createdAt: requestedAt },
    });
    expect(interrupted.kind).toBe("updated");
    if (interrupted.kind !== "updated") return;

    // The interrupt fails and the provider keeps streaming the turn.
    const streaming = applyThreadDetailEvent(interrupted.thread, {
      ...baseEventFields,
      sequence: 2,
      occurredAt: "2026-01-01T00:00:20.000Z",
      aggregateKind: "thread",
      aggregateId: running.id,
      type: "thread.message-sent",
      payload: {
        threadId: running.id,
        messageId: "msg-interrupt" as never,
        role: "assistant",
        text: "Still working.",
        turnId,
        streaming: true,
        createdAt: "2026-01-01T00:00:20.000Z",
        updatedAt: "2026-01-01T00:00:20.000Z",
      },
    });
    expect(streaming.kind).toBe("updated");
    if (streaming.kind !== "updated") return;

    const settled = applyThreadDetailEvent(streaming.thread, {
      ...baseEventFields,
      sequence: 3,
      occurredAt: completedAt,
      aggregateKind: "thread",
      aggregateId: running.id,
      type: "thread.session-set",
      payload: {
        threadId: running.id,
        session: {
          threadId: running.id,
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

    // The requested interrupt boundary must not shorten the turn.
    expect(foldLabel(settled.thread)).toBe("Worked for 30s");
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestTurn still points at the
    // previous, settled turn — it must stay folded through that window.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "assistant-thought-entry",
      "work-entry-1",
      "working-indicator-row",
    ]);
  });

  it("does not fold the session's running turn when latestTurn regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            turnId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningTurnId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.turnId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("running-work-entry");
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
  });

  it("models work log overflow expansion as inserted list rows", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "edit",
          detail: "Editing MessagesTimeline.tsx",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-3", "work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 2,
      expanded: false,
      onlyToolEntries: true,
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-1",
      "work-2",
      "work-3",
      "work-toggle:work-entry-1",
    ]);
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});
