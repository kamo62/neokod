import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type { SymphonyProject, SymphonyProjectId } from "@neokod/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  GitBranchIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom } from "../../state/server";
import { symphonyEnvironment } from "../../state/symphony";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { SymphonyEmptyState } from "./SymphonyEmptyState";
import {
  availableSymphonyImplementationProviders,
  availableSymphonyReviewProviders,
  defaultSymphonyProjectConfiguration,
  isSymphonyProjectConfigurationComplete,
  SymphonyProjectConfigurationForm,
} from "./SymphonyProjectConfigurationForm";
import { SymphonyWorkView } from "./SymphonyWorkView";
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
import { PROJECT_TABS, type ProjectTab, type WorkFilter } from "./symphonyProjectTabs";

const TAB_LABELS: Readonly<Record<ProjectTab, string>> = {
  work: "Work",
  history: "History",
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
  filter,
  onTabChange,
  onFilterChange,
}: {
  readonly projectId: SymphonyProjectId;
  readonly tab: ProjectTab;
  readonly filter: WorkFilter;
  readonly onTabChange: (tab: ProjectTab) => void;
  readonly onFilterChange: (filter: WorkFilter) => void;
}) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const environment = usePrimaryEnvironment();
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
  const startProject = useAtomCommand(symphonyEnvironment.startProject, {
    reportFailure: false,
  });
  const pauseProject = useAtomCommand(symphonyEnvironment.pauseProject, {
    reportFailure: false,
  });
  const board = boardQuery.data;

  if (environmentId === null) {
    return (
      <SymphonyEmptyState
        icon={TriangleAlertIcon}
        title="No environment connected"
        description="Connect the local Neokod server before opening Symphony work."
        action={
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/symphony" })}>
            Back to projects
          </Button>
        }
      />
    );
  }

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
  const machineLabel = environment?.label ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b px-6 pt-8 sm:px-8 sm:pt-5">
        <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
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
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              <Badge variant="outline">Tracker: {trackerScope(project)}</Badge>
              <Badge variant="outline">
                <GitBranchIcon className="size-3" />
                Source control: {sourceControl}
              </Badge>
              <Badge variant="outline">
                Policy: {project.configuration?.autonomy ?? "not set"}
              </Badge>
              {project.setupState === "needs_setup" ? (
                <Badge variant="warning">Needs setup</Badge>
              ) : null}
              <span
                className="inline-flex min-w-0 items-center gap-1"
                title={project.repositoryPath}
              >
                <span className="shrink-0">Repository</span>
                <span className="truncate font-mono text-[11px]">{project.repositoryPath}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="shrink-0">Server</span>
                <span className="truncate">{machineLabel ?? "Not reported"}</span>
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-start gap-2 sm:justify-end">
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

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "settings" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SettingsTab
              key={project.id}
              project={project}
              environmentId={environmentId}
              onSaved={boardQuery.refresh}
            />
          </div>
        ) : (
          <SymphonyWorkView
            projectId={projectId}
            environmentId={environmentId}
            project={project}
            board={board}
            boardLoading={boardQuery.isPending}
            boardError={boardQuery.error}
            tab={tab}
            filter={filter}
            onFilterChange={onFilterChange}
            machineLabel={machineLabel}
          />
        )}
      </main>
    </div>
  );
}
