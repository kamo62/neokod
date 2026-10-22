import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@neokod/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@neokod/contracts";
import { worktreeGitStatesMatch, worktreeRequiresForce } from "@neokod/shared/git";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { readLocalApi } from "../localApi";
import { readEnvironmentThreadRefs, readProject, readThreadShell } from "../state/entities";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import {
  finalizeThreadDeletion,
  planWorktreeCleanup,
  toWorktreeRemovalState,
  unknownWorktreeRemovalMessage,
} from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import { useAtomCommand } from "../state/use-atom-command";

export class ThreadArchiveBlockedError extends Schema.TaggedErrorClass<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Cannot archive a running thread.";
  }
}

let lastArchivedThreadRef: ScopedThreadRef | null = null;

export interface WorktreeCleanupCandidate {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectCwd: string;
  worktreePath: string;
}

type WorktreeCleanupFailure = AsyncResult.Failure<unknown, unknown>;

function asCleanupFailure(result: {
  readonly _tag: "Success" | "Failure" | "Initial";
  readonly cause?: Cause.Cause<unknown>;
}): WorktreeCleanupFailure | null {
  return result._tag === "Failure" && result.cause !== undefined
    ? AsyncResult.failure(result.cause)
    : null;
}

export function useThreadActions() {
  const closeTerminal = useAtomCommand(terminalEnvironment.close);
  const archiveThreadMutation = useAtomCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useAtomCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useAtomCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const inspectWorktree = useAtomCommand(vcsEnvironment.inspectWorktree, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const unarchiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const result = await unarchiveThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success") {
        if (
          lastArchivedThreadRef?.environmentId === target.environmentId &&
          lastArchivedThreadRef.threadId === target.threadId
        ) {
          lastArchivedThreadRef = null;
        }
        refreshArchivedThreadsForEnvironment(target.environmentId);
      }
      return result;
    },
    [unarchiveThreadMutation],
  );

  const archiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const resolved = resolveThreadTarget(target);
      if (!resolved) return AsyncResult.success(undefined);
      const { thread, threadRef } = resolved;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadArchiveBlockedError({
              environmentId: threadRef.environmentId,
              threadId: threadRef.threadId,
            }),
          ),
        );
      }

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToDraft =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const archiveResult = await archiveThreadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (archiveResult._tag === "Failure") {
        return archiveResult;
      }

      lastArchivedThreadRef = threadRef;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Thread archived",
          description: thread.title || undefined,
          actionVariant: "outline",
          actionProps: {
            children: "Undo",
            onClick: () => {
              void unarchiveThread(threadRef).then((result) => {
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  const error = squashAtomCommandFailure(result);
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Failed to undo archive",
                      description: error instanceof Error ? error.message : "An error occurred.",
                    }),
                  );
                }
              });
            },
          },
        }),
      );

      if (shouldNavigateToDraft) {
        const navigationResult = await settlePromise(() =>
          handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId)),
        );
        if (navigationResult._tag === "Failure") {
          return navigationResult;
        }
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
        return archiveResult;
      }

      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      return archiveResult;
    },
    [archiveThreadMutation, getCurrentRouteThreadRef, resolveThreadTarget, unarchiveThread],
  );

  const reopenLastArchivedThread = useCallback(async () => {
    const target = lastArchivedThreadRef;
    if (!target) return;

    const result = await unarchiveThread(target);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to reopen archived thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }

    const navigationResult = await settlePromise(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target),
      }),
    );
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Thread reopened, but navigation failed",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [router, unarchiveThread]);

  const readWorktreeCleanupCandidate = useCallback(
    (target: ScopedThreadRef): WorktreeCleanupCandidate | null => {
      const thread = readThreadShell(target);
      if (!thread) return null;
      const worktreePath = thread.worktreePath?.trim();
      if (!worktreePath) return null;
      const project = readProject({
        environmentId: target.environmentId,
        projectId: thread.projectId,
      });
      if (!project) return null;
      return {
        environmentId: target.environmentId,
        threadId: target.threadId,
        projectCwd: project.workspaceRoot,
        worktreePath,
      };
    },
    [],
  );

  const cleanupWorktrees = useCallback(
    async (candidates: readonly WorktreeCleanupCandidate[]) => {
      const groups = new Map<string, WorktreeCleanupCandidate[]>();
      for (const candidate of candidates) {
        const key = `${candidate.environmentId}\u0000${candidate.worktreePath}`;
        const group = groups.get(key);
        if (group) {
          group.push(candidate);
        } else {
          groups.set(key, [candidate]);
        }
      }

      let firstFailure: WorktreeCleanupFailure | null = null;
      for (const group of groups.values()) {
        const candidate = group[0]!;
        const inspectResult = await inspectWorktree({
          environmentId: candidate.environmentId,
          input: {
            cwd: candidate.projectCwd,
            path: candidate.worktreePath,
            excludeThreadIds: group.map((item) => item.threadId),
          },
        });
        if (inspectResult._tag !== "Success") {
          if (!isAtomCommandInterrupted(inspectResult)) {
            const error = squashAtomCommandFailure(inspectResult);
            toastManager.add(
              stackedThreadToast({
                type: "info",
                title: "Worktree kept",
                description: `Could not inspect ${candidate.worktreePath}. ${error instanceof Error ? error.message : "An error occurred."}`,
              }),
            );
          }
          firstFailure ??= asCleanupFailure(inspectResult);
          continue;
        }

        let inspection = inspectResult.value;
        let plan = planWorktreeCleanup(inspection);
        if (plan.kind === "keep") {
          continue;
        }

        let removed = false;
        let removalFailure: WorktreeCleanupFailure | null = null;
        let outcomeUnknown = false;
        // A link or commit can appear while the dialogs are open. The server
        // rejects that stale evidence; re-inspect and ask again once.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (plan.kind !== "prompt") {
            break;
          }
          const promptPlan = plan;
          const localApi = readLocalApi();
          if (!localApi) {
            break;
          }
          const confirmed = await settlePromise(() =>
            localApi.dialogs.confirm(promptPlan.confirmMessage),
          );
          if (confirmed._tag === "Failure") {
            firstFailure ??= asCleanupFailure(confirmed);
            break;
          }
          if (!confirmed.value) {
            break;
          }
          if (promptPlan.discardMessage !== null) {
            const discarded = await settlePromise(() =>
              localApi.dialogs.confirm(promptPlan.discardMessage!),
            );
            if (discarded._tag === "Failure") {
              firstFailure ??= asCleanupFailure(discarded);
              break;
            }
            if (!discarded.value) {
              break;
            }
          }

          const removeResult = await removeWorktree({
            environmentId: candidate.environmentId,
            input: {
              cwd: candidate.projectCwd,
              path: candidate.worktreePath,
              force: worktreeRequiresForce(inspection),
              confirmLoss: promptPlan.discardMessage !== null,
              deleteBranch: true,
              expectedState: toWorktreeRemovalState(inspection),
            },
          });
          if (removeResult._tag === "Success") {
            removed = true;
            break;
          }
          removalFailure = asCleanupFailure(removeResult);

          const reinspectResult = await inspectWorktree({
            environmentId: candidate.environmentId,
            input: {
              cwd: candidate.projectCwd,
              path: candidate.worktreePath,
              excludeThreadIds: group.map((item) => item.threadId),
            },
          });
          if (reinspectResult._tag !== "Success") {
            outcomeUnknown = true;
            toastManager.add(
              stackedThreadToast({
                type: "info",
                title: "Worktree removal not confirmed",
                description: unknownWorktreeRemovalMessage(candidate.worktreePath),
              }),
            );
            break;
          }
          if (!reinspectResult.value.exists) {
            // The path is gone: the removal either succeeded or was already
            // complete. Do not present the missing acknowledgement as failure.
            removed = true;
            break;
          }
          const nextPlan = planWorktreeCleanup(reinspectResult.value);
          if (nextPlan.kind === "keep") {
            toastManager.add(
              stackedThreadToast({
                type: "info",
                title: "Worktree kept",
                description: `Another thread now uses ${candidate.worktreePath}. The worktree was kept.`,
              }),
            );
            break;
          }
          if (
            worktreeGitStatesMatch(
              toWorktreeRemovalState(inspection),
              toWorktreeRemovalState(reinspectResult.value),
            )
          ) {
            break;
          }
          inspection = reinspectResult.value;
          plan = nextPlan;
        }

        if (removed) {
          const refreshResult = await refreshVcsStatus({
            environmentId: candidate.environmentId,
            input: { cwd: candidate.projectCwd },
          });
          if (refreshResult._tag === "Failure") {
            firstFailure ??= asCleanupFailure(refreshResult);
          }
        } else if (removalFailure && !outcomeUnknown) {
          const error = squashAtomCommandFailure(removalFailure);
          const message =
            error instanceof Error ? error.message : "Unknown error removing worktree.";
          console.error("Failed to remove orphaned worktree after thread deletion", {
            threadId: candidate.threadId,
            projectCwd: candidate.projectCwd,
            worktreePath: candidate.worktreePath,
            error,
          });
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread deleted, but worktree removal failed",
              description: `The worktree was kept at ${candidate.worktreePath}. ${message}`,
            }),
          );
          firstFailure ??= removalFailure;
        }
      }
      return firstFailure;
    },
    [inspectWorktree, refreshVcsStatus, removeWorktree],
  );

  const deleteThread = useCallback(
    async (
      target: ScopedThreadRef,
      opts: { deletedThreadKeys?: ReadonlySet<string>; deferWorktreeCleanup?: boolean } = {},
    ) => {
      const resolved = resolveThreadTarget(target);
      if (!resolved) {
        // Thread not in main store (e.g. archived thread) — dispatch delete directly.
        const result = await deleteThreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        if (result._tag === "Success") {
          refreshArchivedThreadsForEnvironment(target.environmentId);
        }
        return result;
      }
      const { thread, threadRef } = resolved;
      const candidate = readWorktreeCleanupCandidate(threadRef);
      const threads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [shell];
      });
      const deletedIds =
        opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
          ? new Set<ThreadId>(
              [...opts.deletedThreadKeys].flatMap((threadKey) => {
                const ref = parseScopedThreadKey(threadKey);
                return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
              }),
            )
          : undefined;

      if (thread.session && thread.session.status !== "stopped") {
        await stopThreadSession({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        });
      }

      await closeTerminal({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, deleteHistory: true },
      });

      const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToFallback =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadRef.threadId,
        deletedThreadIds,
        sortOrder: sidebarThreadSortOrder,
      });
      const deleteResult = await deleteThreadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (deleteResult._tag === "Failure") {
        return deleteResult;
      }
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      clearComposerDraftForThread(threadRef);
      clearProjectDraftThreadById(
        scopeProjectRef(threadRef.environmentId, thread.projectId),
        threadRef,
      );
      clearTerminalUiState(threadRef);

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          const fallbackThread = readThreadShell(
            scopeThreadRef(threadRef.environmentId, fallbackThreadId),
          );
          if (fallbackThread) {
            const navigationResult = await settlePromise(() =>
              router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
                ),
                replace: true,
              }),
            );
            if (navigationResult._tag === "Failure") {
              return navigationResult;
            }
          } else {
            const navigationResult = await settlePromise(() =>
              router.navigate({ to: "/", replace: true }),
            );
            if (navigationResult._tag === "Failure") {
              return navigationResult;
            }
          }
        } else {
          const navigationResult = await settlePromise(() =>
            router.navigate({ to: "/", replace: true }),
          );
          if (navigationResult._tag === "Failure") {
            return navigationResult;
          }
        }
      }

      if (opts.deferWorktreeCleanup || candidate === null) {
        return deleteResult;
      }
      // The thread is deleted. Cleanup reports its own warning and keeps the
      // worktree on failure; it must not be reported as a failed deletion.
      const outcome = await finalizeThreadDeletion({
        deletion: deleteResult,
        deletionSucceeded: true,
        candidates: [candidate],
        cleanup: cleanupWorktrees,
      });
      return outcome.deletion;
    },
    [
      cleanupWorktrees,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalUiState,
      closeTerminal,
      deleteThreadMutation,
      getCurrentRouteThreadRef,
      readWorktreeCleanupCandidate,
      router,
      resolveThreadTarget,
      sidebarThreadSortOrder,
      stopThreadSession,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);

      if (confirmThreadDelete && localApi) {
        const title = resolved?.thread.title ?? "this thread";
        const confirmationResult = await settlePromise(() =>
          localApi.dialogs.confirm(
            [
              `Delete thread "${title}"?`,
              "This permanently clears conversation history for this thread.",
            ].join("\n"),
          ),
        );
        if (confirmationResult._tag === "Failure") {
          return confirmationResult;
        }
        if (!confirmationResult.value) {
          return AsyncResult.success(undefined);
        }
      }

      return deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  return useMemo(
    () => ({
      archiveThread,
      unarchiveThread,
      reopenLastArchivedThread,
      deleteThread,
      confirmAndDeleteThread,
      readWorktreeCleanupCandidate,
      cleanupWorktrees,
    }),
    [
      archiveThread,
      cleanupWorktrees,
      confirmAndDeleteThread,
      deleteThread,
      readWorktreeCleanupCandidate,
      reopenLastArchivedThread,
      unarchiveThread,
    ],
  );
}
