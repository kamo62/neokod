import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { OrchestrationLatestTurn, OrchestrationSession, OrchestrationThreadShell, TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createActivityObservationState,
  activityOccurrenceKey,
  enqueueActivityOccurrences,
  flushNextActivityOccurrence,
  reduceEnvironmentActivityObservation,
  settleActivityOccurrence,
  type ActivityObservationState,
  type ActivityOccurrence,
  type EnvironmentActivityInput,
} from "./activityNotifications.logic";

const ENV_A = "environment-a" as never;
const ENV_B = "environment-b" as never;
const NOW = "2026-07-12T00:00:00.000Z";

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "thread-1" as never, projectId: "project-1" as never, title: "Thread",
    modelSelection: { instanceId: "codex" as never, model: "gpt-5" }, runtimeMode: "full-access", interactionMode: "default",
    branch: null, worktreePath: null, latestTurn: null, createdAt: NOW, updatedAt: NOW, archivedAt: null,
    session: null, latestUserMessageAt: null, hasPendingApprovals: false, hasPendingUserInput: false,
    hasActionableProposedPlan: false, ...overrides,
  } as OrchestrationThreadShell;
}

function terminal(overrides: Partial<TerminalSummary> = {}): TerminalSummary {
  return { threadId: "thread-1", terminalId: "terminal-1", cwd: "/repo", worktreePath: null, status: "running", pid: 1,
    exitCode: null, exitSignal: null, hasRunningSubprocess: false, label: "Terminal", updatedAt: NOW, ...overrides };
}

function input(environmentId: typeof ENV_A | typeof ENV_B, nowMs: number, overrides: Partial<EnvironmentActivityInput> = {}): EnvironmentActivityInput {
  return { environmentId, generation: 1, catalogReady: true, shellStatus: "live", threads: [thread()], terminals: [], notificationsEnabled: true, nowMs, ...overrides };
}

function observe(state: ActivityObservationState, value: EnvironmentActivityInput) { return reduceEnvironmentActivityObservation(state, value); }

function flush(state: ActivityObservationState, nowMs: number) {
  const delivered: ActivityOccurrence[] = [];
  let next = state;
  while (true) {
    const result = flushNextActivityOccurrence(next, nowMs);
    next = result.state;
    if (!result.occurrence) return { state: next, delivered };
    delivered.push(result.occurrence);
    next = settleActivityOccurrence(next, activityOccurrenceKey(result.occurrence), "delivered");
  }
}

describe("activity notifications occurrence reducer", () => {
  it("A-U01 baselines cached, synchronizing, and staggered environments", () => {
    let state = createActivityObservationState();
    let result = observe(state, input(ENV_A, 0, { shellStatus: "cached", threads: [thread({ latestTurn: completed("old") })] }));
    expect(result.occurrences).toEqual([]);
    result = observe(result.state, input(ENV_A, 1, { shellStatus: "synchronizing", threads: [thread({ latestTurn: completed("old") })] }));
    expect(result.occurrences).toEqual([]);
    result = observe(result.state, input(ENV_A, 2, { threads: [thread({ latestTurn: completed("old") })] }));
    expect(result.occurrences).toEqual([]);
    result = observe(result.state, input(ENV_B, 3, { shellStatus: "cached", threads: [thread({ latestTurn: failed("old") })] }));
    expect(observe(result.state, input(ENV_B, 4, { threads: [thread({ latestTurn: failed("old") })] })).occurrences).toEqual([]);
    result = observe(result.state, input(ENV_A, 5, { threads: [thread({ latestTurn: completed("new") })] }));
    expect(result.occurrences).toMatchObject([{ kind: "agent-completed", turnId: "new" }]);
  });

  it("A-U02 emits a coalesced-render completion once and settles repeat observation", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0, { threads: [thread({ latestTurn: completed("old") })] })).state;
    const result = observe(state, input(ENV_A, 1, { threads: [thread({ latestTurn: completed("turn-1") })] }));
    expect(result.occurrences).toMatchObject([{ kind: "agent-completed", reliability: "exact", turnId: "turn-1" }]);
    const settled = flush(result.state, 251).state;
    expect(observe(settled, input(ENV_A, 2, { threads: [thread({ latestTurn: completed("turn-1") })] })).occurrences).toEqual([]);
  });

  it("A-U03 settles after attention and A-U04 settles a same-generation active turn", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    const attention = observe(state, input(ENV_A, 1, { threads: [thread({ session: running("turn-1"), hasPendingApprovals: true })] }));
    expect(attention.occurrences).toMatchObject([{ kind: "approval-needed" }]);
    state = attention.state;
    let result = observe(state, input(ENV_A, 2, { threads: [thread({ latestTurn: completed("turn-1") })] }));
    expect(result.occurrences).toMatchObject([{ kind: "agent-completed", turnId: "turn-1" }]);
    expect(flush(result.state, 252).delivered).toMatchObject([{ kind: "approval-needed" }, { kind: "agent-completed" }]);
    state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ session: running("turn-2") })] })).state;
    result = observe(state, input(ENV_A, 2, { threads: [thread({ session: ready(null) })] }));
    expect(result.occurrences).toMatchObject([{ kind: "agent-completed", turnId: "turn-2" }]);
  });

  it("A-U05 keeps ready-at-birth, title-only, and ID-less transitions silent", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0, { threads: [thread({ session: ready(null) })] })).state;
    expect(observe(state, input(ENV_A, 1, { threads: [thread({ title: "Renamed", session: ready(null) })] })).occurrences).toEqual([]);
    state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ session: starting(null) })] })).state;
    expect(observe(state, input(ENV_A, 2, { threads: [thread({ session: ready(null) })] })).occurrences).toEqual([]);
  });

  it("is edge-triggered for ID-less failures", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    let result = observe(state, input(ENV_A, 1, { threads: [thread({ session: error(null) })] }));
    expect(result.occurrences).toMatchObject([{ kind: "agent-failed", reliability: "best-effort", ordinal: 1 }]);
    result = observe(result.state, input(ENV_A, 2, { threads: [thread({ session: error(null) })] }));
    expect(result.occurrences).toEqual([]);
  });

  it("consumes cached active turns that settle on their first live terminal snapshot", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0, { shellStatus: "cached", threads: [thread({ session: running("old") })] })).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ session: ready(null) })] })).state;
    expect(observe(state, input(ENV_A, 2, { threads: [thread({ session: ready(null) })] })).occurrences).toEqual([]);
    state = observe(createActivityObservationState(), input(ENV_A, 0, { shellStatus: "cached", threads: [thread({ session: running("old") })] })).state;
    const firstLive = observe(state, input(ENV_A, 1, { threads: [thread({ latestTurn: failed("old") })] }));
    expect(firstLive.occurrences).toEqual([]);
    expect(observe(firstLive.state, input(ENV_A, 2, { threads: [thread({ session: ready(null) })] })).occurrences).toEqual([]);
  });

  it("preserves a live completion across cached and synchronizing snapshots", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ session: running("turn-1") })] })).state;
    state = observe(state, input(ENV_A, 2, { shellStatus: "cached", threads: [thread({ latestTurn: completed("turn-1") })] })).state;
    state = observe(state, input(ENV_A, 3, { shellStatus: "synchronizing", threads: [thread({ latestTurn: completed("turn-1") })] })).state;
    expect(observe(state, input(ENV_A, 4, { threads: [thread({ latestTurn: completed("turn-1") })] })).occurrences)
      .toMatchObject([{ kind: "agent-completed", turnId: "turn-1" }]);
  });

  it("preserves a live failure across cached and synchronizing snapshots", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ session: running("turn-1") })] })).state;
    state = observe(state, input(ENV_A, 2, { shellStatus: "cached", threads: [thread({ latestTurn: failed("turn-1") })] })).state;
    state = observe(state, input(ENV_A, 3, { shellStatus: "synchronizing", threads: [thread({ latestTurn: failed("turn-1") })] })).state;
    expect(observe(state, input(ENV_A, 4, { threads: [thread({ latestTurn: failed("turn-1") })] })).occurrences)
      .toMatchObject([{ kind: "agent-failed", turnId: "turn-1" }]);
  });

  it("settles the original live completion when the replacement fails offline", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ session: running("turn-a") })] })).state;
    state = observe(state, input(ENV_A, 2, { shellStatus: "cached", threads: [thread({ session: ready(null), latestTurn: completed("turn-a") })] })).state;
    state = observe(state, input(ENV_A, 3, { shellStatus: "synchronizing", threads: [thread({ session: running("turn-b"), latestTurn: completed("turn-a") })] })).state;
    expect(observe(state, input(ENV_A, 4, { threads: [thread({ session: error("turn-b"), latestTurn: failed("turn-b") })] })).occurrences)
      .toMatchObject([{ kind: "agent-completed", turnId: "turn-a" }]);
  });

  it("settles the original live failure when the replacement completes offline", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ session: running("turn-a") })] })).state;
    state = observe(state, input(ENV_A, 2, { shellStatus: "cached", threads: [thread({ session: error(null), latestTurn: failed("turn-a") })] })).state;
    state = observe(state, input(ENV_A, 3, { shellStatus: "synchronizing", threads: [thread({ session: running("turn-b"), latestTurn: failed("turn-a") })] })).state;
    expect(observe(state, input(ENV_A, 4, { threads: [thread({ session: running("turn-b"), latestTurn: completed("turn-b") })] })).occurrences)
      .toMatchObject([{ kind: "agent-failed", turnId: "turn-a" }]);
  });

  it("uses a scope window so failure at t249 wins approval at t0", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 0, { threads: [thread({ hasPendingApprovals: true })] })).state;
    state = observe(state, input(ENV_A, 249, { threads: [thread({ hasPendingApprovals: true, session: error("turn-1") })] })).state;
    const first = flushNextActivityOccurrence(state, 250);
    expect(first.occurrence).toMatchObject({ kind: "agent-failed", reliability: "exact", turnId: "turn-1" });
    const settled = settleActivityOccurrence(first.state, activityOccurrenceKey(first.occurrence!), "delivered");
    expect(flush(settled, 250).delivered).toMatchObject([{ kind: "approval-needed", reliability: "best-effort" }]);
  });

  it("A-U07 retries the failed approval before delivering completion", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ hasPendingApprovals: true })] })).state;
    state = observe(state, input(ENV_A, 2, { threads: [thread({ hasPendingApprovals: true, latestTurn: completed("turn-1") })] })).state;
    const first = flushNextActivityOccurrence(state, 251);
    const failed = settleActivityOccurrence(first.state, activityOccurrenceKey(first.occurrence!), "failed");
    const retry = flushNextActivityOccurrence(failed, 251);
    expect(retry.occurrence).toMatchObject({ kind: "approval-needed" });
    const delivered = settleActivityOccurrence(retry.state, activityOccurrenceKey(retry.occurrence!), "delivered");
    expect(flush(delivered, 251).delivered).toMatchObject([{ kind: "agent-completed" }]);
  });

  it("retains attention ordinals through tombstone reappearance false then a fresh rise", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ hasPendingApprovals: true })] })).state;
    state = flush(state, 251).state;
    state = observe(state, input(ENV_A, 2, { threads: [] })).state;
    state = observe(state, input(ENV_A, 3, { threads: [thread()] })).state;
    const result = observe(state, input(ENV_A, 4, { threads: [thread({ hasPendingApprovals: true })] }));
    expect(result.occurrences).toMatchObject([{ kind: "approval-needed", reliability: "best-effort", ordinal: 2 }]);
  });

  it("A-U08 suppresses a pending-true tombstone reappearance", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ hasPendingApprovals: true })] })).state;
    state = observe(state, input(ENV_A, 2, { threads: [] })).state;
    expect(observe(state, input(ENV_A, 3, { threads: [thread({ hasPendingApprovals: true, updatedAt: "2026-07-12T00:00:03.000Z" })] })).occurrences).toEqual([]);
  });

  it("A-U09 baselines pending input on reconnect", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { generation: 2, threads: [thread({ hasPendingUserInput: true })] })).state;
    expect(observe(state, input(ENV_A, 2, { generation: 2, threads: [thread({ hasPendingUserInput: true })] })).occurrences).toEqual([]);
  });

  it("A-U10 consumes disabled queued and in-flight occurrences before re-enable", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ hasPendingApprovals: true })] })).state;
    const inFlight = flushNextActivityOccurrence(state, 251);
    state = observe(inFlight.state, input(ENV_A, 2, { notificationsEnabled: false, threads: [thread({ hasPendingApprovals: true })] })).state;
    expect(state.inFlightByKey.size).toBe(0);
    expect(state.queuedByScope.size).toBe(0);
    expect(state.deliveredKeys.size).toBe(1);
    state = observe(state, input(ENV_A, 3, { threads: [thread()] })).state;
    expect(observe(state, input(ENV_A, 4, { threads: [thread({ hasPendingApprovals: true })] })).occurrences).toMatchObject([{ kind: "approval-needed", ordinal: 2 }]);
  });

  it("uses raw latest-turn error despite pending input", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    const result = observe(state, input(ENV_A, 1, { threads: [thread({ latestTurn: failed("turn-1"), hasPendingUserInput: true })] }));
    expect(result.occurrences).toMatchObject([
      { kind: "agent-failed", reliability: "exact", turnId: "turn-1" },
      { kind: "input-needed", reliability: "best-effort", ordinal: 1 },
    ]);
  });

  it("treats interrupted turns with completedAt as exact completion and ignores timestamp-only changes", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    let result = observe(state, input(ENV_A, 1, { threads: [thread({ latestTurn: interrupted("turn-1", NOW) })] }));
    expect(result.occurrences).toMatchObject([{ kind: "agent-completed", reliability: "exact", turnId: "turn-1" }]);
    state = result.state;
    result = observe(state, input(ENV_A, 2, { threads: [thread({ latestTurn: interrupted("turn-1", "2026-07-12T00:00:02.000Z"), updatedAt: "2026-07-12T00:00:02.000Z" })] }));
    expect(result.occurrences).toEqual([]);
  });

  it("increments terminal episode only on a new running episode", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { terminals: [terminal({ hasRunningSubprocess: true })] })).state;
    const result = observe(state, input(ENV_A, 2, { terminals: [terminal({ hasRunningSubprocess: false })] }));
    expect(result.occurrences).toMatchObject([{ kind: "terminal-completed", reliability: "best-effort", ordinal: 1 }]);
  });

  it("A-U11 suppresses terminal completion on reconnect but emits a fresh edge", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { terminals: [terminal({ hasRunningSubprocess: true })] })).state;
    state = observe(state, input(ENV_A, 2, { generation: 2, terminals: [terminal({ hasRunningSubprocess: false })] })).state;
    const freshRunning = observe(state, input(ENV_A, 3, { generation: 2, terminals: [terminal({ hasRunningSubprocess: true })] }));
    expect(freshRunning.occurrences).toEqual([]);
    state = freshRunning.state;
    expect(observe(state, input(ENV_A, 4, { generation: 2, terminals: [terminal({ hasRunningSubprocess: false })] })).occurrences).toMatchObject([{ kind: "terminal-completed" }]);
  });

  it("baselines delayed initial terminal metadata and replacement snapshots", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0, { terminalMetadataReady: false })).state;
    state = observe(state, input(ENV_A, 1, {
      terminalMetadataReady: true,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).state;
    state = observe(state, input(ENV_A, 2, {
      terminals: [terminal({ hasRunningSubprocess: true })],
    })).state;
    expect(observe(state, input(ENV_A, 3, {
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).occurrences).toMatchObject([{ kind: "terminal-completed" }]);

    state = observe(state, input(ENV_A, 4, {
      generation: 2,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).state;
    expect(observe(state, input(ENV_A, 5, {
      generation: 2,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).occurrences).toEqual([]);
  });

  it("waits for replacement metadata, baselines it, then emits a fresh live edge", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0, {
      terminalMetadataEpoch: 1,
      terminals: [terminal({ hasRunningSubprocess: true })],
    })).state;
    state = observe(state, input(ENV_A, 1, {
      generation: 2,
      terminalMetadataEpoch: 1,
      terminals: [terminal({ hasRunningSubprocess: true })],
    })).state;
    const replacement = observe(state, input(ENV_A, 2, {
      generation: 2,
      terminalMetadataEpoch: 2,
      terminals: [terminal({ hasRunningSubprocess: false })],
    }));
    expect(replacement.occurrences).toEqual([]);
    state = replacement.state;
    state = observe(state, input(ENV_A, 3, {
      generation: 2,
      terminalMetadataEpoch: 2,
      terminals: [terminal({ hasRunningSubprocess: true })],
    })).state;
    expect(observe(state, input(ENV_A, 4, {
      generation: 2,
      terminalMetadataEpoch: 2,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).occurrences).toMatchObject([{ kind: "terminal-completed" }]);
  });

  it("baselines a delayed replacement after the prior epoch, then emits a fresh live edge", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0, {
      terminalMetadataEpoch: 1,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).state;
    state = observe(state, input(ENV_A, 1, {
      terminalMetadataEpoch: 2,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).state;
    state = observe(state, input(ENV_A, 2, {
      generation: 2,
      terminalMetadataEpoch: 2,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).state;
    const replacement = observe(state, input(ENV_A, 3, {
      generation: 2,
      terminalMetadataEpoch: 3,
      terminals: [terminal({ hasRunningSubprocess: true })],
    }));
    expect(replacement.occurrences).toEqual([]);
    state = observe(replacement.state, input(ENV_A, 4, {
      generation: 2,
      terminalMetadataEpoch: 3,
      terminals: [terminal({ hasRunningSubprocess: true })],
    })).state;
    expect(observe(state, input(ENV_A, 5, {
      generation: 2,
      terminalMetadataEpoch: 3,
      terminals: [terminal({ hasRunningSubprocess: false })],
    })).occurrences).toMatchObject([{ kind: "terminal-completed" }]);
  });

  it("A-U12 bounds delivered keys and tombstones, and scopes identical ids independently", () => {
    let state = createActivityObservationState();
    for (let index = 0; index < 513; index += 1) state = enqueueActivityOccurrences(state, [occurrence(ENV_A, `thread-${index}`, `turn-${index}`)]);
    state = flush(state, 250).state;
    expect(state.deliveredKeys.size).toBe(512);
    state = enqueueActivityOccurrences(state, [occurrence(ENV_A, "same-thread", "same-turn"), occurrence(ENV_B, "same-thread", "same-turn")]);
    expect(flush(state, 250).delivered).toHaveLength(2);
    expect(scopedThreadKey(scopeThreadRef(ENV_A, "same-thread" as never))).not.toBe(scopedThreadKey(scopeThreadRef(ENV_B, "same-thread" as never)));
    state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    for (let index = 0; index < 513; index += 1) {
      state = observe(state, input(ENV_A, index + 1, { threads: [thread({ id: `tombstone-${index}` as never })] })).state;
      state = observe(state, input(ENV_A, index + 1, { threads: [] })).state;
    }
    expect(state.tombstones.size).toBe(512);
  });

  it("withholds a scope while one of its occurrences is in flight", () => {
    let state = observe(createActivityObservationState(), input(ENV_A, 0)).state;
    state = observe(state, input(ENV_A, 1, { threads: [thread({ hasPendingApprovals: true, latestTurn: completed("turn-1") })] })).state;
    const first = flushNextActivityOccurrence(state, 251);
    expect(first.occurrence).toMatchObject({ kind: "approval-needed" });
    expect(flushNextActivityOccurrence(first.state, 251).occurrence).toBeNull();
  });
});

function session(status: OrchestrationSession["status"], activeTurnId: string | null): OrchestrationSession {
  return { threadId: "thread-1" as never, status, providerName: null, runtimeMode: "full-access", activeTurnId: activeTurnId as never, lastError: null, updatedAt: NOW };
}
function running(turnId: string | null) { return session("running", turnId); }
function ready(turnId: string | null) { return session("ready", turnId); }
function starting(turnId: string | null) { return session("starting", turnId); }
function error(turnId: string | null) { return session("error", turnId); }
function completed(turnId: string): OrchestrationLatestTurn { return { turnId: turnId as never, state: "completed", requestedAt: NOW, startedAt: NOW, completedAt: NOW, assistantMessageId: null }; }
function failed(turnId: string): OrchestrationLatestTurn { return { ...completed(turnId), state: "error", completedAt: null }; }
function interrupted(turnId: string, completedAt: string | null): OrchestrationLatestTurn { return { ...completed(turnId), state: "interrupted", completedAt }; }
function occurrence(environmentId: typeof ENV_A | typeof ENV_B, threadId: string, turnId: string) { return { kind: "agent-completed" as const, reliability: "exact" as const, environmentId, threadId, turnId, generation: 1, headline: "Agent finished", observedAt: 0 }; }
