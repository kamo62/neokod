import {
  AttentionItemId,
  EnvironmentId,
  RunAttemptId,
  SymphonyProjectId,
  WorkItemId,
  type AttentionItem,
  type RunAttemptStatus,
  type SymphonyBoardCard,
  type WorkLifecycle,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectSymphonyWorkCollection,
  projectSymphonyWorkItem,
  symphonyWorkConnectionStaleReason,
  type SymphonyWorkAttemptFact,
  type SymphonyWorkClosureEvidence,
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

const known = <A>(value: A, staleReason?: string): SymphonyWorkEvidence<A> => ({
  state: "known",
  value,
  ...(staleReason === undefined ? {} : { staleReason }),
});

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

function closure(runAttemptId: RunAttemptId | undefined = firstRunId): SymphonyWorkClosureEvidence {
  return {
    workItemId,
    runAttemptId,
    observedAt: "2026-10-23T10:00:00.000Z",
    source: "recovery.stop_confirmed",
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
    board: known({ cards: [], coverage: exhaustive, generatedAt: createdAt }),
    runs: known({ runs: [], coverage: cappedCoverage }),
    attention: known({ items: [], coverage: cappedCoverage }),
    ...overrides,
  };
}

describe("environment connection freshness", () => {
  it("only treats a connected environment on an online network as fresh", () => {
    expect(symphonyWorkConnectionStaleReason("connected", "online")).toBeNull();
    expect(symphonyWorkConnectionStaleReason("connected", "offline")).not.toBeNull();
    expect(symphonyWorkConnectionStaleReason("connected", "unknown")).not.toBeNull();
    for (const phase of [
      "available",
      "offline",
      "connecting",
      "reconnecting",
      "error",
      null,
    ] as const) {
      expect(symphonyWorkConnectionStaleReason(phase, "online")).not.toBeNull();
    }
  });
});

describe("projectSymphonyWorkItem lifecycle", () => {
  it.each([
    {
      lifecycle: "draft",
      phase: "not_started",
      reason: "draft",
      execution: "not_observed",
      notStarted: true,
      history: false,
      startState: "blocked",
    },
    {
      lifecycle: "ineligible",
      phase: "not_started",
      reason: "ineligible",
      execution: "not_observed",
      notStarted: true,
      history: false,
      startState: "blocked",
    },
    {
      lifecycle: "queued",
      phase: "in_progress",
      execution: "not_observed",
      notStarted: false,
      history: false,
      startState: "available",
    },
    {
      lifecycle: "running",
      phase: "in_progress",
      execution: "observed",
      notStarted: false,
      history: false,
      startState: "blocked",
    },
    {
      lifecycle: "ready_for_review",
      phase: "in_progress",
      execution: "not_observed",
      notStarted: false,
      history: false,
      startState: "blocked",
    },
    {
      lifecycle: "failed",
      phase: "finished",
      execution: "not_observed",
      notStarted: false,
      history: true,
      startState: "available",
    },
    {
      lifecycle: "completed",
      phase: "finished",
      execution: "not_observed",
      notStarted: false,
      history: true,
      startState: "blocked",
    },
  ] as const)("maps $lifecycle without merging attention or history", (row) => {
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
    expect(value.membership.notStarted).toBe(row.notStarted);
    expect(value.membership.history).toBe(row.history);
    expect(value.membership.all).toBe(row.history === false);
    expect(startAction(value)?.state).toBe(row.startState);
  });

  it("keeps the current item in progress while the latest attempt succeeded", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "ready_for_review", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({ runs: [attemptFact(firstRunId, "succeeded")], coverage: exhaustive }),
    });
    expect(value.lifecycle).toEqual({ phase: "in_progress", lifecycle: "ready_for_review" });
    expect(value.attempts.current?.outcome).toEqual({ state: "succeeded" });
    expect(value.execution).toBe("not_observed");
  });

  it("never claims not running when no lifecycle evidence was loaded", () => {
    const value = projection({ card: undefined, runs: undefined, attention: undefined });
    expect(value.lifecycle.phase).toBe("unknown");
    expect(value.execution).toBe("unknown");
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
  });
});

describe("stale last-known evidence", () => {
  it("keeps stale board data visible but refuses to authorise Start", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed" }), "Board refresh failed."),
    });
    expect(value.lifecycle.phase).toBe("finished");
    expect(value.freshness.lifecycle).toEqual({
      state: "stale",
      reason: "Board refresh failed.",
    });
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(startAction(value)?.reason).toContain("stale");
  });

  it("refuses Start when run history is stale even if the card looks terminal", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed" })),
      runs: known({ runs: [], coverage: exhaustive }, "Runs refresh failed."),
    });
    expect(value.attempts.freshness).toEqual({
      state: "stale",
      reason: "Runs refresh failed.",
    });
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("keeps a stale request visible but makes answer/approve/reject unknown", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "running" })),
      attention: known(
        { items: [attentionItem()], coverage: cappedCoverage },
        "Attention refresh failed.",
      ),
    });
    expect(value.attention.state).toBe("needs_attention");
    expect(value.membership.needsAttention).toBe(true);
    expect(value.actions.find((action) => action.kind === "answer")?.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("exposes stale freshness on collection counts", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: known(
          { cards: [], coverage: exhaustive, generatedAt: createdAt },
          "Board refresh failed.",
        ),
        attention: known({ items: [], coverage: cappedCoverage }, "Attention refresh failed."),
      }),
    );
    expect(value.freshness.board.state).toBe("stale");
    expect(value.freshness.attention.state).toBe("stale");
    expect(value.counts.items.freshness.state).toBe("stale");
    expect(value.counts.attention.freshness.state).toBe("stale");
  });
});

describe("unknown ownership from incomplete attempts", () => {
  it("does not offer Run again merely because the capped run list is empty", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed" })),
      runs: known({ runs: [], coverage: cappedCoverage }),
    });
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(startAction(value)?.reason).toContain("coverage");
  });

  it("does not offer Run again when the run source is unavailable", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed" })),
      runs: {
        state: "unavailable",
        reason: "Run read failed.",
        retryable: true,
      },
    });
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("does not authorise a queued re-dispatch from a capped run list", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      runs: known({ runs: [], coverage: cappedCoverage }),
    });
    expect(value.ownership.state).toBe("admitted");
    expect(startAction(value)?.state).toBe("unknown");
    expect(startAction(value)?.reason).toContain("coverage");
  });

  it("offers Run again only with fresh exhaustive history and no outstanding work", () => {
    const value = projection({ card: known(boardCard({ lifecycle: "failed" })) });
    expect(value.ownership.state).toBe("none_observed");
    expect(startAction(value)).toMatchObject({ kind: "run_again", state: "available" });
  });
});

describe("stop requests and confirmed closure", () => {
  it("does not label a cancellation Stopped or offer Run again without closure", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "cancelled", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({ runs: [attemptFact(firstRunId, "user_cancelled")], coverage: exhaustive }),
    });
    expect(value.attempts.history[0]?.outcome.state).toBe("stop_requested");
    expect(value.execution).toBe("unknown");
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(value.membership).toMatchObject({
      all: true,
      inProgress: true,
      needsAttention: true,
      history: true,
      reconciliation: true,
    });
  });

  it("accepts authoritative closure and then allows a known retry", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "cancelled", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({ runs: [attemptFact(firstRunId, "user_cancelled")], coverage: exhaustive }),
      closures: [closure()],
    });
    expect(value.attempts.history[0]?.outcome).toEqual({ state: "stopped" });
    expect(value.ownership.state).toBe("none_observed");
    expect(startAction(value)).toMatchObject({ kind: "run_again", state: "available" });
    expect(value.membership.reconciliation).toBe(false);
  });

  it("treats a legacy cancelled lifecycle without attempt closure as unconfirmed", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "cancelled" })),
    });
    expect(value.ownership.state).toBe("unknown");
    expect(value.execution).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(value.membership).toMatchObject({
      all: true,
      inProgress: true,
      needsAttention: true,
      reconciliation: true,
    });
  });

  it("accepts work-item closure for a legacy cancelled record", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "cancelled" })),
      closures: [{ workItemId, observedAt: createdAt, source: "recovery.stop_confirmed" }],
    });
    expect(value.ownership.state).toBe("none_observed");
    expect(startAction(value)).toMatchObject({ kind: "run_again", state: "available" });
  });

  it("does not let another attempt's closure confirm a legacy cancellation", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "cancelled" })),
      closures: [closure(secondRunId)],
    });
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("does not let an older work-item closure confirm a later cancelled attempt", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "cancelled", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: secondRunId,
      runs: known({
        runs: [
          attemptFact(secondRunId, "user_cancelled", {
            attemptNumber: 2,
            startedAt: "2026-10-23T11:00:00.000Z",
          }),
        ],
        coverage: exhaustive,
      }),
      closures: [
        {
          workItemId,
          observedAt: "2026-10-23T10:00:00.000Z",
          source: "recovery.stop_confirmed",
        },
      ],
    });
    expect(value.attempts.history[0]?.outcome.state).toBe("stop_requested");
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("requires an exact closure timestamp after the attempt started", () => {
    const before = projection({
      card: known(boardCard({ lifecycle: "cancelled", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: secondRunId,
      runs: known({
        runs: [
          attemptFact(secondRunId, "user_cancelled", {
            attemptNumber: 2,
            startedAt: "2026-10-23T11:00:00.000Z",
          }),
        ],
        coverage: exhaustive,
      }),
      closures: [closure(secondRunId)],
    });
    expect(before.attempts.history[0]?.outcome.state).toBe("stop_requested");

    const after = projection({
      card: known(boardCard({ lifecycle: "cancelled", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: secondRunId,
      runs: known({
        runs: [
          attemptFact(secondRunId, "user_cancelled", {
            attemptNumber: 2,
            startedAt: "2026-10-23T09:00:00.000Z",
          }),
        ],
        coverage: exhaustive,
      }),
      closures: [closure(secondRunId)],
    });
    expect(after.attempts.history[0]?.outcome.state).toBe("stopped");
  });

  it("keeps an old unconfirmed stop in history without flooding In progress", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: secondRunId,
      runs: known({
        runs: [
          attemptFact(firstRunId, "interrupted", { attemptNumber: 1 }),
          attemptFact(secondRunId, "succeeded", {
            attemptNumber: 2,
            startedAt: "2026-10-23T11:00:00.000Z",
          }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.attempts.history.map((attempt) => attempt.outcome.state)).toEqual([
      "succeeded",
      "stop_requested",
    ]);
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(value.membership).toMatchObject({
      all: true,
      inProgress: false,
      needsAttention: false,
      history: true,
      reconciliation: true,
    });
  });

  it("keeps an unresolved older stop in In progress and attention", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: secondRunId,
      runs: known({
        runs: [
          attemptFact(firstRunId, "interrupted", { attemptNumber: 1 }),
          attemptFact(secondRunId, "failed", { attemptNumber: 2 }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.membership).toMatchObject({
      inProgress: true,
      needsAttention: true,
      reconciliation: true,
    });
  });
});

describe("refused admission", () => {
  it("projects the real failed -> queued -> refused path as Not started", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      refusal: { reason: "concurrency_cap", detail: "global", priorLifecycle: "failed" },
    });
    expect(value.lifecycle).toMatchObject({
      phase: "not_started",
      lifecycle: "queued",
      reason: "refused",
      detail: "global",
    });
    expect(startAction(value)?.state).toBe("available");
    expect(startAction(value)?.reason).toContain("concurrency_cap");
    expect(value.refusal?.detail).toBe("global");
  });

  it("keeps a refused retry unknown when another affirmative gate is missing", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      refusal: { reason: "concurrency_cap", priorLifecycle: "failed" },
      runs: known({ runs: [], coverage: cappedCoverage }),
    });
    expect(value.lifecycle.phase).toBe("not_started");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("keeps an already admitted item in progress when a later command is refused", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      refusal: { reason: "paused", detail: "global", priorLifecycle: "queued" },
    });
    expect(value.lifecycle).toMatchObject({ phase: "in_progress", lifecycle: "queued" });
    expect(startAction(value)?.state).toBe("available");
    expect(value.refusal?.reason).toBe("paused");
  });

  it("does not make a refusal a permanent latch without prior lifecycle evidence", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      refusal: { reason: "not_leader" },
    });
    expect(value.lifecycle).toMatchObject({ phase: "in_progress", lifecycle: "queued" });
    expect(startAction(value)?.state).toBe("available");
  });

  it("keeps positive ownership when a refused retry follows an active older attempt", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued" })),
      refusal: { reason: "already_running", priorLifecycle: "failed" },
      runs: known({ runs: [attemptFact(firstRunId, "streaming_turn")], coverage: exhaustive }),
    });
    expect(value.lifecycle.phase).toBe("in_progress");
    expect(startAction(value)?.state).toBe("blocked");
  });
});

describe("pending dispatch and attention overlap", () => {
  it("keeps a terminal item current while a dispatch acknowledgement is unknown", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed" })),
      pendingDispatch: { requestedAt: "2026-10-23T10:00:00.000Z" },
    });
    expect(value.lifecycle.phase).toBe("finished");
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(value.membership).toMatchObject({
      all: true,
      inProgress: true,
      needsAttention: true,
      history: true,
      reconciliation: true,
    });
  });

  it("allows one item to be both In progress and Needs your attention", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "running", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({ runs: [attemptFact(firstRunId, "streaming_turn")], coverage: exhaustive }),
      attention: known({ items: [attentionItem()], coverage: cappedCoverage }),
    });
    expect(value.membership.inProgress).toBe(true);
    expect(value.membership.needsAttention).toBe(true);
    expect(value.actions.some((action) => action.kind === "answer")).toBe(true);
    expect(startAction(value)?.state).toBe("blocked");
  });

  it("keeps pending requests on older attempts visible", () => {
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
            kind: "command_approval",
            availableActions: ["approve", "reject"],
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

  it("keeps an unreadable attention source explicit", () => {
    const value = projection({
      attention: { state: "unavailable", reason: "Attention read failed.", retryable: true },
    });
    expect(value.attention.state).toBe("unavailable");
    expect(value.evidence.attention).toBe("unavailable");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("does not authorise Start when attention was never loaded", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed" })),
      attention: undefined,
    });
    expect(value.attention.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
    expect(startAction(value)?.reason).toContain("Attention evidence");
  });

  it("does not let an informational attention item create a dead end", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "failed" })),
      attention: known({
        items: [
          attentionItem({
            kind: "merge_conflict",
            availableActions: ["re-dispatch", "take-over", "abandon"],
          }),
        ],
        coverage: cappedCoverage,
      }),
    });
    expect(value.attention.state).toBe("needs_attention");
    if (value.attention.state !== "needs_attention") return;
    expect(value.attention.items[0]?.mode).toBe("info");
    expect(startAction(value)).toMatchObject({ kind: "run_again", state: "available" });
  });
});

describe("attempts and contradictions", () => {
  it("does not promote history to current without an explicit current id", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "ready_for_review" })),
      runs: known({ runs: [attemptFact(firstRunId, "succeeded")], coverage: exhaustive }),
    });
    expect(value.attempts.current).toBeNull();
    expect(value.attempts.currentState).toBe("unknown");
    expect(value.observedTarget.source).toBe("historical_attempt");
  });

  it("surfaces an older active attempt behind the latest", () => {
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
    expect(value.attempts.olderOutstanding.map((entry) => entry.runAttemptId)).toEqual([
      firstRunId,
    ]);
    expect(value.contradictions.map((entry) => entry.code)).toContain(
      "active_attempt_behind_latest",
    );
    expect(value.membership.reconciliation).toBe(true);
  });

  it("surfaces an active attempt behind a terminal lifecycle", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "completed" })),
      runs: known({ runs: [attemptFact(firstRunId, "streaming_turn")], coverage: exhaustive }),
    });
    expect(value.contradictions.map((entry) => entry.code)).toContain(
      "active_attempt_after_terminal_lifecycle",
    );
    expect(value.membership).toMatchObject({
      all: true,
      inProgress: true,
      needsAttention: true,
      history: true,
    });
  });

  it("marks conflicting duplicate attempt evidence unknown", () => {
    const value = projection({
      runs: known({
        runs: [
          attemptFact(firstRunId, "streaming_turn"),
          attemptFact(firstRunId, "failed", { attemptNumber: 2 }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.attempts.history[0]?.status).toBeNull();
    expect(value.attempts.history[0]?.outcome.state).toBe("unknown");
    expect(value.ownership.state).toBe("unknown");
  });

  it("offers cancel only for an exact active attempt", () => {
    const active = projection({
      card: known(boardCard({ lifecycle: "running", latestRunAttemptId: firstRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({ runs: [attemptFact(firstRunId, "streaming_turn")], coverage: exhaustive }),
    });
    expect(cancelActions(active)).toMatchObject([{ state: "available", runAttemptId: firstRunId }]);

    const noExactAttempt = projection({
      card: known(boardCard({ lifecycle: "running" })),
      runs: known({ runs: [], coverage: cappedCoverage }),
    });
    expect(cancelActions(noExactAttempt)).toEqual([]);
  });

  it("does not authorise Start while current-attempt identity is contradictory", () => {
    const value = projection({
      card: known(boardCard({ lifecycle: "queued", latestRunAttemptId: secondRunId })),
      currentRunAttemptId: firstRunId,
      runs: known({
        runs: [
          attemptFact(firstRunId, "succeeded"),
          attemptFact(secondRunId, "succeeded", { attemptNumber: 2 }),
        ],
        coverage: exhaustive,
      }),
    });
    expect(value.contradictions.map((entry) => entry.code)).toContain("current_attempt_mismatch");
    expect(value.ownership.state).toBe("unknown");
    expect(startAction(value)?.state).toBe("unknown");
  });

  it("does not let one item's attention leak to another in a collection", () => {
    const first = boardCard({ lifecycle: "running", workItemId: WorkItemId.make("wi-a") });
    const second = boardCard({ lifecycle: "running", workItemId: WorkItemId.make("wi-b") });
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: known({ cards: [first, second], coverage: exhaustive, generatedAt: createdAt }),
        attention: known({
          items: [
            attentionItem({ id: AttentionItemId.make("att-a"), workItemId: first.workItemId }),
          ],
          coverage: cappedCoverage,
        }),
      }),
    );
    expect(value.items[0]?.attention.state).toBe("needs_attention");
    expect(value.items[1]?.attention.state).not.toBe("needs_attention");
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
      reconciliation: 0,
    });
    expect(value.counts.attention).toMatchObject({ state: "observed", workItems: 2, items: 2 });
    expect(value.visibleItems.map((item) => item.identity.title)).toEqual([
      "Running work",
      "Draft work",
    ]);
    expect(value.attentionOutsideFilter).toMatchObject({
      state: "observed",
      workItems: 1,
      items: 1,
    });
    const ids = value.visibleItems.map((item) => String(item.identity.workItemId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts a terminal item with unknown acknowledgement in All and attention", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: known({ cards: [failedCard], coverage: exhaustive, generatedAt: createdAt }),
        dispatch: {
          pending: [{ workItemId: failedCard.workItemId }],
          refusals: [],
        },
      }),
    );
    expect(value.counts.items).toMatchObject({
      all: 1,
      history: 1,
      inProgress: 1,
      reconciliation: 1,
    });
    expect(value.counts.attention.workItems).toBe(1);
  });

  it("never claims a known empty attention queue when coverage is missing", () => {
    const value = projectSymphonyWorkCollection(collectionInput());
    expect(value.items).toHaveLength(0);
    expect(value.counts.items.state).toBe("known");
    expect(value.counts.attention.state).toBe("unknown");
    expect(value.attentionOutsideFilter.state).toBe("unknown");
  });

  it("preserves an unavailable board instead of manufacturing empty work", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        board: { state: "unavailable", reason: "Board read failed.", retryable: true },
      }),
    );
    expect(value.state).toBe("unavailable");
    expect(value.counts.items.state).toBe("unavailable");
    expect(value.evidence.board).toBe("unavailable");
  });

  it("surfaces attention and runs outside the board caps without inserting rows", () => {
    const value = projectSymphonyWorkCollection(
      collectionInput({
        attention: known({
          items: [attentionItem({ workItemId: otherWorkItemId })],
          coverage: cappedCoverage,
        }),
        runs: known({
          runs: [attemptFact(firstRunId, "streaming_turn", { workItemId: otherWorkItemId })],
          coverage: cappedCoverage,
        }),
      }),
    );
    expect(value.items).toHaveLength(0);
    expect(value.attentionOutsideBoard).toHaveLength(1);
    expect(value.unmatchedRuns.map((entry) => entry.runAttemptId)).toEqual([firstRunId]);
    expect(value.counts.attention.outsideBoardWorkItems).toBe(1);
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
        board: known({ cards: [runningCard], coverage: exhaustive, generatedAt: createdAt }),
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

  it("keeps a completed row discoverable in attention and history, not All", () => {
    const value = mixedCollection();
    const completed = value.items.find((item) => item.identity.title === "Completed work");
    expect(completed?.membership).toEqual({
      all: false,
      notStarted: false,
      inProgress: false,
      needsAttention: true,
      history: true,
      reconciliation: false,
    });
  });
});
