import { describe, expect, it } from "vite-plus/test";
import {
  deriveMissionControlRowView,
  groupMissionControlThreads,
  selectMissionControlDashboardGroups,
  selectMissionControlThreads,
} from "./MissionControl.logic";

const project = (id: string, title = id) => ({ id, environmentId: "local", title }) as any;

const thread = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    environmentId: "local",
    projectId: "project-a",
    title: id,
    modelSelection: { model: "gpt-5" },
    updatedAt: "2026-07-10T10:00:00.000Z",
    latestTurn: { state: "completed" },
    goal: null,
    goalStatus: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  }) as any;

describe("Mission Control helpers", () => {
  it("selects known activity threads, puts running work first, and applies the cap", () => {
    const projects = [project("project-a")];
    const selected = selectMissionControlThreads(
      [
        thread("idle-new", { updatedAt: "2026-07-10T12:00:00.000Z" }),
        thread("running-old", {
          latestTurn: { state: "running" },
          updatedAt: "2026-07-10T09:00:00.000Z",
        }),
        thread("running-new", {
          latestTurn: { state: "running" },
          updatedAt: "2026-07-10T11:00:00.000Z",
        }),
        thread("no-turn", { latestTurn: null }),
      ],
      projects,
      2,
    );

    expect(selected.map((candidate) => candidate.id)).toEqual(["running-new", "running-old"]);
  });

  it("groups selected threads by project and orders sections by their most recent thread", () => {
    const projects = [project("project-a", "A"), project("project-b", "B")];
    const sections = groupMissionControlThreads(
      [
        thread("a-old", { updatedAt: "2026-07-10T09:00:00.000Z" }),
        thread("b-new", {
          projectId: "project-b",
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
          latestTurn: { state: "running" },
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
        latestTurn: { state: "running" },
        updatedAt: "2026-07-10T10:00:00.000Z",
        branch: "demo",
      }),
      [
        {
          kind: "task.started",
          createdAt: "2026-07-10T11:00:00.000Z",
          sequence: 1,
          payload: { taskId: "worker" },
        },
      ] as any,
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
        thread("running", { session: { status: "running" } }),
        thread("approval", { hasPendingApprovals: true }),
        thread("plan", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: {
            state: "completed",
            startedAt: "2026-07-10T09:00:00.000Z",
            completedAt: "2026-07-10T10:00:00.000Z",
          },
          session: { status: "ready", activeTurnId: null },
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
});
