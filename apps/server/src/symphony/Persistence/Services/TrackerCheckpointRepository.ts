import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import { decodeJson, encodeJson } from "../Json.ts";

const CheckpointRowSchema = Schema.Struct({
  trackerKind: Schema.String,
  scopeKey: Schema.String,
  lastPollAt: Schema.String,
  cursorJson: Schema.NullOr(Schema.String),
});

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

export interface TrackerCheckpointRepositoryShape {
  readonly getCheckpoint: (input: {
    readonly trackerKind: string;
    readonly scopeKey: string;
  }) => Effect.Effect<
    { readonly lastPollAt: string; readonly cursor: unknown | null } | null,
    SymphonyPersistenceSqlError
  >;
  readonly upsertCheckpoint: (input: {
    readonly trackerKind: string;
    readonly scopeKey: string;
    readonly cursor?: unknown;
  }) => Effect.Effect<void, SymphonyPersistenceSqlError>;
}

export class TrackerCheckpointRepository extends Context.Service<
  TrackerCheckpointRepository,
  TrackerCheckpointRepositoryShape
>()("neokod/symphony/Persistence/Services/TrackerCheckpointRepository") {}

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getCheckpoint: TrackerCheckpointRepositoryShape["getCheckpoint"] = (input) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ trackerKind: Schema.String, scopeKey: Schema.String }),
      Result: CheckpointRowSchema,
      execute: (request) =>
        sql`
          SELECT tracker_kind AS "trackerKind", scope_key AS "scopeKey",
            last_poll_at AS "lastPollAt", cursor_json AS "cursorJson"
          FROM symphony_tracker_checkpoints
          WHERE tracker_kind = ${request.trackerKind} AND scope_key = ${request.scopeKey}
        `,
    })({ trackerKind: input.trackerKind, scopeKey: input.scopeKey }).pipe(
      Effect.mapError(toSqlError("TrackerCheckpointRepository.getCheckpoint")),
      Effect.map((row) =>
        row._tag === "None"
          ? null
          : {
              lastPollAt: row.value.lastPollAt,
              cursor: row.value.cursorJson === null ? null : decodeJson(row.value.cursorJson),
            },
      ),
    );

  const upsertCheckpoint: TrackerCheckpointRepositoryShape["upsertCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      yield* sql`
        INSERT INTO symphony_tracker_checkpoints (tracker_kind, scope_key, last_poll_at, cursor_json)
        VALUES (${input.trackerKind}, ${input.scopeKey}, ${timestamp},
          ${input.cursor === undefined ? null : encodeJson(input.cursor)})
        ON CONFLICT(tracker_kind, scope_key) DO UPDATE SET
          last_poll_at = ${timestamp},
          cursor_json = ${input.cursor === undefined ? null : encodeJson(input.cursor)}
      `.pipe(Effect.mapError(toSqlError("TrackerCheckpointRepository.upsertCheckpoint")));
    });

  return { getCheckpoint, upsertCheckpoint };
});

export const TrackerCheckpointRepositoryLive: Layer.Layer<
  TrackerCheckpointRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(TrackerCheckpointRepository, makeRepository);
