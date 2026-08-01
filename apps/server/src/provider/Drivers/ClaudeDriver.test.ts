import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@neokod/contracts";
import * as Duration from "effect/Duration";
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

// The stickiness bug lived in the cache `ClaudeDriver.create` builds, not in
// any cache a test could assemble for itself, so the regression test below
// drives the real driver. Only `probeClaudeCapabilities` is stubbed: it is
// the one lookup that would otherwise spawn a Claude Agent SDK subprocess,
// and the stub is where consecutive misses are counted.
const capabilitiesProbeState = vi.hoisted(() => ({ lookups: 0 }));

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
