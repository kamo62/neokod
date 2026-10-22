import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { sessionUpdateIsReplay } from "./AcpRuntimeModel.ts";

export interface AcpAssistantTextResult {
  readonly stopReason: EffectAcpSchema.PromptResponse["stopReason"];
  readonly text: string;
  readonly usage?: EffectAcpSchema.PromptResponse["usage"];
}

/**
 * Collects assistant text losslessly for text generation. It consumes raw
 * session updates and performs the two filters that matter here: startup/load
 * updates are discarded and updates from non-root sessions are ignored.
 *
 * This deliberately does not use `getEvents`: the shared runtime projection
 * drops whitespace-only assistant chunks after a tool update closes the active
 * segment, which would silently change generated JSON for Cursor and Grok. The
 * runtime should eventually preserve those chunks; until then this collector
 * keeps the previous lossless behaviour without editing the shared runtime.
 */
export function collectAcpAssistantText<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "handleSessionUpdate" | "prompt" | "start"
  >;
  readonly prompt: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<AcpAssistantTextResult, E> {
  return Effect.gen(function* () {
    const textRef = yield* Ref.make("");
    let acceptingUpdates = false;
    let rootSessionId: string | undefined;

    yield* input.runtime.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        if (!acceptingUpdates) {
          return;
        }
        if (sessionUpdateIsReplay(notification)) {
          return;
        }
        if (rootSessionId !== undefined && notification.sessionId !== rootSessionId) {
          return;
        }
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return;
        }
        const content = update.content;
        if (content.type !== "text") {
          return;
        }
        const text = content.text;
        yield* Ref.update(textRef, (current) => current + text);
      }),
    );

    const started = yield* input.runtime.start();
    rootSessionId = started.sessionId;
    acceptingUpdates = true;

    const response = yield* input.runtime.prompt({
      prompt: [{ type: "text", text: input.prompt }],
    });
    return {
      stopReason: response.stopReason,
      text: (yield* Ref.get(textRef)).trim(),
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    };
  }).pipe(Effect.mapError(input.mapError));
}
