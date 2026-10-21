import {
  GitCommandError,
  type OrchestrationReadModel,
  type VcsWorktreeGitState,
  type VcsWorktreeLinkedThread,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";

import { resolveWorkspaceIdentity } from "../vcs/WorkspaceIdentity.ts";

/**
 * Find every surviving thread whose effective workspace is the target
 * worktree. The effective workspace is `worktreePath ?? project.workspaceRoot`,
 * matching the server's workspace resolution, and identity is a physical path
 * so aliases and symlinked parents compare equal.
 */
export const findThreadsUsingWorktree = Effect.fn("findThreadsUsingWorktree")(function* (input: {
  readModel: Pick<OrchestrationReadModel, "threads" | "projects">;
  targetIdentity: string;
  excludeThreadIds?: ReadonlySet<string>;
  operation: string;
  cwd: string;
}) {
  const projectsById = new Map(
    input.readModel.projects.map((project) => [project.id, project.workspaceRoot]),
  );
  const linked: VcsWorktreeLinkedThread[] = [];
  for (const thread of input.readModel.threads) {
    if (thread.deletedAt !== null) continue;
    if (input.excludeThreadIds?.has(thread.id)) continue;
    const workspacePath = thread.worktreePath ?? projectsById.get(thread.projectId) ?? null;
    if (workspacePath === null) continue;
    const identity = yield* resolveWorkspaceIdentity(workspacePath).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: input.operation,
            command: "resolve workspace identity",
            cwd: input.cwd,
            detail: `Unable to resolve the workspace for thread ${thread.id}.`,
            cause,
          }),
      ),
    );
    if (identity === input.targetIdentity) {
      linked.push({ threadId: thread.id, title: thread.title });
    }
  }
  return linked;
});

export function worktreeGitStatesMatch(
  expected: VcsWorktreeGitState,
  actual: VcsWorktreeGitState,
): boolean {
  return (
    expected.exists === actual.exists &&
    expected.refName === actual.refName &&
    expected.headSha === actual.headSha &&
    expected.changedFileCount === actual.changedFileCount &&
    expected.untrackedFileCount === actual.untrackedFileCount &&
    expected.ignoredFileCount === actual.ignoredFileCount &&
    expected.localOnlyCommitCount === actual.localOnlyCommitCount &&
    expected.branchReclaimable === actual.branchReclaimable
  );
}

export function worktreeStateHasLoss(state: VcsWorktreeGitState): boolean {
  return (
    state.exists &&
    (state.changedFileCount > 0 ||
      state.untrackedFileCount > 0 ||
      state.ignoredFileCount > 0 ||
      state.localOnlyCommitCount > 0)
  );
}
