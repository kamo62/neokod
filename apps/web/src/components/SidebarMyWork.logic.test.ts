import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
} from "@neokod/contracts";
import type { EnvironmentThreadShell } from "@neokod/client-runtime/state/shell";

import {
  computeThreadSignature,
  countMyWorkThreads,
  resolveVisibleMyWork,
} from "./SidebarMyWork.logic";

const environmentId = EnvironmentId.make("environment-local");

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project-a"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    updatedAt: "2026-07-19T10:00:00.000Z",
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: "2026-07-19T09:00:00.000Z",
      startedAt: "2026-07-19T09:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    goal: null,
    goalStatus: undefined,
    branch: null,
    worktreePath: null,
    createdAt: "2026-07-19T09:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function groups(input: EnvironmentThreadShell) {
  return { running: [input], needsAttention: [], planReady: [], recent: [] };
}

describe("My Work visibility", () => {
  it("hides a dismissed thread while its signature is unchanged", () => {
    const working = thread("thread-1");
    const visible = resolveVisibleMyWork(groups(working), {
      [`${working.environmentId}:${working.id}`]: computeThreadSignature(working),
    });

    expect(visible.running).toEqual([]);
    expect(countMyWorkThreads(visible)).toBe(0);
  });

  it("keeps a dismissed running thread hidden while activity streams", () => {
    const working = thread("thread-1");
    const dismissed = {
      [`${working.environmentId}:${working.id}`]: computeThreadSignature(working),
    };
    const streamedActivity = thread("thread-1", { updatedAt: "2026-07-19T10:02:00.000Z" });

    expect(resolveVisibleMyWork(groups(streamedActivity), dismissed).running).toEqual([]);
  });

  it("restores a dismissed thread after meaningful transitions", () => {
    const working = thread("thread-1");
    const dismissed = {
      [`${working.environmentId}:${working.id}`]: computeThreadSignature(working),
    };
    const completedTurn: OrchestrationLatestTurn = {
      ...working.latestTurn!,
      state: "completed",
      completedAt: "2026-07-19T10:01:00.000Z",
    };
    const completed = thread("thread-1", {
      latestTurn: completedTurn,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    const needsInput = thread("thread-1", { hasPendingUserInput: true });
    const newTurn = thread("thread-1", {
      latestTurn: { ...working.latestTurn!, turnId: TurnId.make("turn-2") },
    });

    expect(
      resolveVisibleMyWork(
        { running: [], needsAttention: [], planReady: [], recent: [completed] },
        dismissed,
      ).recent,
    ).toEqual([completed]);
    expect(
      resolveVisibleMyWork(
        { running: [], needsAttention: [needsInput], planReady: [], recent: [] },
        dismissed,
      ).needsAttention,
    ).toEqual([needsInput]);
    expect(resolveVisibleMyWork(groups(newTurn), dismissed).running).toEqual([newTurn]);
  });

  it("puts plan-ready work in Needs you", () => {
    const planReady = thread("thread-1", {
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestTurn: { ...thread("thread-1").latestTurn!, state: "completed" },
    });

    expect(
      resolveVisibleMyWork(
        { running: [], needsAttention: [], planReady: [planReady], recent: [] },
        {},
      ).needsAttention,
    ).toEqual([planReady]);
  });

  it("filters every entry cleared from a group", () => {
    const first = thread("thread-1");
    const second = thread("thread-2");
    const visible = resolveVisibleMyWork(
      { running: [first, second], needsAttention: [], planReady: [], recent: [] },
      {
        [`${first.environmentId}:${first.id}`]: computeThreadSignature(first),
        [`${second.environmentId}:${second.id}`]: computeThreadSignature(second),
      },
    );

    expect(visible.running).toEqual([]);
  });
});
