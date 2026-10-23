import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceRef } from "./providerInstance.ts";
import { UserInputQuestion } from "./providerRuntime.ts";

/**
 * Symphony Mode contracts.
 *
 * Symphony is the second top-level operating mode of Neokod: workflow-led,
 * tracker-driven autonomous execution of repository work. Work Mode remains
 * interactive and developer-led; both modes share the same underlying
 * providers, repositories, workspaces, git services and evidence model.
 *
 * This module defines the canonical domain model (normalized issue, work
 * item, run attempt, evidence bundle, attention, approvals), the workflow
 * contract (`WORKFLOW.md`), and the WebSocket RPC surface. It is schema-only;
 * all runtime behaviour lives in `apps/server/src/symphony/`.
 *
 * @module symphony
 */

export const SYMPHONY_WS_METHODS = {
  // Overview / reads
  getOverview: "symphony.getOverview",
  listQueue: "symphony.listQueue",
  listRuns: "symphony.listRuns",
  getRun: "symphony.getRun",
  listProjects: "symphony.listProjects",
  getProject: "symphony.getProject",
  createProject: "symphony.createProject",
  updateProject: "symphony.updateProject",
  startProject: "symphony.startProject",
  pauseProject: "symphony.pauseProject",
  getProjectBoard: "symphony.getProjectBoard",
  listWorkflows: "symphony.listWorkflows",
  getWorkflow: "symphony.getWorkflow",
  validateWorkflow: "symphony.validateWorkflow",
  getWorkflowContent: "symphony.getWorkflowContent",
  saveWorkflowContent: "symphony.saveWorkflowContent",
  createWorkflow: "symphony.createWorkflow",
  listTrackers: "symphony.listTrackers",
  listHistory: "symphony.listHistory",

  // Workflow controls
  activateWorkflow: "symphony.activateWorkflow",
  pauseWorkflow: "symphony.pauseWorkflow",
  resumeWorkflow: "symphony.resumeWorkflow",
  pauseRepository: "symphony.pauseRepository",
  resumeRepository: "symphony.resumeRepository",
  pauseGlobal: "symphony.pauseGlobal",
  resumeGlobal: "symphony.resumeGlobal",

  // Dispatch / run controls
  dispatchWorkItem: "symphony.dispatchWorkItem",
  excludeWorkItem: "symphony.excludeWorkItem",
  includeWorkItem: "symphony.includeWorkItem",
  setLocalPriority: "symphony.setLocalPriority",
  cancelRun: "symphony.cancelRun",
  stopAllRuns: "symphony.stopAllRuns",
  resumeAutonomous: "symphony.resumeAutonomous",

  // Review / attention
  approve: "symphony.approve",
  reject: "symphony.reject",
  respondToUserInput: "symphony.respondToUserInput",
  listAttention: "symphony.listAttention",
  resolveAttention: "symphony.resolveAttention",
  requestChanges: "symphony.requestChanges",
  approveMerge: "symphony.approveMerge",
  refreshPullRequest: "symphony.refreshPullRequest",

  // Cross-mode handoff
  takeOver: "symphony.takeOver",
  delegateFromThread: "symphony.delegateFromThread",

  // Diagnostics
  exportDiagnostics: "symphony.exportDiagnostics",

  // Streaming subscriptions
  subscribeOverview: "subscribeSymphonyOverview",
  subscribeRuns: "subscribeSymphonyRuns",
  subscribeQueue: "subscribeSymphonyQueue",
  subscribeAttention: "subscribeSymphonyAttention",
  subscribeRunEvents: "subscribeSymphonyRunEvents",
  subscribeProjectBoard: "subscribeSymphonyProjectBoard",
} as const;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const WorkflowId = makeEntityId("SymphonyWorkflowId");
export type WorkflowId = typeof WorkflowId.Type;
export const SymphonyProjectId = makeEntityId("SymphonyProjectId");
export type SymphonyProjectId = typeof SymphonyProjectId.Type;
export const WorkItemId = makeEntityId("SymphonyWorkItemId");
export type WorkItemId = typeof WorkItemId.Type;
export const RunAttemptId = makeEntityId("SymphonyRunAttemptId");
export type RunAttemptId = typeof RunAttemptId.Type;
export const AttentionItemId = makeEntityId("SymphonyAttentionItemId");
export type AttentionItemId = typeof AttentionItemId.Type;
export const SymphonyApprovalRequestId = makeEntityId("SymphonyApprovalRequestId");
export type SymphonyApprovalRequestId = typeof SymphonyApprovalRequestId.Type;
export const RunEventSequence = NonNegativeInt;
export type RunEventSequence = typeof RunEventSequence.Type;

/**
 * Sanitized, collision-resistant workspace directory name derived from an
 * issue identifier (SPEC 4.2). Only `[A-Za-z0-9._-]` characters.
 */
export const WorkspaceKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/));
export type WorkspaceKey = typeof WorkspaceKey.Type;

// ---------------------------------------------------------------------------
// Normalized tracker issue (SPEC 4.1.1)
// ---------------------------------------------------------------------------

export const BlockerRefSchema = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  identifier: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
});
export type BlockerRef = typeof BlockerRefSchema.Type;

/**
 * Best-effort, non-secret provider identifiers preserved for provider-native
 * agent tools and prompt context. Never used as a map key; never contains
 * credentials (SPEC 4.1.1, 11.3).
 */
export const NativeRefSchema = Schema.Record(Schema.String, Schema.Unknown);
export type NativeRef = typeof NativeRefSchema.Type;

export const NormalizedIssueSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  nativeRef: Schema.NullOr(NativeRefSchema),
  identifier: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Int),
  state: Schema.NonEmptyString,
  branchName: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  assigneeId: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  blockedBy: Schema.Array(BlockerRefSchema),
  dispatchable: Schema.Boolean,
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type NormalizedIssue = typeof NormalizedIssueSchema.Type;

// ---------------------------------------------------------------------------
// Work source and lifecycle (PRD 11.2, 11.3)
// ---------------------------------------------------------------------------

export const WorkSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("github"),
    externalId: Schema.String,
    externalUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("linear"),
    externalId: Schema.String,
    externalUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("jira"),
    externalId: Schema.String,
    externalUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("azure_boards"),
    externalId: Schema.String,
    externalUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("gitlab"),
    externalId: Schema.String,
    externalUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("asana"),
    externalId: Schema.String,
    externalUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("github_projects"),
    externalId: Schema.String,
    externalUrl: Schema.String,
  }),
]);
export type WorkSource = typeof WorkSourceSchema.Type;

export const WorkLifecycleSchema = Schema.Literals([
  "draft",
  "ineligible",
  "queued",
  "preparing",
  "running",
  "testing",
  "blocked",
  "waiting_for_approval",
  "retry_scheduled",
  "validation_failed",
  "ready_for_review",
  "changes_requested",
  "ready_to_merge",
  "completed",
  "cancelled",
  "failed",
]);
export type WorkLifecycle = typeof WorkLifecycleSchema.Type;

// ---------------------------------------------------------------------------
// Run attempt (PRD 11.4, SPEC 7.2)
// ---------------------------------------------------------------------------

export const RunAttemptStatusSchema = Schema.Literals([
  "preparing_workspace",
  "building_prompt",
  "launching_agent",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
  "user_cancelled",
  "tracker_cancelled",
  "process_failed",
  "validation_failed",
  "workflow_error",
  "provider_error",
  "interrupted",
  "retries_exhausted",
]);
export type RunAttemptStatus = typeof RunAttemptStatusSchema.Type;

export const TokenUsageSchema = Schema.Struct({
  inputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  totalTokens: Schema.optional(NonNegativeInt),
});
export type TokenUsage = typeof TokenUsageSchema.Type;

export const RunErrorSchema = Schema.Struct({
  category: TrimmedNonEmptyString,
  message: Schema.String,
  attemptNumber: Schema.optional(NonNegativeInt),
});
export type RunError = typeof RunErrorSchema.Type;

/**
 * Positive, server-owned Stop closure for one exact attempt. It is produced
 * only after confirmed process closure; absence is unknown/legacy.
 */
export const SymphonyStopClosureSchema = Schema.Struct({
  state: Schema.Literal("confirmed"),
  runAttemptId: RunAttemptId,
  observedAt: IsoDateTime,
  source: Schema.Literal("recovery.stop_confirmed"),
});
export type SymphonyStopClosure = typeof SymphonyStopClosureSchema.Type;

export const TrackerKindSchema = Schema.Literals([
  "github",
  "jira",
  "linear",
  "gitlab",
  "asana",
  "azure_boards",
  "github_projects",
]);
export type TrackerKind = typeof TrackerKindSchema.Type;

export const AutonomyLevelSchema = Schema.Literals(["observe", "prepare", "execute", "deliver"]);
export type AutonomyLevel = typeof AutonomyLevelSchema.Type;

/**
 * A tracker kind plus the real manual work source. Saved source provenance must
 * not relabel a manual item as whichever tracker the workflow happens to use.
 */
export const AcceptedSourceKindSchema = Schema.Union([TrackerKindSchema, Schema.Literal("manual")]);
export type AcceptedSourceKind = typeof AcceptedSourceKindSchema.Type;

/** Operator text that was deliberately absent versus deliberately empty. */
export const AcceptedInstructionTextSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("absent") }),
  Schema.Struct({ state: Schema.Literal("present"), text: Schema.String }),
]);
export type AcceptedInstructionText = typeof AcceptedInstructionTextSchema.Type;

export const AcceptedDeliveryScopeSchema = Schema.Struct({
  /** null records "the workflow did not state a value"; it is not coerced to false. */
  approvalBeforePush: Schema.NullOr(Schema.Boolean),
  approvalBeforePullRequest: Schema.NullOr(Schema.Boolean),
  approvalBeforeMerge: Schema.NullOr(Schema.Boolean),
});
export type AcceptedDeliveryScope = typeof AcceptedDeliveryScopeSchema.Type;

export const AcceptedPermissionScopeSchema = Schema.Struct({
  autonomy: AutonomyLevelSchema,
  approvalPolicy: Schema.Literals(["untrusted", "on-request", "never"]),
  threadSandbox: Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  turnSandboxPolicy: Schema.Union([
    Schema.Struct({ type: Schema.Literal("readOnly") }),
    Schema.Struct({ type: Schema.Literal("workspaceWrite") }),
    Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
  ]),
  editsAllowed: Schema.Boolean,
  approvalsEnabled: Schema.Boolean,
  protectedPaths: Schema.Array(Schema.String),
  delivery: AcceptedDeliveryScopeSchema,
});
export type AcceptedPermissionScope = typeof AcceptedPermissionScopeSchema.Type;

export const AcceptedWorkflowGuidanceSchema = Schema.Struct({
  id: WorkflowId,
  path: Schema.String,
  /** Persisted workflow `updatedAt` at acceptance; the existing revision authority. */
  revision: IsoDateTime,
  digest: Schema.String,
  /** Parsed agent-facing body only. Front matter is never accepted. */
  instructions: Schema.String,
  validationRequired: Schema.Array(Schema.String),
});

export const AcceptedSourceSnapshotSchema = Schema.Struct({
  trackerId: Schema.String,
  kind: AcceptedSourceKindSchema,
  externalId: Schema.optional(Schema.String),
  externalUrl: Schema.optional(Schema.String),
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  /** Tracker `updatedAt`; null means the tracker did not report one. */
  revision: Schema.NullOr(IsoDateTime),
  digest: Schema.String,
});

export const AcceptedGuidanceTextSchema = Schema.Struct({
  batch: AcceptedInstructionTextSchema,
  story: AcceptedInstructionTextSchema,
  digest: Schema.String,
});

export const AcceptedTargetSchema = Schema.Struct({
  repositoryId: Schema.optional(Schema.String),
  repositoryPath: Schema.String,
  workflowPath: Schema.String,
  workspacePath: Schema.optional(Schema.String),
  baseBranch: Schema.optional(Schema.String),
  provider: ProviderInstanceRef,
  model: Schema.optional(Schema.String),
});

export const AcceptedGuidanceSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  acceptedAt: IsoDateTime,
  digest: Schema.String,
  workflow: AcceptedWorkflowGuidanceSchema,
  source: AcceptedSourceSnapshotSchema,
  guidance: AcceptedGuidanceTextSchema,
  target: AcceptedTargetSchema,
  permission: AcceptedPermissionScopeSchema,
});
export type AcceptedGuidanceSnapshot = typeof AcceptedGuidanceSnapshotSchema.Type;

export const RunEventSchema = Schema.Struct({
  sequence: RunEventSequence,
  runAttemptId: RunAttemptId,
  eventType: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type RunEvent = typeof RunEventSchema.Type;

export const RunAttemptSchema = Schema.Struct({
  id: RunAttemptId,
  workItemId: WorkItemId,
  attemptNumber: NonNegativeInt,
  workspacePath: Schema.String,
  provider: ProviderInstanceRef,
  model: Schema.optional(TrimmedNonEmptyString),
  status: RunAttemptStatusSchema,
  currentStage: Schema.optional(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(RunErrorSchema),
  tokenUsage: Schema.optional(TokenUsageSchema),
  sessionId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  /**
   * Frozen at admission. Undefined means either a legacy attempt recorded
   * before the field existed, or an attempt refused before acceptance; absence
   * is not an accepted brief and must never be rendered as one.
   */
  acceptedGuidance: Schema.optional(AcceptedGuidanceSnapshotSchema),
  /**
   * Server-owned confirmed Stop closure. Absent means unknown or legacy; never
   * derive it from a cancelled status, PID match or timer.
   */
  stopClosure: Schema.optional(SymphonyStopClosureSchema),
});
export type RunAttempt = typeof RunAttemptSchema.Type;

// ---------------------------------------------------------------------------
// Evidence (PRD 11.5, 14.10)
// ---------------------------------------------------------------------------

export const ChangedFileEvidenceSchema = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  status: Schema.optional(Schema.Literals(["added", "modified", "deleted", "renamed"])),
});
export type ChangedFileEvidence = typeof ChangedFileEvidenceSchema.Type;

export const ValidationStatusSchema = Schema.Literals([
  "passed",
  "failed",
  "skipped",
  "unavailable",
  "warning",
]);
export type ValidationStatus = typeof ValidationStatusSchema.Type;

export const ValidationResultSchema = Schema.Struct({
  command: TrimmedNonEmptyString,
  status: ValidationStatusSchema,
  exitCode: Schema.optional(Schema.Int),
  durationMs: Schema.optional(NonNegativeInt),
  outputPath: Schema.optional(TrimmedNonEmptyString),
  executedAt: Schema.optional(IsoDateTime),
});
export type ValidationResult = typeof ValidationResultSchema.Type;

export const EvidenceItemSchema = Schema.Struct({
  text: TrimmedNonEmptyString,
  source: Schema.optional(Schema.Literals(["agent", "host", "model"])),
});
export type EvidenceItem = typeof EvidenceItemSchema.Type;

export const RiskEvidenceSchema = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high"]),
  text: TrimmedNonEmptyString,
  source: Schema.optional(Schema.Literals(["agent", "host", "model"])),
});
export type RiskEvidence = typeof RiskEvidenceSchema.Type;

export const EvidenceArtefactSchema = Schema.Struct({
  kind: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  path: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
});
export type EvidenceArtefact = typeof EvidenceArtefactSchema.Type;

export const CommitEvidenceSchema = Schema.Struct({
  sha: TrimmedNonEmptyString,
  message: Schema.String,
  authoredAt: IsoDateTime,
});
export type CommitEvidence = typeof CommitEvidenceSchema.Type;

export const PullRequestEvidenceSchema = Schema.Struct({
  number: NonNegativeInt,
  title: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  url: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["open", "draft", "merged", "closed"])),
  ciStatus: Schema.optional(Schema.Literals(["pending", "success", "failure", "unknown"])),
  reviewState: Schema.optional(
    Schema.Literals(["none", "approved", "changes_requested", "review_required"]),
  ),
  mergeable: Schema.optional(Schema.Literals(["mergeable", "conflicting", "unknown"])),
  unresolvedComments: Schema.optional(NonNegativeInt),
  latestCommit: Schema.optional(TrimmedNonEmptyString),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  reviewers: Schema.optional(Schema.Array(Schema.String)),
});
export type PullRequestEvidence = typeof PullRequestEvidenceSchema.Type;

/**
 * Model-authored review evidence (section 10.2, issue #108). Reviewer findings
 * may add warnings or block a configured merge gate, but they never upgrade
 * host-derived evidence or satisfy required validation.
 */
export const ModelReviewRequirementSchema = Schema.Literals([
  "all-approve",
  "any-approve",
  "advisory",
]);
export type ModelReviewRequirement = typeof ModelReviewRequirementSchema.Type;

export const ModelReviewVerdictSchema = Schema.Literals(["approve", "request_changes"]);
export type ModelReviewVerdict = typeof ModelReviewVerdictSchema.Type;

export const ModelReviewFindingSchema = Schema.Struct({
  severity: Schema.Literals(["info", "warning", "blocking"]),
  title: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
  path: Schema.optional(TrimmedNonEmptyString),
});
export type ModelReviewFinding = typeof ModelReviewFindingSchema.Type;

export const ModelReviewerResultSchema = Schema.Struct({
  provenance: Schema.Literal("model"),
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  status: Schema.Literals(["completed", "failed", "interrupted"]),
  verdict: Schema.optional(ModelReviewVerdictSchema),
  summary: Schema.String,
  findings: Schema.Array(ModelReviewFindingSchema),
  error: Schema.optional(Schema.String),
  reviewedAt: IsoDateTime,
});
export type ModelReviewerResult = typeof ModelReviewerResultSchema.Type;

export const ModelReviewArtefactSchema = Schema.Struct({
  provenance: Schema.Literal("model"),
  target: Schema.Literal("baseBranch"),
  baseRef: TrimmedNonEmptyString,
  headRef: TrimmedNonEmptyString,
  baseSha: Schema.optional(TrimmedNonEmptyString),
  headSha: Schema.optional(TrimmedNonEmptyString),
  sourceHashes: Schema.Array(TrimmedNonEmptyString),
  require: ModelReviewRequirementSchema,
  verdict: Schema.Literals(["approve", "request_changes", "advisory"]),
  passed: Schema.Boolean,
  reviewers: Schema.Array(ModelReviewerResultSchema),
  reviewedAt: IsoDateTime,
});
export type ModelReviewArtefact = typeof ModelReviewArtefactSchema.Type;

export const OverallAssessmentSchema = Schema.Literals([
  "insufficient",
  "failed",
  "ready_with_warnings",
  "ready_for_review",
  "ready_to_merge",
]);
export type OverallAssessment = typeof OverallAssessmentSchema.Type;

export const EvidenceBundleSchema = Schema.Struct({
  objective: Schema.optional(Schema.String),
  implementationSummary: Schema.optional(Schema.String),
  changedFiles: Schema.Array(ChangedFileEvidenceSchema),
  testsChanged: Schema.Array(ChangedFileEvidenceSchema),
  commits: Schema.Array(CommitEvidenceSchema),
  validationResults: Schema.Array(ValidationResultSchema),
  assumptions: Schema.Array(EvidenceItemSchema),
  risks: Schema.Array(RiskEvidenceSchema),
  unresolved: Schema.Array(EvidenceItemSchema),
  artefacts: Schema.Array(EvidenceArtefactSchema),
  pullRequest: Schema.NullOr(PullRequestEvidenceSchema),
  modelReview: Schema.NullOr(ModelReviewArtefactSchema),
  overallAssessment: OverallAssessmentSchema,
  workflowVersion: Schema.optional(TrimmedNonEmptyString),
  agent: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  totalDurationMs: Schema.optional(NonNegativeInt),
  tokenUsage: Schema.optional(TokenUsageSchema),
  createdAt: IsoDateTime,
});
export type EvidenceBundle = typeof EvidenceBundleSchema.Type;

// ---------------------------------------------------------------------------
// Work item (PRD 11.1)
// ---------------------------------------------------------------------------

export const WorkItemSchema = Schema.Struct({
  id: WorkItemId,
  mode: Schema.Literals(["work", "symphony"]),
  repositoryId: Schema.optional(TrimmedNonEmptyString),
  repositoryPath: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(SymphonyProjectId),
  workflowId: Schema.optional(WorkflowId),
  objective: Schema.String,
  description: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  source: WorkSourceSchema,
  workspaceKey: Schema.optional(WorkspaceKey),
  workspacePath: Schema.optional(Schema.String),
  baseBranch: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderInstanceRef),
  lifecycle: WorkLifecycleSchema,
  trackerIssueId: Schema.optional(Schema.String),
  trackerIdentifier: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Int),
  localPriority: Schema.optional(Schema.Int),
  excluded: Schema.optionalKey(Schema.Boolean),
  blocked: Schema.optionalKey(Schema.Boolean),
  eligibilityReasons: Schema.Array(TrimmedNonEmptyString),
  evidence: Schema.NullOr(EvidenceBundleSchema),
  /** Server-owned confirmed Stop closure for the exact attempt, when observed. */
  stopClosure: Schema.optional(SymphonyStopClosureSchema),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** When the claim was taken (REVIEW P1 #10: orphan claims are detectable). */
  claimedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** The coding-agent child PID recorded on the claim (audit item 3: orphan
   * termination after a crash needs it; null when never recorded). */
  ownerPid: Schema.optional(Schema.NullOr(PositiveInt)),
  /** The coding-agent child process-GROUP id, captured at spawn as an explicit
   * POSIX group leader (equal to the leader pid). Recovery signals the group,
   * never a bare pid; null when the child was not spawned as a group leader or
   * on a platform without group signalling (Issue #101 spec 4.1 / 6.6). */
  ownerPgid: Schema.optional(Schema.NullOr(PositiveInt)),
  /** Recycle-resistant OS process-birth token for the agent child captured at
   * spawn. Recovery validates the live process against this before signalling;
   * `pid === pgid` alone is not proof of identity (Issue #101 spec 6.6). */
  ownerBirthToken: Schema.optional(Schema.NullOr(Schema.String)),
}).check(
  Schema.makeFilter(
    (input) =>
      input.ownerPgid === undefined ||
      input.ownerPgid === null ||
      input.ownerPid === input.ownerPgid ||
      "ownerPgid must be accompanied by an ownerPid with the same value.",
    { identifier: "WorkItemProcessIdentity" },
  ),
);
export type WorkItem = typeof WorkItemSchema.Type;

// ---------------------------------------------------------------------------
// Attention and approvals (PRD 14.8, 14.9)
// ---------------------------------------------------------------------------

export const AttentionItemKindSchema = Schema.Literals([
  "agent_question",
  "command_approval",
  "protected_path_change",
  "tracker_credential_failure",
  "workflow_invalid",
  "repeated_validation_failure",
  "merge_conflict",
  "run_duration_exceeded",
  "agent_stall",
  "merge_approval",
  "run_interrupted",
  "unknown",
]);
export type AttentionItemKind = typeof AttentionItemKindSchema.Type;

export const AttentionSeveritySchema = Schema.Literals(["low", "medium", "high", "critical"]);
export type AttentionSeverity = typeof AttentionSeveritySchema.Type;

export const AttentionItemStateSchema = Schema.Literals(["open", "resolved", "dismissed"]);
export type AttentionItemState = typeof AttentionItemStateSchema.Type;

export const AttentionItemSchema = Schema.Struct({
  id: AttentionItemId,
  projectId: Schema.optional(SymphonyProjectId),
  workItemId: WorkItemId,
  runAttemptId: Schema.optional(RunAttemptId),
  kind: AttentionItemKindSchema,
  severity: AttentionSeveritySchema,
  state: AttentionItemStateSchema,
  whatHappened: Schema.String,
  whyHuman: Schema.String,
  recommendedResponse: Schema.optional(Schema.String),
  availableActions: Schema.Array(TrimmedNonEmptyString),
  consequences: Schema.optional(Schema.String),
  filter: Schema.optional(
    Schema.Struct({
      repository: Schema.optional(Schema.String),
      workflow: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
    }),
  ),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  resolution: Schema.optional(Schema.String),
});
export type AttentionItem = typeof AttentionItemSchema.Type;

export const ApprovalScopeSchema = Schema.Literals(["once", "current_run", "repository"]);
export type ApprovalScope = typeof ApprovalScopeSchema.Type;

export const ApprovalActionSchema = Schema.Literals([
  "command_execution",
  "network_access",
  "dependency_installation",
  "protected_file_change",
  "push",
  "pull_request",
  "merge",
  "tracker_write",
]);
export type ApprovalAction = typeof ApprovalActionSchema.Type;

export const ApprovalRequestStateSchema = Schema.Literals([
  "pending",
  "delivering",
  "answered",
  "approved",
  "rejected",
  "expired",
  "interrupted",
]);
export type ApprovalRequestState = typeof ApprovalRequestStateSchema.Type;

/**
 * What the runtime is actually asking for. `ApprovalActionSchema` stays the
 * policy vocabulary (the classes a workflow may gate); a request additionally
 * carries provider reaction kinds and questions, and must be able to say
 * `unknown` rather than mislabeling protocol drift.
 */
export const ApprovalRequestActionSchema = Schema.Union([
  ApprovalActionSchema,
  Schema.Literals(["file_change", "user_input", "unknown"]),
]);
export type ApprovalRequestAction = typeof ApprovalRequestActionSchema.Type;

/** An approval is decided (`approved`/`rejected`); a question is answered. */
export const ApprovalRequestKindSchema = Schema.Literals(["approval", "user_input"]);
export type ApprovalRequestKind = typeof ApprovalRequestKindSchema.Type;

/**
 * The question contract version stored in `ApprovalQuestionPayloadSchema`.
 *
 * Version 1 is the provider-neutral shape shared with ordinary provider
 * questions (`UserInputQuestion`) plus the provider's own `isSecret` marker.
 * Any future change to that shape must bump the version instead of silently
 * reinterpreting rows written by an older build.
 */
export const ApprovalQuestionSchemaVersion = 1 as const;

/**
 * One durable Symphony question. It is the shared `UserInputQuestion` shape,
 * so the thread question interaction and the Symphony surface agree on ids,
 * options and multi-select, with the provider's secret flag preserved.
 */
export const ApprovalQuestionSchema = Schema.Struct({
  ...UserInputQuestion.fields,
  /**
   * Codex option descriptions are not guaranteed to be non-empty. Keep them as
   * strings so a blank description is preserved evidence instead of making the
   * whole durable row undecodable.
   */
  options: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      description: Schema.String,
    }),
  ),
  /** Provider flagged this answer as secret; history stores a redaction only. */
  sensitive: Schema.optional(Schema.Boolean),
});
export type ApprovalQuestion = typeof ApprovalQuestionSchema.Type;

/**
 * The durable question payload for a user-input request.
 *
 * Structured questions are versioned. Rows written before questions were
 * persisted fall back to their flattened prompt text (`legacy_text`), and a
 * request whose provider shape could not be preserved is explicitly
 * `unsupported` rather than guessed at.
 */
export const ApprovalQuestionPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("structured"),
    version: Schema.Literal(ApprovalQuestionSchemaVersion),
    questions: Schema.Array(ApprovalQuestionSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("legacy_text"),
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    providerMethod: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
]);
export type ApprovalQuestionPayload = typeof ApprovalQuestionPayloadSchema.Type;

/** A single-provider answer value: one label/custom text, or several for multi-select. */
export const ApprovalAnswerValueSchema = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
]);
export type ApprovalAnswerValue = typeof ApprovalAnswerValueSchema.Type;

/** One answer in an RPC submission, keyed by its provider question id. */
export const ApprovalAnswerInputSchema = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  answer: ApprovalAnswerValueSchema,
});
export type ApprovalAnswerInput = typeof ApprovalAnswerInputSchema.Type;

/** Stored answer content. `redacted` replaces the value for a secret question. */
export const ApprovalAnswerEntrySchema = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  answer: ApprovalAnswerValueSchema,
  redacted: Schema.optional(Schema.Boolean),
});
export type ApprovalAnswerEntry = typeof ApprovalAnswerEntrySchema.Type;

/**
 * Durable answer history.
 *
 * `delivery` is `unknown` because writing a response to the provider stream is
 * not provider acknowledgement: the UI must not present durable history as
 * proof that the agent received it.
 */
export const ApprovalAnswerRecordSchema = Schema.Struct({
  answers: Schema.Array(ApprovalAnswerEntrySchema),
  /** Free text for a legacy request whose question ids were never persisted. */
  legacyText: Schema.optional(TrimmedNonEmptyString),
  delivery: Schema.Literal("unknown"),
  actor: Schema.Literal("local_operator"),
  recordedAt: IsoDateTime,
});
export type ApprovalAnswerRecord = typeof ApprovalAnswerRecordSchema.Type;

/**
 * An approval/rejection note. The Codex approval response carries only a
 * decision, so a note is saved to history and is explicitly not delivered to
 * the agent.
 */
export const ApprovalDecisionNoteSchema = Schema.Struct({
  text: TrimmedNonEmptyString,
  delivery: Schema.Literal("history_only"),
  actor: Schema.Literal("local_operator"),
  recordedAt: IsoDateTime,
});
export type ApprovalDecisionNote = typeof ApprovalDecisionNoteSchema.Type;

export const ApprovalRequestSchema = Schema.Struct({
  id: SymphonyApprovalRequestId,
  requestId: TrimmedNonEmptyString,
  workItemId: WorkItemId,
  runAttemptId: Schema.optional(RunAttemptId),
  /**
   * Whether this request is a gated action or an agent question. Optional so
   * payloads written before the field existed still decode: consumers derive it
   * from `action` when it is absent instead of rejecting known evidence.
   */
  kind: Schema.optional(ApprovalRequestKindSchema),
  /** Normalised request action; `unknown` when the provider kind is not mapped. */
  action: ApprovalRequestActionSchema,
  /** The provider's own kind (`commandExecution`, `fileChange`) when it differs. */
  providerAction: Schema.optional(Schema.String),
  scope: ApprovalScopeSchema,
  state: ApprovalRequestStateSchema,
  command: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  expectedImpact: Schema.optional(Schema.String),
  affectedFiles: Schema.Array(Schema.String),
  reversibility: Schema.optional(Schema.String),
  policySource: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  /**
   * The preserved question shape for a user-input request. Official rows carry
   * a versioned structured payload; older rows decode as `legacy_text` so
   * their flattened prompt stays readable without invented choices.
   */
  questionPayload: Schema.optional(ApprovalQuestionPayloadSchema),
  /** What the operator submitted, for answered questions only. */
  answer: Schema.optional(ApprovalAnswerRecordSchema),
  /** History-only note attached to an approval or rejection. */
  decisionNote: Schema.optional(ApprovalDecisionNoteSchema),
  /**
   * Present when stored answer/note JSON could not be decoded. The row and its
   * question stay readable; no answer or note content is invented.
   */
  historyUnavailable: Schema.optional(Schema.String),
  /**
   * How the request closed. The durable column records the same value as
   * `state` on every close, including `interrupted` (the run died while the
   * request was pending), so an interrupted row stays decodable.
   */
  decision: Schema.optional(
    Schema.Literals(["delivering", "answered", "approved", "rejected", "expired", "interrupted"]),
  ),
});
export type ApprovalRequest = typeof ApprovalRequestSchema.Type;

// ---------------------------------------------------------------------------
// Workflow contract (SPEC 5, PRD 12)
// ---------------------------------------------------------------------------

export const WorkflowDefinitionSchema = Schema.Struct({
  config: Schema.Record(Schema.String, Schema.Unknown),
  promptTemplate: Schema.String,
});
export type WorkflowDefinition = typeof WorkflowDefinitionSchema.Type;

export const SymphonyTrackerScopeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github"),
    repository: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("jira"),
    projectKey: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("linear"),
    projectSlug: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("gitlab"),
    projectPath: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("asana"),
    projectGid: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("azure_boards"),
    /** @deprecated Legacy project-local organization; new projects use global Tracking settings. */
    organization: Schema.optional(TrimmedNonEmptyString),
    project: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("github_projects"),
    owner: TrimmedNonEmptyString,
    number: PositiveInt,
  }),
]);
export type SymphonyTrackerScope = typeof SymphonyTrackerScopeSchema.Type;

export const SymphonyProjectConfigurationSchema = Schema.Struct({
  tracker: SymphonyTrackerScopeSchema,
  trackerRequiredLabels: Schema.Array(Schema.String),
  trackerActiveStates: Schema.Array(Schema.String),
  trackerTerminalStates: Schema.Array(Schema.String),
  autonomy: AutonomyLevelSchema,
  agentProvider: ProviderInstanceRef,
  agentModel: Schema.optional(TrimmedNonEmptyString),
  reviewAgents: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reviewRequirement: Schema.optional(ModelReviewRequirementSchema),
  validationRequired: Schema.Array(Schema.String),
  maxConcurrentAgents: PositiveInt,
  maxTurns: PositiveInt,
  maxAttempts: PositiveInt,
  approvalsBeforePush: Schema.Boolean,
  approvalsBeforePullRequest: Schema.Boolean,
  approvalsBeforeMerge: Schema.Boolean,
});
export type SymphonyProjectConfiguration = typeof SymphonyProjectConfigurationSchema.Type;

export const SymphonyProjectStatusSchema = Schema.Literals(["active", "paused"]);
export type SymphonyProjectStatus = typeof SymphonyProjectStatusSchema.Type;

export const SymphonyProjectSetupStateSchema = Schema.Literals(["ready", "needs_setup"]);
export type SymphonyProjectSetupState = typeof SymphonyProjectSetupStateSchema.Type;

export const SymphonyProjectSchema = Schema.Struct({
  id: SymphonyProjectId,
  codeProjectId: Schema.NullOr(ProjectId),
  title: TrimmedNonEmptyString,
  repositoryPath: TrimmedNonEmptyString,
  status: SymphonyProjectStatusSchema,
  setupState: SymphonyProjectSetupStateSchema,
  configuration: Schema.NullOr(SymphonyProjectConfigurationSchema),
  revision: NonNegativeInt,
  legacyWorkflowId: Schema.NullOr(WorkflowId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SymphonyProject = typeof SymphonyProjectSchema.Type;

export const ApprovalPolicyClassSchema = Schema.Struct({
  action: ApprovalActionSchema,
  mode: Schema.Literals(["auto", "human", "auto_if_required"]),
  scope: ApprovalScopeSchema,
});
export type ApprovalPolicyClass = typeof ApprovalPolicyClassSchema.Type;

/**
 * Typed runtime view of `WORKFLOW.md` front matter plus defaults and `$VAR`
 * resolution (SPEC 6.4, PRD 12). `config` on `WorkflowDefinition` is the raw
 * map; this is the coerced, validated view the orchestrator runs against.
 */
export const EffectiveWorkflowConfigSchema = Schema.Struct({
  repositoryPath: TrimmedNonEmptyString,
  workflowPath: TrimmedNonEmptyString,
  trackerKind: TrackerKindSchema,
  trackerRequiredLabels: Schema.Array(Schema.String),
  trackerActiveStates: Schema.Array(Schema.String),
  trackerTerminalStates: Schema.Array(Schema.String),
  trackerProvider: Schema.Record(Schema.String, Schema.Unknown),
  pollIntervalMs: Schema.optional(NonNegativeInt),
  workspaceRoot: Schema.String,
  autonomy: AutonomyLevelSchema,
  agentProvider: ProviderInstanceRef,
  agentModel: Schema.optional(TrimmedNonEmptyString),
  reviewAgents: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reviewRequirement: Schema.optional(ModelReviewRequirementSchema),
  maxConcurrentAgents: Schema.optional(PositiveInt),
  maxTurns: Schema.optional(PositiveInt),
  maxAttempts: Schema.optional(PositiveInt),
  initialRetryDelayMs: Schema.optional(NonNegativeInt),
  maxRetryBackoffMs: Schema.optional(NonNegativeInt),
  maxRunDurationMs: Schema.optional(NonNegativeInt),
  codexCommand: Schema.optional(Schema.String),
  codexApprovalPolicy: Schema.optional(
    Schema.Literals(["untrusted", "on-failure", "on-request", "never"]),
  ),
  codexThreadSandbox: Schema.optional(
    Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  ),
  codexTurnSandboxPolicy: Schema.optional(
    Schema.Literals(["readOnly", "workspaceWrite", "dangerFullAccess"]),
  ),
  codexTurnTimeoutMs: Schema.optional(NonNegativeInt),
  codexReadTimeoutMs: Schema.optional(NonNegativeInt),
  codexStallTimeoutMs: Schema.optional(Schema.Int),
  validationRequired: Schema.Array(Schema.String),
  validationTestPathPatterns: Schema.Array(Schema.String),
  approvalsBeforePush: Schema.optional(Schema.Boolean),
  approvalsBeforePullRequest: Schema.optional(Schema.Boolean),
  approvalsBeforeMerge: Schema.optional(Schema.Boolean),
  approvalsProtectedPaths: Schema.Array(Schema.String),
  approvalsWaitTimeoutMs: Schema.optional(NonNegativeInt),
  approvalsPolicies: Schema.Array(ApprovalPolicyClassSchema),
  concurrencyGlobal: Schema.optional(NonNegativeInt),
  concurrencyRepository: Schema.optional(NonNegativeInt),
  concurrencyProvider: Schema.optional(NonNegativeInt),
  concurrencyWorkflow: Schema.optional(NonNegativeInt),
  hooksAfterCreate: Schema.optional(Schema.String),
  hooksBeforeRun: Schema.optional(Schema.String),
  hooksAfterRun: Schema.optional(Schema.String),
  hooksBeforeRemove: Schema.optional(Schema.String),
  hooksTimeoutMs: Schema.optional(NonNegativeInt),
  liveRequestsWaitTimeoutMs: Schema.optional(NonNegativeInt),
  handoffState: Schema.optional(TrimmedNonEmptyString),
});
export type EffectiveWorkflowConfig = typeof EffectiveWorkflowConfigSchema.Type;

export const WorkflowStatusSchema = Schema.Literals(["active", "paused", "invalid", "draft"]);
export type WorkflowStatus = typeof WorkflowStatusSchema.Type;

export const WorkflowRecordSchema = Schema.Struct({
  id: WorkflowId,
  repositoryPath: TrimmedNonEmptyString,
  workflowPath: TrimmedNonEmptyString,
  status: WorkflowStatusSchema,
  autonomy: AutonomyLevelSchema,
  validationError: Schema.NullOr(Schema.String),
  definition: WorkflowDefinitionSchema,
  effectiveConfig: Schema.NullOr(EffectiveWorkflowConfigSchema),
  enabledAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkflowRecord = typeof WorkflowRecordSchema.Type;

export const WorkflowValidationField = Schema.Struct({
  field: TrimmedNonEmptyString,
  message: Schema.String,
});
export type WorkflowValidationField = typeof WorkflowValidationField.Type;

export const WorkflowValidationResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(WorkflowValidationField),
});
export type WorkflowValidationResult = typeof WorkflowValidationResultSchema.Type;

// ---------------------------------------------------------------------------
// Overview / queue / run summaries (PRD 16, 25.1)
// ---------------------------------------------------------------------------

export const SymphonyOverviewMetricSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("known"), value: NonNegativeInt }),
  Schema.Struct({ state: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export type SymphonyOverviewMetric = typeof SymphonyOverviewMetricSchema.Type;

export const SymphonyOverviewSchema = Schema.Struct({
  running: SymphonyOverviewMetricSchema,
  queued: SymphonyOverviewMetricSchema,
  needsAttention: SymphonyOverviewMetricSchema,
  readyForReview: SymphonyOverviewMetricSchema,
  retrying: SymphonyOverviewMetricSchema,
  failedToday: SymphonyOverviewMetricSchema,
  orchestratorPaused: Schema.NullOr(Schema.Boolean),
  activeWorkflowCount: SymphonyOverviewMetricSchema,
  providerHealth: Schema.Record(Schema.String, Schema.Struct({ available: Schema.Boolean })),
  trackerHealth: Schema.Record(
    Schema.String,
    Schema.Struct({ ok: Schema.Boolean, lastPollAt: Schema.NullOr(IsoDateTime) }),
  ),
  lastTrackerPollAt: Schema.NullOr(IsoDateTime),
  // follower: another Neokod process holds the orchestrator lock on this database; this process only observes
  orchestratorRole: Schema.optional(Schema.Literals(["leader", "follower"])),
  activeAgentCount: SymphonyOverviewMetricSchema,
  tokenUsage: Schema.optional(TokenUsageSchema),
  generatedAt: IsoDateTime,
});
export type SymphonyOverview = typeof SymphonyOverviewSchema.Type;

export const QueueItemSchema = Schema.Struct({
  workItemId: WorkItemId,
  projectId: Schema.optional(SymphonyProjectId),
  trackerIdentifier: Schema.optional(Schema.String),
  title: Schema.String,
  repositoryPath: Schema.optional(Schema.String),
  workflowId: Schema.optional(WorkflowId),
  state: Schema.String,
  lifecycle: WorkLifecycleSchema,
  priority: Schema.optional(Schema.Int),
  blocked: Schema.Boolean,
  blockers: Schema.Array(BlockerRefSchema),
  eligible: Schema.Boolean,
  ineligibilityReasons: Schema.Array(TrimmedNonEmptyString),
  excluded: Schema.Boolean,
  estimatedReadiness: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type QueueItem = typeof QueueItemSchema.Type;

/**
 * Compact PR reference carried on `RunSummary` (reviews-list PR badges): just
 * enough to render a linked, tone-coloured badge without pulling the full
 * evidence bundle. Optional so old persisted/streamed `RunSummary` payloads
 * still decode.
 */
export const RunSummaryPullRequestSchema = Schema.Struct({
  number: NonNegativeInt,
  url: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["open", "draft", "merged", "closed"])),
});
export type RunSummaryPullRequest = typeof RunSummaryPullRequestSchema.Type;

export const RunSummarySchema = Schema.Struct({
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  projectId: Schema.optional(SymphonyProjectId),
  trackerIdentifier: Schema.optional(Schema.String),
  issueTitle: Schema.optional(Schema.String),
  repositoryPath: Schema.optional(Schema.String),
  workflowId: Schema.optional(WorkflowId),
  provider: Schema.optional(ProviderInstanceRef),
  model: Schema.optional(Schema.String),
  status: RunAttemptStatusSchema,
  currentStage: Schema.optional(TrimmedNonEmptyString),
  attemptNumber: NonNegativeInt,
  retryCount: NonNegativeInt,
  startedAt: IsoDateTime,
  elapsedMs: Schema.optional(NonNegativeInt),
  tokenUsage: Schema.optional(TokenUsageSchema),
  latestEvent: Schema.optional(TrimmedNonEmptyString),
  workspacePath: Schema.optional(Schema.String),
  lifecycle: WorkLifecycleSchema,
  /** Evidence assessment for the run (REVIEW P1: the reviews list rendered a
   * fabricated green badge because the summary did not carry it). */
  overallAssessment: Schema.optional(OverallAssessmentSchema),
  /** Compact PR reference for the reviews-list and history-view badges. */
  pullRequest: Schema.optional(RunSummaryPullRequestSchema),
});
export type RunSummary = typeof RunSummarySchema.Type;

export const RunDetailsSchema = Schema.Struct({
  workItem: WorkItemSchema,
  runAttempt: RunAttemptSchema,
  timeline: Schema.Array(RunEventSchema),
  attentionItems: Schema.Array(AttentionItemSchema),
  approvalRequests: Schema.Array(ApprovalRequestSchema),
});
export type RunDetails = typeof RunDetailsSchema.Type;

export const RunHistoryEntrySchema = Schema.Struct({
  workItemId: WorkItemId,
  projectId: Schema.optional(SymphonyProjectId),
  trackerIdentifier: Schema.optional(Schema.String),
  issueTitle: Schema.optional(Schema.String),
  repositoryPath: Schema.optional(Schema.String),
  lifecycle: WorkLifecycleSchema,
  overallAssessment: Schema.optional(OverallAssessmentSchema),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.optional(NonNegativeInt),
  provider: Schema.optional(ProviderInstanceRef),
  pullRequest: Schema.NullOr(PullRequestEvidenceSchema),
});
export type RunHistoryEntry = typeof RunHistoryEntrySchema.Type;

export const TrackerHealthSchema = Schema.Struct({
  kind: TrackerKindSchema,
  ok: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  lastPollAt: Schema.NullOr(IsoDateTime),
  profile: Schema.Record(Schema.String, Schema.Unknown),
});
export type TrackerHealth = typeof TrackerHealthSchema.Type;

export const SymphonyBoardColumnIdSchema = Schema.Literals([
  "not_started",
  "in_progress",
  "testing",
  "human_review",
  "done",
]);
export type SymphonyBoardColumnId = typeof SymphonyBoardColumnIdSchema.Type;

export const SymphonyBoardCardSchema = Schema.Struct({
  workItemId: WorkItemId,
  projectId: SymphonyProjectId,
  trackerIdentifier: Schema.optional(Schema.String),
  title: Schema.String,
  lifecycle: WorkLifecycleSchema,
  columnId: SymphonyBoardColumnIdSchema,
  outcome: Schema.NullOr(Schema.Literals(["completed", "cancelled", "failed"])),
  priority: Schema.optional(Schema.Int),
  issueUrl: Schema.optional(Schema.String),
  eligibilityReasons: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  latestRunAttemptId: Schema.optional(RunAttemptId),
  updatedAt: IsoDateTime,
});
export type SymphonyBoardCard = typeof SymphonyBoardCardSchema.Type;

export const SymphonyBoardColumnSchema = Schema.Struct({
  id: SymphonyBoardColumnIdSchema,
  title: TrimmedNonEmptyString,
  cards: Schema.Array(SymphonyBoardCardSchema),
  totalCount: Schema.optional(NonNegativeInt),
});
export type SymphonyBoardColumn = typeof SymphonyBoardColumnSchema.Type;

export const SymphonyProjectSourceControlSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({
    state: Schema.Literal("known"),
    vcsKind: TrimmedNonEmptyString,
    provider: Schema.NullOr(TrimmedNonEmptyString),
    remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
    authenticated: Schema.NullOr(Schema.Boolean),
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Schema.String,
  }),
]);
export type SymphonyProjectSourceControl = typeof SymphonyProjectSourceControlSchema.Type;

export const SymphonyProjectBoardSchema = Schema.Struct({
  project: SymphonyProjectSchema,
  sourceControl: SymphonyProjectSourceControlSchema,
  columns: Schema.Array(SymphonyBoardColumnSchema),
  generatedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type SymphonyProjectBoard = typeof SymphonyProjectBoardSchema.Type;

// ---------------------------------------------------------------------------
// Handoff (PRD 14.12, 16)
// ---------------------------------------------------------------------------

export const WorkModeHandoffSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  workspacePath: TrimmedNonEmptyString,
  branch: Schema.String,
  workItemId: WorkItemId,
});
export type WorkModeHandoff = typeof WorkModeHandoffSchema.Type;

export const DelegateFromThreadInputSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  workflowId: Schema.optional(WorkflowId),
  autonomy: Schema.optional(AutonomyLevelSchema),
  objective: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
});
export type DelegateFromThreadInput = typeof DelegateFromThreadInputSchema.Type;

export const DelegateFromThreadResultSchema = Schema.Struct({
  workItemId: WorkItemId,
});
export type DelegateFromThreadResult = typeof DelegateFromThreadResultSchema.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SymphonyError extends Schema.TaggedErrorClass<SymphonyError>()("SymphonyError", {
  code: TrimmedNonEmptyString,
  message: Schema.String,
  workItemId: Schema.optional(WorkItemId),
  runAttemptId: Schema.optional(RunAttemptId),
}) {
  override get message(): string {
    return `${this.code}: ${this.message}`;
  }
}

export const SymphonyRpcErrorSchema = Schema.Union([
  SymphonyError,
  Schema.Struct({ _tag: Schema.Literal("UnknownSymphonyError"), message: Schema.String }),
]);

// ---------------------------------------------------------------------------
// RPC inputs / outputs
// ---------------------------------------------------------------------------

export const SymphonyGetOverviewInput = Schema.Struct({});
export const SymphonyListQueueInput = Schema.Struct({
  projectId: Schema.optional(SymphonyProjectId),
  workflowId: Schema.optional(WorkflowId),
  repositoryPath: Schema.optional(Schema.String),
  lifecycle: Schema.optional(WorkLifecycleSchema),
  limit: Schema.optional(PositiveInt),
});
export const SymphonyListRunsInput = Schema.Struct({
  projectId: Schema.optional(SymphonyProjectId),
  workflowId: Schema.optional(WorkflowId),
  repositoryPath: Schema.optional(Schema.String),
  status: Schema.optional(RunAttemptStatusSchema),
  lifecycle: Schema.optional(WorkLifecycleSchema),
  limit: Schema.optional(PositiveInt),
});
export const SymphonyGetRunInput = Schema.Struct({
  runAttemptId: RunAttemptId,
});
export const SymphonyListProjectsInput = Schema.Struct({});
export const SymphonyGetProjectInput = Schema.Struct({
  projectId: SymphonyProjectId,
});
export const SymphonyCreateProjectInput = Schema.Struct({
  codeProjectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  configuration: SymphonyProjectConfigurationSchema,
});
export const SymphonyUpdateProjectInput = Schema.Struct({
  projectId: SymphonyProjectId,
  expectedRevision: NonNegativeInt,
  title: Schema.optional(TrimmedNonEmptyString),
  configuration: Schema.optional(SymphonyProjectConfigurationSchema),
});
export const SymphonyStartProjectInput = Schema.Struct({
  projectId: SymphonyProjectId,
  expectedRevision: NonNegativeInt,
});
export const SymphonyPauseProjectInput = Schema.Struct({
  projectId: SymphonyProjectId,
  expectedRevision: NonNegativeInt,
});
export const SymphonyGetProjectBoardInput = Schema.Struct({
  projectId: SymphonyProjectId,
});
export const SymphonyListWorkflowsInput = Schema.Struct({
  repositoryPath: Schema.optional(Schema.String),
});
export const SymphonyGetWorkflowInput = Schema.Struct({
  workflowId: WorkflowId,
});
export const SymphonyValidateWorkflowInput = Schema.Struct({
  repositoryPath: TrimmedNonEmptyString,
  workflowPath: Schema.optional(Schema.String),
});
/**
 * In-app workflow editor (PRD 12.3, pragmatic v1). `getWorkflowContent`
 * reads the raw WORKFLOW.md text; `saveWorkflowContent` writes it and
 * re-parses through the workflow loader. Both resolve the file path from
 * the persisted `WorkflowRecord` server-side, never from client input.
 */
export const SymphonyGetWorkflowContentInput = Schema.Struct({
  workflowId: WorkflowId,
});
export const SymphonyGetWorkflowContentResult = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
export const SymphonySaveWorkflowContentInput = Schema.Struct({
  workflowId: WorkflowId,
  content: Schema.String,
});
export const SymphonySaveWorkflowContentResult = Schema.Struct({
  ok: Schema.Boolean,
  validationError: Schema.optional(Schema.String),
});
/**
 * Create a brand-new WORKFLOW.md for a tracked project from the in-app "New
 * workflow" dialog. `repositoryPath` is validated server-side against the
 * projects the server already knows about — never trusted as an arbitrary
 * filesystem path. The file always lands at `<repositoryPath>/WORKFLOW.md`;
 * an existing file there is refused rather than overwritten. Content is
 * re-parsed through the workflow loader exactly like `saveWorkflowContent`,
 * so invalid content still creates the file and record, surfacing
 * `validationError` instead of being silently dropped.
 */
export const SymphonyCreateWorkflowInput = Schema.Struct({
  repositoryPath: TrimmedNonEmptyString,
  content: Schema.String,
});
export const SymphonyCreateWorkflowResult = Schema.Struct({
  ok: Schema.Boolean,
  workflowId: Schema.optional(WorkflowId),
  validationError: Schema.optional(Schema.String),
});
export const SymphonyListTrackersInput = Schema.Struct({});
export const SymphonyListHistoryInput = Schema.Struct({
  projectId: Schema.optional(SymphonyProjectId),
  limit: Schema.optional(PositiveInt),
});
export const SymphonyActivateWorkflowInput = Schema.Struct({
  repositoryPath: TrimmedNonEmptyString,
  workflowPath: Schema.optional(Schema.String),
  autonomy: Schema.optional(AutonomyLevelSchema),
});
export const SymphonyPauseWorkflowInput = Schema.Struct({ workflowId: WorkflowId });
export const SymphonyResumeWorkflowInput = Schema.Struct({ workflowId: WorkflowId });
export const SymphonyPauseRepositoryInput = Schema.Struct({
  repositoryPath: TrimmedNonEmptyString,
});
export const SymphonyResumeRepositoryInput = Schema.Struct({
  repositoryPath: TrimmedNonEmptyString,
});
export const SymphonyPauseGlobalInput = Schema.Struct({});
export const SymphonyResumeGlobalInput = Schema.Struct({});
export const SymphonyDispatchWorkItemInput = Schema.Struct({
  workItemId: WorkItemId,
});
export const SymphonyExcludeWorkItemInput = Schema.Struct({
  workItemId: WorkItemId,
  exclude: Schema.Boolean,
});
export const SymphonyIncludeWorkItemInput = Schema.Struct({
  workItemId: WorkItemId,
});
export const SymphonySetLocalPriorityInput = Schema.Struct({
  workItemId: WorkItemId,
  priority: Schema.Int,
});
export const SymphonyCancelRunInput = Schema.Struct({
  runAttemptId: RunAttemptId,
});

/**
 * Honest Stop acknowledgement.
 *
 * `held` means ownership was deliberately kept; a caller must not present the
 * run as stopped or released. `evidence` is the closure evidence string from
 * the shared process helper; contracts do not import runtime helper enums.
 */
export const SymphonyStopOutcomeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("confirmed"),
    runAttemptId: RunAttemptId,
    evidence: Schema.String,
    released: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("held"),
    runAttemptId: RunAttemptId,
    reason: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
]);
export type SymphonyStopOutcome = typeof SymphonyStopOutcomeSchema.Type;

/**
 * `outcome` is optional for compatibility with older servers. Its absence means
 * unknown, never confirmed. `ok` is not stop proof.
 */
export const SymphonyStopResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  outcome: Schema.optional(SymphonyStopOutcomeSchema),
});
export type SymphonyStopResult = typeof SymphonyStopResultSchema.Type;

/**
 * Stop-all keeps the legacy `ok` shape and adds confirmed/held counts only when
 * the server actually observed them. Held runs are not counted as stopped.
 */
export const SymphonyStopAllResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  confirmed: Schema.optional(NonNegativeInt),
  held: Schema.optional(NonNegativeInt),
});
export type SymphonyStopAllResult = typeof SymphonyStopAllResultSchema.Type;
export const SymphonyStopAllRunsInput = Schema.Struct({
  confirm: Schema.Literal("stop-all-runs"),
});
export const SymphonyResumeAutonomousInput = Schema.Struct({
  workItemId: WorkItemId,
});
export const SymphonyApproveInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  scope: ApprovalScopeSchema,
  /** Saved to history only; Codex approval responses carry no note. */
  note: Schema.optional(TrimmedNonEmptyString),
  /** Optional exact run/attempt check; rejects a stale record id. */
  runAttemptId: Schema.optional(RunAttemptId),
});
export const SymphonyRejectInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  /** Backward-compatible alias for `note`. */
  reason: Schema.optional(Schema.String),
  /** Saved to history only; Codex approval responses carry no note. */
  note: Schema.optional(TrimmedNonEmptyString),
  runAttemptId: Schema.optional(RunAttemptId),
});
export const SymphonyRespondToUserInputInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  /** Structured answers, one per provider question id. */
  answers: Schema.optional(Schema.Array(ApprovalAnswerInputSchema)),
  /** Legacy free text, accepted only for a legacy-text request. */
  text: Schema.optional(Schema.String),
  runAttemptId: Schema.optional(RunAttemptId),
});
export const SymphonyResolveAttentionInput = Schema.Struct({
  attentionItemId: AttentionItemId,
});
export const SymphonyListAttentionInput = Schema.Struct({
  projectId: Schema.optional(SymphonyProjectId),
  limit: Schema.optional(PositiveInt),
});
export const SymphonyRequestChangesInput = Schema.Struct({
  workItemId: WorkItemId,
  reason: Schema.optional(Schema.String),
});
export const SymphonyApproveMergeInput = Schema.Struct({
  workItemId: WorkItemId,
});
export const SymphonyRefreshPullRequestInput = Schema.Struct({
  workItemId: WorkItemId,
});
export const SymphonyTakeOverInput = Schema.Struct({
  runAttemptId: RunAttemptId,
});

/**
 * Delegate a Work Mode thread into a Symphony work item (PRD FR-110/111,
 * plan 12). Carries the thread identity plus the fields a new work item needs:
 * objective, repository, current branch, relevant files, conversation summary,
 * acceptance criteria, and the selected provider where appropriate.
 */
export const SymphonyDelegateFromThreadInput = Schema.Struct({
  threadId: ThreadId,
  objective: TrimmedNonEmptyString,
  repositoryPath: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  relevantFiles: Schema.optional(Schema.Array(Schema.String)),
  summary: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
});
export const SymphonyDelegateFromThreadResult = Schema.Struct({
  workItemId: WorkItemId,
});
export const SymphonyExportDiagnosticsInput = Schema.Struct({
  includeRepositorySource: Schema.optionalKey(Schema.Boolean),
});
export const SymphonyExportDiagnosticsResult = Schema.Struct({
  bundlePath: TrimmedNonEmptyString,
});

// Stream payloads. Discriminated on `type` following the `ServerConfigStreamEvent`
// convention so client-side narrowing is structural rather than tag-keyed.
export const SymphonyOverviewStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("overview"),
    overview: SymphonyOverviewSchema,
  }),
]);

export const SymphonyRunEventsStreamEvent = Schema.Union([
  RunEventSchema,
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("runEvent"),
    runEvent: RunEventSchema,
  }),
]);

export const SymphonyQueueStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("queue"),
    items: Schema.Array(QueueItemSchema),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("queueItemChanged"),
    item: QueueItemSchema,
  }),
]);

export const SymphonyRunsStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("runs"),
    runs: Schema.Array(RunSummarySchema),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("runChanged"),
    run: RunSummarySchema,
  }),
]);

export const SymphonyAttentionStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("attention"),
    items: Schema.Array(AttentionItemSchema),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("attentionItemChanged"),
    item: AttentionItemSchema,
  }),
]);

export const SymphonyProjectBoardStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("projectBoard"),
    board: SymphonyProjectBoardSchema,
  }),
]);

export const SymphonyEmptyResult = Schema.Struct({ ok: Schema.Boolean });

export const SymphonyDispatchRefusalReasonSchema = Schema.Literals([
  "not_leader",
  "not_found",
  "already_running",
  "not_dispatchable",
  "paused",
  "excluded",
  "ineligible",
  "no_workflow",
  "observe_only",
  "concurrency_cap",
  "tracker_refresh_failed",
]);
export type SymphonyDispatchRefusalReason = typeof SymphonyDispatchRefusalReasonSchema.Type;

export const SymphonyDispatchResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("started") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: SymphonyDispatchRefusalReasonSchema,
    detail: Schema.optional(Schema.String),
  }),
]);
export type SymphonyDispatchResult = typeof SymphonyDispatchResultSchema.Type;

export const SymphonyWorkItemResult = Schema.Struct({ workItemId: WorkItemId });
