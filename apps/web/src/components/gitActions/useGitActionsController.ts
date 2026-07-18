import { useAtomValue } from "@effect/atom-react";
import { type ScopedThreadRef } from "@neokod/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@neokod/contracts";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  buildGitActionProgressStages,
  buildMenuItems,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  type GitActionMenuItem,
  type GitQuickAction,
} from "../GitActionsControl.logic";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsInitAction,
  useVcsPullAction,
} from "~/lib/sourceControlActions";
import { useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { openPullRequestLink } from "~/lib/openPullRequestLink";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";

export interface UseGitActionsControllerInput {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  /**
   * Whether this instance owns the effects that should only ever run once
   * per thread regardless of how many surfaces mount this hook: the
   * focus/visibilitychange VCS-status refresh listeners, and the live
   * thread-branch-sync effect (which persists a metadata write). Defaults
   * to `true`. The always-mounted header `GitActionsControl` keeps the
   * default; `EnvironmentPanel` (which mounts only while the panel is
   * open, alongside the header) passes `false` so the two instances don't
   * double up on global listeners or duplicate metadata writes.
   */
  ownsGlobalEffects?: boolean;
}

export interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

export interface RunGitActionInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  filePaths?: string[];
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
  /** Set from the `action_failed` progress event's `phase`, when the server
   * reports one. Lets the failure toast say which step landed vs. which
   * failed (e.g. "commit succeeded; push failed") instead of a bare
   * "Action failed". */
  failedPhase: GitActionProgressPhase | null;
}

function describeGitActionPhase(phase: GitActionProgressPhase): string {
  switch (phase) {
    case "branch":
      return "branch creation";
    case "commit":
      return "commit";
    case "push":
      return "push";
    case "pr":
      return "pull request creation";
  }
}

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

type RefreshVcsStatus = (target: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: ScopedThreadRef["environmentId"] | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}

const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

/**
 * Shared VCS status/action controller consumed by both the compact header
 * `GitActionsControl` and the `EnvironmentPanel`. Owns the git status query,
 * quick-action/menu derivation, and the command execution (commit/push/PR)
 * flow, including default-branch confirmation. Each caller keeps its own
 * dialog-open UI state; the underlying command logic lives here exactly
 * once.
 */
export function useGitActionsController({
  gitCwd,
  activeThreadRef,
  draftId,
  ownsGlobalEffects = true,
}: UseGitActionsControllerInput) {
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread branch metadata update",
  );
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const activeServerThread = useThread(activeThreadRef);
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  const sourceControlScope = useMemo(
    () => ({ environmentId: activeEnvironmentId, cwd: gitCwd }),
    [activeEnvironmentId, gitCwd],
  );
  let runGitAction: (input: RunGitActionInput) => Promise<void>;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        void updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
          },
        });

        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      draftId,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  const gitStatusQuery = useEnvironmentQuery(
    activeEnvironmentId !== null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: activeEnvironmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const { data: gitStatus, error: gitStatusError } = gitStatusQuery;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = gitStatus;

  const initAction = useVcsInitAction(sourceControlScope);
  const runImmediateGitAction = useGitStackedAction(sourceControlScope);
  const pullAction = useVcsPullAction(sourceControlScope);
  const isGitActionRunning = useSourceControlActionRunning(
    sourceControlScope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  useEffect(() => {
    // Only the owning instance persists live branch-sync metadata writes;
    // a second mounted instance (e.g. the panel while the header is also
    // mounted) would otherwise race the same write for no benefit.
    if (!ownsGlobalEffects || isGitActionRunning || isSelectingWorktreeBase) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeServerThread?.branch ?? activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread?.branch,
    activeDraftThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    isSelectingWorktreeBase,
    ownsGlobalEffects,
    persistThreadBranchSync,
  ]);

  const isDefaultRef = useMemo(() => {
    return gitStatusForActions?.isDefaultRef ?? false;
  }, [gitStatusForActions?.isDefaultRef]);

  const menuItems: GitActionMenuItem[] = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isGitActionRunning],
  );
  const quickAction: GitQuickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  useEffect(() => {
    // Only the owning instance registers the window-level listeners; both
    // the header and the panel querying the same status atom would
    // otherwise each fire a refresh RPC per focus/visibility change.
    if (!ownsGlobalEffects || gitCwd === null) {
      return;
    }

    let refreshTimeout: number | null = null;
    const scheduleRefreshCurrentGitStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshCurrentGitStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshCurrentGitStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshCurrentGitStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEnvironmentId, gitCwd, ownsGlobalEffects, refreshVcsStatus]);

  const openExistingPr = useCallback(async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open pull request found.",
        data: threadToastData,
      });
      return;
    }
    void openPullRequestLink(api.shell, prUrl).catch((err: unknown) => {
      console.error(err);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: err instanceof Error ? err.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    });
  }, [gitStatusForActions, threadToastData]);

  runGitAction = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      filePaths,
    }: RunGitActionInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.refName ?? null;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      const includesCommit =
        actionCanCommit &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId = toastManager.add({
        type: "loading",
        title: progressStages[0] ?? "Running git action...",
        description: "Waiting for Git...",
        timeout: 0,
        data: scopedToastData,
      });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
        failedPhase: null,
      };

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `Running ${event.hookName}...`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Committing...";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Record which phase failed so the settled mutation below can
            // say "commit succeeded; push failed" instead of a bare
            // "Action failed"; the toast itself is still published there to
            // avoid a transient intermediate state before the final message.
            progress.failedPhase = event.phase;
            return;
        }

        updateActiveProgressToast();
      };

      const result = await runImmediateGitAction.run({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: applyProgressEvent,
      });

      const finishedProgress = activeGitActionProgressRef.current;
      activeGitActionProgressRef.current = null;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(resolvedProgressToastId);
          return;
        }

        // A failed action can still have landed a partial result (e.g.
        // commit_push commits locally, then fails to push). Refresh VCS
        // status immediately so the header/panel reflect that instead of
        // showing stale "clean" or "nothing to push" state.
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);

        const error = squashAtomCommandFailure(result);
        const errorMessage = error instanceof Error ? error.message : "An error occurred.";
        const failedPhase = finishedProgress?.failedPhase ?? null;
        // Only a reported phase strictly after "commit" implies the commit
        // itself landed; "branch"/"commit"/unreported failures mean nothing
        // was committed, so fall back to the generic message.
        const commitLikelyLanded =
          includesCommit && (action === "commit_push" || action === "commit_push_pr");
        const description =
          commitLikelyLanded && (failedPhase === "push" || failedPhase === "pr")
            ? `Commit succeeded; ${describeGitActionPhase(failedPhase)} failed: ${errorMessage}`
            : errorMessage;
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description,
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
        return;
      }

      const actionResult = result.value;
      syncThreadBranchAfterGitAction(actionResult);
      const closeResultToast = () => {
        toastManager.close(resolvedProgressToastId);
      };

      const toastCta = actionResult.toast.cta;
      let toastActionProps: {
        children: string;
        onClick: () => void;
      } | null = null;
      if (toastCta.kind === "run_action") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            closeResultToast();
            void runGitAction({
              action: toastCta.action.kind,
            });
          },
        };
      } else if (toastCta.kind === "open_pr") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            const api = readLocalApi();
            if (!api) return;
            closeResultToast();
            void api.shell.openExternal(toastCta.url);
          },
        };
      }

      const successToastData = {
        ...scopedToastData,
        dismissAfterVisibleMs: 10_000,
      };

      if (toastActionProps) {
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "success",
            title: actionResult.toast.title,
            description: actionResult.toast.description,
            timeout: 0,
            actionProps: toastActionProps,
            data: successToastData,
          }),
        );
      } else {
        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: actionResult.toast.title,
          description: actionResult.toast.description,
          timeout: 0,
          data: successToastData,
        });
      }
    },
  );

  const confirmPendingDefaultBranchAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitAction({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction, runGitAction]);

  const checkoutFeatureBranchForPendingAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitAction({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction, runGitAction]);

  const cancelPendingDefaultBranchAction = useCallback(() => {
    setPendingDefaultBranchAction(null);
  }, []);

  const runPull = useCallback(async () => {
    const toastId = toastManager.add({
      type: "loading",
      title: "Pulling...",
      timeout: 0,
      data: threadToastData,
    });
    const result = await pullAction.run();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "error",
          title: "Pull failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
      return;
    }

    const pullResult = result.value;
    toastManager.update(toastId, {
      type: "success",
      title: pullResult.status === "pulled" ? "Pulled" : "Already up to date",
      description:
        pullResult.status === "pulled"
          ? `Updated ${pullResult.refName} from ${pullResult.upstreamRef ?? "upstream"}`
          : `${pullResult.refName} is already synchronized.`,
      data: threadToastData,
    });
  }, [pullAction, threadToastData]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void (async () => {
        const result = await openInPreferredEditor(target);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })();
    },
    [gitCwd, openInPreferredEditor, threadToastData],
  );

  const initializeRepository = useCallback(async () => {
    const result = await initAction.run();
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
      return;
    }
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Git initialization failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        ...(threadToastData !== undefined ? { data: threadToastData } : {}),
      }),
    );
  }, [initAction, threadToastData]);

  const refreshGitStatus = useCallback(() => {
    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
  }, [activeEnvironmentId, gitCwd, refreshVcsStatus]);

  const canPublishRepository = isRepo && gitStatusForActions !== null && !hasPrimaryRemote;

  return {
    activeEnvironmentId,
    gitStatus: gitStatusForActions ?? null,
    gitStatusError,
    isRepo,
    hasPrimaryRemote,
    isDefaultRef,
    sourceControlPresentation,
    changeRequestTerminology,
    isGitActionRunning,
    quickAction,
    menuItems,
    canPublishRepository,
    isInitializingRepository: initAction.isPending,
    initializeRepository,
    isPulling: pullAction.isPending,
    runPull,
    runGitAction,
    openExistingPr,
    openChangedFileInEditor,
    pendingDefaultBranchAction,
    confirmPendingDefaultBranchAction,
    checkoutFeatureBranchForPendingAction,
    cancelPendingDefaultBranchAction,
    refreshGitStatus,
    threadToastData,
  };
}

export type GitActionsController = ReturnType<typeof useGitActionsController>;
