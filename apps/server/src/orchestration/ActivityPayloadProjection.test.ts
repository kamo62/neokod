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
