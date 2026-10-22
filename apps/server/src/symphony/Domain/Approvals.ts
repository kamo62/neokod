import type {
  ApprovalRequest,
  ApprovalRequestAction,
  ApprovalRequestKind,
} from "@neokod/contracts";
import { ApprovalActionSchema } from "@neokod/contracts";

/**
 * Approval request vocabulary.
 *
 * The runtime records the provider's own request kind (Codex sends
 * `commandExecution` / `fileChange`); the durable request row stores a
 * normalised request action plus the raw provider kind when the two differ.
 * Rows written before this normalisation existed still carry the raw provider
 * kind, so the same function is used at record time and when decoding rows.
 *
 * A provider kind that is not mapped becomes `unknown`: preserving "we do not
 * know what this asks for" is better than guessing a policy class.
 */
const POLICY_ACTIONS: ReadonlySet<string> = new Set(ApprovalActionSchema.literals);

export const normaliseApprovalRequestAction = (raw: string): ApprovalRequestAction => {
  switch (raw) {
    case "commandExecution":
    case "command_execution":
      return "command_execution";
    case "fileChange":
    case "file_change":
      return "file_change";
    case "user_input":
      return "user_input";
    default:
      return POLICY_ACTIONS.has(raw) ? (raw as ApprovalRequestAction) : "unknown";
  }
};

/** Questions are answered; everything else is a gated action. */
export const approvalRequestKindForAction = (action: ApprovalRequestAction): ApprovalRequestKind =>
  action === "user_input" ? "user_input" : "approval";

/**
 * Effective request kind. Payloads written before the explicit `kind` field
 * existed only carry the action, so it is derived instead of rejected
 * (state-and-evidence: known evidence must not become an error).
 */
export const approvalRequestKind = (
  request: Pick<ApprovalRequest, "kind" | "action">,
): ApprovalRequestKind => request.kind ?? approvalRequestKindForAction(request.action);
