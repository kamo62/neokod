import type {
  SymphonyBoardColumnId,
  SymphonyBoardCard,
  SymphonyBoardColumn,
  SymphonyProject,
  SymphonyProjectBoard,
  SymphonyProjectSourceControl,
  WorkItem,
  WorkLifecycle,
} from "@neokod/contracts";

export const boardColumnForLifecycle = (lifecycle: WorkLifecycle): SymphonyBoardColumnId => {
  switch (lifecycle) {
    case "draft":
    case "eligible":
    case "queued":
      return "not_started";
    case "preparing":
    case "running":
    case "blocked":
    case "waiting_for_approval":
    case "retry_scheduled":
    case "changes_requested":
      return "in_progress";
    case "testing":
    case "validation_failed":
      return "testing";
    case "ready_for_review":
    case "ready_to_merge":
      return "human_review";
    case "completed":
    case "cancelled":
    case "failed":
      return "done";
  }
};

export const projectBoardFromWorkItems = (input: {
  readonly project: SymphonyProject;
  readonly sourceControl: SymphonyProjectSourceControl;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly generatedAt: string;
}): SymphonyProjectBoard => {
  const columns: Array<Omit<SymphonyBoardColumn, "cards"> & { cards: SymphonyBoardCard[] }> = [
    { id: "not_started", title: "Not Started", cards: [] },
    { id: "in_progress", title: "In Progress", cards: [] },
    { id: "testing", title: "Testing", cards: [] },
    { id: "human_review", title: "PR / Human Review", cards: [] },
    { id: "done", title: "Done", cards: [] },
  ];
  const columnById = new Map(columns.map((column) => [column.id, column]));

  for (const item of input.workItems) {
    const columnId = boardColumnForLifecycle(item.lifecycle);
    columnById.get(columnId)?.cards.push({
      workItemId: item.id,
      projectId: input.project.id,
      ...(item.trackerIdentifier === undefined
        ? {}
        : { trackerIdentifier: item.trackerIdentifier }),
      title: item.objective,
      lifecycle: item.lifecycle,
      columnId,
      outcome:
        item.lifecycle === "completed" ||
        item.lifecycle === "cancelled" ||
        item.lifecycle === "failed"
          ? item.lifecycle
          : null,
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      ...(item.source.kind === "manual" || item.source.externalUrl.trim().length === 0
        ? {}
        : { issueUrl: item.source.externalUrl }),
      updatedAt: item.updatedAt,
    });
  }

  for (const column of columns) {
    column.cards.sort(
      (left, right) =>
        (left.priority ?? Number.POSITIVE_INFINITY) -
          (right.priority ?? Number.POSITIVE_INFINITY) ||
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.workItemId.localeCompare(right.workItemId),
    );
  }

  return {
    project: input.project,
    sourceControl: input.sourceControl,
    columns,
    generatedAt: input.generatedAt,
  };
};
