import type { WorkItem, WorkItemId, WorkLifecycle } from "@neokod/contracts";
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
    trackerKind: string,
    trackerIssueId: string,
  ) => Effect.Effect<WorkItem | null, SymphonyPersistenceError>;

  /** Read work items in a set of lifecycles, optionally scoped. */
  readonly listByLifecycle: (
    lifecycles: ReadonlyArray<WorkLifecycle>,
    options?: { readonly workflowId?: string; readonly limit?: number },
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
   */
  readonly transition: (
    id: WorkItemId,
    lifecycle: WorkLifecycle,
    options?: { readonly ownerToken?: string; readonly generation?: number },
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
