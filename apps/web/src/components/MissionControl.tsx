import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationThreadActivity, ScopedThreadRef } from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon, BotIcon, CircleIcon, GitBranchIcon } from "lucide-react";

import { deriveSubagentCards } from "../session-logic";
import { useProjects, useThreadActivities, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { useMissionControlUiStore } from "../missionControlUiStore";
import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const MISSION_CONTROL_THREAD_CAP = 20;

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

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function MissionControlThreadRowView(props: {
  thread: EnvironmentThreadShell;
  project: EnvironmentProject;
  row: MissionControlRowView;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const statusLabel = props.row.isRunning ? "running" : "idle";
  const workerLabel = props.row.workerCount > 0 ? `, ${props.row.workerCount} workers` : "";
  return (
    <button
      type="button"
      aria-label={`${props.thread.title}, ${statusLabel}${workerLabel}, ${props.project.title}`}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => props.onOpen(threadRef)}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CircleIcon
            className={cn(
              "size-2 shrink-0 fill-current",
              props.row.isRunning ? "text-emerald-500" : "text-muted-foreground/50",
            )}
          />
          <span className="truncate">{props.thread.title}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{props.project.title}</span>
          <span>{props.thread.modelSelection.model}</span>
          {props.row.goalLabel ? <span className="truncate">{props.row.goalLabel}</span> : null}
          {props.row.workspaceLabel ? (
            <span className="inline-flex items-center gap-1 truncate">
              <GitBranchIcon className="size-3" />
              {props.row.workspaceLabel}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        {props.row.workerCount > 0 ? (
          <span
            className="inline-flex items-center gap-1"
            title={`${props.row.workerCount} active workers`}
          >
            <BotIcon className="size-3" />
            {props.row.workerCount}
          </span>
        ) : null}
        <span>{relativeTime(props.row.lastActivityAt)}</span>
      </div>
    </button>
  );
}

function MissionControlRunningThreadRow(props: {
  thread: EnvironmentThreadShell;
  project: EnvironmentProject;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  const activities = useThreadActivities(
    scopeThreadRef(props.thread.environmentId, props.thread.id),
  );
  return (
    <MissionControlThreadRowView
      {...props}
      row={deriveMissionControlRowView(props.thread, activities)}
    />
  );
}

function MissionControlThreadRow(props: {
  thread: EnvironmentThreadShell;
  project: EnvironmentProject;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  if (props.thread.latestTurn?.state === "running") {
    return <MissionControlRunningThreadRow {...props} />;
  }
  return (
    <MissionControlThreadRowView {...props} row={deriveMissionControlRowView(props.thread, null)} />
  );
}

function MissionControlContent(props: { onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const eligibleThreads = selectMissionControlThreads(threads, projects, Infinity);
  const visibleThreads = selectMissionControlThreads(threads, projects, MISSION_CONTROL_THREAD_CAP);
  const sections = groupMissionControlThreads(visibleThreads, projects);
  const openThread = (threadRef: ScopedThreadRef) => {
    props.onOpenChange(false);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };

  return (
    <DialogPopup className="max-w-4xl overflow-hidden" bottomStickOnMobile={false}>
      <DialogHeader className="border-b border-border/70 bg-muted/20">
        <DialogTitle className="flex items-center gap-2">
          <ActivityIcon className="size-5" />
          Mission Control
        </DialogTitle>
        <DialogDescription>Agent activity across your projects.</DialogDescription>
      </DialogHeader>
      <DialogPanel scrollFade={false} className="max-h-[70vh] p-0">
        {visibleThreads.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-muted-foreground">
            No agent activity yet
            <span className="mt-1 block text-xs">Start a thread to see work here.</span>
          </div>
        ) : (
          <>
            {sections.map((section) => (
              <section key={section.key}>
                <div className="border-b border-border/60 bg-muted/25 px-4 py-2 text-xs font-medium text-muted-foreground">
                  {section.project.title}
                </div>
                {section.threads.map((thread) => (
                  <MissionControlThreadRow
                    key={`${thread.environmentId}:${thread.id}`}
                    thread={thread}
                    project={section.project}
                    onOpen={openThread}
                  />
                ))}
              </section>
            ))}
            {eligibleThreads.length > visibleThreads.length ? (
              <div className="border-t border-border/60 px-4 py-3 text-center text-xs text-muted-foreground">
                Showing 20 threads, running work first
              </div>
            ) : null}
          </>
        )}
      </DialogPanel>
    </DialogPopup>
  );
}

export function MissionControlHost() {
  const open = useMissionControlUiStore((state) => state.open);
  const setOpen = useMissionControlUiStore((state) => state.setOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? <MissionControlContent onOpenChange={setOpen} /> : null}
    </Dialog>
  );
}
