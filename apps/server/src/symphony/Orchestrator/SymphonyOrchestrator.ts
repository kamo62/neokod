import type {
  QueueItem,
  RunSummary,
  SymphonyOverview,
  TrackerHealth,
  WorkflowRecord,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

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
  readonly listWorkflows: () => Effect.Effect<WorkflowRecord[]>;
  readonly listTrackerHealth: () => Effect.Effect<TrackerHealth[]>;
  readonly isPaused: () => Effect.Effect<boolean>;
}

export class SymphonyOrchestrator extends Context.Service<
  SymphonyOrchestrator,
  SymphonyOrchestratorShape
>()("neokod/symphony/Orchestrator/SymphonyOrchestrator") {}
