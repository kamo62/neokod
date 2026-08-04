import type { EffectiveWorkflowConfig, NormalizedIssue, WorkItem } from "@neokod/contracts";
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

export const workItemIdForIssue = (trackerKind: string, issueId: string): WorkItemId =>
  WorkItemId.make(`${trackerKind}:${issueId}`);

export const projectWorkItem = Effect.fn("projectWorkItem")(function* (
  issue: NormalizedIssue,
  config: EffectiveWorkflowConfig,
  eligibility: EligibilityResult,
  now: string,
) {
  const workspaceKey = yield* deriveWorkspaceKeyEffect(issue.identifier);
  const lifecycle = inferQueuedLifecycle(issue, eligibility);

  const source: WorkItem["source"] = {
    kind: config.trackerKind,
    externalId: issue.id,
    externalUrl: issue.url ?? "",
  };

  const workItem: WorkItem = {
    id: workItemIdForIssue(config.trackerKind, issue.id),
    mode: "symphony",
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

  if (issue.description !== null) {
    return { ...workItem, description: issue.description };
  }
  if (issue.branchName !== null) {
    return { ...workItem, baseBranch: issue.branchName };
  }
  if (issue.priority !== null) {
    return { ...workItem, priority: issue.priority };
  }
  if (issue.blockedBy.length > 0) {
    return { ...workItem, blocked: true };
  }
  return workItem;
});
