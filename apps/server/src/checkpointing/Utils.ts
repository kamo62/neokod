import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@neokod/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/neokod/checkpoints";

export const RECOVERY_REFS_PREFIX = "refs/neokod/recovery";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/**
 * Hidden ref that holds the workspace as it was just before a revert.
 *
 * Git ref names cannot contain `:`, so the timestamp is epoch milliseconds. The
 * thread id is base64url encoded for the same reason as a checkpoint ref.
 */
export function recoveryRefForThreadRevert(
  threadId: ThreadId,
  epochMillis: number,
  uniqueSuffix?: string,
): CheckpointRef {
  return CheckpointRef.make(
    `${RECOVERY_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/${epochMillis}${
      uniqueSuffix === undefined ? "" : `-${uniqueSuffix}`
    }`,
  );
}

const trimTrailingSeparators = (value: string): string => value.replace(/[\\/]+$/, "");

/** True when the provider session is starting or running, or reports an active turn. */
export function providerSessionHasActiveTurn(session: {
  readonly status: string;
  readonly activeTurnId?: string | null | undefined;
}): boolean {
  return (
    session.status === "running" ||
    session.status === "connecting" ||
    (session.activeTurnId !== undefined && session.activeTurnId !== null)
  );
}

const foldersOverlap = (left: string, right: string): boolean => {
  const normalizedLeft = trimTrailingSeparators(left);
  const normalizedRight = trimTrailingSeparators(right);
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return (
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedLeft.startsWith(`${normalizedRight}\\`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}\\`)
  );
};

/**
 * Threads whose provider session has an active turn in `cwd` or in a folder
 * that contains or is contained by `cwd`.
 *
 * `running` and `connecting` sessions count. A session that stays `ready`
 * while a turn is active, as Copilot and Cursor do, counts through its
 * `activeTurnId`. The reverting thread's own active turn also counts.
 *
 * The comparison is normalized string equality or prefix overlap (trailing
 * separators are trimmed). It does not resolve symlinks, `..` segments, case
 * differences on a case-insensitive filesystem, or bind mounts, and it cannot
 * observe writers outside Neokod.
 */
export function findActiveSessionsSharingCwd(input: {
  readonly cwd: string;
  readonly sessions: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly cwd?: string | undefined;
    readonly status: string;
    readonly activeTurnId?: string | null | undefined;
  }>;
}): ReadonlyArray<ThreadId> {
  return input.sessions
    .filter(
      (session) =>
        providerSessionHasActiveTurn(session) &&
        session.cwd !== undefined &&
        foldersOverlap(session.cwd, input.cwd),
    )
    .map((session) => session.threadId);
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
