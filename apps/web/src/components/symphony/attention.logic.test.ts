import type { ApprovalRequest, AttentionItem } from "@neokod/contracts";
import { SymphonyApprovalRequestId, WorkItemId } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalRequestHistory,
  approvalRequestMode,
  attentionMode,
  buildApprovalAnswerInputs,
} from "./attention.logic";

const attentionItem = (availableActions: ReadonlyArray<string>) =>
  ({ availableActions }) as Pick<AttentionItem, "availableActions">;

describe("attentionMode", () => {
  it("treats an answerable item as a question", () => {
    expect(attentionMode(attentionItem(["answer"]))).toBe("question");
  });

  it("treats an approve/reject item as an approval", () => {
    expect(attentionMode(attentionItem(["approve", "reject"]))).toBe("approval");
  });

  it("treats an item with no request controls as info", () => {
    expect(attentionMode(attentionItem(["re-dispatch", "take-over", "abandon"]))).toBe("info");
  });
});

describe("approvalRequestMode", () => {
  it("treats a user-input request as a question", () => {
    expect(approvalRequestMode({ kind: "user_input", action: "user_input" })).toBe("question");
  });

  it("treats a command approval as an approval", () => {
    expect(approvalRequestMode({ kind: "approval", action: "command_execution" })).toBe("approval");
  });

  it("derives the mode when a pre-kind payload has no kind", () => {
    expect(approvalRequestMode({ action: "user_input" })).toBe("question");
    expect(approvalRequestMode({ action: "command_execution" })).toBe("approval");
    expect(approvalRequestMode({ action: "unknown" })).toBe("approval");
  });
});

describe("buildApprovalAnswerInputs", () => {
  const question = {
    id: "q1",
    header: "Checks",
    question: "Which checks?",
    options: [],
    multiSelect: true,
  } as const;

  it("serialises a custom multi-select answer as a singleton array with no options", () => {
    expect(
      buildApprovalAnswerInputs([question], { q1: { selected: [], custom: "custom check" } }),
    ).toEqual([{ questionId: "q1", answer: ["custom check"] }]);
  });

  it("keeps selected multi-choice labels as an array", () => {
    expect(
      buildApprovalAnswerInputs([question], {
        q1: { selected: ["unit", "lint"], custom: "" },
      }),
    ).toEqual([{ questionId: "q1", answer: ["unit", "lint"] }]);
  });

  it("requires every question and leaves a single-select custom answer as a string", () => {
    const single = { ...question, multiSelect: false } as const;
    expect(buildApprovalAnswerInputs([single], {})).toBeNull();
    expect(buildApprovalAnswerInputs([single], { q1: { selected: [], custom: "custom" } })).toEqual(
      [{ questionId: "q1", answer: "custom" }],
    );
  });
});

const approvalRequest = (overrides: Partial<ApprovalRequest>): ApprovalRequest => ({
  id: SymphonyApprovalRequestId.make("sym-1"),
  requestId: "req-1",
  workItemId: WorkItemId.make("wi-1"),
  action: "user_input",
  kind: "user_input",
  scope: "once",
  state: "answered",
  affectedFiles: [],
  createdAt: "2026-08-08T10:00:00.000Z",
  decidedAt: "2026-08-08T10:00:05.000Z",
  ...overrides,
});

describe("approvalRequestHistory", () => {
  it("separates an answered question from a permission approval", () => {
    const history = approvalRequestHistory(
      approvalRequest({
        answer: {
          answers: [
            { questionId: "q1", answer: "main" },
            { questionId: "q2", answer: ["unit", "lint"] },
          ],
          delivery: "unknown",
          actor: "local_operator",
          recordedAt: "2026-08-08T10:00:05.000Z",
        },
      }),
    );
    expect(history.answered).toBe(true);
    expect(history.deliveryPending).toBe(false);
    expect(history.answerText).toBe("q1: main\nq2: unit, lint");
    expect(history.answerDeliveryLabel).toBe("Provider receipt not confirmed");
  });

  it("does not call a permission approval an answer", () => {
    const history = approvalRequestHistory(
      approvalRequest({
        action: "command_execution",
        kind: "approval",
        state: "approved",
        decision: "approved",
      }),
    );
    expect(history.answered).toBe(false);
    expect(history.answerText).toBeNull();
  });

  it("labels a staged delivery as unknown, not delivered", () => {
    const history = approvalRequestHistory(
      approvalRequest({
        state: "delivering",
        decision: "answered",
        answer: {
          answers: [{ questionId: "q1", answer: "main" }],
          delivery: "unknown",
          actor: "local_operator",
          recordedAt: "2026-08-08T10:00:05.000Z",
        },
      }),
    );
    expect(history.deliveryPending).toBe(true);
    expect(history.answerDeliveryLabel).toContain("Delivery unknown");
  });

  it("shows the staged decision for an interrupted delivery-unknown row", () => {
    const history = approvalRequestHistory(
      approvalRequest({
        action: "command_execution",
        kind: "approval",
        state: "interrupted",
        decision: "approved",
        decisionNote: {
          text: "approved locally",
          delivery: "history_only",
          actor: "local_operator",
          recordedAt: "2026-08-08T10:00:05.000Z",
        },
      }),
    );
    expect(history.deliveryPending).toBe(true);
    expect(history.stagedDecision).toBe("approved");
    expect(history.answerDeliveryLabel).toContain("staged approved");
  });

  it("labels redacted and history-only content honestly", () => {
    const history = approvalRequestHistory(
      approvalRequest({
        answer: {
          answers: [{ questionId: "token", answer: "[redacted]", redacted: true }],
          delivery: "unknown",
          actor: "local_operator",
          recordedAt: "2026-08-08T10:00:05.000Z",
        },
        decisionNote: {
          text: "local only",
          delivery: "history_only",
          actor: "local_operator",
          recordedAt: "2026-08-08T10:00:06.000Z",
        },
        historyUnavailable: "the stored answer history could not be decoded",
      }),
    );
    expect(history.answerRedacted).toBe(true);
    expect(history.answerText).toBe("token: [redacted]");
    expect(history.noteText).toBe("local only");
    expect(history.noteDeliveryLabel).toBe("History only; not sent to the agent");
    expect(history.historyUnavailable).toContain("answer history");
  });
});
