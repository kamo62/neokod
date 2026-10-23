import type {
  ApprovalQuestionPayload,
  ApprovalRequest,
  ApprovalRequestKind,
} from "@neokod/contracts";
import {
  ApprovalAnswerRecordSchema,
  ApprovalDecisionNoteSchema,
  ApprovalQuestionPayloadSchema,
  ApprovalRequestSchema,
  RunAttemptId,
  SymphonyApprovalRequestId,
} from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import {
  approvalRequestKindForAction,
  normaliseApprovalRequestAction,
  questionIsSensitive,
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
  questionPayloadJson: Schema.NullOr(Schema.String),
  answerJson: Schema.NullOr(Schema.String),
  decisionNoteJson: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
});

const payloadString = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined;

const decodeQuestionPayload = Schema.decodeUnknownEffect(ApprovalQuestionPayloadSchema);
const decodeAnswerRecord = Schema.decodeUnknownEffect(ApprovalAnswerRecordSchema);
const decodeDecisionNote = Schema.decodeUnknownEffect(ApprovalDecisionNoteSchema);
const decodeApprovalRequest = Schema.decodeUnknownEffect(ApprovalRequestSchema);

/**
 * Legacy structured payloads may predate stored pattern-detected sensitivity.
 * Normalise that flag on read so UI masking and redaction agree.
 */
const normalisePayloadSensitivity = (payload: ApprovalQuestionPayload): ApprovalQuestionPayload =>
  payload.kind === "structured"
    ? {
        ...payload,
        questions: payload.questions.map((question) =>
          questionIsSensitive(question) ? { ...question, sensitive: true } : question,
        ),
      }
    : payload;

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
    const historyProblems: string[] = [];
    const payload = yield* Effect.try({
      try: () =>
        row.payloadJson === null
          ? ({} as Record<string, unknown>)
          : (decodeJson(row.payloadJson) as Record<string, unknown>),
      catch: () => null,
    }).pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.map((decoded) => {
        if (decoded === null) {
          historyProblems.push("the stored request payload could not be decoded");
          return {} as Record<string, unknown>;
        }
        return decoded;
      }),
    );
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

    /**
     * Questions were only persisted as flattened prompt text before the
     * versioned payload existed. Those rows stay honestly readable as
     * `legacy_text`; a row with no stored prompt is `unsupported` rather than
     * being given invented choices.
     */
    const questionPayload =
      row.questionPayloadJson !== null
        ? yield* Effect.try({
            try: () => decodeJson(row.questionPayloadJson as string),
            catch: () => null,
          }).pipe(
            Effect.catch(() => Effect.succeed(null)),
            Effect.flatMap((json) =>
              json === null
                ? Effect.succeed(null)
                : decodeQuestionPayload(json).pipe(
                    Effect.map((payload) => normalisePayloadSensitivity(payload)),
                    Effect.catch(() => Effect.succeed(null)),
                  ),
            ),
            Effect.map(
              (payload): ApprovalQuestionPayload =>
                payload ?? {
                  kind: "unsupported",
                  providerMethod: "item/tool/requestUserInput",
                  detail: "the stored question payload could not be decoded",
                },
            ),
          )
        : kind === "user_input"
          ? reason === undefined
            ? ({
                kind: "unsupported" as const,
                providerMethod: "item/tool/requestUserInput",
                detail: "the stored request did not record its questions",
              } as const)
            : ({ kind: "legacy_text" as const, text: reason } as const)
          : undefined;

    const answer =
      row.answerJson === null
        ? undefined
        : yield* Effect.try({
            try: () => decodeJson(row.answerJson as string),
            catch: () => null,
          }).pipe(
            Effect.catch(() => Effect.succeed(null)),
            Effect.flatMap((json) => {
              if (json === null) {
                historyProblems.push("the stored answer history could not be decoded");
                return Effect.succeed(null);
              }
              return decodeAnswerRecord(json).pipe(
                Effect.catch(() => {
                  historyProblems.push("the stored answer history could not be decoded");
                  return Effect.succeed(null);
                }),
              );
            }),
          );

    const decisionNote =
      row.decisionNoteJson === null
        ? undefined
        : yield* Effect.try({
            try: () => decodeJson(row.decisionNoteJson as string),
            catch: () => null,
          }).pipe(
            Effect.catch(() => Effect.succeed(null)),
            Effect.flatMap((json) => {
              if (json === null) {
                historyProblems.push("the stored decision note could not be decoded");
                return Effect.succeed(null);
              }
              return decodeDecisionNote(json).pipe(
                Effect.catch(() => {
                  historyProblems.push("the stored decision note could not be decoded");
                  return Effect.succeed(null);
                }),
              );
            }),
          );

    // Before `answered` existed, a user-input request shared the `approved`
    // vocabulary with permission approvals. A question cannot be permission
    // approved, so the projection corrects the label while preserving the
    // absence of stored answer content.
    const legacyAnswered = kind === "user_input" && row.state === "approved";
    const state = legacyAnswered ? "answered" : row.state;
    const decision = legacyAnswered && row.decision === "approved" ? "answered" : row.decision;

    return yield* decodeApprovalRequest({
      id: row.id,
      requestId: row.requestId,
      workItemId: row.workItemId,
      ...(row.runAttemptId === null ? {} : { runAttemptId: row.runAttemptId }),
      kind,
      action,
      ...(providerAction === undefined ? {} : { providerAction }),
      scope: row.scope,
      state,
      ...(decision === null ? {} : { decision }),
      ...(row.policySource === null ? {} : { policySource: row.policySource }),
      ...(command === undefined ? {} : { command }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(reason === undefined ? {} : { reason }),
      ...(questionPayload === undefined ? {} : { questionPayload }),
      ...(answer === null || answer === undefined ? {} : { answer }),
      ...(decisionNote === null || decisionNote === undefined ? {} : { decisionNote }),
      ...(historyProblems.length > 0 ? { historyUnavailable: historyProblems.join("; ") } : {}),
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
  question_payload_json AS "questionPayloadJson",
  answer_json AS "answerJson", decision_note_json AS "decisionNoteJson",
  created_at AS "createdAt", decided_at AS "decidedAt"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const findRowById = (id: string) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String }),
      Result: ApprovalRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_approvals
          WHERE id = ${request.id}
        `,
    })({ id }).pipe(Effect.mapError(toSqlError("ApprovalRepository.getById")));

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
      const questionPayload =
        input.questionPayload === undefined ? null : encodeJson(input.questionPayload);
      // A redelivered provider request must not create a second durable row or
      // overwrite an already decided one. The row is the identity; the first
      // write wins.
      yield* sql`
        INSERT INTO symphony_approvals (
          id, request_id, work_item_id, run_attempt_id, action, scope,
          state, policy_source, payload_json, question_payload_json, created_at
        )
        VALUES (
          ${input.id}, ${input.requestId}, ${input.workItemId},
          ${input.runAttemptId}, ${action}, ${input.scope},
          'pending', ${input.scope}, ${payload}, ${questionPayload}, ${createdAt}
        )
        ON CONFLICT(id) DO NOTHING
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.create")));
      const row = yield* findRowById(input.id);
      if (row._tag === "None") {
        return yield* new SymphonyPersistenceSqlError({
          operation: "ApprovalRepository.create",
          detail: `approval row ${input.id} was not readable after insert`,
        });
      }
      return yield* rowToApproval(row.value);
    });

  const decide: ApprovalRepositoryShape["decide"] = (id, decision, details) =>
    Effect.gen(function* () {
      const decidedAt = yield* nowIso;
      const answerJson = details?.answer === undefined ? null : encodeJson(details.answer);
      const decisionNoteJson =
        details?.decisionNote === undefined ? null : encodeJson(details.decisionNote);
      yield* sql`
        UPDATE symphony_approvals
        SET state = ${decision}, decision = ${decision}, decided_at = ${decidedAt},
            answer_json = ${answerJson}, decision_note_json = ${decisionNoteJson}
        WHERE id = ${id} AND state = 'pending'
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.decide")));
    });

  const stageDelivery: ApprovalRepositoryShape["stageDelivery"] = (id, decision, details) =>
    Effect.gen(function* () {
      const answerJson = details?.answer === undefined ? null : encodeJson(details.answer);
      const decisionNoteJson =
        details?.decisionNote === undefined ? null : encodeJson(details.decisionNote);
      yield* sql`
        UPDATE symphony_approvals
        SET state = 'delivering', decision = ${decision},
            answer_json = ${answerJson}, decision_note_json = ${decisionNoteJson}
        WHERE id = ${id} AND state = 'pending'
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.stageDelivery")));
    });

  const completeDelivery: ApprovalRepositoryShape["completeDelivery"] = (id, decision) =>
    Effect.gen(function* () {
      const decidedAt = yield* nowIso;
      yield* sql`
        UPDATE symphony_approvals
        SET state = ${decision}, decision = ${decision}, decided_at = ${decidedAt}
        WHERE id = ${id} AND state = 'delivering'
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.completeDelivery")));
    });

  const abortDelivery: ApprovalRepositoryShape["abortDelivery"] = (id, decision) =>
    Effect.gen(function* () {
      const decidedAt = yield* nowIso;
      yield* sql`
        UPDATE symphony_approvals
        SET state = ${decision}, decision = ${decision}, decided_at = ${decidedAt},
            answer_json = NULL, decision_note_json = NULL
        WHERE id = ${id} AND state = 'delivering'
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.abortDelivery")));
    });

  const listDelivering: ApprovalRepositoryShape["listDelivering"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<Schema.Schema.Type<typeof ApprovalRowSchema>>`
        SELECT ${cols}
        FROM symphony_approvals
        WHERE state = 'delivering'
        ORDER BY created_at DESC
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.listDelivering")));
      return yield* Effect.forEach(rows, rowToApproval);
    });

  const reconcileDelivery: ApprovalRepositoryShape["reconcileDelivery"] = (id, decision) =>
    Effect.gen(function* () {
      const decidedAt = yield* nowIso;
      // Preserve answer/note content: it may have reached the provider, so the
      // row stays explicit delivery-unknown rather than being erased.
      yield* sql`
        UPDATE symphony_approvals
        SET state = ${decision}, decision = ${decision}, decided_at = ${decidedAt}
        WHERE id = ${id} AND state = 'delivering'
      `.pipe(Effect.mapError(toSqlError("ApprovalRepository.reconcileDelivery")));
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
    findRowById(id).pipe(
      Effect.flatMap((row) =>
        row._tag === "None" ? Effect.succeed(null) : rowToApproval(row.value),
      ),
    );

  const findByRequest: ApprovalRepositoryShape["findByRequest"] = (runAttemptId, requestId) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ runAttemptId: RunAttemptId, requestId: Schema.String }),
      Result: ApprovalRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_approvals
          WHERE run_attempt_id = ${request.runAttemptId}
            AND request_id = ${request.requestId}
          ORDER BY created_at DESC
          LIMIT 1
        `,
    })({ runAttemptId, requestId }).pipe(
      Effect.mapError(toSqlError("ApprovalRepository.findByRequest")),
      Effect.flatMap((row) =>
        row._tag === "None" ? Effect.succeed(null) : rowToApproval(row.value),
      ),
    );

  return {
    create,
    decide,
    stageDelivery,
    completeDelivery,
    abortDelivery,
    listDelivering,
    reconcileDelivery,
    listPending,
    listForRun,
    getById,
    findByRequest,
  } satisfies ApprovalRepositoryShape;
});

export const ApprovalRepositoryLive = Layer.effect(ApprovalRepository, makeRepository);
