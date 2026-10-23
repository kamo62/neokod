import type { ApprovalRequest, AttentionItem } from "@neokod/contracts";

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
  /** Stored answer content, labelled honestly; null when nothing was stored. */
  readonly answerText: string | null;
  readonly answerRedacted: boolean;
  /** Durable acknowledgement is not provider receipt. */
  readonly answerDeliveryLabel: string | null;
  /** History-only approval/rejection note; null when the operator wrote none. */
  readonly noteText: string | null;
  readonly noteDeliveryLabel: string | null;
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
    answerText: answerTextValue,
    answerRedacted: answer?.answers.some((entry) => entry.redacted === true) ?? false,
    answerDeliveryLabel: answer === undefined ? null : "Provider receipt not confirmed",
    noteText: note?.text ?? null,
    noteDeliveryLabel: note === undefined ? null : "History only; not sent to the agent",
  };
}
