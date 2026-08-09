import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";

function makeActivity(
  id: string,
  itemType: string,
  data: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: `Completed ${itemType}`,
    payload: {
      itemType,
      detail: `${itemType} detail`,
      status: "completed",
      data,
    },
    turnId: TurnId.make(`turn-${id}`),
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(activities: ReadonlyArray<OrchestrationThreadActivity>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-projection"),
    projectId: ProjectId.make("project-projection"),
    title: "Activity projection",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    goal: null,
    goalStatus: "active",
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
}

// One fixture per provider data shape the adapters produce today:
// Codex item notifications, Claude {toolName, input, result}, ACP
// {toolCallId, kind, rawInput, rawOutput, content, locations}, and Copilot
// {toolName, mcpServerName?, mcpToolName?}.
const codexCommand = makeActivity("codex-command", "command_execution", {
  item: {
    command: ["bash", "-lc", "pnpm test"],
    input: { command: "fallback input", ignored: "input bulk" },
    result: {
      command: "fallback result",
      exitCode: 0,
      aggregatedOutput: "x".repeat(10_000),
    },
    commandActions: [{ type: "unknown", output: "y".repeat(5_000) }],
  },
  ignored: "top-level bulk",
});

const codexFileChange = makeActivity("codex-file-change", "file_change", {
  item: {
    changes: [
      { oldPath: "src/old.ts", newPath: "src/new.ts", patch: "large patch".repeat(1_000) },
      { filePath: "src/second.ts" },
    ],
  },
  ignored: "top-level bulk",
});

const claudeTool = makeActivity("claude-bash", "command_execution", {
  toolName: "Bash",
  input: { command: "pnpm vitest run", description: "Run tests" },
  result: {
    type: "tool_result",
    tool_use_id: "toolu-1",
    content: [{ type: "text", text: "test output ".repeat(2_000) }],
  },
});

const acpTool = makeActivity("acp-tool", "dynamic_tool_call", {
  toolCallId: "tool-acp",
  kind: "execute",
  command: "rg --files",
  rawInput: { command: "rg --files" },
  rawOutput: { content: "src/a.ts\nsrc/b.ts" },
  content: [{ type: "content", content: { type: "text", text: "duplicate bulk" } }],
  locations: [{ path: "src/a.ts" }],
});

const copilotTool = makeActivity("copilot-tool", "command_execution", {
  toolName: "run_in_terminal",
});

const mcpTool = makeActivity("mcp", "mcp_tool_call", {
  item: {
    server: "repository",
    tool: "search",
    arguments: { query: "activity projection" },
    aggregatedOutput: "mcp payload remains available",
  },
  ignored: "MCP data is rendered verbatim",
});

const webSearch = makeActivity("search", "web_search", {
  rawOutput: {
    totalFiles: 42,
    truncated: true,
    content: "content summary line",
  },
  ignored: "top-level bulk",
});

describe("projectActivityPayload", () => {
  it("keeps Codex command fields and exit code while dropping aggregated output", () => {
    const projected = projectActivityPayload(codexCommand);
    expect(projected.payload).toEqual({
      itemType: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      data: {
        item: {
          command: ["bash", "-lc", "pnpm test"],
          input: { command: "fallback input" },
          result: { command: "fallback result", exitCode: 0 },
        },
      },
    });
  });

  it("reduces file changes to their changed file paths", () => {
    expect(projectActivityPayload(codexFileChange).payload).toEqual({
      itemType: "file_change",
      detail: "file_change detail",
      status: "completed",
      data: {
        files: [{ path: "src/new.ts" }, { path: "src/old.ts" }, { path: "src/second.ts" }],
      },
    });
  });

  it("keeps the full Claude tool input but drops the raw result block", () => {
    expect(projectActivityPayload(claudeTool).payload).toEqual({
      itemType: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      data: {
        toolName: "Bash",
        input: { command: "pnpm vitest run", description: "Run tests" },
      },
    });
  });

  it("keeps ACP input and output whole but drops content and location duplicates", () => {
    expect(projectActivityPayload(acpTool).payload).toEqual({
      itemType: "dynamic_tool_call",
      detail: "dynamic_tool_call detail",
      status: "completed",
      data: {
        toolCallId: "tool-acp",
        kind: "execute",
        command: "rg --files",
        rawInput: { command: "rg --files" },
        rawOutput: { content: "src/a.ts\nsrc/b.ts" },
      },
    });
  });

  it("keeps small Copilot tool data intact", () => {
    expect(projectActivityPayload(copilotTool).payload).toEqual({
      itemType: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      data: { toolName: "run_in_terminal" },
    });
  });

  it("keeps structured web search output whole", () => {
    expect(projectActivityPayload(webSearch).payload).toEqual({
      itemType: "web_search",
      detail: "web_search detail",
      status: "completed",
      data: {
        rawOutput: { totalFiles: 42, truncated: true, content: "content summary line" },
      },
    });
  });

  it("passes MCP tool data through unchanged", () => {
    expect(projectActivityPayload(mcpTool)).toBe(mcpTool);
  });

  it("passes activities without a data record through unchanged", () => {
    const plan: OrchestrationThreadActivity = {
      id: EventId.make("plan-activity"),
      tone: "info",
      kind: "turn.plan.updated",
      summary: "Plan updated",
      payload: {
        plan: [{ step: "First step", status: "pending" }],
        explanation: "Doing the work",
      },
      turnId: TurnId.make("turn-plan"),
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    expect(projectActivityPayload(plan)).toBe(plan);

    const task: OrchestrationThreadActivity = {
      id: EventId.make("task-activity"),
      tone: "info",
      kind: "task.progress",
      summary: "Subagent progress",
      payload: {
        taskId: "task-1",
        detail: "Working",
        usage: { totalTokens: 1200, copilotUsage: { totalNanoAiu: 5 } },
      },
      turnId: TurnId.make("turn-task"),
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    expect(projectActivityPayload(task)).toBe(task);
  });

  it("projects snapshot and event transports without mutating their sources", () => {
    const activity = codexCommand;
    const thread = makeThread([activity]);
    const snapshot = { snapshotSequence: 7, thread };
    const projectedSnapshot = projectThreadDetailSnapshot(snapshot);

    expect(projectedSnapshot.thread.activities[0]).not.toBe(activity);
    expect(snapshot.thread.activities[0]).toBe(activity);

    const event = {
      sequence: 8,
      eventId: EventId.make("event-activity"),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: "2026-08-01T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projectedEvent = projectActivityEvent(event);
    expect(projectedEvent).not.toBe(event);
    expect(
      projectedEvent.type === "thread.activity-appended"
        ? projectedEvent.payload.activity
        : undefined,
    ).toEqual(projectActivityPayload(activity));
    expect(event.payload.activity).toBe(activity);
  });

  it("leaves non-activity events untouched", () => {
    const event = {
      sequence: 9,
      eventId: EventId.make("event-other"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-08-01T00:00:02.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.archived",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        archivedAt: "2026-08-01T00:00:02.000Z",
        updatedAt: "2026-08-01T00:00:02.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.archived" }>;
    expect(projectActivityEvent(event)).toBe(event);
  });
});

describe("context-window snapshot dedup", () => {
  function makeContextWindowActivity(
    id: string,
    usedTokens: number,
    turn = `turn-${id}`,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens, maxTokens: 200_000 },
      turnId: TurnId.make(turn),
      createdAt: "2026-08-01T00:00:00.000Z",
    };
  }

  it("keeps only the latest context-window activity per turn in snapshots", () => {
    const stale = makeContextWindowActivity("ctx-1", 1_000, "turn-a");
    const latestA = makeContextWindowActivity("ctx-2", 2_000, "turn-a");
    const latestB = makeContextWindowActivity("ctx-3", 3_000, "turn-b");
    const tool = codexCommand;

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([stale, tool, latestA, latestB]),
    });

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      tool.id,
      latestA.id,
      latestB.id,
    ]);
    // The retained rows keep their payloads untouched: the tool-data
    // projection only rewrites payloads with a `data` record.
    expect(projected.thread.activities[2]?.payload).toEqual(latestB.payload);
  });

  it("keeps a usable row per turn so a revert of the newest turn still resolves", () => {
    // A live thread.reverted makes the client drop all activities from
    // discarded turns; each surviving turn must keep its latest row.
    const olderTurn = makeContextWindowActivity("ctx-old", 1_500, "turn-kept");
    const revertedTurn = makeContextWindowActivity("ctx-new", 9_000, "turn-reverted");

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([olderTurn, revertedTurn]),
    });
    const afterRevert = projected.thread.activities.filter(
      (activity) => activity.turnId === TurnId.make("turn-kept"),
    );

    expect(afterRevert).toEqual([olderTurn]);
  });

  it("does not let a malformed row shadow an earlier valid row in the same turn", () => {
    const valid = makeContextWindowActivity("ctx-valid", 5_000, "turn-a");
    const malformed: OrchestrationThreadActivity = {
      ...makeContextWindowActivity("ctx-broken", 0, "turn-a"),
      payload: { usedTokens: null },
    };

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([valid, malformed]),
    });

    // The malformed row passes through and the valid row survives, so the
    // client's backward walk (which skips rows without a finite usedTokens)
    // still resolves the same value as with the full history.
    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      valid.id,
      malformed.id,
    ]);
  });

  it("leaves snapshots without context-window activities untouched", () => {
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([mcpTool]),
    });
    expect(projected.thread.activities).toEqual([mcpTool]);
  });

  it("does not filter live activity-appended events", () => {
    const activity = makeContextWindowActivity("ctx-live", 4_000);
    const event = {
      sequence: 9,
      eventId: EventId.make("event-ctx"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-08-01T00:00:02.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projected = projectActivityEvent(event);
    expect(
      projected.type === "thread.activity-appended" ? projected.payload.activity : undefined,
    ).toEqual(activity);
  });
});

describe("superseded tool.updated snapshot dedup", () => {
  function makeToolLifecycleActivity(
    id: string,
    kind: "tool.updated" | "tool.completed",
    options: {
      readonly turn?: string;
      readonly itemType?: string;
      readonly title?: string;
      readonly detail?: string;
      readonly toolCallId?: string;
    } = {},
  ): OrchestrationThreadActivity {
    const {
      turn = "turn-a",
      itemType = "file_change",
      title = "File change",
      detail,
      toolCallId,
    } = options;
    return {
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: title,
      payload: {
        itemType,
        title,
        ...(detail ? { detail } : {}),
        data: {
          ...(toolCallId ? { toolCallId } : {}),
          toolName: "Edit",
          input: { file_path: "src/app.ts" },
        },
      },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  function projectedIds(activities: ReadonlyArray<OrchestrationThreadActivity>) {
    return projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    }).thread.activities.map((activity) => activity.id);
  }

  it("drops updates a later completion supersedes in the same turn", () => {
    const update1 = makeToolLifecycleActivity("upd-1", "tool.updated");
    const update2 = makeToolLifecycleActivity("upd-2", "tool.updated");
    const completed = makeToolLifecycleActivity("done-1", "tool.completed");

    expect(projectedIds([update1, update2, completed])).toEqual([completed.id]);
  });

  it("matches on toolCallId when the adapter emits one", () => {
    const otherCall = makeToolLifecycleActivity("upd-other", "tool.updated", {
      toolCallId: "call-b",
    });
    const update = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const completed = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });

    // Same itemType/title, different call: only call-a's update is superseded.
    expect(projectedIds([otherCall, update, completed])).toEqual([otherCall.id, completed.id]);
  });

  it("keeps identities whose fields only collide when concatenated without separators", () => {
    const update = makeToolLifecycleActivity("upd-separated", "tool.updated", {
      itemType: "ab",
      title: "c",
    });
    const completed = makeToolLifecycleActivity("done-other", "tool.completed", {
      itemType: "a",
      title: "bc",
    });

    expect(projectedIds([update, completed])).toEqual([update.id, completed.id]);
  });

  it("keeps updates with no matching completion", () => {
    const inFlight = makeToolLifecycleActivity("upd-live", "tool.updated", { title: "Running" });
    const other = makeToolLifecycleActivity("upd-other", "tool.updated", { title: "Reading" });
    const completed = makeToolLifecycleActivity("done-other", "tool.completed", {
      title: "Reading",
    });

    expect(projectedIds([inFlight, other, completed])).toEqual([inFlight.id, completed.id]);
  });

  it("drops interleaved superseded updates even when a parallel call separates them", () => {
    // Deliberate divergence from the clients' adjacency-based collapse: a
    // superseded update separated from its completion by an interleaved
    // parallel call renders as its own in-flight row on full history, and the
    // snapshot omits it. Its final state still shows via the retained
    // completion (1.5% of dropped rows on real data; see the projection's doc
    // comment).
    const updateA = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const updateB = makeToolLifecycleActivity("upd-b", "tool.updated", { toolCallId: "call-b" });
    const completedA = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });
    const completedB = makeToolLifecycleActivity("done-b", "tool.completed", {
      toolCallId: "call-b",
    });

    expect(projectedIds([updateA, updateB, completedA, completedB])).toEqual([
      completedA.id,
      completedB.id,
    ]);
  });

  it("keeps an update whose completion lives in another turn", () => {
    // A live thread.reverted can discard the completing turn while keeping
    // the updating one, which would leave the call unrepresented.
    const update = makeToolLifecycleActivity("upd-kept", "tool.updated", { turn: "turn-kept" });
    const completed = makeToolLifecycleActivity("done-later", "tool.completed", {
      turn: "turn-reverted",
    });

    expect(projectedIds([update, completed])).toEqual([update.id, completed.id]);
  });

  it("keeps an update that follows its completion", () => {
    // A later update under the same identity is the next call, still in flight.
    const completed = makeToolLifecycleActivity("done-first", "tool.completed");
    const nextCall = makeToolLifecycleActivity("upd-next", "tool.updated");

    expect(projectedIds([completed, nextCall])).toEqual([completed.id, nextCall.id]);
  });

  it("keeps identity-less rows the clients never collapse", () => {
    const anonymous: OrchestrationThreadActivity = {
      id: EventId.make("upd-anon"),
      tone: "tool",
      kind: "tool.updated",
      summary: " ",
      payload: { data: { toolName: "Edit" } },
      turnId: TurnId.make("turn-a"),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    const completed: OrchestrationThreadActivity = {
      ...anonymous,
      id: EventId.make("done-anon"),
      kind: "tool.completed",
    };

    expect(projectedIds([anonymous, completed])).toEqual([anonymous.id, completed.id]);
  });

  it("does not filter live activity-appended events", () => {
    const update = makeToolLifecycleActivity("upd-live-event", "tool.updated");
    const event = {
      sequence: 11,
      eventId: EventId.make("event-tool-updated"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-07-27T00:00:03.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        activity: update,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projected = projectActivityEvent(event);
    expect(
      projected.type === "thread.activity-appended" ? projected.payload.activity.id : undefined,
    ).toEqual(update.id);
  });
});
