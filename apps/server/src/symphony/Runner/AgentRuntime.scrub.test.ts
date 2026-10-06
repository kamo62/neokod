import { describe, expect, it } from "@effect/vitest";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import { makeCodexAgentRuntime, scrubEnvironment, waitForTurnCompletion } from "./AgentRuntime.ts";
import { makeLiveRequests } from "./LiveRequests.ts";

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

type CapturedSpawn = {
  readonly options: {
    readonly env?: Record<string, string | undefined>;
    readonly extendEnv?: boolean;
  };
};

const finalSpawnEnvironment = (
  options: CapturedSpawn["options"],
): Record<string, string | undefined> =>
  options.extendEnv === true ? { ...process.env, ...options.env } : (options.env ?? {});

const capturingSpawner = (captured: Array<CapturedSpawn>) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      captured.push(command as unknown as CapturedSpawn);
      throw new Error("captured");
    }),
  );

describe("agent child environment", () => {
  it.effect("the child receives the scrubbed environment and CODEX_HOME", () =>
    Effect.scoped(
      Effect.gen(function* () {
        process.env.NEOKOD_SCRUB_TEST_SECRET = "leak";
        try {
          const captured: Array<CapturedSpawn> = [];
          const liveRequests = yield* makeLiveRequests;
          const runtime = yield* makeCodexAgentRuntime({
            codexCommand: "codex",
            codexHomePath: "/tmp/codex-home",
            env: { PATH: "/usr/bin", HOME: "/home/u", GH_TOKEN: "s3cret", KEEP: "k" },
            secretEnvironmentNames: ["GH_TOKEN", "NEOKOD_SCRUB_TEST_SECRET"],
            liveRequests,
          }).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              capturingSpawner(captured),
            ),
            Effect.provideService(HostProcessPlatform, "linux"),
          );
          yield* Effect.exit(runtime.runTurn({} as never));
          expect(captured.length).toBeGreaterThan(0);
          expect(captured[0]?.options.extendEnv).not.toBe(true);
          expect(captured[0]?.options.env).toEqual({
            PATH: "/usr/bin",
            HOME: "/home/u",
            KEEP: "k",
            CODEX_HOME: "/tmp/codex-home",
          });
          expect(finalSpawnEnvironment(captured[0]?.options ?? {}).NEOKOD_SCRUB_TEST_SECRET).toBe(
            undefined,
          );
          expect(finalSpawnEnvironment(captured[0]?.options ?? {}).GH_TOKEN).toBe(undefined);
          expect(finalSpawnEnvironment(captured[0]?.options ?? {}).PATH).toBe("/usr/bin");
          expect(finalSpawnEnvironment(captured[0]?.options ?? {}).HOME).toBe("/home/u");
        } finally {
          delete process.env.NEOKOD_SCRUB_TEST_SECRET;
        }
      }),
    ),
  );

  it.effect("refuses to spawn when the secret list is unresolved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captured: Array<CapturedSpawn> = [];
        const liveRequests = yield* makeLiveRequests;
        const runtime = yield* makeCodexAgentRuntime({
          codexCommand: "codex",
          codexHomePath: "/tmp/codex-home",
          env: { PATH: "/usr/bin" },
          secretEnvironmentNames: null,
          liveRequests,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            capturingSpawner(captured),
          ),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        const exit = yield* Effect.exit(runtime.runTurn({} as never));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("cannot be scrubbed");
        }
        expect(captured).toEqual([]);
      }),
    ),
  );

  it.effect("no secrets means the whole environment is passed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captured: Array<CapturedSpawn> = [];
        const liveRequests = yield* makeLiveRequests;
        const runtime = yield* makeCodexAgentRuntime({
          codexCommand: "codex",
          codexHomePath: "/tmp/codex-home",
          env: { PATH: "/usr/bin", HOME: "/home/u", GH_TOKEN: "s3cret", KEEP: "k" },
          liveRequests,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            capturingSpawner(captured),
          ),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        yield* Effect.exit(runtime.runTurn({} as never));
        const final = finalSpawnEnvironment(captured[0]?.options ?? {});
        expect(final.KEEP).toBe("k");
        expect(final.GH_TOKEN).toBe("s3cret");
      }),
    ),
  );
});
