import type { RunAttemptStatus } from "@neokod/contracts";

export type RunAttemptStatusBadgeVariant = "error" | "info" | "secondary" | "success";

export function runAttemptStatusBadgeVariant(
  status: RunAttemptStatus,
): RunAttemptStatusBadgeVariant {
  switch (status) {
    case "preparing_workspace":
    case "building_prompt":
    case "launching_agent":
    case "initializing_session":
    case "streaming_turn":
    case "finishing":
      return "info";
    case "succeeded":
      return "success";
    case "canceled_by_reconciliation":
    case "user_cancelled":
    case "tracker_cancelled":
    case "interrupted":
      return "secondary";
    case "failed":
    case "timed_out":
    case "stalled":
    case "process_failed":
    case "validation_failed":
    case "workflow_error":
    case "provider_error":
    case "retries_exhausted":
      return "error";
    default:
      return status satisfies never;
  }
}
