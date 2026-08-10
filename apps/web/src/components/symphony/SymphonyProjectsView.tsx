import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, SymphonyProjectConfiguration } from "@neokod/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderGit2Icon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useOpenAddProjectCommandPalette } from "../../commandPaletteContext";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom } from "../../state/server";
import { symphonyEnvironment } from "../../state/symphony";
import { vcsEnvironment } from "../../state/vcs";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { SymphonyEmptyState } from "./SymphonyEmptyState";
import {
  defaultSymphonyProjectConfiguration,
  isSymphonyProjectConfigurationComplete,
  SymphonyProjectConfigurationForm,
} from "./SymphonyProjectConfigurationForm";

function CreateProjectDialog({
  open,
  onOpenChange,
  environmentId,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly onCreated: (projectId: string) => void;
}) {
  const createProject = useAtomCommand(symphonyEnvironment.createProject, { reportFailure: false });
  const initializeRepository = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const openAddCodeProject = useOpenAddProjectCommandPalette();
  const allCodeProjects = useProjects();
  const codeProjects = allCodeProjects.filter((project) => project.environmentId === environmentId);
  const providers = useAtomValue(primaryServerProvidersAtom).filter(
    (provider) => provider.enabled && provider.installed && provider.availability !== "unavailable",
  );
  const defaultProvider = providers[0] ?? null;
  const [codeProjectId, setCodeProjectId] = useState<ProjectId | null>(null);
  const [configuration, setConfiguration] = useState<SymphonyProjectConfiguration | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (configuration === null && defaultProvider !== null) {
      setConfiguration(defaultSymphonyProjectConfiguration(defaultProvider));
    }
  }, [configuration, defaultProvider]);

  const selectedProjectId =
    codeProjectId ?? (codeProjects.length === 1 ? (codeProjects[0]?.id ?? null) : null);
  const configurationComplete =
    configuration !== null && isSymphonyProjectConfigurationComplete(configuration);

  const reset = () => {
    setCodeProjectId(null);
    setConfiguration(defaultProvider ? defaultSymphonyProjectConfiguration(defaultProvider) : null);
    setError(null);
  };

  const addCodeProject = () => {
    onOpenChange(false);
    openAddCodeProject(async (project) => {
      if (project.environmentId !== environmentId) {
        setError("Choose a Code project in the current environment.");
        onOpenChange(true);
        return;
      }
      const initialized = await initializeRepository({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot },
      });
      setCodeProjectId(project.projectId);
      onOpenChange(true);
      if (initialized._tag === "Failure" && !isAtomCommandInterrupted(initialized)) {
        const cause = squashAtomCommandFailure(initialized);
        setError(
          cause instanceof Error ? cause.message : "Could not initialise the Git repository.",
        );
      }
    });
  };

  const submit = async () => {
    if (environmentId === null || selectedProjectId === null || !configurationComplete) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await createProject({
        environmentId,
        input: { codeProjectId: selectedProjectId, configuration },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(
            typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "symphony_project_already_exists"
              ? "This Code project already has a Symphony project."
              : cause instanceof Error
                ? cause.message
                : "Could not create the Symphony project.",
          );
        }
        return;
      }
      onCreated(result.value.id);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) reset();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create Symphony project</DialogTitle>
          <DialogDescription>
            Attach one Code project to one tracker. Source control is inferred independently from
            the repository remote. The project starts paused.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="space-y-1.5">
            <Label>Code project</Label>
            {codeProjects.length === 0 ? (
              <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                <p>Add, clone, or create a Code project first.</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={addCodeProject}>
                  <PlusIcon className="size-3.5" /> Add Code project
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Select
                  value={selectedProjectId ?? undefined}
                  onValueChange={(value) => setCodeProjectId(value as ProjectId)}
                  items={codeProjects.map((project) => ({
                    value: project.id,
                    label: project.title,
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a Code project" />
                  </SelectTrigger>
                  <SelectPopup>
                    {codeProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        <span className="flex min-w-0 flex-col">
                          <span>{project.title}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {project.workspaceRoot}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button size="sm" variant="ghost" className="px-2" onClick={addCodeProject}>
                  <PlusIcon className="size-3.5" /> Add, clone, or create another
                </Button>
              </div>
            )}
          </div>

          {configuration === null ? (
            <p className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground">
              Configure and enable at least one coding provider before creating a Symphony project.
            </p>
          ) : (
            <SymphonyProjectConfigurationForm
              value={configuration}
              providers={providers}
              onChange={setConfiguration}
            />
          )}
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={isSubmitting || selectedProjectId === null || !configurationComplete}
          >
            {isSubmitting ? <Spinner className="size-3.5" /> : null}
            Create paused project
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SymphonyProjectsView() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const [createOpen, setCreateOpen] = useState(false);
  const projectsQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.projects({ environmentId, input: {} }),
  );
  const projects = projectsQuery.data ?? [];
  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-5 sm:px-8">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.02em]">Symphony projects</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Code repository, tracker scope, and delivery policy meet here.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={projectsQuery.refresh}
            disabled={projectsQuery.isPending}
          >
            <RefreshCwIcon
              className={projectsQuery.isPending ? "size-3.5 animate-spin" : "size-3.5"}
            />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-3.5" /> Create project
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {projectsQuery.isPending && projectsQuery.data === null ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-36 rounded-2xl" />
            <Skeleton className="h-36 rounded-2xl" />
          </div>
        ) : projectsQuery.error && projectsQuery.data === null ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Projects unavailable"
            description={projectsQuery.error}
          />
        ) : sortedProjects.length === 0 ? (
          <SymphonyEmptyState
            icon={FolderGit2Icon}
            title="Create your first Symphony project"
            description="Choose an existing Code project, clone a repository, or create a local project. Then attach its tracker and runtime policy."
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-3.5" /> Create project
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {sortedProjects.map((project) => (
              <button
                type="button"
                key={project.id}
                className="rounded-2xl border bg-card p-5 text-left transition-colors hover:border-foreground/20 hover:bg-accent/20"
                onClick={() =>
                  void navigate({
                    to: "/symphony/projects/$projectId",
                    params: { projectId: project.id },
                  })
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{project.title}</h2>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {project.repositoryPath}
                    </p>
                  </div>
                  <Badge variant={project.status === "active" ? "success" : "secondary"}>
                    {project.status}
                  </Badge>
                </div>
                <div className="mt-5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">
                    Tracker: {project.configuration?.tracker.kind ?? "needs setup"}
                  </Badge>
                  <Badge variant="outline">
                    Runtime: {project.configuration?.autonomy ?? "not set"}
                  </Badge>
                  {project.setupState === "needs_setup" ? (
                    <Badge variant="warning">Needs setup</Badge>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        environmentId={environmentId}
        onCreated={(projectId) => {
          projectsQuery.refresh();
          void navigate({ to: "/symphony/projects/$projectId", params: { projectId } });
        }}
      />
    </div>
  );
}
