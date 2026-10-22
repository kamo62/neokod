import { CommandId, type OrchestrationEvent, type ThreadId, type TurnId } from "@neokod/contracts";
import { makeDrainableWorker } from "@neokod/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  TurnSettlementReactor,
  type TurnSettlementReactorShape,
} from "../Services/TurnSettlementReactor.ts";

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
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  // Turns already published in this process. The durable command receipt makes
  // republication after a restart a no-op.
  const publishedTurnKeys = new Set<string>();

  const publishSettlement = (turn: ProjectionTurn, occurredAt: string) =>
    Effect.gen(function* () {
      if (turn.turnId === null || turn.state === "running" || turn.state === "pending") {
        return;
      }
      const key = `${turn.threadId}:${turn.turnId}`;
      if (publishedTurnKeys.has(key)) {
        return;
      }
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.settle",
          commandId: turnSettlementCommandId(turn.threadId, turn.turnId),
          threadId: turn.threadId,
          turnId: turn.turnId,
          completedAt: turn.completedAt,
          createdAt: occurredAt,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              publishedTurnKeys.add(key);
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to publish turn settlement", {
              threadId: turn.threadId,
              turnId: turn.turnId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    });

  const publishThreadSettlements = Effect.fn("TurnSettlementReactor.publishThreadSettlements")(
    function* (threadId: ThreadId, occurredAt: string) {
      const turns = yield* projectionTurnRepository.listByThreadId({ threadId });
      yield* Effect.forEach(turns, (turn) => publishSettlement(turn, occurredAt), {
        concurrency: 1,
      });
    },
  );

  // A crash between durable closure and publication leaves the settlement
  // unpublished. Republish every durable settled turn at startup so a
  // warm-cache client that resumes from `afterSequence` still receives it.
  const reconcileSettledTurnsAtStartup = Effect.fn(
    "TurnSettlementReactor.reconcileSettledTurnsAtStartup",
  )(function* () {
    const occurredAt = yield* nowIso;
    const turns = yield* projectionTurnRepository.listSettledTurns();
    yield* Effect.forEach(turns, (turn) => publishSettlement(turn, occurredAt), {
      concurrency: 1,
    });
  });

  const processEvent = Effect.fn("TurnSettlementReactor.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    const threadId = settlementSourceThreadId(event);
    if (threadId === null) {
      return;
    }
    yield* publishThreadSettlements(threadId, event.occurredAt);
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
    // forked consumer could otherwise miss a closure committed while the scan
    // runs. Returning from this subscription is the readiness signal.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;

    yield* reconcileSettledTurnsAtStartup().pipe(
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

export const TurnSettlementReactorLive = Layer.effect(TurnSettlementReactor, make);
