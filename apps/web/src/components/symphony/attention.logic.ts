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

export function approvalRequestMode(
  request: Pick<ApprovalRequest, "kind">,
): "approval" | "question" {
  return request.kind === "user_input" ? "question" : "approval";
}
