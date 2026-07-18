import { scopeThreadRef } from "@neokod/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@neokod/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon, CircleIcon, LightbulbIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarInset } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useProjects, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  formatMissionControlRelativeTime,
  resolveMissionControlThreadStatusPill,
  selectMissionControlDashboardGroups,
} from "./MissionControl.logic";

const HOME_DASHBOARD_RECENT_CAP = 8;

function HomeDashboardThreadRow({
  thread,
  project,
  onOpen,
}: {
  thread: EnvironmentThreadShell;
  project: EnvironmentProject;
  onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const status = resolveMissionControlThreadStatusPill(thread);
  return (
    <button
      type="button"
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(thread)}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CircleIcon
            className={cn(
              "size-2 shrink-0 fill-current",
              status ? status.colorClass : "text-muted-foreground/50",
            )}
          />
          <span className="truncate">{thread.title}</span>
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {project.title}
          {thread.goal ? ` · ${thread.goal}` : ""}
        </span>
      </span>
      <span className="pt-0.5 text-xs text-muted-foreground">
        {formatMissionControlRelativeTime(thread.updatedAt)}
      </span>
    </button>
  );
}

function HomeDashboardGroup({
  title,
  icon,
  threads,
  projectsByKey,
  onOpen,
}: {
  title: string;
  icon: ReactNode;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  projectsByKey: ReadonlyMap<string, EnvironmentProject>;
  onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/75 bg-card shadow-xs">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/25 px-4 py-2.5 text-sm font-medium text-foreground">
        {icon}
        {title}
        <span className="text-xs font-normal text-muted-foreground">{threads.length}</span>
      </div>
      {threads.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground">Nothing here right now.</p>
      ) : (
        threads.flatMap((thread) => {
          const project = projectsByKey.get(`${thread.environmentId}:${thread.projectId}`);
          return project
            ? [
                <HomeDashboardThreadRow
                  key={`${thread.environmentId}:${thread.id}`}
                  thread={thread}
                  project={project}
                  onOpen={onOpen}
                />,
              ]
            : [];
        })
      )}
    </section>
  );
}

export function HomeDashboard() {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const groups = selectMissionControlDashboardGroups(threads, projects, HOME_DASHBOARD_RECENT_CAP);
  const projectsByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const openThread = (thread: EnvironmentThreadShell) => {
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-8 sm:py-12">
      <div className="mb-7">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Work across your projects, all in one place.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <HomeDashboardGroup
          title="Running"
          icon={<ActivityIcon className="size-4 text-emerald-600 dark:text-emerald-300" />}
          threads={groups.running}
          projectsByKey={projectsByKey}
          onOpen={openThread}
        />
        <HomeDashboardGroup
          title="Needs attention"
          icon={<TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-300" />}
          threads={groups.needsAttention}
          projectsByKey={projectsByKey}
          onOpen={openThread}
        />
        <HomeDashboardGroup
          title="Plan ready"
          icon={<LightbulbIcon className="size-4 text-violet-600 dark:text-violet-300" />}
          threads={groups.planReady}
          projectsByKey={projectsByKey}
          onOpen={openThread}
        />
        <HomeDashboardGroup
          title="Recent"
          icon={<ActivityIcon className="size-4 text-muted-foreground" />}
          threads={groups.recent}
          projectsByKey={projectsByKey}
          onOpen={openThread}
        />
      </div>
    </main>
  );
}

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[var(--workspace-native-controls-inset)]">
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <HomeDashboard />
      </div>
    </SidebarInset>
  );
}
