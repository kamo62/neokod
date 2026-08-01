import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import { SpawnExecutableResolution } from "@neokod/shared/shell";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  parseOpenCodeServerTimeoutMs,
} from "./opencodeRuntime.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

describe("parseOpenCodeServerTimeoutMs", () => {
  it("uses the default when the operator sets nothing", () => {
    expect(parseOpenCodeServerTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("accepts a positive integer and tolerates surrounding whitespace", () => {
    expect(parseOpenCodeServerTimeoutMs("45000")).toBe(45_000);
    expect(parseOpenCodeServerTimeoutMs("  45000  ")).toBe(45_000);
  });

  it("ignores values that would make every start fail immediately", () => {
    // A zero or negative budget times out before the process can announce
    // itself, so falling back beats honouring it.
    for (const raw of ["0", "-1", "-45000"]) {
      expect(parseOpenCodeServerTimeoutMs(raw)).toBe(DEFAULT_TIMEOUT_MS);
    }
  });

  it("ignores values that are not safe integers", () => {
    for (const raw of ["", "   ", "abc", "15s", "1.5", "1e999", "9007199254740993"]) {
      expect(parseOpenCodeServerTimeoutMs(raw)).toBe(DEFAULT_TIMEOUT_MS);
    }
  });
});

describe("OpenCodeRuntimeError", () => {
  it("reports its detail as the error message", () => {
    // Without this the error prints as a bare "OpenCodeRuntimeError:" and the
    // reason is lost unless an outer error happens to interpolate it.
    const error = new OpenCodeRuntimeError({
      operation: "startOpenCodeServerProcess",
      detail: "Timed out waiting for OpenCode server start after 15000ms.",
    });

    expect(error.message).toBe("Timed out waiting for OpenCode server start after 15000ms.");
    expect(String(error)).toContain("Timed out waiting for OpenCode server start after 15000ms.");
  });
});

// The spawn options recorded by the capturing spawner below. Structural cast
// of the private Command shape, following processRunner.test.ts.
type CapturedSpawn = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly env?: Record<string, string | undefined>;
    readonly extendEnv?: boolean;
  };
};

const SERVER_URL = "http://127.0.0.1:4097";

// A handle that behaves like a healthy `opencode serve`: it announces its
// listening URL on stdout and then stays alive until the scope kills it.
function makeServerHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(`opencode server listening on ${SERVER_URL}\n`)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const makeCapturingSpawner = (captured: Array<CapturedSpawn>) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      captured.push(command as unknown as CapturedSpawn);
      return makeServerHandle();
    }),
  );

// The platform is pinned to win32 so the shutdown finalizer goes through
// `child.kill` on the fake handle instead of `process.kill(-pid)`, which
// would signal a real process group on the host running the tests. The
// executable resolver is stubbed out so the win32 path never scans the
// real filesystem for a fake binary.
const runtimeLayerWith = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  OpenCodeRuntimeLive.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
    Layer.provide(Layer.succeed(SpawnExecutableResolution, () => undefined)),
  );

// Closing the server scope sleeps one second between SIGTERM and SIGKILL.
// Under the test clock that sleep never elapses on its own, so the started
// server runs in a forked fiber and the clock is advanced until the scope
// close settles.
const startServerAndSettle = (environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime;
    const fiber = yield* runtime
      .startOpenCodeServerProcess({
        binaryPath: "fake-opencode",
        port: 4097,
        ...(environment !== undefined ? { environment } : {}),
      })
      .pipe(Effect.scoped, Effect.forkChild);
    for (let round = 0; round < 5; round++) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
    }
    return yield* Fiber.join(fiber);
  });

describe("startOpenCodeServerProcess environment passthrough", () => {
  it.effect("passes an inherited OPENCODE_CONFIG_CONTENT to the server unchanged", () => {
    const configContent = '{"provider":{"myprovider":{"models":{"custom-model":{}}}}}';
    const captured: Array<CapturedSpawn> = [];
    return Effect.gen(function* () {
      const server = yield* startServerAndSettle({
        HOME: "/home/operator",
        OPENCODE_CONFIG_CONTENT: configContent,
      });

      expect(server.url).toBe(SERVER_URL);
      expect(captured).toHaveLength(1);
      // The forced empty config used to win over the spread here, so the
      // operator's exported value was replaced with "{}" before the child
      // ever saw it.
      expect(captured[0]?.options.env?.OPENCODE_CONFIG_CONTENT).toBe(configContent);
    }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured))));
  });

  it.effect(
    "does not synthesize an empty OPENCODE_CONFIG_CONTENT into the caller's environment",
    () => {
      const captured: Array<CapturedSpawn> = [];
      return Effect.gen(function* () {
        yield* startServerAndSettle({
          HOME: "/home/operator",
          PATH: "/usr/bin",
        });

        expect(captured).toHaveLength(1);
        // Exact match: nothing injected, and the caller's environment
        // (including HOME, which opencode needs to find its config and
        // auth state) reaches the child as-is.
        expect(captured[0]?.options.env).toEqual({
          HOME: "/home/operator",
          PATH: "/usr/bin",
        });
      }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured))));
    },
  );

  it.effect("inherits the parent environment wholesale when no environment is given", () => {
    const captured: Array<CapturedSpawn> = [];
    return Effect.gen(function* () {
      yield* startServerAndSettle();

      expect(captured).toHaveLength(1);
      // No override object at all: the child extends the parent process
      // environment, so an operator-exported OPENCODE_CONFIG_CONTENT wins.
      expect(captured[0]?.options.env).toBeUndefined();
      expect(captured[0]?.options.extendEnv).toBe(true);
    }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured))));
  });
});
