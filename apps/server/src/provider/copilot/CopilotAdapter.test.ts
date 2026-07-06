import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type {
  CopilotSession,
  PermissionRequestResult,
  SessionConfigBase,
} from "@github/copilot-sdk";
import {
  ApprovalRequestId,
  CopilotSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { beforeEach } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { CopilotAdapterShape } from "./CopilotAdapter.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";
import { mapCopilotTodosToPlanSteps, normalizeCopilotTodoStatus } from "./CopilotAdapter.ts";

class CopilotAdapterTag extends Context.Service<CopilotAdapterTag, CopilotAdapterShape>()(
  "t3/provider/copilot/CopilotAdapter.test/CopilotAdapterTag",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const PROVIDER = ProviderDriverKind.make("githubCopilot");
const INSTANCE_ID = ProviderInstanceId.make("githubCopilot");

type FakeEventHandler = (event: unknown) => void;

interface FakeCopilotSession {
  readonly sessionId: string;
  readonly on: (eventType: string, handler: FakeEventHandler) => () => void;
  readonly send: (options: unknown) => Promise<string>;
  readonly sendAndWait: (options: unknown) => Promise<unknown>;
  readonly disconnect: () => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly setModel: (model: string, options?: unknown) => Promise<void>;
  readonly rpc: {
    readonly fleet: {
      readonly start: (params: { prompt?: string }) => Promise<{ started: boolean }>;
    };
    readonly plan: {
      readonly readSqlTodosWithDependencies: () => Promise<{
        rows: Array<{ id?: string; title?: string; description?: string; status?: string }>;
        dependencies: Array<{ todoId: string; dependsOn: string }>;
      }>;
    };
  };
  readonly emit: (eventType: string, event: unknown) => void;
  readonly sentMessages: Array<unknown>;
  readonly fleetStarts: Array<{ prompt?: string }>;
  readonly setTodoRows: (
    rows: Array<{ id?: string; title?: string; description?: string; status?: string }>,
  ) => void;
  readonly disconnectCalls: Array<string>;
  readonly abortCalls: number;
  readonly setModelCalls: Array<{ model: string; options: unknown }>;
}

function makeFakeCopilotSession(sessionId: string): FakeCopilotSession {
  const handlers = new Map<string, Set<FakeEventHandler>>();
  const sentMessages: Array<unknown> = [];
  const fleetStarts: Array<{ prompt?: string }> = [];
  const disconnectCalls: Array<string> = [];
  const setModelCalls: Array<{ model: string; options: unknown }> = [];
  let todoRows: Array<{ id?: string; title?: string; description?: string; status?: string }> = [];
  let abortCalls = 0;
  let messageCounter = 0;

  const fake: FakeCopilotSession = {
    sessionId,
    on: (eventType, handler) => {
      const set = handlers.get(eventType) ?? new Set();
      set.add(handler);
      handlers.set(eventType, set);
      return () => {
        set.delete(handler);
      };
    },
    send: async (options) => {
      sentMessages.push(options);
      messageCounter += 1;
      return `message-${messageCounter}`;
    },
    sendAndWait: async (options) => {
      sentMessages.push(options);
      return undefined;
    },
    disconnect: async () => {
      disconnectCalls.push(sessionId);
    },
    abort: async () => {
      abortCalls += 1;
    },
    setModel: async (model, options) => {
      setModelCalls.push({ model, options });
    },
    rpc: {
      fleet: {
        start: async (params) => {
          fleetStarts.push(params);
          return { started: true };
        },
      },
      plan: {
        readSqlTodosWithDependencies: async () => ({ rows: todoRows, dependencies: [] }),
      },
    },
    emit: (eventType, event) => {
      for (const handler of handlers.get(eventType) ?? []) {
        handler(event);
      }
    },
    sentMessages,
    fleetStarts,
    setTodoRows: (rows) => {
      todoRows = rows;
    },
    disconnectCalls,
    get abortCalls() {
      return abortCalls;
    },
    setModelCalls,
  };
  return fake;
}

interface CopilotClientTestDouble {
  readonly createSession: (config: SessionConfigBase) => Promise<CopilotSession>;
  readonly resumeSession: (sessionId: string, config: SessionConfigBase) => Promise<CopilotSession>;
  readonly capturedConfigs: Array<SessionConfigBase>;
  readonly sessionsById: Map<string, FakeCopilotSession>;
  nextSessionId: number;
}

function makeCopilotClientTestDouble(): CopilotClientTestDouble {
  const capturedConfigs: Array<SessionConfigBase> = [];
  const sessionsById = new Map<string, FakeCopilotSession>();
  const testDouble: CopilotClientTestDouble = {
    capturedConfigs,
    sessionsById,
    nextSessionId: 0,
    createSession: async (config) => {
      capturedConfigs.push(config);
      testDouble.nextSessionId += 1;
      const fake = makeFakeCopilotSession(`fake-session-${testDouble.nextSessionId}`);
      sessionsById.set(fake.sessionId, fake);
      return fake as unknown as CopilotSession;
    },
    resumeSession: async (sessionId, config) => {
      capturedConfigs.push(config);
      const fake = sessionsById.get(sessionId) ?? makeFakeCopilotSession(sessionId);
      sessionsById.set(sessionId, fake);
      return fake as unknown as CopilotSession;
    },
  };
  return testDouble;
}

const decodeCopilotSettings = Schema.decodeEffect(CopilotSettings);
const testCopilotSettings = Schema.decodeSync(CopilotSettings)({});

let client: CopilotClientTestDouble;

const CopilotAdapterTestLayer = Layer.unwrap(
  Effect.sync(() => {
    client = makeCopilotClientTestDouble();
    return Layer.effect(
      CopilotAdapterTag,
      makeCopilotAdapter(client, testCopilotSettings, { instanceId: INSTANCE_ID }),
    );
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

function latestSession(): FakeCopilotSession {
  const configs = client.capturedConfigs;
  NodeAssert.ok(configs.length > 0, "expected at least one createSession call");
  const sessions = Array.from(client.sessionsById.values());
  const session = sessions[sessions.length - 1];
  NodeAssert.ok(session, "expected a fake session to have been created");
  return session;
}

function latestOnPermissionRequest() {
  const config = client.capturedConfigs[client.capturedConfigs.length - 1];
  NodeAssert.ok(config?.onPermissionRequest, "expected onPermissionRequest to be configured");
  return config.onPermissionRequest!;
}

it.layer(CopilotAdapterTestLayer)("CopilotAdapterLive", (it) => {
  it.effect("startSession creates a Copilot session scoped to the requested cwd", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const session = yield* adapter.startSession({
        provider: PROVIDER,
        threadId: asThreadId("thread-start"),
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });

      NodeAssert.equal(session.provider, PROVIDER);
      NodeAssert.equal(session.threadId, "thread-start");
      NodeAssert.equal(session.status, "ready");
      NodeAssert.equal(client.capturedConfigs[0]?.workingDirectory, "/tmp/project");
      NodeAssert.equal(client.capturedConfigs[0]?.streaming, true);
    }),
  );

  it.effect("maps assistant.message_delta events to content.delta runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-delta");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "content.delta"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("assistant.message_delta", {
        data: { deltaContent: "Hello", messageId: "msg-1" },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.length, 1);
      const event = events[0]!;
      NodeAssert.equal(event.type, "content.delta");
      if (event.type === "content.delta") {
        NodeAssert.equal(event.payload.streamKind, "assistant_text");
        NodeAssert.equal(event.payload.delta, "Hello");
      }
      NodeAssert.equal(event.itemId, "msg-1");
    }),
  );

  it.effect("maps tool.execution_start/complete to item.started/item.completed", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-tool");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "item.started" || event.type === "item.completed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("tool.execution_start", {
        data: { toolCallId: "call-1", toolName: "bash", arguments: { command: "ls" } },
      });
      fakeSession.emit("tool.execution_complete", {
        data: {
          toolCallId: "call-1",
          success: true,
          toolDescription: { name: "bash" },
          result: { content: "file.txt" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["item.started", "item.completed"],
      );
      NodeAssert.equal(events[0]?.itemId, "call-1");
      if (events[0]?.type === "item.started") {
        NodeAssert.equal(events[0].payload.itemType, "command_execution");
        NodeAssert.equal(events[0].payload.status, "inProgress");
      }
      if (events[1]?.type === "item.completed") {
        NodeAssert.equal(events[1].payload.status, "completed");
      }
    }),
  );

  it.effect("keeps started tool identity and MCP attribution for completion events", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-mcp-tool");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "item.started" || event.type === "item.completed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("tool.execution_start", {
        data: {
          toolCallId: "call-mcp",
          toolName: "server__search",
          mcpServerName: "ai-orch",
          mcpToolName: "search",
          arguments: { query: "status" },
        },
      });
      fakeSession.emit("tool.execution_complete", {
        data: {
          toolCallId: "call-mcp",
          success: true,
          toolDescription: { name: "tool" },
          result: { content: "ok" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      for (const event of events) {
        if (event.type === "item.started" || event.type === "item.completed") {
          NodeAssert.equal(event.payload.itemType, "mcp_tool_call");
          NodeAssert.deepEqual(event.payload.data, {
            toolName: "server__search",
            mcpServerName: "ai-orch",
            mcpToolName: "search",
          });
        }
      }
    }),
  );

  it.effect("falls back when a tool completion arrives without a start event", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-tool-fallback");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "item.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      latestSession().emit("tool.execution_complete", {
        data: {
          toolCallId: "call-fallback",
          success: true,
          toolDescription: { name: "bash" },
          result: { content: "ok" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const event = events[0]!;
      if (event.type === "item.completed") {
        NodeAssert.equal(event.payload.itemType, "command_execution");
        NodeAssert.deepEqual(event.payload.data, { toolName: "bash" });
      }
    }),
  );

  it.effect("clears tool identity after session.idle", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-tool-idle-clear");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "item.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("tool.execution_start", {
        data: {
          toolCallId: "call-idle-clear",
          toolName: "server__search",
          mcpServerName: "ai-orch",
          mcpToolName: "search",
        },
      });
      fakeSession.emit("session.idle", { data: { aborted: false } });
      fakeSession.emit("tool.execution_complete", {
        data: {
          toolCallId: "call-idle-clear",
          success: true,
          toolDescription: { name: "bash" },
          result: { content: "ok" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const event = events[0]!;
      if (event.type === "item.completed") {
        NodeAssert.equal(event.payload.itemType, "command_execution");
        NodeAssert.deepEqual(event.payload.data, { toolName: "bash" });
      }
    }),
  );

  it.effect("clears tool identity after stopSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-tool-stop-clear");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "item.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("tool.execution_start", {
        data: {
          toolCallId: "call-stop-clear",
          toolName: "server__search",
          mcpServerName: "ai-orch",
          mcpToolName: "search",
        },
      });
      yield* adapter.stopSession(threadId);
      fakeSession.emit("tool.execution_complete", {
        data: {
          toolCallId: "call-stop-clear",
          success: true,
          toolDescription: { name: "bash" },
          result: { content: "ok" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const event = events[0]!;
      if (event.type === "item.completed") {
        NodeAssert.equal(event.payload.itemType, "command_execution");
        NodeAssert.deepEqual(event.payload.data, { toolName: "bash" });
      }
    }),
  );

  it.effect("passes configured MCP servers to created sessions", () =>
    Effect.gen(function* () {
      const scopedClient = makeCopilotClientTestDouble();
      const settings = yield* decodeCopilotSettings({
        mcpServers: {
          "ai-orch": {
            type: "http",
            url: "https://governance.example/mcp",
            headers: { Authorization: "Bearer test" },
            tools: ["*"],
          },
        },
      });
      const adapterLayer = Layer.effect(
        CopilotAdapterTag,
        makeCopilotAdapter(scopedClient, settings, { instanceId: INSTANCE_ID }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.build(adapterLayer);
      const adapter = yield* Effect.service(CopilotAdapterTag).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId: asThreadId("thread-mcp-config"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      NodeAssert.deepEqual(scopedClient.capturedConfigs[0]?.mcpServers, settings.mcpServers);

      const resumed = yield* adapter.startSession({
        provider: PROVIDER,
        threadId: asThreadId("thread-mcp-config"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, copilotSessionId: "fake-session-1" },
      });

      NodeAssert.deepEqual(resumed.resumeCursor, {
        schemaVersion: 1,
        copilotSessionId: "fake-session-1",
      });
      NodeAssert.deepEqual(scopedClient.capturedConfigs[1]?.mcpServers, settings.mcpServers);
    }),
  );

  it.effect("passes configured custom agents to created and resumed sessions", () =>
    Effect.gen(function* () {
      const scopedClient = makeCopilotClientTestDouble();
      const settings = yield* decodeCopilotSettings({
        customAgents: [
          {
            name: "reviewer",
            displayName: "Reviewer",
            prompt: "Review the current diff.",
            tools: ["read_file"],
            mcpServers: {
              reviewer_tools: {
                command: "reviewer-mcp",
                args: ["serve"],
                type: "stdio",
              },
            },
            infer: false,
          },
        ],
        defaultAgent: { excludedTools: ["write_file"] },
        activeAgent: "reviewer",
      });
      const adapterLayer = Layer.effect(
        CopilotAdapterTag,
        makeCopilotAdapter(scopedClient, settings, { instanceId: INSTANCE_ID }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.build(adapterLayer);
      const adapter = yield* Effect.service(CopilotAdapterTag).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId: asThreadId("thread-custom-agents"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      NodeAssert.deepEqual(scopedClient.capturedConfigs[0]?.customAgents, [
        {
          name: "reviewer",
          displayName: "Reviewer",
          prompt: "Review the current diff.",
          tools: ["read_file"],
          mcpServers: {
            reviewer_tools: {
              command: "reviewer-mcp",
              args: ["serve"],
              type: "stdio",
            },
          },
          infer: false,
        },
      ]);
      NodeAssert.deepEqual(scopedClient.capturedConfigs[0]?.defaultAgent, {
        excludedTools: ["write_file"],
      });
      NodeAssert.equal(scopedClient.capturedConfigs[0]?.agent, "reviewer");
      NodeAssert.equal(scopedClient.capturedConfigs[0]?.includeSubAgentStreamingEvents, true);

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId: asThreadId("thread-custom-agents"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, copilotSessionId: "fake-session-1" },
      });

      NodeAssert.deepEqual(
        scopedClient.capturedConfigs[1]?.customAgents,
        scopedClient.capturedConfigs[0]?.customAgents,
      );
      NodeAssert.equal(scopedClient.capturedConfigs[1]?.agent, "reviewer");
    }),
  );

  it.effect("steers active Copilot turns with immediate delivery", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-steering-mode");
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const fakeSession = latestSession();
      yield* adapter.sendTurn({ threadId, input: "first" });
      yield* adapter.sendTurn({ threadId, input: "steer" });

      NodeAssert.equal((fakeSession.sentMessages[0] as { mode?: string }).mode, "enqueue");
      NodeAssert.equal((fakeSession.sentMessages[1] as { mode?: string }).mode, "immediate");
    }),
  );

  it.effect("starts fleet mode when enabled", () =>
    Effect.gen(function* () {
      const scopedClient = makeCopilotClientTestDouble();
      const settings = yield* decodeCopilotSettings({ fleetMode: true });
      const adapterLayer = Layer.effect(
        CopilotAdapterTag,
        makeCopilotAdapter(scopedClient, settings, { instanceId: INSTANCE_ID }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.build(adapterLayer);
      const adapter = yield* Effect.service(CopilotAdapterTag).pipe(Effect.provide(context));
      const threadId = asThreadId("thread-fleet");

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "split this up" });

      const session = Array.from(scopedClient.sessionsById.values())[0]!;
      NodeAssert.deepEqual(session.fleetStarts, [{ prompt: "split this up" }]);
      NodeAssert.equal(session.sentMessages.length, 0);
    }),
  );

  it.effect("completes the active turn when session.idle fires", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-idle");
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const result = yield* adapter.sendTurn({ threadId, input: "hi" });
      const fakeSession = latestSession();
      fakeSession.emit("session.idle", { data: { aborted: false } });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.length, 1);
      const event = events[0]!;
      NodeAssert.equal(event.turnId, result.turnId);
      if (event.type === "turn.completed") {
        NodeAssert.equal(event.payload.state, "completed");
      }
    }),
  );

  it.effect("marks the turn cancelled when session.idle reports aborted", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-idle-aborted");
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hi" });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      latestSession().emit("session.idle", { data: { aborted: true } });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const event = events[0]!;
      if (event.type === "turn.completed") {
        NodeAssert.equal(event.payload.state, "cancelled");
      }
    }),
  );

  it.effect("routes onPermissionRequest through respondToRequest (accept)", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-permission-accept");
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const onPermissionRequest = latestOnPermissionRequest();
      const decisionPromise = Promise.resolve(
        onPermissionRequest(
          { kind: "shell", fullCommandText: "rm -rf /", canOfferSessionApproval: true } as never,
          { sessionId: latestSession().sessionId },
        ),
      );

      const opened = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(opened.length, 1);
      const requestId = opened[0]!.requestId;
      NodeAssert.ok(requestId);

      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId!), "accept");
      const decision = yield* Effect.promise(() => decisionPromise);
      NodeAssert.deepEqual(decision, { kind: "approve-once" } satisfies PermissionRequestResult);
    }),
  );

  it.effect("maps a decline decision to a reject permission result", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-permission-decline");
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const onPermissionRequest = latestOnPermissionRequest();
      const decisionPromise = Promise.resolve(
        onPermissionRequest(
          {
            kind: "write",
            fileName: "a.txt",
            intention: "add a line",
            diff: "",
            canOfferSessionApproval: true,
          } as never,
          { sessionId: latestSession().sessionId },
        ),
      );
      const opened = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const requestId = opened[0]!.requestId!;

      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId), "decline");
      const decision = yield* Effect.promise(() => decisionPromise);
      NodeAssert.deepEqual(decision, { kind: "reject" } satisfies PermissionRequestResult);
    }),
  );

  it.effect("auto-approves permission requests in full-access mode without a pending request", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-full-access");
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const onPermissionRequest = latestOnPermissionRequest();
      const decision = yield* Effect.promise(() =>
        Promise.resolve(
          onPermissionRequest(
            { kind: "shell", fullCommandText: "ls", canOfferSessionApproval: true } as never,
            { sessionId: latestSession().sessionId },
          ),
        ),
      );
      NodeAssert.deepEqual(decision, { kind: "approve-once" } satisfies PermissionRequestResult);
    }),
  );

  it.effect("maps SDK usage events with provider turn refs", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-usage");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("assistant.turn_start", { data: { turnId: "sdk-turn-1" } });
      fakeSession.emit("assistant.usage", {
        data: { model: "gpt-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
      });
      fakeSession.emit("assistant.usage", {
        data: { model: "gpt-5", outputTokens: 7, reasoningTokens: 2 },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const last = events[1]!;
      NodeAssert.equal(last.providerRefs?.providerTurnId, "sdk-turn-1");
      NodeAssert.equal(last.raw?.source, "copilot.sdk.session-event");
      if (last.type === "thread.token-usage.updated") {
        NodeAssert.equal(last.payload.usage.usedTokens, 22);
        NodeAssert.equal(last.payload.usage.inputTokens, 10);
        NodeAssert.equal(last.payload.usage.outputTokens, 12);
        NodeAssert.equal(last.payload.usage.reasoningOutputTokens, 2);
        NodeAssert.equal(last.payload.usage.lastUsedTokens, 7);
      }
    }),
  );

  it.effect("maps SDK metadata, error, and subagent events", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-governance-events");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "thread.metadata.updated" ||
              event.type === "runtime.error" ||
              event.type === "task.started" ||
              event.type === "task.completed"),
        ),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("session.usage_checkpoint", { data: { totalNanoAiu: 123 } });
      fakeSession.emit("session.context_changed", {
        data: { cwd: "/tmp/project", branch: "main" },
      });
      fakeSession.emit("session.shutdown", {
        data: {
          shutdownType: "normal",
          codeChanges: { filesModified: ["a.ts"], linesAdded: 1, linesRemoved: 0 },
          modelMetrics: {},
          sessionStartTime: 1,
          totalApiDurationMs: 2,
        },
      });
      fakeSession.emit("session.error", {
        data: { errorType: "provider_error", message: "boom", statusCode: 500 },
      });
      fakeSession.emit("subagent.started", {
        data: {
          toolCallId: "task-1",
          agentName: "reviewer",
          agentDisplayName: "Reviewer",
          agentDescription: "Review code",
        },
      });
      fakeSession.emit("subagent.failed", {
        data: {
          toolCallId: "task-1",
          agentName: "reviewer",
          agentDisplayName: "Reviewer",
          error: "nope",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(
        events.every((event) => event.raw?.source === "copilot.sdk.session-event"),
        true,
      );
      NodeAssert.equal(
        events.filter((event) => event.type === "thread.metadata.updated").length,
        3,
      );
      NodeAssert.equal(
        events.some((event) => event.type === "runtime.error"),
        true,
      );
      NodeAssert.equal(
        events.some((event) => event.type === "task.started"),
        true,
      );
      NodeAssert.equal(
        events.some((event) => event.type === "task.completed"),
        true,
      );
    }),
  );

  it.effect("attributes sub-agent worker output to task.progress (A2)", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-worker-attribution");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.progress" ||
              event.type === "task.completed" ||
              event.type === "content.delta" ||
              event.type === "item.completed"),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("subagent.started", {
        agentId: "agent-1",
        data: {
          toolCallId: "tc-1",
          agentName: "reviewer",
          agentDisplayName: "Reviewer",
          agentDescription: "Review code",
          model: "gpt-5-codex",
        },
      });
      // A mapped worker's streaming delta must produce nothing.
      fakeSession.emit("assistant.message_delta", {
        agentId: "agent-1",
        data: { deltaContent: "partial", messageId: "wmsg-1" },
      });
      // A completed worker message becomes one coalesced progress row.
      fakeSession.emit("assistant.message", {
        agentId: "agent-1",
        data: { content: "Reviewed the diff.\nLooks good.", messageId: "wmsg-1" },
      });
      // A worker tool call becomes one progress row keyed on the tool name.
      fakeSession.emit("tool.execution_start", {
        agentId: "agent-1",
        data: { toolCallId: "wtc-1", toolName: "bash", arguments: { command: "ls" } },
      });
      fakeSession.emit("subagent.completed", {
        agentId: "agent-1",
        data: { toolCallId: "tc-1", agentName: "reviewer", agentDisplayName: "Reviewer" },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));

      // No worker content leaks onto the main thread.
      NodeAssert.equal(
        events.some((event) => event.type === "content.delta" || event.type === "item.completed"),
        false,
      );

      const started = events.find((event) => event.type === "task.started");
      NodeAssert.ok(started && started.type === "task.started");
      NodeAssert.equal(started.payload.agentId, "agent-1");
      NodeAssert.equal(started.payload.model, "gpt-5-codex");
      NodeAssert.equal(started.payload.parentToolCallId, "tc-1");

      const progress = events.filter((event) => event.type === "task.progress");
      NodeAssert.equal(progress.length, 2);
      NodeAssert.equal(
        progress.every(
          (event) => event.type === "task.progress" && event.payload.agentId === "agent-1",
        ),
        true,
      );
      NodeAssert.equal(
        progress.some(
          (event) =>
            event.type === "task.progress" && event.payload.description === "Reviewed the diff.",
        ),
        true,
      );
      NodeAssert.equal(
        progress.some(
          (event) => event.type === "task.progress" && event.payload.description === "`ls`",
        ),
        true,
      );
      NodeAssert.equal(
        progress.some(
          (event) => event.type === "task.progress" && event.payload.lastToolName === "Command run",
        ),
        true,
      );

      const completed = events.find((event) => event.type === "task.completed");
      NodeAssert.ok(completed && completed.type === "task.completed");
      NodeAssert.equal(completed.payload.agentId, "agent-1");
    }),
  );

  it.effect("ignores events tagged with an unknown agentId for task purposes (A2)", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-worker-unknown-agent");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.progress" || event.type === "item.completed"),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      // No subagent.started was seen for "ghost" (e.g. after a resume); the
      // event must not crash the mapping and must fall back to the main thread.
      latestSession().emit("assistant.message", {
        agentId: "ghost",
        data: { content: "Orphan worker output.", messageId: "ghost-msg-1" },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.length, 1);
      NodeAssert.equal(events[0]?.type, "item.completed");
      NodeAssert.equal(
        events.some((event) => event.type === "task.progress"),
        false,
      );
    }),
  );

  it.effect("normalizes todo status and maps rows into plan steps", () =>
    Effect.sync(() => {
      NodeAssert.equal(normalizeCopilotTodoStatus("completed"), "completed");
      NodeAssert.equal(normalizeCopilotTodoStatus("done"), "completed");
      NodeAssert.equal(normalizeCopilotTodoStatus("in_progress"), "inProgress");
      NodeAssert.equal(normalizeCopilotTodoStatus("in progress"), "inProgress");
      NodeAssert.equal(normalizeCopilotTodoStatus("running"), "inProgress");
      NodeAssert.equal(normalizeCopilotTodoStatus("pending"), "pending");
      NodeAssert.equal(normalizeCopilotTodoStatus(undefined), "pending");

      const steps = mapCopilotTodosToPlanSteps([
        { id: "1", title: "Read code", status: "completed" },
        { id: "2", description: "Write fix", status: "in_progress" },
        { id: "3", status: "pending" }, // no text -> dropped
        { id: "4", title: "  ", status: "pending" }, // blank -> dropped
        { id: "5", title: "Verify", status: "queued" },
      ]);
      NodeAssert.deepEqual(steps, [
        { step: "Read code", status: "completed" },
        { step: "Write fix", status: "inProgress" },
        { step: "Verify", status: "pending" },
      ]);
    }),
  );

  it.effect("emits turn.plan.updated from Copilot todos on session.todos_changed", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-copilot-tasklist");
      const planFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.plan.updated"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.setTodoRows([
        { id: "1", title: "Investigate", status: "in_progress" },
        { id: "2", title: "Fix", status: "pending" },
      ]);
      fakeSession.emit("session.todos_changed", { data: {} });

      const events = Array.from(yield* Fiber.join(planFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.length, 1);
      const planEvent = events[0];
      NodeAssert.ok(planEvent && planEvent.type === "turn.plan.updated");
      NodeAssert.deepEqual(planEvent.payload.plan, [
        { step: "Investigate", status: "inProgress" },
        { step: "Fix", status: "pending" },
      ]);
    }),
  );

  it.effect("keeps sub-agent work in the pane and the main agent's result in the main thread", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-worker-result-to-main");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.progress" || event.type === "item.completed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("subagent.started", {
        agentId: "agent-1",
        data: {
          toolCallId: "tc-1",
          agentName: "reviewer",
          agentDisplayName: "Reviewer",
          agentDescription: "Review code",
        },
      });
      // Sub-agent work → pane.
      fakeSession.emit("assistant.message", {
        agentId: "agent-1",
        data: { content: "Checked the diff.", messageId: "wmsg-1" },
      });
      // Main agent's synthesis (no agentId) → main thread (the final result).
      fakeSession.emit("assistant.message", {
        data: { content: "The reviewer found no issues.", messageId: "main-1" },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const workerProgress = events.find((event) => event.type === "task.progress");
      NodeAssert.ok(workerProgress && workerProgress.type === "task.progress");
      NodeAssert.equal(workerProgress.payload.agentId, "agent-1");

      const mainResult = events.find((event) => event.type === "item.completed");
      NodeAssert.ok(mainResult && mainResult.type === "item.completed");
      NodeAssert.equal(mainResult.payload.itemType, "assistant_message");
      NodeAssert.equal(mainResult.payload.detail, "The reviewer found no issues.");
    }),
  );

  it.effect("maps auto-resolved SDK permissions to a resolution only (no phantom prompt)", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-sdk-permission-full-access");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      fakeSession.emit("permission.requested", {
        data: {
          requestId: "sdk-request-1",
          permissionRequest: {
            kind: "shell",
            fullCommandText: "ls",
            canOfferSessionApproval: true,
          },
        },
      });
      fakeSession.emit("permission.completed", {
        data: { requestId: "sdk-request-1", result: { kind: "approved" } },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      // Only a resolution — never a request.opened that would flash a pending
      // approval for a permission the user never had to act on.
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["request.resolved"],
      );
      NodeAssert.equal(events[0]?.requestId, "sdk-request-1");
      NodeAssert.equal(events[0]?.raw?.method, "permission.completed");
    }),
  );

  it.effect("ignores the SDK's repeated permission.completed re-fires (one resolution)", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-dup-permission");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.resolved"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();
      const shell = { kind: "shell", fullCommandText: "ls", canOfferSessionApproval: true };
      fakeSession.emit("permission.requested", {
        data: { requestId: "dup-1", permissionRequest: shell },
      });
      fakeSession.emit("permission.completed", {
        data: { requestId: "dup-1", result: { kind: "approved" } },
      });
      // The SDK re-fires the same completion; this must NOT emit a second resolution.
      fakeSession.emit("permission.completed", {
        data: { requestId: "dup-1", result: { kind: "approved" } },
      });
      // A distinct request confirms the stream advances to the next id, proving
      // the duplicate above produced nothing between them.
      fakeSession.emit("permission.requested", {
        data: { requestId: "dup-2", permissionRequest: shell },
      });
      fakeSession.emit("permission.completed", {
        data: { requestId: "dup-2", result: { kind: "approved" } },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.requestId),
        ["dup-1", "dup-2"],
      );
    }),
  );

  it.effect("stopSession disconnects the underlying Copilot session", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      const threadId = asThreadId("thread-stop");
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const fakeSession = latestSession();

      yield* adapter.stopSession(threadId);

      NodeAssert.deepEqual(fakeSession.disconnectCalls, [fakeSession.sessionId]);
      const hasSession = yield* adapter.hasSession(threadId);
      NodeAssert.equal(hasSession, false);
    }),
  );

  it.effect("stopAll disconnects every open session", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapterTag;
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId: asThreadId("thread-stop-all-a"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId: asThreadId("thread-stop-all-b"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* adapter.stopAll();
      const sessions = yield* adapter.listSessions();
      NodeAssert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;
      const scopedClient = makeCopilotClientTestDouble();

      try {
        const adapterLayer = Layer.effect(
          CopilotAdapterTag,
          makeCopilotAdapter(scopedClient, testCopilotSettings, { instanceId: INSTANCE_ID }),
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(CopilotAdapterTag).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        NodeAssert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );
});

beforeEach(() => {
  // `client` is reassigned per-test via `Layer.unwrap`; nothing to
  // reset here, but `beforeEach` is imported to match sibling adapter
  // test files' structure and keep vitest's per-test isolation explicit.
});
