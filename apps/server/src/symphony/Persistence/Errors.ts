import * as Schema from "effect/Schema";

import { WorkItemId } from "@neokod/contracts";

/**
 * Symphony persistence errors.
 *
 * The work-item repository is the dispatch authority, so its errors are
 * deliberately distinct: a claim that loses the conditional UPDATE surfaces
 * as `SymphonyClaimLost` (zero changed rows), and a busy database surfaces as
 * a retriable `SymphonyBusy`. Everything else follows the shared persistence
 * error family.
 */
export class SymphonyPersistenceSqlError extends Schema.TaggedErrorClass<SymphonyPersistenceSqlError>()(
  "SymphonyPersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    workItemId: Schema.optional(WorkItemId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Symphony SQL error in ${this.operation}`
      : `Symphony SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class SymphonyPersistenceDecodeError extends Schema.TaggedErrorClass<SymphonyPersistenceDecodeError>()(
  "SymphonyPersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    workItemId: Schema.optional(WorkItemId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Symphony decode error in ${this.operation}: ${this.issue}`;
  }
}

export class SymphonyProjectConflict extends Schema.TaggedErrorClass<SymphonyProjectConflict>()(
  "SymphonyProjectConflict",
  {
    field: Schema.Literals(["id", "code_project_id", "repository_path"]),
    value: Schema.String,
  },
) {
  override get message(): string {
    return `A Symphony project already exists for ${this.field} ${this.value}`;
  }
}

export class SymphonyClaimLost extends Schema.TaggedErrorClass<SymphonyClaimLost>()(
  "SymphonyClaimLost",
  {
    workItemId: WorkItemId,
  },
) {
  override get message(): string {
    return `Claim lost for work item ${this.workItemId}: another claimant won the conditional update`;
  }
}

export class SymphonyBusy extends Schema.TaggedErrorClass<SymphonyBusy>()("SymphonyBusy", {
  operation: Schema.String,
  workItemId: Schema.optional(WorkItemId),
}) {
  override get message(): string {
    return `Database busy in Symphony operation ${this.operation}`;
  }
}

export class SymphonyOrchestratorLockHeld extends Schema.TaggedErrorClass<SymphonyOrchestratorLockHeld>()(
  "SymphonyOrchestratorLockHeld",
  {
    holder: Schema.String,
    expiresAt: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Symphony orchestrator lock held by ${this.holder}`;
  }
}

export type SymphonyPersistenceError =
  | SymphonyPersistenceSqlError
  | SymphonyPersistenceDecodeError
  | SymphonyProjectConflict
  | SymphonyClaimLost
  | SymphonyBusy;
