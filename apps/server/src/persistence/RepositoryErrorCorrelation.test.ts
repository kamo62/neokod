import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as PersistenceErrors from "./Errors.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";

const providerSessionRuntimeLayer = ProviderSessionRuntime.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

describe("persistence error correlation", () => {
  it.effect("correlates provider runtime SQL and per-row decode failures by thread", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-correlation");
      const runtimePayload = "runtime-payload-secret-sentinel";
      const lastSeenAt = "2026-06-20T00:00:00.000Z";

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${threadId},
          ${"codex"},
          NULL,
          ${"codex"},
          ${"invalid-runtime-mode"},
          ${"running"},
          ${lastSeenAt},
          NULL,
          ${`{"secret":"${runtimePayload}"}`}
        )
      `;

      const decodeError = yield* Effect.flip(runtimes.list());
      assert.instanceOf(decodeError, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(decodeError.correlation, { threadId });
      assert.equal(
        decodeError.message,
        `Decode error in ProviderSessionRuntimeRepository.list:decodeRows: ${decodeError.issue}`,
      );
      assert.notInclude(decodeError.issue, runtimePayload);
      assert.notInclude(decodeError.message, runtimePayload);
      assert.notInclude(decodeError.message, lastSeenAt);

      yield* sql`DROP TABLE provider_session_runtime`;
      const sqlFailure = yield* Effect.flip(
        runtimes.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt,
          resumeCursor: null,
          runtimePayload: { secret: runtimePayload },
        }),
      );
      assert.instanceOf(sqlFailure, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(sqlFailure.correlation, { threadId });
      assert.equal(
        sqlFailure.message,
        "SQL error in ProviderSessionRuntimeRepository.upsert:query",
      );
      assert.notInclude(sqlFailure.message, runtimePayload);
      assert.notInclude(sqlFailure.message, lastSeenAt);
    }).pipe(Effect.provide(providerSessionRuntimeLayer)),
  );
});
