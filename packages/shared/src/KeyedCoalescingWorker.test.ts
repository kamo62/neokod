import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  it.live("waits for latest work enqueued during active processing before draining the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (value === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker
            .drainKey("terminal-1")
            .pipe(Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie))),
        );

        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );

  it.live("requeues pending work for a key after a processor failure and keeps draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFailure);
                return yield* Effect.fail("boom");
              }

              if (value === "second") {
                yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );

  it.live("retains a failed value and merges it into the next enqueue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (current, next) => `${current}+${next}`,
          process: (_key, value) =>
            Effect.gen(function* () {
              processed.push(value);
              if (value === "a") return yield* Effect.fail("boom");
            }),
        });

        yield* worker.enqueue("k", "a");
        yield* worker.drainKey("k");
        yield* worker.enqueue("k", "b");
        yield* worker.drainKey("k");

        expect(processed).toEqual(["a", "a+b"]);
      }),
    ),
  );

  it.live("retryFailed reprocesses a retained value once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        let calls = 0;
        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (_key, value) =>
            Effect.gen(function* () {
              calls += 1;
              processed.push(value);
              if (calls === 1) return yield* Effect.fail("boom");
            }),
        });

        yield* worker.enqueue("k", "a");
        yield* worker.drainKey("k");
        yield* worker.retryFailed("k");
        yield* worker.drainKey("k");
        expect(processed).toEqual(["a", "a"]);
        yield* worker.retryFailed("k");
        expect(processed.length).toBe(2);
      }),
    ),
  );

  it.live("retryFailed does nothing while newer work is pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const release = yield* Deferred.make<void>();
        const bStarted = yield* Deferred.make<void>();
        let first = true;
        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (current, next) => `${current}+${next}`,
          process: (_key, value) =>
            Effect.gen(function* () {
              processed.push(value);
              if (first) {
                first = false;
                return yield* Effect.fail("boom");
              }
              if (value === "a+b") {
                yield* Deferred.succeed(bStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(release);
              }
            }),
        });

        yield* worker.enqueue("k", "a");
        yield* worker.drainKey("k");
        yield* worker.enqueue("k", "b");
        yield* Deferred.await(bStarted);
        yield* worker.retryFailed("k");
        yield* Deferred.succeed(release, undefined).pipe(Effect.orDie);
        yield* worker.drainKey("k");
        expect(processed).toEqual(["a", "a+b"]);
      }),
    ),
  );
});
