import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { vi } from "vite-plus/test";

import { layerTest as serverConfigLayerTest } from "../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { classifyOpenCodeVersion } from "../openCodeVersion.ts";
import { makeProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import {
  OpenCodeDriver,
  resolveOpenCodeMaintenanceCapabilities,
  supportsOpenCodeSymphonyCodeReview,
} from "./OpenCodeDriver.ts";

vi.mock("../Layers/OpenCodeAdapter.ts", async () => {
  const EffectModule = await import("effect/Effect");
  return {
    makeOpenCodeAdapter: () => EffectModule.succeed({} as never),
  };
});

vi.mock("../../textGeneration/OpenCodeTextGeneration.ts", async () => {
  const EffectModule = await import("effect/Effect");
  return {
    makeOpenCodeTextGeneration: () => EffectModule.succeed({} as never),
  };
});

const OPENCODE = ProviderDriverKind.make("opencode");
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const packageFallback = () =>
  makeProviderMaintenanceCapabilities({
    provider: OPENCODE,
    packageName: "opencode-ai",
    updateExecutable: "npm",
    updateArgs: ["install", "-g", "opencode-ai@latest"],
    updateLockKey: "npm-global",
  });

describe("resolveOpenCodeMaintenanceCapabilities", () => {
  it("does not offer a legacy 1.x package update for a known OpenCode 2 install", () => {
    const resolved = resolveOpenCodeMaintenanceCapabilities({
      knownVersion: classifyOpenCodeVersion("v2.0.32"),
      fallback: packageFallback(),
    });

    expect(resolved.update).toBeNull();
    expect(resolved.packageName).toBeNull();
  });

  it("keeps the package-managed update for a supported OpenCode 1.x install", () => {
    const fallback = packageFallback();
    const resolved = resolveOpenCodeMaintenanceCapabilities({
      knownVersion: classifyOpenCodeVersion("1.18.15"),
      fallback,
    });

    expect(resolved).toBe(fallback);
  });

  it("preserves current update behavior when the version is not known", () => {
    const fallback = packageFallback();
    const resolved = resolveOpenCodeMaintenanceCapabilities({
      knownVersion: null,
      fallback,
    });

    expect(resolved).toBe(fallback);
  });
});

describe("supportsOpenCodeSymphonyCodeReview", () => {
  it("rejects a known OpenCode 2 install", () => {
    expect(supportsOpenCodeSymphonyCodeReview(classifyOpenCodeVersion("2.0.32"))).toBe(false);
  });

  it("keeps supported and unverified installs review-capable", () => {
    expect(supportsOpenCodeSymphonyCodeReview(classifyOpenCodeVersion("1.18.15"))).toBe(true);
    expect(supportsOpenCodeSymphonyCodeReview(null)).toBe(true);
  });
});

const versionStdoutState = vi.hoisted(() => ({ value: "opencode v2.0.32\n" }));
const versionCommandCalls: Array<{
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
}> = [];

const fakeRuntime: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("unexpected server start"),
  connectToOpenCodeServer: () => Effect.die("unexpected server connection"),
  runOpenCodeCommand: (input) =>
    Effect.sync(() => {
      versionCommandCalls.push({ binaryPath: input.binaryPath, args: input.args });
      return { stdout: versionStdoutState.value, stderr: "", code: 0 };
    }),
  createOpenCodeSdkClient: () => ({}) as never,
  loadOpenCodeInventory: () => Effect.die("unexpected inventory read"),
};

const testHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const driverTestLayer = serverConfigLayerTest(process.cwd(), {
  prefix: "opencode-driver-version-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(serverSettingsLayerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, fakeRuntime)),
  Layer.provideMerge(testHttpClientLayer),
);

const awaitSnapshot = (
  instance: ProviderInstance,
  predicate: (snapshot: ServerProvider) => boolean,
): Effect.Effect<ServerProvider> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const snapshot = yield* instance.snapshot.getSnapshot;
      if (predicate(snapshot)) {
        return snapshot;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("expected OpenCode snapshot was not published");
  });

describe("OpenCodeDriver version capability wiring", () => {
  it.effect("does not advertise review or a 1.x update for a known OpenCode 2 install", () =>
    Effect.gen(function* () {
      versionStdoutState.value = "opencode v2.0.32\n";
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode_v2_guard"),
        displayName: undefined,
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: decodeOpenCodeSettings({ enabled: true }),
      });

      expect(instance.symphonyCodeReview).toBe(false);
      expect(instance.snapshot.maintenanceCapabilities.update).toBeNull();
      expect(instance.snapshot.maintenanceCapabilities.packageName).toBeNull();

      const snapshot = yield* awaitSnapshot(instance, (candidate) => candidate.status === "error");
      expect(snapshot.version).toBe("2.0.32");
      expect(snapshot.message).toContain("OpenCode 2 is not supported yet");
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );
});

const createOpenCodeInstance = (input: {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly serverUrl?: string;
}) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make(input.instanceId),
    displayName: undefined,
    accentColor: undefined,
    environment: [],
    enabled: input.enabled,
    config: decodeOpenCodeSettings({
      enabled: input.enabled,
      ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
    }),
  });

/**
 * Read the command-time revalidation the driver attaches to the update it
 * captured at creation. Fails the test when the driver offers no update at all.
 */
const openCodeUpdateGuard = (instance: ProviderInstance): Effect.Effect<string | null> => {
  const update = instance.snapshot.maintenanceCapabilities.update;
  if (update === null || update.verifyStillApplicable === undefined) {
    throw new Error("expected a command-time OpenCode update guard");
  }
  return update.verifyStillApplicable;
};

describe("OpenCodeDriver command-time maintenance guard", () => {
  it.effect(
    "blocks the captured 1.x updater when the CLI becomes OpenCode 2 before the update runs",
    () =>
      Effect.gen(function* () {
        versionCommandCalls.length = 0;
        versionStdoutState.value = "opencode 1.18.15\n";
        const instance = yield* createOpenCodeInstance({
          instanceId: "opencode_guard_upgrade",
          enabled: true,
        });
        expect(instance.snapshot.maintenanceCapabilities.update).not.toBeNull();
        const verifyStillApplicable = openCodeUpdateGuard(instance);
        const probesBeforeUpdate = versionCommandCalls.length;

        versionStdoutState.value = "opencode v2.0.32\n";
        const blockedReason = yield* verifyStillApplicable;

        expect(versionCommandCalls.length).toBeGreaterThan(probesBeforeUpdate);
        expect(versionCommandCalls.at(-1)?.args).toEqual(["--version"]);
        expect(blockedReason).toContain("OpenCode v2.0.32");
        expect(blockedReason).toContain("install OpenCode 1.x");
      }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );

  it.effect("allows the captured update while the CLI is still OpenCode 1.x", () =>
    Effect.gen(function* () {
      versionStdoutState.value = "opencode 1.18.15\n";
      const instance = yield* createOpenCodeInstance({
        instanceId: "opencode_guard_supported",
        enabled: true,
      });
      const verifyStillApplicable = openCodeUpdateGuard(instance);

      expect(yield* verifyStillApplicable).toBeNull();
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );

  it.effect("does not guard an external server from the local CLI", () =>
    Effect.gen(function* () {
      versionCommandCalls.length = 0;
      versionStdoutState.value = "opencode 1.18.15\n";
      const instance = yield* createOpenCodeInstance({
        instanceId: "opencode_guard_external",
        enabled: true,
        serverUrl: "http://127.0.0.1:4096",
      });

      expect(versionCommandCalls).toEqual([]);
      expect(
        instance.snapshot.maintenanceCapabilities.update?.verifyStillApplicable,
      ).toBeUndefined();
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );

  it.effect("keeps a disabled local instance from spawning until maintenance is requested", () =>
    Effect.gen(function* () {
      versionCommandCalls.length = 0;
      versionStdoutState.value = "opencode 1.18.15\n";
      const instance = yield* createOpenCodeInstance({
        instanceId: "opencode_guard_disabled",
        enabled: false,
      });
      const verifyStillApplicable = openCodeUpdateGuard(instance);

      expect(versionCommandCalls).toEqual([]);

      versionStdoutState.value = "opencode v2.0.32\n";
      expect(yield* verifyStillApplicable).toContain("OpenCode v2.0.32");
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );
});
