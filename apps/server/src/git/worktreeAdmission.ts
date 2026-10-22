import type { OrchestrationCommand, OrchestrationReadModel } from "@neokod/contracts";

export interface WorktreeAdmission {
  /** Effective workspaces this command can attach or expose. */
  readonly workspacePaths: readonly string[];
  /** Non-null worktree paths whose prepared identity must still hold. */
  readonly preparedWorktreePaths: readonly string[];
}

/**
 * Effective workspaces an orchestration command can attach or expose. The
 * order is not significant; duplicates are harmless.
 */
export function admissionWorkspacePaths(
  command: OrchestrationCommand,
  readModel: Pick<OrchestrationReadModel, "projects" | "threads">,
): WorktreeAdmission {
  const projectWorkspaceRoot = (projectId: string): string | null =>
    readModel.projects.find((project) => project.id === projectId)?.workspaceRoot ?? null;

  switch (command.type) {
    case "project.create":
      return { workspacePaths: [command.workspaceRoot], preparedWorktreePaths: [] };
    case "project.meta.update":
      return {
        workspacePaths: command.workspaceRoot === undefined ? [] : [command.workspaceRoot],
        preparedWorktreePaths: [],
      };
    case "thread.create": {
      const workspacePath = command.worktreePath ?? projectWorkspaceRoot(command.projectId);
      return {
        workspacePaths: workspacePath === null ? [] : [workspacePath],
        preparedWorktreePaths: command.worktreePath === null ? [] : [command.worktreePath],
      };
    }
    case "thread.meta.update": {
      if (command.worktreePath === undefined) {
        return { workspacePaths: [], preparedWorktreePaths: [] };
      }
      if (command.worktreePath !== null) {
        return {
          workspacePaths: [command.worktreePath],
          preparedWorktreePaths: [command.worktreePath],
        };
      }
      const thread = readModel.threads.find((candidate) => candidate.id === command.threadId);
      const projectRoot = thread ? projectWorkspaceRoot(thread.projectId) : null;
      return {
        workspacePaths: projectRoot === null ? [] : [projectRoot],
        preparedWorktreePaths: [],
      };
    }
    case "thread.turn.start": {
      const thread = readModel.threads.find((candidate) => candidate.id === command.threadId);
      if (!thread) {
        return { workspacePaths: [], preparedWorktreePaths: [] };
      }
      const workspacePath = thread.worktreePath ?? projectWorkspaceRoot(thread.projectId);
      return {
        workspacePaths: workspacePath === null ? [] : [workspacePath],
        preparedWorktreePaths: [],
      };
    }
    default:
      return { workspacePaths: [], preparedWorktreePaths: [] };
  }
}
