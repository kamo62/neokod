import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@neokod/client-runtime/state/shell";

import {
  deriveSidebarThreadLifecycle,
  resolveThreadStatusPill as resolveSidebarThreadStatusPill,
  type ThreadStatusPill,
} from "./Sidebar.logic";

export interface DashboardGroups {
  readonly running: ReadonlyArray<EnvironmentThreadShell>;
  readonly needsAttention: ReadonlyArray<EnvironmentThreadShell>;
  readonly planReady: ReadonlyArray<EnvironmentThreadShell>;
  readonly recent: ReadonlyArray<EnvironmentThreadShell>;
}

function compareThreads(left: EnvironmentThreadShell, right: EnvironmentThreadShell): number {
  return (
    Number(right.latestTurn?.state === "running") - Number(left.latestTurn?.state === "running") ||
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

export function selectDashboardThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  cap: number,
): EnvironmentThreadShell[] {
  const projectKeys = new Set(projects.map((project) => `${project.environmentId}:${project.id}`));
  return threads
    .filter(
      (thread) =>
        (thread.latestTurn !== null || thread.latestUserMessageAt !== null) &&
        thread.archivedAt === null &&
        projectKeys.has(`${thread.environmentId}:${thread.projectId}`),
    )
    .toSorted(compareThreads)
    .slice(0, cap);
}

/** Resolves a single thread's status pill, wrapping Sidebar.logic's object-argument form. */
export function resolveThreadStatusPill(thread: EnvironmentThreadShell): ThreadStatusPill | null {
  return resolveSidebarThreadStatusPill({ thread });
}

export function selectDashboardGroups(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  recentCap: number,
): DashboardGroups {
  const eligible = selectDashboardThreads(threads, projects, Infinity);
  const running: EnvironmentThreadShell[] = [];
  const needsAttention: EnvironmentThreadShell[] = [];
  const planReady: EnvironmentThreadShell[] = [];
  const recent: EnvironmentThreadShell[] = [];

  for (const thread of eligible) {
    const lifecycle = deriveSidebarThreadLifecycle(thread);
    if (lifecycle.phase === "working" || lifecycle.phase === "connecting") {
      running.push(thread);
    } else if (
      lifecycle.phase === "awaiting" ||
      (lifecycle.phase === "terminal" && lifecycle.outcome === "failed")
    ) {
      needsAttention.push(thread);
    } else if (lifecycle.phase === "plan-ready") {
      planReady.push(thread);
    } else if (recent.length < recentCap) {
      recent.push(thread);
    }
  }

  return { running, needsAttention, planReady, recent };
}

export function formatRelativeTime(value: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
