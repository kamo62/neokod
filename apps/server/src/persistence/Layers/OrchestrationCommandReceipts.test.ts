import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CommandId, ThreadId } from "@neokod/contracts";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationCommandReceipts insert", (it) => {
  it.effect("insert keeps the first receipt and fails on a duplicate command id", () =>
    Effect.gen(function* () {
      const repo = yield* OrchestrationCommandReceiptRepository;
      const acceptedAt = "2026-01-01T00:00:00.000Z";
      yield* repo.insert({
        commandId: CommandId.make("cmd-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        acceptedAt,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
      const error = yield* repo
        .insert({
          commandId: CommandId.make("cmd-1"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-b"),
          acceptedAt,
          resultSequence: 2,
          status: "accepted",
          error: null,
        })
        .pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toBe("PersistenceSqlError");
      const stored = yield* repo.getByCommandId({ commandId: CommandId.make("cmd-1") });
      if (stored._tag !== "Some") throw new Error("expected receipt");
      expect(stored.value.aggregateId).toBe("thread-a");
      expect(stored.value.resultSequence).toBe(1);
    }),
  );
});
