import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectBoardSchema,
  SymphonyProjectId,
  WorkItemId,
  type SymphonyProject,
  type WorkItem,
  type WorkLifecycle,
} from "@neokod/contracts";

import { boardColumnForLifecycle, projectBoardFromWorkItems } from "./ProjectBoard.ts";

const decodeProjectBoard = Schema.decodeUnknownSync(SymphonyProjectBoardSchema);

describe("boardColumnForLifecycle", () => {
  it("maps every lifecycle into the five server-owned columns", () => {
    const expected: Record<WorkLifecycle, ReturnType<typeof boardColumnForLifecycle>> = {
      draft: "not_started",
      ineligible: "not_started",
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
    eligibilityReasons: ReadonlyArray<string> = [],
  ): WorkItem => ({
    id: WorkItemId.make(id),
    mode: "symphony",
    projectId: project.id,
    objective: id,
    acceptanceCriteria: [],
    source,
    lifecycle,
    priority,
    eligibilityReasons,
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

  it("links a card to its latest run attempt only when the item has one", () => {
    const board = projectBoardFromWorkItems({
      project,
      sourceControl: { state: "none" },
      workItems: [workItem("with-run", "queued", 1), workItem("without-run", "queued", 2)],
      latestRunAttemptIds: new Map([["with-run", RunAttemptId.make("run-latest")]]),
      generatedAt: "2026-08-10T00:01:00.000Z",
    });

    const cards = board.columns[0]?.cards ?? [];
    expect(
      cards.find((card) => card.workItemId === WorkItemId.make("with-run"))?.latestRunAttemptId,
    ).toBe(RunAttemptId.make("run-latest"));
    expect(
      cards.find((card) => card.workItemId === WorkItemId.make("without-run"))?.latestRunAttemptId,
    ).toBeUndefined();
  });

  it("shows ineligible cards in Not Started with their eligibility reasons", () => {
    const board = projectBoardFromWorkItems({
      project,
      sourceControl: { state: "none" },
      workItems: [
        workItem("ineligible", "ineligible", 1, { kind: "manual" }, ["missing_label:agent-ready"]),
        workItem("queued", "queued", 2),
      ],
      generatedAt: "2026-08-10T00:01:00.000Z",
    });

    const cards = board.columns[0]?.cards ?? [];
    expect(cards.find((card) => card.workItemId === WorkItemId.make("ineligible"))).toMatchObject({
      lifecycle: "ineligible",
      eligibilityReasons: ["missing_label:agent-ready"],
    });
    expect(
      cards.find((card) => card.workItemId === WorkItemId.make("queued"))?.eligibilityReasons,
    ).toBeUndefined();
  });

  it("reports exact column totals and truncation from actual lifecycle counts", () => {
    const board = projectBoardFromWorkItems({
      project,
      sourceControl: { state: "none" },
      workItems: [
        workItem("completed", "completed", 1),
        workItem("queued-first", "queued", 1),
        workItem("queued-second", "queued", 2),
      ],
      lifecycleTotals: { completed: 5, queued: 2 },
      generatedAt: "2026-08-10T00:01:00.000Z",
    });

    expect(board.columns.find((column) => column.id === "done")?.totalCount).toBe(5);
    expect(board.columns.find((column) => column.id === "not_started")?.totalCount).toBe(2);
    expect(board.truncated).toBe(true);

    const complete = projectBoardFromWorkItems({
      project,
      sourceControl: { state: "none" },
      workItems: [
        workItem("completed", "completed", 1),
        workItem("queued-first", "queued", 1),
        workItem("queued-second", "queued", 2),
      ],
      lifecycleTotals: { completed: 1, queued: 2 },
      generatedAt: "2026-08-10T00:01:00.000Z",
    });

    expect(complete.truncated).toBe(false);
  });

  it("omits coverage metadata when lifecycle totals are unavailable", () => {
    const board = projectBoardFromWorkItems({
      project,
      sourceControl: { state: "none" },
      workItems: [workItem("completed", "completed", 1), workItem("queued", "queued", 2)],
      generatedAt: "2026-08-10T00:01:00.000Z",
    });

    expect(board.truncated).toBeUndefined();
    expect(board.columns.every((column) => column.totalCount === undefined)).toBe(true);
  });

  it("decodes a board payload from before coverage metadata", () => {
    const board = projectBoardFromWorkItems({
      project,
      sourceControl: { state: "none" },
      workItems: [workItem("queued", "queued", 1)],
      lifecycleTotals: { queued: 1 },
      generatedAt: "2026-08-10T00:01:00.000Z",
    });
    const { truncated: _truncated, ...legacyBoard } = board;
    const legacyPayload = {
      ...legacyBoard,
      columns: board.columns.map(({ totalCount: _totalCount, ...column }) => column),
    };

    const decoded = decodeProjectBoard(legacyPayload);

    expect(decoded.truncated).toBeUndefined();
    expect(decoded.columns.every((column) => column.totalCount === undefined)).toBe(true);
  });
});
