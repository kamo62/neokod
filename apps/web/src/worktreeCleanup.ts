import type { VcsInspectWorktreeResult } from "@neokod/contracts";

import type { ThreadShell } from "./types";

export type WorktreeCleanupPlan =
  | { readonly kind: "keep" }
  | {
      readonly kind: "prompt";
      readonly confirmMessage: string;
      readonly discardMessage: string | null;
    };

function pluralSuffix(count: number): string {
  return count === 1 ? "" : "s";
}

export function planWorktreeCleanup(inspect: VcsInspectWorktreeResult): WorktreeCleanupPlan {
  if (inspect.linkedThreads.length > 0) {
    return { kind: "keep" };
  }

  const dirty = inspect.changedFileCount + inspect.untrackedFileCount > 0;
  const lostCommits = inspect.refName === null && inspect.localOnlyCommitCount > 0;
  const confirmLines = ["This thread is the only one linked to this worktree:", inspect.path];

  if (inspect.refName !== null) {
    if (inspect.branchReclaimable) {
      confirmLines.push(`Branch ${inspect.refName} will be deleted too.`);
    } else if (inspect.localOnlyCommitCount > 0) {
      const count = inspect.localOnlyCommitCount;
      confirmLines.push(
        `Branch ${inspect.refName} is kept (${count} commit${pluralSuffix(count)} exist only on it).`,
      );
    } else {
      confirmLines.push(`Branch ${inspect.refName} is kept.`);
    }
  } else if (inspect.localOnlyCommitCount > 0) {
    const count = inspect.localOnlyCommitCount;
    confirmLines.push(`Detached HEAD (${count} commit${pluralSuffix(count)} exist only here).`);
  }

  if (dirty) {
    confirmLines.push(
      `Uncommitted work: ${inspect.changedFileCount} changed file${pluralSuffix(inspect.changedFileCount)}, ${inspect.untrackedFileCount} untracked file${pluralSuffix(inspect.untrackedFileCount)}.`,
    );
  }
  confirmLines.push("", "Delete the worktree too?");

  let discardMessage: string | null = null;
  if (dirty || lostCommits) {
    const lossParts: string[] = [];
    if (inspect.changedFileCount > 0) {
      lossParts.push(
        `${inspect.changedFileCount} changed file${pluralSuffix(inspect.changedFileCount)}`,
      );
    }
    if (inspect.untrackedFileCount > 0) {
      lossParts.push(
        `${inspect.untrackedFileCount} untracked file${pluralSuffix(inspect.untrackedFileCount)}`,
      );
    }
    if (lostCommits) {
      lossParts.push(
        `${inspect.localOnlyCommitCount} commit${pluralSuffix(inspect.localOnlyCommitCount)} not on any branch`,
      );
    }
    discardMessage = `Discard unsaved work in ${inspect.path}?\n${lossParts.join(", ")}. This cannot be undone.`;
  }

  return {
    kind: "prompt",
    confirmMessage: confirmLines.join("\n"),
    discardMessage,
  };
}

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
