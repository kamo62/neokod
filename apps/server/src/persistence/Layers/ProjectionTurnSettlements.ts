import { NonNegativeInt, ThreadId } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ListUnpublishedProjectionTurnSettlementsInput,
  MarkProjectionTurnSettlementPublishedInput,
  ProjectionTurnSettlement,
  ProjectionTurnSettlementRepository,
  RecordProjectionTurnSettlementInput,
  type ProjectionTurnSettlementRepositoryShape,
} from "../Services/ProjectionTurnSettlements.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionTurnSettlementRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordSettlement = SqlSchema.void({
    Request: RecordProjectionTurnSettlementInput,
    execute: (row) =>
      sql`
        INSERT INTO projection_turn_settlements (
          thread_id,
          turn_id,
          completed_at,
          published_at
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.completedAt},
          NULL
        )
        ON CONFLICT (thread_id, turn_id) DO NOTHING
      `,
  });

  const listUnpublishedAll = SqlSchema.findAll({
    Request: ListUnpublishedProjectionTurnSettlementsInput,
    Result: ProjectionTurnSettlement,
    execute: ({ limit }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          completed_at AS "completedAt"
        FROM projection_turn_settlements
        WHERE published_at IS NULL
        ORDER BY thread_id ASC, turn_id ASC
        LIMIT ${limit}
      `,
  });

  const listUnpublishedByThread = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, limit: NonNegativeInt }),
    Result: ProjectionTurnSettlement,
    execute: ({ threadId, limit }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          completed_at AS "completedAt"
        FROM projection_turn_settlements
        WHERE thread_id = ${threadId}
          AND published_at IS NULL
        ORDER BY turn_id ASC
        LIMIT ${limit}
      `,
  });

  const markPublished = SqlSchema.void({
    Request: MarkProjectionTurnSettlementPublishedInput,
    execute: ({ threadId, turnId, publishedAt }) =>
      sql`
        UPDATE projection_turn_settlements
        SET published_at = ${publishedAt}
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND published_at IS NULL
      `,
  });

  const record: ProjectionTurnSettlementRepositoryShape["recordSettlement"] = (input) =>
    recordSettlement(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnSettlementRepository.recordSettlement:query",
          "ProjectionTurnSettlementRepository.recordSettlement:encodeRequest",
        ),
      ),
    );

  const listUnpublished: ProjectionTurnSettlementRepositoryShape["listUnpublished"] = (input) =>
    (input.threadId === undefined
      ? listUnpublishedAll(input)
      : listUnpublishedByThread({ threadId: input.threadId, limit: input.limit })
    ).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnSettlementRepository.listUnpublished:query",
          "ProjectionTurnSettlementRepository.listUnpublished:decodeRows",
        ),
      ),
    );

  const mark: ProjectionTurnSettlementRepositoryShape["markPublished"] = (input) =>
    markPublished(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnSettlementRepository.markPublished:query",
          "ProjectionTurnSettlementRepository.markPublished:encodeRequest",
        ),
      ),
    );

  return {
    recordSettlement: record,
    listUnpublished,
    markPublished: mark,
  } satisfies ProjectionTurnSettlementRepositoryShape;
});

export const ProjectionTurnSettlementRepositoryLive = Layer.effect(
  ProjectionTurnSettlementRepository,
  makeProjectionTurnSettlementRepository,
);
