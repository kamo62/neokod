import type {
  AttentionItem,
  ProjectId,
  QueueItem,
  RunDetails,
  RunEvent,
  RunSummary,
  SymphonyProject,
  SymphonyProjectBoard,
  SymphonyProjectConfiguration,
  SymphonyProjectId,
  SymphonyProjectSourceControl,
  SymphonyOverview,
  TrackerHealth,
  WorkflowRecord,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { SymphonyPersistenceError } from "../Persistence/Errors.ts";

export type SymphonyProjectUpdateResult =
  | { readonly _tag: "updated"; readonly project: SymphonyProject }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "revision_conflict" };

/**
 * SymphonyOrchestrator - single-authority orchestrator for Symphony Mode.
 *
 * Owns the poll loop (SPEC 8.1): on each tick, reconcile, run dispatch
 * preflight validation, fetch candidate issues per active workflow, compute
 * eligibility, and project the queue. At Observe autonomy no dispatch happens;
 * the gate for dispatch (claims, concurrency, workspace creation) is a later
 * phase. This service is what the Observe RPC surface reads from.
 *
 * Read methods never fail: transient tracker/CLI errors are recorded in
 * tracker health and the overview rather than propagated to the UI.
 */
export interface SymphonyOrchestratorShape {
  /** Force an immediate poll + reconcile cycle (the `/refresh` equivalent). */
  readonly refreshNow: () => Effect.Effect<void>;
  readonly getOverview: () => Effect.Effect<SymphonyOverview>;
  readonly listQueue: (filter?: {
    readonly projectId?: SymphonyProjectId | undefined;
    readonly workflowId?: string | undefined;
    readonly repositoryPath?: string | undefined;
    readonly lifecycle?: QueueItem["lifecycle"] | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<QueueItem[]>;
  readonly listRuns: (filter?: {
    readonly projectId?: SymphonyProjectId | undefined;
    readonly workflowId?: string | undefined;
    readonly repositoryPath?: string | undefined;
    readonly status?: RunSummary["status"] | undefined;
    readonly lifecycle?: RunSummary["lifecycle"] | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<RunSummary[]>;
  /** Full run details: work item, attempt, timeline, attention items. */
  readonly getRun: (runAttemptId: string) => Effect.Effect<RunDetails | null>;
  readonly listProjects: () => Effect.Effect<SymphonyProject[]>;
  readonly getProject: (projectId: SymphonyProjectId) => Effect.Effect<SymphonyProject | null>;
  readonly createProject: (input: {
    readonly id: SymphonyProjectId;
    readonly codeProjectId: ProjectId;
    readonly title: string;
    readonly repositoryPath: string;
    readonly configuration: SymphonyProjectConfiguration;
    readonly now: string;
  }) => Effect.Effect<SymphonyProject, SymphonyPersistenceError>;
  readonly updateProject: (input: {
    readonly projectId: SymphonyProjectId;
    readonly expectedRevision: number;
    readonly title?: string;
    readonly configuration?: SymphonyProjectConfiguration;
    readonly status?: "active" | "paused";
    readonly now: string;
  }) => Effect.Effect<SymphonyProjectUpdateResult, SymphonyPersistenceError>;
  readonly getProjectSourceControl: (
    projectId: SymphonyProjectId,
  ) => Effect.Effect<SymphonyProjectSourceControl | null>;
  readonly getProjectBoard: (
    projectId: SymphonyProjectId,
  ) => Effect.Effect<SymphonyProjectBoard | null>;
  /** The run's event timeline (subscribeRunEvents stream). */
  readonly listRunEvents: (runAttemptId: string) => Effect.Effect<RunEvent[]>;
  /** Open attention items: pending approvals and input requests. */
  readonly listAttention: (filter?: {
    readonly projectId?: SymphonyProjectId | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<AttentionItem[]>;
  readonly listWorkflows: () => Effect.Effect<WorkflowRecord[]>;
  readonly listTrackerHealth: () => Effect.Effect<TrackerHealth[]>;
  /** Single workflow record (getWorkflow RPC; audit item 8 lane B). */
  readonly getWorkflow: (workflowId: string) => Effect.Effect<WorkflowRecord | null>;
  /** Tracker health/profiles for the UI (listTrackers RPC). */
  readonly listTrackers: () => Effect.Effect<TrackerHealth[]>;
  /** Terminal runs, newest first (listHistory RPC). */
  readonly listHistory: (filter?: {
    readonly projectId?: SymphonyProjectId | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<RunSummary[]>;
  /** Resolve a raised attention item (resolveAttention RPC). */
  readonly resolveAttention: (
    attentionItemId: string,
    resolution: string,
  ) => Effect.Effect<boolean>;
  readonly isPaused: () => Effect.Effect<boolean>;

  // Pause/resume safety controls (plan 9.6, FR-130-134): per-scope pause
  // gates dispatch; global pause is the top-level kill switch.
  readonly isWorkflowPaused: (workflowId: string) => Effect.Effect<boolean>;
  readonly setWorkflowPaused: (workflowId: string, paused: boolean) => Effect.Effect<void>;
  readonly isRepositoryPaused: (repositoryPath: string) => Effect.Effect<boolean>;
  readonly setRepositoryPaused: (repositoryPath: string, paused: boolean) => Effect.Effect<void>;
  readonly setGlobalPaused: (paused: boolean) => Effect.Effect<void>;
  /** Cancel every live run (FR-134): confirm required at the RPC boundary. */
  readonly stopAllRuns: () => Effect.Effect<number, never, Scope.Scope>;

  // Queue overrides (FR-022): persisted per work-item, survive restart, and are
  // re-applied after every tracker refresh so a poll cannot resurrect an
  // excluded item or reset a local priority.
  readonly excludeWorkItem: (workItemId: string, exclude: boolean) => Effect.Effect<void>;
  readonly includeWorkItem: (workItemId: string) => Effect.Effect<void>;
  readonly setLocalPriority: (workItemId: string, priority: number) => Effect.Effect<void>;

  // Dispatch (Phase 2): claim -> workspace -> run turn. Only active when the
  // workflow autonomy is prepare/execute/deliver; observe never dispatches.
  readonly dispatchWorkItem: (workItemId: string) => Effect.Effect<void, never, Scope.Scope>;
  readonly cancelRun: (runAttemptId: string) => Effect.Effect<void, never, Scope.Scope>;

  // Review lifecycle (Phase 5, plan 14): review actions with their own
  // lifecycle transitions and confirmations.
  readonly requestChanges: (workItemId: string, reason?: string) => Effect.Effect<boolean, never>;
  readonly approveMerge: (workItemId: string) => Effect.Effect<boolean, never>;

  /** Re-fetch the open PR for a review-ready item and update its evidence
   * bundle (plan 10.1: host enrichment; keeps the review panel current). */
  readonly refreshPullRequest: (workItemId: string) => Effect.Effect<boolean, never>;
}

export class SymphonyOrchestrator extends Context.Service<
  SymphonyOrchestrator,
  SymphonyOrchestratorShape
>()("neokod/symphony/Orchestrator/SymphonyOrchestrator") {}
