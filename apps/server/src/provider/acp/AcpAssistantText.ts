import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export interface AcpAssistantTextResult {
  readonly stopReason: EffectAcpSchema.PromptResponse["stopReason"];
  readonly text: string;
  readonly usage?: EffectAcpSchema.PromptResponse["usage"];
}

/**
 * Collects assistant text from the shared runtime's filtered event stream. Using
 * `getEvents` rather than the raw session-update handler keeps load replay
 * suppression, root-session filtering, and assistant-segment ordering intact.
 * The caller owns startup and any config selection before invoking this helper.
 */
export function collectAcpAssistantText<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getEvents" | "drainEvents" | "prompt"
  >;
  readonly prompt: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<AcpAssistantTextResult, E> {
  return Effect.gen(function* () {
    const textRef = yield* Ref.make("");
    const collector = yield* input.runtime.getEvents().pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "ContentDelta":
            return Ref.update(textRef, (current) => current + event.text);
          case "EventStreamBarrier":
            return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
          default:
            return Effect.void;
        }
      }),
      Effect.forkChild({ startImmediately: true }),
    );

    return yield* Effect.gen(function* () {
      const response = yield* input.runtime.prompt({
        prompt: [{ type: "text", text: input.prompt }],
      });
      yield* input.runtime.drainEvents;
      return {
        stopReason: response.stopReason,
        text: (yield* Ref.get(textRef)).trim(),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
    }).pipe(Effect.ensuring(Fiber.interrupt(collector).pipe(Effect.ignore)));
  }).pipe(Effect.mapError(input.mapError));
}
