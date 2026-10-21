import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, type ServerProvider } from "@neokod/contracts";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import { layerTest as serverConfigLayerTest } from "../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { ClaudeDriver, claudeCapabilitiesProbeCacheTimeToLive } from "./ClaudeDriver.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";

// The stickiness bug lived in the cache `ClaudeDriver.create` builds, not in
// any cache a test could assemble for itself, so the regression test below
// drives the real driver. Only `probeClaudeCapabilities` is stubbed: it is
// the one lookup that would otherwise spawn a Claude Agent SDK subprocess,
// and the stub is where consecutive misses are counted.
const capabilitiesProbeState = vi.hoisted(() => ({ lookups: 0 }));
const adapterOptionsState = vi.hoisted(() => ({
  onRateLimitChange: undefined as unknown,
}));

vi.mock("../Layers/ClaudeAdapter.ts", async () => {
  const EffectModule = await import("effect/Effect");
  return {
    makeClaudeAdapter: (_settings: unknown, options: { readonly onRateLimitChange?: unknown }) =>
      EffectModule.sync(() => {
        adapterOptionsState.onRateLimitChange = options.onRateLimitChange;
        return {} as never;
      }),
  };
});

vi.mock("../Layers/ClaudeProvider.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../Layers/ClaudeProvider.ts")>();
  const EffectModule = await import("effect/Effect");
  return {
    ...original,
    probeClaudeCapabilities: () =>
      EffectModule.sync(() => {
        capabilitiesProbeState.lookups += 1;
        return undefined;
      }),
  };
});

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encoder = new TextEncoder();
const yieldToNodeEventLoop = Effect.promise(() => NodeTimersPromises.setImmediate());

/** Every CLI spawn in this flow is the `--version` health check. */
const claudeCliSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode("1.0.0\n")),
        stderr: Stream.make(encoder.encode("")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

const testHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const driverTestLayer = serverConfigLayerTest(process.cwd(), {
  prefix: "claude-driver-cache-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(serverSettingsLayerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(testHttpClientLayer),
);

const awaitLookups = (count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 10_000; i += 1) {
      if (capabilitiesProbeState.lookups >= count) return;
      yield* yieldToNodeEventLoop;
    }
    assert.fail(`expected ${count} capabilities lookups, saw ${capabilitiesProbeState.lookups}`);
  });

describe("claudeCapabilitiesProbeCacheTimeToLive", () => {
  it("expires a probe miss immediately instead of pinning it for the TTL", () => {
    // `probeClaudeCapabilities` maps both errors and timeouts to `undefined`,
    // so a retained miss would keep the panel on "could not verify" for the
    // whole TTL even after the user hits Refresh.
    assert.ok(Duration.isZero(claudeCapabilitiesProbeCacheTimeToLive(Exit.succeed(undefined))));
    assert.ok(Duration.isZero(claudeCapabilitiesProbeCacheTimeToLive(Exit.fail("probe error"))));
  });

  it("keeps a successful probe for the full TTL", () => {
    const ttl = claudeCapabilitiesProbeCacheTimeToLive(Exit.succeed({ email: "user@example.com" }));
    assert.strictEqual(Duration.toMillis(ttl), Duration.toMillis(Duration.minutes(5)));
  });
});

describe("ClaudeDriver capabilities cache", () => {
  it.effect("re-probes on the next refresh after a miss instead of replaying it", () =>
    Effect.gen(function* () {
      capabilitiesProbeState.lookups = 0;
      const instance = yield* ClaudeDriver.create({
        instanceId: ProviderInstanceId.make("claudeAgent_cache_seam"),
        displayName: undefined,
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: decodeClaudeSettings({ enabled: true }),
      }).pipe(Effect.provide(claudeCliSpawnerLayer));

      // `create` forks the initial snapshot check; wait for its lookup.
      yield* awaitLookups(1);
      assert.strictEqual(capabilitiesProbeState.lookups, 1);

      // The lookup returned `undefined`, a miss. With the old fixed-TTL cache
      // that miss stayed pinned for five minutes and Refresh replayed it;
      // now it expires immediately, so a refresh must probe again.
      yield* instance.snapshot.refresh;
      assert.strictEqual(capabilitiesProbeState.lookups, 2);
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );
});

interface RateLimitChange {
  readonly status: string;
  readonly rateLimitType: string;
  readonly resetsAtEpochSeconds: number | undefined;
}

const reportRateLimit = (change: RateLimitChange) => {
  const callback = adapterOptionsState.onRateLimitChange as
    | ((change: RateLimitChange) => Effect.Effect<void>)
    | undefined;
  assert.ok(callback, "driver did not install onRateLimitChange");
  return callback(change);
};

const awaitSnapshot = (
  instance: ProviderInstance,
  predicate: (snapshot: ServerProvider) => boolean,
): Effect.Effect<ServerProvider> =>
  Effect.gen(function* () {
    for (let i = 0; i < 10_000; i += 1) {
      const snapshot = yield* instance.snapshot.getSnapshot;
      if (predicate(snapshot)) return snapshot;
      yield* yieldToNodeEventLoop;
    }
    return yield* Effect.die("expected snapshot was not published");
  });

const createDriverInstance = (instanceId: string) =>
  ClaudeDriver.create({
    instanceId: ProviderInstanceId.make(instanceId),
    displayName: undefined,
    accentColor: undefined,
    environment: [],
    enabled: true,
    config: decodeClaudeSettings({ enabled: true }),
  }).pipe(Effect.provide(claudeCliSpawnerLayer));

describe("ClaudeDriver rejected rate-limit evidence", () => {
  it.effect("keeps session A's rejected window when session B allows another window", () =>
    Effect.gen(function* () {
      adapterOptionsState.onRateLimitChange = undefined;
      const instance = yield* createDriverInstance("claudeAgent_rate_limit_cross_session");
      const resetAt = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 3_600;

      yield* reportRateLimit({
        status: "rejected",
        rateLimitType: "seven_day_opus",
        resetsAtEpochSeconds: resetAt,
      });
      yield* awaitSnapshot(instance, (snapshot) => snapshot.limit?.window === "seven_day_opus");

      // Session B has no rejected windows of its own and reports five_hour
      // allowed. Its report must not replace the provider-instance evidence.
      yield* reportRateLimit({
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAtEpochSeconds: undefined,
      });
      yield* yieldToNodeEventLoop;

      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.limit?.window, "seven_day_opus");
      assert.strictEqual(snapshot.status, "warning");
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );

  it.effect("does not let a known-reset window expire an unknown-reset rejection", () =>
    Effect.gen(function* () {
      adapterOptionsState.onRateLimitChange = undefined;
      const instance = yield* createDriverInstance("claudeAgent_rate_limit_mixed_reset");
      const resetAt = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 3_600;

      yield* reportRateLimit({
        status: "rejected",
        rateLimitType: "seven_day_opus",
        resetsAtEpochSeconds: undefined,
      });
      yield* reportRateLimit({
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAtEpochSeconds: resetAt,
      });

      const snapshot = yield* awaitSnapshot(
        instance,
        (current) => current.limit?.window === "seven_day_opus",
      );
      assert.strictEqual(snapshot.limit?.resetsAt, undefined);
      assert.strictEqual(snapshot.status, "warning");
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );

  it.effect("clears the card after an explicit allowed report for the last window", () =>
    Effect.gen(function* () {
      adapterOptionsState.onRateLimitChange = undefined;
      const instance = yield* createDriverInstance("claudeAgent_rate_limit_allowed");
      const resetAt = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 3_600;

      yield* reportRateLimit({
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAtEpochSeconds: resetAt,
      });
      yield* awaitSnapshot(instance, (snapshot) => snapshot.limit?.window === "five_hour");

      yield* reportRateLimit({
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAtEpochSeconds: undefined,
      });
      const cleared = yield* awaitSnapshot(instance, (snapshot) => snapshot.limit === undefined);
      assert.strictEqual(cleared.limit, undefined);
    }).pipe(Effect.provide(driverTestLayer), Effect.scoped),
  );
});
