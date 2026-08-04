import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";

import { isStateIn, normalizeLabel } from "../Trackers/Normalize.ts";

/**
 * Dispatch eligibility calculation (SPEC 8.2, PRD FR-016).
 *
 * Pure function of (workflow config, issue, claims/concurrency) -> eligibility.
 * The orchestrator owns the final gate; this module is what it runs so the
 * rules stay testable in isolation. Claimed/running/concurrency are passed in
 * because they are orchestrator state, not issue properties.
 */

export interface EligibilityInput {
  readonly config: EffectiveWorkflowConfig;
  readonly issue: NormalizedIssue;
  /** Opaque dispatch IDs already claimed (running/retrying). */
  readonly claimedIssueIds: ReadonlySet<string>;
  /** True when dispatch is globally paused or the workflow is paused. */
  readonly dispatchPaused: boolean;
}

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly reasons: ReadonlyArray<string>;
}

const normalizeState = (state: string): string => state.trim().toLowerCase();

export const evaluateEligibility = (input: EligibilityInput): EligibilityResult => {
  const { config, issue } = input;
  const reasons: string[] = [];

  if (input.dispatchPaused) {
    reasons.push("dispatch_paused");
  }

  const state = normalizeState(issue.state);
  if (!isStateIn(state, config.trackerActiveStates)) {
    reasons.push(`state_not_active:${issue.state}`);
  }
  if (config.trackerTerminalStates.length > 0 && isStateIn(state, config.trackerTerminalStates)) {
    reasons.push(`state_terminal:${issue.state}`);
  }

  if (!issue.dispatchable) {
    reasons.push("not_dispatchable");
  }

  for (const required of config.trackerRequiredLabels) {
    const normalizedRequired = normalizeLabel(required);
    if (normalizedRequired.length === 0) {
      reasons.push("blank_required_label");
      continue;
    }
    if (!issue.labels.some((label) => normalizeLabel(label) === normalizedRequired)) {
      reasons.push(`missing_label:${required}`);
    }
  }

  if (input.claimedIssueIds.has(issue.id)) {
    reasons.push("already_claimed");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
};

/**
 * Projection of an eligible issue into the queued lifecycle. Ineligible issues
 * stay in `eligible` lifecycle but carry their ineligibility reasons so the
 * Queue view can show why each item is not dispatchable (PRD 18.3: "understand
 * why an issue is not eligible without reading logs").
 */
export const inferQueuedLifecycle = (
  issue: NormalizedIssue,
  result: EligibilityResult,
): "queued" | "eligible" => (result.eligible ? "queued" : "eligible");
