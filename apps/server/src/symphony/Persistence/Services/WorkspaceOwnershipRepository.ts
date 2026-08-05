import type { WorkItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * WorkspaceOwnershipRepository (plan 16.0, Phase 4).
 *
 * Persisted record of which mode owns a workspace (`symphony` | `work`), so
 * Work-mode and Symphony-mode cleanup paths cannot delete a worktree the other
 * is using. Acquire, transfer, renew and release are conditional transactions
 * carrying a fencing `generation`: a stale holder cannot reclaim a workspace
 * that moved on without it.
 */

export type WorkspaceOwner = "symphony" | "work";

export interface WorkspaceOwnershipRecord {
  readonly workspacePath: string;
  readonly owner: WorkspaceOwner;
  readonly workItemId: WorkItemId | null;
  readonly threadId: string | null;
  readonly generation: number;
  readonly leaseExpiresAt: string | null;
  readonly updatedAt: string;
}

export interface WorkspaceOwnershipRepositoryShape {
  /**
   * Claim a workspace for an owner. Succeeds with the new record when the
   * workspace was unowned or the record is stale; fails with null when the
   * workspace is owned by a different owner with a live lease.
   */
  readonly acquire: (input: {
    readonly workspacePath: string;
    readonly owner: WorkspaceOwner;
    readonly workItemId?: WorkItemId;
    readonly threadId?: string;
    readonly leaseExpiresAt?: string;
  }) => Effect.Effect<WorkspaceOwnershipRecord | null, SymphonyPersistenceError>;

  /** Fenced transfer: only succeeds when the caller holds the current
   * generation of the record. Returns null on fence miss. */
  readonly transfer: (input: {
    readonly workspacePath: string;
    readonly owner: WorkspaceOwner;
    readonly workItemId?: WorkItemId | null;
    readonly threadId?: string | null;
    readonly generation: number;
    readonly leaseExpiresAt?: string | null;
  }) => Effect.Effect<WorkspaceOwnershipRecord | null, SymphonyPersistenceError>;

  /** Renew the lease window on a held record (fenced by generation). */
  readonly renew: (input: {
    readonly workspacePath: string;
    readonly owner: WorkspaceOwner;
    readonly generation: number;
    readonly leaseExpiresAt: string;
  }) => Effect.Effect<WorkspaceOwnershipRecord | null, SymphonyPersistenceError>;

  /** Release ownership (fenced by generation). Returns null on fence miss. */
  readonly release: (input: {
    readonly workspacePath: string;
    readonly owner: WorkspaceOwner;
    readonly generation: number;
  }) => Effect.Effect<boolean, SymphonyPersistenceError>;

  readonly getByWorkspacePath: (
    workspacePath: string,
  ) => Effect.Effect<WorkspaceOwnershipRecord | null, SymphonyPersistenceError>;
}

export class WorkspaceOwnershipRepository extends Context.Service<
  WorkspaceOwnershipRepository,
  WorkspaceOwnershipRepositoryShape
>()("neokod/symphony/Persistence/Services/WorkspaceOwnershipRepository") {}
