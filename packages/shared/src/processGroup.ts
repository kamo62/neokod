// @effect-diagnostics nodeBuiltinImport:off - the POSIX birth-identity reader
// shells out to `ps` to read a spawned process's OS start time.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { HostProcessPlatform } from "./hostProcess.ts";

/**
 * Shared validated process-group abstraction
 * (Issue #101 spec sections 4.1 / 6.3 / 6.6, implementation-sequence step 3).
 *
 * Neokod-owned provider and agent children are meant to be spawned as explicit
 * process-group LEADERS (`detached: true` on POSIX). Terminating such a child
 * then means signalling the whole group (`process.kill(-pgid, ...)`) with a
 * bounded TERM-to-KILL escalation, so descendants left in the group die with
 * the leader instead of surviving as orphans.
 *
 * Two safety invariants are enforced here and must not be relaxed by callers:
 *
 *  1. A process group is only ever signalled through a *proven*
 *     {@link ProcessGroupIdentity}. Identity is proven only when the recorded
 *     group id equals the leader pid (the group-leader invariant of a
 *     `detached` spawn). A bare, possibly recycled pid can never be promoted
 *     to a group identity: {@link makeProvenGroupIdentity} rejects it, so no
 *     code path can reconstruct `-pgid` from an untrusted pid.
 *
 *  2. Group signalling is POSIX-only in this release. On platforms without
 *     safe group signalling (Windows, which needs job-object support that is
 *     not wired here) every entry point fails closed and NEVER signals. It
 *     does not fall back to a single-pid kill.
 *
 * The escalation core takes an injectable {@link ProcessGroupSignaller} so the
 * bounded TERM-to-KILL sequence can be unit-tested deterministically, while a
 * focused POSIX integration test exercises the real `process.kill` signaller.
 */

// ---------------------------------------------------------------------------
// Platform support
// ---------------------------------------------------------------------------

/**
 * Platforms on which `process.kill(-pgid, signal)` addresses a POSIX process
 * group. Windows is deliberately absent: it has no equivalent here, so managed
 * group termination is unsupported until job-object support lands (spec 6.3,
 * Gate B). Do not add `win32` without that equivalent.
 */
const POSIX_GROUP_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
]);

export const isGroupSignalingSupported = (platform: NodeJS.Platform): boolean =>
  POSIX_GROUP_PLATFORMS.has(platform);

// ---------------------------------------------------------------------------
// Proven group identity
// ---------------------------------------------------------------------------

/**
 * A validated, neokod-owned process-group identity. The only way to obtain one
 * is {@link makeProvenGroupIdentity}, which enforces the group-leader
 * invariant. Persisting and later reloading this exact record is what lets
 * recovery prove a group is the one neokod spawned before signalling it.
 */
export interface ProcessGroupIdentity {
  /** The spawned leader process id. */
  readonly pid: number;
  /** The process-group id. Equal to `pid` because the child led the group. */
  readonly pgid: number;
  /** Wall-clock spawn time in ms; provenance only, not used for signalling. */
  readonly spawnedAtMs: number;
  /** Platform the group was created on. Must be a POSIX group platform. */
  readonly platform: NodeJS.Platform;
  /**
   * Recycle-resistant OS process-birth token captured at spawn (the leader's
   * kernel-reported start time). `null` when it could not be captured. This is
   * what lets recovery tell a still-live leader apart from an unrelated process
   * that reused the pid: `pid === pgid` alone is NOT proof of identity, so the
   * signalling path in {@link planValidatedOrphanTermination} additionally
   * requires this token to match the live process before any signal is sent.
   */
  readonly birthToken: string | null;
}

export type ProvenIdentityFailure =
  | "not_group_leader"
  | "non_positive_ids"
  | "unsupported_platform";

export type ProvenIdentityResult =
  | { readonly ok: true; readonly identity: ProcessGroupIdentity }
  | { readonly ok: false; readonly reason: ProvenIdentityFailure };

/**
 * Build a proven group identity, or fail closed.
 *
 * Requires `pgid === pid` (the leader invariant of a `detached` spawn): a group
 * whose id does not match the leader pid was not created by a neokod
 * group-leader spawn and must not be trusted. Non-positive ids and non-POSIX
 * platforms are also rejected. Callers that only hold a bare pid MUST NOT
 * fabricate a `pgid`; passing `pgid !== pid` is rejected by design.
 */
export const makeProvenGroupIdentity = (input: {
  readonly pid: number;
  readonly pgid: number;
  readonly spawnedAtMs: number;
  readonly platform: NodeJS.Platform;
  /** Recycle-resistant OS birth token captured at spawn, if available. */
  readonly birthToken?: string | null;
}): ProvenIdentityResult => {
  if (!isGroupSignalingSupported(input.platform)) {
    return { ok: false, reason: "unsupported_platform" };
  }
  if (
    !Number.isInteger(input.pid) ||
    !Number.isInteger(input.pgid) ||
    input.pid <= 0 ||
    input.pgid <= 0
  ) {
    return { ok: false, reason: "non_positive_ids" };
  }
  if (input.pid !== input.pgid) {
    return { ok: false, reason: "not_group_leader" };
  }
  return {
    ok: true,
    identity: {
      pid: input.pid,
      pgid: input.pgid,
      spawnedAtMs: input.spawnedAtMs,
      platform: input.platform,
      birthToken: input.birthToken ?? null,
    },
  };
};

// ---------------------------------------------------------------------------
// Signaller (injectable for deterministic tests)
// ---------------------------------------------------------------------------

export type GroupSignalResult = "sent" | "no_such_group" | "not_permitted" | "error";

export interface ProcessGroupSignaller {
  /** Send `signal` to the whole group. Never throws. */
  readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => Effect.Effect<GroupSignalResult>;
  /** True when at least one process remains in the group. */
  readonly isGroupAlive: (pgid: number) => Effect.Effect<boolean>;
}

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;

/**
 * Real POSIX signaller. `process.kill(-pgid, signal)` targets the group; a
 * `0` signal probes liveness without delivering anything.
 */
export const posixProcessGroupSignaller: ProcessGroupSignaller = {
  signalGroup: (pgid, signal) =>
    Effect.sync(() => {
      try {
        process.kill(-pgid, signal);
        return "sent" as const;
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ESRCH") return "no_such_group" as const;
        if (code === "EPERM") return "not_permitted" as const;
        return "error" as const;
      }
    }),
  isGroupAlive: (pgid) =>
    Effect.sync(() => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        const code = errnoCode(error);
        // ESRCH: the group is gone. EPERM: it exists but is not ours to signal
        // (treat as alive). Any other error: assume alive so termination stays
        // conservative rather than falsely reporting a stop.
        return code !== "ESRCH";
      }
    }),
};

// ---------------------------------------------------------------------------
// Bounded TERM-to-KILL escalation
// ---------------------------------------------------------------------------

/** Default group escalation window (spec 6.3: 10,000 ms). */
export const DEFAULT_GROUP_TERM_GRACE_MS = 10_000;

/** Settle window after SIGKILL before the final liveness check. */
const KILL_SETTLE_MS = 250;
const GROUP_LIVENESS_POLL_MS = 50;

export type ProcessGroupTerminationOutcome =
  /** The group exited within the grace window after SIGTERM. */
  | { readonly status: "terminated" }
  /** The group was already gone before or at the first signal. */
  | { readonly status: "already_dead" }
  /** SIGTERM was ignored; SIGKILL cleared the group. */
  | { readonly status: "escalated_kill" }
  /** Platform cannot signal groups safely; nothing was signalled. */
  | { readonly status: "unsupported_platform" }
  /**
   * Ownership could no longer be confirmed before a signal (or escalation), so
   * no further signal was sent. The group id may have been recycled.
   */
  | { readonly status: "ownership_revoked"; readonly detail: string }
  /** The group survived TERM and KILL, or signalling failed. */
  | { readonly status: "termination_failed"; readonly detail: string };

/**
 * Ownership check run immediately before every signal (TERM and the KILL
 * escalation). A group identity proves the id was well formed at discovery;
 * this check proves the live group still contains a process captured then.
 */
export type ProcessGroupOwnershipCheck =
  | { readonly status: "confirmed" }
  | {
      readonly status: "revoked";
      readonly reason:
        | "group_missing"
        | "group_replaced"
        | "member_recycled"
        | "reader_unavailable"
        | "table_unavailable";
    };

export interface TerminateGroupOptions {
  readonly graceMs?: number;
  readonly killSignal?: NodeJS.Signals;
  readonly forceSignal?: NodeJS.Signals;
  readonly signaller?: ProcessGroupSignaller;
  /**
   * Revalidate live group ownership before TERM and again before KILL. When it
   * reports `revoked` the escalation stops without signalling: the originally
   * owned group may have exited and its id been reused by an unrelated group.
   */
  readonly confirmOwnership?: () => Effect.Effect<ProcessGroupOwnershipCheck>;
}

const waitForGroupExit = Effect.fn("waitForGroupExit")(function* (
  signaller: ProcessGroupSignaller,
  pgid: number,
  graceMs: number,
) {
  const deadline = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + graceMs;
  while (yield* signaller.isGroupAlive(pgid)) {
    const remaining = deadline - (yield* Effect.clockWith((clock) => clock.currentTimeMillis));
    if (remaining <= 0) return false;
    yield* Effect.sleep(Duration.millis(Math.min(GROUP_LIVENESS_POLL_MS, remaining)));
  }
  return true;
});

/**
 * Terminate a proven neokod-owned process group with a bounded TERM-to-KILL
 * escalation. Because it only accepts a {@link ProcessGroupIdentity}, it can
 * never be called with an untrusted pid. Fails closed on unsupported platforms
 * without emitting any signal.
 */
export const terminateProcessGroup = (
  identity: ProcessGroupIdentity,
  options: TerminateGroupOptions = {},
): Effect.Effect<ProcessGroupTerminationOutcome> =>
  Effect.gen(function* () {
    if (!isGroupSignalingSupported(identity.platform)) {
      return { status: "unsupported_platform" } as const;
    }
    const signaller = options.signaller ?? posixProcessGroupSignaller;
    const graceMs = options.graceMs ?? DEFAULT_GROUP_TERM_GRACE_MS;
    const killSignal = options.killSignal ?? "SIGTERM";
    const forceSignal = options.forceSignal ?? "SIGKILL";
    const { pgid } = identity;
    const confirmOwnership = options.confirmOwnership;
    const ownershipRevoked = (check: ProcessGroupOwnershipCheck & { readonly status: "revoked" }) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("refusing to signal process group: ownership not confirmed", {
          pgid,
          reason: check.reason,
        });
        return { status: "ownership_revoked", detail: check.reason } as const;
      });

    if (confirmOwnership !== undefined) {
      const check = yield* confirmOwnership();
      if (check.status === "revoked") return yield* ownershipRevoked(check);
    }

    const term = yield* signaller.signalGroup(pgid, killSignal);
    if (term === "no_such_group") {
      return { status: "already_dead" } as const;
    }

    if (yield* waitForGroupExit(signaller, pgid, graceMs)) {
      return { status: "terminated" } as const;
    }

    // The group survived TERM. Revalidate before escalating: it may have exited
    // and had its id reused while the grace window was open.
    if (confirmOwnership !== undefined) {
      const check = yield* confirmOwnership();
      if (check.status === "revoked") return yield* ownershipRevoked(check);
    }

    const kill = yield* signaller.signalGroup(pgid, forceSignal);
    if (kill === "no_such_group") {
      return { status: "escalated_kill" } as const;
    }
    yield* Effect.sleep(Duration.millis(KILL_SETTLE_MS));
    if (!(yield* signaller.isGroupAlive(pgid))) {
      return { status: "escalated_kill" } as const;
    }
    return {
      status: "termination_failed",
      detail: `process group ${pgid} survived ${killSignal} and ${forceSignal}`,
    } as const;
  });

// ---------------------------------------------------------------------------
// Orphan-recovery planning (fail-closed bridge for persisted data)
// ---------------------------------------------------------------------------

/**
 * Reason a persisted orphan record cannot be terminated by group semantics.
 * `unproven_group_identity` is the current Symphony state: only a bare
 * `ownerPid` is stored, with no recorded group id, so identity cannot be
 * proven and the group must not be signalled.
 */
export type OrphanGroupSkipReason =
  | "no_pid_recorded"
  | "unproven_group_identity"
  | "unsupported_platform";

export type OrphanGroupTerminationPlan =
  | { readonly action: "terminate"; readonly identity: ProcessGroupIdentity }
  | { readonly action: "skip"; readonly reason: OrphanGroupSkipReason };

/**
 * Decide how to terminate a persisted orphan, failing closed when the stored
 * data cannot prove group identity.
 *
 * Today Symphony persists only `ownerPid`. Without a recorded, leader-matching
 * `ownerPgid` there is no way to prove the recorded pid still leads the group
 * neokod spawned (it may have been reaped and recycled), so this returns
 * `skip("unproven_group_identity")` and NOTHING is signalled. The single-pid
 * SIGTERM that used to run here is intentionally not reachable.
 *
 * Once the persistence migration lands (spawn the agent child as a detached
 * group leader and persist `ownerPgid` alongside `ownerPid`), passing that
 * `ownerPgid` here yields a proven identity and a real group termination, with
 * no change to callers.
 */
export const planOrphanGroupTermination = (input: {
  readonly ownerPid?: number | null;
  readonly ownerPgid?: number | null;
  readonly spawnedAtMs?: number | null;
  readonly platform: NodeJS.Platform;
}): OrphanGroupTerminationPlan => {
  if (!isGroupSignalingSupported(input.platform)) {
    return { action: "skip", reason: "unsupported_platform" };
  }
  const pid = input.ownerPid;
  if (pid === null || pid === undefined || pid <= 0) {
    return { action: "skip", reason: "no_pid_recorded" };
  }
  const pgid = input.ownerPgid;
  if (pgid === null || pgid === undefined || pgid <= 0) {
    // Bare pid only: cannot prove the group. Fail closed (spec 6.6).
    return { action: "skip", reason: "unproven_group_identity" };
  }
  const proven = makeProvenGroupIdentity({
    pid,
    pgid,
    spawnedAtMs: input.spawnedAtMs ?? 0,
    platform: input.platform,
  });
  if (!proven.ok) {
    return { action: "skip", reason: "unproven_group_identity" };
  }
  return { action: "terminate", identity: proven.identity };
};

// ---------------------------------------------------------------------------
// Recycle-resistant process-birth identity
// ---------------------------------------------------------------------------

/**
 * A `pid` on its own is not a durable identity: the kernel recycles pids, so a
 * pid persisted before a crash may point at an unrelated process after restart.
 * Signalling `-pgid` where `pgid === recycledPid` could then hit a stranger's
 * process group. The birth token is the kernel-reported start time of the pid;
 * a recycled pid has a different (later) start time, so a persisted token that
 * still matches the live process proves it is the same process we spawned.
 */
export type ProcessBirthResult =
  /** The live process exists; `token` is its birth token. */
  | { readonly kind: "token"; readonly token: string }
  /** No process with that pid exists (the leader is gone). */
  | { readonly kind: "no_such_process" }
  /** The reader could not determine the answer (tool missing, error). */
  | { readonly kind: "unavailable"; readonly detail?: string };

export interface ProcessBirthReader {
  /** Read the recycle-resistant birth token for a live pid. Never throws. */
  readonly readBirthToken: (pid: number) => Effect.Effect<ProcessBirthResult>;
}

type PsTextResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "no_such_process" }
  | { readonly kind: "unavailable"; readonly detail?: string };

/**
 * Read a single `ps` column for a pid. `ps` exits non-zero with empty stdout
 * when the pid does not exist; a spawn-level failure (for example a missing
 * `ps` binary) is `unavailable` so callers fail closed rather than assume the
 * process is gone.
 */
const readPsColumn = (pid: number, column: string): PsTextResult => {
  try {
    const out = NodeChildProcess.execFileSync("ps", ["-o", `${column}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length === 0) return { kind: "no_such_process" } as const;
    return { kind: "text", text: out } as const;
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined) {
      return { kind: "unavailable", detail: code } as const;
    }
    const status = (error as { readonly status?: unknown }).status;
    const stdout = (error as { readonly stdout?: unknown }).stdout;
    const stdoutText = typeof stdout === "string" ? stdout.trim() : "";
    if (typeof status === "number" && stdoutText.length === 0) {
      return { kind: "no_such_process" } as const;
    }
    return { kind: "unavailable", detail: "ps_failed" } as const;
  }
};

/**
 * POSIX birth reader. `ps -o lstart= -p <pid>` prints the process start time
 * with no header; `ps` exits non-zero (status 1) with empty stdout when the
 * pid does not exist, which we map to `no_such_process`. A missing `ps` binary
 * or any other spawn failure maps to `unavailable` so callers fail closed
 * rather than assuming the process is gone.
 */
export const posixProcessBirthReader: ProcessBirthReader = {
  readBirthToken: (pid) =>
    Effect.sync(() => {
      const result = readPsColumn(pid, "lstart");
      switch (result.kind) {
        case "no_such_process":
          return result;
        case "unavailable":
          return result;
        case "text":
          return { kind: "token", token: result.text } as const;
      }
    }),
};

/**
 * Capture the birth token for a freshly spawned pid, best-effort. Returns the
 * token string, or `null` when it cannot be read; a missing token is unknown
 * evidence and later ownership checks fail closed rather than guessing.
 */
export const captureProcessBirthToken = (
  pid: number,
  reader: ProcessBirthReader = posixProcessBirthReader,
): Effect.Effect<string | null> =>
  reader.readBirthToken(pid).pipe(
    Effect.map((result) => (result.kind === "token" ? result.token : null)),
    Effect.catchCause(() => Effect.succeed(null)),
  );

export type BirthValidation =
  /** The live process matches the persisted birth token: same process. */
  | { readonly status: "confirmed" }
  /** The pid now points at a different process: it was recycled. */
  | { readonly status: "recycled" }
  /** No process with that pid exists: the leader is gone. */
  | { readonly status: "process_gone" }
  /** Cannot decide (no persisted token, or reader unavailable). */
  | {
      readonly status: "unverifiable";
      readonly reason: "no_persisted_token" | "reader_unavailable";
    };

/**
 * Validate a persisted pid against the live OS process using the birth token.
 * Fails closed: without a persisted token, or when the reader cannot answer,
 * the result is `unverifiable` and callers must not signal.
 */
export const validateProcessBirthIdentity = (
  input: { readonly pid: number; readonly persistedBirthToken?: string | null },
  reader: ProcessBirthReader = posixProcessBirthReader,
): Effect.Effect<BirthValidation> =>
  Effect.gen(function* () {
    const persisted = input.persistedBirthToken;
    if (persisted === null || persisted === undefined || persisted.trim().length === 0) {
      return { status: "unverifiable", reason: "no_persisted_token" } as const;
    }
    const live = yield* reader.readBirthToken(input.pid);
    switch (live.kind) {
      case "no_such_process":
        return { status: "process_gone" } as const;
      case "unavailable":
        return { status: "unverifiable", reason: "reader_unavailable" } as const;
      case "token":
        return live.token.trim() === persisted.trim()
          ? ({ status: "confirmed" } as const)
          : ({ status: "recycled" } as const);
    }
  });

// ---------------------------------------------------------------------------
// Terminal ownership evidence (pty shell + controlling tty captured at spawn)
// ---------------------------------------------------------------------------

const NO_CONTROLLING_TTY = new Set(["?", "??", "-"]);

export type ProcessTtyResult =
  /** The process has a controlling tty (`ttys003`, `pts/0`, ...). */
  | { readonly kind: "tty"; readonly tty: string }
  /** The process exists but has no controlling tty. */
  | { readonly kind: "no_tty" }
  /** No process with that pid exists. */
  | { readonly kind: "no_such_process" }
  /** The reader could not determine the answer (tool missing, error). */
  | { readonly kind: "unavailable"; readonly detail?: string };

export interface ProcessTtyReader {
  /** Read the controlling tty name for a live pid. Never throws. */
  readonly readTty: (pid: number) => Effect.Effect<ProcessTtyResult>;
}

/** POSIX controlling-tty reader (`ps -o tty= -p <pid>`). */
export const posixProcessTtyReader: ProcessTtyReader = {
  readTty: (pid) =>
    Effect.sync(() => {
      const result = readPsColumn(pid, "tty");
      switch (result.kind) {
        case "no_such_process":
          return result;
        case "unavailable":
          return result;
        case "text":
          return NO_CONTROLLING_TTY.has(result.text)
            ? ({ kind: "no_tty" } as const)
            : ({ kind: "tty", tty: result.text } as const);
      }
    }),
};

/**
 * Ownership evidence captured while the pty shell is known to be the process
 * neokod just spawned. Later cleanup must revalidate this evidence instead of
 * trusting a pid on its own: a recycled pid could point at an unrelated
 * process whose tty (or group) must never be signalled.
 */
export interface TerminalOwnershipEvidence {
  /** The pty shell pid recorded at spawn. */
  readonly shellPid: number;
  /** Recycle-resistant birth token of the shell, captured at spawn. */
  readonly shellBirthToken: string | null;
  /** Controlling tty name of the shell at spawn (`ttys003`, `pts/0`, ...). */
  readonly controllingTty: string | null;
  /** Wall-clock capture time in ms; provenance only. */
  readonly capturedAtMs: number;
  /** Platform the terminal was spawned on. */
  readonly platform: NodeJS.Platform;
}

export interface TerminalOwnershipReadDeps {
  readonly birthReader?: ProcessBirthReader;
  readonly ttyReader?: ProcessTtyReader;
}

/**
 * Capture the shell pid's birth token and controlling tty immediately after a
 * pty spawn. Missing fields stay `null` (unknown evidence), which later
 * disables group discovery rather than guessing.
 */
export const captureTerminalOwnership = (
  input: {
    readonly pid: number;
    readonly platform: NodeJS.Platform;
    readonly capturedAtMs?: number;
  },
  deps: TerminalOwnershipReadDeps = {},
): Effect.Effect<TerminalOwnershipEvidence> =>
  Effect.gen(function* () {
    const capturedAtMs =
      input.capturedAtMs ?? (yield* Effect.clockWith((clock) => clock.currentTimeMillis));
    const base = {
      shellPid: input.pid,
      capturedAtMs,
      platform: input.platform,
    };
    if (
      !isGroupSignalingSupported(input.platform) ||
      !Number.isInteger(input.pid) ||
      input.pid <= 1
    ) {
      return {
        ...base,
        shellBirthToken: null,
        controllingTty: null,
      } as const;
    }
    const birthReader = deps.birthReader ?? posixProcessBirthReader;
    const ttyReader = deps.ttyReader ?? posixProcessTtyReader;
    const shellBirthToken = yield* captureProcessBirthToken(input.pid, birthReader);
    const ttyResult = yield* ttyReader.readTty(input.pid);
    return {
      ...base,
      shellBirthToken,
      controllingTty: ttyResult.kind === "tty" ? ttyResult.tty : null,
    } as const;
  });

export type TerminalOwnershipValidation =
  /** The live shell is the same process and still controls the captured tty. */
  | { readonly status: "confirmed"; readonly tty: string }
  /** No process with the shell pid exists. */
  | { readonly status: "process_gone" }
  /** The pid now points at a different process: it was recycled. */
  | { readonly status: "recycled" }
  /** The shell is the same process but now controls a different tty. */
  | { readonly status: "tty_mismatch"; readonly tty: string | null }
  /** Cannot decide, so no group may be discovered or signalled. */
  | {
      readonly status: "unverifiable";
      readonly reason:
        | "unsupported_platform"
        | "invalid_pid"
        | "no_birth_token"
        | "no_controlling_tty"
        | "table_unavailable"
        | "shell_row_missing"
        | "reader_unavailable";
    };

/** Live process-table snapshot used to prove tty membership. */
export type ProcessTableResult =
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<PsPidPgidTtyRow> }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * Revalidate captured terminal ownership against the live process table and
 * birth identity. Fails closed for every state that cannot prove the shell is
 * still the process neokod spawned and still controls the captured tty.
 */
export const validateTerminalOwnership = (
  evidence: TerminalOwnershipEvidence,
  table: ProcessTableResult,
  reader: ProcessBirthReader = posixProcessBirthReader,
): Effect.Effect<TerminalOwnershipValidation> =>
  Effect.gen(function* () {
    if (!isGroupSignalingSupported(evidence.platform)) {
      return { status: "unverifiable", reason: "unsupported_platform" } as const;
    }
    if (!Number.isInteger(evidence.shellPid) || evidence.shellPid <= 1) {
      return { status: "unverifiable", reason: "invalid_pid" } as const;
    }
    if (evidence.shellBirthToken === null || evidence.shellBirthToken.trim().length === 0) {
      return { status: "unverifiable", reason: "no_birth_token" } as const;
    }
    const birth = yield* validateProcessBirthIdentity(
      { pid: evidence.shellPid, persistedBirthToken: evidence.shellBirthToken },
      reader,
    );
    switch (birth.status) {
      case "process_gone":
        return { status: "process_gone" } as const;
      case "recycled":
        return { status: "recycled" } as const;
      case "unverifiable":
        return { status: "unverifiable", reason: "reader_unavailable" } as const;
      case "confirmed":
        break;
    }
    if (evidence.controllingTty === null) {
      return { status: "unverifiable", reason: "no_controlling_tty" } as const;
    }
    if (table.kind === "unavailable") {
      return { status: "unverifiable", reason: "table_unavailable" } as const;
    }
    const shellRow = table.rows.find((row) => row.pid === evidence.shellPid);
    if (shellRow === undefined) {
      return { status: "unverifiable", reason: "shell_row_missing" } as const;
    }
    if (shellRow.tty !== evidence.controllingTty) {
      return { status: "tty_mismatch", tty: shellRow.tty } as const;
    }
    return { status: "confirmed", tty: evidence.controllingTty } as const;
  });

// ---------------------------------------------------------------------------
// Terminal-owned process groups (discovery + revalidation before signalling)
// ---------------------------------------------------------------------------

export interface ProcessGroupAnchor {
  /** A member pid observed in the group at discovery. */
  readonly pid: number;
  /** Birth token of that member, captured at discovery. */
  readonly birthToken: string;
  /** Controlling tty observed for the member when the anchor was accepted. */
  readonly tty: string;
}

export interface OwnedTtyProcessGroup {
  readonly pgid: number;
  readonly tty: string;
  /**
   * Members whose birth identity was readable at discovery. Before each signal
   * at least one anchor must still exist with the same pgid and birth token:
   * that proves the group id was not recycled. Groups without anchors are
   * excluded, never signalled on numeric equality alone.
   */
  readonly anchors: ReadonlyArray<ProcessGroupAnchor>;
}

/**
 * Groups sharing a validated terminal tty, with birth-token anchors for the
 * members that could be read and whose membership was reconfirmed after the
 * token read. Pure over the supplied snapshots; POSIX-free so it can be tested
 * deterministically.
 *
 * A pid in the initial snapshot can exit and be recycled before its birth token
 * is read, so the token may belong to an unrelated replacement. `readMembership`
 * is therefore read again after the tokens and an anchor is kept only when that
 * fresh row still matches the snapshot's pid, pgid and tty.
 */
export const discoverOwnedTtyProcessGroups = (
  input: {
    readonly rows: ReadonlyArray<PsPidPgidTtyRow>;
    readonly tty: string;
    readonly ownPid: number;
  },
  reader: ProcessBirthReader,
  readMembership: () => Effect.Effect<ProcessTableResult>,
): Effect.Effect<ReadonlyArray<OwnedTtyProcessGroup>> =>
  Effect.gen(function* () {
    const ownGroup = input.rows.find((row) => row.pid === input.ownPid)?.pgid;
    const membersByGroup = new Map<number, Array<number>>();
    for (const row of input.rows) {
      if (row.tty !== input.tty || row.pgid <= 1 || row.pgid === ownGroup) continue;
      if (row.pid === input.ownPid) continue;
      const members = membersByGroup.get(row.pgid) ?? [];
      members.push(row.pid);
      membersByGroup.set(row.pgid, members);
    }

    const groups: Array<OwnedTtyProcessGroup> = [];
    for (const [pgid, members] of membersByGroup) {
      const anchors: Array<ProcessGroupAnchor> = [];
      for (const pid of members) {
        const birth = yield* reader.readBirthToken(pid);
        if (birth.kind === "token" && birth.token.trim().length > 0) {
          anchors.push({ pid, birthToken: birth.token, tty: input.tty });
        }
      }
      if (anchors.length > 0) {
        groups.push({ pgid, tty: input.tty, anchors });
      }
    }
    if (groups.length === 0) return groups;

    // The snapshot and the birth tokens above are separate observations. Read
    // membership once more so a pid recycled onto another tty cannot donate the
    // replacement's birth token to a group we would later signal.
    const membership = yield* readMembership();
    if (membership.kind === "unavailable") return [];
    const rowsByPid = new Map(membership.rows.map((row) => [row.pid, row] as const));
    return groups.flatMap((group) => {
      const anchors = group.anchors.filter((anchor) => {
        const row = rowsByPid.get(anchor.pid);
        return row !== undefined && row.pgid === group.pgid && row.tty === group.tty;
      });
      return anchors.length > 0 ? [{ ...group, anchors }] : [];
    });
  });

/**
 * Confirm a discovered group still contains at least one of its anchors with
 * the same pgid, tty and birth token. This is the pre-signal guard: it fails
 * closed when the group vanished, a pid was recycled onto another terminal, or
 * the evidence cannot be read.
 */
export const confirmOwnedTtyProcessGroup = (
  group: OwnedTtyProcessGroup,
  table: ProcessTableResult,
  reader: ProcessBirthReader = posixProcessBirthReader,
): Effect.Effect<ProcessGroupOwnershipCheck> =>
  Effect.gen(function* () {
    if (table.kind === "unavailable") {
      return { status: "revoked", reason: "table_unavailable" } as const;
    }
    let sawReaderUnavailable = false;
    let sawMismatch = false;
    let sawTtyMismatch = false;
    for (const anchor of group.anchors) {
      const row = table.rows.find((candidate) => candidate.pid === anchor.pid);
      if (row === undefined) {
        sawMismatch = true;
        continue;
      }
      if (row.pgid !== group.pgid) {
        sawMismatch = true;
        continue;
      }
      if (row.tty !== group.tty || row.tty !== anchor.tty) {
        // The pid now belongs to a process group on another terminal, so it
        // cannot confirm this group even if its birth token matches.
        sawTtyMismatch = true;
        continue;
      }
      const birth = yield* reader.readBirthToken(anchor.pid);
      switch (birth.kind) {
        case "unavailable":
          sawReaderUnavailable = true;
          break;
        case "no_such_process":
          sawMismatch = true;
          break;
        case "token":
          if (birth.token.trim() === anchor.birthToken.trim()) {
            return { status: "confirmed" } as const;
          }
          sawMismatch = true;
          break;
      }
    }
    if (sawMismatch) return { status: "revoked", reason: "group_replaced" } as const;
    if (sawTtyMismatch) return { status: "revoked", reason: "member_recycled" } as const;
    if (sawReaderUnavailable) {
      return { status: "revoked", reason: "reader_unavailable" } as const;
    }
    return { status: "revoked", reason: "group_missing" } as const;
  });

// ---------------------------------------------------------------------------
// Validated orphan-recovery planning (structural identity + live birth check)
// ---------------------------------------------------------------------------

export type ValidatedOrphanSkipReason =
  | OrphanGroupSkipReason
  | "pid_recycled"
  | "birth_identity_unverifiable";

export type ValidatedOrphanTerminationPlan =
  /** Identity proven AND the live process confirmed: terminate the group. */
  | { readonly action: "terminate"; readonly identity: ProcessGroupIdentity }
  /** The recorded leader is gone; there is nothing to signal. */
  | { readonly action: "already_gone" }
  /** Fail closed: do not signal, keep the orphan blocked (spec 6.6). */
  | { readonly action: "skip"; readonly reason: ValidatedOrphanSkipReason };

/**
 * Decide how to terminate a persisted orphan, validating the CURRENT OS process
 * against the persisted birth identity before authorizing any signal
 * (Issue #101 spec 6.6, implementation-sequence step 3).
 *
 * This is the recovery entry point and supersedes the purely structural
 * {@link planOrphanGroupTermination} for the signalling decision. A persisted
 * `pid === pgid` is treated as necessary but NOT sufficient: the birth token
 * captured at spawn must still match the live process, otherwise the pid may
 * have been recycled and signalling `-pgid` could hit an unrelated group. When
 * the birth identity cannot be confirmed the plan fails closed and nothing is
 * signalled.
 */
export const planValidatedOrphanTermination = (
  input: {
    readonly ownerPid?: number | null;
    readonly ownerPgid?: number | null;
    readonly ownerBirthToken?: string | null;
    readonly spawnedAtMs?: number | null;
    readonly platform: NodeJS.Platform;
  },
  reader: ProcessBirthReader = posixProcessBirthReader,
): Effect.Effect<ValidatedOrphanTerminationPlan> =>
  Effect.gen(function* () {
    const structural = planOrphanGroupTermination({
      ...(input.ownerPid === undefined ? {} : { ownerPid: input.ownerPid }),
      ...(input.ownerPgid === undefined ? {} : { ownerPgid: input.ownerPgid }),
      ...(input.spawnedAtMs === undefined ? {} : { spawnedAtMs: input.spawnedAtMs }),
      platform: input.platform,
    });
    if (structural.action === "skip") {
      return { action: "skip", reason: structural.reason };
    }
    const validation = yield* validateProcessBirthIdentity(
      {
        pid: structural.identity.pid,
        ...(input.ownerBirthToken === undefined
          ? {}
          : { persistedBirthToken: input.ownerBirthToken }),
      },
      reader,
    );
    switch (validation.status) {
      case "confirmed":
        return {
          action: "terminate",
          identity: { ...structural.identity, birthToken: input.ownerBirthToken ?? null },
        };
      case "process_gone":
        return { action: "already_gone" };
      case "recycled":
        return { action: "skip", reason: "pid_recycled" };
      case "unverifiable":
        return { action: "skip", reason: "birth_identity_unverifiable" };
    }
  });

// ---------------------------------------------------------------------------
// Owned-process closure (single policy for recovery and confirmed stop)
// ---------------------------------------------------------------------------

/**
 * Why an owned process/group could not be confirmed closed. Every one of these
 * states keeps the owning claim/lease held: releasing it would let a retry run
 * beside a possibly-surviving process.
 */
export type ProcessClosureHoldReason =
  | ValidatedOrphanSkipReason
  | "owner_is_server"
  | "invalid_owner_pid"
  | "leader_gone_descendants_unconfirmed"
  | "ownership_revoked"
  | "termination_failed";

/**
 * Positive evidence that no process we owned can still be running.
 * `no_owner_recorded` means the claim never recorded a child process, so there
 * is nothing neokod could have signalled or must wait for.
 */
export type ProcessClosureEvidence =
  | "no_owner_recorded"
  | "group_terminated"
  | "group_escalated_kill"
  | "group_already_dead"
  | "leader_and_group_gone";

export type ProcessClosureResult =
  | { readonly status: "closed"; readonly evidence: ProcessClosureEvidence }
  | {
      readonly status: "held";
      readonly reason: ProcessClosureHoldReason;
      readonly detail?: string;
    };

export interface ProcessClosureDeps {
  readonly reader?: ProcessBirthReader;
  readonly signaller?: ProcessGroupSignaller;
  readonly platform?: NodeJS.Platform;
  readonly graceMs?: number;
  readonly killSignal?: NodeJS.Signals;
  readonly forceSignal?: NodeJS.Signals;
}

const hold = (reason: ProcessClosureHoldReason, detail?: string): ProcessClosureResult =>
  detail === undefined ? { status: "held", reason } : { status: "held", reason, detail };

/**
 * Resolve the closure of a persisted neokod-owned agent process group.
 *
 * This is the one shared closure policy. Recovery calls it before releasing a
 * claim/lease, and a confirmed Stop calls it before settling a cancelled run.
 * It only signals through {@link planValidatedOrphanTermination} and
 * {@link terminateProcessGroup}, so:
 *
 *  - a bare pid, a recycled pid, a missing birth token, an unreadable process
 *    table, or a non-POSIX platform is `held` and emits no signal;
 *  - the leader's exit alone never proves descendant closure. When the leader
 *    is gone but the group still has members, the result is `held`
 *    (`leader_gone_descendants_unconfirmed`) rather than a signal or a release;
 *  - ownership is revalidated immediately before each signal. If the leader
 *    exits after SIGTERM while group members remain, escalation is refused
 *    (`ownership_revoked`) because a recycled group id cannot be distinguished
 *    from our surviving descendants, so closure stays unconfirmed.
 */
export const confirmOwnedProcessClosure = (
  input: {
    readonly ownerPid?: number | null;
    readonly ownerPgid?: number | null;
    readonly ownerBirthToken?: string | null;
    readonly spawnedAtMs?: number | null;
    /** The calling server's own pid; recovered rows must never target it. */
    readonly ownPid?: number;
  },
  deps: ProcessClosureDeps = {},
): Effect.Effect<ProcessClosureResult> =>
  Effect.gen(function* () {
    const pid = input.ownerPid;
    if (pid === null || pid === undefined) {
      return { status: "closed", evidence: "no_owner_recorded" } as const;
    }
    if (!Number.isInteger(pid) || pid <= 1) {
      return hold("invalid_owner_pid");
    }
    const ownPid = input.ownPid ?? process.pid;
    if (pid === ownPid) {
      return hold("owner_is_server");
    }

    const reader = deps.reader ?? posixProcessBirthReader;
    const signaller = deps.signaller ?? posixProcessGroupSignaller;
    const platform = deps.platform ?? (yield* HostProcessPlatform);

    const plan = yield* planValidatedOrphanTermination(
      {
        ownerPid: pid,
        ...(input.ownerPgid === undefined ? {} : { ownerPgid: input.ownerPgid }),
        ...(input.ownerBirthToken === undefined ? {} : { ownerBirthToken: input.ownerBirthToken }),
        ...(input.spawnedAtMs === undefined ? {} : { spawnedAtMs: input.spawnedAtMs }),
        platform,
      },
      reader,
    );

    switch (plan.action) {
      case "skip":
        return hold(plan.reason);
      case "already_gone": {
        // The recorded leader is gone. The group id stays allocated while any
        // descendant remains, so a live group is evidence of possible surviving
        // work, but with no live leader there is no birth identity left to
        // prove it is OUR group. Preserve the uncertainty instead of signalling
        // or releasing.
        const pgid = input.ownerPgid;
        if (pgid === null || pgid === undefined || pgid <= 0 || pgid !== pid) {
          return hold("unproven_group_identity");
        }
        const groupAlive = yield* signaller.isGroupAlive(pgid);
        return groupAlive
          ? hold("leader_gone_descendants_unconfirmed")
          : ({ status: "closed", evidence: "leader_and_group_gone" } as const);
      }
      case "terminate": {
        const confirmOwnership = (): Effect.Effect<ProcessGroupOwnershipCheck> =>
          Effect.gen(function* () {
            const validation = yield* validateProcessBirthIdentity(
              {
                pid: plan.identity.pid,
                ...(plan.identity.birthToken === null
                  ? {}
                  : { persistedBirthToken: plan.identity.birthToken }),
              },
              reader,
            );
            switch (validation.status) {
              case "confirmed":
                return { status: "confirmed" } as const;
              case "process_gone":
                return { status: "revoked", reason: "group_missing" } as const;
              case "recycled":
                return { status: "revoked", reason: "member_recycled" } as const;
              case "unverifiable":
                return { status: "revoked", reason: "reader_unavailable" } as const;
            }
          });

        const outcome = yield* terminateProcessGroup(plan.identity, {
          signaller,
          ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
          ...(deps.killSignal === undefined ? {} : { killSignal: deps.killSignal }),
          ...(deps.forceSignal === undefined ? {} : { forceSignal: deps.forceSignal }),
          confirmOwnership,
        });
        switch (outcome.status) {
          case "terminated":
            return { status: "closed", evidence: "group_terminated" } as const;
          case "escalated_kill":
            return { status: "closed", evidence: "group_escalated_kill" } as const;
          case "already_dead":
            return { status: "closed", evidence: "group_already_dead" } as const;
          case "ownership_revoked":
            return hold("ownership_revoked", outcome.detail);
          case "termination_failed":
            return hold("termination_failed", outcome.detail);
          case "unsupported_platform":
            return hold("unsupported_platform");
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Controlling-tty discovery (terminals that own an interactive pty)
// ---------------------------------------------------------------------------

export interface PsPidPgidTtyRow {
  readonly pid: number;
  readonly pgid: number;
  readonly tty: string;
}

/** Parse `ps -A -o pid=,pgid=,tty=` output. Lines that do not have three columns are ignored. */
export const parsePsPidPgidTty = (stdout: string): ReadonlyArray<PsPidPgidTtyRow> => {
  const rows: Array<PsPidPgidTtyRow> = [];
  for (const line of stdout.split("\n")) {
    const [pidText, pgidText, tty] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const pgid = Number(pgidText);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid) || tty === undefined) continue;
    rows.push({ pid, pgid, tty });
  }
  return rows;
};

/**
 * Process-group ids of every process that shares the controlling tty of
 * `rootPid` (the pty child, which is the session leader). Excludes the
 * server's own group. Returns [] when the root is not in the table or has no
 * tty, so callers fall back instead of signalling a broad or unknown set.
 */
export const selectControllingTtyProcessGroups = (
  rows: ReadonlyArray<PsPidPgidTtyRow>,
  input: { readonly rootPid: number; readonly ownPid: number },
): ReadonlyArray<number> => {
  const root = rows.find((row) => row.pid === input.rootPid);
  if (root === undefined || NO_CONTROLLING_TTY.has(root.tty)) return [];
  const ownGroup = rows.find((row) => row.pid === input.ownPid)?.pgid;
  const groups = new Set<number>();
  for (const row of rows) {
    if (row.tty !== root.tty || row.pgid <= 1 || row.pgid === ownGroup) continue;
    groups.add(row.pgid);
  }
  return [...groups];
};

const execFileText = NodeUtil.promisify(NodeChildProcess.execFile);

/**
 * Read a snapshot of the live process table (`pid`, `pgid`, `tty`). POSIX
 * only; `unavailable` on unsupported platforms or when `ps` is missing/fails,
 * so callers fail closed instead of guessing which groups to signal.
 */
export const readProcessTable = (platform: NodeJS.Platform): Effect.Effect<ProcessTableResult> =>
  !isGroupSignalingSupported(platform)
    ? Effect.succeed({ kind: "unavailable", detail: "unsupported_platform" } as const)
    : Effect.tryPromise(() =>
        execFileText("ps", ["-A", "-o", "pid=,pgid=,tty="], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 3_000,
        }),
      ).pipe(
        Effect.map(({ stdout }) => ({ kind: "rows", rows: parsePsPidPgidTty(stdout) }) as const),
        Effect.orElseSucceed(() => ({ kind: "unavailable", detail: "ps_unavailable" }) as const),
      );

/**
 * Groups sharing the controlling tty of `rootPid`, read from a live process
 * table snapshot. POSIX only: returns [] on unsupported platforms, for an
 * invalid root pid, or when `ps` is missing/fails, so the caller can keep its
 * single-pid fallback rather than guessing which unrelated groups to signal.
 */
export const listControllingTtyProcessGroups = (
  rootPid: number,
  platform: NodeJS.Platform,
): Effect.Effect<ReadonlyArray<number>> =>
  !isGroupSignalingSupported(platform) || !Number.isInteger(rootPid) || rootPid <= 1
    ? Effect.succeed([])
    : readProcessTable(platform).pipe(
        Effect.map((table) =>
          table.kind === "rows"
            ? selectControllingTtyProcessGroups(table.rows, {
                rootPid,
                ownPid: process.pid,
              })
            : [],
        ),
      );
