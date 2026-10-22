import type { SymphonyDispatchRefusalReason } from "@neokod/contracts";

/**
 * The one place a dispatch refusal becomes human text. The server owns the
 * decision; the card only adapts the reason it was given.
 */
export const dispatchRefusalMessage = (result: {
  readonly reason: SymphonyDispatchRefusalReason;
  readonly detail?: string | undefined;
}): string => {
  switch (result.reason) {
    case "not_leader":
      return "Another Neokod server is running Symphony. This server only observes.";
    case "not_found":
      return "This work item no longer exists.";
    case "already_running":
      return "A run is already in progress for this item.";
    case "not_dispatchable":
      return "This item cannot be run from its current state.";
    case "paused":
      switch (result.detail) {
        case "global":
          return "Dispatch is paused for all projects.";
        case "repository":
          return "Dispatch is paused for this repository.";
        default:
          return "Dispatch is paused for this project.";
      }
    case "excluded":
      return "This item is excluded. Include it to run it.";
    case "ineligible":
      return `Not eligible: ${result.detail ?? ""}.`;
    case "no_workflow":
      return "This project is not set up to run work. Check its settings.";
    case "observe_only":
      return "Autonomy is set to observe. Change it to prepare, execute or deliver to run work.";
    case "concurrency_cap":
      return `The ${result.detail ?? "current"} concurrency limit is reached. Try again when a run finishes.`;
    case "tracker_refresh_failed":
      return "Could not re-read this issue from the tracker. It may be closed, or the tracker is unreachable.";
  }
};
