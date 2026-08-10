import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SymphonyProjectId,
  WorkItemId,
  type SymphonyProject,
  type WorkItem,
  type WorkLifecycle,
} from "@neokod/contracts";

import { boardColumnForLifecycle, projectBoardFromWorkItems } from "./ProjectBoard.ts";

describe("boardColumnForLifecycle", () => {
  it("maps every lifecycle into the five server-owned columns", () => {
    const expected: Record<WorkLifecycle, ReturnType<typeof boardColumnForLifecycle>> = {
      draft: "not_started",
      eligible: "not_started",
      queued: "not_started",
      preparing: "in_progress",
      running: "in_progress",
      blocked: "in_progress",
      waiting_for_approval: "in_progress",
      retry_scheduled: "in_progress",
      changes_requested: "in_progress",
      testing: "testing",
      validation_failed: "testing",
      ready_for_review: "human_review",
      ready_to_merge: "human_review",
      completed: "done",
      cancelled: "done",
      failed: "done",
    };

    for (const [lifecycle, column] of Object.entries(expected)) {
      expect(boardColumnForLifecycle(lifecycle as WorkLifecycle)).toBe(column);
    }
  });
});

describe("projectBoardFromWorkItems", () => {
  const project: SymphonyProject = {
    id: SymphonyProjectId.make("project-1"),
    codeProjectId: ProjectId.make("code-project-1"),
    title: "Project",
    repositoryPath: "/repo/project",
    status: "paused",
    setupState: "ready",
    configuration: {
      tracker: { kind: "github", repository: "owner/repo" },
      trackerRequiredLabels: [],
      trackerActiveStates: ["open"],
      trackerTerminalStates: ["closed"],
      autonomy: "observe",
      agentProvider: {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
      },
      validationRequired: [],
      maxConcurrentAgents: 1,
      maxTurns: 20,
      maxAttempts: 3,
      approvalsBeforePush: false,
      approvalsBeforePullRequest: false,
      approvalsBeforeMerge: true,
    },
    revision: 0,
    legacyWorkflowId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };

  const workItem = (
    id: string,
    lifecycle: WorkLifecycle,
    priority: number,
    source: WorkItem["source"] = { kind: "manual" },
  ): WorkItem => ({
    id: WorkItemId.make(id),
    mode: "symphony",
    projectId: project.id,
    objective: id,
    acceptanceCriteria: [],
    source,
    lifecycle,
    priority,
    eligibilityReasons: [],
    evidence: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: `2026-08-10T00:00:0${priority}.000Z`,
  });

  it("builds ordered columns, outcomes, stable card order, and safe issue links", () => {
    const board = projectBoardFromWorkItems({
      project,
      sourceControl: { state: "none" },
      workItems: [
        workItem("completed", "completed", 3),
        workItem("failed", "failed", 2),
        workItem("cancelled", "cancelled", 1),
        workItem("later", "queued", 2),
        workItem("first", "queued", 1),
        workItem("blank-url", "queued", 3, {
          kind: "github",
          externalId: "3",
          externalUrl: "",
        }),
      ],
      generatedAt: "2026-08-10T00:01:00.000Z",
    });

    expect(board.columns.map((column) => column.id)).toEqual([
      "not_started",
      "in_progress",
      "testing",
      "human_review",
      "done",
    ]);
    expect(board.columns[0]?.cards.map((card) => card.workItemId)).toEqual([
      WorkItemId.make("first"),
      WorkItemId.make("later"),
      WorkItemId.make("blank-url"),
    ]);
    expect(board.columns[0]?.cards.every((card) => card.issueUrl === undefined)).toBe(true);
    expect(board.columns[4]?.cards.map((card) => card.outcome)).toEqual([
      "cancelled",
      "failed",
      "completed",
    ]);
  });
});
