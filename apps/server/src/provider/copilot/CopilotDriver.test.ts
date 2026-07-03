import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CopilotSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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

  it("defaults to enabled, matching Claude — this fork's other out-of-the-box driver", () => {
    NodeAssert.equal(CopilotDriver.defaultConfig().enabled, true);
    NodeAssert.equal(ClaudeDriver.defaultConfig().enabled, true);
  });

  it("leaves Codex's existing default untouched", () => {
    NodeAssert.equal(CodexDriver.defaultConfig().enabled, true);
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
  startShouldFail: false,
  callOrder: [] as Array<string>,
  clients: [] as Array<{ startCalls: number; stopCalls: number }>,
}));

vi.mock("@github/copilot-sdk", () => {
  class CopilotClient {
    startCalls = 0;
    stopCalls = 0;

    constructor() {
      copilotSdkState.clients.push(this);
    }

    start(): Promise<void> {
      this.startCalls += 1;
      if (copilotSdkState.startShouldFail) {
        return Promise.reject(new Error("simulated Copilot runtime start failure"));
      }
      return Promise.resolve();
    }

    stop(): Promise<void> {
      this.stopCalls += 1;
      copilotSdkState.callOrder.push("client.stop");
      return Promise.resolve();
    }

    createSession(): Promise<{
      readonly sessionId: string;
      readonly on: (eventType: string, handler: (event: unknown) => void) => () => void;
      readonly disconnect: () => Promise<void>;
    }> {
      const sessionId = `fake-session-${copilotSdkState.callOrder.length}`;
      return Promise.resolve({
        sessionId,
        on: () => () => {},
        disconnect: () => {
          copilotSdkState.callOrder.push(`session.disconnect:${sessionId}`);
          return Promise.resolve();
        },
      });
    }

    resumeSession(): ReturnType<CopilotClient["createSession"]> {
      return this.createSession();
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
}): ProviderDriverCreateInput<CopilotSettings> {
  return {
    instanceId: input.instanceId,
    displayName: undefined,
    accentColor: undefined,
    environment: [],
    enabled: input.enabled,
    config: decodeCopilotSettings({}),
  };
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "copilot-driver-lifecycle-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

describe("CopilotDriver — lifecycle", () => {
  it.effect("starts the bundled runtime exactly once per created instance when enabled", () =>
    Effect.gen(function* () {
      const before = copilotSdkState.clients.length;

      const instance = yield* CopilotDriver.create(
        makeCreateInput({ instanceId: ProviderInstanceId.make("githubCopilot_start_once"), enabled: true }),
      ).pipe(Effect.provide(testLayer), Effect.scoped);

      NodeAssert.equal(instance.enabled, true);
      const created = copilotSdkState.clients.slice(before);
      NodeAssert.equal(created.length, 1, "expected exactly one CopilotClient to be constructed");
      NodeAssert.equal(created[0]!.startCalls, 1);
    }),
  );

  it.effect("does not construct or start the runtime when the instance is disabled", () =>
    Effect.gen(function* () {
      const before = copilotSdkState.clients.length;

      const instance = yield* CopilotDriver.create(
        makeCreateInput({ instanceId: ProviderInstanceId.make("githubCopilot_disabled"), enabled: false }),
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
      copilotSdkState.startShouldFail = true;
      const instanceId = ProviderInstanceId.make("githubCopilot_start_failure");

      const error = yield* CopilotDriver.create(makeCreateInput({ instanceId, enabled: true })).pipe(
        Effect.provide(testLayer),
        Effect.scoped,
        Effect.flip,
      );

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
          copilotSdkState.startShouldFail = false;
        }),
      ),
    ),
  );
});
