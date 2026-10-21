import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@neokod/shared/hostProcess";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";

/**
 * Durable record of every `opencode serve` process group Neokod spawned.
 *
 * A hard crash of the Neokod server skips its scope finalizers, so nothing else
 * would stop the child. The entry stores the process identity that was observed
 * when the child started: a pid alone is not proof, because the OS can reuse it.
 * Reconciliation only signals a group when the current pid still has the
 * recorded start time, process group and command line. Anything unproven is
 * left alone and its file removed.
 */
export const OpenCodeServerLedgerEntry = Schema.Struct({
  version: Schema.Literal(1),
  pgid: Schema.Int,
  pid: Schema.Int,
  startTime: Schema.String,
  command: Schema.String,
  port: Schema.Int,
  stateDir: Schema.String,
  owner: Schema.Struct({
    pid: Schema.Int,
    startTime: Schema.String,
  }),
});
export type OpenCodeServerLedgerEntry = typeof OpenCodeServerLedgerEntry.Type;

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(OpenCodeServerLedgerEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(OpenCodeServerLedgerEntry));
const ENTRY_FILE_PATTERN = /^\d+\.json$/;
const LEDGER_DIRECTORY = "opencode-servers";
const ORPHAN_TERM_POLLS = 40;
const ORPHAN_TERM_POLL_INTERVAL = "50 millis";

export interface ObservedProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

/**
 * Process inspection boundary. Tests drive the ledger through a synthetic map
 * so no real process is ever observed or signalled.
 */
export interface ProcessInspector {
  readonly observe: (pid: number) => Effect.Effect<ObservedProcess | undefined>;
  readonly observeGroup: (pgid: number) => Effect.Effect<ReadonlyArray<ObservedProcess>>;
  readonly groupExists: (pgid: number) => Effect.Effect<boolean>;
  readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => Effect.Effect<void>;
}

export interface OpenCodeServerLedgerShape {
  /**
   * Records a spawned server group and returns the effect that forgets the
   * entry after a graceful stop. Tracking never fails a spawn.
   */
  readonly track: (server: {
    readonly pid: number;
    readonly port: number;
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<Effect.Effect<void>>;
}

/**
 * No-op default so runtime layers that have no ledger (and the adapter test
 * doubles) keep working. `layer` replaces it with the durable implementation.
 */
export const OpenCodeServerLedger = Context.Reference<OpenCodeServerLedgerShape>(
  "neokod/provider/OpenCodeServerLedger",
  {
    defaultValue: () => ({
      track: () => Effect.succeed(Effect.void),
    }),
  },
);

const isErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === code;

const parseLinuxStat = (
  raw: string,
):
  | {
      readonly state: string;
      readonly ppid: number;
      readonly pgid: number;
      readonly startTime: string;
    }
  | undefined => {
  const closingParen = raw.lastIndexOf(")");
  if (closingParen < 0) {
    return undefined;
  }
  const fields = raw
    .slice(closingParen + 1)
    .trim()
    .split(/\s+/);
  // After comm: state, ppid, pgrp, ... starttime is field 22 overall, index 19
  // of the post-comm fields.
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (
    state === undefined ||
    startTime === undefined ||
    !Number.isSafeInteger(ppid) ||
    !Number.isSafeInteger(pgid)
  ) {
    return undefined;
  }
  return { state, ppid, pgid, startTime };
};

const readLinuxObservedProcess = (
  fs: FileSystem.FileSystem,
  pid: number,
): Effect.Effect<ObservedProcess | undefined> =>
  Effect.gen(function* () {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
    const parsed = parseLinuxStat(stat);
    if (parsed === undefined) {
      return undefined;
    }
    const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
    return {
      pid,
      pgid: parsed.pgid,
      startTime: parsed.startTime,
      command: cmdline.split("\u0000").join(" ").trim(),
      zombie: parsed.state === "Z",
    };
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

const PS_LINE_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

const parsePsOutput = (output: string, pgidFilter?: number): Array<ObservedProcess> => {
  const observed: Array<ObservedProcess> = [];
  for (const line of output.split("\n")) {
    const match = line.match(PS_LINE_PATTERN);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const stat = match[3] ?? "";
    const startTime = match[4] ?? "";
    const command = (match[5] ?? "").trim();
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid)) {
      continue;
    }
    if (pgidFilter !== undefined && pgid !== pgidFilter) {
      continue;
    }
    observed.push({ pid, pgid, startTime, command, zombie: stat.startsWith("Z") });
  }
  return observed;
};

export const makeSystemProcessInspector: Effect.Effect<
  ProcessInspector,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;

  const runPs = (args: ReadonlyArray<string>): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/bin/ps", args, {
          env: { LC_ALL: "C", TZ: "UTC" },
          extendEnv: true,
          stdin: "ignore",
        }),
      );
      const [stdout] = yield* Effect.all([collectStreamAsString(child.stdout), child.exitCode], {
        concurrency: "unbounded",
      });
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption("5 seconds"),
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "win32") {
      return Effect.succeed(undefined);
    }
    if (platform === "linux") {
      return readLinuxObservedProcess(fs, pid);
    }
    if (platform !== "darwin") {
      return Effect.succeed(undefined);
    }
    return runPs(["-ww", "-o", "pid=,pgid=,stat=,lstart=,args=", "-p", String(pid)]).pipe(
      Effect.map((output) => (output === undefined ? undefined : parsePsOutput(output)[0])),
    );
  };

  const observeGroup = (pgid: number): Effect.Effect<ReadonlyArray<ObservedProcess>> => {
    if (platform === "win32") {
      return Effect.succeed([]);
    }
    if (platform === "linux") {
      return Effect.gen(function* () {
        const entries = yield* fs
          .readDirectory("/proc")
          .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)));
        const members: Array<ObservedProcess> = [];
        for (const entry of entries) {
          const pid = Number(entry);
          if (!Number.isSafeInteger(pid)) {
            continue;
          }
          const observed = yield* readLinuxObservedProcess(fs, pid);
          if (observed !== undefined && observed.pgid === pgid) {
            members.push(observed);
          }
        }
        return members;
      });
    }
    if (platform !== "darwin") {
      return Effect.succeed([]);
    }
    return runPs(["-A", "-ww", "-o", "pid=,pgid=,stat=,lstart=,args="]).pipe(
      Effect.map((output) => (output === undefined ? [] : parsePsOutput(output, pgid))),
    );
  };

  const groupExists = (pgid: number): Effect.Effect<boolean> => {
    if (platform === "win32") {
      return Effect.succeed(false);
    }
    return Effect.sync(() => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (cause) {
        // ESRCH is the only proof the group is gone; EPERM means it exists but
        // is not ours to signal, which is not an exit.
        return !isErrnoCode(cause, "ESRCH");
      }
    });
  };

  const signalGroup = (pgid: number, signal: NodeJS.Signals): Effect.Effect<void> => {
    if (platform === "win32") {
      return Effect.void;
    }
    return Effect.sync(() => {
      try {
        process.kill(-pgid, signal);
      } catch (cause) {
        if (!isErrnoCode(cause, "ESRCH")) {
          throw cause;
        }
      }
    }).pipe(Effect.ignore({ log: true }));
  };

  return { observe, observeGroup, groupExists, signalGroup };
});

export interface MakeOpenCodeServerLedgerOptions {
  readonly stateDir: string;
  readonly ownerPid?: number;
  readonly inspector: ProcessInspector;
}

interface OpenCodeServerLedgerService extends OpenCodeServerLedgerShape {
  readonly reapOrphans: Effect.Effect<void>;
}

/** Best-effort removal: a missing file is already the desired state. */
const removeEntryFile = (fs: FileSystem.FileSystem, filePath: string): Effect.Effect<void> =>
  fs.remove(filePath, { force: true }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not remove an OpenCode server ledger entry", {
        filePath,
        cause,
      }),
    ),
  );

const stopOrphan = (
  entry: OpenCodeServerLedgerEntry,
  inspector: ProcessInspector,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const observed = yield* inspector.observe(entry.pid);
    // Without a full identity match the pid may belong to another process now.
    if (observed === undefined || observed.zombie) {
      return;
    }
    if (
      observed.startTime !== entry.startTime ||
      observed.pgid !== entry.pgid ||
      observed.command !== entry.command
    ) {
      return;
    }
    yield* Effect.logWarning("Stopping an OpenCode server orphaned by a previous Neokod server", {
      pgid: entry.pgid,
      pid: entry.pid,
      port: entry.port,
    });
    yield* inspector.signalGroup(entry.pgid, "SIGTERM");
    for (let poll = 0; poll < ORPHAN_TERM_POLLS; poll++) {
      if (!(yield* inspector.groupExists(entry.pgid))) {
        return;
      }
      yield* Effect.sleep(ORPHAN_TERM_POLL_INTERVAL);
    }
    // A group that never emptied cannot have had its id reused while we polled.
    yield* inspector.signalGroup(entry.pgid, "SIGKILL");
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not stop an orphaned OpenCode server group", {
        pgid: entry.pgid,
        pid: entry.pid,
        cause,
      }),
    ),
  );

export const make = (
  options: MakeOpenCodeServerLedgerOptions,
): Effect.Effect<OpenCodeServerLedgerService, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir, inspector, ownerPid = process.pid } = options;
    const directory = path.join(stateDir, LEDGER_DIRECTORY);
    const entryPath = (pgid: number) => path.join(directory, `${pgid}.json`);
    const owner = yield* inspector.observe(ownerPid);

    const track: OpenCodeServerLedgerShape["track"] = (server) =>
      Effect.gen(function* () {
        if (owner === undefined) {
          // The platform cannot prove our own identity, so it cannot write an
          // entry any reaper could verify safely. Report a live group instead
          // of silently leaving it unrecorded.
          if (yield* inspector.groupExists(server.pid)) {
            yield* Effect.logWarning(
              "Cannot record an OpenCode server process because this platform does not expose the owner's identity",
              { pid: server.pid, port: server.port },
            );
          }
          return Effect.void;
        }

        const pgid = server.pid;
        const leader = yield* inspector.observe(pgid);
        const members =
          leader !== undefined && !leader.zombie && leader.pgid === pgid
            ? [leader]
            : (yield* inspector.observeGroup(pgid)).filter((member) => !member.zombie);
        const commandSuffix = ` ${server.args.join(" ")}`;
        const matched =
          members.find((member) => member.command.endsWith(commandSuffix)) ?? members[0];
        if (matched === undefined) {
          return Effect.void;
        }

        const entry: OpenCodeServerLedgerEntry = {
          version: 1,
          pgid,
          pid: matched.pid,
          startTime: matched.startTime,
          command: matched.command,
          port: server.port,
          stateDir,
          owner: { pid: ownerPid, startTime: owner.startTime },
        };
        const filePath = entryPath(pgid);
        yield* writeFileStringAtomically({
          filePath,
          contents: `${encodeEntry(entry)}\n`,
        });
        return removeEntryFile(fs, filePath);
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Could not record an OpenCode server process", { cause });
            return Effect.void;
          }),
        ),
      );

    const reapEntry = (filePath: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const raw = yield* fs
          .readFileString(filePath)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
        if (raw === undefined) {
          return;
        }
        const decoded = decodeEntry(raw);
        if (Option.isNone(decoded)) {
          // A file that matches our naming scheme but cannot be decoded is
          // ours to discard; unrelated files never reach this function.
          yield* removeEntryFile(fs, filePath);
          return;
        }
        const entry = decoded.value;
        if (entry.stateDir !== stateDir) {
          yield* removeEntryFile(fs, filePath);
          return;
        }
        const currentOwner = yield* inspector.observe(entry.owner.pid);
        if (
          currentOwner !== undefined &&
          !currentOwner.zombie &&
          currentOwner.startTime === entry.owner.startTime
        ) {
          // A second Neokod server on the same base directory is still alive;
          // its children are not orphans.
          return;
        }
        yield* stopOrphan(entry, inspector);
        yield* removeEntryFile(fs, filePath);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not reconcile an OpenCode server ledger entry", {
            filePath,
            cause,
          }),
        ),
      );

    const reapOrphans: Effect.Effect<void> = Effect.gen(function* () {
      const exists = yield* fs
        .exists(directory)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return;
      }
      const entries = yield* fs.readDirectory(directory).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Could not list OpenCode server ledger entries", {
              directory,
              cause,
            });
            return [] as ReadonlyArray<string>;
          }),
        ),
      );
      for (const name of entries) {
        if (!ENTRY_FILE_PATTERN.test(name)) {
          continue;
        }
        yield* reapEntry(path.join(directory, name));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not reconcile OpenCode server orphans", { cause }),
      ),
    );

    return { track, reapOrphans };
  });

/**
 * Durable ledger with a forked startup reconciliation. The reap is forked so a
 * slow orphan shutdown never delays server startup.
 */
export const layer = Layer.effect(
  OpenCodeServerLedger,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const inspector = yield* makeSystemProcessInspector;
    const ledger = yield* make({ stateDir: config.stateDir, inspector });
    yield* ledger.reapOrphans.pipe(Effect.forkScoped);
    return { track: ledger.track };
  }),
);
