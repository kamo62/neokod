import type { WorkItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

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

/**
 * Cross-mode removal guard (plan 16.0, Phase 4 definition of done).
 *
 * Every worktree removal funnels through a single gateway that checks the
 * ownership record: a workspace held by a live Symphony lease must not be
 * removed by Work-mode cleanup (and vice versa). The guard is optional — when
 * the Symphony persistence layer is not mounted (Work mode alone), it allows
 * removal, so the two modes are independent when Symphony is absent.
 *
 * Removal is refused only while the OTHER owner holds a live lease. The owner
 * itself may always remove (its own cleanup paths), and `force` bypasses the
 * guard for explicit user intent.
 */
export class WorkspaceRemovalBlockedError extends Error {
  readonly workspacePath: string;
  readonly owner: string;

  constructor(workspacePath: string, owner: string) {
    super(`Cannot remove workspace ${workspacePath}: held by a live ${owner} lease`);
    this.name = "WorkspaceRemovalBlockedError";
    this.workspacePath = workspacePath;
    this.owner = owner;
  }
}

/** The ownership table could not be read; removal must fail closed. */
export class WorkspaceRemovalUnavailableError extends Error {
  readonly workspacePath: string;
  readonly underlying: unknown;

  constructor(workspacePath: string, underlying: unknown) {
    super(`Cannot determine ownership of ${workspacePath}; removal refused`);
    this.name = "WorkspaceRemovalUnavailableError";
    this.workspacePath = workspacePath;
    this.underlying = underlying;
  }
}

export interface WorkspaceRemovalGuardShape {
  readonly assertRemovable: (input: {
    readonly workspacePath: string;
    readonly force?: boolean;
    readonly removingOwner: WorkspaceOwner;
  }) => Effect.Effect<void, WorkspaceRemovalBlockedError | WorkspaceRemovalUnavailableError>;
}

export class WorkspaceRemovalGuard extends Context.Service<
  WorkspaceRemovalGuard,
  WorkspaceRemovalGuardShape
>()("neokod/symphony/Persistence/Services/WorkspaceOwnershipRepository/WorkspaceRemovalGuard") {}

export const makeWorkspaceRemovalGuard = (
  repository: WorkspaceOwnershipRepositoryShape,
): WorkspaceRemovalGuardShape => {
  const assertRemovable: WorkspaceRemovalGuardShape["assertRemovable"] = (input) =>
    Effect.gen(function* () {
      // `force` here is git's "remove despite dirty tree"; it is NOT an
      // ownership override (REVIEW P0: Work thread deletion always sends
      // force:true, which would bypass the guard). Only the owning mode may
      // remove its own workspace; a live lease held by the other mode always
      // blocks, unless the lease has expired.
      const record = yield* repository
        .getByWorkspacePath(input.workspacePath)
        .pipe(
          Effect.mapError(
            (underlying) => new WorkspaceRemovalUnavailableError(input.workspacePath, underlying),
          ),
        );
      if (record === null) {
        return;
      }
      if (record.owner === input.removingOwner) {
        return;
      }
      // A NULL lease means held indefinitely (never reclaimable by another
      // owner); an expired lease is reclaimable.
      const expired =
        record.leaseExpiresAt !== null && Date.parse(record.leaseExpiresAt) < Date.now();
      if (!expired) {
        return yield* Effect.fail(
          new WorkspaceRemovalBlockedError(input.workspacePath, record.owner),
        );
      }
    });
  return { assertRemovable };
};
