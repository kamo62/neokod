import type { RunEvent } from "@neokod/contracts";
import { RunAttemptId, RunEventSequence } from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import {
  RunEventRepository,
  type RunEventRepositoryShape,
} from "../Services/RunEventRepository.ts";

const RunEventRowSchema = Schema.Struct({
  rowId: Schema.Int,
  runAttemptId: RunAttemptId,
  sequence: RunEventSequence,
  eventType: Schema.String,
  occurredAt: Schema.String,
  payloadJson: Schema.NullOr(Schema.String),
});

const rowToEvent = (row: Schema.Schema.Type<typeof RunEventRowSchema>): RunEvent => ({
  sequence: row.sequence,
  runAttemptId: row.runAttemptId,
  eventType: row.eventType,
  occurredAt: row.occurredAt,
  ...(row.payloadJson === null
    ? {}
    : { payload: JSON.parse(row.payloadJson) as Record<string, unknown> }),
});

const SELECT_COLUMNS = `
  row_id AS "rowId", run_attempt_id AS "runAttemptId", sequence,
  event_type AS "eventType", occurred_at AS "occurredAt",
  payload_json AS "payloadJson"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const appendRow = SqlSchema.findOne({
    Request: Schema.Struct({
      runAttemptId: RunAttemptId,
      eventType: Schema.String,
      occurredAt: Schema.String,
      payloadJson: Schema.NullOr(Schema.String),
    }),
    Result: RunEventRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO symphony_run_events (
          run_attempt_id, sequence, event_type, occurred_at, payload_json
        )
        VALUES (
          ${request.runAttemptId},
          COALESCE(
            (SELECT MAX(sequence) + 1 FROM symphony_run_events WHERE run_attempt_id = ${request.runAttemptId}),
            0
          ),
          ${request.eventType},
          ${request.occurredAt},
          ${request.payloadJson}
        )
        RETURNING ${cols}
      `,
  });

  const append: RunEventRepositoryShape["append"] = (runAttemptId, eventType, payload) =>
    Effect.gen(function* () {
      const occurredAt = yield* nowIso;
      const row = yield* appendRow({
        runAttemptId,
        eventType,
        occurredAt,
        payloadJson: payload === undefined ? null : JSON.stringify(payload),
      }).pipe(Effect.mapError(toSqlError("RunEventRepository.append")));
      return rowToEvent(row);
    });

  const listForAttempt: RunEventRepositoryShape["listForAttempt"] = (runAttemptId) =>
    sql<Schema.Schema.Type<typeof RunEventRowSchema>>`
      SELECT ${cols}
      FROM symphony_run_events
      WHERE run_attempt_id = ${runAttemptId}
      ORDER BY sequence ASC
    `.pipe(
      Effect.mapError(toSqlError("RunEventRepository.listForAttempt")),
      Effect.map((rows) => rows.map(rowToEvent)),
    );

  const streamAfter: RunEventRepositoryShape["streamAfter"] = (
    runAttemptId,
    sequenceExclusive,
    limit = 1_000,
  ) =>
    Stream.fromEffect(
      sql<Schema.Schema.Type<typeof RunEventRowSchema>>`
        SELECT ${cols}
        FROM symphony_run_events
        WHERE run_attempt_id = ${runAttemptId}
          AND sequence > ${sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${limit}
      `.pipe(
        Effect.mapError(toSqlError("RunEventRepository.streamAfter")),
        Effect.map((rows) => rows.map(rowToEvent)),
      ),
    ).pipe(Stream.flatMap(Stream.fromIterable));

  const lastSequence: RunEventRepositoryShape["lastSequence"] = (runAttemptId) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ runAttemptId: RunAttemptId }),
      Result: Schema.Struct({ maxSequence: Schema.NullOr(Schema.Int) }),
      execute: (request) =>
        sql`
          SELECT MAX(sequence) AS "maxSequence"
          FROM symphony_run_events
          WHERE run_attempt_id = ${request.runAttemptId}
        `,
    })({ runAttemptId }).pipe(
      Effect.mapError(toSqlError("RunEventRepository.lastSequence")),
      Effect.map((row) => {
        if (row._tag === "None") {
          return 0;
        }
        return row.value.maxSequence ?? 0;
      }),
    );

  return {
    append,
    listForAttempt,
    streamAfter,
    lastSequence,
  } satisfies RunEventRepositoryShape;
});

export const RunEventRepositoryLive = Layer.effect(RunEventRepository, makeRepository);
