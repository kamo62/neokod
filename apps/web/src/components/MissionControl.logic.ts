import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@neokod/client-runtime/state/shell";
import type { OrchestrationThreadActivity } from "@neokod/contracts";

import { deriveSubagentCards } from "../session-logic";
import { resolveThreadStatusPill } from "./Sidebar.logic";

export interface MissionControlRowView {
  readonly workerCount: number;
  readonly isRunning: boolean;
  readonly lastActivityAt: string;
  readonly goalLabel: string | null;
  readonly workspaceLabel: string | null;
}

export interface MissionControlSection {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

export interface MissionControlDashboardGroups {
  readonly running: ReadonlyArray<EnvironmentThreadShell>;
  readonly needsAttention: ReadonlyArray<EnvironmentThreadShell>;
  readonly planReady: ReadonlyArray<EnvironmentThreadShell>;
  readonly recent: ReadonlyArray<EnvironmentThreadShell>;
}

function compareMissionControlThreads(
  left: EnvironmentThreadShell,
  right: EnvironmentThreadShell,
): number {
  return (
    Number(right.latestTurn?.state === "running") - Number(left.latestTurn?.state === "running") ||
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

export function selectMissionControlThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  cap: number,
): EnvironmentThreadShell[] {
  const projectKeys = new Set(projects.map((project) => `${project.environmentId}:${project.id}`));
  return threads
    .filter(
      (thread) =>
        thread.latestTurn !== null &&
        projectKeys.has(`${thread.environmentId}:${thread.projectId}`),
    )
    .toSorted(compareMissionControlThreads)
    .slice(0, cap);
}

export function groupMissionControlThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
): MissionControlSection[] {
  const projectsByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const threadsByProjectKey = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const projectKey = `${thread.environmentId}:${thread.projectId}`;
    if (!projectsByKey.has(projectKey)) continue;
    const group = threadsByProjectKey.get(projectKey) ?? [];
    group.push(thread);
    threadsByProjectKey.set(projectKey, group);
  }

  return [...threadsByProjectKey.entries()]
    .map(([key, group]) => ({
      key,
      project: projectsByKey.get(key)!,
      threads: group.toSorted(compareMissionControlThreads),
    }))
    .toSorted((left, right) =>
      right.threads[0]!.updatedAt.localeCompare(left.threads[0]!.updatedAt),
    );
}

export function selectMissionControlDashboardGroups(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  recentCap: number,
): MissionControlDashboardGroups {
  const eligible = selectMissionControlThreads(threads, projects, Infinity);
  const running: EnvironmentThreadShell[] = [];
  const needsAttention: EnvironmentThreadShell[] = [];
  const planReady: EnvironmentThreadShell[] = [];
  const recent: EnvironmentThreadShell[] = [];

  for (const thread of eligible) {
    const status = resolveThreadStatusPill({ thread })?.label;
    if (status === "Working" || status === "Connecting") {
      running.push(thread);
    } else if (status === "Pending Approval" || status === "Awaiting Input") {
      needsAttention.push(thread);
    } else if (status === "Plan Ready") {
      planReady.push(thread);
    } else if (recent.length < recentCap) {
      recent.push(thread);
    }
  }

  return { running, needsAttention, planReady, recent };
}

export function deriveMissionControlRowView(
  thread: EnvironmentThreadShell,
  activities: ReadonlyArray<OrchestrationThreadActivity> | null,
): MissionControlRowView {
  const workers = activities === null ? [] : deriveSubagentCards(activities);
  return {
    workerCount: workers.filter((worker) => worker.status === "inProgress").length,
    isRunning: thread.latestTurn?.state === "running",
    lastActivityAt:
      activities?.reduce(
        (latest, activity) => (activity.createdAt > latest ? activity.createdAt : latest),
        thread.updatedAt,
      ) ?? thread.updatedAt,
    goalLabel: thread.goal
      ? `${thread.goalStatus === "done" ? "Done" : "Goal"}: ${thread.goal}`
      : null,
    workspaceLabel: thread.branch ?? thread.worktreePath,
  };
}

export function formatMissionControlRelativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
