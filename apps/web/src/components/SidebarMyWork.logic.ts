import type { EnvironmentThreadShell } from "@neokod/client-runtime/state/shell";

import type { MissionControlDashboardGroups } from "./MissionControl.logic";
import { resolveThreadStatusPill } from "./Sidebar.logic";

export type MyWorkGroupKey = "running" | "needsAttention" | "recent";

export type MyWorkGroups = Pick<MissionControlDashboardGroups, MyWorkGroupKey>;

export function computeThreadSignature(thread: EnvironmentThreadShell): string {
  const status = resolveThreadStatusPill({ thread })?.label ?? "";
  return [
    thread.latestTurn?.turnId ?? "",
    thread.latestTurn?.state ?? "",
    status,
    thread.hasPendingApprovals ? "1" : "0",
    thread.hasPendingUserInput ? "1" : "0",
    thread.session?.status ?? "",
    thread.updatedAt,
  ].join("\u001f");
}

export function resolveVisibleMyWork(
  dashboardGroups: MissionControlDashboardGroups,
  dismissedSignatures: Readonly<Record<string, string>>,
): MyWorkGroups {
  const visible = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
    threads.filter(
      (thread) =>
        dismissedSignatures[`${thread.environmentId}:${thread.id}`] !==
        computeThreadSignature(thread),
    );

  return {
    running: visible(dashboardGroups.running),
    needsAttention: visible(dashboardGroups.needsAttention),
    recent: visible(dashboardGroups.recent),
  };
}

export function countMyWorkThreads(groups: MyWorkGroups): number {
  return groups.running.length + groups.needsAttention.length + groups.recent.length;
}
