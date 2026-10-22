import type { OrchestrationCommand, OrchestrationReadModel } from "@neokod/contracts";

/**
 * Effective workspaces an orchestration command can attach or expose. The
 * order is not significant; duplicates are harmless.
 */
export function admissionWorkspacePaths(
  command: OrchestrationCommand,
  readModel: Pick<OrchestrationReadModel, "projects" | "threads">,
): readonly string[] {
  const projectWorkspaceRoot = (projectId: string): string | null =>
    readModel.projects.find((project) => project.id === projectId)?.workspaceRoot ?? null;

  switch (command.type) {
    case "project.create":
      return [command.workspaceRoot];
    case "project.meta.update":
      return command.workspaceRoot === undefined ? [] : [command.workspaceRoot];
    case "thread.create":
      return [command.worktreePath ?? projectWorkspaceRoot(command.projectId)].filter(
        (value): value is string => value !== null,
      );
    case "thread.meta.update": {
      if (command.worktreePath === undefined) {
        return [];
      }
      if (command.worktreePath !== null) {
        return [command.worktreePath];
      }
      const thread = readModel.threads.find((candidate) => candidate.id === command.threadId);
      const projectRoot = thread ? projectWorkspaceRoot(thread.projectId) : null;
      return projectRoot === null ? [] : [projectRoot];
    }
    default:
      return [];
  }
}
