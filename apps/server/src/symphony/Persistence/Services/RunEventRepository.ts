import type { RunAttemptId, RunEvent, RunEventSequence } from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * RunEventRepository - append-only run timeline (SPEC 10.4, PRD FR-052).
 *
 * Rows drive both the UI timeline and the privileged-operation audit trail.
 * `sequence` is assigned per attempt by the storage layer.
 */
export interface RunEventRepositoryShape {
  readonly append: (
    runAttemptId: RunAttemptId,
    eventType: string,
    payload?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<RunEvent, SymphonyPersistenceError>;
  /**
   * Append an observation at most once per attempt/type/payload. Reconciliation
   * facts (a PR merged or closed, a stale claim released) can be produced by a
   * scheduled sweep and a manual refresh at the same time; the insert checks
   * for an existing identical event in the same statement, so only the writer
   * that actually observed the change adds history. Returns true when appended.
   */
  readonly appendOnce: (
    runAttemptId: RunAttemptId,
    eventType: string,
    payload?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<boolean, SymphonyPersistenceError>;
  readonly listForAttempt: (
    runAttemptId: RunAttemptId,
  ) => Effect.Effect<RunEvent[], SymphonyPersistenceError>;
  /** Stream after a sequence cursor (exclusive), bounded for subscription resume. */
  readonly streamAfter: (
    runAttemptId: RunAttemptId,
    sequenceExclusive: RunEventSequence,
    limit?: number,
  ) => Stream.Stream<RunEvent, SymphonyPersistenceError>;
  readonly lastSequence: (
    runAttemptId: RunAttemptId,
  ) => Effect.Effect<RunEventSequence, SymphonyPersistenceError>;
}

export class RunEventRepository extends Context.Service<
  RunEventRepository,
  RunEventRepositoryShape
>()("neokod/symphony/Persistence/Services/RunEventRepository") {}
