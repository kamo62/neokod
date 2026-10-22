import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type {
  RunSummary,
  SymphonyBoardCard,
  SymphonyProject,
  SymphonyProjectBoard,
  SymphonyProjectId,
} from "@neokod/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  GitBranchIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom } from "../../state/server";
import { symphonyEnvironment } from "../../state/symphony";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { SymphonyAttentionList } from "./SymphonyAttentionList";
import { SymphonyEmptyState } from "./SymphonyEmptyState";
import { canRunNow, formatEligibilityReason, runActionLabel } from "./boardCard.logic";
import { dispatchRefusalMessage } from "./dispatchRefusal.logic";
import { runAttemptStatusBadgeVariant } from "./SymphonyRunningView.logic";
import {
  availableSymphonyImplementationProviders,
  availableSymphonyReviewProviders,
  defaultSymphonyProjectConfiguration,
  isSymphonyProjectConfigurationComplete,
  SymphonyProjectConfigurationForm,
} from "./SymphonyProjectConfigurationForm";
import {
  applySavedDraft,
  beginEditDraft,
  editDraft,
  endEditDraft,
  isDraftDirty,
  reconcileDraft,
  startDraft,
} from "./projectSettingsDraft";
import { useProjectSettingsDraftStore } from "./projectSettingsDraftStore";
import { filterRuns, type RunFilter } from "./symphonyRuns.logic";
import { PROJECT_TABS, type ProjectTab } from "./symphonyProjectTabs";

const TAB_LABELS: Readonly<Record<ProjectTab, string>> = {
  board: "Board",
  runs: "Runs",
  attention: "Attention",
  settings: "Settings",
};

const TABS: ReadonlyArray<{ value: ProjectTab; label: string }> = PROJECT_TABS.map((value) => ({
  value,
  label: TAB_LABELS[value],
}));

const trackerScope = (project: SymphonyProject): string => {
  const tracker = project.configuration?.tracker;
  if (!tracker) return "Needs setup";
  switch (tracker.kind) {
    case "github":
      return `GitHub Issues · ${tracker.repository}`;
    case "jira":
      return `Jira · ${tracker.projectKey}`;
    case "linear":
      return `Linear · ${tracker.projectSlug}`;
    case "gitlab":
      return `GitLab Issues · ${tracker.projectPath}`;
    case "asana":
      return `Asana · ${tracker.projectGid}`;
    case "azure_boards":
      return `Azure Boards · ${tracker.organization ? `${tracker.organization}/` : ""}${tracker.project}`;
    case "github_projects":
      return `GitHub Projects · ${tracker.owner} #${tracker.number}`;
  }
};

function BoardTab({
  board,
  onRefresh,
}: {
  readonly board: SymphonyProjectBoard;
  readonly onRefresh: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const dispatchWorkItem = useAtomCommand(symphonyEnvironment.dispatchWorkItem);
  const [dispatching, setDispatching] = useState<SymphonyBoardCard["workItemId"] | null>(null);
  const [refusals, setRefusals] = useState<Record<string, string>>({});

  const dispatch = async (workItemId: SymphonyBoardCard["workItemId"]) => {
    if (environmentId === null) return;
    setDispatching(workItemId);
    try {
      const result = await dispatchWorkItem({ environmentId, input: { workItemId } });
      if (result._tag === "Success" && result.value.status === "refused") {
        const refusal = result.value;
        setRefusals((current) => ({
          ...current,
          [workItemId]: dispatchRefusalMessage(refusal),
        }));
      } else if (result._tag === "Success") {
        setRefusals((current) => {
          if (!(workItemId in current)) return current;
          const next = { ...current };
          delete next[workItemId];
          return next;
        });
      } else {
        setRefusals((current) => ({
          ...current,
          [workItemId]: "The request failed. Try again.",
        }));
      }
      onRefresh();
    } finally {
      setDispatching(null);
    }
  };

  const doneShown = board.columns.find((column) => column.id === "done")?.cards.length ?? 0;
  const cardCount = (column: SymphonyProjectBoard["columns"][number]) =>
    column.totalCount ?? column.cards.length;

  return (
    <div>
      {board.truncated ? (
        <p className="px-6 pt-4 text-xs text-muted-foreground sm:px-8">
          Some items are hidden. Done shows the newest {doneShown} finished items.
        </p>
      ) : null}
      <div className="grid min-h-full min-w-[70rem] grid-cols-5 gap-4 p-6 sm:p-8">
        {board.columns.map((column) => (
          <section key={column.id} className="min-w-0">
            <div className="mb-3 flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold">{column.title}</h2>
              <Badge variant="secondary">{cardCount(column)}</Badge>
            </div>
            <div className="space-y-3 rounded-2xl bg-muted/35 p-2 min-h-28">
              {column.cards.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">No work</p>
              ) : (
                column.cards.map((card) => (
                  <article
                    key={card.workItemId}
                    className="rounded-xl border bg-card p-3 shadow-xs/5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug">{card.title}</p>
                      {card.outcome ? (
                        card.outcome === "completed" ? (
                          <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                        ) : (
                          <CircleDotIcon className="size-4 shrink-0 text-muted-foreground" />
                        )
                      ) : null}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {card.trackerIdentifier ? (
                        <Badge variant="outline">{card.trackerIdentifier}</Badge>
                      ) : null}
                      <Badge
                        variant={
                          card.lifecycle === "validation_failed" || card.lifecycle === "failed"
                            ? "error"
                            : "secondary"
                        }
                      >
                        {card.lifecycle.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    {canRunNow(card) ? (
                      <>
                        <Button
                          size="sm"
                          className="mt-3 w-full"
                          disabled={environmentId === null || dispatching !== null}
                          onClick={() => void dispatch(card.workItemId)}
                        >
                          {dispatching === card.workItemId ? (
                            <Spinner className="size-3.5" />
                          ) : null}
                          {refusals[card.workItemId] === undefined
                            ? runActionLabel(card.lifecycle)
                            : "Try again"}
                        </Button>
                        {refusals[card.workItemId] === undefined ? null : (
                          <p role="status" className="mt-2 text-xs text-destructive-foreground">
                            {refusals[card.workItemId]}
                          </p>
                        )}
                      </>
                    ) : null}
                    {card.lifecycle === "ineligible" ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Not eligible:{" "}
                        {(card.eligibilityReasons ?? []).map(formatEligibilityReason).join("; ")}
                      </p>
                    ) : null}
                    {card.latestRunAttemptId === undefined ? null : (
                      <Link
                        to="/symphony/$runId"
                        params={{ runId: card.latestRunAttemptId }}
                        className="mt-2 inline-block text-xs text-muted-foreground underline"
                      >
                        Open run
                      </Link>
                    )}
                  </article>
                ))
              )}
            </div>
            {column.totalCount !== undefined && column.totalCount > column.cards.length ? (
              <p className="px-2 pb-2 text-center text-xs text-muted-foreground">
                Showing {column.cards.length} of {column.totalCount}
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function SettingsTab({
  project,
  environmentId,
  onSaved,
}: {
  readonly project: SymphonyProject;
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly onSaved: () => void;
}) {
  const allProviders = useAtomValue(primaryServerProvidersAtom);
  const providers = availableSymphonyImplementationProviders(allProviders);
  const reviewProviders = availableSymphonyReviewProviders(allProviders);
  const fallback = providers[0] ?? null;
  const storedDraft = useProjectSettingsDraftStore((state) => state.drafts[project.id]);
  const setDraft = useProjectSettingsDraftStore((state) => state.setDraft);
  const clearDraft = useProjectSettingsDraftStore((state) => state.clearDraft);
  const fallbackConfig = fallback ? defaultSymphonyProjectConfiguration(fallback) : null;
  const reconciled = storedDraft ? reconcileDraft(storedDraft, project, fallbackConfig) : null;
  const draft = reconciled?.draft ?? startDraft(project, fallbackConfig);
  const sync = reconciled?.sync ?? "clean";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateProject = useAtomCommand(symphonyEnvironment.updateProject, {
    reportFailure: false,
  });

  const save = async (expectedRevision: number) => {
    if (
      draft === null ||
      !isSymphonyProjectConfigurationComplete(draft.value, providers, reviewProviders)
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateProject({
        environmentId,
        input: {
          projectId: project.id,
          expectedRevision,
          configuration: draft.value,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : "Could not save project settings.");
        }
        return;
      }
      const saved = applySavedDraft(
        useProjectSettingsDraftStore.getState().drafts[project.id],
        result.value,
      );
      if (saved !== null) {
        setDraft(project.id, saved);
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const beginBufferedEdit = () => {
    if (draft === null || draft.editing) return;
    setDraft(project.id, beginEditDraft(draft));
  };

  const discardBufferedEdit = () => {
    if (draft === null || !draft.editing) return;
    setDraft(project.id, endEditDraft(draft));
  };

  if (draft === null) {
    return (
      <SymphonyEmptyState
        icon={TriangleAlertIcon}
        title="No supported execution provider"
        description="Symphony execution currently requires an enabled Codex provider."
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
      <div>
        <h2 className="text-base font-semibold">Project settings</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Tracker scope and runtime policy belong to this Symphony project. Repository credentials
          stay global.
        </p>
      </div>
      {sync === "changed_elsewhere" ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
          <p>These settings changed elsewhere after you started editing.</p>
          <p className="mt-1 text-muted-foreground">
            Reload to use the server copy and discard your edits, or save your edits to overwrite
            it.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setError(null);
                clearDraft(project.id);
              }}
            >
              Reload
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save(project.revision)}>
              Save my edits
            </Button>
          </div>
        </div>
      ) : null}
      <SymphonyProjectConfigurationForm
        value={draft.value}
        providers={providers}
        reviewProviders={reviewProviders}
        onChange={(value) => setDraft(project.id, editDraft(draft, value))}
        onBeginEdit={beginBufferedEdit}
        onDiscardEdit={discardBufferedEdit}
      />
      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void save(draft.baseRevision)}
          disabled={
            saving ||
            sync === "changed_elsewhere" ||
            !isSymphonyProjectConfigurationComplete(draft.value, providers, reviewProviders)
          }
        >
          {saving ? <Spinner className="size-3.5" /> : null}Save settings
        </Button>
      </div>
    </div>
  );
}

export function SymphonyProjectView({
  projectId,
  tab,
  onTabChange,
}: {
  readonly projectId: SymphonyProjectId;
  readonly tab: ProjectTab;
  readonly onTabChange: (tab: ProjectTab) => void;
}) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const [action, setAction] = useState<"start" | "pause" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const settingsDraft = useProjectSettingsDraftStore((state) => state.drafts[projectId]);
  const settingsDraftDirty = settingsDraft !== undefined && isDraftDirty(settingsDraft);
  const boardQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyEnvironment.projectBoard({
          environmentId,
          input: { projectId },
        }),
  );
  const runsQuery = useEnvironmentQuery(
    environmentId === null || tab !== "runs"
      ? null
      : symphonyEnvironment.runs({ environmentId, input: { projectId } }),
  );
  const attentionQuery = useEnvironmentQuery(
    environmentId === null || tab !== "attention"
      ? null
      : symphonyEnvironment.attention({ environmentId, input: { projectId } }),
  );
  const startProject = useAtomCommand(symphonyEnvironment.startProject, {
    reportFailure: false,
  });
  const pauseProject = useAtomCommand(symphonyEnvironment.pauseProject, {
    reportFailure: false,
  });
  const board = boardQuery.data;

  if (boardQuery.isPending && board === null) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    );
  }
  if (board === null) {
    return (
      <SymphonyEmptyState
        icon={TriangleAlertIcon}
        title="Project unavailable"
        description={boardQuery.error ?? "This Symphony project was not found."}
        action={
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/symphony" })}>
            Back to projects
          </Button>
        }
      />
    );
  }
  const project = board.project;

  const setProjectStatus = async (next: "start" | "pause") => {
    if (environmentId === null) return;
    setAction(next);
    setActionError(null);
    try {
      const command = next === "start" ? startProject : pauseProject;
      const result = await command({
        environmentId,
        input: { projectId: project.id, expectedRevision: project.revision },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setActionError(cause instanceof Error ? cause.message : `Could not ${next} the project.`);
        }
        return;
      }
      boardQuery.refresh();
    } finally {
      setAction(null);
    }
  };

  const sourceControl =
    board.sourceControl.state === "known"
      ? `${board.sourceControl.provider ?? board.sourceControl.vcsKind}${board.sourceControl.remoteUrl ? ` · ${board.sourceControl.remoteUrl}` : ""}`
      : board.sourceControl.state === "none"
        ? "No remote"
        : "Unavailable";
  const deliveryNeedsRemote =
    project.configuration?.autonomy === "deliver" &&
    (board.sourceControl.state !== "known" || board.sourceControl.provider === null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b px-6 pt-5 sm:px-8">
        <div className="flex items-start justify-between gap-4 pb-4">
          <div className="min-w-0">
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2 mb-2"
              onClick={() => void navigate({ to: "/symphony" })}
            >
              <ArrowLeftIcon className="size-3.5" />
              Projects
            </Button>
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold">{project.title}</h1>
              <Badge variant={project.status === "active" ? "success" : "secondary"}>
                {project.status}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Tracker: {trackerScope(project)}</Badge>
              <Badge variant="outline">
                <GitBranchIcon className="size-3" />
                Source control: {sourceControl}
              </Badge>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={boardQuery.refresh}>
              <RefreshCwIcon className="size-3.5" />
              Refresh
            </Button>
            {project.status === "active" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void setProjectStatus("pause")}
                disabled={action !== null}
              >
                {action === "pause" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <PauseIcon className="size-3.5" />
                )}
                Pause
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void setProjectStatus("start")}
                disabled={action !== null || project.setupState !== "ready" || deliveryNeedsRemote}
                title={
                  deliveryNeedsRemote
                    ? "Deliver mode requires a recognised source-control remote"
                    : undefined
                }
              >
                {action === "start" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
                Start
              </Button>
            )}
          </div>
        </div>
        {actionError ? (
          <p className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
            {actionError}
          </p>
        ) : null}
        {boardQuery.error !== null ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
            <p>
              Live updates stopped. Showing the board from{" "}
              {new Date(board.generatedAt).toLocaleTimeString()}. {boardQuery.error}
            </p>
            <Button size="sm" variant="outline" onClick={boardQuery.refresh}>
              Retry
            </Button>
          </div>
        ) : null}
        <nav className="flex gap-1 overflow-x-auto" aria-label="Project sections">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={
                tab === item.value
                  ? "border-b-2 border-foreground px-3 py-2 text-sm font-medium"
                  : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              }
              onClick={() => onTabChange(item.value)}
            >
              {item.label}
              {item.value === "settings" && settingsDraftDirty ? " •" : null}
            </button>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {tab === "board" ? <BoardTab board={board} onRefresh={boardQuery.refresh} /> : null}
        {tab === "settings" && environmentId !== null ? (
          <SettingsTab
            key={project.id}
            project={project}
            environmentId={environmentId}
            onSaved={boardQuery.refresh}
          />
        ) : null}
        {tab === "runs" ? (
          <RunsTab
            runs={runsQuery.data ?? []}
            loading={runsQuery.isPending}
            error={runsQuery.error}
          />
        ) : null}
        {tab === "attention" && environmentId !== null ? (
          <ListFrame
            title="Attention"
            loading={attentionQuery.isPending}
            error={attentionQuery.error}
            isEmpty={(attentionQuery.data ?? []).length === 0}
          >
            <SymphonyAttentionList
              items={attentionQuery.data ?? []}
              environmentId={environmentId}
              onChanged={attentionQuery.refresh}
            />
          </ListFrame>
        ) : null}
      </main>
    </div>
  );
}

function ListFrame({
  title,
  loading,
  error,
  isEmpty,
  children,
}: {
  readonly title: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly isEmpty: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 sm:p-8">
      <h2 className="text-base font-semibold">{title}</h2>
      {loading && isEmpty ? (
        <Skeleton className="h-32 rounded-2xl" />
      ) : error && isEmpty ? (
        <SymphonyEmptyState
          icon={TriangleAlertIcon}
          title={`${title} unavailable`}
          description={error}
        />
      ) : isEmpty ? (
        <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Nothing here yet.
        </p>
      ) : (
        children
      )}
    </div>
  );
}

const RUN_FILTERS: ReadonlyArray<{ readonly value: RunFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "finished", label: "Finished" },
];

function RunsTab({
  runs,
  loading,
  error,
}: {
  readonly runs: ReadonlyArray<RunSummary>;
  readonly loading: boolean;
  readonly error: string | null;
}) {
  const [filter, setFilter] = useState<RunFilter>("all");
  const visible = filterRuns(runs, filter);
  return (
    <SimpleList
      title="Runs"
      loading={loading}
      error={error}
      isEmpty={runs.length === 0}
      toolbar={
        <div className="flex gap-1">
          {RUN_FILTERS.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={filter === item.value ? "secondary" : "ghost"}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      }
      rows={visible.map((run) => ({
        id: run.runAttemptId,
        title: run.issueTitle ?? run.workItemId,
        detail: `${run.status.replaceAll("_", " ")} · item ${run.lifecycle.replaceAll("_", " ")} · attempt ${run.attemptNumber}`,
        to: { runId: run.runAttemptId },
        badge: {
          label: run.status.replaceAll("_", " "),
          variant: runAttemptStatusBadgeVariant(run.status),
        },
      }))}
    />
  );
}

function SimpleList({
  title,
  loading,
  error,
  rows,
  toolbar,
  isEmpty,
}: {
  readonly title: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly isEmpty?: boolean;
  readonly rows: ReadonlyArray<{
    id: string;
    title: string;
    detail: string;
    to?: { runId: string };
    badge?: { label: string; variant: "error" | "info" | "secondary" | "success" };
  }>;
  readonly toolbar?: ReactNode;
}) {
  return (
    <ListFrame title={title} loading={loading} error={error} isEmpty={isEmpty ?? rows.length === 0}>
      {toolbar}
      <div className="divide-y rounded-2xl border bg-card">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No runs match this filter.
          </p>
        ) : null}
        {rows.map((row) => {
          const body = (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{row.title}</p>
                {row.badge === undefined ? null : (
                  <Badge variant={row.badge.variant} size="sm">
                    {row.badge.label}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
            </>
          );
          return row.to === undefined ? (
            <div key={row.id} className="px-4 py-3">
              {body}
            </div>
          ) : (
            <Link
              key={row.id}
              to="/symphony/$runId"
              params={row.to}
              className="block px-4 py-3 hover:bg-muted/40"
            >
              {body}
            </Link>
          );
        })}
      </div>
    </ListFrame>
  );
}
