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
  readonly emit: (eventType: string, event: unknown) => void;
  readonly sentMessages: Array<unknown>;
  readonly disconnectCalls: Array<string>;
  readonly abortCalls: number;
  readonly setModelCalls: Array<{ model: string; options: unknown }>;
}

function makeFakeCopilotSession(sessionId: string): FakeCopilotSession {
  const handlers = new Map<string, Set<FakeEventHandler>>();
  const sentMessages: Array<unknown> = [];
  const disconnectCalls: Array<string> = [];
  const setModelCalls: Array<{ model: string; options: unknown }> = [];
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
    emit: (eventType, event) => {
      for (const handler of handlers.get(eventType) ?? []) {
        handler(event);
      }
    },
    sentMessages,
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
