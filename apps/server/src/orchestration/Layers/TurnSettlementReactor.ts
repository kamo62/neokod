import { CommandId, type OrchestrationEvent, type ThreadId, type TurnId } from "@neokod/contracts";
import { makeDrainableWorker } from "@neokod/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProjectionTurnSettlementRepositoryLive } from "../../persistence/Layers/ProjectionTurnSettlements.ts";
import {
  ProjectionTurnSettlementRepository,
  type ProjectionTurnSettlement,
} from "../../persistence/Services/ProjectionTurnSettlements.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  TurnSettlementReactor,
  type TurnSettlementReactorShape,
} from "../Services/TurnSettlementReactor.ts";

/** Bounded publication batch. */
const SETTLEMENT_BATCH_SIZE = 100;

/** Events after which the turn projection may have closed a turn. */
function settlementSourceThreadId(event: OrchestrationEvent): ThreadId | null {
  switch (event.type) {
    case "thread.session-set":
    case "thread.message-sent":
    case "thread.turn-diff-completed":
      return event.payload.threadId;
    default:
      return null;
  }
}

/**
 * Deterministic command identity for a turn's settlement publication. The
 * durable command receipt makes republishing the same turn a no-op, including
 * across restarts.
 */
export function turnSettlementCommandId(threadId: ThreadId, turnId: TurnId): CommandId {
  return CommandId.make(`turn-settlement:${threadId}:${turnId}`);
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const settlementRepository = yield* ProjectionTurnSettlementRepository;

  const publishSettlement = (settlement: ProjectionTurnSettlement, publishedAt: string) =>
    orchestrationEngine
      .dispatch({
        type: "thread.turn.settle",
        commandId: turnSettlementCommandId(settlement.threadId, settlement.turnId),
        threadId: settlement.threadId,
        turnId: settlement.turnId,
        completedAt: settlement.completedAt,
        createdAt: publishedAt,
      })
      .pipe(
        Effect.andThen(
          settlementRepository.markPublished({
            threadId: settlement.threadId,
            turnId: settlement.turnId,
            publishedAt,
          }),
        ),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to publish turn settlement", {
            threadId: settlement.threadId,
            turnId: settlement.turnId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );

  // Drain the durable outbox in bounded batches. Only rows without a published
  // marker are read, so already published history costs nothing at startup or
  // during streaming.
  const drainUnpublishedSettlements = Effect.fn(
    "TurnSettlementReactor.drainUnpublishedSettlements",
  )(function* (input: { readonly threadId?: ThreadId; readonly publishedAt: string }) {
    while (true) {
      const pending = yield* settlementRepository.listUnpublished({
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        limit: SETTLEMENT_BATCH_SIZE,
      });
      if (pending.length === 0) {
        return;
      }
      let failed = false;
      for (const settlement of pending) {
        const published = yield* publishSettlement(settlement, input.publishedAt);
        if (!published) {
          // Leave the row unpublished and retry on the next trigger or boot.
          // Continue with the rest of the batch so one failure cannot block
          // settlement publication for other turns.
          failed = true;
        }
      }
      if (failed || pending.length < SETTLEMENT_BATCH_SIZE) {
        return;
      }
    }
  });

  const processEvent = Effect.fn("TurnSettlementReactor.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    const threadId = settlementSourceThreadId(event);
    if (threadId === null) {
      return;
    }
    yield* drainUnpublishedSettlements({ threadId, publishedAt: event.occurredAt });
  });

  const processEventSafely = (event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("turn settlement reactor failed to process event", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: TurnSettlementReactorShape["start"] = Effect.fn("start")(function* () {
    // Acquire before startup reconciliation. The hot PubSub has no replay, so a
    // forked consumer could otherwise miss a closure committed while the
    // outbox is drained. Returning from this subscription is the readiness
    // signal.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;

    // Repair closures whose publication was lost to a crash. Only unpublished
    // outbox rows are read, in bounded batches.
    const publishedAt = yield* nowIso;
    yield* drainUnpublishedSettlements({ publishedAt }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("turn settlement startup reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromSubscription(domainEvents), (event) =>
        settlementSourceThreadId(event) === null ? Effect.void : worker.enqueue(event),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies TurnSettlementReactorShape;
});

export const TurnSettlementReactorLive = Layer.effect(TurnSettlementReactor, make).pipe(
  Layer.provide(ProjectionTurnSettlementRepositoryLive),
);
