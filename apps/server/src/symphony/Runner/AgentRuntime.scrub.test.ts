import { describe, expect, it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";

import { scrubEnvironment, waitForTurnCompletion } from "./AgentRuntime.ts";

describe("scrubEnvironment (SPEC 15.3)", () => {
  it("strips secret names from the inherited environment", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      GH_TOKEN: "super-secret",
      GITHUB_PAT: "another-secret",
      KEEP_ME: "value",
    };
    const scrubbed = scrubEnvironment(env, ["GH_TOKEN", "GITHUB_PAT"]);
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/user");
    expect(scrubbed.KEEP_ME).toBe("value");
    expect(scrubbed.GH_TOKEN).toBeUndefined();
    expect(scrubbed.GITHUB_PAT).toBeUndefined();
  });

  it("never mutates the input environment", () => {
    const env = { GH_TOKEN: "secret" };
    scrubEnvironment(env, ["GH_TOKEN"]);
    expect(env.GH_TOKEN).toBe("secret");
  });

  it("handles an empty secret list as a passthrough", () => {
    const env = { A: "1", B: "2" };
    expect(scrubEnvironment(env, [])).toEqual({ A: "1", B: "2" });
  });

  it.effect("executes completion notification handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* Queue.unbounded<{
          readonly method: string;
          readonly params?: unknown;
        }>();
        const client = {
          raw: { notifications: Stream.fromQueue(notifications) },
        } as unknown as Parameters<typeof waitForTurnCompletion>[0];
        const completion = yield* waitForTurnCompletion(
          client,
          {
            codexTurnTimeoutMs: 1_000,
          } as Parameters<typeof waitForTurnCompletion>[1],
          { threadId: "thread-1", turnId: "turn-1" },
        ).pipe(Effect.forkScoped);

        yield* Queue.offer(notifications, {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });

        expect(yield* Fiber.join(completion)).toBe(true);
      }),
    ),
  );

  it.effect("fails terminal app-server errors instead of starting continuation turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* Queue.unbounded<{
          readonly method: string;
          readonly params?: unknown;
        }>();
        const client = {
          raw: { notifications: Stream.fromQueue(notifications) },
        } as unknown as Parameters<typeof waitForTurnCompletion>[0];
        const completion = yield* waitForTurnCompletion(
          client,
          {
            codexTurnTimeoutMs: 1_000,
          } as Parameters<typeof waitForTurnCompletion>[1],
          { threadId: "thread-1", turnId: "turn-1" },
        ).pipe(Effect.forkScoped);

        yield* Queue.offer(notifications, {
          method: "error",
          params: {
            error: { message: "out of credits" },
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: false,
          },
        });

        const result = yield* Effect.result(Fiber.join(completion));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message).toContain("out of credits");
        }
      }),
    ),
  );
});
