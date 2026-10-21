import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@neokod/contracts";
import { createModelSelection } from "@neokod/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  isTerminalOpenCodeRetryMessage,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "neokod/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

const createDeferred = (): Deferred => {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    messagesCalls: [] as Array<unknown>,
    permissionReplyCalls: [] as Array<unknown>,
    questionReplyCalls: [] as Array<unknown>,
    subscribedEvents: [] as unknown[],
    eventsAfterAbort: [] as unknown[],
    eventsAfterAbortAfterPrompts: 1,
    eventsAfterAbortResponse: [] as unknown[],
    holdSubscribedEventsUntilPrompt: false,
    holdAbortResponse: false,
    abortResponseGate: null as Deferred | null,
    holdLateAbortEcho: false,
    lateAbortEchoGate: null as Deferred | null,
    onPromptCall: null as (() => void) | null,
    onAbortCall: null as (() => void) | null,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.messagesCalls.length = 0;
    this.state.permissionReplyCalls.length = 0;
    this.state.questionReplyCalls.length = 0;
    this.state.subscribedEvents = [];
    this.state.eventsAfterAbort = [];
    this.state.eventsAfterAbortAfterPrompts = 1;
    this.state.eventsAfterAbortResponse = [];
    this.state.holdSubscribedEventsUntilPrompt = false;
    this.state.holdAbortResponse = false;
    this.state.abortResponseGate = null;
    this.state.holdLateAbortEcho = false;
    this.state.lateAbortEchoGate = null;
    this.state.onPromptCall = null;
    this.state.onAbortCall = null;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
        serverPassword: "spawned-password",
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Unconditionally register a scope finalizer for test observability —
      // preserves the `closeCalls` / `closeError` probes that the existing
      // suites rely on. Production code never attaches a finalizer to an
      // external server (it simply returns `Effect.succeed(...)`).
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
        ...(serverUrl ? {} : { serverPassword: "spawned-password" }),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async () => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
          runtimeMock.state.onAbortCall?.();
          if (runtimeMock.state.holdAbortResponse) {
            await runtimeMock.state.abortResponseGate?.promise;
          }
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
          runtimeMock.state.onPromptCall?.();
        },
        messages: async (input: unknown) => {
          runtimeMock.state.messagesCalls.push(input);
          return { data: runtimeMock.state.messages };
        },
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      permission: {
        reply: async (input: unknown) => {
          runtimeMock.state.permissionReplyCalls.push(input);
        },
      },
      question: {
        reply: async (input: unknown) => {
          runtimeMock.state.questionReplyCalls.push(input);
        },
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            // Optional gate for tests whose subscribed events depend on turn
            // state: hold the replay until the first accepted prompt so
            // sendTurn has assigned the active turn id before the pump sees
            // the events. Without it the pump can drain the array first.
            if (
              runtimeMock.state.holdSubscribedEventsUntilPrompt &&
              runtimeMock.state.promptCalls.length === 0
            ) {
              await new Promise<void>((resolve) => {
                runtimeMock.state.onPromptCall = resolve;
              });
            }
            for (const event of runtimeMock.state.subscribedEvents) {
              yield event;
            }
            if (runtimeMock.state.eventsAfterAbort.length > 0) {
              while (
                runtimeMock.state.promptCalls.length <
                runtimeMock.state.eventsAfterAbortAfterPrompts
              ) {
                await new Promise<void>((resolve) => {
                  runtimeMock.state.onPromptCall = resolve;
                });
              }
              if (runtimeMock.state.abortCalls.length === 0) {
                await new Promise<void>((resolve) => {
                  runtimeMock.state.onAbortCall = resolve;
                });
              }
              for (const event of runtimeMock.state.eventsAfterAbort) {
                yield event;
              }
              if (runtimeMock.state.holdLateAbortEcho) {
                await runtimeMock.state.lateAbortEchoGate?.promise;
                for (const event of runtimeMock.state.eventsAfterAbortResponse) {
                  yield event;
                }
              }
            }
          })(),
        }),
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

// A spawned-server configuration: the settings password must be ignored in
// favour of the password generated for that child process.
const openCodeLocalServerTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "",
  serverPassword: "configured-password-must-not-be-used",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

/**
 * Join a forked event-collector fiber, bounding the wait with a real timer
 * instead of `Effect.timeout`: the suite runs on the TestClock, so a clock
 * timeout would only fire if the test advanced it, and a regression where the
 * awaited events never arrive would hang to the vitest budget instead of
 * failing the assertion. Returns `Option.none()` when the deadline passes.
 */
const joinWithinRealTime = <A, E>(fiber: Fiber.Fiber<A, E>, millis: number) =>
  Effect.race(
    Fiber.join(fiber).pipe(Effect.map(Option.some)),
    Effect.promise<Option.Option<A>>(
      (signal) =>
        new Promise((resolve) => {
          // @effect-diagnostics-next-line globalTimers:off
          const timer = setTimeout(() => resolve(Option.none()), millis);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve(Option.none());
          });
        }),
    ),
  );

/**
 * Real-time sleep for the abort-echo tests: the suite runs on the TestClock,
 * so `Effect.sleep` would never elapse without an explicit adjust.
 */
const sleepReal = (millis: number) =>
  Effect.promise<void>(
    () =>
      new Promise((resolve) => {
        // @effect-diagnostics-next-line globalTimers:off
        setTimeout(resolve, millis);
      }),
  );

const collectThreadEvents = (adapter: OpenCodeAdapterShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
    yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId),
      Stream.runForEach((event) => Ref.update(events, (current) => [...current, event])),
      Effect.forkChild,
    );
    return events;
  });

const waitForThreadEvents = (
  events: Ref.Ref<ReadonlyArray<ProviderRuntimeEvent>>,
  predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
  millis: number,
) => {
  const poll = (remaining: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (predicate(yield* Ref.get(events))) {
        return true;
      }
      if (remaining <= 0) {
        return false;
      }
      yield* sleepReal(10);
      return yield* poll(remaining - 1);
    });
  return poll(Math.ceil(millis / 10));
};

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "opencode");
      NodeAssert.equal(session.threadId, "thread-opencode");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("spawned local server clients authenticate with the generated password", () => {
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeLocalServerTestSettings),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode-local-password"),
        runtimeMode: "full-access",
      });

      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:spawned-password")}`,
      ]);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      NodeAssert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
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

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "prompt failed");
      NodeAssert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("resolves pending permissions when the session errors", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-session-error-permission");
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            id: "permission-session-error",
            permission: "bash",
            patterns: ["bun test"],
            metadata: {},
          },
        },
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: { data: { message: "session failed" } },
          },
        },
      ];
      const resolvedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.resolved"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const resolved = Array.from(
        yield* Fiber.join(resolvedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.deepEqual(resolved[0]?.payload, {
        requestType: "command_execution_approval",
        decision: "cancel",
      });

      const error = yield* adapter
        .respondToRequest(threadId, asApprovalRequestId("permission-session-error"), "accept")
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.detail,
        "Unknown pending permission request: permission-session-error",
      );
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, []);
    }),
  );

  it.effect("settles the active turn when OpenCode retries a terminal credential failure", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-terminal-retry");
      runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
      const retryStatusEvent = (attempt: number) => ({
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: {
            type: "retry",
            attempt,
            message: "Internal Server Error: Invalid API key",
            next: 1754006400000,
          },
        },
      });
      // Two identical retries mirror the production incident. The second one
      // arrives after the first has settled the turn and must not settle,
      // warn, or abort again.
      runtimeMock.state.subscribedEvents = [retryStatusEvent(1), retryStatusEvent(2)];
      runtimeMock.state.eventsAfterAbort = [
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          },
        },
      ];
      const collected = yield* collectThreadEvents(adapter, threadId);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      const settled = yield* waitForThreadEvents(
        collected,
        (events) => events.filter((event) => event.type === "turn.completed").length === 1,
        2_000,
      );
      NodeAssert.equal(
        settled,
        true,
        "terminal retry must settle the turn instead of only warning",
      );
      // Give the abort echo time to arrive. Before the mark was set on the
      // retry abort it settled the already-dead turn a second time.
      yield* sleepReal(200);
      const events = (yield* Ref.get(collected)).filter(
        (event) =>
          event.type === "turn.completed" ||
          event.type === "runtime.error" ||
          event.type === "runtime.warning",
      );
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.completed", "runtime.error"],
      );
      const completed = events[0];
      if (completed?.type !== "turn.completed") {
        throw new Error("Expected a turn.completed event");
      }
      NodeAssert.equal(String(completed.turnId), String(turn.turnId));
      NodeAssert.deepEqual(completed.payload, {
        state: "failed",
        errorMessage: "Internal Server Error: Invalid API key",
      });
      const runtimeError = events[1];
      if (runtimeError?.type !== "runtime.error") {
        throw new Error("Expected a runtime.error event");
      }
      NodeAssert.equal(runtimeError.payload.message, "Internal Server Error: Invalid API key");
      NodeAssert.equal(runtimeError.payload.class, "provider_error");

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "error");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.equal(session?.lastError, "Internal Server Error: Invalid API key");
      // Exactly one abort: the settlement stopped OpenCode's retry loop, and
      // the second retry event did not trigger a duplicate settlement.
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
    }),
  );

  it.effect("settles Stop as interrupted when the abort echo arrives as MessageAbortedError", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-abort-error");
      runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
      runtimeMock.state.eventsAfterAbort = [
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          },
        },
      ];
      const collected = yield* collectThreadEvents(adapter, threadId);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      yield* adapter.interruptTurn(threadId, turn.turnId);

      const settled = yield* waitForThreadEvents(
        collected,
        (events) => events.some((event) => event.type === "turn.completed"),
        2_000,
      );
      NodeAssert.equal(settled, true, "Stop must settle the turn");
      yield* sleepReal(200);
      const events = yield* Ref.get(collected);
      const completed = events.filter((event) => event.type === "turn.completed");
      NodeAssert.equal(completed.length, 1, "the abort echo must not settle the turn twice");
      const completedEvent = completed[0];
      if (completedEvent?.type !== "turn.completed") {
        throw new Error("Expected a turn.completed event");
      }
      NodeAssert.equal(String(completedEvent.turnId), String(turn.turnId));
      NodeAssert.deepEqual(completedEvent.payload, { state: "interrupted" });
      NodeAssert.equal(
        events.filter((event) => event.type === "runtime.error").length,
        0,
        "a user interrupt must not emit runtime.error",
      );

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.equal(session?.lastError, undefined);
    }),
  );

  it.effect("reports interrupted when idle wins the race against the abort echo", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-idle-race");
      runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
      runtimeMock.state.eventsAfterAbort = [
        {
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            status: { type: "idle" },
          },
        },
      ];
      const collected = yield* collectThreadEvents(adapter, threadId);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      yield* adapter.interruptTurn(threadId, turn.turnId);

      const settled = yield* waitForThreadEvents(
        collected,
        (events) => events.some((event) => event.type === "turn.completed"),
        2_000,
      );
      NodeAssert.equal(settled, true, "idle after Stop must settle the turn");
      yield* sleepReal(200);
      const completed = (yield* Ref.get(collected)).filter(
        (event) => event.type === "turn.completed",
      );
      NodeAssert.equal(completed.length, 1);
      const completedEvent = completed[0];
      if (completedEvent?.type !== "turn.completed") {
        throw new Error("Expected a turn.completed event");
      }
      NodeAssert.equal(String(completedEvent.turnId), String(turn.turnId));
      NodeAssert.deepEqual(completedEvent.payload, { state: "interrupted" });
    }),
  );

  it.effect(
    "settles one interrupted turn and resolves pending requests when idle wins before the abort response",
    () => {
      const abortResponseGate = createDeferred();
      const lateAbortEchoGate = createDeferred();
      // Release both gates even when an assertion fails, so a regression cannot
      // leave the fake abort or the event stream blocked during teardown.
      const releaseGates = Effect.sync(() => {
        abortResponseGate.resolve();
        lateAbortEchoGate.resolve();
      });
      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-stop-idle-before-abort-response");
        runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
        runtimeMock.state.holdAbortResponse = true;
        runtimeMock.state.abortResponseGate = abortResponseGate;
        runtimeMock.state.holdLateAbortEcho = true;
        runtimeMock.state.lateAbortEchoGate = lateAbortEchoGate;
        runtimeMock.state.subscribedEvents = [
          {
            type: "permission.asked",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              id: "permission-idle-race",
              permission: "bash",
              patterns: ["bun test"],
              metadata: {},
            },
          },
          {
            type: "question.asked",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              id: "question-idle-race",
              questions: [
                {
                  header: "Pick a path",
                  question: "Which path should I take?",
                  options: [{ label: "A", description: "Path A" }],
                },
              ],
            },
          },
        ];
        // The idle echo is delivered while session.abort is still in flight; the
        // late MessageAbortedError follows only after the abort response returns.
        runtimeMock.state.eventsAfterAbort = [
          {
            type: "session.status",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              status: { type: "idle" },
            },
          },
        ];
        runtimeMock.state.eventsAfterAbortResponse = [
          {
            type: "session.error",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              error: { name: "MessageAbortedError", data: { message: "Aborted" } },
            },
          },
        ];
        const collected = yield* collectThreadEvents(adapter, threadId);

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });

        const opened = yield* waitForThreadEvents(
          collected,
          (events) =>
            events.some((event) => event.type === "request.opened") &&
            events.some((event) => event.type === "user-input.requested"),
          2_000,
        );
        NodeAssert.equal(opened, true, "the approval and question must be pending before Stop");

        const interruptFiber = yield* adapter
          .interruptTurn(threadId, turn.turnId)
          .pipe(Effect.forkChild);

        // session.abort is blocked, so an idle settlement here proves idle beat
        // the abort response.
        const settled = yield* waitForThreadEvents(
          collected,
          (events) => events.some((event) => event.type === "turn.completed"),
          2_000,
        );
        NodeAssert.equal(settled, true, "idle must settle the turn before session.abort returns");

        const afterIdle = yield* Ref.get(collected);
        const completed = afterIdle.filter((event) => event.type === "turn.completed");
        NodeAssert.equal(completed.length, 1, "idle must publish exactly one terminal event");
        const completedEvent = completed[0];
        if (completedEvent?.type !== "turn.completed") {
          throw new Error("Expected a turn.completed event");
        }
        NodeAssert.equal(String(completedEvent.turnId), String(turn.turnId));
        NodeAssert.deepEqual(completedEvent.payload, { state: "interrupted" });
        NodeAssert.equal(
          afterIdle.filter((event) => event.type === "turn.aborted").length,
          0,
          "the abort response must still be in flight",
        );
        NodeAssert.equal(
          afterIdle.filter((event) => event.type === "request.resolved").length,
          1,
          "idle settlement must resolve the pending approval once",
        );
        NodeAssert.equal(
          afterIdle.filter((event) => event.type === "user-input.resolved").length,
          1,
          "idle settlement must resolve the pending question once",
        );

        const permissionError = yield* adapter
          .respondToRequest(threadId, asApprovalRequestId("permission-idle-race"), "accept")
          .pipe(Effect.flip);
        NodeAssert.equal(permissionError._tag, "ProviderAdapterRequestError");
        if (permissionError._tag !== "ProviderAdapterRequestError") {
          throw new Error("Unexpected error type");
        }
        NodeAssert.equal(
          permissionError.detail,
          "Unknown pending permission request: permission-idle-race",
        );
        const questionError = yield* adapter
          .respondToUserInput(threadId, asApprovalRequestId("question-idle-race"), {})
          .pipe(Effect.flip);
        NodeAssert.equal(questionError._tag, "ProviderAdapterRequestError");
        if (questionError._tag !== "ProviderAdapterRequestError") {
          throw new Error("Unexpected error type");
        }
        NodeAssert.equal(
          questionError.detail,
          "Unknown pending user-input request: question-idle-race",
        );
        NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, []);
        NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, []);

        abortResponseGate.resolve();
        const interruptResult = yield* joinWithinRealTime(interruptFiber, 2_000);
        NodeAssert.equal(
          Option.isSome(interruptResult),
          true,
          "interruptTurn must return after abort",
        );
        lateAbortEchoGate.resolve();
        yield* sleepReal(200);

        const events = yield* Ref.get(collected);
        NodeAssert.equal(
          events.filter((event) => event.type === "turn.completed").length,
          1,
          "the late abort echo must not settle the turn twice",
        );
        NodeAssert.equal(
          events.filter((event) => event.type === "request.resolved").length,
          1,
          "the late abort echo must not resolve the approval twice",
        );
        NodeAssert.equal(
          events.filter((event) => event.type === "user-input.resolved").length,
          1,
          "the late abort echo must not resolve the question twice",
        );
        NodeAssert.equal(
          events.filter((event) => event.type === "runtime.error").length,
          0,
          "a requested Stop must not synthesize a runtime error",
        );

        const sessions = yield* adapter.listSessions();
        const session = sessions.find((entry) => entry.threadId === threadId);
        NodeAssert.equal(session?.status, "ready");
        NodeAssert.equal(session?.activeTurnId, undefined);
        NodeAssert.equal(session?.lastError, undefined);
        NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
      }).pipe(Effect.ensuring(releaseGates));
    },
  );

  it.effect("keeps an unrequested MessageAbortedError as a failure", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-unrequested-abort-error");
      runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          },
        },
      ];
      const collected = yield* collectThreadEvents(adapter, threadId);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      const settled = yield* waitForThreadEvents(
        collected,
        (events) => events.some((event) => event.type === "turn.completed"),
        2_000,
      );
      NodeAssert.equal(settled, true);
      yield* sleepReal(200);
      const events = yield* Ref.get(collected);
      const completed = events.filter((event) => event.type === "turn.completed");
      NodeAssert.equal(completed.length, 1);
      const completedEvent = completed[0];
      if (completedEvent?.type !== "turn.completed") {
        throw new Error("Expected a turn.completed event");
      }
      NodeAssert.equal(String(completedEvent.turnId), String(turn.turnId));
      NodeAssert.deepEqual(completedEvent.payload, {
        state: "failed",
        errorMessage: "Aborted",
      });
      NodeAssert.equal(
        events.filter((event) => event.type === "runtime.error").length,
        1,
        "an abort Neokod did not request is still a provider failure",
      );
    }),
  );

  it.effect("a new turn clears the interrupt mark", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-new-turn-clears-mark");
      runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
      runtimeMock.state.eventsAfterAbortAfterPrompts = 2;
      runtimeMock.state.eventsAfterAbort = [
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          },
        },
      ];
      const collected = yield* collectThreadEvents(adapter, threadId);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);

      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      const settled = yield* waitForThreadEvents(
        collected,
        (events) => events.filter((event) => event.type === "turn.completed").length === 2,
        2_000,
      );
      NodeAssert.equal(settled, true);
      const events = yield* Ref.get(collected);
      const completed = events.filter((event) => event.type === "turn.completed");
      NodeAssert.equal(completed.length, 2);
      const secondCompleted = completed[1];
      if (secondCompleted?.type !== "turn.completed") {
        throw new Error("Expected a second turn.completed event");
      }
      NodeAssert.equal(String(secondCompleted.turnId), String(secondTurn.turnId));
      NodeAssert.deepEqual(secondCompleted.payload, {
        state: "failed",
        errorMessage: "Aborted",
      });
    }),
  );

  it.effect("resolves pending permissions on interrupt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-permission");
      runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            id: "permission-interrupt",
            permission: "bash",
            patterns: ["bun test"],
            metadata: {},
          },
        },
      ];
      const collected = yield* collectThreadEvents(adapter, threadId);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      const opened = yield* waitForThreadEvents(
        collected,
        (events) => events.some((event) => event.type === "request.opened"),
        2_000,
      );
      NodeAssert.equal(opened, true, "the approval must be pending before Stop");

      yield* adapter.interruptTurn(threadId);

      const resolved = yield* waitForThreadEvents(
        collected,
        (events) => events.some((event) => event.type === "request.resolved"),
        2_000,
      );
      NodeAssert.equal(resolved, true, "Stop must resolve the pending permission");
      const resolvedEvent = (yield* Ref.get(collected)).find(
        (event) => event.type === "request.resolved",
      );
      if (resolvedEvent?.type !== "request.resolved") {
        throw new Error("Expected a request.resolved event");
      }
      NodeAssert.deepEqual(resolvedEvent.payload, {
        requestType: "command_execution_approval",
        decision: "cancel",
      });

      const error = yield* adapter
        .respondToRequest(threadId, asApprovalRequestId("permission-interrupt"), "accept")
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "Unknown pending permission request: permission-interrupt");
    }),
  );
  it.effect("keeps transient retry statuses as warnings without settling the turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-transient-retry");
      runtimeMock.state.holdSubscribedEventsUntilPrompt = true;
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            status: {
              type: "retry",
              // A high attempt count on a transient failure stays retryable:
              // the policy classifies by message, it does not cap attempts.
              attempt: 7,
              message: "Rate limit exceeded, please try again later",
              next: 1754006400000,
            },
          },
        },
      ];
      const warningsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "runtime.warning" ||
              event.type === "runtime.error" ||
              event.type === "turn.completed"),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      const joined = yield* joinWithinRealTime(warningsFiber, 2_000);
      NodeAssert.equal(Option.isSome(joined), true, "transient retry must surface a warning");
      const events = Array.from(Option.isSome(joined) ? joined.value : []);
      const warning = events[0];
      if (warning?.type !== "runtime.warning") {
        throw new Error(`Expected a runtime.warning event, got ${warning?.type}`);
      }
      NodeAssert.equal(warning.payload.message, "Rate limit exceeded, please try again later");

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(session?.lastError, undefined);
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, []);
    }),
  );

  it.effect("classifies only credential failures as terminal retry messages", () =>
    Effect.sync(() => {
      const terminal = [
        "Internal Server Error: Invalid API key",
        "401 Unauthorized",
        "authentication_error: invalid x-api-key",
        "Incorrect API key provided",
        "Invalid credentials",
      ];
      const transient = [
        "Rate limit exceeded",
        "Too Many Requests",
        "Provider is overloaded",
        "Internal Server Error",
        "Free usage exceeded, subscribe to Go",
        "Usage limit reached. It will reset in 2 hours",
        "Connection timed out",
      ];
      for (const message of terminal) {
        NodeAssert.equal(isTerminalOpenCodeRetryMessage(message), true, `terminal: ${message}`);
      }
      for (const message of transient) {
        NodeAssert.equal(isTerminalOpenCodeRetryMessage(message), false, `transient: ${message}`);
      }
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      // Steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("keeps the running turn when a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      runtimeMock.state.promptAsyncError = new Error("steer failed");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      // The original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      NodeAssert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});
