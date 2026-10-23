import {
  AttentionItemId,
  EnvironmentId,
  RunAttemptId,
  SymphonyProjectId,
  WorkItemId,
  type AttentionItem,
  type RunAttemptStatus,
  type SymphonyBoardCard,
  type WorkItem,
  type WorkLifecycle,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectSymphonyWorkCollection,
  projectSymphonyWorkItem,
  type SymphonyWorkAttemptFact,
  type SymphonyWorkCollectionInput,
  type SymphonyWorkCoverage,
  type SymphonyWorkEvidence,
  type SymphonyWorkItemInput,
  type SymphonyWorkItemProjection,
} from "./symphonyWork.logic";

const environmentId = EnvironmentId.make("env-1");
const projectId = SymphonyProjectId.make("project-1");
const otherProjectId = SymphonyProjectId.make("project-2");
const workItemId = WorkItemId.make("wi-1");
const otherWorkItemId = WorkItemId.make("wi-old");
const firstRunId = RunAttemptId.make("run-1");
const secondRunId = RunAttemptId.make("run-2");
const createdAt = "2026-10-23T08:00:00.000Z";

const exhaustive: SymphonyWorkCoverage = { state: "exhaustive" };
const cappedCoverage: SymphonyWorkCoverage = {
  state: "unknown",
  reason: "The server does not report completeness for this read.",
};

const known = <A>(value: A): SymphonyWorkEvidence<A> => ({ state: "known", value });

function boardCard(
  overrides: Partial<SymphonyBoardCard> & { readonly lifecycle: WorkLifecycle },
): SymphonyBoardCard {
  const { lifecycle, ...rest } = overrides;
  const outcome =
    lifecycle === "completed" || lifecycle === "cancelled" || lifecycle === "failed"
      ? lifecycle
      : null;
  return {
    workItemId,
    projectId,
    title: "Fix the thing",
    columnId: "in_progress",
    outcome,
    updatedAt: createdAt,
    ...rest,
    lifecycle,
  };
}

function attemptFact(
  runAttemptId: RunAttemptId,
  status: RunAttemptStatus,
  overrides: Partial<SymphonyWorkAttemptFact> = {},
): SymphonyWorkAttemptFact {
  return {
    runAttemptId,
    workItemId,
    attemptNumber: 1,
    status,
    startedAt: "2026-10-23T09:00:00.000Z",
    ...overrides,
  };
}

function attentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: AttentionItemId.make("att-1"),
    workItemId,
    kind: "agent_question",
    severity: "high",
    state: "open",
    whatHappened: "The agent asked a question.",
    whyHuman: "The agent is waiting for your answer.",
    availableActions: ["answer"],
    createdAt,
    resolvedAt: null,
    ...overrides,
  };
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: workItemId,
    mode: "symphony",
    objective: "Fix the thing",
    acceptanceCriteria: [],
    source: { kind: "manual" },
    lifecycle: "draft",
    eligibilityReasons: [],
    evidence: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function itemInput(overrides: Partial<SymphonyWorkItemInput> = {}): SymphonyWorkItemInput {
  return {
    environmentId,
    workItemId,
    projectId,
    card: known(boardCard({ lifecycle: "draft" })),
    runs: known({ runs: [], coverage: exhaustive }),
    attention: known({ items: [], coverage: exhaustive }),
    ...overrides,
  };
}

function projection(overrides: Partial<SymphonyWorkItemInput> = {}): SymphonyWorkItemProjection {
  return projectSymphonyWorkItem(itemInput(overrides));
}

function startAction(value: SymphonyWorkItemProjection) {
  return value.actions.find((action) => action.kind === "start" || action.kind === "run_again");
}

function cancelActions(value: SymphonyWorkItemProjection) {
  return value.actions.filter((action) => action.kind === "cancel");
}

function collectionInput(
  overrides: Partial<SymphonyWorkCollectionInput> = {},
): SymphonyWorkCollectionInput {
  return {
    environmentId,
    projectId,
    board: known({
      cards: [],
      coverage: exhaustive,
      generatedAt: createdAt,
    }),
    runs: known({ runs: [], coverage: cappedCoverage }),
    attention: known({ items: [], coverage: cappedCoverage }),
    ...overrides,
  };
}

describe("projectSymphonyWorkItem lifecycle", () => {
  it.each([
    {
      lifecycle: "draft",
      phase: "not_started",
      reason: "draft",
      execution: "not_observed",
      inProgress: false,
      notStarted: true,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "ineligible",
      phase: "not_started",
      reason: "ineligible",
      execution: "not_observed",
      inProgress: false,
      notStarted: true,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "queued",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "available",
      startKind: "start",
    },
    {
      lifecycle: "preparing",
      phase: "in_progress",
      execution: "observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "running",
      phase: "in_progress",
      execution: "observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "testing",
      phase: "in_progress",
      execution: "observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "blocked",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "waiting_for_approval",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "retry_scheduled",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "available",
      startKind: "start",
    },
    {
      lifecycle: "validation_failed",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "available",
      startKind: "run_again",
    },
    {
      lifecycle: "ready_for_review",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "changes_requested",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "available",
      startKind: "run_again",
    },
    {
      lifecycle: "ready_to_merge",
      phase: "in_progress",
      execution: "not_observed",
      inProgress: true,
      notStarted: false,
      history: false,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "completed",
      phase: "finished",
      execution: "not_observed",
      inProgress: false,
      notStarted: false,
      history: true,
      startState: "blocked",
      startKind: "start",
    },
    {
      lifecycle: "cancelled",
      phase: "finished",
      execution: "not_observed",
      inProgress: false,
      notStarted: false,
      history: true,
      startState: "available",
      startKind: "run_again",
    },
    {
      lifecycle: "failed",
      phase: "finished",
      execution: "not_observed",
      inProgress: false,
      notStarted: false,
      history: true,
      startState: "available",
      startKind: "run_again",
    },
  ] as const)("maps $lifecycle to $phase without merging attention or history", (row) => {
    const card = boardCard({
      lifecycle: row.lifecycle,
      ...(row.lifecycle === "ineligible" ? { eligibilityReasons: ["state_terminal:Done"] } : {}),
    });
    const value = projection({ card: known(card) });
    expect(value.lifecycle.phase).toBe(row.phase);
    if (row.phase === "not_started" && "reason" in row) {
      expect(value.lifecycle).toMatchObject({ reason: row.reason });
    }
    expect(value.execution).toBe(row.execution);
    expect(value.membership.inProgress).toBe(row.inProgress);
    expect(value.membership.notStarted).toBe(row.notStarted);
    expect(value.membership.history).toBe(row.history);
    expect(value.membership.all).toBe(row.history === false);
    expect(startAction(value)?.state).toBe(row.startState);
    expect(startAction(value)?.kind).toBe(row.startKind);
  });

  it("keeps the current item in progress while the latest attempt succeeded", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "ready_for_review", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({
        runs: [attemptFact(firstRunId, "succeeded")],
        coverage: exhaustive,
      }),
    });
    expect(value.lifecycle).toEqual({ phase: "in_progress", lifecycle: "ready_for_review" });
    expect(value.attempts.current?.outcome).toEqual({ state: "succeeded" });
    expect(value.execution).toBe("not_observed");
    expect(value.membership.inProgress).toBe(true);
    expect(value.membership.history).toBe(false);
  });

  it("keeps a positive refusal on Not started with its reason", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "draft" })),
      refusal: { reason: "concurrency_cap", detail: "global" },
    });
    expect(value.lifecycle).toEqual({
      phase: "not_started",
      lifecycle: "draft",
      reason: "refused",
      detail: "global",
    });
    expect(value.membership.notStarted).toBe(true);
    expect(startAction(value)?.state).toBe("blocked");
  });

  it("does not rewrite an already admitted item because a later dispatch was refused", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      refusal: { reason: "concurrency_cap", detail: "repository" },
    });
    expect(value.lifecycle).toMatchObject({ phase: "in_progress", lifecycle: "queued" });
    expect(value.refusal).toEqual({ reason: "concurrency_cap", detail: "repository" });
    expect(startAction(value)?.state).toBe("available");
  });

  it("blocks Start on a non-retryable refusal", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      refusal: { reason: "not_leader" },
    });
    expect(value.lifecycle).toMatchObject({ phase: "in_progress", lifecycle: "queued" });
    expect(startAction(value)?.state).toBe("blocked");
    expect(startAction(value)?.reason).toContain("not_leader");
  });

  it("never claims not running when no lifecycle evidence was loaded", () => {
    const value = projection({ card: undefined, runs: undefined, attention: undefined });
    expect(value.lifecycle.phase).toBe("unknown");
    expect(value.execution).toBe("unknown");
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(value.evidence).toEqual({
      lifecycle: "unknown",
      runs: "unknown",
      attention: "unknown",
    });
  });

  it("does not authorise Start while a dispatch acknowledgement is unknown", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "draft" })),
      pendingDispatch: { requestedAt: "2026-10-23T10:00:00.000Z" },
    });
    expect(value.lifecycle.phase).toBe("not_started");
    expect(value.ownership).toEqual({
      state: "unknown",
      reason: "A dispatch request has no observed acknowledgement.",
    });
    expect(startAction(value)?.state).toBe("unknown");
    expect(startAction(value)?.reason).toContain("acknowledgement");
  });
});

describe("projectSymphonyWorkItem attention and attempts", () => {
  it("allows one item to be both In progress and Needs your attention", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "running", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({
        runs: [attemptFact(firstRunId, "streaming_turn")],
        coverage: exhaustive,
      }),
      attention: known({
        items: [attentionItem()],
        coverage: cappedCoverage,
      }),
    });
    expect(value.lifecycle).toMatchObject({ phase: "in_progress", lifecycle: "running" });
    expect(value.membership.inProgress).toBe(true);
    expect(value.membership.needsAttention).toBe(true);
    expect(value.attention.state).toBe("needs_attention");
    expect(value.execution).toBe("observed");
    expect(value.actions.some((action) => action.kind === "answer")).toBe(true);
    expect(startAction(value)?.state).toBe("blocked");
  });

  it("does not hide an older active attempt behind the latest attempt", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "ready_for_review", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: secondRunId,
      runs: known({
        runs: [
          attemptFact(firstRunId, "streaming_turn", { attemptNumber: 1 }),
          attemptFact(secondRunId, "succeeded", { attemptNumber: 2 }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.attempts.current?.runAttemptId).toBe(secondRunId);
    expect(value.attempts.current?.outcome).toEqual({ state: "succeeded" });
    expect(value.attempts.olderOutstanding.map((entry) => entry.runAttemptId)).toEqual([
      firstRunId,
    ]);
    expect(value.attempts.history.map((entry) => entry.runAttemptId)).toEqual([
      secondRunId,
      firstRunId,
    ]);
    expect(value.contradictions.map((entry) => entry.code)).toContain(
      "active_attempt_behind_latest",
    );
    expect(startAction(value)?.state).toBe("blocked");
  });

  it("keeps pending requests on older attempts visible and separately identified", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "ready_for_review", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: secondRunId,
      runs: known({
        runs: [
          attemptFact(firstRunId, "streaming_turn", { attemptNumber: 1 }),
          attemptFact(secondRunId, "succeeded", { attemptNumber: 2 }),
        ],
        coverage: exhaustive,
      }),
      attention: known({
        items: [
          attentionItem({ id: AttentionItemId.make("att-old"), runAttemptId: firstRunId }),
          attentionItem({
            id: AttentionItemId.make("att-new"),
            runAttemptId: secondRunId,
            availableActions: ["approve", "reject"],
            kind: "command_approval",
          }),
        ],
        coverage: cappedCoverage,
      }),
    });
    expect(value.attention.state).toBe("needs_attention");
    if (value.attention.state !== "needs_attention") return;
    expect(value.attention.items.map((entry) => entry.runAttemptId)).toEqual([
      firstRunId,
      secondRunId,
    ]);
    expect(value.attention.items.every((entry) => entry.attemptLoaded)).toBe(true);
    expect(value.attempts.outstanding.map((entry) => entry.runAttemptId)).toEqual([
      secondRunId,
      firstRunId,
    ]);
    expect(value.attempts.olderOutstanding.map((entry) => entry.runAttemptId)).toEqual([
      firstRunId,
    ]);
    expect(value.contradictions.map((entry) => entry.code)).toContain(
      "multiple_outstanding_attempts",
    );
  });

  it("never turns a non-exhaustive empty attention read into a known clear state", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "running" })),
      attention: known({ items: [], coverage: cappedCoverage }),
    });
    expect(value.attention.state).toBe("unknown");
    expect(value.membership.needsAttention).toBe(false);
  });

  it("preserves an unreadable attention source instead of flattening it to empty", () => {
    const value = projection({
      attention: {
        state: "unavailable",
        reason: "Attention read failed.",
        retryable: true,
      },
    });
    expect(value.attention).toEqual({
      state: "unavailable",
      reason: "Attention read failed.",
      retryable: true,
    });
    expect(value.evidence.attention).toBe("unavailable");
  });

  it("leaves current-attempt identity unknown when the board did not report it", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "ready_for_review" })),
      runs: known({
        runs: [attemptFact(firstRunId, "succeeded")],
        coverage: exhaustive,
      }),
    });
    expect(value.attempts.current).toBeNull();
    expect(value.attempts.currentState).toBe("unknown");
    expect(value.attempts.history).toHaveLength(1);
    expect(value.observedTarget.source).toBe("historical_attempt");
  });

  it("marks conflicting duplicate attempt evidence unknown and keeps both statuses", () => {
    const value = projection({
      runs: known({
        runs: [
          attemptFact(firstRunId, "streaming_turn"),
          attemptFact(firstRunId, "failed", { attemptNumber: 2 }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.attempts.history).toHaveLength(1);
    expect(value.attempts.history[0]?.status).toBeNull();
    expect(value.attempts.history[0]?.outcome.state).toBe("unknown");
    expect(value.contradictions.map((entry) => entry.code)).toContain("duplicate_attempt_evidence");
  });

  it("offers cancel only for an exact active attempt", () => {
    const active = projection({
      card: known(boardCard({ lifecycle: "running", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({
        runs: [attemptFact(firstRunId, "streaming_turn")],
        coverage: exhaustive,
      }),
    });
    expect(cancelActions(active)).toMatchObject([
      {
        state: "available",
        runAttemptId: firstRunId,
      },
    ]);

    const noExactAttempt = projection({
      card: known(boardCard({ lifecycle: "running" })),
      runs: known({ runs: [], coverage: cappedCoverage }),
    });
    expect(cancelActions(noExactAttempt)).toEqual([]);
  });
});

describe("projectSymphonyWorkItem contradictions", () => {
  it("uses the board lifecycle but surfaces a durable-record mismatch", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "running" })),
      workItem: known(workItem({ lifecycle: "ready_for_review" })),
    });
    expect(value.lifecycle).toMatchObject({ phase: "in_progress", lifecycle: "running" });
    expect(value.contradictions.map((entry) => entry.code)).toContain("lifecycle_mismatch");
  });

  it("refuses a card and a run that belong to a different work item or project", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "running", workItemId: otherWorkItemId })),
      runs: known({
        runs: [
          attemptFact(firstRunId, "streaming_turn", {
            projectId: otherProjectId,
          }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.lifecycle.phase).toBe("unknown");
    expect(value.attempts.history).toHaveLength(0);
    expect(value.contradictions.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["identity_mismatch", "project_mismatch"]),
    );
  });

  it("surfaces a current-attempt mismatch without promoting history", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "running", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({
        runs: [
          attemptFact(firstRunId, "streaming_turn"),
          attemptFact(secondRunId, "succeeded", { attemptNumber: 2 }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.attempts.current?.runAttemptId).toBe(firstRunId);
    expect(value.contradictions.map((entry) => entry.code)).toContain("current_attempt_mismatch");
  });

  it("surfaces a run observed behind a terminal lifecycle", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "completed" })),
      runs: known({
        runs: [attemptFact(firstRunId, "streaming_turn")],
        coverage: exhaustive,
      }),
    });
    expect(value.lifecycle.phase).toBe("finished");
    expect(value.contradictions.map((entry) => entry.code)).toContain(
      "active_attempt_after_terminal_lifecycle",
    );
    expect(startAction(value)?.state).toBe("blocked");
  });
});

describe("projectSymphonyWorkCollection", () => {
  const runningCard = boardCard({
    lifecycle: "running",
    workItemId: WorkItemId.make("wi-running"),
    title: "Running work",
  });
  const draftCard = boardCard({
    lifecycle: "draft",
    workItemId: WorkItemId.make("wi-draft"),
    title: "Draft work",
  });
  const completedCard = boardCard({
    lifecycle: "completed",
    workItemId: WorkItemId.make("wi-completed"),
    title: "Completed work",
  });
  const failedCard = boardCard({
    lifecycle: "failed",
    workItemId: WorkItemId.make("wi-failed"),
    title: "Failed work",
  });

  function mixedCollection(overrides: Partial<SymphonyWorkCollectionInput> = {}) {
    return projectSymphonyWorkCollection(
      collectionInput({
        board: known({
          cards: [runningCard, draftCard, completedCard, failedCard],
          coverage: exhaustive,
          generatedAt: createdAt,
        }),
        attention: known({
          items: [
            attentionItem({
              id: AttentionItemId.make("att-running"),
              workItemId: runningCard.workItemId,
            }),
            attentionItem({
              id: AttentionItemId.make("att-completed"),
              workItemId: completedCard.workItemId,
              kind: "command_approval",
              availableActions: ["approve", "reject"],
            }),
          ],
          coverage: cappedCoverage,
        }),
        ...overrides,
      }),
    );
  }

  it("owns filter membership without duplicating rows or partitioning All by attention", () => {
    const value = mixedCollection();
    expect(value.items).toHaveLength(4);
    expect(value.counts.items).toMatchObject({
      all: 2,
      notStarted: 1,
      inProgress: 1,
      history: 2,
    });
    expect(value.counts.attention).toMatchObject({
      state: "observed",
      workItems: 2,
      items: 2,
    });

    expect(value.visibleItems.map((item) => item.identity.title)).toEqual([
      "Running work",
      "Draft work",
    ]);
    expect(
      projectSymphonyWorkCollection(
        collectionInput({
          board: known({
            cards: [runningCard, draftCard, completedCard, failedCard],
            coverage: exhaustive,
            generatedAt: createdAt,
          }),
          attention: known({
            items: [
              attentionItem({
                id: AttentionItemId.make("att-running"),
                workItemId: runningCard.workItemId,
              }),
            ],
            coverage: cappedCoverage,
          }),
          filter: "attention",
        }),
      ).visibleItems.map((item) => item.identity.title),
    ).toEqual(["Running work"]);
    expect(
      projectSymphonyWorkCollection(
        collectionInput({
          board: known({
            cards: [runningCard, draftCard, completedCard, failedCard],
            coverage: exhaustive,
            generatedAt: createdAt,
          }),
          filter: "history",
        }),
      ).visibleItems.map((item) => item.identity.title),
    ).toEqual(["Completed work", "Failed work"]);

    const ids = value.visibleItems.map((item) => String(item.identity.workItemId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(value.attentionOutsideFilter).toMatchObject({
      state: "observed",
      workItems: 1,
      items: 1,
    });
  });

  it("never claims a known empty attention queue when coverage is missing", () => {
    const value = projectSymphonyWorkCollection(collectionInput());
    expect(value.state).toBe("known");
    expect(value.items).toHaveLength(0);
    expect(value.counts.items.state).toBe("known");
    expect(value.counts.attention.state).toBe("unknown");
    expect(value.attentionOutsideFilter.state).toBe("unknown");
    expect(value.attentionOutsideFilter.workItems).toBe(0);
  });

  it("preserves an unavailable board instead of manufacturing empty work", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: {
          state: "unavailable",
          reason: "Board read failed.",
          retryable: true,
        },
      }),
    );
    expect(value.state).toBe("unavailable");
    expect(value.counts.items.state).toBe("unavailable");
    expect(value.visibleItems).toEqual([]);
    expect(value.evidence.board).toBe("unavailable");
  });

  it("exposes a bounded board without turning it into exhaustive history", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: known({
          cards: [completedCard],
          coverage: {
            state: "bounded",
            reason: "Only the newest finished items are shown.",
          },
          generatedAt: createdAt,
        }),
      }),
    );
    expect(value.items).toHaveLength(1);
    expect(value.counts.items.state).toBe("observed");
    expect(value.coverage.board.state).toBe("bounded");
    expect(value.visibleItems).toHaveLength(0);
  });

  it("surfaces attention and runs outside the board caps without inserting rows", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        attention: known({
          items: [
            attentionItem({
              id: AttentionItemId.make("att-old"),
              workItemId: otherWorkItemId,
            }),
          ],
          coverage: cappedCoverage,
        }),
        runs: known({
          runs: [
            attemptFact(firstRunId, "streaming_turn", {
              workItemId: otherWorkItemId,
            }),
          ],
          coverage: cappedCoverage,
        }),
      }),
    );
    expect(value.items).toHaveLength(0);
    expect(value.attentionOutsideBoard).toHaveLength(1);
    expect(value.attentionOutsideBoard[0]?.item.workItemId).toBe(otherWorkItemId);
    expect(value.unmatchedRuns.map((entry) => entry.runAttemptId)).toEqual([firstRunId]);
    expect(value.counts.attention).toMatchObject({
      state: "observed",
      outsideBoardWorkItems: 1,
      outsideBoardItems: 1,
    });
  });

  it("deduplicates repeated board cards and names the contradiction", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: known({
          cards: [draftCard, draftCard],
          coverage: exhaustive,
          generatedAt: createdAt,
        }),
      }),
    );
    expect(value.items).toHaveLength(1);
    expect(value.contradictions.map((entry) => entry.code)).toContain("duplicate_work_item_card");
  });

  it("does not attach a run from another project", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: known({
          cards: [runningCard],
          coverage: exhaustive,
          generatedAt: createdAt,
        }),
        runs: known({
          runs: [
            attemptFact(firstRunId, "streaming_turn", {
              workItemId: runningCard.workItemId,
              projectId: otherProjectId,
            }),
          ],
          coverage: cappedCoverage,
        }),
      }),
    );
    expect(value.items[0]?.attempts.history).toHaveLength(0);
    expect(value.contradictions.map((entry) => entry.code)).toContain("project_mismatch");
  });

  it("keeps a canonical row discoverable in attention and history, not All", () => {
    const value = mixedCollection();
    const completed = value.items.find((item) => item.identity.title === "Completed work");
    expect(completed?.membership).toEqual({
      all: false,
      notStarted: false,
      inProgress: false,
      needsAttention: true,
      history: true,
    });
    const attention = projectSymphonyWorkCollection(
      collectionInput({
        board: known({
          cards: [runningCard, completedCard],
          coverage: exhaustive,
          generatedAt: createdAt,
        }),
        attention: known({
          items: [
            attentionItem({
              id: AttentionItemId.make("att-completed"),
              workItemId: completedCard.workItemId,
            }),
          ],
          coverage: cappedCoverage,
        }),
        filter: "attention",
      }),
    );
    expect(attention.visibleItems.map((item) => item.identity.title)).toEqual(["Completed work"]);
  });
});
