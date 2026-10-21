import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import type { ProcessBirthReader, ProcessGroupSignaller } from "@neokod/shared/processGroup";
import { SpawnExecutableResolution } from "@neokod/shared/shell";

import {
  buildOpenCodeServerEnvironment,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  parseOpenCodeServerTimeoutMs,
  terminateOpenCodeProcessGroup,
} from "./opencodeRuntime.ts";
import { OpenCodeServerLedger, type OpenCodeServerLedgerShape } from "./OpenCodeServerLedger.ts";

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

describe("buildOpenCodeServerEnvironment", () => {
  it("drops NEOKOD_, T3CODE_ and inherited OpenCode auth names", () => {
    const env = buildOpenCodeServerEnvironment(
      {
        HOME: "/home/operator",
        PATH: "/usr/bin",
        NEOKOD_ACCESS_TOKEN: "secret",
        T3CODE_MODE: "dev",
        OPENCODE_SERVER_PASSWORD: "legacy-password",
        OPENCODE_SERVER_USERNAME: "someone",
        OPENCODE_PASSWORD: "newer-password",
        OPENCODE_CONFIG_CONTENT: "{}",
        ANTHROPIC_API_KEY: "provider-key",
      },
      "spawned-password",
    );

    expect(env).toEqual({
      HOME: "/home/operator",
      PATH: "/usr/bin",
      OPENCODE_CONFIG_CONTENT: "{}",
      ANTHROPIC_API_KEY: "provider-key",
      OPENCODE_SERVER_PASSWORD: "spawned-password",
    });
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
function makeServerHandle(onKill?: () => void) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.sync(() => onKill?.()),
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

// Records the order of shutdown effects. The runtime kills through the fake
// handle, and the fake ledger records when the entry is forgotten.
const makeOrderingSpawner = (events: Array<string>) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      makeServerHandle(() => {
        events.push("terminate");
      }),
    ),
  );

const makeRecordingLedger = (events: Array<string>): OpenCodeServerLedgerShape => ({
  track: () =>
    Effect.sync(() => {
      events.push("track");
      return Effect.sync(() => {
        events.push("forget");
      });
    }),
});

const NOOP_LEDGER: OpenCodeServerLedgerShape = {
  track: () => Effect.succeed(Effect.void),
};

// The platform is pinned to win32 so the shutdown finalizer goes through
// `child.kill` on the fake handle instead of `process.kill(-pid)`, which
// would signal a real process group on the host running the tests. The
// executable resolver is stubbed out so the win32 path never scans the
// real filesystem for a fake binary.
const runtimeLayerWith = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ledger: OpenCodeServerLedgerShape = NOOP_LEDGER,
) =>
  OpenCodeRuntimeLive.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
    Layer.provide(Layer.succeed(SpawnExecutableResolution, () => undefined)),
    Layer.provide(Layer.succeed(OpenCodeServerLedger, ledger)),
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
        // Exact match: nothing injected beyond the per-spawn password, and the
        // caller's environment (including HOME, which opencode needs to find
        // its config and auth state) reaches the child as-is.
        expect(captured[0]?.options.env).toEqual({
          HOME: "/home/operator",
          PATH: "/usr/bin",
          OPENCODE_SERVER_PASSWORD: expect.any(String),
        });
      }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured))));
    },
  );

  it.effect("uses the scrubbed process environment when none is given", () => {
    const captured: Array<CapturedSpawn> = [];
    const previousSecret = process.env.NEOKOD_TEST_SECRET;
    const previousOpenCodePassword = process.env.OPENCODE_PASSWORD;
    return Effect.gen(function* () {
      process.env.NEOKOD_TEST_SECRET = "x";
      process.env.OPENCODE_PASSWORD = "inherited";
      yield* startServerAndSettle();

      expect(captured).toHaveLength(1);
      // The scrub must also apply when the caller passes no environment: the
      // spawner used to merge the parent environment back over the child env.
      expect(captured[0]?.options.extendEnv).toBe(false);
      expect(captured[0]?.options.env?.NEOKOD_TEST_SECRET).toBeUndefined();
      expect(captured[0]?.options.env?.OPENCODE_PASSWORD).toBeUndefined();
      expect(captured[0]?.options.env?.PATH).toBe(process.env.PATH);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousSecret === undefined) {
            delete process.env.NEOKOD_TEST_SECRET;
          } else {
            process.env.NEOKOD_TEST_SECRET = previousSecret;
          }
          if (previousOpenCodePassword === undefined) {
            delete process.env.OPENCODE_PASSWORD;
          } else {
            process.env.OPENCODE_PASSWORD = previousOpenCodePassword;
          }
        }),
      ),
      Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured))),
    );
  });

  it.effect("generates a distinct password per spawn and keeps it out of argv", () => {
    const captured: Array<CapturedSpawn> = [];
    return Effect.gen(function* () {
      const first = yield* startServerAndSettle({ HOME: "/home/operator" });
      const second = yield* startServerAndSettle({ HOME: "/home/operator" });

      expect(typeof first.serverPassword).toBe("string");
      expect(typeof second.serverPassword).toBe("string");
      expect(first.serverPassword?.length ?? 0).toBeGreaterThanOrEqual(40);
      expect(first.serverPassword, "each spawned server needs its own credential").not.toBe(
        second.serverPassword,
      );
      expect(captured[0]?.options.env?.OPENCODE_SERVER_PASSWORD).toBe(first.serverPassword);
      expect(captured[1]?.options.env?.OPENCODE_SERVER_PASSWORD).toBe(second.serverPassword);
      expect(captured[0]?.args.join(" ")).not.toContain(first.serverPassword);
      expect(captured[1]?.args.join(" ")).not.toContain(second.serverPassword);
    }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured))));
  });
});

describe("startOpenCodeServerProcess shutdown ordering", () => {
  it.effect("terminates the process before forgetting its ledger entry", () => {
    const events: Array<string> = [];
    return Effect.gen(function* () {
      yield* startServerAndSettle();

      // Scope finalizers run last-in-first-out. Forgetting before termination
      // would drop the only durable evidence of a child that a crash could
      // still leave running, so the kill must settle first.
      expect(events).toEqual(["track", "terminate", "terminate", "forget"]);
    }).pipe(
      Effect.provide(runtimeLayerWith(makeOrderingSpawner(events), makeRecordingLedger(events))),
    );
  });

  it.effect("still terminates the child when tracking fails", () => {
    const events: Array<string> = [];
    const failingLedger: OpenCodeServerLedgerShape = {
      track: () => Effect.die(new Error("ledger unavailable")),
    };
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(startServerAndSettle());

      expect(Exit.isFailure(exit)).toBe(true);
      // Registration of the shutdown finalizer must not depend on tracking
      // succeeding, or a failed spawn record would leak a live child.
      expect(events.filter((event) => event === "terminate")).toHaveLength(2);
    }).pipe(Effect.provide(runtimeLayerWith(makeOrderingSpawner(events), failingLedger)));
  });
});

interface FakeGroupState {
  alive: boolean;
  readonly signals: Array<NodeJS.Signals>;
}

const makeFakeGroupSignaller = (state: FakeGroupState): ProcessGroupSignaller => ({
  signalGroup: (_pgid, signal) =>
    Effect.sync(() => {
      state.signals.push(signal);
      return "sent" as const;
    }),
  isGroupAlive: () => Effect.sync(() => state.alive),
});

const runGroupTermination = (
  birthReader: ProcessBirthReader,
  state: FakeGroupState,
  birthToken: string | null = "captured-birth-token",
) =>
  Effect.gen(function* () {
    const fiber = yield* terminateOpenCodeProcessGroup(
      { pgid: 500, birthToken },
      { signaller: makeFakeGroupSignaller(state), birthReader },
    ).pipe(Effect.forkChild);
    for (let round = 0; round < 10; round++) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
    }
    yield* Fiber.join(fiber);
  });

describe("terminateOpenCodeProcessGroup", () => {
  it.effect("escalates only after the birth identity is still confirmed", () => {
    const state: FakeGroupState = { alive: true, signals: [] };
    const birthReader: ProcessBirthReader = {
      readBirthToken: () => Effect.succeed({ kind: "token", token: "captured-birth-token" }),
    };

    return runGroupTermination(birthReader, state).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);
        }),
      ),
    );
  });

  it.effect("refuses SIGKILL when the recorded leader was reused", () => {
    const state: FakeGroupState = { alive: true, signals: [] };
    const birthReader: ProcessBirthReader = {
      readBirthToken: () => Effect.succeed({ kind: "token", token: "replacement-birth-token" }),
    };

    return runGroupTermination(birthReader, state).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // The group is still alive, but it no longer proves it is ours:
          // escalation must fail closed and leave the ledger evidence intact.
          expect(state.signals).toEqual(["SIGTERM"]);
        }),
      ),
    );
  });

  it.effect("refuses SIGKILL when the leader is gone but the group survives", () => {
    const state: FakeGroupState = { alive: true, signals: [] };
    const birthReader: ProcessBirthReader = {
      readBirthToken: () => Effect.succeed({ kind: "no_such_process" }),
    };

    return runGroupTermination(birthReader, state).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // A missing leader is not proof that the group is gone, and the
          // remaining members have no verified identity.
          expect(state.signals).toEqual(["SIGTERM"]);
        }),
      ),
    );
  });
});
