import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  make,
  OpenCodeServerLedgerEntry,
  type ObservedProcess,
  type ProcessInspector,
  type ProcessObservation,
} from "./OpenCodeServerLedger.ts";

const OWNER_START = "Sun Oct  4 22:04:25 2026";
const SERVER_START = "Sun Oct  4 22:05:00 2026";
const SERVER_ARGS = ["serve", "--hostname=127.0.0.1", "--port=4100"];
const SERVER_COMMAND = `/bin/opencode ${SERVER_ARGS.join(" ")}`;

const decodeEntry = Schema.decodeSync(Schema.fromJsonString(OpenCodeServerLedgerEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(OpenCodeServerLedgerEntry));

interface FakeInspector {
  readonly inspector: ProcessInspector;
  readonly processes: Map<number, ObservedProcess>;
  readonly signals: Array<{ readonly pgid: number; readonly signal: NodeJS.Signals }>;
  /** When true, SIGTERM leaves the group in the map to exercise escalation. */
  ignoreTerm: boolean;
  /** When true, inspecting the recorded server pid fails instead of answering. */
  failObserve: boolean;
  /** Pids whose inspection reports unknown evidence instead of present/absent. */
  readonly unknownObservePids: Set<number>;
  /** When true, reading the group members fails instead of answering. */
  failObserveGroup: boolean;
  /** When true, the group-liveness probe fails instead of answering. */
  failGroupExists: boolean;
  /** When set, signalling the group fails before any signal is recorded. */
  failSignal?: Error;
  /** Hook used to simulate a group exiting and its id being reused after SIGTERM. */
  onTerm?: () => void;
}

const makeFakeInspector = (): FakeInspector => {
  const processes = new Map<number, ObservedProcess>();
  const signals: Array<{ readonly pgid: number; readonly signal: NodeJS.Signals }> = [];
  const fake: FakeInspector = {
    processes,
    signals,
    ignoreTerm: false,
    failObserve: false,
    unknownObservePids: new Set<number>(),
    failObserveGroup: false,
    failGroupExists: false,
    inspector: {
      observe: (pid): Effect.Effect<ProcessObservation> =>
        Effect.suspend((): Effect.Effect<ProcessObservation> => {
          if (fake.failObserve && pid === 500) {
            return Effect.die(new Error("inspection unavailable"));
          }
          if (fake.unknownObservePids.has(pid)) {
            return Effect.succeed({ state: "unknown" as const });
          }
          return Effect.sync(() => {
            const process = processes.get(pid);
            return process === undefined
              ? { state: "absent" as const }
              : { state: "present" as const, process };
          });
        }),
      observeGroup: (pgid) =>
        Effect.suspend(() => {
          if (fake.failObserveGroup) {
            return Effect.die(new Error("group inspection unavailable"));
          }
          return Effect.sync(() => [...processes.values()].filter((entry) => entry.pgid === pgid));
        }),
      groupExists: (pgid) =>
        Effect.suspend(() => {
          if (fake.failGroupExists) {
            return Effect.die(new Error("group liveness unavailable"));
          }
          return Effect.sync(() => [...processes.values()].some((entry) => entry.pgid === pgid));
        }),
      signalGroup: (pgid, signal) =>
        Effect.suspend(() => {
          if (fake.failSignal !== undefined) {
            return Effect.die(fake.failSignal);
          }
          return Effect.sync(() => {
            signals.push({ pgid, signal });
            if (signal === "SIGTERM" && !fake.ignoreTerm) {
              for (const [pid, entry] of processes) {
                if (entry.pgid === pgid) {
                  processes.delete(pid);
                }
              }
            }
            if (signal === "SIGTERM") {
              fake.onTerm?.();
            }
          });
        }),
    },
  };
  return fake;
};

const addOwner = (fake: FakeInspector, pid = 100, startTime = OWNER_START) => {
  fake.processes.set(pid, {
    pid,
    pgid: pid,
    startTime,
    command: "/bin/neokod serve",
    zombie: false,
  });
};

const addServer = (fake: FakeInspector, overrides?: Partial<ObservedProcess>) => {
  fake.processes.set(500, {
    pid: 500,
    pgid: 500,
    startTime: SERVER_START,
    command: SERVER_COMMAND,
    zombie: false,
    ...overrides,
  });
};

const entryPath = (stateDir: string) => `${stateDir}/opencode-servers/500.json`;

const makeLedger = (options: {
  readonly fake: FakeInspector;
  readonly stateDir: string;
  readonly ownerPid?: number;
}) =>
  make({
    stateDir: options.stateDir,
    inspector: options.fake.inspector,
    ...(options.ownerPid !== undefined ? { ownerPid: options.ownerPid } : {}),
  });

it.layer(NodeServices.layer)("OpenCodeServerLedger", (it) => {
  it.effect("records a spawned group atomically", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const fake = makeFakeInspector();
      addOwner(fake);
      addServer(fake);
      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 100 });

      yield* Effect.asVoid(ledger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const entry = decodeEntry(yield* fs.readFileString(entryPath(stateDir)));
      assert.strictEqual(entry.version, 1);
      assert.strictEqual(entry.pgid, 500);
      assert.strictEqual(entry.pid, 500);
      assert.strictEqual(entry.startTime, SERVER_START);
      assert.strictEqual(entry.command, SERVER_COMMAND);
      assert.strictEqual(entry.port, 4100);
      assert.strictEqual(entry.stateDir, stateDir);
      assert.deepStrictEqual(entry.owner, { pid: 100, startTime: OWNER_START });
      assert.deepStrictEqual(yield* fs.readDirectory(`${stateDir}/opencode-servers`), ["500.json"]);
    }),
  );

  it.effect("forgets the entry after the group is confirmed gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const fake = makeFakeInspector();
      addOwner(fake);
      addServer(fake);
      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 100 });

      const forget = yield* ledger.track({ pid: 500, port: 4100, args: SERVER_ARGS });
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
      // The runtime has already run its termination sequence; simulate the
      // group actually exiting before the finalizer asks to forget it.
      fake.processes.delete(500);
      yield* forget;
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
    }),
  );

  it.effect("keeps the entry when forgetting while the group is still alive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const fake = makeFakeInspector();
      addOwner(fake);
      addServer(fake);
      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 100 });

      const forget = yield* ledger.track({ pid: 500, port: 4100, args: SERVER_ARGS });
      // The termination attempt failed or the group ignored it: liveness is
      // present, so the evidence must survive for the next boot to retry.
      yield* forget;

      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("keeps the entry when group liveness is unknown during forget", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const fake = makeFakeInspector();
      addOwner(fake);
      addServer(fake);
      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 100 });

      const forget = yield* ledger.track({ pid: 500, port: 4100, args: SERVER_ARGS });
      fake.failGroupExists = true;
      yield* forget;

      // An unavailable probe is not proof of exit. Removing here would destroy
      // the only durable record of a process that may still be running.
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("reaps a group whose owner is gone and whose identity matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      // The old owner is gone; only the orphaned server group remains. The
      // inspector answers `absent` for its pid, which is affirmative evidence.
      const second = makeFakeInspector();
      addServer(second);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      yield* secondLedger.reapOrphans;

      assert.deepStrictEqual(second.signals, [{ pgid: 500, signal: "SIGTERM" }]);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
    }),
  );

  it.effect("keeps the entry when the owner's identity cannot be observed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      // The probe cannot answer for the owner. That is unknown evidence, not
      // proof that the owner died, so its live child must not be reaped.
      const second = makeFakeInspector();
      addServer(second);
      second.unknownObservePids.add(100);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      yield* secondLedger.reapOrphans;

      assert.deepStrictEqual(second.signals, []);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("leaves a group alone when the owner is still running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const fake = makeFakeInspector();
      addOwner(fake);
      addServer(fake);
      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(ledger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      // A second Neokod server still owns the same base directory.
      const second = makeFakeInspector();
      addOwner(second);
      addServer(second);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 100 });
      yield* secondLedger.reapOrphans;

      assert.deepStrictEqual(second.signals, []);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("does not signal when the pid was reused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      addServer(second, { startTime: "Sun Oct  4 23:30:00 2026" });
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      yield* secondLedger.reapOrphans;

      assert.deepStrictEqual(second.signals, []);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
    }),
  );

  it.effect("does not signal when the command line differs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      addServer(second, { command: "/bin/vim file" });
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      yield* secondLedger.reapOrphans;

      assert.deepStrictEqual(second.signals, []);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
    }),
  );

  it.effect("escalates to SIGKILL when the group does not exit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      second.ignoreTerm = true;
      addServer(second);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      const reaping = yield* secondLedger.reapOrphans.pipe(Effect.forkChild);
      for (let tick = 0; tick < 120; tick++) {
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(reaping);

      assert.deepStrictEqual(second.signals, [
        { pgid: 500, signal: "SIGTERM" },
        { pgid: 500, signal: "SIGKILL" },
      ]);
      // SIGKILL was delivered but the group never left the process table, so
      // its exit is unconfirmed and the evidence must survive for a retry.
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("does not escalate when the group identity changes after SIGTERM", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      second.ignoreTerm = true;
      addServer(second);
      // The original group exits during the grace window and the kernel reuses
      // its id for an unrelated group. Liveness alone still reports a group.
      second.onTerm = () => {
        second.processes.delete(500);
        second.processes.set(700, {
          pid: 700,
          pgid: 500,
          startTime: "Sun Oct  4 23:30:00 2026",
          command: "/bin/other",
          zombie: false,
        });
      };
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      const reaping = yield* secondLedger.reapOrphans.pipe(Effect.forkChild);
      for (let tick = 0; tick < 120; tick++) {
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(reaping);

      // The replacement group must never receive SIGKILL, and the evidence
      // must survive because the original group's exit was not confirmed.
      assert.deepStrictEqual(second.signals, [{ pgid: 500, signal: "SIGTERM" }]);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("does not escalate when the group identity is unavailable after SIGTERM", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      second.ignoreTerm = true;
      addServer(second);
      second.onTerm = () => {
        second.failObserveGroup = true;
        second.failObserve = true;
      };
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      const reaping = yield* secondLedger.reapOrphans.pipe(Effect.forkChild);
      for (let tick = 0; tick < 120; tick++) {
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(reaping);

      assert.deepStrictEqual(second.signals, [{ pgid: 500, signal: "SIGTERM" }]);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("keeps the entry when the orphaned group survives SIGKILL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      second.ignoreTerm = true;
      addServer(second);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      const reaping = yield* secondLedger.reapOrphans.pipe(Effect.forkChild);
      for (let tick = 0; tick < 120; tick++) {
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(reaping);

      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("keeps the entry when the group cannot be signalled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      second.failSignal = new Error("EPERM");
      addServer(second);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      yield* secondLedger.reapOrphans;

      assert.deepStrictEqual(second.signals, []);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("keeps the entry when process inspection is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const first = makeFakeInspector();
      addOwner(first);
      addServer(first);
      const firstLedger = yield* makeLedger({ fake: first, stateDir, ownerPid: 100 });
      yield* Effect.asVoid(firstLedger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      const second = makeFakeInspector();
      second.failObserve = true;
      addServer(second);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      yield* secondLedger.reapOrphans;

      // Unavailable inspection is not proof of exit: keep the record instead
      // of converting an unknown outcome into a successful stop.
      assert.deepStrictEqual(second.signals, []);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
    }),
  );

  it.effect("ignores entries recorded for another state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const otherStateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-other-" });
      const fake = makeFakeInspector();
      addServer(fake);
      yield* fs.makeDirectory(`${stateDir}/opencode-servers`, { recursive: true });
      const foreignEntry: OpenCodeServerLedgerEntry = {
        version: 1,
        pgid: 500,
        pid: 500,
        startTime: SERVER_START,
        command: SERVER_COMMAND,
        port: 4100,
        stateDir: otherStateDir,
        owner: { pid: 100, startTime: OWNER_START },
      };
      yield* fs.writeFileString(entryPath(stateDir), `${encodeEntry(foreignEntry)}\n`);

      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 101 });
      yield* ledger.reapOrphans;

      assert.deepStrictEqual(fake.signals, []);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
    }),
  );

  it.effect("ignores unreadable and unrelated files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const directory = `${stateDir}/opencode-servers`;
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(`${directory}/garbage.json`, "keep me");
      yield* fs.writeFileString(`${directory}/501.json`, "not json");
      const fake = makeFakeInspector();
      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 101 });

      yield* ledger.reapOrphans;

      assert.strictEqual(yield* fs.exists(`${directory}/garbage.json`), true);
      assert.strictEqual(yield* fs.readFileString(`${directory}/garbage.json`), "keep me");
      assert.strictEqual(yield* fs.exists(`${directory}/501.json`), false);
    }),
  );

  it.effect("track never fails when the platform is unsupported", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const fake = makeFakeInspector();
      const inspector: ProcessInspector = {
        observe: () => Effect.succeed({ state: "unknown" as const }),
        observeGroup: () => Effect.succeed([]),
        groupExists: () => Effect.succeed(false),
        signalGroup: () => Effect.void,
      };
      const ledger = yield* make({ stateDir, inspector, ownerPid: 100 });

      yield* Effect.asVoid(ledger.track({ pid: 500, port: 4100, args: SERVER_ARGS }));

      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
      assert.deepStrictEqual(fake.signals, []);
    }),
  );
});
