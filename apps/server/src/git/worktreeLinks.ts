import {
  GitCommandError,
  type OrchestrationReadModel,
  type VcsWorktreeLinkedThread,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";

import {
  isWorkspaceSameOrInside,
  type WorkspaceIdentityEvidence,
} from "../vcs/WorkspaceIdentity.ts";

export { worktreeGitStatesMatch, worktreeHasLoss, worktreeRequiresForce } from "@neokod/shared/git";

/**
 * Find every surviving thread whose effective workspace is the target
 * worktree or lives inside it. The effective workspace is
 * `worktreePath ?? project.workspaceRoot`, matching the server's workspace
 * resolution. Identity is an inode-backed physical object so aliases and
 * symlinked parents compare equal.
 */
export const findThreadsUsingWorktree = Effect.fn("findThreadsUsingWorktree")(function* (input: {
  readModel: Pick<OrchestrationReadModel, "threads" | "projects">;
  targetIdentity: WorkspaceIdentityEvidence;
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
    const inside = yield* isWorkspaceSameOrInside({
      target: input.targetIdentity,
      candidatePath: workspacePath,
    }).pipe(
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
    if (inside) {
      linked.push({ threadId: thread.id, title: thread.title });
    }
  }
  return linked;
});
