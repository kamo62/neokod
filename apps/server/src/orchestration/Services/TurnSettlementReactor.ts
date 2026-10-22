/**
 * TurnSettlementReactor - Publishes durable per-turn settlement.
 *
 * The durable turn projection owns the single settlement decision: it persists
 * `projection_turns.completed_at` whenever a turn closes. This reactor reacts to
 * the domain events that can close a turn and republishes the value the
 * projection persisted as `thread.turn-settled`, so clients receive the same
 * evidence a snapshot would give them.
 *
 * @module
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * TurnSettlementReactorShape - Service API for the settlement publication.
 */
export interface TurnSettlementReactorShape {
  /**
   * Start publishing turn settlements.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * TurnSettlementReactor - Service tag for the settlement publication worker.
 */
export class TurnSettlementReactor extends Context.Service<
  TurnSettlementReactor,
  TurnSettlementReactorShape
>()("neokod/orchestration/Services/TurnSettlementReactor") {}
