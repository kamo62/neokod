import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  type CopilotRuntimeClient,
  makeCopilotRuntimeSupervisor,
} from "./CopilotRuntimeSupervisor.ts";

interface FakeRuntime {
  readonly client: CopilotRuntimeClient;
  readonly calls: { ping: number; start: number; forceStop: number };
  readonly setDead: (dead: boolean) => void;
}

function makeFakeRuntime(options?: {
  readonly startFailure?: string;
  readonly pingNeverResolves?: boolean;
}): FakeRuntime {
  let dead = true;
  const calls = { ping: 0, start: 0, forceStop: 0 };
  return {
    calls,
    setDead: (next) => {
      dead = next;
    },
    client: {
      ping: () => {
        calls.ping += 1;
        if (options?.pingNeverResolves) {
          return new Promise(() => {});
        }
        return dead
          ? Promise.reject(new Error("Connection is closed."))
          : Promise.resolve({ protocolVersion: "test" });
      },
      start: () => {
        calls.start += 1;
        if (options?.startFailure) {
          return Promise.reject(new Error(options.startFailure));
        }
        dead = false;
        return Promise.resolve();
      },
      forceStop: () => {
        calls.forceStop += 1;
        return Promise.resolve();
      },
    },
  };
}

describe("CopilotRuntimeSupervisor", () => {
  it.effect("restarts a dead runtime once", () =>
    Effect.gen(function* () {
      const runtime = makeFakeRuntime();
      const supervisor = yield* makeCopilotRuntimeSupervisor(runtime.client);

      const results = yield* Effect.all([supervisor.restartIfDead, supervisor.restartIfDead], {
        concurrency: 2,
      });

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(runtime.calls.start).toBe(1);
      expect(runtime.calls.forceStop).toBe(1);
      expect(yield* SubscriptionRef.get(supervisor.restartCount)).toBe(1);
    }),
  );

  it.effect("leaves an alive runtime alone", () =>
    Effect.gen(function* () {
      const runtime = makeFakeRuntime();
      runtime.setDead(false);
      const supervisor = yield* makeCopilotRuntimeSupervisor(runtime.client);

      expect(yield* supervisor.restartIfDead).toBe(false);
      expect(runtime.calls.forceStop).toBe(0);
      expect(runtime.calls.start).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.restartCount)).toBe(0);
    }),
  );

  it.effect("treats a ping timeout as unknown", () =>
    Effect.gen(function* () {
      const runtime = makeFakeRuntime({ pingNeverResolves: true });
      const supervisor = yield* makeCopilotRuntimeSupervisor(runtime.client);
      const probeFiber = yield* supervisor.probe.pipe(Effect.forkChild);

      yield* TestClock.adjust("6 seconds");
      expect(yield* Fiber.join(probeFiber)).toBe("unknown");

      const restartFiber = yield* supervisor.restartIfDead.pipe(Effect.forkChild);
      yield* TestClock.adjust("6 seconds");
      expect(yield* Fiber.join(restartFiber)).toBe(false);
      expect(runtime.calls.forceStop).toBe(0);
      expect(runtime.calls.start).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.restartCount)).toBe(0);
    }),
  );

  it.effect("reports a failed start", () =>
    Effect.gen(function* () {
      const runtime = makeFakeRuntime({ startFailure: "spawn failed" });
      const supervisor = yield* makeCopilotRuntimeSupervisor(runtime.client);

      expect(yield* supervisor.restartIfDead).toBe(false);
      expect(runtime.calls.start).toBe(1);
      expect(runtime.calls.forceStop).toBe(1);
      expect(yield* SubscriptionRef.get(supervisor.restartCount)).toBe(0);
    }),
  );
});
