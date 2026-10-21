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
}

const makeFakeInspector = (): FakeInspector => {
  const processes = new Map<number, ObservedProcess>();
  const signals: Array<{ readonly pgid: number; readonly signal: NodeJS.Signals }> = [];
  const fake: FakeInspector = {
    processes,
    signals,
    ignoreTerm: false,
    inspector: {
      observe: (pid) => Effect.sync(() => processes.get(pid)),
      observeGroup: (pgid) =>
        Effect.sync(() => [...processes.values()].filter((entry) => entry.pgid === pgid)),
      groupExists: (pgid) =>
        Effect.sync(() => [...processes.values()].some((entry) => entry.pgid === pgid)),
      signalGroup: (pgid, signal) =>
        Effect.sync(() => {
          signals.push({ pgid, signal });
          if (signal === "SIGTERM" && !fake.ignoreTerm) {
            for (const [pid, entry] of processes) {
              if (entry.pgid === pgid) {
                processes.delete(pid);
              }
            }
          }
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

  it.effect("forgets the entry after a graceful stop", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-ledger-" });
      const fake = makeFakeInspector();
      addOwner(fake);
      addServer(fake);
      const ledger = yield* makeLedger({ fake, stateDir, ownerPid: 100 });

      const forget = yield* ledger.track({ pid: 500, port: 4100, args: SERVER_ARGS });
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), true);
      yield* forget;
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
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

      // The old owner is gone; only the orphaned server group remains.
      const second = makeFakeInspector();
      addServer(second);
      const secondLedger = yield* makeLedger({ fake: second, stateDir, ownerPid: 101 });
      yield* secondLedger.reapOrphans;

      assert.deepStrictEqual(second.signals, [{ pgid: 500, signal: "SIGTERM" }]);
      assert.strictEqual(yield* fs.exists(entryPath(stateDir)), false);
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
      for (let tick = 0; tick < 60; tick++) {
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(reaping);

      assert.deepStrictEqual(second.signals, [
        { pgid: 500, signal: "SIGTERM" },
        { pgid: 500, signal: "SIGKILL" },
      ]);
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
        observe: () => Effect.succeed(undefined),
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
