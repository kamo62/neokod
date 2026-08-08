// @effect-diagnostics nodeBuiltinImport:off - focused POSIX test spawns a real
// detached process to exercise the group signaller.
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "./hostProcess.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as NodeChildProcess from "node:child_process";

import {
  DEFAULT_GROUP_TERM_GRACE_MS,
  isGroupSignalingSupported,
  makeProvenGroupIdentity,
  planOrphanGroupTermination,
  posixProcessGroupSignaller,
  type ProcessGroupSignaller,
  terminateProcessGroup,
} from "./processGroup.ts";

describe("isGroupSignalingSupported", () => {
  it("is true for POSIX platforms and false for win32", () => {
    expect(isGroupSignalingSupported("darwin")).toBe(true);
    expect(isGroupSignalingSupported("linux")).toBe(true);
    expect(isGroupSignalingSupported("win32")).toBe(false);
  });
});

describe("makeProvenGroupIdentity", () => {
  it("accepts a group leader (pgid === pid)", () => {
    const result = makeProvenGroupIdentity({
      pid: 4242,
      pgid: 4242,
      spawnedAtMs: 1,
      platform: "linux",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a fabricated group id (pgid !== pid) so a bare pid cannot be promoted", () => {
    const result = makeProvenGroupIdentity({
      pid: 4242,
      pgid: 4243,
      spawnedAtMs: 1,
      platform: "linux",
    });
    expect(result).toEqual({ ok: false, reason: "not_group_leader" });
  });

  it("rejects non-positive ids", () => {
    expect(makeProvenGroupIdentity({ pid: 0, pgid: 0, spawnedAtMs: 1, platform: "linux" })).toEqual(
      { ok: false, reason: "non_positive_ids" },
    );
  });

  it("rejects unsupported platforms", () => {
    expect(makeProvenGroupIdentity({ pid: 5, pgid: 5, spawnedAtMs: 1, platform: "win32" })).toEqual(
      { ok: false, reason: "unsupported_platform" },
    );
  });
});

describe("planOrphanGroupTermination", () => {
  it("fails closed with unproven_group_identity when only a bare pid is persisted", () => {
    expect(planOrphanGroupTermination({ ownerPid: 12345, platform: "linux" })).toEqual({
      action: "skip",
      reason: "unproven_group_identity",
    });
  });

  it("skips when no pid was recorded", () => {
    expect(planOrphanGroupTermination({ ownerPid: null, platform: "linux" })).toEqual({
      action: "skip",
      reason: "no_pid_recorded",
    });
  });

  it("fails closed on unsupported platforms even with a full identity", () => {
    expect(
      planOrphanGroupTermination({
        ownerPid: 10,
        ownerPgid: 10,
        platform: "win32",
      }),
    ).toEqual({ action: "skip", reason: "unsupported_platform" });
  });

  it("plans a group termination once a leader-matching pgid is persisted", () => {
    const plan = planOrphanGroupTermination({
      ownerPid: 777,
      ownerPgid: 777,
      spawnedAtMs: 5,
      platform: "linux",
    });
    expect(plan.action).toBe("terminate");
  });

  it("rejects a persisted pgid that does not match the leader pid", () => {
    expect(
      planOrphanGroupTermination({ ownerPid: 777, ownerPgid: 778, platform: "linux" }),
    ).toEqual({ action: "skip", reason: "unproven_group_identity" });
  });
});

const provenIdentity = (platform: NodeJS.Platform) => {
  const result = makeProvenGroupIdentity({ pid: 9001, pgid: 9001, spawnedAtMs: 0, platform });
  if (!result.ok) throw new Error("expected proven identity");
  return result.identity;
};

// A fake signaller lets the bounded escalation be exercised without real
// processes (fast, low memory) and covers the ignore-TERM path.
const fakeSignaller = (config: {
  readonly aliveAfterTerm: boolean;
  readonly aliveAfterKill: boolean;
  readonly termResult?: "sent" | "no_such_group";
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<Array<NodeJS.Signals>>([]);
    const sentCount = yield* Ref.make(0);
    const signaller: ProcessGroupSignaller = {
      signalGroup: (_pgid, signal) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (prev) => [...prev, signal]);
          if (signal === "SIGTERM") return config.termResult ?? "sent";
          return "sent";
        }),
      isGroupAlive: (_pgid) =>
        Ref.updateAndGet(sentCount, (n) => n + 1).pipe(
          Effect.map((n) => (n === 1 ? config.aliveAfterTerm : config.aliveAfterKill)),
        ),
    };
    return { signaller, calls };
  });

describe("terminateProcessGroup (deterministic)", () => {
  it.effect("reports unsupported_platform and never signals on win32", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: true,
      });
      // The public constructor forbids a win32 identity, so pass a raw record
      // to prove terminateProcessGroup's own platform guard fails closed.
      const outcome = yield* terminateProcessGroup(
        { pid: 1, pgid: 1, spawnedAtMs: 0, platform: "win32", birthToken: null },
        { signaller, graceMs: 1 },
      );
      expect(outcome).toEqual({ status: "unsupported_platform" });
      // No signal of any kind may have been emitted.
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  );

  it.effect("reports already_dead when the group is gone at first signal", () =>
    Effect.gen(function* () {
      const { signaller } = yield* fakeSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
        termResult: "no_such_group",
      });
      const outcome = yield* terminateProcessGroup(provenIdentity("linux"), {
        signaller,
        graceMs: 1,
      });
      expect(outcome).toEqual({ status: "already_dead" });
    }),
  );

  it.live("reports terminated when SIGTERM clears the group within grace", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      const outcome = yield* terminateProcessGroup(provenIdentity("linux"), {
        signaller,
        graceMs: 1,
      });
      expect(outcome).toEqual({ status: "terminated" });
      expect(yield* Ref.get(calls)).toEqual(["SIGTERM"]);
    }),
  );

  it.live("escalates to SIGKILL when SIGTERM is ignored", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: false,
      });
      const outcome = yield* terminateProcessGroup(provenIdentity("linux"), {
        signaller,
        graceMs: 1,
      });
      expect(outcome).toEqual({ status: "escalated_kill" });
      expect(yield* Ref.get(calls)).toEqual(["SIGTERM", "SIGKILL"]);
    }),
  );

  it.live("reports termination_failed when the group survives both signals", () =>
    Effect.gen(function* () {
      const { signaller } = yield* fakeSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: true,
      });
      const outcome = yield* terminateProcessGroup(provenIdentity("linux"), {
        signaller,
        graceMs: 1,
      });
      expect(outcome.status).toBe("termination_failed");
    }),
  );
});

describe("terminateProcessGroup (real POSIX signaller)", () => {
  it.live("terminates a real detached process-group leader", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (!isGroupSignalingSupported(platform)) return;
      const child = NodeChildProcess.spawn("sleep", ["30"], {
        detached: true,
        stdio: "ignore",
      });
      const pid = child.pid;
      expect(pid).toBeGreaterThan(0);
      const spawnedAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const identity = makeProvenGroupIdentity({
        pid: pid as number,
        pgid: pid as number,
        spawnedAtMs,
        platform,
      });
      if (!identity.ok) throw new Error("expected proven identity for real child");

      // Confirm the group is alive before termination.
      expect(yield* posixProcessGroupSignaller.isGroupAlive(pid as number)).toBe(true);

      const outcome = yield* terminateProcessGroup(identity.identity, { graceMs: 2_000 });
      expect(["terminated", "escalated_kill", "already_dead"]).toContain(outcome.status);
      expect(yield* posixProcessGroupSignaller.isGroupAlive(pid as number)).toBe(false);
    }),
  );
});

describe("constants", () => {
  it("defaults the escalation grace to the spec value", () => {
    expect(DEFAULT_GROUP_TERM_GRACE_MS).toBe(10_000);
  });
});
