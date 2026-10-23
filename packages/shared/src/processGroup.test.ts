// @effect-diagnostics nodeBuiltinImport:off - focused POSIX test spawns a real
// detached process to exercise the group signaller.
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "./hostProcess.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as NodeChildProcess from "node:child_process";

import {
  captureTerminalOwnership,
  confirmOwnedProcessClosure,
  confirmOwnedTtyProcessGroup,
  DEFAULT_GROUP_TERM_GRACE_MS,
  discoverOwnedTtyProcessGroups,
  isGroupSignalingSupported,
  listControllingTtyProcessGroups,
  makeProvenGroupIdentity,
  parsePsPidPgidTty,
  planOrphanGroupTermination,
  posixProcessGroupSignaller,
  readProcessTable,
  selectControllingTtyProcessGroups,
  terminateProcessGroup,
  validateTerminalOwnership,
  type ProcessBirthReader,
  type ProcessGroupSignaller,
  type ProcessTableResult,
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
    const alive = yield* Ref.make(true);
    const signaller: ProcessGroupSignaller = {
      signalGroup: (_pgid, signal) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (prev) => [...prev, signal]);
          if (signal === "SIGTERM") {
            yield* Ref.set(alive, config.aliveAfterTerm);
            return config.termResult ?? "sent";
          }
          yield* Ref.set(alive, config.aliveAfterKill);
          return "sent";
        }),
      isGroupAlive: (_pgid) => Ref.get(alive),
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
      child.unref();
      const pid = child.pid;
      yield* Effect.gen(function* () {
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
      }).pipe(
        Effect.ensuring(
          typeof pid === "number"
            ? posixProcessGroupSignaller.signalGroup(pid, "SIGKILL").pipe(Effect.asVoid)
            : Effect.void,
        ),
      );
    }),
  );
});

describe("constants", () => {
  it("defaults the escalation grace to the spec value", () => {
    expect(DEFAULT_GROUP_TERM_GRACE_MS).toBe(10_000);
  });
});

describe("parsePsPidPgidTty", () => {
  it("skips malformed lines", () => {
    const rows = parsePsPidPgidTty("  100   100 ttys009\n  101   101 ??\nnot a row\n\n");
    expect(rows).toEqual([
      { pid: 100, pgid: 100, tty: "ttys009" },
      { pid: 101, pgid: 101, tty: "??" },
    ]);
  });
});

describe("selectControllingTtyProcessGroups", () => {
  const sharedTtyRows = [
    { pid: 100, pgid: 100, tty: "ttys009" },
    { pid: 101, pgid: 101, tty: "ttys009" },
    { pid: 103, pgid: 102, tty: "ttys009" },
    { pid: 200, pgid: 200, tty: "ttys010" },
    { pid: 300, pgid: 300, tty: "??" },
    { pid: 50, pgid: 50, tty: "ttys001" },
    { pid: 400, pgid: 50, tty: "ttys009" },
  ];

  it("returns every group on the shell's tty except the server's own group", () => {
    const groups = selectControllingTtyProcessGroups(sharedTtyRows, {
      rootPid: 100,
      ownPid: 50,
    });
    expect([...groups].sort((left, right) => left - right)).toEqual([100, 101, 102]);
  });

  it("fails closed when the root is absent or has no controlling tty", () => {
    expect(selectControllingTtyProcessGroups(sharedTtyRows, { rootPid: 999, ownPid: 50 })).toEqual(
      [],
    );
    expect(selectControllingTtyProcessGroups(sharedTtyRows, { rootPid: 300, ownPid: 50 })).toEqual(
      [],
    );
    expect(
      selectControllingTtyProcessGroups([{ pid: 1, pgid: 1, tty: "-" }], {
        rootPid: 1,
        ownPid: 50,
      }),
    ).toEqual([]);
  });
});

describe("listControllingTtyProcessGroups", () => {
  it.effect("does nothing on win32", () =>
    Effect.gen(function* () {
      expect(yield* listControllingTtyProcessGroups(1234, "win32")).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Terminal ownership revalidation
// ---------------------------------------------------------------------------

const tokenReader = (tokens: Readonly<Record<number, string>>): ProcessBirthReader => ({
  readBirthToken: (pid) => {
    const token = tokens[pid];
    return Effect.succeed(
      token === undefined
        ? ({ kind: "no_such_process" } as const)
        : ({ kind: "token", token } as const),
    );
  },
});

const table = (rows: ReadonlyArray<{ pid: number; pgid: number; tty: string }>) =>
  ({ kind: "rows", rows }) as const satisfies ProcessTableResult;

const terminalEvidence = (
  overrides: Partial<Parameters<typeof validateTerminalOwnership>[0]> = {},
) =>
  ({
    shellPid: 9000,
    shellBirthToken: "shell-born",
    controllingTty: "ttys900",
    capturedAtMs: 0,
    platform: "linux",
    ...overrides,
  }) as const;

describe("validateTerminalOwnership", () => {
  it.effect("rejects a recycled shell pid even when the tty name matches", () =>
    Effect.gen(function* () {
      const result = yield* validateTerminalOwnership(
        terminalEvidence(),
        table([{ pid: 9000, pgid: 9000, tty: "ttys900" }]),
        tokenReader({ 9000: "shell-born-later" }),
      );
      expect(result).toEqual({ status: "recycled" });
    }),
  );

  it.effect("rejects a recycled shell pid whose replacement controls another tty", () =>
    Effect.gen(function* () {
      const result = yield* validateTerminalOwnership(
        terminalEvidence(),
        table([{ pid: 9000, pgid: 9000, tty: "ttys901" }]),
        tokenReader({ 9000: "shell-born-later" }),
      );
      expect(result).toEqual({ status: "recycled" });
    }),
  );

  it.effect("rejects a same-process shell that now controls a different tty", () =>
    Effect.gen(function* () {
      const result = yield* validateTerminalOwnership(
        terminalEvidence(),
        table([{ pid: 9000, pgid: 9000, tty: "ttys901" }]),
        tokenReader({ 9000: "shell-born" }),
      );
      expect(result).toEqual({ status: "tty_mismatch", tty: "ttys901" });
    }),
  );

  it.effect("confirms the same process on the captured tty", () =>
    Effect.gen(function* () {
      const result = yield* validateTerminalOwnership(
        terminalEvidence(),
        table([{ pid: 9000, pgid: 9000, tty: "ttys900" }]),
        tokenReader({ 9000: "shell-born" }),
      );
      expect(result).toEqual({ status: "confirmed", tty: "ttys900" });
    }),
  );

  it.effect(
    "fails closed without a birth token, when the shell is gone, or when ps is missing",
    () =>
      Effect.gen(function* () {
        const noToken = yield* validateTerminalOwnership(
          terminalEvidence({ shellBirthToken: null }),
          table([{ pid: 9000, pgid: 9000, tty: "ttys900" }]),
          tokenReader({}),
        );
        expect(noToken).toEqual({ status: "unverifiable", reason: "no_birth_token" });

        const gone = yield* validateTerminalOwnership(
          terminalEvidence(),
          table([]),
          tokenReader({}),
        );
        expect(gone).toEqual({ status: "process_gone" });

        const missingPs = yield* validateTerminalOwnership(
          terminalEvidence(),
          { kind: "unavailable", detail: "ps_unavailable" },
          tokenReader({ 9000: "shell-born" }),
        );
        expect(missingPs).toEqual({ status: "unverifiable", reason: "table_unavailable" });
      }),
  );
});

describe("readProcessTable", () => {
  it.effect("reports unavailable instead of an empty table on win32", () =>
    Effect.gen(function* () {
      expect(yield* readProcessTable("win32")).toEqual({
        kind: "unavailable",
        detail: "unsupported_platform",
      });
    }),
  );
});

describe("captureTerminalOwnership", () => {
  it.effect("captures the birth token and tty without inventing missing evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* captureTerminalOwnership(
        { pid: 9000, platform: "linux", capturedAtMs: 5 },
        {
          birthReader: tokenReader({ 9000: "shell-born" }),
          ttyReader: { readTty: () => Effect.succeed({ kind: "tty", tty: "ttys900" }) },
        },
      );
      expect(evidence).toEqual({
        shellPid: 9000,
        shellBirthToken: "shell-born",
        controllingTty: "ttys900",
        capturedAtMs: 5,
        platform: "linux",
      });
    }),
  );

  it.effect("leaves unsupported platforms without evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* captureTerminalOwnership(
        { pid: 9000, platform: "win32", capturedAtMs: 5 },
        {
          birthReader: tokenReader({ 9000: "shell-born" }),
          ttyReader: { readTty: () => Effect.succeed({ kind: "tty", tty: "ttys900" }) },
        },
      );
      expect(evidence.shellBirthToken).toBeNull();
      expect(evidence.controllingTty).toBeNull();
    }),
  );
});

describe("discoverOwnedTtyProcessGroups / confirmOwnedTtyProcessGroup", () => {
  const rows = [
    { pid: 9000, pgid: 9000, tty: "ttys900" },
    { pid: 7002, pgid: 7001, tty: "ttys900" },
    { pid: 7003, pgid: 7001, tty: "ttys900" },
    { pid: 50, pgid: 50, tty: "ttys900" },
    { pid: 200, pgid: 200, tty: "ttys901" },
  ];

  it.effect("anchors discovered groups by member birth token and excludes the server group", () =>
    Effect.gen(function* () {
      const groups = yield* discoverOwnedTtyProcessGroups(
        { rows, tty: "ttys900", ownPid: 50 },
        tokenReader({ 9000: "shell-born", 7002: "group-born", 7003: "group-born-2" }),
        () => Effect.succeed(table(rows)),
      );
      expect(groups).toEqual([
        {
          pgid: 9000,
          tty: "ttys900",
          anchors: [{ pid: 9000, birthToken: "shell-born", tty: "ttys900" }],
        },
        {
          pgid: 7001,
          tty: "ttys900",
          anchors: [
            { pid: 7002, birthToken: "group-born", tty: "ttys900" },
            { pid: 7003, birthToken: "group-born-2", tty: "ttys900" },
          ],
        },
      ]);
    }),
  );

  it.effect("confirms while an anchor still matches and revokes once the group is replaced", () =>
    Effect.gen(function* () {
      const group = (yield* discoverOwnedTtyProcessGroups(
        { rows, tty: "ttys900", ownPid: 50 },
        tokenReader({ 9000: "shell-born", 7002: "group-born" }),
        () => Effect.succeed(table(rows)),
      )).find((candidate) => candidate.pgid === 7001);
      if (!group) throw new Error("expected background group");

      const confirmed = yield* confirmOwnedTtyProcessGroup(
        group,
        table(rows),
        tokenReader({ 7002: "group-born" }),
      );
      expect(confirmed).toEqual({ status: "confirmed" });

      const revoked = yield* confirmOwnedTtyProcessGroup(
        group,
        table(rows),
        tokenReader({ 7002: "replacement-born" }),
      );
      expect(revoked).toEqual({ status: "revoked", reason: "group_replaced" });

      const vanished = yield* confirmOwnedTtyProcessGroup(
        group,
        table(rows.filter((row) => row.pid !== 7002)),
        tokenReader({}),
      );
      expect(vanished).toEqual({ status: "revoked", reason: "group_replaced" });
    }),
  );

  it.effect("drops an anchor whose pid moved to another tty before capture", () =>
    Effect.gen(function* () {
      // The snapshot still shows 7002 in group 7001 on the terminal tty. By the
      // time its birth token is read, the original group is gone and the pid has
      // been recycled onto an unrelated tty, so the token belongs to the
      // replacement. A fresh membership read must reject that anchor.
      const groups = yield* discoverOwnedTtyProcessGroups(
        { rows, tty: "ttys900", ownPid: 50 },
        tokenReader({ 9000: "shell-born", 7002: "replacement-born" }),
        () =>
          Effect.succeed(
            table([
              { pid: 9000, pgid: 9000, tty: "ttys900" },
              { pid: 7002, pgid: 7001, tty: "ttys901" },
              { pid: 50, pgid: 50, tty: "ttys900" },
            ]),
          ),
      );
      expect(groups.map((group) => group.pgid)).toEqual([9000]);
    }),
  );

  it.effect("fails closed when fresh membership cannot be read", () =>
    Effect.gen(function* () {
      const groups = yield* discoverOwnedTtyProcessGroups(
        { rows, tty: "ttys900", ownPid: 50 },
        tokenReader({ 9000: "shell-born", 7002: "group-born" }),
        () => Effect.succeed({ kind: "unavailable", detail: "ps_unavailable" }),
      );
      expect(groups).toEqual([]);
    }),
  );

  it.effect("revokes a matching anchor that now controls another tty", () =>
    Effect.gen(function* () {
      // Even if an anchor was captured for the replacement, the pre-signal
      // check must reject a fresh row that no longer belongs to the terminal.
      const check = yield* confirmOwnedTtyProcessGroup(
        {
          pgid: 7001,
          tty: "ttys900",
          anchors: [{ pid: 7002, birthToken: "replacement-born", tty: "ttys900" }],
        },
        table([{ pid: 7002, pgid: 7001, tty: "ttys901" }]),
        tokenReader({ 7002: "replacement-born" }),
      );
      expect(check).toEqual({ status: "revoked", reason: "member_recycled" });
    }),
  );
});

describe("terminateProcessGroup ownership guard", () => {
  it.live("stops before SIGTERM when ownership is already revoked", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      const outcome = yield* terminateProcessGroup(provenIdentity("linux"), {
        signaller,
        graceMs: 1,
        confirmOwnership: () =>
          Effect.succeed({ status: "revoked", reason: "group_replaced" } as const),
      });
      expect(outcome).toEqual({ status: "ownership_revoked", detail: "group_replaced" });
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  );

  it.live("does not escalate to SIGKILL when ownership is revoked after SIGTERM", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: false,
      });
      const checks = yield* Ref.make(0);
      const outcome = yield* terminateProcessGroup(provenIdentity("linux"), {
        signaller,
        graceMs: 1,
        confirmOwnership: () =>
          Ref.modify(checks, (count) => [
            count === 0
              ? ({ status: "confirmed" } as const)
              : ({ status: "revoked", reason: "member_recycled" } as const),
            count + 1,
          ]),
      });
      expect(outcome).toEqual({ status: "ownership_revoked", detail: "member_recycled" });
      expect(yield* Ref.get(calls)).toEqual(["SIGTERM"]);
    }),
  );

  it.live("escalates normally when ownership stays confirmed", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: false,
      });
      const outcome = yield* terminateProcessGroup(provenIdentity("linux"), {
        signaller,
        graceMs: 1,
        confirmOwnership: () => Effect.succeed({ status: "confirmed" } as const),
      });
      expect(outcome).toEqual({ status: "escalated_kill" });
      expect(yield* Ref.get(calls)).toEqual(["SIGTERM", "SIGKILL"]);
    }),
  );
});

describe("confirmOwnedProcessClosure", () => {
  const identity = {
    ownerPid: 9001,
    ownerPgid: 9001,
    ownerBirthToken: "born-9001",
    ownPid: 50,
    spawnedAtMs: 0,
  } as const;

  it.effect("reports closed when the claim never recorded an owner process", () =>
    Effect.gen(function* () {
      expect(
        yield* confirmOwnedProcessClosure({ ownerPid: null, ownPid: 50 }, { platform: "linux" }),
      ).toEqual({ status: "closed", evidence: "no_owner_recorded" });
    }),
  );

  it.effect("never signals a bare persisted pid", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      const result = yield* confirmOwnedProcessClosure(
        { ...identity, ownerPgid: null, ownerBirthToken: null },
        { signaller, reader: tokenReader({ 9001: "born-9001" }), platform: "linux", graceMs: 1 },
      );
      expect(result).toEqual({ status: "held", reason: "unproven_group_identity" });
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  );

  it.effect("never signals a recycled pid whose birth token differs", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      const result = yield* confirmOwnedProcessClosure(identity, {
        signaller,
        reader: tokenReader({ 9001: "replacement-born" }),
        platform: "linux",
        graceMs: 1,
      });
      expect(result).toEqual({ status: "held", reason: "pid_recycled" });
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  );

  it.effect("never signals the server's own pid or an unverifiable platform", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      expect(
        yield* confirmOwnedProcessClosure(
          { ...identity, ownerPid: 50, ownerPgid: 50 },
          { signaller, reader: tokenReader({ 50: "born-9001" }), platform: "linux", graceMs: 1 },
        ),
      ).toEqual({ status: "held", reason: "owner_is_server" });
      expect(
        yield* confirmOwnedProcessClosure(identity, {
          signaller,
          reader: tokenReader({ 9001: "born-9001" }),
          platform: "win32",
        }),
      ).toEqual({ status: "held", reason: "unsupported_platform" });
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  );

  it.live("confirms closure only after the owned group exits", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      const result = yield* confirmOwnedProcessClosure(identity, {
        signaller,
        reader: tokenReader({ 9001: "born-9001" }),
        platform: "linux",
        graceMs: 1,
      });
      expect(result).toEqual({ status: "closed", evidence: "group_terminated" });
      expect(yield* Ref.get(calls)).toEqual(["SIGTERM"]);
    }),
  );

  it.live("preserves uncertainty when the leader exits but the group survives", () =>
    Effect.gen(function* () {
      // SIGTERM kills the leader (so the pre-KILL birth check can no longer
      // confirm identity) while a descendant keeps the group alive. That is
      // not closure: the escalation must be refused and the claim held.
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: false,
      });
      // Alive for the pre-signal checks; gone once the grace window closes.
      const reads = yield* Ref.make(0);
      const leaderDiesAfterTerm: ProcessBirthReader = {
        readBirthToken: () =>
          Ref.modify(reads, (count) => [
            count < 2
              ? ({ kind: "token", token: "born-9001" } as const)
              : ({ kind: "no_such_process" } as const),
            count + 1,
          ]),
      };
      const result = yield* confirmOwnedProcessClosure(identity, {
        signaller,
        reader: leaderDiesAfterTerm,
        platform: "linux",
        graceMs: 1,
      });
      expect(result).toEqual({
        status: "held",
        reason: "ownership_revoked",
        detail: "group_missing",
      });
      expect(yield* Ref.get(calls)).toEqual(["SIGTERM"]);
    }),
  );

  it.effect("holds a live descendant group whose leader is already gone", () =>
    Effect.gen(function* () {
      const signalGroup = () => Effect.succeed("no_such_group" as const);
      const aliveSignaller: ProcessGroupSignaller = {
        signalGroup,
        isGroupAlive: () => Effect.succeed(true),
      };
      expect(
        yield* confirmOwnedProcessClosure(identity, {
          signaller: aliveSignaller,
          reader: tokenReader({}), // leader gone, group still has members
          platform: "linux",
        }),
      ).toEqual({ status: "held", reason: "leader_gone_descendants_unconfirmed" });
    }),
  );

  it.effect("confirms closure when both leader and group are gone", () =>
    Effect.gen(function* () {
      const goneSignaller: ProcessGroupSignaller = {
        signalGroup: () => Effect.succeed("no_such_group"),
        isGroupAlive: () => Effect.succeed(false),
      };
      expect(
        yield* confirmOwnedProcessClosure(identity, {
          signaller: goneSignaller,
          reader: tokenReader({}),
          platform: "linux",
        }),
      ).toEqual({ status: "closed", evidence: "leader_and_group_gone" });
    }),
  );

  it.live("holds when the group survives TERM and KILL", () =>
    Effect.gen(function* () {
      const { signaller, calls } = yield* fakeSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: true,
      });
      const result = yield* confirmOwnedProcessClosure(identity, {
        signaller,
        reader: tokenReader({ 9001: "born-9001" }),
        platform: "linux",
        graceMs: 1,
      });
      expect(result.status).toBe("held");
      if (result.status === "held") expect(result.reason).toBe("termination_failed");
      expect(yield* Ref.get(calls)).toEqual(["SIGTERM", "SIGKILL"]);
    }),
  );
});
