// @effect-diagnostics nodeBuiltinImport:off - fixtures use synchronous temp files and paths
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
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
  parseOpenCodeServerUrlFromOutput,
  terminateOpenCodeProcessGroup,
} from "./opencodeRuntime.ts";
import { OpenCodeServerLedger, type OpenCodeServerLedgerShape } from "./OpenCodeServerLedger.ts";
import { OPENCODE_VERSION_PROBE_TIMEOUT } from "./openCodeVersion.ts";

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

describe("parseOpenCodeServerUrlFromOutput", () => {
  it("accepts the OpenCode 1.x readiness banner", () => {
    expect(parseOpenCodeServerUrlFromOutput(`opencode server listening on ${SERVER_URL}\n`)).toBe(
      SERVER_URL,
    );
  });

  it("accepts the OpenCode 2 readiness banner without implying v2 support", () => {
    expect(parseOpenCodeServerUrlFromOutput(`server listening on ${SERVER_URL}\n`)).toBe(
      SERVER_URL,
    );
  });

  it("ignores unrelated output", () => {
    expect(parseOpenCodeServerUrlFromOutput("starting opencode\n")).toBeNull();
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

const makeCommandHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

// A command that never produces output and never exits, like an executable
// blocked before it can answer `--version`. Only the probe timeout can settle it.
const makeHangingCommandHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.never,
    stderr: Stream.never,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeCapturingSpawner = (
  captured: Array<CapturedSpawn>,
  versionStdout = "opencode 1.14.19\n",
) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const capturedCommand = command as unknown as CapturedSpawn;
      captured.push(capturedCommand);
      return capturedCommand.args.includes("--version")
        ? makeCommandHandle(versionStdout)
        : makeServerHandle();
    }),
  );

// A CLI whose `--version` never answers. The server command still behaves.
const makeHangingVersionSpawner = (
  captured: Array<CapturedSpawn>,
  versionSpawned: Deferred.Deferred<void>,
) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const capturedCommand = command as unknown as CapturedSpawn;
      captured.push(capturedCommand);
      if (capturedCommand.args.includes("--version")) {
        yield* Deferred.succeed(versionSpawned, void 0);
        return makeHangingCommandHandle();
      }
      return makeServerHandle();
    }),
  );

const capturedServerSpawns = (captured: ReadonlyArray<CapturedSpawn>) =>
  captured.filter((spawn) => spawn.args.includes("serve"));

// Records the order of shutdown effects. The runtime kills through the fake
// handle, and the fake ledger records when the entry is forgotten.
const makeOrderingSpawner = (events: Array<string>) =>
  ChildProcessSpawner.make((command) =>
    Effect.succeed(
      (command as unknown as CapturedSpawn).args.includes("--version")
        ? makeCommandHandle("opencode 1.14.19\n")
        : makeServerHandle(() => {
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

const runtimeLayerWithRealSpawner = () =>
  OpenCodeRuntimeLive.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(OpenCodeServerLedger, NOOP_LEDGER)),
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
      const serverSpawn = capturedServerSpawns(captured)[0];
      expect(serverSpawn).toBeDefined();
      // The forced empty config used to win over the spread here, so the
      // operator's exported value was replaced with "{}" before the child
      // ever saw it.
      expect(serverSpawn?.options.env?.OPENCODE_CONFIG_CONTENT).toBe(configContent);
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

        const serverSpawn = capturedServerSpawns(captured)[0];
        expect(serverSpawn).toBeDefined();
        // Exact match: nothing injected beyond the per-spawn password, and the
        // caller's environment (including HOME, which opencode needs to find
        // its config and auth state) reaches the child as-is.
        expect(serverSpawn?.options.env).toEqual({
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

      const serverSpawn = capturedServerSpawns(captured)[0];
      expect(serverSpawn).toBeDefined();
      // The scrub must also apply when the caller passes no environment: the
      // spawner used to merge the parent environment back over the child env.
      expect(serverSpawn?.options.extendEnv).toBe(false);
      expect(serverSpawn?.options.env?.NEOKOD_TEST_SECRET).toBeUndefined();
      expect(serverSpawn?.options.env?.OPENCODE_PASSWORD).toBeUndefined();
      expect(serverSpawn?.options.env?.PATH).toBe(process.env.PATH);
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
      const [firstServerSpawn, secondServerSpawn] = capturedServerSpawns(captured);
      expect(firstServerSpawn?.options.env?.OPENCODE_SERVER_PASSWORD).toBe(first.serverPassword);
      expect(secondServerSpawn?.options.env?.OPENCODE_SERVER_PASSWORD).toBe(second.serverPassword);
      for (const spawn of captured) {
        expect(spawn.args.join(" ")).not.toContain(first.serverPassword);
        expect(spawn.args.join(" ")).not.toContain(second.serverPassword);
      }
    }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured))));
  });
});

describe("startOpenCodeServerProcess version guard", () => {
  it.effect("refuses to launch the OpenCode 2 HTTP server", () => {
    const captured: Array<CapturedSpawn> = [];
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(startServerAndSettle());

      expect(Exit.isFailure(exit)).toBe(true);
      expect(capturedServerSpawns(captured)).toHaveLength(0);
      expect(captured.map((spawn) => spawn.args.join(" "))).toEqual(["--version"]);
    }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured, "opencode v2.0.32\n"))));
  });

  it.effect("still launches the supported OpenCode 1.x HTTP server", () => {
    const captured: Array<CapturedSpawn> = [];
    return Effect.gen(function* () {
      const server = yield* startServerAndSettle();

      expect(server.url).toBe(SERVER_URL);
      expect(capturedServerSpawns(captured)).toHaveLength(1);
    }).pipe(Effect.provide(runtimeLayerWith(makeCapturingSpawner(captured, "opencode 1.18.15\n"))));
  });

  it.effect("starts the server after a hung --version probe times out", () => {
    const captured: Array<CapturedSpawn> = [];
    const versionSpawned = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const fiber = yield* runtime
        .startOpenCodeServerProcess({ binaryPath: "fake-opencode", port: 4097 })
        .pipe(Effect.scoped, Effect.forkChild);
      yield* Deferred.await(versionSpawned);

      // The fake CLI never answers `--version`. One millisecond before the
      // bound, startup must still be waiting on the probe rather than serving.
      yield* TestClock.adjust(
        Duration.millis(Duration.toMillis(OPENCODE_VERSION_PROBE_TIMEOUT) - 1),
      );
      yield* Effect.yieldNow;
      expect(captured.map((spawn) => spawn.args.join(" "))).toEqual(["--version"]);
      expect(fiber.pollUnsafe()).toBeUndefined();

      // At the bound the probe resolves unknown and the supported server starts
      // through its normal path.
      yield* TestClock.adjust("1 millis");
      yield* Effect.yieldNow;
      expect(capturedServerSpawns(captured)).toHaveLength(1);
      for (let round = 0; round < 5; round++) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
      }
      const server = yield* Fiber.join(fiber);

      expect(server.url).toBe(SERVER_URL);
      expect(capturedServerSpawns(captured)).toHaveLength(1);
    }).pipe(Effect.provide(runtimeLayerWith(makeHangingVersionSpawner(captured, versionSpawned))));
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

// The real Node spawner, and a real POSIX process group per fixture. Each test
// owns the only processes in its group, so a stray `kill(-pgid, ...)` can only
// hit the fixture and never an unrelated process on the host.
const makeFixtureDirectory = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "neokod-opencode-runtime-"));

const writeExecutableFixture = (directory: string, name: string, lines: ReadonlyArray<string>) => {
  const filePath = NodePath.join(directory, name);
  NodeFS.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o755 });
  return filePath;
};

const readFixturePid = (filePath: string): number | undefined => {
  try {
    const parsed = Number(NodeFS.readFileSync(filePath, "utf8").trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killFixture = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};

const waitForProcessExit = (pid: number, timeoutMs: number) =>
  Effect.gen(function* () {
    for (let waited = 0; waited < timeoutMs; waited += 50) {
      if (!isProcessAlive(pid)) return true;
      yield* Effect.sleep("50 millis");
    }
    return !isProcessAlive(pid);
  });

// POSIX-only fixtures; the runtime's platform reference is provided per effect
// below. This is suite-level gating, not runtime code.
// oxlint-disable-next-line neokod/no-global-process-runtime
const describeOnPosix = NodeOS.platform() === "win32" ? describe.skip : describe;

describeOnPosix("startOpenCodeServerProcess spawner ownership", () => {
  it.live("does not let the spawner scope finalizer signal a group the guard refused", () => {
    const directory = makeFixtureDirectory();
    const leaderPidPath = NodePath.join(directory, "leader.pid");
    const fixturePath = writeExecutableFixture(directory, "failing-opencode.sh", [
      "#!/bin/sh",
      `echo $$ > "${leaderPidPath}"`,
      "exit 7",
    ]);

    // The real spawner calls `globalThis.process.kill(-pid, signal)` directly
    // from its scope finalizer. Intercept that one boundary so the test sees
    // the call without sending a real group signal; non-group calls pass
    // through unchanged.

    return Effect.gen(function* () {
      const originalKill = process.kill.bind(process);
      const groupSignals: Array<{
        readonly pid: number;
        readonly signal: string | number | undefined;
      }> = [];
      process.kill = ((pid: number, signal?: string | number) => {
        if (pid < 0) {
          groupSignals.push({ pid, signal });
          return true;
        }
        return originalKill(pid, signal);
      }) as typeof process.kill;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const exit = yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: fixturePath,
              port: 4097,
              timeoutMs: 5_000,
              environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory },
            })
            .pipe(Effect.scoped, Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          const leaderPid = readFixturePid(leaderPidPath);
          expect(leaderPid, "the fixture must record its pid").toBeDefined();

          // Scope close has already run by now: the guarded cleanup refused
          // because the leader had exited non-zero, and the spawner's own
          // finalizer used to follow it with an unguarded SIGTERM to -pgid.
          expect(
            groupSignals,
            "scope close must not signal the recorded group after the guard refused",
          ).toEqual([]);
        }),
        Effect.sync(() => {
          process.kill = originalKill;
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      );
    }).pipe(Effect.provide(runtimeLayerWithRealSpawner()));
  });

  it.live("still terminates an owned server group through the guarded path", () => {
    const directory = makeFixtureDirectory();
    const serverPidPath = NodePath.join(directory, "server.pid");
    const fixturePath = writeExecutableFixture(directory, "healthy-opencode.sh", [
      "#!/bin/sh",
      `echo $$ > "${serverPidPath}"`,
      "echo 'opencode server listening on http://127.0.0.1:4097'",
      "trap 'exit 0' TERM",
      "while :; do sleep 1; done",
    ]);
    let serverPid: number | undefined;

    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const exit = yield* runtime
        .startOpenCodeServerProcess({
          binaryPath: fixturePath,
          port: 4097,
          timeoutMs: 5_000,
          environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory },
        })
        .pipe(Effect.scoped, Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
      serverPid = readFixturePid(serverPidPath);
      expect(serverPid, "the fixture must record its pid").toBeDefined();

      // The fixture loops forever unless signalled. The guarded finalizer is
      // the only cleanup owner now, so its TERM-to-exit remains observable.
      const exited = yield* waitForProcessExit(serverPid!, 4_000);
      expect(exited, "closing the server scope must still stop the owned group").toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const pid = serverPid ?? readFixturePid(serverPidPath);
          if (pid !== undefined && isProcessAlive(pid)) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              killFixture(pid);
            }
          }
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      ),
      Effect.provide(runtimeLayerWithRealSpawner()),
    );
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

  it.effect("refuses every signal when the recorded leader was reused", () => {
    const state: FakeGroupState = { alive: true, signals: [] };
    const birthReader: ProcessBirthReader = {
      readBirthToken: () => Effect.succeed({ kind: "token", token: "replacement-birth-token" }),
    };

    return runGroupTermination(birthReader, state).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // A live group whose leader no longer matches the recorded birth
          // token may be a recycled pgid. Even the first signal must fail
          // closed and leave the ledger evidence intact.
          expect(state.signals).toEqual([]);
        }),
      ),
    );
  });

  it.effect("refuses every signal when the leader is gone but the group survives", () => {
    const state: FakeGroupState = { alive: true, signals: [] };
    const birthReader: ProcessBirthReader = {
      readBirthToken: () => Effect.succeed({ kind: "no_such_process" }),
    };

    return runGroupTermination(birthReader, state).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // A missing leader is not proof that the group is ours, and the
          // remaining members have no verified identity.
          expect(state.signals).toEqual([]);
        }),
      ),
    );
  });

  it.effect("refuses every signal when the birth identity is unavailable", () => {
    const state: FakeGroupState = { alive: true, signals: [] };
    const birthReader: ProcessBirthReader = {
      readBirthToken: () => Effect.succeed({ kind: "unavailable", detail: "ps_failed" }),
    };

    return runGroupTermination(birthReader, state).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // An unreadable identity is unknown evidence, not permission to
          // signal a group that may belong to another process.
          expect(state.signals).toEqual([]);
        }),
      ),
    );
  });
});
