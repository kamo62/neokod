import { scopeThreadRef } from "@neokod/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@neokod/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "~/lib/utils";
import { selectMissionControlDashboardGroups } from "./MissionControl.logic";
import {
  computeThreadSignature,
  countMyWorkThreads,
  resolveVisibleMyWork,
  type MyWorkGroupKey,
} from "./SidebarMyWork.logic";
import { resolveThreadStatusPill } from "./Sidebar.logic";

const MY_WORK_RECENT_CAP = 8;

const GROUPS: ReadonlyArray<{ key: MyWorkGroupKey; title: string }> = [
  { key: "running", title: "Active" },
  { key: "needsAttention", title: "Needs you" },
  { key: "recent", title: "Recent" },
];

function MyWorkRow({
  thread,
  projectName,
  needsAttention,
  onOpen,
  onDismiss,
}: {
  thread: EnvironmentThreadShell;
  projectName: string;
  needsAttention: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const status = resolveThreadStatusPill({ thread });
  const done = status?.label === "Completed" || status === null;
  return (
    <div className="group/my-work-row relative">
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 pr-7 text-left text-ui text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onOpen}
      >
        {done ? (
          <CheckIcon
            className="mt-0.5 size-3 shrink-0 text-muted-foreground/45"
            aria-label="Done"
          />
        ) : (
          <span
            aria-label={status?.label}
            className={cn(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              needsAttention ? "bg-amber-500 dark:bg-amber-300/90" : status?.dotClass,
              status?.pulse && "animate-pulse",
            )}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{thread.title}</span>
          {projectName ? (
            <span className="block truncate text-meta text-muted-foreground/65">{projectName}</span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${thread.title} from My Work`}
        className="pointer-events-none absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover/my-work-row:pointer-events-auto group-hover/my-work-row:opacity-100 group-focus-within/my-work-row:pointer-events-auto group-focus-within/my-work-row:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

export function SidebarMyWork({
  projects,
  threads,
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const navigate = useNavigate();
  const collapsed = useUiStateStore((state) => state.myWorkCollapsed);
  const dismissed = useUiStateStore((state) => state.myWorkDismissed);
  const lastDismissed = useUiStateStore((state) => state.myWorkLastDismissed);
  const toggleCollapsed = useUiStateStore((state) => state.toggleMyWorkCollapsed);
  const dismissThread = useUiStateStore((state) => state.dismissMyWorkThread);
  const dismissThreads = useUiStateStore((state) => state.dismissMyWorkThreads);
  const undoDismiss = useUiStateStore((state) => state.undoMyWorkDismissal);
  const [now, setNow] = useState(Date.now);
  const dashboardGroups = useMemo(
    () => selectMissionControlDashboardGroups(threads, projects, MY_WORK_RECENT_CAP),
    [projects, threads],
  );
  const groups = useMemo(
    () => resolveVisibleMyWork(dashboardGroups, dismissed),
    [dashboardGroups, dismissed],
  );
  const count = countMyWorkThreads(groups);
  const projectNames = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );

  useEffect(() => {
    if (!lastDismissed) return;
    const remaining = Math.max(0, 5000 - (Date.now() - lastDismissed.dismissedAt));
    setNow(Date.now());
    const timeout = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timeout);
  }, [lastDismissed?.dismissedAt]);

  const undoVisible = lastDismissed !== null && now - lastDismissed.dismissedAt < 5000;

  const openThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    },
    [navigate],
  );

  return (
    <section className="mb-2 border-b border-border/55 pb-2" aria-label="My Work">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-ui font-medium text-[var(--text-secondary)] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", !collapsed && "rotate-90")}
        />
        <span>My Work</span>
        <span className="text-meta font-normal text-muted-foreground">{count}</span>
      </button>
      {collapsed ? null : (
        <div className="mt-1 space-y-1">
          {GROUPS.map(({ key, title }) => {
            const group = groups[key];
            if (group.length === 0) return null;
            return (
              <div key={key} className="group/my-work-group">
                <div className="flex h-5 items-center justify-between px-2 text-meta font-medium uppercase tracking-wide text-muted-foreground/75">
                  <span>{title}</span>
                  <button
                    type="button"
                    className="opacity-0 transition-opacity hover:text-foreground group-hover/my-work-group:opacity-100 group-focus-within/my-work-group:opacity-100"
                    onClick={() =>
                      dismissThreads(
                        Object.fromEntries(
                          group.map((thread) => [
                            `${thread.environmentId}:${thread.id}`,
                            computeThreadSignature(thread),
                          ]),
                        ),
                      )
                    }
                  >
                    Clear
                  </button>
                </div>
                {group.map((thread) => (
                  <MyWorkRow
                    key={`${thread.environmentId}:${thread.id}`}
                    thread={thread}
                    projectName={
                      projectNames.get(`${thread.environmentId}:${thread.projectId}`) ?? ""
                    }
                    needsAttention={key === "needsAttention"}
                    onOpen={() => openThread(thread)}
                    onDismiss={() =>
                      dismissThread(
                        `${thread.environmentId}:${thread.id}`,
                        computeThreadSignature(thread),
                      )
                    }
                  />
                ))}
              </div>
            );
          })}
          {undoVisible && lastDismissed ? (
            <button
              type="button"
              className="ml-2 text-meta text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                undoDismiss();
                setNow(0);
              }}
            >
              Undo dismiss
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
