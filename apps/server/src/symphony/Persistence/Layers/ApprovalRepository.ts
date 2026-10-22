import type { ApprovalRequest, ApprovalRequestKind } from "@neokod/contracts";
import { ApprovalRequestSchema, RunAttemptId, SymphonyApprovalRequestId } from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import {
  approvalRequestKindForAction,
  normaliseApprovalRequestAction,
} from "../../Domain/Approvals.ts";
import { SymphonyPersistenceDecodeError, SymphonyPersistenceSqlError } from "../Errors.ts";
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

const payloadString = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined;

const payloadKind = (payload: Record<string, unknown>): ApprovalRequestKind | undefined => {
  const value = payload.kind;
  return value === "approval" || value === "user_input" ? value : undefined;
};

/**
 * Decode one durable approval row. Nothing is cast: an unrecognised state,
 * scope or id surfaces as a named `SymphonyPersistenceDecodeError` instead of
 * reaching the RPC boundary as a payload that cannot encode.
 *
 * Rows written before the request vocabulary existed hold the provider's raw
 * kind and no `kind`; both are normalised here, so old history stays readable.
 */
const rowToApproval = (
  row: Schema.Schema.Type<typeof ApprovalRowSchema>,
): Effect.Effect<ApprovalRequest, SymphonyPersistenceDecodeError> =>
  Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () =>
        row.payloadJson === null
          ? ({} as Record<string, unknown>)
          : (decodeJson(row.payloadJson) as Record<string, unknown>),
      catch: (cause) =>
        new SymphonyPersistenceDecodeError({
          operation: "ApprovalRepository.rowToApproval",
          issue: `approval row ${String(row.id)} payload could not be decoded`,
          cause,
        }),
    });
    const affectedFiles = Array.isArray(payload.affectedFiles)
      ? (payload.affectedFiles as string[]).map(String)
      : [];
    const action = normaliseApprovalRequestAction(row.action);
    const kind = payloadKind(payload) ?? approvalRequestKindForAction(action);
    const storedProviderAction = payloadString(payload, "providerAction");
    const providerAction = storedProviderAction ?? (action === row.action ? undefined : row.action);
    const command = payloadString(payload, "command");
    const workingDirectory = payloadString(payload, "workingDirectory");
    const reason = payloadString(payload, "reason");
    return yield* Schema.decodeUnknownEffect(ApprovalRequestSchema)({
      id: row.id,
      requestId: row.requestId,
      workItemId: row.workItemId,
      ...(row.runAttemptId === null ? {} : { runAttemptId: row.runAttemptId }),
      kind,
      action,
      ...(providerAction === undefined ? {} : { providerAction }),
      scope: row.scope,
      state: row.state,
      ...(row.decision === null ? {} : { decision: row.decision }),
      ...(row.policySource === null ? {} : { policySource: row.policySource }),
      ...(command === undefined ? {} : { command }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(reason === undefined ? {} : { reason }),
      affectedFiles,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SymphonyPersistenceDecodeError({
            operation: "ApprovalRepository.rowToApproval",
            issue: `approval row ${String(row.id)} could not be decoded`,
            cause,
          }),
      ),
    );
  });

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
      // Normalise once at the write boundary: the provider's raw kind is kept
      // next to the action it maps to, and `kind` records whether a human must
      // decide or answer.
      const action = normaliseApprovalRequestAction(input.action);
      const kind = approvalRequestKindForAction(action);
      const payload = encodeJson({
        kind,
        ...(action === input.action ? {} : { providerAction: input.action }),
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
        action,
        scope: input.scope,
        payload,
        createdAt,
      }).pipe(Effect.mapError(toSqlError("ApprovalRepository.create")));
      return yield* rowToApproval(row);
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
    Effect.gen(function* () {
      const rows = yield* sql<Schema.Schema.Type<typeof ApprovalRowSchema>>`
        SELECT ${cols}
        FROM symphony_approvals
        WHERE state = 'pending'
        ORDER BY created_at DESC
        ${options?.limit ? sql`LIMIT ${options.limit}` : sql``}
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.listPending")));
      return yield* Effect.forEach(rows, rowToApproval);
    });

  const listForRun: ApprovalRepositoryShape["listForRun"] = (runAttemptId) =>
    Effect.gen(function* () {
      const rows = yield* sql<Schema.Schema.Type<typeof ApprovalRowSchema>>`
        SELECT ${cols}
        FROM symphony_approvals
        WHERE run_attempt_id = ${runAttemptId}
        ORDER BY created_at DESC
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.listForRun")));
      return yield* Effect.forEach(rows, rowToApproval);
    });

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
      Effect.flatMap((row) =>
        row._tag === "None" ? Effect.succeed(null) : rowToApproval(row.value),
      ),
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
