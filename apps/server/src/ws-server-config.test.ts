import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
  type ServerSettings,
} from "@neokod/contracts";
import { describe, it, assert } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { acquireServerConfigUpdates, subscribeServerConfigStream } from "./ws.ts";
import type { KeybindingsChangeEvent } from "./keybindings.ts";

const readyProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const keybindingsUpdate: KeybindingsChangeEvent = {
  keybindings: [],
  issues: [],
};

const snapshotEvent = (providers: ReadonlyArray<ServerProvider>): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config: { providers } as ServerConfig,
});

const subscribe = <A>(pubsub: PubSub.PubSub<A>) =>
  PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription));

describe("subscribeServerConfigStream", () => {
  it.live("keeps a nested merged source publish that lands before and during the snapshot", () =>
    Effect.gen(function* () {
      const keybindingsChanges = yield* PubSub.unbounded<KeybindingsChangeEvent>();
      const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
      const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
      const providerRead = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);

      const acquireUpdates = acquireServerConfigUpdates({
        keybindingsChanges: subscribe(keybindingsChanges),
        // Production acquire order: provider subscription is live, then the
        // already-running probe publishes ready before the snapshot starts.
        providerChanges: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(providerChanges);
          yield* PubSub.publish(providerChanges, [readyProvider]);
          return Stream.fromSubscription(subscription);
        }),
        settingsChanges: subscribe(settingsChanges),
      });

      const loadSnapshot = Effect.gen(function* () {
        const providers = yield* Ref.get(providersRef);
        // The picker's snapshot has read pending providers and is now blocked
        // in editor/settings discovery.
        yield* Deferred.succeed(providerRead, undefined);
        yield* Deferred.await(releaseSnapshot);
        return snapshotEvent(providers);
      });

      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            subscribeServerConfigStream({
              acquireUpdates,
              refresh: Effect.void,
              loadSnapshot,
            }),
          );

          yield* Deferred.await(providerRead);
          // Both remaining sources publish while the snapshot is still held.
          yield* PubSub.publish(keybindingsChanges, keybindingsUpdate);
          yield* PubSub.publish(settingsChanges, DEFAULT_SERVER_SETTINGS);
          yield* Deferred.succeed(releaseSnapshot, undefined);

          const stream = yield* Fiber.join(fiber);
          return yield* Stream.runCollect(stream.pipe(Stream.take(4))).pipe(
            Effect.timeoutOption("2 seconds"),
          );
        }),
      );

      assert.isTrue(Option.isSome(events));
      if (Option.isSome(events)) {
        const collected = Array.from(events.value);
        assert.equal(collected.length, 4);
        const [first, ...updates] = collected;
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.config.providers, []);
        }
        const byType = new Map(updates.map((event) => [event.type, event]));
        assert.deepEqual(byType.get("keybindingsUpdated"), {
          version: 1,
          type: "keybindingsUpdated",
          payload: keybindingsUpdate,
        });
        assert.deepEqual(byType.get("providerStatuses"), {
          version: 1,
          type: "providerStatuses",
          payload: { providers: [readyProvider] },
        });
        assert.deepEqual(byType.get("settingsUpdated"), {
          version: 1,
          type: "settingsUpdated",
          payload: { settings: DEFAULT_SERVER_SETTINGS },
        });
      }
    }),
  );

  it.effect("propagates a live producer defect instead of leaving an idle stream", () =>
    Effect.gen(function* () {
      const defect = new Error("server config live feed failed");
      const liveStreamFinalized = yield* Deferred.make<void>();
      const keybindingsChanges = yield* PubSub.unbounded<KeybindingsChangeEvent>();
      const settingsChanges = yield* PubSub.unbounded<ServerSettings>();

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            subscribeServerConfigStream({
              acquireUpdates: acquireServerConfigUpdates({
                keybindingsChanges: subscribe(keybindingsChanges),
                providerChanges: Effect.succeed(Stream.die(defect)),
                settingsChanges: subscribe(settingsChanges),
              }).pipe(
                Effect.map((updates) =>
                  updates.pipe(Stream.ensuring(Deferred.succeed(liveStreamFinalized, undefined))),
                ),
              ),
              refresh: Effect.void,
              loadSnapshot: Effect.succeed(snapshotEvent([])),
            }),
          );

          const stream = yield* Fiber.join(fiber);
          const exit = yield* Effect.exit(Stream.runDrain(stream));
          return { exit, finalized: yield* Deferred.isDone(liveStreamFinalized) };
        }),
      );

      assert.isTrue(Exit.isFailure(result.exit));
      if (Exit.isFailure(result.exit)) {
        assert.isTrue(Cause.hasDies(result.exit.cause));
      }
      assert.isTrue(result.finalized);
    }),
  );
});
