// @effect-diagnostics nodeBuiltinImport:off - the POSIX birth-identity reader
// shells out to `ps` to read a spawned process's OS start time.
import * as NodeChildProcess from "node:child_process";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

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
  /** The group survived TERM and KILL, or signalling failed. */
  | { readonly status: "termination_failed"; readonly detail: string };

export interface TerminateGroupOptions {
  readonly graceMs?: number;
  readonly killSignal?: NodeJS.Signals;
  readonly forceSignal?: NodeJS.Signals;
  readonly signaller?: ProcessGroupSignaller;
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

    const term = yield* signaller.signalGroup(pgid, killSignal);
    if (term === "no_such_group") {
      return { status: "already_dead" } as const;
    }

    if (yield* waitForGroupExit(signaller, pgid, graceMs)) {
      return { status: "terminated" } as const;
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
      try {
        const out = NodeChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out.length === 0) return { kind: "no_such_process" } as const;
        return { kind: "token", token: out } as const;
      } catch (error) {
        const code = errnoCode(error);
        if (code !== undefined) {
          // Spawn-level failure (e.g. ENOENT: `ps` not found): cannot tell.
          return { kind: "unavailable", detail: code } as const;
        }
        const status = (error as { readonly status?: unknown }).status;
        const stdout = (error as { readonly stdout?: unknown }).stdout;
        const stdoutText = typeof stdout === "string" ? stdout.trim() : "";
        // `ps` ran and exited non-zero with no output: the pid is not found.
        if (typeof status === "number" && stdoutText.length === 0) {
          return { kind: "no_such_process" } as const;
        }
        return { kind: "unavailable", detail: "ps_failed" } as const;
      }
    }),
};

/**
 * Capture the birth token for a freshly spawned pid, best-effort. Returns the
 * token string, or `null` when it cannot be read (the identity is then only
 * provenance and can never be used to authorize a later signal).
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
