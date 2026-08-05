import type {
  AttentionItem,
  QueueItem,
  RunDetails,
  RunSummary,
  SymphonyOverview,
  TrackerHealth,
  WorkflowRecord,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

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
    readonly workflowId?: string;
    readonly limit?: number;
  }) => Effect.Effect<QueueItem[]>;
  readonly listRuns: (filter?: {
    readonly workflowId?: string;
    readonly limit?: number;
  }) => Effect.Effect<RunSummary[]>;
  /** Full run details: work item, attempt, timeline, attention items. */
  readonly getRun: (runAttemptId: string) => Effect.Effect<RunDetails | null>;
  /** Open attention items: pending approvals and input requests. */
  readonly listAttention: (limit?: number) => Effect.Effect<AttentionItem[]>;
  readonly listWorkflows: () => Effect.Effect<WorkflowRecord[]>;
  readonly listTrackerHealth: () => Effect.Effect<TrackerHealth[]>;
  readonly isPaused: () => Effect.Effect<boolean>;

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
}

export class SymphonyOrchestrator extends Context.Service<
  SymphonyOrchestrator,
  SymphonyOrchestratorShape
>()("neokod/symphony/Orchestrator/SymphonyOrchestrator") {}
