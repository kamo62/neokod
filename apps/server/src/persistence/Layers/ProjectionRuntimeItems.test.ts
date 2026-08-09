import {
  EventId,
  RuntimeItemId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationRuntimeItem,
} from "@neokod/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionRuntimeItemRepository } from "../Services/ProjectionRuntimeItems.ts";
import { ProjectionRuntimeItemRepositoryLive } from "./ProjectionRuntimeItems.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionRuntimeItemRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function runtimeItem(input: {
  readonly id: string;
  readonly sequence: number;
  readonly mayStillBeRunning?: boolean;
  readonly session?: string;
}): OrchestrationRuntimeItem {
  const mayStillBeRunning = input.mayStillBeRunning ?? false;
  return {
    runtimeItemId: RuntimeItemId.make(input.id),
    providerItemId: null,
    threadId: ThreadId.make("thread-runtime-repository"),
    sessionId: RuntimeSessionId.make(input.session ?? "session-runtime-repository"),
    turnId: TurnId.make("turn-runtime-repository"),
    kind: mayStillBeRunning ? "delegated-task" : "tool",
    scope: mayStillBeRunning ? "detached" : "turn",
    label: mayStillBeRunning ? "Detached task" : "Tool call",
    providerState: "active",
    syntheticState: mayStillBeRunning ? "orphaned" : null,
    effectiveState: mayStillBeRunning ? "orphaned" : "active",
    terminalSource: mayStillBeRunning ? "synthetic" : null,
    mayStillBeRunning,
    providerEventId: EventId.make(`provider-${input.id}`),
    syntheticEventId: mayStillBeRunning ? EventId.make(`synthetic-${input.id}`) : null,
    startedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:01:00.000Z",
    completedAt: mayStillBeRunning ? "2026-04-01T00:01:00.000Z" : null,
    lastSequence: input.sequence,
  };
}

layer("ProjectionRuntimeItemRepository", (it) => {
  it.effect("round-trips durable lifecycle evidence and orders by server sequence", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionRuntimeItemRepository;
      const later = runtimeItem({ id: "runtime-later", sequence: 20, mayStillBeRunning: true });
      const earlier = runtimeItem({ id: "runtime-earlier", sequence: 10 });

      yield* repository.upsert(later);
      yield* repository.upsert(earlier);

      const byId = Option.getOrThrow(
        yield* repository.getById({
          threadId: later.threadId,
          sessionId: later.sessionId,
          kind: later.kind,
          runtimeItemId: later.runtimeItemId,
        }),
      );
      assert.deepStrictEqual(byId, later);
      assert.strictEqual(byId.mayStillBeRunning, true);

      const listed = yield* repository.listByThreadId({ threadId: later.threadId });
      assert.deepStrictEqual(
        listed.map((item) => item.runtimeItemId),
        [earlier.runtimeItemId, later.runtimeItemId],
      );
      assert.deepStrictEqual(
        listed.map((item) => item.mayStillBeRunning),
        [false, true],
      );

      yield* repository.deleteByThreadId({ threadId: later.threadId });
      assert.deepStrictEqual(yield* repository.listByThreadId({ threadId: later.threadId }), []);
    }),
  );

  it.effect("keeps reused provider item ids separate across session generations", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionRuntimeItemRepository;
      const oldSession = runtimeItem({ id: "reused-tool", sequence: 1, session: "session-old" });
      const newSession = runtimeItem({ id: "reused-tool", sequence: 2, session: "session-new" });
      yield* repository.upsert(oldSession);
      yield* repository.upsert(newSession);

      const listed = yield* repository.listByThreadId({ threadId: oldSession.threadId });
      assert.deepStrictEqual(
        listed.map((item) => item.sessionId),
        [oldSession.sessionId, newSession.sessionId],
      );
    }),
  );
});
