import { useState } from "react";
import {
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";

import type { EnvironmentId, WorkflowRecord } from "@neokod/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { symphonyEnvironment } from "../../state/symphony";
import { symphonyExtras } from "../../state/symphonyExtras";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { cn } from "../../lib/utils";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

const STATUS_BADGE: Record<string, "default" | "secondary" | "success" | "warning" | "info"> = {
  active: "success",
  paused: "warning",
  invalid: "secondary",
  draft: "secondary",
};

type WorkflowAction = "validate" | "activate" | "pause" | "resume";
type GlobalAction = "pause" | "resume" | "stop";

/**
 * Inline WORKFLOW.md editor (PRD 12.3, pragmatic v1). Fetches the raw file
 * text on mount (only mounted while its row is expanded), tracks a local
 * dirty draft, and reuses the row's existing Validate action so the
 * on-disk validation result is the same code path either way. Save is a
 * new RPC: the write always lands, an invalid result comes back as
 * `{ ok: true, validationError }` rather than a failure (server already
 * marks the workflow record `invalid` in that case), so this surfaces the
 * message inline instead of treating it as a request failure.
 */
function WorkflowEditorPanel({
  environmentId,
  workflow,
  validatePending,
  onValidate,
  onCancel,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowRecord;
  readonly validatePending: boolean;
  readonly onValidate: () => void;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}) {
  const contentQuery = useEnvironmentQuery(
    symphonyExtras.getWorkflowContent({ environmentId, input: { workflowId: workflow.id } }),
  );
  const saveWorkflowContent = useAtomCommand(symphonyExtras.saveWorkflowContent);

  const [draft, setDraft] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveValidationError, setSaveValidationError] = useState<string | null>(null);

  const original = contentQuery.data?.content ?? null;
  const value = draft ?? original ?? "";
  const isDirty = draft !== null && original !== null && draft !== original;

  const handleSave = async () => {
    if (draft === null) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveValidationError(null);
    try {
      const result = await saveWorkflowContent({
        environmentId,
        input: { workflowId: workflow.id, content: draft },
      });
      if (result._tag === "Success") {
        setSaveValidationError(result.value.validationError ?? null);
        setDraft(null);
        contentQuery.refresh();
        onSaved();
      } else {
        setSaveError("Save failed. Try again.");
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="border-t border-border/60 bg-muted/20 px-4 py-3.5 sm:px-5">
      {contentQuery.isPending && contentQuery.data === null ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : contentQuery.error && contentQuery.data === null ? (
        <p className="text-[11px] text-destructive-foreground">
          Could not load {workflow.workflowPath}: {contentQuery.error}
        </p>
      ) : (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="truncate text-[11px] text-muted-foreground/80">
              {contentQuery.data?.path ?? workflow.workflowPath}
            </code>
            {isDirty ? (
              <span className="text-[11px] font-medium text-warning">Unsaved changes</span>
            ) : null}
          </div>
          <textarea
            className="h-72 w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            aria-label={`Edit ${workflow.workflowPath}`}
          />
          {saveValidationError !== null ? (
            <p className="text-[11px] text-warning">{saveValidationError}</p>
          ) : null}
          {saveError !== null ? (
            <p className="text-[11px] text-destructive-foreground">{saveError}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={onValidate}
              disabled={validatePending}
              aria-label="Validate workflow"
            >
              {validatePending ? <Spinner className="size-3" /> : null}
              Validate
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => void handleSave()}
              disabled={isSaving || !isDirty}
              aria-label="Save workflow"
            >
              {isSaving ? <Spinner className="size-3" /> : null}
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={onCancel}
              disabled={isSaving}
              aria-label="Cancel editing workflow"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowRow({
  workflow,
  pendingAction,
  isEditing,
  environmentId,
  onValidate,
  onActivate,
  onPause,
  onResume,
  onToggleEdit,
  onSaved,
}: {
  readonly workflow: WorkflowRecord;
  readonly pendingAction: WorkflowAction | null;
  readonly isEditing: boolean;
  readonly environmentId: EnvironmentId;
  readonly onValidate: () => void;
  readonly onActivate: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onToggleEdit: () => void;
  readonly onSaved: () => void;
}) {
  const isPending = pendingAction !== null;
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="px-4 py-3.5 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                {workflow.workflowPath}
              </code>
              <Badge variant={STATUS_BADGE[workflow.status] ?? "secondary"} size="sm">
                {workflow.status}
              </Badge>
              <Badge variant="outline" size="sm">
                {workflow.autonomy}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground/80">{workflow.repositoryPath}</p>
            {workflow.validationError !== null ? (
              <p className="text-[11px] text-warning">{workflow.validationError}</p>
            ) : null}
          </div>
          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant={isEditing ? "secondary" : "ghost"}
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={onToggleEdit}
              aria-label={isEditing ? "Close workflow editor" : "Edit workflow"}
            >
              {isEditing ? "Close" : "Edit"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={onValidate}
              disabled={isPending}
              aria-label="Validate workflow"
            >
              {pendingAction === "validate" ? <Spinner className="size-3" /> : null}
              Validate
            </Button>
            {workflow.status === "draft" || workflow.status === "invalid" ? (
              <Button
                size="sm"
                variant="default"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={onActivate}
                disabled={isPending}
                aria-label="Activate workflow"
              >
                {pendingAction === "activate" ? <Spinner className="size-3" /> : null}
                Activate
              </Button>
            ) : null}
            {workflow.status === "active" ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={onPause}
                disabled={isPending}
                aria-label="Pause workflow"
              >
                {pendingAction === "pause" ? <Spinner className="size-3" /> : null}
                Pause
              </Button>
            ) : null}
            {workflow.status === "paused" ? (
              <Button
                size="sm"
                variant="default"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={onResume}
                disabled={isPending}
                aria-label="Resume workflow"
              >
                {pendingAction === "resume" ? <Spinner className="size-3" /> : null}
                Resume
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {isEditing ? (
        <WorkflowEditorPanel
          environmentId={environmentId}
          workflow={workflow}
          validatePending={pendingAction === "validate"}
          onValidate={onValidate}
          onCancel={onToggleEdit}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

function WorkflowsSkeleton() {
  const rows = ["one", "two"] as const;
  return (
    <>
      {rows.map((row) => (
        <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3 rounded-full" />
            <Skeleton className="h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </>
  );
}

export function SymphonySettingsView() {
  const environmentId = usePrimaryEnvironmentId();
  const workflowsQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.workflows({ environmentId, input: {} }),
  );
  const overviewQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.overview({ environmentId, input: {} }),
  );
  const workflows = workflowsQuery.data ?? [];
  const orchestratorPaused = overviewQuery.data?.orchestratorPaused ?? null;

  const validateWorkflow = useAtomCommand(symphonyExtras.validateWorkflow);
  const activateWorkflow = useAtomCommand(symphonyExtras.activateWorkflow);
  const pauseWorkflow = useAtomCommand(symphonyExtras.pauseWorkflow);
  const resumeWorkflow = useAtomCommand(symphonyExtras.resumeWorkflow);
  const pauseGlobal = useAtomCommand(symphonyExtras.pauseGlobal);
  const resumeGlobal = useAtomCommand(symphonyExtras.resumeGlobal);
  const stopAllRuns = useAtomCommand(symphonyExtras.stopAllRuns);

  const [pendingWorkflow, setPendingWorkflow] = useState<{
    workflowId: string;
    action: WorkflowAction;
  } | null>(null);
  const [pendingGlobal, setPendingGlobal] = useState<GlobalAction | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);

  const runWorkflowAction = async (
    workflow: WorkflowRecord,
    envId: EnvironmentId,
    action: WorkflowAction,
  ) => {
    setPendingWorkflow({ workflowId: workflow.id, action });
    try {
      const result = await (action === "validate"
        ? validateWorkflow({
            environmentId: envId,
            input: { repositoryPath: workflow.repositoryPath, workflowPath: workflow.workflowPath },
          })
        : action === "activate"
          ? activateWorkflow({
              environmentId: envId,
              input: {
                repositoryPath: workflow.repositoryPath,
                workflowPath: workflow.workflowPath,
              },
            })
          : action === "pause"
            ? pauseWorkflow({ environmentId: envId, input: { workflowId: workflow.id } })
            : resumeWorkflow({ environmentId: envId, input: { workflowId: workflow.id } }));
      if (result._tag === "Success") {
        workflowsQuery.refresh();
      }
    } finally {
      setPendingWorkflow(null);
    }
  };

  const runGlobalAction = async (envId: EnvironmentId, action: GlobalAction) => {
    setPendingGlobal(action);
    try {
      const result = await (action === "pause"
        ? pauseGlobal({ environmentId: envId, input: {} })
        : action === "resume"
          ? resumeGlobal({ environmentId: envId, input: {} })
          : stopAllRuns({ environmentId: envId, input: { confirm: "stop-all-runs" } }));
      if (result._tag === "Success") {
        overviewQuery.refresh();
      }
    } finally {
      setPendingGlobal(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-6 pb-2 pt-6 sm:px-8">
        <div className="space-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Settings</h1>
          <p className="text-xs text-muted-foreground">
            Manage workflows and orchestrator-wide dispatch controls.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={() => {
            workflowsQuery.refresh();
            overviewQuery.refresh();
          }}
          disabled={workflowsQuery.isPending}
          aria-label="Refresh settings"
        >
          <RefreshCwIcon className={cn("size-3.5", workflowsQuery.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {workflowsQuery.isPending && workflowsQuery.data === null ? (
          <div className="space-y-6">
            <div className="rounded-2xl border bg-card">
              <WorkflowsSkeleton />
            </div>
            <div className="rounded-2xl border bg-card">
              <WorkflowsSkeleton />
            </div>
          </div>
        ) : workflowsQuery.error && workflowsQuery.data === null ? (
          <SymphonyEmptyState
            icon={TriangleAlertIcon}
            title="Could not load settings"
            description={workflowsQuery.error}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={workflowsQuery.refresh}
                disabled={workflowsQuery.isPending}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", workflowsQuery.isPending && "animate-spin")}
                />
                Retry
              </Button>
            }
          />
        ) : (
          <div className="space-y-6">
            <section className="space-y-2.5">
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Global controls
              </h2>
              <div className="rounded-2xl border bg-card">
                <div className="px-4 py-3.5 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                        Dispatch
                      </h3>
                      <p className="text-xs text-muted-foreground/80">
                        {orchestratorPaused === null
                          ? "Dispatch state is unknown."
                          : orchestratorPaused
                            ? "Dispatch is paused. No new work will be picked up."
                            : "Dispatch is active. Eligible work is picked up automatically."}
                      </p>
                    </div>
                    <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 px-2 text-[11px]"
                        disabled={
                          environmentId === null ||
                          pendingGlobal !== null ||
                          orchestratorPaused === true
                        }
                        onClick={() =>
                          environmentId !== null && void runGlobalAction(environmentId, "pause")
                        }
                        aria-label="Pause all dispatch"
                      >
                        {pendingGlobal === "pause" ? (
                          <Spinner className="size-3" />
                        ) : (
                          <PauseIcon className="size-3" />
                        )}
                        Pause all
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 px-2 text-[11px]"
                        disabled={
                          environmentId === null ||
                          pendingGlobal !== null ||
                          orchestratorPaused === false
                        }
                        onClick={() =>
                          environmentId !== null && void runGlobalAction(environmentId, "resume")
                        }
                        aria-label="Resume all dispatch"
                      >
                        {pendingGlobal === "resume" ? (
                          <Spinner className="size-3" />
                        ) : (
                          <PlayIcon className="size-3" />
                        )}
                        Resume all
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="border-t border-border/60 px-4 py-3.5 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                        Stop all runs
                      </h3>
                      <p className="text-xs text-muted-foreground/80">
                        Cancel every run in flight across every workflow. Queued work stays queued;
                        dispatch keeps running unless paused separately.
                      </p>
                    </div>
                    <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 gap-1.5 px-2 text-[11px]"
                        disabled={environmentId === null || pendingGlobal !== null}
                        onClick={() => setStopConfirmOpen(true)}
                        aria-label="Stop all runs"
                      >
                        {pendingGlobal === "stop" ? (
                          <Spinner className="size-3" />
                        ) : (
                          <SquareIcon className="size-3" />
                        )}
                        Stop all runs
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-2.5">
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Workflows
              </h2>
              {workflows.length === 0 ? (
                <Empty className="min-h-64 rounded-2xl border bg-card">
                  <EmptyMedia variant="icon">
                    <WorkflowIcon />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No workflows configured</EmptyTitle>
                    <EmptyDescription>
                      Add a WORKFLOW.md to a tracked repository to define a Symphony workflow. It
                      appears here once the server discovers it.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="rounded-2xl border bg-card">
                  {environmentId === null
                    ? null
                    : workflows.map((workflow) => (
                        <WorkflowRow
                          key={workflow.id}
                          workflow={workflow}
                          environmentId={environmentId}
                          pendingAction={
                            pendingWorkflow?.workflowId === workflow.id
                              ? pendingWorkflow.action
                              : null
                          }
                          isEditing={editingWorkflowId === workflow.id}
                          onValidate={() =>
                            void runWorkflowAction(workflow, environmentId, "validate")
                          }
                          onActivate={() =>
                            void runWorkflowAction(workflow, environmentId, "activate")
                          }
                          onPause={() => void runWorkflowAction(workflow, environmentId, "pause")}
                          onResume={() => void runWorkflowAction(workflow, environmentId, "resume")}
                          onToggleEdit={() =>
                            setEditingWorkflowId((current) =>
                              current === workflow.id ? null : workflow.id,
                            )
                          }
                          onSaved={() => workflowsQuery.refresh()}
                        />
                      ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      <AlertDialog
        open={stopConfirmOpen}
        onOpenChange={(open) => {
          if (pendingGlobal === null) setStopConfirmOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop all runs?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels every in-flight Symphony run across every workflow right now. It cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" disabled={pendingGlobal !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingGlobal !== null || environmentId === null}
              onClick={() => {
                setStopConfirmOpen(false);
                if (environmentId !== null) void runGlobalAction(environmentId, "stop");
              }}
            >
              {pendingGlobal === "stop" ? <Spinner className="size-3.5" /> : null}
              Stop all runs
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
