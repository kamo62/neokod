import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import { OpenCodeSettings } from "@neokod/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { checkOpenCodeProviderStatus } from "./OpenCodeProvider.ts";
import type { OpenCodeInventory } from "../opencodeRuntime.ts";
import { OPENCODE_VERSION_PROBE_TIMEOUT } from "../openCodeVersion.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";

/**
 * The legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
 * are deleted. The snapshot-producing logic they wrapped now lives in the
 * standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
 * drivers call directly when building their per-instance snapshot
 * `ServerProviderShape`. Tests mirror that shape: build a settings payload,
 * invoke the check, assert on the returned snapshot.
 */

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    versionHangs: false,
    inventoryError: null as Error | null,
    closeCalls: 0,
    connectCalls: 0,
    inventoryCalls: 0,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      config: {},
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.versionHangs = false;
    this.state.inventoryError = null;
    this.state.closeCalls = 0;
    this.state.connectCalls = 0;
    this.state.inventoryCalls = 0;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      config: {},
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      runtimeMock.state.connectCalls += 1;
      if (!serverUrl) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4301",
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.versionHangs
      ? Effect.never
      : runtimeMock.state.runVersionError
        ? Effect.fail(
            new OpenCodeRuntimeError({
              operation: "runOpenCodeCommand",
              detail: runtimeMock.state.runVersionError.message,
              cause: runtimeMock.state.runVersionError,
            }),
          )
        : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.suspend(() => {
      runtimeMock.state.inventoryCalls += 1;
      return runtimeMock.state.inventoryError
        ? Effect.fail(
            new OpenCodeRuntimeError({
              operation: "loadOpenCodeInventory",
              detail: runtimeMock.state.inventoryError.message,
              cause: runtimeMock.state.inventoryError,
            }),
          )
        : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory);
    }),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

it.layer(testLayer)("checkOpenCodeProviderStatus", (it) => {
  it.effect("shows a codex-style missing binary message naming the searched PATH", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd(), {
        PATH: "/usr/bin:/bin",
      });

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode CLI (`opencode`) was not found on PATH (searched PATH: /usr/bin:/bin). If it is installed, set the binary path in the provider settings to its absolute path.",
      );
    }),
  );

  it.effect("bounds a hanging local --version probe and keeps the version unknown", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionHangs = true;
      const statusFiber = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      // One millisecond before the shared probe bound, status must still be
      // waiting rather than reporting a version it never observed.
      yield* TestClock.adjust(
        Duration.millis(Duration.toMillis(OPENCODE_VERSION_PROBE_TIMEOUT) - 1),
      );
      yield* Effect.yieldNow;
      NodeAssert.equal(statusFiber.pollUnsafe(), undefined);

      yield* TestClock.adjust("1 millis");
      yield* Effect.yieldNow;
      const snapshot = yield* Fiber.join(statusFiber);

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.version, null);
      NodeAssert.deepEqual(snapshot.auth, { status: "unknown" });
      NodeAssert.match(snapshot.message ?? "", /did not finish/);
      NodeAssert.match(snapshot.message ?? "", /5\d{3}ms/);
      NodeAssert.equal(runtimeMock.state.connectCalls, 0);
      NodeAssert.equal(runtimeMock.state.inventoryCalls, 0);
    }),
  );

  it.effect("reports OpenCode 2 as unsupported before trying its HTTP API", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode v2.0.32\n";

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.version, "2.0.32");
      NodeAssert.match(snapshot.message ?? "", /OpenCode 2 is not supported yet/);
      NodeAssert.match(snapshot.message ?? "", /install OpenCode 1\.x/);
      NodeAssert.equal(runtimeMock.state.connectCalls, 0);
      NodeAssert.equal(runtimeMock.state.inventoryCalls, 0);
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("emits OpenCode variant defaults so trait picker can resolve a visible selection", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: "build", hidden: false, mode: "primary" },
          { name: "plan", hidden: false, mode: "primary" },
        ],
        config: {},
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());
      const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

      NodeAssert.ok(model);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      NodeAssert.ok(variantDescriptor && variantDescriptor.type === "select");
      NodeAssert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "medium",
      );
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
      );
      NodeAssert.ok(agentDescriptor && agentDescriptor.type === "select");
      NodeAssert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        "build",
      );
    }),
  );

  it.effect("honors OpenCode provider model filters", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["azure"],
          all: [
            {
              id: "azure",
              name: "Azure",
              models: {
                "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" },
                "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
              },
            },
          ],
          default: {},
        },
        agents: [],
        config: {
          provider: {
            azure: {
              whitelist: ["gpt-5.5"],
            },
          },
        },
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["azure/gpt-5.5"],
      );
    }),
  );

  it.effect("closes the local OpenCode server scope after provider refresh", () =>
    Effect.gen(function* () {
      yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.equal(runtimeMock.state.closeCalls, 1);
    }),
  );
});

it.layer(testLayer)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("reports that a configured server's version cannot be verified", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.match(snapshot.message ?? "", /OpenCode 2 is not supported yet/);
      NodeAssert.match(snapshot.message ?? "", /cannot verify a configured OpenCode server/);
    }),
  );

  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("401 Unauthorized");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password. Neokod cannot verify a configured OpenCode server's version; OpenCode 2 is not supported yet.",
      );
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct. Neokod cannot verify a configured OpenCode server's version; OpenCode 2 is not supported yet.",
      );
    }),
  );
});
