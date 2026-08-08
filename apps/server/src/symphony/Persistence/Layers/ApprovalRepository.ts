import type { ApprovalRequest } from "@neokod/contracts";
import { RunAttemptId, SymphonyApprovalRequestId } from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import { decodeJson, encodeJson } from "../Json.ts";
import {
  ApprovalRepository,
  type ApprovalRepositoryShape,
} from "../Services/ApprovalRepository.ts";

const ApprovalRowSchema = Schema.Struct({
  id: SymphonyApprovalRequestId,
  requestId: Schema.String,
  workItemId: Schema.String,
  runAttemptId: Schema.NullOr(RunAttemptId),
  action: Schema.String,
  scope: Schema.String,
  state: Schema.String,
  decision: Schema.NullOr(Schema.String),
  policySource: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
});

const rowToApproval = (row: Schema.Schema.Type<typeof ApprovalRowSchema>): ApprovalRequest => {
  const payload =
    row.payloadJson === null
      ? ({} as Record<string, unknown>)
      : (decodeJson(row.payloadJson) as Record<string, unknown>);
  const affectedFiles = Array.isArray(payload.affectedFiles)
    ? (payload.affectedFiles as string[]).map(String)
    : [];
  return {
    id: row.id,
    requestId: row.requestId,
    workItemId: row.workItemId as ApprovalRequest["workItemId"],
    ...(row.runAttemptId === null ? {} : { runAttemptId: row.runAttemptId }),
    action: row.action as ApprovalRequest["action"],
    scope: row.scope as ApprovalRequest["scope"],
    state: row.state as ApprovalRequest["state"],
    ...(row.decision === null
      ? {}
      : { decision: row.decision as "approved" | "rejected" | "expired" }),
    ...(row.policySource === null ? {} : { policySource: row.policySource }),
    ...(payload.command !== undefined ? { command: String(payload.command) } : {}),
    ...(payload.workingDirectory !== undefined
      ? { workingDirectory: String(payload.workingDirectory) }
      : {}),
    ...(payload.reason !== undefined ? { reason: String(payload.reason) } : {}),
    affectedFiles,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
};

const SELECT_COLUMNS = `
  id, request_id AS "requestId", work_item_id AS "workItemId",
  run_attempt_id AS "runAttemptId", action, scope, state, decision,
  policy_source AS "policySource", payload_json AS "payloadJson",
  created_at AS "createdAt", decided_at AS "decidedAt"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const create: ApprovalRepositoryShape["create"] = (input) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const payload = encodeJson({
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.workingDirectory !== undefined
          ? { workingDirectory: input.workingDirectory }
          : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.affectedFiles !== undefined && input.affectedFiles.length > 0
          ? { affectedFiles: input.affectedFiles }
          : {}),
      });
      const row = yield* SqlSchema.findOne({
        Request: Schema.Struct({
          id: Schema.String,
          requestId: Schema.String,
          workItemId: Schema.String,
          runAttemptId: Schema.NullOr(RunAttemptId),
          action: Schema.String,
          scope: Schema.String,
          payload: Schema.String,
          createdAt: Schema.String,
        }),
        Result: ApprovalRowSchema,
        execute: (request) =>
          sql`
            INSERT INTO symphony_approvals (
              id, request_id, work_item_id, run_attempt_id, action, scope,
              state, policy_source, payload_json, created_at
            )
            VALUES (
              ${request.id}, ${request.requestId}, ${request.workItemId},
              ${request.runAttemptId}, ${request.action}, ${request.scope},
              'pending', ${request.scope}, ${request.payload}, ${request.createdAt}
            )
            RETURNING ${cols}
          `,
      })({
        id: input.id,
        requestId: input.requestId,
        workItemId: input.workItemId,
        runAttemptId: input.runAttemptId,
        action: input.action,
        scope: input.scope,
        payload,
        createdAt,
      }).pipe(Effect.mapError(toSqlError("ApprovalRepository.create")));
      return rowToApproval(row);
    });

  const decide: ApprovalRepositoryShape["decide"] = (id, decision) =>
    Effect.gen(function* () {
      const decidedAt = yield* nowIso;
      yield* sql`
        UPDATE symphony_approvals
        SET state = ${decision}, decision = ${decision}, decided_at = ${decidedAt}
        WHERE id = ${id} AND state = 'pending'
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.decide")));
    });

  const listPending: ApprovalRepositoryShape["listPending"] = (options) =>
    sql<Schema.Schema.Type<typeof ApprovalRowSchema>>`
      SELECT ${cols}
      FROM symphony_approvals
      WHERE state = 'pending'
      ORDER BY created_at DESC
      ${options?.limit ? sql`LIMIT ${options.limit}` : sql``}
    `.pipe(
      Effect.mapError(toSqlError("ApprovalRepository.listPending")),
      Effect.map((rows) => rows.map(rowToApproval)),
    );

  const listForRun: ApprovalRepositoryShape["listForRun"] = (runAttemptId) =>
    sql<Schema.Schema.Type<typeof ApprovalRowSchema>>`
      SELECT ${cols}
      FROM symphony_approvals
      WHERE run_attempt_id = ${runAttemptId}
      ORDER BY created_at DESC
    `.pipe(
      Effect.mapError(toSqlError("ApprovalRepository.listForRun")),
      Effect.map((rows) => rows.map(rowToApproval)),
    );

  const getById: ApprovalRepositoryShape["getById"] = (id) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String }),
      Result: ApprovalRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_approvals
          WHERE id = ${request.id}
        `,
    })({ id }).pipe(
      Effect.mapError(toSqlError("ApprovalRepository.getById")),
      Effect.map((row) => (row._tag === "None" ? null : rowToApproval(row.value))),
    );

  return {
    create,
    decide,
    listPending,
    listForRun,
    getById,
  } satisfies ApprovalRepositoryShape;
});

export const ApprovalRepositoryLive = Layer.effect(ApprovalRepository, makeRepository);
