import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * OrchestratorStateRepository - single-row orchestrator state: the global
 * pause flag and the advisory lock.
 *
 * One server process holds the lock at a time (plan section 4). The lock is
 * acquired at startup, released on clean shutdown, and reclaimable when its
 * lease expires, so an abandoned lock cannot block the orchestrator forever.
 */
export interface OrchestratorStateRepositoryShape {
  readonly isGlobalPaused: () => Effect.Effect<boolean, SymphonyPersistenceError>;
  readonly setGlobalPaused: (paused: boolean) => Effect.Effect<void, SymphonyPersistenceError>;
  /** Acquire the orchestrator lock; fails if held by a live owner. */
  readonly acquireLock: (options: {
    readonly ownerToken: string;
    readonly leaseMs: number;
  }) => Effect.Effect<boolean, SymphonyPersistenceError>;
  /** Renew the lock lease while the owner is alive. */
  readonly renewLock: (options: {
    readonly ownerToken: string;
    readonly leaseMs: number;
  }) => Effect.Effect<boolean, SymphonyPersistenceError>;
  readonly releaseLock: (ownerToken: string) => Effect.Effect<void, SymphonyPersistenceError>;
}

export class OrchestratorStateRepository extends Context.Service<
  OrchestratorStateRepository,
  OrchestratorStateRepositoryShape
>()("neokod/symphony/Persistence/Services/OrchestratorStateRepository") {}
