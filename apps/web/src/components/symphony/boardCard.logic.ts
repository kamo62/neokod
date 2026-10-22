import type { SymphonyBoardCard, WorkLifecycle } from "@neokod/contracts";

export const RUNNABLE_LIFECYCLES: ReadonlySet<WorkLifecycle> = new Set([
  "queued",
  "retry_scheduled",
]);

export const canRunNow = (
  card: Pick<SymphonyBoardCard, "lifecycle" | "eligibilityReasons">,
): boolean =>
  RUNNABLE_LIFECYCLES.has(card.lifecycle) && (card.eligibilityReasons ?? []).length === 0;

export const formatEligibilityReason = (reason: string): string => {
  if (reason.startsWith("missing_label:")) {
    return `Missing label "${reason.slice("missing_label:".length)}"`;
  }
  if (reason.startsWith("state_not_active:")) {
    return `State "${reason.slice("state_not_active:".length)}" is not active`;
  }
  if (reason.startsWith("state_terminal:")) {
    return `State "${reason.slice("state_terminal:".length)}" is closed`;
  }
  switch (reason) {
    case "not_dispatchable":
      return "The tracker marks it not dispatchable";
    case "already_claimed":
      return "Already claimed";
    case "blank_required_label":
      return "A required label is blank";
    case "dispatch_paused":
      return "Dispatch is paused";
    default:
      return reason;
  }
};
