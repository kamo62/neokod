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
export function recoveryRefForThreadRevert(threadId: ThreadId, epochMillis: number): CheckpointRef {
  return CheckpointRef.make(
    `${RECOVERY_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/${epochMillis}`,
  );
}

const trimTrailingSeparators = (value: string): string => value.replace(/[\\/]+$/, "");

/**
 * Threads, other than `threadId`, whose provider session is starting or running
 * in `cwd`.
 *
 * The comparison is normalized string equality (trailing separators are
 * trimmed). It does not resolve symlinks, `..` segments, case differences on a
 * case-insensitive filesystem, or bind mounts, and it cannot observe writers
 * outside Neokod.
 */
export function findActiveSessionsSharingCwd(input: {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly sessions: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly cwd?: string | undefined;
    readonly status: string;
  }>;
}): ReadonlyArray<ThreadId> {
  const target = trimTrailingSeparators(input.cwd);
  return input.sessions
    .filter(
      (session) =>
        session.threadId !== input.threadId &&
        (session.status === "running" || session.status === "connecting") &&
        session.cwd !== undefined &&
        trimTrailingSeparators(session.cwd) === target,
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
