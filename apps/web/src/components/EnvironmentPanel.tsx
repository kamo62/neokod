import { scopeThreadRef } from "@neokod/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@neokod/contracts";
import {
  CloudUploadIcon,
  FileDiffIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { type DraftId } from "~/composerDraftStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { usePrimaryEnvironmentId } from "~/state/environments";
import type { SourceControlPresentation } from "~/sourceControlPresentation";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useThreadEnvironmentContext } from "./BranchToolbar";
import { GitCommitDialog } from "./gitActions/GitCommitDialog";
import { GitDefaultBranchConfirmDialog } from "./gitActions/GitDefaultBranchConfirmDialog";
import { useGitActionsController } from "./gitActions/useGitActionsController";
import {
  resolveCompareWithBaseAvailability,
  resolveEnvironmentAheadBehind,
  resolveEnvironmentBaseBranchLabel,
  resolveEnvironmentChangeStats,
  resolveEnvironmentContextualActions,
  type EnvironmentContextualAction,
} from "./EnvironmentPanel.logic";

export interface EnvironmentPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  gitCwd: string | null;
  envLocked: boolean;
  effectiveEnvModeOverride?: EnvMode;
  /**
   * Whether this thread is a real server thread rather than a not-yet-sent
   * draft. Mirrors `ChatView`'s own gate on the Diff surface -- drafts have
   * no diff surface to open, so Compare-with-base must stay disabled there
   * instead of landing on the Diff panel's "select a thread" empty state.
   */
  isServerThread: boolean;
}

function EnvironmentActionIcon({
  action,
  SourceControlIcon,
}: {
  action: EnvironmentContextualAction;
  SourceControlIcon: SourceControlPresentation["Icon"];
}) {
  if (action.id === "commit") return <GitCommitIcon className="size-3.5" aria-hidden />;
  if (action.id === "commit_push" || action.id === "push") {
    return <CloudUploadIcon className="size-3.5" aria-hidden />;
  }
  return <SourceControlIcon className="size-3.5" aria-hidden />;
}

/**
 * Unified Environment right-panel: current project/environment, local vs
 * worktree mode, branch/base-branch, +adds/-dels and changed-file count,
 * ahead/behind, and the same Commit/Push/PR command logic as the header's
 * `GitActionsControl` (via `useGitActionsController`), plus a "Compare with
 * base" action that configures and opens the existing Diff panel rather
 * than building a second diff surface.
 */
export default function EnvironmentPanel({
  environmentId,
  threadId,
  draftId,
  gitCwd,
  envLocked,
  effectiveEnvModeOverride,
  isServerThread,
}: EnvironmentPanelProps) {
  const activeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { activeProject, activeWorktreePath, effectiveEnvMode } = useThreadEnvironmentContext({
    environmentId,
    threadId,
    ...(draftId ? { draftId } : {}),
    envLocked,
    ...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {}),
  });

  const gitActions = useGitActionsController({
    gitCwd,
    activeThreadRef,
    ...(draftId ? { draftId } : {}),
    // The header's GitActionsControl is always mounted while the panel is
    // open and already owns the focus/visibility refresh listeners and the
    // live branch-sync effect; a second copy here would double both.
    ownsGlobalEffects: false,
  });
  const {
    gitStatus,
    isRepo,
    hasPrimaryRemote,
    isDefaultRef,
    isGitActionRunning,
    menuItems,
    changeRequestTerminology,
    sourceControlPresentation,
    runGitAction,
    openExistingPr,
    openChangedFileInEditor,
    pendingDefaultBranchAction,
    confirmPendingDefaultBranchAction,
    checkoutFeatureBranchForPendingAction,
    cancelPendingDefaultBranchAction,
    isInitializingRepository,
    initializeRepository,
  } = gitActions;

  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);

  const changeStats = useMemo(() => resolveEnvironmentChangeStats(gitStatus), [gitStatus]);
  const aheadBehind = useMemo(() => resolveEnvironmentAheadBehind(gitStatus), [gitStatus]);
  const contextualActions = useMemo(
    () =>
      resolveEnvironmentContextualActions({
        gitStatus,
        menuItems,
        isBusy: isGitActionRunning,
        hasPrimaryRemote,
        terminology: changeRequestTerminology,
      }),
    [gitStatus, menuItems, isGitActionRunning, hasPrimaryRemote, changeRequestTerminology],
  );

  // Resolved purely for display, reusing the same review.diffPreview query
  // the Diff panel already issues for automatic base-ref resolution — no
  // new RPC. "Compare with base" below opens/configures the real Diff panel
  // instead of rendering a second diff surface here.
  const baseRefPreview = useEnvironmentQuery(
    isRepo && gitStatus?.pr == null && gitCwd
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const autoResolvedBaseRef =
    baseRefPreview.data?.sources.find((source) => source.kind === "branch-range")?.baseRef ?? null;
  const baseBranchLabel = resolveEnvironmentBaseBranchLabel({ gitStatus, autoResolvedBaseRef });
  const compareWithBaseAvailability = useMemo(
    () => resolveCompareWithBaseAvailability({ isServerThread, isRepo, baseBranchLabel }),
    [isServerThread, isRepo, baseBranchLabel],
  );

  const compareWithBase = useCallback(() => {
    if (compareWithBaseAvailability.disabled || compareWithBaseAvailability.baseRef === null) {
      return;
    }
    // Write the exact base ref this panel just displayed -- not "automatic"
    // -- so the Diff panel can never resolve a different base than the one
    // shown here (e.g. a PR targeting "release" while automatic resolution
    // would otherwise pick "main").
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    useDiffPanelStore
      .getState()
      .selectBranchBaseRef(activeThreadRef, compareWithBaseAvailability.baseRef);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
  }, [activeThreadRef, compareWithBaseAvailability]);

  const runContextualAction = useCallback(
    (action: EnvironmentContextualAction) => {
      if (action.disabled) return;
      if (action.kind === "open_commit_dialog") {
        setIsCommitDialogOpen(true);
        return;
      }
      if (action.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (action.action) {
        void runGitAction({ action: action.action });
      }
    },
    [openExistingPr, runGitAction],
  );

  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel =
    effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-panel">
      <div className="right-panel-pane-header justify-between px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="shrink-0 rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            Environment
          </Badge>
          {activeProject ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
              {activeProject.title}
            </span>
          ) : null}
        </div>
        {environmentId !== primaryEnvironmentId ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{environmentId}</span>
        ) : null}
      </div>

      {!isRepo ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-xs text-muted-foreground">
            This workspace isn&apos;t a Git repository yet.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={isInitializingRepository}
            onClick={() => void initializeRepository()}
          >
            <GitBranchPlusIcon className="size-3.5" aria-hidden />
            {isInitializingRepository ? "Initializing..." : "Initialize Git"}
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-3">
            <section className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                Workspace
              </p>
              <div className="flex items-center gap-1.5 text-[13px] text-foreground">
                <WorkspaceIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{workspaceLabel}</span>
              </div>
            </section>

            <Separator />

            <section className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                Branch
              </p>
              <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                <span className="font-medium text-foreground">
                  {gitStatus?.refName ?? "(detached HEAD)"}
                </span>
                {baseBranchLabel ? (
                  <>
                    <span className="text-muted-foreground/50">into</span>
                    <span className="text-muted-foreground">{baseBranchLabel}</span>
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-mono">
                  <span className="text-success">+{changeStats.additions}</span>{" "}
                  <span className="text-destructive">-{changeStats.deletions}</span>
                </span>
                <span>
                  {changeStats.changedFileCount}{" "}
                  {changeStats.changedFileCount === 1 ? "file" : "files"} changed
                </span>
                {aheadBehind.ahead > 0 ? <span>{aheadBehind.ahead} ahead</span> : null}
                {aheadBehind.behind > 0 ? <span>{aheadBehind.behind} behind</span> : null}
              </div>
            </section>

            <Separator />

            <section className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                Actions
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {contextualActions.map((action) => {
                  const button = (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={action.disabled}
                      onClick={() => runContextualAction(action)}
                      className={cn(
                        "w-full justify-start",
                        action.disabled && "pointer-events-none",
                      )}
                    >
                      <EnvironmentActionIcon
                        action={action}
                        SourceControlIcon={sourceControlPresentation.Icon}
                      />
                      {action.label}
                    </Button>
                  );
                  if (!action.disabled || !action.disabledReason) {
                    return <div key={action.id}>{button}</div>;
                  }
                  return (
                    <Tooltip key={action.id}>
                      <TooltipTrigger render={<span className="block w-full cursor-not-allowed" />}>
                        {button}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{action.disabledReason}</TooltipPopup>
                    </Tooltip>
                  );
                })}
              </div>
            </section>

            <Separator />

            <section>
              {(() => {
                const compareButton = (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={compareWithBaseAvailability.disabled}
                    className={cn(
                      "w-full justify-center",
                      compareWithBaseAvailability.disabled && "pointer-events-none",
                    )}
                    onClick={compareWithBase}
                  >
                    <FileDiffIcon className="size-3.5" aria-hidden />
                    Compare with base
                  </Button>
                );
                if (
                  !compareWithBaseAvailability.disabled ||
                  !compareWithBaseAvailability.disabledReason
                ) {
                  return compareButton;
                }
                return (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block w-full cursor-not-allowed" />}>
                      {compareButton}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {compareWithBaseAvailability.disabledReason}
                    </TooltipPopup>
                  </Tooltip>
                );
              })()}
            </section>
          </div>
        </ScrollArea>
      )}

      <GitCommitDialog
        open={isCommitDialogOpen}
        onOpenChange={setIsCommitDialogOpen}
        gitStatus={gitStatus}
        isDefaultRef={isDefaultRef}
        onOpenFile={openChangedFileInEditor}
        onCommit={(input) => void runGitAction({ action: "commit", ...input })}
        onCommitOnNewBranch={(input) =>
          void runGitAction({
            action: "commit",
            ...input,
            featureBranch: true,
            skipDefaultBranchPrompt: true,
          })
        }
      />

      <GitDefaultBranchConfirmDialog
        pendingAction={pendingDefaultBranchAction}
        terminology={changeRequestTerminology}
        onCancel={cancelPendingDefaultBranchAction}
        onContinue={confirmPendingDefaultBranchAction}
        onCheckoutFeatureBranch={checkoutFeatureBranchForPendingAction}
      />
    </div>
  );
}
