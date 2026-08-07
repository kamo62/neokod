import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

export interface AuditEventInput {
  readonly actor: string;
  readonly eventType: string;
  readonly workItemId?: string;
  readonly runAttemptId?: string;
  readonly payload?: unknown;
}

export interface AuditRepositoryShape {
  /** Append an audit event (plan 13.4; audit item 8 lane E — the table
   * existed with zero writers). Best-effort callers wrap with catch. */
  readonly record: (input: AuditEventInput) => Effect.Effect<void, SymphonyPersistenceSqlError>;
  readonly listRecent: (options?: { readonly limit?: number }) => Effect.Effect<
    ReadonlyArray<{
      readonly occurredAt: string;
      readonly actor: string;
      readonly eventType: string;
      readonly workItemId: string | null;
      readonly runAttemptId: string | null;
      readonly payload: unknown;
    }>,
    SymphonyPersistenceSqlError
  >;
}

export class AuditRepository extends Context.Service<AuditRepository, AuditRepositoryShape>()(
  "neokod/symphony/Persistence/Services/AuditRepository",
) {}

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const record: AuditRepositoryShape["record"] = (input) =>
    Effect.gen(function* () {
      const occurredAt = yield* nowIso;
      yield* sql`
        INSERT INTO symphony_audit_events (
          occurred_at, actor, event_type, work_item_id, run_attempt_id, payload_json
        )
        VALUES (
          ${occurredAt}, ${input.actor}, ${input.eventType},
          ${input.workItemId ?? null}, ${input.runAttemptId ?? null},
          ${input.payload === undefined ? null : JSON.stringify(input.payload)}
        )
      `.pipe(Effect.mapError(toSqlError("AuditRepository.record")));
    });

  const listRecent: AuditRepositoryShape["listRecent"] = (options) =>
    sql<Schema.Schema.Type<typeof AuditRowSchema>>`
      SELECT occurred_at AS "occurredAt", actor, event_type AS "eventType",
        work_item_id AS "workItemId", run_attempt_id AS "runAttemptId", payload_json AS "payloadJson"
      FROM symphony_audit_events
      ORDER BY occurred_at DESC
      LIMIT ${options?.limit ?? 100}
    `.pipe(
      Effect.mapError(toSqlError("AuditRepository.listRecent")),
      Effect.map((rows) =>
        rows.map((row) => ({
          occurredAt: row.occurredAt,
          actor: row.actor,
          eventType: row.eventType,
          workItemId: row.workItemId,
          runAttemptId: row.runAttemptId,
          payload: row.payloadJson === null ? null : (JSON.parse(row.payloadJson) as unknown),
        })),
      ),
    );

  return { record, listRecent };
});

const AuditRowSchema = Schema.Struct({
  occurredAt: Schema.String,
  actor: Schema.String,
  eventType: Schema.String,
  workItemId: Schema.NullOr(Schema.String),
  runAttemptId: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
});

export const AuditRepositoryLive: Layer.Layer<AuditRepository, never, SqlClient.SqlClient> =
  Layer.effect(AuditRepository, makeRepository);
