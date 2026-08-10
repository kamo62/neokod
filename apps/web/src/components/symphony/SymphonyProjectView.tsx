import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type {
  SymphonyProject,
  SymphonyProjectBoard,
  SymphonyProjectConfiguration,
  SymphonyProjectId,
} from "@neokod/contracts";
import { useNavigate } from "@tanstack/react-router";
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
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom } from "../../state/server";
import { symphonyEnvironment } from "../../state/symphony";
import { symphonyExtras } from "../../state/symphonyExtras";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { SymphonyEmptyState } from "./SymphonyEmptyState";
import {
  defaultSymphonyProjectConfiguration,
  isSymphonyProjectConfigurationComplete,
  SymphonyProjectConfigurationForm,
} from "./SymphonyProjectConfigurationForm";

type ProjectTab = "board" | "runs" | "attention" | "history" | "settings";

const TABS: ReadonlyArray<{ value: ProjectTab; label: string }> = [
  { value: "board", label: "Board" },
  { value: "runs", label: "Runs" },
  { value: "attention", label: "Attention" },
  { value: "history", label: "History" },
  { value: "settings", label: "Settings" },
];

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

function BoardTab({ board }: { readonly board: SymphonyProjectBoard }) {
  return (
    <div className="grid min-h-full min-w-[70rem] grid-cols-5 gap-4 p-6 sm:p-8">
      {board.columns.map((column) => (
        <section key={column.id} className="min-w-0">
          <div className="mb-3 flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold">{column.title}</h2>
            <Badge variant="secondary">{column.cards.length}</Badge>
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
                </article>
              ))
            )}
          </div>
        </section>
      ))}
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
  const providers = useAtomValue(primaryServerProvidersAtom).filter(
    (provider) => provider.enabled && provider.installed && provider.availability !== "unavailable",
  );
  const fallback = providers[0] ?? null;
  const [configuration, setConfiguration] = useState<SymphonyProjectConfiguration | null>(
    project.configuration ?? (fallback ? defaultSymphonyProjectConfiguration(fallback) : null),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateProject = useAtomCommand(symphonyEnvironment.updateProject, { reportFailure: false });

  useEffect(() => {
    setConfiguration(
      project.configuration ?? (fallback ? defaultSymphonyProjectConfiguration(fallback) : null),
    );
  }, [fallback, project]);

  const save = async () => {
    if (configuration === null || !isSymphonyProjectConfigurationComplete(configuration)) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateProject({
        environmentId,
        input: { projectId: project.id, expectedRevision: project.revision, configuration },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : "Could not save project settings.");
        }
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (configuration === null) {
    return (
      <SymphonyEmptyState
        icon={TriangleAlertIcon}
        title="No coding provider"
        description="Configure a coding provider before completing this project."
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
      <SymphonyProjectConfigurationForm
        value={configuration}
        providers={providers}
        onChange={setConfiguration}
      />
      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !isSymphonyProjectConfigurationComplete(configuration)}
        >
          {saving ? <Spinner className="size-3.5" /> : null}Save settings
        </Button>
      </div>
    </div>
  );
}

export function SymphonyProjectView({ projectId }: { readonly projectId: SymphonyProjectId }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const [tab, setTab] = useState<ProjectTab>("board");
  const [action, setAction] = useState<"start" | "pause" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const boardQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyEnvironment.projectBoard({ environmentId, input: { projectId } }),
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
  const historyQuery = useEnvironmentQuery(
    environmentId === null || tab !== "history"
      ? null
      : symphonyExtras.history({ environmentId, input: { projectId } }),
  );
  const startProject = useAtomCommand(symphonyEnvironment.startProject, { reportFailure: false });
  const pauseProject = useAtomCommand(symphonyEnvironment.pauseProject, { reportFailure: false });
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
            <Button
              size="sm"
              variant="ghost"
              onClick={boardQuery.refresh}
              disabled={boardQuery.isPending}
            >
              <RefreshCwIcon
                className={boardQuery.isPending ? "size-3.5 animate-spin" : "size-3.5"}
              />
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
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {tab === "board" ? <BoardTab board={board} /> : null}
        {tab === "settings" && environmentId !== null ? (
          <SettingsTab
            project={project}
            environmentId={environmentId}
            onSaved={boardQuery.refresh}
          />
        ) : null}
        {tab === "runs" ? (
          <SimpleList
            title="Runs"
            loading={runsQuery.isPending}
            error={runsQuery.error}
            rows={(runsQuery.data ?? []).map((run) => ({
              id: run.runAttemptId,
              title: run.issueTitle ?? run.workItemId,
              detail: `${run.lifecycle.replaceAll("_", " ")} · attempt ${run.attemptNumber}`,
            }))}
          />
        ) : null}
        {tab === "attention" ? (
          <SimpleList
            title="Attention"
            loading={attentionQuery.isPending}
            error={attentionQuery.error}
            rows={(attentionQuery.data ?? []).map((item) => ({
              id: item.id,
              title: item.kind.replaceAll("_", " "),
              detail: item.recommendedResponse ?? item.whatHappened,
            }))}
          />
        ) : null}
        {tab === "history" ? (
          <SimpleList
            title="History"
            loading={historyQuery.isPending}
            error={historyQuery.error}
            rows={(historyQuery.data ?? []).map((run) => ({
              id: run.runAttemptId,
              title: run.issueTitle ?? run.workItemId,
              detail: `${run.lifecycle.replaceAll("_", " ")} · ${new Date(run.startedAt).toLocaleString()}`,
            }))}
          />
        ) : null}
      </main>
    </div>
  );
}

function SimpleList({
  title,
  loading,
  error,
  rows,
}: {
  readonly title: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly rows: ReadonlyArray<{ id: string; title: string; detail: string }>;
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 sm:p-8">
      <h2 className="text-base font-semibold">{title}</h2>
      {loading && rows.length === 0 ? (
        <Skeleton className="h-32 rounded-2xl" />
      ) : error && rows.length === 0 ? (
        <SymphonyEmptyState
          icon={TriangleAlertIcon}
          title={`${title} unavailable`}
          description={error}
        />
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Nothing here yet.
        </p>
      ) : (
        <div className="divide-y rounded-2xl border bg-card">
          {rows.map((row) => (
            <div key={row.id} className="px-4 py-3">
              <p className="text-sm font-medium">{row.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
