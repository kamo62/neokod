import type {
  ApprovalAnswerInput,
  ApprovalQuestion,
  ApprovalRequest,
  AttentionItem,
} from "@neokod/contracts";

/**
 * Which controls an attention row offers.
 *
 * `question` is an agent user-input request answered with text; `approval` is a
 * gated action answered with approve/reject; `info` is an item that carries no
 * request at all (for example `pr_creation_failed`) and therefore has nothing to
 * answer, even though it may list other actions.
 */
export type AttentionMode = "approval" | "question" | "info";

export function attentionMode(item: Pick<AttentionItem, "availableActions">): AttentionMode {
  if (item.availableActions.includes("answer")) return "question";
  if (item.availableActions.includes("approve")) return "approval";
  return "info";
}

export interface ApprovalQuestionDraft {
  readonly selected: ReadonlyArray<string>;
  readonly custom: string;
}

/**
 * Serialise one draft per question into the exact answer map the server
 * validates. A custom answer to a multi-select question is a singleton array,
 * including when the question has no options.
 */
export function buildApprovalAnswerInputs(
  questions: ReadonlyArray<ApprovalQuestion>,
  drafts: Readonly<Record<string, ApprovalQuestionDraft>>,
): ReadonlyArray<ApprovalAnswerInput> | null {
  const answers: ApprovalAnswerInput[] = [];
  for (const question of questions) {
    const draft = drafts[question.id] ?? { selected: [], custom: "" };
    const custom = draft.custom.trim();
    if (custom.length > 0) {
      answers.push({
        questionId: question.id,
        answer: question.multiSelect === true ? [custom] : custom,
      });
      continue;
    }
    if (question.multiSelect === true) {
      if (draft.selected.length === 0) return null;
      answers.push({ questionId: question.id, answer: [...draft.selected] });
      continue;
    }
    const selected = draft.selected[0];
    if (selected === undefined || selected.length === 0) return null;
    answers.push({ questionId: question.id, answer: selected });
  }
  return answers;
}

/**
 * Question vs approval for a durable request. The request kind is explicit on
 * current payloads; payloads written before it existed only carry the action,
 * so it is derived rather than treated as unknown.
 */
export function approvalRequestMode(
  request: Pick<ApprovalRequest, "kind" | "action">,
): "approval" | "question" {
  const kind = request.kind ?? (request.action === "user_input" ? "user_input" : "approval");
  return kind === "user_input" ? "question" : "approval";
}

export interface ApprovalRequestHistory {
  /** True only for an answered question, never for a permission approval. */
  readonly answered: boolean;
  /** Staged content whose history finalisation did not complete. */
  readonly deliveryPending: boolean;
  /** Stored answer content, labelled honestly; null when nothing was stored. */
  readonly answerText: string | null;
  readonly answerRedacted: boolean;
  /** Durable acknowledgement is not provider receipt. */
  readonly answerDeliveryLabel: string | null;
  /** History-only approval/rejection note; null when the operator wrote none. */
  readonly noteText: string | null;
  readonly noteDeliveryLabel: string | null;
  /** Explicit reason when stored payload/answer/note content was undecodable. */
  readonly historyUnavailable: string | null;
}

const answerText = (value: string | ReadonlyArray<string>): string =>
  typeof value === "string" ? value : value.join(", ");

/**
 * The durable history projection for a decided request.
 *
 * It distinguishes an answered question from an approved permission and states
 * that provider receipt is unknown. Redacted secret answers are shown as
 * redacted rather than as the operator's text. Legacy rows with no stored
 * answer keep that absence explicit instead of implying the answer was empty.
 */
export function approvalRequestHistory(request: ApprovalRequest): ApprovalRequestHistory {
  const answer = request.answer;
  const note = request.decisionNote;
  const answerTextValue =
    answer === undefined
      ? null
      : answer.legacyText !== undefined
        ? answer.legacyText
        : answer.answers.length > 0
          ? answer.answers
              .map(
                (entry) =>
                  `${entry.questionId}: ${
                    entry.redacted === true ? "[redacted]" : answerText(entry.answer)
                  }`,
              )
              .join("\n")
          : null;

  return {
    answered: request.state === "answered",
    deliveryPending: request.state === "delivering",
    answerText: answerTextValue,
    answerRedacted: answer?.answers.some((entry) => entry.redacted === true) ?? false,
    answerDeliveryLabel:
      answer === undefined
        ? null
        : request.state === "delivering"
          ? "Delivery unknown; local acceptance recorded, provider receipt unconfirmed"
          : "Provider receipt not confirmed",
    noteText: note?.text ?? null,
    noteDeliveryLabel: note === undefined ? null : "History only; not sent to the agent",
    historyUnavailable: request.historyUnavailable ?? null,
  };
}
