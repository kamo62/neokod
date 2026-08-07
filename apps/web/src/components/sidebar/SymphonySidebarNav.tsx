import { useCallback, type ComponentType } from "react";
import {
  ArrowLeftIcon,
  GitPullRequestIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  PlayCircleIcon,
  Settings2Icon,
  TagsIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import type { SymphonyOverview } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { symphonyEnvironment } from "../../state/symphony";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";

export type SymphonyNavPath =
  | "/symphony"
  | "/symphony/queue"
  | "/symphony/running"
  | "/symphony/reviews"
  | "/symphony/attention"
  | "/symphony/history"
  | "/symphony/trackers"
  | "/symphony/settings";

type SymphonyOverviewCountKey = "queued" | "running" | "needsAttention";
// Only the variants this nav actually uses — keeps the item table's type
// independent of Badge's full variant surface.
type BadgeVariant = "secondary" | "success" | "warning";

interface SymphonyNavItem {
  readonly label: string;
  readonly to: SymphonyNavPath;
  readonly icon: ComponentType<{ className?: string }>;
  readonly countKey?: SymphonyOverviewCountKey;
  readonly badgeVariant?: BadgeVariant;
}

// Paths match apps/web/src/routes/symphony.*.tsx exactly. "/symphony" (not
// "/symphony/") is the path this codebase already navigates to for the
// overview — see SidebarBrand's switchMode fallbackRoute in Sidebar.tsx.
const SYMPHONY_NAV_ITEMS: readonly SymphonyNavItem[] = [
  { label: "Overview", to: "/symphony", icon: LayoutDashboardIcon },
  { label: "Queue", to: "/symphony/queue", icon: ListTodoIcon, countKey: "queued" },
  {
    label: "Running",
    to: "/symphony/running",
    icon: PlayCircleIcon,
    countKey: "running",
    badgeVariant: "success",
  },
  { label: "Reviews", to: "/symphony/reviews", icon: GitPullRequestIcon },
  {
    label: "Attention",
    to: "/symphony/attention",
    icon: TriangleAlertIcon,
    countKey: "needsAttention",
    badgeVariant: "warning",
  },
  { label: "History", to: "/symphony/history", icon: HistoryIcon },
  { label: "Trackers", to: "/symphony/trackers", icon: TagsIcon },
  { label: "Settings", to: "/symphony/settings", icon: Settings2Icon },
];

// Mirrors the lifecycle set the orchestrator counts toward `overview.running`
// (apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts
// listByLifecycle(["preparing", "running", "waiting_for_approval"])), so the
// "Active runs" list below lines up with the Running row's badge count.
const ACTIVE_RUN_LIFECYCLES = new Set(["preparing", "running", "waiting_for_approval"]);
const MAX_ACTIVE_RUNS_SHOWN = 5;

function overviewCount(
  overview: SymphonyOverview | null,
  key: SymphonyOverviewCountKey | undefined,
): number | null {
  if (!overview || key === undefined) return null;
  const value = overview[key];
  return value > 0 ? value : null;
}

function ActiveRunsSkeleton() {
  const rows = ["one", "two"] as const;
  return (
    <div className="flex flex-col gap-1 px-2.5 py-1">
      {rows.map((row) => (
        <Skeleton key={row} className="h-4 w-4/5 rounded-full" />
      ))}
    </div>
  );
}

export function SymphonySidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = usePrimaryEnvironmentId();
  const overviewQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.overview({ environmentId, input: {} }),
  );
  // Same query (same environmentId + input) the Running view issues, so this
  // shares that atom's cache entry instead of triggering a second fetch.
  const runsQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.runs({ environmentId, input: {} }),
  );
  const overview = overviewQuery.data;
  const activeRuns = (runsQuery.data ?? []).filter((run) =>
    ACTIVE_RUN_LIFECYCLES.has(run.lifecycle),
  );
  const visibleActiveRuns = activeRuns.slice(0, MAX_ACTIVE_RUNS_SHOWN);
  const hiddenActiveRunCount = activeRuns.length - visibleActiveRuns.length;
  const activeRunsLoading =
    environmentId !== null && runsQuery.isPending && runsQuery.data === null;

  const finishNavigation = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const handleNavClick = useCallback(
    (to: SymphonyNavPath) => {
      finishNavigation();
      void navigate({ to });
    },
    [finishNavigation, navigate],
  );

  const handleRunClick = useCallback(
    (runAttemptId: string) => {
      finishNavigation();
      void navigate({ to: "/symphony/$runId", params: { runId: runAttemptId } });
    },
    [finishNavigation, navigate],
  );

  return (
    <SidebarContent className="overflow-x-hidden">
      <SidebarGroup className="px-2 pt-3 pb-0">
        <SidebarMenu>
          {/* Explicit way back: the brand menu also switches modes, but a
              visible row is the discoverable path (user report: symphony
              felt like a one-way door). */}
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
              onClick={() => {
                finishNavigation();
                void navigate({ to: "/" });
              }}
              aria-label="Back to Work mode"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Back to Work</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="px-2 py-3">
        <SidebarMenu>
          {SYMPHONY_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.to;
            const count = overviewCount(overview, item.countKey);
            const showCount = count !== null;
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  size="sm"
                  isActive={isActive}
                  className={
                    isActive
                      ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                      : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                  }
                  onClick={() => handleNavClick(item.to)}
                >
                  <Icon
                    className={
                      isActive
                        ? "size-4 shrink-0 text-foreground"
                        : "size-4 shrink-0 text-muted-foreground/60"
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {showCount ? (
                    <Badge
                      variant={item.badgeVariant ?? "secondary"}
                      size="sm"
                      className="shrink-0"
                    >
                      {count}
                    </Badge>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>

      {environmentId === null ? null : (
        <>
          <SidebarSeparator />
          <SidebarGroup className="px-2 py-3">
            <div className="px-2.5 pb-1.5 text-ui font-medium text-[var(--text-secondary)]">
              Active runs
            </div>
            {activeRunsLoading ? (
              <ActiveRunsSkeleton />
            ) : activeRuns.length === 0 ? (
              <div className="px-2.5 py-1 text-meta text-text-tertiary">
                Nothing running right now
              </div>
            ) : (
              <SidebarMenu>
                {visibleActiveRuns.map((run) => (
                  <SidebarMenuItem key={run.runAttemptId}>
                    <SidebarMenuButton
                      size="sm"
                      className="gap-2 px-2.5 py-1.5 text-left text-[13px] text-muted-foreground/80 hover:text-foreground/90"
                      onClick={() => handleRunClick(run.runAttemptId)}
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-success animate-status-pulse"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {run.issueTitle ?? run.workItemId}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                {hiddenActiveRunCount > 0 ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      size="sm"
                      className="px-2.5 py-1.5 text-left text-meta text-text-tertiary hover:text-foreground"
                      onClick={() => handleNavClick("/symphony/running")}
                    >
                      +{hiddenActiveRunCount} more running
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            )}
          </SidebarGroup>
        </>
      )}
    </SidebarContent>
  );
}
