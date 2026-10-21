import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CopilotSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  ThreadId,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { ProviderDriverError } from "../Errors.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type { ProviderDriverCreateInput } from "../ProviderDriver.ts";
import { CopilotDriver } from "./CopilotDriver.ts";

describe("CopilotDriver", () => {
  it("registers as a built-in driver under the 'githubCopilot' kind", () => {
    NodeAssert.equal(CopilotDriver.driverKind, "githubCopilot");
    NodeAssert.equal(CopilotDriver.metadata.displayName, "GitHub Copilot");
    NodeAssert.equal(CopilotDriver.metadata.supportsMultipleInstances, true);
    NodeAssert.ok(
      BUILT_IN_DRIVERS.some((driver) => driver.driverKind === CopilotDriver.driverKind),
      "CopilotDriver should be listed in BUILT_IN_DRIVERS",
    );
  });

  it("defaults to disabled until the user enables it, matching Claude", () => {
    NodeAssert.equal(CopilotDriver.defaultConfig().enabled, false);
    NodeAssert.equal(ClaudeDriver.defaultConfig().enabled, false);
  });

  it("ships Codex disabled by default", () => {
    NodeAssert.equal(CodexDriver.defaultConfig().enabled, false);
  });

  it("ships Cursor/Grok/OpenCode disabled by default", () => {
    NodeAssert.equal(CursorDriver.defaultConfig().enabled, false);
    NodeAssert.equal(GrokDriver.defaultConfig().enabled, false);
    NodeAssert.equal(OpenCodeDriver.defaultConfig().enabled, false);
  });
});

// --- Lifecycle slice ---------------------------------------------------
//
// `CopilotDriver.create` constructs the bundled `@github/copilot-sdk`
// `CopilotClient` itself (unlike the other drivers, which spawn a
// disposable process per call), so exercising its start/stop lifecycle
// needs the SDK module mocked rather than a constructor-injected test
// double the way `CopilotAdapter.test.ts` does for the session-level
// surface. `vi.hoisted` holds the shared state the mocked module and the
// test bodies below both need to reach.

const copilotSdkState = vi.hoisted(() => ({
  startFailureMessage: undefined as string | undefined,
  pingDead: false,
  callOrder: [] as Array<string>,
  sessionConfigs: [] as Array<Record<string, unknown>>,
  clients: [] as Array<{
    startCalls: number;
    stopCalls: number;
    forceStopCalls: number;
    options: unknown;
  }>,
}));

vi.mock("@github/copilot-sdk", () => {
  class CopilotClient {
    startCalls = 0;
    stopCalls = 0;
    forceStopCalls = 0;

    options: unknown;

    constructor(options: unknown) {
      this.options = options;
      copilotSdkState.clients.push(this);
    }

    start(): Promise<void> {
      this.startCalls += 1;
      if (copilotSdkState.startFailureMessage) {
        return Promise.reject(new Error(copilotSdkState.startFailureMessage));
      }
      copilotSdkState.pingDead = false;
      return Promise.resolve();
    }

    stop(): Promise<void> {
      this.stopCalls += 1;
      copilotSdkState.callOrder.push("client.stop");
      return Promise.resolve();
    }

    ping(): Promise<unknown> {
      return copilotSdkState.pingDead
        ? Promise.reject(new Error("Connection is closed."))
        : Promise.resolve({ protocolVersion: "test" });
    }

    forceStop(): Promise<void> {
      this.forceStopCalls += 1;
      copilotSdkState.callOrder.push("client.forceStop");
      return Promise.resolve();
    }

    createSession(config: Record<string, unknown>): Promise<{
      readonly sessionId: string;
      readonly on: (eventType: string, handler: (event: unknown) => void) => () => void;
      readonly disconnect: () => Promise<void>;
      readonly send: (options: unknown) => Promise<string>;
      readonly abort: () => Promise<void>;
    }> {
      copilotSdkState.sessionConfigs.push(config);
      const sessionId = `fake-session-${copilotSdkState.callOrder.length}`;
      return Promise.resolve({
        sessionId,
        on: () => () => {},
        disconnect: () => {
          copilotSdkState.callOrder.push(`session.disconnect:${sessionId}`);
          return Promise.resolve();
        },
        send: () => Promise.resolve(`fake-message-${sessionId}`),
        abort: () => Promise.resolve(),
      });
    }

    resumeSession(config: Record<string, unknown>): ReturnType<CopilotClient["createSession"]> {
      return this.createSession(config);
    }

    getStatus(): Promise<{ readonly version: string }> {
      return Promise.resolve({ version: "0.0.0-test" });
    }

    getAuthStatus(): Promise<{ readonly isAuthenticated: boolean }> {
      return Promise.resolve({ isAuthenticated: false });
    }
  }

  return {
    CopilotClient,
    RuntimeConnection: { forStdio: (options: unknown) => options },
  };
});

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
const isProviderDriverError = Schema.is(ProviderDriverError);

function makeCreateInput(input: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly binaryPath?: string;
}): ProviderDriverCreateInput<CopilotSettings> {
  return {
    instanceId: input.instanceId,
    displayName: undefined,
    accentColor: undefined,
    environment: [],
    enabled: input.enabled,
    config: decodeCopilotSettings({ binaryPath: input.binaryPath ?? "" }),
  };
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "copilot-driver-lifecycle-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

const shellPermissionRequest = {
  kind: "shell" as const,
  canOfferSessionApproval: false,
  commands: [{ identifier: "ls", readOnly: true }],
  fullCommandText: "ls",
  hasWriteFileRedirection: false,
  intention: "List the working directory",
  possiblePaths: [],
  possibleUrls: [],
};

describe("CopilotDriver — lifecycle", () => {
  it.effect("uses the bundled native runtime when no custom path is configured", () =>
    Effect.gen(function* () {
      const before = copilotSdkState.clients.length;

      yield* CopilotDriver.create(
        makeCreateInput({
          instanceId: ProviderInstanceId.make("githubCopilot_bundled_runtime"),
          enabled: false,
        }),
      ).pipe(Effect.provide(testLayer), Effect.scoped);

      const created = copilotSdkState.clients.slice(before);
      const connection = (created[0]!.options as { connection?: { path?: string } }).connection;
      NodeAssert.ok(connection?.path, "expected a bundled stdio runtime connection");
      NodeAssert.ok(
        /copilot(\.exe)?$/.test(connection.path),
        "expected the bundled native Copilot executable",
      );
    }),
  );

  it.effect("keeps a configured runtime path unchanged", () =>
    Effect.gen(function* () {
      const before = copilotSdkState.clients.length;

      yield* CopilotDriver.create(
        makeCreateInput({
          instanceId: ProviderInstanceId.make("githubCopilot_custom_runtime"),
          enabled: false,
          binaryPath: "/usr/local/bin/copilot",
        }),
      ).pipe(Effect.provide(testLayer), Effect.scoped);

      const created = copilotSdkState.clients.slice(before);
      const connection = (created[0]!.options as { connection?: { path?: string } }).connection;
      NodeAssert.equal(connection?.path, "/usr/local/bin/copilot");
    }),
  );

  it.effect("starts the bundled runtime exactly once per created instance when enabled", () =>
    Effect.gen(function* () {
      const before = copilotSdkState.clients.length;

      const instance = yield* CopilotDriver.create(
        makeCreateInput({
          instanceId: ProviderInstanceId.make("githubCopilot_start_once"),
          enabled: true,
        }),
      ).pipe(Effect.provide(testLayer), Effect.scoped);

      NodeAssert.equal(instance.enabled, true);
      const created = copilotSdkState.clients.slice(before);
      NodeAssert.equal(created.length, 1, "expected exactly one CopilotClient to be constructed");
      NodeAssert.equal(created[0]!.startCalls, 1);
    }),
  );

  it.effect("restarts a dead runtime when the snapshot refreshes", () =>
    Effect.gen(function* () {
      const before = copilotSdkState.clients.length;
      const instance = yield* CopilotDriver.create(
        makeCreateInput({
          instanceId: ProviderInstanceId.make("githubCopilot_restart_on_refresh"),
          enabled: true,
        }),
      ).pipe(Effect.provide(testLayer), Effect.scoped);
      const created = copilotSdkState.clients[before]!;

      // Settle the initial background refresh before simulating the death.
      yield* instance.snapshot.refresh;
      NodeAssert.equal(created.startCalls, 1);

      copilotSdkState.pingDead = true;
      yield* instance.snapshot.refresh;

      NodeAssert.equal(created.forceStopCalls, 1);
      NodeAssert.equal(created.startCalls, 2);
      NodeAssert.equal(copilotSdkState.pingDead, false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          copilotSdkState.pingDead = false;
        }),
      ),
    ),
  );

  it.live(
    "settles an active turn and pending request when a refresh replaces a dead runtime",
    () => {
      const instanceId = ProviderInstanceId.make("githubCopilot_refresh_settles_sessions");
      const threadId = ThreadId.make("thread-refresh-settles-sessions");
      const sleepReal = (millis: number) => Effect.sleep(`${millis} millis`);

      return Effect.gen(function* () {
        // The instance scope must stay open for the whole test: `Effect.scoped`
        // would close it as soon as `create` returns, shutting down the
        // adapter's event queue before the test can observe settlement.
        const scope = yield* Scope.make("sequential");
        return yield* Effect.gen(function* () {
          const before = copilotSdkState.clients.length;
          const instance = yield* CopilotDriver.create(
            makeCreateInput({ instanceId, enabled: true }),
          ).pipe(Effect.provide(testLayer), Effect.provideService(Scope.Scope, scope));
          const created = copilotSdkState.clients[before]!;
          const adapter = instance.adapter;

          // Settle the initial background refresh before simulating the death.
          yield* instance.snapshot.refresh;
          NodeAssert.equal(created.startCalls, 1);

          const events: Array<ProviderRuntimeEvent> = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );

          yield* adapter.startSession({
            provider: ProviderDriverKind.make("githubCopilot"),
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          const sent = yield* adapter.sendTurn({ threadId, input: "list the directory" });

          const config = copilotSdkState.sessionConfigs[copilotSdkState.sessionConfigs.length - 1];
          const onPermissionRequest = config?.onPermissionRequest as
            | ((request: unknown) => Promise<unknown>)
            | undefined;
          NodeAssert.ok(
            onPermissionRequest,
            "expected the adapter to register a permission handler",
          );
          const pendingRequest = yield* Effect.promise(() =>
            onPermissionRequest(shellPermissionRequest),
          ).pipe(Effect.forkChild);

          const waitFor = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 200; attempt++) {
                if (events.some(predicate)) return true;
                yield* sleepReal(10);
              }
              return false;
            });

          NodeAssert.ok(
            yield* waitFor(
              (event) => event.threadId === threadId && event.type === "request.opened",
            ),
            "expected the pending approval request to open before the runtime dies",
          );

          // The child dies and the provider refresh wins the race against the
          // adapter watchdog: the replacement must settle the adapter's
          // sessions before `forceStop` disconnects them.
          copilotSdkState.pingDead = true;
          yield* instance.snapshot.refresh;
          NodeAssert.equal(created.forceStopCalls, 1);
          NodeAssert.equal(created.startCalls, 2);

          NodeAssert.ok(
            yield* waitFor(
              (event) => event.threadId === threadId && event.type === "turn.completed",
            ),
            "expected the in-flight turn to settle when the refresh replaced the runtime",
          );
          const permissionResult = yield* Fiber.join(pendingRequest);
          NodeAssert.deepEqual(permissionResult, {
            kind: "reject",
            feedback: "Request cancelled by user.",
          });

          // A later healthy refresh must not re-emit terminal events.
          yield* instance.snapshot.refresh;
          yield* sleepReal(50);

          const threadEvents = events.filter((event) => event.threadId === threadId);
          const turnCompleted = threadEvents.filter((event) => event.type === "turn.completed");
          NodeAssert.equal(turnCompleted.length, 1, "expected the old turn to settle exactly once");
          const completed = turnCompleted[0]!;
          NodeAssert.equal(completed.type, "turn.completed");
          if (completed.type === "turn.completed") {
            NodeAssert.equal(completed.turnId, sent.turnId);
            NodeAssert.equal(completed.payload.state, "failed");
          }
          const requestResolved = threadEvents.filter((event) => event.type === "request.resolved");
          NodeAssert.equal(requestResolved.length, 1);
          const resolved = requestResolved[0]!;
          if (resolved.type === "request.resolved") {
            NodeAssert.equal(resolved.payload.decision, "cancel");
          }
          NodeAssert.equal(
            threadEvents.filter((event) => event.type === "session.exited").length,
            1,
          );
          NodeAssert.equal(
            yield* adapter.hasSession(threadId),
            false,
            "old session must be removed",
          );

          // A fresh message recovers on the replacement runtime.
          yield* adapter.startSession({
            provider: ProviderDriverKind.make("githubCopilot"),
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          const recovered = yield* adapter.sendTurn({ threadId, input: "try again" });
          NodeAssert.notEqual(recovered.turnId, sent.turnId);
          NodeAssert.equal(yield* adapter.hasSession(threadId), true);
          NodeAssert.equal(created.startCalls, 2);
        }).pipe(
          Effect.ensuring(
            Scope.close(scope, Exit.void).pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.sync(() => {
                  copilotSdkState.pingDead = false;
                }),
              ),
            ),
          ),
        );
      });
    },
  );

  it.effect("does not construct or start the runtime when the instance is disabled", () =>
    Effect.gen(function* () {
      const before = copilotSdkState.clients.length;

      const instance = yield* CopilotDriver.create(
        makeCreateInput({
          instanceId: ProviderInstanceId.make("githubCopilot_disabled"),
          enabled: false,
        }),
      ).pipe(Effect.provide(testLayer), Effect.scoped);

      NodeAssert.equal(instance.enabled, false);
      // The client is still constructed (its constructor is inert), but
      // `.start()` must never be called for a disabled instance.
      const created = copilotSdkState.clients.slice(before);
      NodeAssert.equal(created.length, 1);
      NodeAssert.equal(created[0]!.startCalls, 0);
      NodeAssert.equal(created[0]!.stopCalls, 0);
    }),
  );

  it.effect(
    "stops the runtime and disconnects open sessions when the instance scope closes, session first",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        let scopeClosed = false;

        try {
          const instance = yield* CopilotDriver.create(
            makeCreateInput({
              instanceId: ProviderInstanceId.make("githubCopilot_stop_on_close"),
              enabled: true,
            }),
          ).pipe(Effect.provide(testLayer), Effect.provideService(Scope.Scope, scope));

          const client = copilotSdkState.clients[copilotSdkState.clients.length - 1]!;
          NodeAssert.equal(client.stopCalls, 0);

          yield* instance.adapter.startSession({
            provider: ProviderDriverKind.make("githubCopilot"),
            threadId: ThreadId.make("thread-driver-lifecycle"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* Scope.close(scope, Exit.void);
          scopeClosed = true;

          NodeAssert.equal(client.stopCalls, 1);
          const disconnectIndex = copilotSdkState.callOrder.findIndex((entry) =>
            entry.startsWith("session.disconnect"),
          );
          const stopIndex = copilotSdkState.callOrder.lastIndexOf("client.stop");
          NodeAssert.ok(disconnectIndex !== -1, "expected a session disconnect call");
          NodeAssert.ok(stopIndex !== -1, "expected a client.stop call");
          NodeAssert.ok(
            disconnectIndex < stopIndex,
            "session disconnect must finalize before client.stop runs",
          );
        } finally {
          if (!scopeClosed) {
            yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
          }
        }
      }),
  );

  it.effect("surfaces a client.start() failure as a ProviderDriverError", () =>
    Effect.gen(function* () {
      copilotSdkState.startFailureMessage = "simulated Copilot runtime start failure";
      const instanceId = ProviderInstanceId.make("githubCopilot_start_failure");

      const error = yield* CopilotDriver.create(
        makeCreateInput({ instanceId, enabled: true }),
      ).pipe(Effect.provide(testLayer), Effect.scoped, Effect.flip);

      NodeAssert.ok(isProviderDriverError(error));
      NodeAssert.equal(error.driver, "githubCopilot");
      NodeAssert.equal(error.instanceId, instanceId);
      NodeAssert.equal(
        error.detail,
        "simulated Copilot runtime start failure",
        "expected the real SDK rejection message, not Effect's generic tryPromise message",
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          copilotSdkState.startFailureMessage = undefined;
        }),
      ),
    ),
  );

  it.effect("explains when a configured runtime rejects the SDK server arguments", () =>
    Effect.gen(function* () {
      copilotSdkState.startFailureMessage =
        "CLI server exited with code 1 stderr: error: too many arguments. Expected 0 arguments but got 1.";
      const error = yield* CopilotDriver.create(
        makeCreateInput({
          instanceId: ProviderInstanceId.make("githubCopilot_incompatible_runtime"),
          enabled: true,
          binaryPath: "/usr/local/bin/copilot",
        }),
      ).pipe(Effect.provide(testLayer), Effect.scoped, Effect.flip);

      NodeAssert.ok(isProviderDriverError(error));
      NodeAssert.equal(
        error.detail,
        "The configured runtime at /usr/local/bin/copilot is not compatible with the Copilot SDK. Use a current GitHub Copilot CLI that supports --headless and --stdio, or clear Runtime path to use Neokod's bundled runtime.",
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          copilotSdkState.startFailureMessage = undefined;
        }),
      ),
    ),
  );
});
