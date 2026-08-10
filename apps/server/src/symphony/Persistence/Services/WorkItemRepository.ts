import type { SymphonyProjectId, WorkItem, WorkItemId, WorkLifecycle } from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * WorkItemRepository - persistence for symphony work items.
 *
 * Work-item rows are the dispatch authority (plan section 4): claiming is a
 * conditional `UPDATE ... WHERE lifecycle IN ('eligible','queued','retry_scheduled')`
 * moving the row to `preparing`, returning either the claimed work item or a
 * claim-lost error. Every subsequent transition and side effect asserts
 * `owner_token = ? AND generation = ?` via {@link assertOwnedTransition}, so a
 * resurrected zombie worker cannot write.
 */
export interface WorkItemRepositoryShape {
  /** Insert a freshly discovered/created work item. Idempotent by unique key. */
  readonly upsert: (workItem: WorkItem) => Effect.Effect<WorkItem, SymphonyPersistenceError>;

  /** Read one work item by id. */
  readonly getById: (id: WorkItemId) => Effect.Effect<WorkItem | null, SymphonyPersistenceError>;

  /** Read the work item for a tracker issue, if one exists. */
  readonly getByTrackerIssue: (
    projectId: SymphonyProjectId,
    trackerKind: string,
    trackerIssueId: string,
  ) => Effect.Effect<WorkItem | null, SymphonyPersistenceError>;

  /** Read work items in a set of lifecycles, optionally scoped. */
  readonly listByLifecycle: (
    lifecycles: ReadonlyArray<WorkLifecycle>,
    options?: {
      readonly projectId?: SymphonyProjectId;
      readonly workflowId?: string;
      readonly limit?: number;
    },
  ) => Effect.Effect<WorkItem[], SymphonyPersistenceError>;

  /** Claim: conditional update to `preparing`, or {@link SymphonyClaimLost}. */
  readonly claim: (
    id: WorkItemId,
    ownerToken: string,
  ) => Effect.Effect<
    { readonly workItem: WorkItem; readonly generation: number },
    SymphonyPersistenceError
  >;

  /**
   * Transition a work item's lifecycle under the owner fence. Side-effect-free
   * state writes pass here; side-effecting transitions must check the returned
   * rowcount before running any external effect.
   *
   * `from` restricts the source lifecycle (plan section 19 suite 6: lifecycle
   * legality). When `from` is given the write only matches rows currently in
   * one of those lifecycles; a terminal item can never be moved back by an
   * unfenced caller. `overrideFence` bypasses the owner fence for deliberate
   * cross-claim transitions (e.g. takeOver parking a run) — use only where
   * the caller is a trusted authority, never for routine state writes.
   */
  readonly transition: (
    id: WorkItemId,
    lifecycle: WorkLifecycle,
    options?: {
      readonly ownerToken?: string;
      readonly generation?: number;
      readonly from?: ReadonlyArray<WorkLifecycle>;
      readonly overrideFence?: boolean;
      readonly requireUnclaimed?: boolean;
    },
  ) => Effect.Effect<boolean, SymphonyPersistenceError>;

  /**
   * Record the coding-agent child PID on a live claim (audit item 3): the
   * claim row starts with the server PID, but orphan adoption after a crash
   * needs the agent child's PID to terminate a surviving orphan. Only matches
   * rows still owned by `ownerToken` at `generation`.
   */
  readonly setClaimOwnerPid: (
    id: WorkItemId,
    ownerToken: string,
    generation: number,
    pid: number,
  ) => Effect.Effect<boolean, SymphonyPersistenceError>;

  /**
   * Release a claim without the owner fence (reconciliation, plan 9.4/9.7).
   * Only matches rows still in `preparing` or `running`, so an already-finished
   * item can never be downgraded; bumps `generation` so any in-flight worker's
   * fences stop matching. Returns true when a claim was actually released.
   */
  readonly releaseClaim: (
    id: WorkItemId,
    to: "queued" | "retry_scheduled",
  ) => Effect.Effect<boolean, SymphonyPersistenceError>;

  /** Write queue overrides (exclude / local priority) that survive restart. */
  readonly writeOverrides: (
    id: WorkItemId,
    overrides: { readonly excluded?: boolean; readonly localPriority?: number | null },
  ) => Effect.Effect<void, SymphonyPersistenceError>;

  /** Update tracker-derived metadata after a poll refresh. */
  readonly refreshTrackerSnapshot: (
    id: WorkItemId,
    snapshot: {
      readonly state?: string;
      readonly labels?: ReadonlyArray<string>;
      readonly priority?: number | null;
      readonly blocked?: boolean;
      readonly lastSeenAt?: string;
    },
  ) => Effect.Effect<void, SymphonyPersistenceError>;
}

export class WorkItemRepository extends Context.Service<
  WorkItemRepository,
  WorkItemRepositoryShape
>()("neokod/symphony/Persistence/Services/WorkItemRepository") {}
