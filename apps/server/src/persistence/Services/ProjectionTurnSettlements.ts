/**
 * ProjectionTurnSettlementRepository - Outbox for per-turn settlement publication.
 *
 * The durable turn projection records one settlement row per closed turn in the
 * same transaction as the turn row. The settlement reactor drains unpublished
 * rows in bounded batches, marks them published after the event is accepted,
 * and never rescans turn history.
 *
 * @module ProjectionTurnSettlements
 */
import { IsoDateTime, NonNegativeInt, ThreadId, TurnId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnSettlement = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTurnSettlement = typeof ProjectionTurnSettlement.Type;

export const RecordProjectionTurnSettlementInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type RecordProjectionTurnSettlementInput = typeof RecordProjectionTurnSettlementInput.Type;

export const ListUnpublishedProjectionTurnSettlementsInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  limit: NonNegativeInt,
});
export type ListUnpublishedProjectionTurnSettlementsInput =
  typeof ListUnpublishedProjectionTurnSettlementsInput.Type;

export const MarkProjectionTurnSettlementPublishedInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  publishedAt: IsoDateTime,
});
export type MarkProjectionTurnSettlementPublishedInput =
  typeof MarkProjectionTurnSettlementPublishedInput.Type;

export interface ProjectionTurnSettlementRepositoryShape {
  /**
   * Record the durable settlement of a turn. The first settlement of a turn
   * wins; later checkpoints or stops do not create a second publication.
   */
  readonly recordSettlement: (
    input: RecordProjectionTurnSettlementInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List unpublished settlements in bounded batches, optionally scoped to one
   * thread. Only the fields needed for publication are decoded.
   */
  readonly listUnpublished: (
    input: ListUnpublishedProjectionTurnSettlementsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurnSettlement>, ProjectionRepositoryError>;

  /**
   * Mark a settlement published after its event was accepted. Idempotent.
   */
  readonly markPublished: (
    input: MarkProjectionTurnSettlementPublishedInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionTurnSettlementRepository - Service tag for the settlement outbox.
 */
export class ProjectionTurnSettlementRepository extends Context.Service<
  ProjectionTurnSettlementRepository,
  ProjectionTurnSettlementRepositoryShape
>()("neokod/persistence/Services/ProjectionTurnSettlements/ProjectionTurnSettlementRepository") {}
