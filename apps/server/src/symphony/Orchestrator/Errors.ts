import * as Schema from "effect/Schema";

import { WorkItemId } from "@neokod/contracts";

/**
 * Symphony orchestrator errors. Observe-phase errors are informational and
 * surface in tracker health and the overview; they never crash the poll loop.
 */
export class SymphonyOrchestratorError extends Schema.TaggedErrorClass<SymphonyOrchestratorError>()(
  "SymphonyOrchestratorError",
  {
    code: Schema.String,
    message: Schema.String,
    workItemId: Schema.optional(WorkItemId),
    repositoryPath: Schema.optional(Schema.String),
  },
) {}

export const trackerFetchFailed = (
  repositoryPath: string,
  kind: string,
  detail: string,
): SymphonyOrchestratorError =>
  new SymphonyOrchestratorError({
    code: "tracker_fetch_failed",
    message: `Tracker ${kind} fetch failed for ${repositoryPath}: ${detail}`,
    repositoryPath,
  });

export const workflowInvalid = (
  repositoryPath: string,
  detail: string,
): SymphonyOrchestratorError =>
  new SymphonyOrchestratorError({
    code: "workflow_invalid",
    message: `Workflow invalid for ${repositoryPath}: ${detail}`,
    repositoryPath,
  });
