import type {
  EffectiveWorkflowConfig,
  NormalizedIssue,
  SymphonyProjectId,
  WorkItem,
} from "@neokod/contracts";
import { WorkItemId } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import { deriveWorkspaceKeyEffect } from "../Domain/Keys.ts";
import { inferQueuedLifecycle } from "./Eligibility.ts";
import type { EligibilityResult } from "./Eligibility.ts";

/**
 * Queue projection (SPEC 8.4, PRD FR-020/021).
 *
 * Maps a normalized tracker issue to a `WorkItem` row keyed by the tracker's
 * opaque dispatch id. The work-item id is deterministic so re-polling upserts
 * the same row instead of duplicating it. Ineligible issues are still stored
 * (lifecycle `eligible`) with their reasons so the Queue view can explain them.
 */

export const workItemIdForIssue = (
  projectId: SymphonyProjectId,
  trackerKind: string,
  issueId: string,
): WorkItemId => WorkItemId.make(`${projectId}:${trackerKind}:${issueId}`);

export const projectWorkItem = Effect.fn("projectWorkItem")(function* (
  issue: NormalizedIssue,
  config: EffectiveWorkflowConfig,
  eligibility: EligibilityResult,
  now: string,
  projectId: SymphonyProjectId,
) {
  const workspaceKey = yield* deriveWorkspaceKeyEffect(issue.identifier);
  const lifecycle = inferQueuedLifecycle(issue, eligibility);

  const source: WorkItem["source"] = {
    kind: config.trackerKind,
    externalId: issue.id,
    externalUrl: issue.url ?? "",
  };

  const workItem: WorkItem = {
    id: workItemIdForIssue(projectId, config.trackerKind, issue.id),
    mode: "symphony",
    projectId,
    repositoryPath: config.repositoryPath,
    objective: issue.title,
    acceptanceCriteria: [],
    source,
    workspaceKey,
    lifecycle,
    trackerIssueId: issue.id,
    trackerIdentifier: issue.identifier,
    eligibilityReasons: [...eligibility.reasons],
    evidence: null,
    createdAt: now,
    updatedAt: now,
  };

  // Fold every present field into the projected row: an issue commonly has a
  // description AND a branch AND a priority AND blockers, and each is
  // independently meaningful to the Queue view. These must accumulate, not
  // short-circuit (the previous exclusive `if (…) return` dropped baseBranch,
  // priority, and blocked for any issue with a description).
  return {
    ...workItem,
    ...(issue.description !== null ? { description: issue.description } : {}),
    ...(issue.branchName !== null ? { baseBranch: issue.branchName } : {}),
    ...(issue.priority !== null ? { priority: issue.priority } : {}),
    ...(issue.blockedBy.length > 0 ? { blocked: true } : {}),
  };
});
