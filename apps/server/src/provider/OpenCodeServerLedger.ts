import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
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
 * left alone and its entry retained so a later boot can retry.
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
 * Result of inspecting one pid.
 *
 * `absent` is affirmative evidence that no process currently holds the pid.
 * `unknown` means the inspection could not answer, for example because the
 * platform is unsupported or a probe failed. Reaping decisions must not
 * conflate the two: an unobservable owner may still be alive.
 */
export type ProcessObservation =
  | { readonly state: "present"; readonly process: ObservedProcess }
  | { readonly state: "absent" }
  | { readonly state: "unknown"; readonly detail?: string };

/**
 * Process inspection boundary. Tests drive the ledger through a synthetic map
 * so no real process is ever observed or signalled.
 */
export interface ProcessInspector {
  readonly observe: (pid: number) => Effect.Effect<ProcessObservation>;
  readonly observeGroup: (pgid: number) => Effect.Effect<ReadonlyArray<ObservedProcess>>;
  readonly groupExists: (pgid: number) => Effect.Effect<boolean>;
  readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => Effect.Effect<void>;
}

export interface OpenCodeServerLedgerShape {
  /**
   * Records a spawned server group and returns the effect that removes the
   * entry only once the group is confirmed gone. Tracking never fails a spawn.
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

const isNotFoundCause = (cause: Cause.Cause<unknown>): boolean => {
  const squashed = Cause.squash(cause);
  if (isErrnoCode(squashed, "ENOENT")) {
    return true;
  }
  if (squashed instanceof PlatformError.PlatformError) {
    return (
      squashed.reason._tag === "NotFound" ||
      ("cause" in squashed.reason && isErrnoCode(squashed.reason.cause, "ENOENT"))
    );
  }
  return false;
};

type TextRead =
  | { readonly state: "present"; readonly text: string }
  | { readonly state: "absent" }
  | { readonly state: "unknown"; readonly detail: string };

const readTextFile = (fs: FileSystem.FileSystem, filePath: string): Effect.Effect<TextRead> =>
  fs.readFileString(filePath).pipe(
    Effect.map((text) => ({ state: "present", text }) as const),
    Effect.catchCause((cause) =>
      Effect.succeed(
        isNotFoundCause(cause)
          ? ({ state: "absent" } as const)
          : ({ state: "unknown", detail: "read_failed" } as const),
      ),
    ),
  );

const readLinuxObservedProcess = (
  fs: FileSystem.FileSystem,
  pid: number,
): Effect.Effect<ProcessObservation> =>
  Effect.gen(function* () {
    const statFile = yield* readTextFile(fs, `/proc/${pid}/stat`);
    if (statFile.state !== "present") {
      return statFile;
    }
    const parsed = parseLinuxStat(statFile.text);
    if (parsed === undefined) {
      return { state: "unknown", detail: "unparsable_stat" } as const;
    }
    const cmdlineFile = yield* readTextFile(fs, `/proc/${pid}/cmdline`);
    if (cmdlineFile.state !== "present") {
      return cmdlineFile;
    }
    return {
      state: "present",
      process: {
        pid,
        pgid: parsed.pgid,
        startTime: parsed.startTime,
        command: cmdlineFile.text.split("\u0000").join(" ").trim(),
        zombie: parsed.state === "Z",
      },
    } as const;
  });

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

  type PsOutput =
    | { readonly state: "present"; readonly stdout: string }
    | { readonly state: "absent" }
    | { readonly state: "unknown"; readonly detail: string };

  /**
   * Darwin's `/bin/ps` exits 1 when the selection matched nothing, with no
   * rows and no diagnostic (`if (nkept == 0) exit(1)` in adv_cmds `ps/ps.c`).
   * Every other failure is a failed probe and must stay unknown.
   */
  const PS_NO_MATCH_EXIT_CODE = 1;

  const runPs = (args: ReadonlyArray<string>): Effect.Effect<PsOutput> =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/bin/ps", args, {
          env: { LC_ALL: "C", TZ: "UTC" },
          extendEnv: true,
          stdin: "ignore",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        {
          concurrency: "unbounded",
        },
      );
      const exitCode = Number(code);
      const noRows = stdout.trim().length === 0;
      const noDiagnostic = stderr.trim().length === 0;
      if (exitCode === PS_NO_MATCH_EXIT_CODE && noRows && noDiagnostic) {
        return { state: "absent" } as const;
      }
      if (exitCode !== 0) {
        // Any other failure says nothing about the pid, even when it printed no
        // rows. Reporting it as absent would let a reaper kill a live child.
        return { state: "unknown", detail: `ps_exit_${exitCode}` } as const;
      }
      if (noRows) {
        return { state: "unknown", detail: "ps_output_unparsed" } as const;
      }
      return { state: "present", stdout } as const;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption("5 seconds"),
      Effect.map((result) =>
        Option.isNone(result)
          ? ({ state: "unknown", detail: "ps_timeout" } as const)
          : result.value,
      ),
      Effect.catchCause(() =>
        Effect.succeed({ state: "unknown", detail: "ps_unavailable" } as const),
      ),
    );

  const observe = (pid: number): Effect.Effect<ProcessObservation> => {
    if (platform === "win32") {
      return Effect.succeed({ state: "unknown", detail: "unsupported_platform" } as const);
    }
    if (platform === "linux") {
      return readLinuxObservedProcess(fs, pid);
    }
    if (platform !== "darwin") {
      return Effect.succeed({ state: "unknown", detail: "unsupported_platform" } as const);
    }
    return runPs(["-ww", "-o", "pid=,pgid=,stat=,lstart=,args=", "-p", String(pid)]).pipe(
      Effect.map((output) => {
        if (output.state !== "present") {
          return output;
        }
        const observed = parsePsOutput(output.stdout)[0];
        return observed === undefined
          ? ({ state: "unknown", detail: "ps_output_unparsed" } as const)
          : ({ state: "present", process: observed } as const);
      }),
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
          if (observed.state === "present" && observed.process.pgid === pgid) {
            members.push(observed.process);
          }
        }
        return members;
      });
    }
    if (platform !== "darwin") {
      return Effect.succeed([]);
    }
    return runPs(["-A", "-ww", "-o", "pid=,pgid=,stat=,lstart=,args="]).pipe(
      Effect.map((output) =>
        output.state === "present" ? parsePsOutput(output.stdout, pgid) : [],
      ),
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

type OrphanStopOutcome =
  /** The recorded group is confirmed gone. */
  | "exited"
  /** The recorded pid no longer identifies our process; it was never signalled. */
  | "stale"
  /** Exit could not be confirmed, so the entry must survive for a retry. */
  | "unresolved";

type GroupPresence = "present" | "gone" | "unknown";

const observeGroupPresence = (
  entry: OpenCodeServerLedgerEntry,
  inspector: ProcessInspector,
): Effect.Effect<GroupPresence> =>
  inspector.groupExists(entry.pgid).pipe(
    Effect.map((exists) => (exists ? "present" : "gone") as GroupPresence),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "Could not confirm whether an orphaned OpenCode server group exited",
          { pgid: entry.pgid, pid: entry.pid, cause },
        );
        return "unknown" as const;
      }),
    ),
  );

const waitForGroupExit = (
  entry: OpenCodeServerLedgerEntry,
  inspector: ProcessInspector,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let poll = 0; poll < ORPHAN_TERM_POLLS; poll++) {
      if ((yield* observeGroupPresence(entry, inspector)) === "gone") {
        return true;
      }
      yield* Effect.sleep(ORPHAN_TERM_POLL_INTERVAL);
    }
    return false;
  });

type GroupOwnership = "owned" | "gone" | "changed" | "unknown";

const sameProcessIdentity = (left: ObservedProcess, right: ObservedProcess): boolean =>
  left.pid === right.pid &&
  left.pgid === right.pgid &&
  left.startTime === right.startTime &&
  left.command === right.command;

/**
 * Snapshot the identity of every non-zombie member in the group, but only when
 * the listing still contains the leader that was just validated. If the
 * listing does not contain that leader, the group may already have exited and
 * had its id reused, so the snapshot must not contribute any other proof.
 */
const captureGroupIdentityProof = (
  entry: OpenCodeServerLedgerEntry,
  leader: ObservedProcess,
  inspector: ProcessInspector,
): Effect.Effect<ReadonlyArray<ObservedProcess>> =>
  inspector.observeGroup(entry.pgid).pipe(
    Effect.map((members) => {
      const stillContainsLeader = members.some((member) => sameProcessIdentity(leader, member));
      if (!stillContainsLeader) {
        return [leader] as ReadonlyArray<ObservedProcess>;
      }
      return [
        leader,
        ...members.filter(
          (member) => member.pgid === entry.pgid && !member.zombie && member.pid !== leader.pid,
        ),
      ];
    }),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "Could not snapshot the OpenCode server process group members before signalling",
          { pgid: entry.pgid, pid: entry.pid, cause },
        );
        return [leader] as ReadonlyArray<ObservedProcess>;
      }),
    ),
  );

/**
 * Revalidate the live group against the identity proof captured before the
 * first signal. Repeated liveness is not identity: a group can exit and the
 * kernel can reuse its id, so at least one current member must still match the
 * recorded pid, start time and command before another signal is sent.
 */
const revalidateGroupIdentity = (
  entry: OpenCodeServerLedgerEntry,
  proof: ReadonlyArray<ObservedProcess>,
  inspector: ProcessInspector,
): Effect.Effect<GroupOwnership> =>
  Effect.gen(function* () {
    const presence = yield* observeGroupPresence(entry, inspector);
    if (presence === "gone") {
      return "gone" as const;
    }
    if (presence === "unknown") {
      return "unknown" as const;
    }

    const members = yield* inspector.observeGroup(entry.pgid).pipe(
      Effect.map((observed) =>
        observed.filter((member) => member.pgid === entry.pgid && !member.zombie),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            "Could not re-read the OpenCode server process group members before signalling",
            { pgid: entry.pgid, pid: entry.pid, cause },
          );
          return undefined;
        }),
      ),
    );
    const leaderObservation = yield* inspector
      .observe(entry.pid)
      .pipe(Effect.catchCause(() => Effect.succeed({ state: "unknown" } as const)));
    const leader = leaderObservation.state === "present" ? leaderObservation.process : undefined;

    const candidates = [...(members ?? []), ...(leader === undefined ? [] : [leader])];
    if (candidates.length === 0) {
      return "unknown" as const;
    }
    return candidates.some((candidate) =>
      proof.some((original) => sameProcessIdentity(original, candidate)),
    )
      ? ("owned" as const)
      : ("changed" as const);
  });

const stopOrphan = (
  entry: OpenCodeServerLedgerEntry,
  inspector: ProcessInspector,
): Effect.Effect<OrphanStopOutcome> =>
  Effect.gen(function* () {
    const observation = yield* inspector.observe(entry.pid);
    if (observation.state !== "present") {
      // A missing or unobservable identity is not proof of exit, and only a
      // missing process group proves this orphan is gone.
      if ((yield* observeGroupPresence(entry, inspector)) === "gone") {
        return "exited";
      }
      yield* Effect.logWarning(
        "Keeping an OpenCode server ledger entry because its process identity could not be observed",
        { pgid: entry.pgid, pid: entry.pid, port: entry.port, observation: observation.state },
      );
      return "unresolved";
    }
    const observed = observation.process;
    if (observed.zombie) {
      // The leader has exited but the group it anchored may not have.
      if ((yield* observeGroupPresence(entry, inspector)) === "gone") {
        return "exited";
      }
      yield* Effect.logWarning(
        "Keeping an OpenCode server ledger entry because its group still exists after the leader exited",
        { pgid: entry.pgid, pid: entry.pid, port: entry.port },
      );
      return "unresolved";
    }
    if (
      observed.startTime !== entry.startTime ||
      observed.pgid !== entry.pgid ||
      observed.command !== entry.command
    ) {
      // The pid now belongs to another process. Never signal it; the record no
      // longer identifies anything this server owns.
      yield* Effect.logInfo("Forgetting an OpenCode server entry whose pid was reused", {
        pgid: entry.pgid,
        pid: entry.pid,
        port: entry.port,
      });
      return "stale";
    }
    const proof = yield* captureGroupIdentityProof(entry, observed, inspector);
    const beforeTerm = yield* revalidateGroupIdentity(entry, proof, inspector);
    if (beforeTerm === "gone") {
      return "exited";
    }
    if (beforeTerm !== "owned") {
      yield* Effect.logWarning(
        "Skipping SIGTERM for an OpenCode server orphan whose group identity changed or could not be reverified",
        { pgid: entry.pgid, pid: entry.pid, port: entry.port, identity: beforeTerm },
      );
      return "unresolved";
    }
    yield* Effect.logWarning("Stopping an OpenCode server orphaned by a previous Neokod server", {
      pgid: entry.pgid,
      pid: entry.pid,
      port: entry.port,
    });
    yield* inspector.signalGroup(entry.pgid, "SIGTERM");
    if (yield* waitForGroupExit(entry, inspector)) {
      return "exited";
    }
    // The group survived the grace window. It may still be ours, but it may
    // also have exited and had its id reused while we polled, so revalidate the
    // original identity before escalating instead of trusting liveness alone.
    const beforeKill = yield* revalidateGroupIdentity(entry, proof, inspector);
    if (beforeKill === "gone") {
      return "exited";
    }
    if (beforeKill !== "owned") {
      yield* Effect.logWarning(
        "Refusing to send SIGKILL to an OpenCode server orphan whose group identity changed or could not be reverified; keeping its ledger entry",
        { pgid: entry.pgid, pid: entry.pid, port: entry.port, identity: beforeKill },
      );
      return "unresolved";
    }
    yield* inspector.signalGroup(entry.pgid, "SIGKILL");
    if (yield* waitForGroupExit(entry, inspector)) {
      return "exited";
    }
    yield* Effect.logWarning(
      "An orphaned OpenCode server group survived SIGKILL; keeping its ledger entry for a later retry",
      { pgid: entry.pgid, pid: entry.pid, port: entry.port },
    );
    return "unresolved";
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "Could not stop an orphaned OpenCode server group; keeping its ledger entry",
          { pgid: entry.pgid, pid: entry.pid, cause },
        );
        return "unresolved" as const;
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
    const ownerObservation = yield* inspector.observe(ownerPid);
    const owner = ownerObservation.state === "present" ? ownerObservation.process : undefined;

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
        const leaderObservation = yield* inspector.observe(pgid);
        const leader =
          leaderObservation.state === "present" ? leaderObservation.process : undefined;
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
        return Effect.gen(function* () {
          const presence = yield* observeGroupPresence(entry, inspector);
          if (presence === "gone") {
            yield* removeEntryFile(fs, filePath);
            return;
          }
          yield* Effect.logWarning(
            "Keeping an OpenCode server ledger entry because its group exit is not confirmed",
            { filePath, pgid, pid: entry.pid, port: entry.port, presence },
          );
        });
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
        const ownerObservation = yield* inspector.observe(entry.owner.pid);
        if (ownerObservation.state === "unknown") {
          // An unreadable owner probe is not proof that the owner died. Its
          // child may still be live, so keep the durable evidence.
          yield* Effect.logWarning(
            "Keeping an OpenCode server ledger entry because its owner's identity could not be observed",
            {
              filePath,
              pgid: entry.pgid,
              pid: entry.pid,
              port: entry.port,
              reason: ownerObservation.detail,
            },
          );
          return;
        }
        if (ownerObservation.state === "present") {
          const currentOwner = ownerObservation.process;
          if (!currentOwner.zombie && currentOwner.startTime === entry.owner.startTime) {
            // A second Neokod server on the same base directory is still alive;
            // its children are not orphans.
            return;
          }
        }
        // The owner is confirmed absent, a zombie, or a different process that
        // reused its pid. Only then may its child be treated as an orphan.
        const outcome = yield* stopOrphan(entry, inspector);
        if (outcome === "exited" || outcome === "stale") {
          yield* removeEntryFile(fs, filePath);
          return;
        }
        yield* Effect.logWarning(
          "Keeping an OpenCode server ledger entry because its group exit is unconfirmed",
          { filePath, pgid: entry.pgid, pid: entry.pid, port: entry.port },
        );
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
