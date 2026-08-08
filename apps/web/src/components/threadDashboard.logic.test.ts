import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
} from "@neokod/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@neokod/client-runtime/state/shell";
import {
  formatRelativeTime,
  selectDashboardGroups,
  selectDashboardThreads,
} from "./threadDashboard.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");

function latestTurn(
  state: OrchestrationLatestTurn["state"] = "completed",
): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: "2026-07-10T09:00:00.000Z",
    startedAt: "2026-07-10T09:00:00.000Z",
    completedAt: state === "running" ? null : "2026-07-10T10:00:00.000Z",
    assistantMessageId: null,
  };
}

function session(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-07-10T10:00:00.000Z",
  };
}

function project(id: string, title = id): EnvironmentProject {
  return {
    id: ProjectId.make(id),
    environmentId: localEnvironmentId,
    title,
    workspaceRoot: `/workspace/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
  };
}

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-a"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    updatedAt: "2026-07-10T10:00:00.000Z",
    latestTurn: latestTurn(),
    goal: null,
    goalStatus: undefined,
    branch: null,
    worktreePath: null,
    createdAt: "2026-07-10T10:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("thread dashboard helpers", () => {
  it("selects known activity threads, puts running work first, and applies the cap", () => {
    const projects = [project("project-a")];
    const selected = selectDashboardThreads(
      [
        thread("idle-new", { updatedAt: "2026-07-10T12:00:00.000Z" }),
        thread("running-old", {
          latestTurn: latestTurn("running"),
          updatedAt: "2026-07-10T09:00:00.000Z",
        }),
        thread("running-new", {
          latestTurn: latestTurn("running"),
          updatedAt: "2026-07-10T11:00:00.000Z",
        }),
        thread("no-turn", { latestTurn: null }),
      ],
      projects,
      2,
    );

    expect(selected.map((candidate) => candidate.id)).toEqual(["running-new", "running-old"]);
  });

  it("excludes archived threads from dashboard selections", () => {
    const selected = selectDashboardThreads(
      [thread("active"), thread("archived", { archivedAt: "2026-07-10T12:00:00.000Z" })],
      [project("project-a")],
      5,
    );

    expect(selected.map((candidate) => candidate.id)).toEqual([ThreadId.make("active")]);
  });

  it("keeps settled threads with user activity after their active turn is cleared", () => {
    const selected = selectDashboardThreads(
      [
        thread("settled", {
          latestTurn: null,
          latestUserMessageAt: "2026-07-10T10:00:00.000Z",
        }),
        thread("empty-draft", { latestTurn: null }),
      ],
      [project("project-a")],
      5,
    );

    expect(selected.map((candidate) => candidate.id)).toEqual([ThreadId.make("settled")]);
  });

  it("uses the sidebar status contract to group dashboard threads without duplicates", () => {
    const groups = selectDashboardGroups(
      [
        thread("running", { session: session("running") }),
        thread("approval", { hasPendingApprovals: true }),
        thread("plan", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: {
            ...latestTurn(),
            startedAt: "2026-07-10T09:00:00.000Z",
            completedAt: "2026-07-10T10:00:00.000Z",
          },
          session: session("ready"),
        }),
        thread("recent"),
      ],
      [project("project-a")],
      5,
    );

    expect(groups.running.map((candidate) => candidate.id)).toEqual(["running"]);
    expect(groups.needsAttention.map((candidate) => candidate.id)).toEqual(["approval"]);
    expect(groups.planReady.map((candidate) => candidate.id)).toEqual(["plan"]);
    expect(groups.recent.map((candidate) => candidate.id)).toEqual(["recent"]);
  });

  it("groups from semantic lifecycle rather than sidebar presentation labels", () => {
    const groups = selectDashboardGroups(
      [
        thread("turn-only-running", { latestTurn: latestTurn("running"), session: null }),
        thread("failed", { latestTurn: latestTurn("error"), session: session("error") }),
      ],
      [project("project-a")],
      5,
    );

    expect(groups.running.map((candidate) => candidate.id)).toEqual(["turn-only-running"]);
    expect(groups.needsAttention.map((candidate) => candidate.id)).toEqual(["failed"]);
    expect(groups.recent).toEqual([]);
  });

  it("excludes archived dashboard threads and caps recent results", () => {
    const groups = selectDashboardGroups(
      [
        thread("archived", {
          archivedAt: "2026-07-10T12:00:00.000Z",
          updatedAt: "2026-07-10T14:00:00.000Z",
        }),
        thread("recent-new", { updatedAt: "2026-07-10T13:00:00.000Z" }),
        thread("recent-middle", { updatedAt: "2026-07-10T12:00:00.000Z" }),
        thread("recent-old", { updatedAt: "2026-07-10T11:00:00.000Z" }),
      ],
      [project("project-a")],
      2,
    );

    expect(groups.recent.map((candidate) => candidate.id)).toEqual([
      ThreadId.make("recent-new"),
      ThreadId.make("recent-middle"),
    ]);
  });
});

describe("formatRelativeTime", () => {
  it("uses the supplied clock rather than ambient time", () => {
    const value = "2026-07-10T10:00:00.000Z";

    expect(formatRelativeTime(value, Date.parse("2026-07-10T10:00:30.000Z"))).toBe("now");
    expect(formatRelativeTime(value, Date.parse("2026-07-10T10:05:00.000Z"))).toBe("5m");
    expect(formatRelativeTime(value, Date.parse("2026-07-10T12:00:00.000Z"))).toBe("2h");
  });
});
