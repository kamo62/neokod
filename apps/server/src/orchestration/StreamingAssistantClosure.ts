import { CommandId, type ThreadId, type TurnId } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * The single durable closure step for assistant messages owned by turns that
 * have ended. Callers pin the ended turn ids and the interruption cutoff, so a
 * delayed or repeated settlement never touches a newer running turn.
 */
export const completeStreamingAssistantMessages = (input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadMessagesById">;
  readonly threadId: ThreadId;
  readonly endedTurnIds: ReadonlySet<TurnId>;
  readonly observedNoLaterThan: string;
  readonly occurredAt: string;
}) =>
  Effect.gen(function* () {
    if (input.endedTurnIds.size === 0) {
      return;
    }
    const messages = (yield* input.projectionSnapshotQuery.getThreadMessagesById(
      input.threadId,
    )).filter(
      (message) =>
        message.role === "assistant" &&
        message.streaming &&
        message.turnId !== null &&
        input.endedTurnIds.has(message.turnId) &&
        message.updatedAt <= input.observedNoLaterThan,
    );
    yield* Effect.forEach(
      messages,
      (message) =>
        input.orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(
            `reconcile:assistant-complete:${input.threadId}:${message.id}:${message.updatedAt}`,
          ),
          threadId: input.threadId,
          messageId: message.id,
          ...(message.turnId !== null ? { turnId: message.turnId } : {}),
          lastObservedAt: message.updatedAt,
          createdAt: input.occurredAt,
        }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });
