import type { RunAttempt, RunAttemptStatus } from "@neokod/contracts";
import { RunAttemptId, RunAttemptSchema, WorkItemId } from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import {
  RunAttemptRepository,
  type RunAttemptRepositoryShape,
} from "../Services/RunAttemptRepository.ts";

const RunAttemptRowSchema = Schema.Struct({
  id: RunAttemptId,
  workItemId: WorkItemId,
  attemptNumber: Schema.Int,
  provider: Schema.String,
  model: Schema.NullOr(Schema.String),
  status: RunAttemptSchema.fields.status,
  currentStage: Schema.NullOr(Schema.String),
  workspacePath: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  errorJson: Schema.NullOr(Schema.String),
  tokenUsageJson: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
});

const rowToAttempt = (row: Schema.Schema.Type<typeof RunAttemptRowSchema>): RunAttempt => ({
  id: row.id,
  workItemId: row.workItemId,
  attemptNumber: row.attemptNumber,
  workspacePath: row.workspacePath,
  provider: JSON.parse(row.provider) as RunAttempt["provider"],
  model: row.model ?? undefined,
  status: row.status as RunAttemptStatus,
  currentStage: row.currentStage ?? undefined,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt === null ? null : row.finishedAt,
  error: row.errorJson === null ? null : (JSON.parse(row.errorJson) as RunAttempt["error"]),
  tokenUsage:
    row.tokenUsageJson === null
      ? undefined
      : (JSON.parse(row.tokenUsageJson) as RunAttempt["tokenUsage"]),
  sessionId: row.sessionId ?? undefined,
  threadId: row.threadId ?? undefined,
});

const attemptToRow = (attempt: RunAttempt): Schema.Schema.Type<typeof RunAttemptRowSchema> => ({
  id: attempt.id,
  workItemId: attempt.workItemId,
  attemptNumber: attempt.attemptNumber,
  provider: JSON.stringify(attempt.provider),
  model: attempt.model ?? null,
  status: attempt.status,
  currentStage: attempt.currentStage ?? null,
  workspacePath: attempt.workspacePath,
  startedAt: attempt.startedAt,
  finishedAt: attempt.finishedAt ?? null,
  errorJson:
    attempt.error === null || attempt.error === undefined ? null : JSON.stringify(attempt.error),
  tokenUsageJson: attempt.tokenUsage === undefined ? null : JSON.stringify(attempt.tokenUsage),
  sessionId: attempt.sessionId ?? null,
  threadId: attempt.threadId ?? null,
});

const SELECT_COLUMNS = `
  id, work_item_id AS "workItemId", attempt_number AS "attemptNumber",
  provider, model, status, current_stage AS "currentStage",
  workspace_path AS "workspacePath", started_at AS "startedAt",
  finished_at AS "finishedAt", error_json AS "errorJson",
  token_usage_json AS "tokenUsageJson", session_id AS "sessionId",
  thread_id AS "threadId"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const createRow = SqlSchema.findOne({
    Request: RunAttemptRowSchema,
    Result: RunAttemptRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO symphony_run_attempts (
          id, work_item_id, attempt_number, provider, model, status,
          current_stage, workspace_path, started_at, finished_at,
          error_json, token_usage_json, session_id, thread_id
        )
        VALUES (
          ${row.id}, ${row.workItemId}, ${row.attemptNumber}, ${row.provider},
          ${row.model}, ${row.status}, ${row.currentStage}, ${row.workspacePath},
          ${row.startedAt}, ${row.finishedAt}, ${row.errorJson}, ${row.tokenUsageJson},
          ${row.sessionId}, ${row.threadId}
        )
        RETURNING ${cols}
      `,
  });

  const updateRow = SqlSchema.findOneOption({
    Request: RunAttemptRowSchema,
    Result: RunAttemptRowSchema,
    execute: (row) =>
      sql`
        UPDATE symphony_run_attempts SET
          provider = ${row.provider},
          model = ${row.model},
          status = ${row.status},
          current_stage = ${row.currentStage},
          finished_at = ${row.finishedAt},
          error_json = ${row.errorJson},
          token_usage_json = ${row.tokenUsageJson},
          session_id = ${row.sessionId},
          thread_id = ${row.threadId}
        WHERE id = ${row.id}
        RETURNING ${cols}
      `,
  });

  const create: RunAttemptRepositoryShape["create"] = (attempt) =>
    createRow(attemptToRow(attempt)).pipe(
      Effect.mapError(toSqlError("RunAttemptRepository.create")),
      Effect.map(rowToAttempt),
    );

  const update: RunAttemptRepositoryShape["update"] = (attempt) =>
    updateRow(attemptToRow(attempt)).pipe(
      Effect.mapError(toSqlError("RunAttemptRepository.update")),
      Effect.map(Option.getOrThrowWith(() => new Error(`Missing attempt row ${attempt.id}`))),
      Effect.map(rowToAttempt),
    );

  const selectById = (id: RunAttemptId) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: RunAttemptId }),
      Result: RunAttemptRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_run_attempts
          WHERE id = ${request.id}
        `,
    })({ id });

  const getById: RunAttemptRepositoryShape["getById"] = (id) =>
    selectById(id).pipe(
      Effect.mapError(toSqlError("RunAttemptRepository.getById")),
      Effect.map(Option.match({ onNone: () => null, onSome: rowToAttempt })),
    );

  const listByWorkItem: RunAttemptRepositoryShape["listByWorkItem"] = (workItemId) =>
    sql<Schema.Schema.Type<typeof RunAttemptRowSchema>>`
      SELECT ${cols}
      FROM symphony_run_attempts
      WHERE work_item_id = ${workItemId}
      ORDER BY attempt_number ASC
    `.pipe(
      Effect.mapError(toSqlError("RunAttemptRepository.listByWorkItem")),
      Effect.map((rows) => rows.map(rowToAttempt)),
    );

  const latestForWorkItem: RunAttemptRepositoryShape["latestForWorkItem"] = (workItemId) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ workItemId: WorkItemId }),
      Result: RunAttemptRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_run_attempts
          WHERE work_item_id = ${request.workItemId}
          ORDER BY attempt_number DESC
          LIMIT 1
        `,
    })({ workItemId }).pipe(
      Effect.mapError(toSqlError("RunAttemptRepository.latestForWorkItem")),
      Effect.map(Option.match({ onNone: () => null, onSome: rowToAttempt })),
    );

  const updateStatus: RunAttemptRepositoryShape["updateStatus"] = (id, status, options) =>
    Effect.gen(function* () {
      const existing = yield* selectById(id).pipe(
        Effect.mapError(toSqlError("RunAttemptRepository.updateStatus:read")),
      );
      const row = Option.getOrNull(existing);
      if (row === null) {
        return;
      }
      const next: Schema.Schema.Type<typeof RunAttemptRowSchema> = {
        ...row,
        status,
        currentStage: options?.currentStage ?? row.currentStage,
        finishedAt: options?.finishedAt ?? row.finishedAt,
        errorJson:
          options?.error === undefined
            ? row.errorJson
            : options.error === null
              ? null
              : JSON.stringify(options.error),
        tokenUsageJson:
          options?.tokenUsage === undefined
            ? row.tokenUsageJson
            : options.tokenUsage === undefined
              ? row.tokenUsageJson
              : JSON.stringify(options.tokenUsage),
      };
      const now = yield* nowIso;
      yield* sql`
        UPDATE symphony_run_attempts SET
          status = ${next.status},
          current_stage = ${next.currentStage},
          finished_at = ${next.finishedAt},
          error_json = ${next.errorJson},
          token_usage_json = ${next.tokenUsageJson}
        WHERE id = ${id}
      `.pipe(Effect.mapError(toSqlError("RunAttemptRepository.updateStatus")));
      yield* Effect.logDebug("Updated run attempt status", { runAttemptId: id, status }).pipe(
        Effect.annotateLogs({ workItemId: row.workItemId, updatedAt: now }),
      );
    });

  return {
    create,
    update,
    getById,
    listByWorkItem,
    latestForWorkItem,
    updateStatus,
  } satisfies RunAttemptRepositoryShape;
});

export const RunAttemptRepositoryLive = Layer.effect(RunAttemptRepository, makeRepository);
