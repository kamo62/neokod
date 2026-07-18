import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
} from "@neokod/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@neokod/client-runtime/state/shell";
import {
  deriveMissionControlRowView,
  groupMissionControlThreads,
  selectMissionControlDashboardGroups,
  selectMissionControlThreads,
} from "./MissionControl.logic";

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

describe("Mission Control helpers", () => {
  it("selects known activity threads, puts running work first, and applies the cap", () => {
    const projects = [project("project-a")];
    const selected = selectMissionControlThreads(
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

  it("excludes archived threads from Mission Control selections", () => {
    const selected = selectMissionControlThreads(
      [thread("active"), thread("archived", { archivedAt: "2026-07-10T12:00:00.000Z" })],
      [project("project-a")],
      5,
    );

    expect(selected.map((candidate) => candidate.id)).toEqual([ThreadId.make("active")]);
  });

  it("groups selected threads by project and orders sections by their most recent thread", () => {
    const projects = [project("project-a", "A"), project("project-b", "B")];
    const sections = groupMissionControlThreads(
      [
        thread("a-old", { updatedAt: "2026-07-10T09:00:00.000Z" }),
        thread("b-new", {
          projectId: ProjectId.make("project-b"),
          updatedAt: "2026-07-10T12:00:00.000Z",
        }),
        thread("a-new", { updatedAt: "2026-07-10T11:00:00.000Z" }),
      ],
      projects,
    );

    expect(sections.map((section) => section.project.title)).toEqual(["B", "A"]);
    expect(sections[1]?.threads.map((candidate) => candidate.id)).toEqual(["a-new", "a-old"]);
  });

  it("keeps running work first within a project even when idle work is newer", () => {
    const sections = groupMissionControlThreads(
      [
        thread("idle-new", { updatedAt: "2026-07-10T12:00:00.000Z" }),
        thread("running-old", {
          latestTurn: latestTurn("running"),
          updatedAt: "2026-07-10T09:00:00.000Z",
        }),
      ],
      [project("project-a")],
    );

    expect(sections[0]?.threads.map((candidate) => candidate.id)).toEqual([
      "running-old",
      "idle-new",
    ]);
  });

  it("derives a shell-only row view without workers or activity timestamps", () => {
    const row = deriveMissionControlRowView(
      thread("idle", {
        updatedAt: "2026-07-10T10:00:00.000Z",
        goal: "Ship demo",
        goalStatus: "done",
        worktreePath: "/tmp/demo",
      }),
      null,
    );

    expect(row).toMatchObject({
      isRunning: false,
      workerCount: 0,
      lastActivityAt: "2026-07-10T10:00:00.000Z",
      goalLabel: "Done: Ship demo",
      workspaceLabel: "/tmp/demo",
    });
  });

  it("derives live workers and last activity from running-thread activities", () => {
    const row = deriveMissionControlRowView(
      thread("running", {
        latestTurn: latestTurn("running"),
        updatedAt: "2026-07-10T10:00:00.000Z",
        branch: "demo",
      }),
      [
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "task.started",
          summary: "Worker started",
          createdAt: "2026-07-10T11:00:00.000Z",
          turnId: TurnId.make("turn-1"),
          sequence: 1,
          payload: { taskId: "worker" },
        },
      ] satisfies ReadonlyArray<OrchestrationThreadActivity>,
    );

    expect(row).toMatchObject({
      isRunning: true,
      workerCount: 1,
      lastActivityAt: "2026-07-10T11:00:00.000Z",
      workspaceLabel: "demo",
    });
  });

  it("uses the sidebar status contract to group dashboard threads without duplicates", () => {
    const groups = selectMissionControlDashboardGroups(
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

  it("excludes archived dashboard threads and caps recent results", () => {
    const groups = selectMissionControlDashboardGroups(
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
