import type { EvidenceBundle } from "@neokod/contracts";
import { WorkItemId } from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import {
  EvidenceRepository,
  type EvidenceRepositoryShape,
} from "../Services/EvidenceRepository.ts";

const EvidenceRowSchema = Schema.Struct({
  workItemId: WorkItemId,
  bundleJson: Schema.String,
  createdAt: Schema.String,
});

const rowToBundle = (row: Schema.Schema.Type<typeof EvidenceRowSchema>): EvidenceBundle =>
  JSON.parse(row.bundleJson) as EvidenceBundle;

const SELECT_COLUMNS = `
  work_item_id AS "workItemId", bundle_json AS "bundleJson", created_at AS "createdAt"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const upsert: EvidenceRepositoryShape["upsert"] = (workItemId, bundle) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const row = yield* SqlSchema.findOne({
        Request: Schema.Struct({
          workItemId: WorkItemId,
          bundleJson: Schema.String,
          createdAt: Schema.String,
        }),
        Result: EvidenceRowSchema,
        execute: (request) =>
          sql`
            INSERT INTO symphony_evidence (work_item_id, bundle_json, created_at)
            VALUES (${request.workItemId}, ${request.bundleJson}, ${request.createdAt})
            ON CONFLICT(work_item_id) DO UPDATE SET
              bundle_json = ${request.bundleJson},
              created_at = ${request.createdAt}
            RETURNING ${cols}
          `,
      })({ workItemId, bundleJson: JSON.stringify(bundle), createdAt }).pipe(
        Effect.mapError(toSqlError("EvidenceRepository.upsert")),
      );
      return rowToBundle(row);
    });

  const getByWorkItem: EvidenceRepositoryShape["getByWorkItem"] = (workItemId) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ workItemId: WorkItemId }),
      Result: EvidenceRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_evidence
          WHERE work_item_id = ${request.workItemId}
        `,
    })({ workItemId }).pipe(
      Effect.mapError(toSqlError("EvidenceRepository.getByWorkItem")),
      Effect.map((row) => (row._tag === "None" ? null : rowToBundle(row.value))),
    );

  return {
    upsert,
    getByWorkItem,
  } satisfies EvidenceRepositoryShape;
});

export const EvidenceRepositoryLive = Layer.effect(EvidenceRepository, makeRepository);
