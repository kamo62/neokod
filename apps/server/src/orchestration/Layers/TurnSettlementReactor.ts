import { CommandId, type OrchestrationEvent, type ThreadId } from "@neokod/contracts";
import { makeDrainableWorker } from "@neokod/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
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

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  // Turns already published in this process. The durable command receipt makes
  // republication after a restart a no-op.
  const publishedTurnKeys = new Set<string>();

  const publishSettlements = Effect.fn("TurnSettlementReactor.publishSettlements")(function* (
    threadId: ThreadId,
    occurredAt: string,
  ) {
    const turns = yield* projectionTurnRepository.listByThreadId({ threadId });
    yield* Effect.forEach(
      turns,
      (turn) => {
        if (turn.turnId === null || turn.state === "running" || turn.state === "pending") {
          return Effect.void;
        }
        const key = `${turn.threadId}:${turn.turnId}`;
        if (publishedTurnKeys.has(key)) {
          return Effect.void;
        }
        return orchestrationEngine
          .dispatch({
            type: "thread.turn.settle",
            commandId: CommandId.make(`turn-settlement:${turn.threadId}:${turn.turnId}`),
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
      },
      { concurrency: 1 },
    );
  });

  const processEvent = Effect.fn("TurnSettlementReactor.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    const threadId = settlementSourceThreadId(event);
    if (threadId === null) {
      return;
    }
    yield* publishSettlements(threadId, event.occurredAt);
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
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
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
