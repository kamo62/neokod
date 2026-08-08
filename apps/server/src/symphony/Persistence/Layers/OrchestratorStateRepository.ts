import { Schema } from "effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import { decodeJson, encodeJson } from "../Json.ts";
import {
  OrchestratorStateRepository,
  type OrchestratorStateRepositoryShape,
} from "../Services/OrchestratorStateRepository.ts";

const StateRowSchema = Schema.Struct({
  id: Schema.String,
  globalPaused: Schema.Int,
  pausedWorkflows: Schema.String,
  pausedRepositories: Schema.String,
  lockToken: Schema.NullOr(Schema.String),
  lockAcquiredAt: Schema.NullOr(Schema.String),
  lockExpiresAt: Schema.NullOr(Schema.String),
});

const SINGLETON_ID = "orchestrator";

const CurrentColumnSchema = Schema.Struct({ current: Schema.String });

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ensureSingleton = SqlSchema.findOne({
    Request: Schema.Struct({ id: Schema.String, nowIso: Schema.String }),
    Result: StateRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO symphony_orchestrator_state (id, global_paused, updated_at)
        VALUES (${request.id}, 0, ${request.nowIso})
        ON CONFLICT(id) DO NOTHING
        RETURNING id, global_paused AS "globalPaused",
          paused_workflows AS "pausedWorkflows",
          paused_repositories AS "pausedRepositories",
          lock_token AS "lockToken", lock_acquired_at AS "lockAcquiredAt",
          lock_expires_at AS "lockExpiresAt"
      `,
  });

  const getRow = () =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String }),
      Result: StateRowSchema,
      execute: (request) =>
        sql`
          SELECT id, global_paused AS "globalPaused",
            paused_workflows AS "pausedWorkflows",
            paused_repositories AS "pausedRepositories",
            lock_token AS "lockToken", lock_acquired_at AS "lockAcquiredAt",
            lock_expires_at AS "lockExpiresAt"
          FROM symphony_orchestrator_state
          WHERE id = ${request.id}
        `,
    })({ id: SINGLETON_ID });

  const isGlobalPaused: OrchestratorStateRepositoryShape["isGlobalPaused"] = () =>
    Effect.gen(function* () {
      const nowIsoValue = yield* nowIso;
      yield* ensureSingleton({ id: SINGLETON_ID, nowIso: nowIsoValue }).pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.ensureSingleton")),
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      );
      const row = yield* getRow().pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.isGlobalPaused")),
      );
      return Option.match(row, {
        onNone: () => false,
        onSome: (row) => row.globalPaused === 1,
      });
    });

  const setGlobalPaused: OrchestratorStateRepositoryShape["setGlobalPaused"] = (paused) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      yield* ensureSingleton({ id: SINGLETON_ID, nowIso: timestamp }).pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.setGlobalPaused:ensure")),
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      );
      yield* sql`
        UPDATE symphony_orchestrator_state
        SET global_paused = ${paused ? 1 : 0}, updated_at = ${timestamp}
        WHERE id = ${SINGLETON_ID}
      `.pipe(Effect.mapError(toSqlError("OrchestratorStateRepository.setGlobalPaused")));
    });

  const toggleInList = (
    jsonColumn: "paused_workflows" | "paused_repositories",
    value: string,
    paused: boolean,
  ) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      const column = sql.literal(jsonColumn);
      const row = yield* sql<Schema.Schema.Type<typeof CurrentColumnSchema>>`
        SELECT ${column} AS "current"
        FROM symphony_orchestrator_state
        WHERE id = ${SINGLETON_ID}
      `.pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.toggleInList:read")),
        Effect.map((rows) => rows[0]?.current ?? "[]"),
      );
      const current = decodeJson(row) as string[];
      const next = paused
        ? current.includes(value)
          ? current
          : [...current, value]
        : current.filter((entry) => entry !== value);
      yield* sql`
        UPDATE symphony_orchestrator_state
        SET ${column} = ${encodeJson(next)}, updated_at = ${timestamp}
        WHERE id = ${SINGLETON_ID}
      `.pipe(Effect.mapError(toSqlError("OrchestratorStateRepository.toggleInList")));
    });

  const isInList = (jsonColumn: "paused_workflows" | "paused_repositories", value: string) =>
    Effect.gen(function* () {
      yield* ensureSingleton({ id: SINGLETON_ID, nowIso: yield* nowIso }).pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.isInList:ensure")),
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      );
      const column = sql.literal(jsonColumn);
      const row = yield* sql<Schema.Schema.Type<typeof CurrentColumnSchema>>`
        SELECT ${column} AS "current"
        FROM symphony_orchestrator_state
        WHERE id = ${SINGLETON_ID}
      `.pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.isInList")),
        Effect.map((rows) => rows[0]?.current ?? "[]"),
      );
      const current = decodeJson(row) as string[];
      return current.includes(value);
    });

  const isWorkflowPaused: OrchestratorStateRepositoryShape["isWorkflowPaused"] = (workflowId) =>
    isInList("paused_workflows", workflowId);

  const setWorkflowPaused: OrchestratorStateRepositoryShape["setWorkflowPaused"] = (
    workflowId,
    paused,
  ) => toggleInList("paused_workflows", workflowId, paused);

  const isRepositoryPaused: OrchestratorStateRepositoryShape["isRepositoryPaused"] = (
    repositoryPath,
  ) => isInList("paused_repositories", repositoryPath);

  const setRepositoryPaused: OrchestratorStateRepositoryShape["setRepositoryPaused"] = (
    repositoryPath,
    paused,
  ) => toggleInList("paused_repositories", repositoryPath, paused);

  const acquireLock: OrchestratorStateRepositoryShape["acquireLock"] = ({ ownerToken, leaseMs }) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      const nowMs = yield* Clock.currentTimeMillis;
      const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + leaseMs));
      yield* ensureSingleton({ id: SINGLETON_ID, nowIso: timestamp }).pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.acquireLock:ensure")),
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      );
      const updated = yield* sql`
        UPDATE symphony_orchestrator_state
        SET lock_token = ${ownerToken},
            lock_acquired_at = ${timestamp},
            lock_expires_at = ${expiresAt},
            updated_at = ${timestamp}
        WHERE id = ${SINGLETON_ID}
          AND (lock_token IS NULL OR lock_expires_at IS NULL OR lock_expires_at < ${timestamp})
        RETURNING id
      `.pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.acquireLock")),
        Effect.map((rows) => rows.length > 0),
      );
      return updated;
    });

  const renewLock: OrchestratorStateRepositoryShape["renewLock"] = ({ ownerToken, leaseMs }) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      const nowMs = yield* Clock.currentTimeMillis;
      const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + leaseMs));
      const updated = yield* sql`
        UPDATE symphony_orchestrator_state
        SET lock_expires_at = ${expiresAt}, updated_at = ${timestamp}
        WHERE id = ${SINGLETON_ID}
          AND lock_token = ${ownerToken}
        RETURNING id
      `.pipe(
        Effect.mapError(toSqlError("OrchestratorStateRepository.renewLock")),
        Effect.map((rows) => rows.length > 0),
      );
      return updated;
    });

  const releaseLock: OrchestratorStateRepositoryShape["releaseLock"] = (ownerToken) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      yield* sql`
        UPDATE symphony_orchestrator_state
        SET lock_token = NULL, lock_expires_at = NULL, updated_at = ${timestamp}
        WHERE id = ${SINGLETON_ID} AND lock_token = ${ownerToken}
      `.pipe(Effect.mapError(toSqlError("OrchestratorStateRepository.releaseLock")));
    });

  return {
    isGlobalPaused,
    setGlobalPaused,
    isWorkflowPaused,
    setWorkflowPaused,
    isRepositoryPaused,
    setRepositoryPaused,
    acquireLock,
    renewLock,
    releaseLock,
  } satisfies OrchestratorStateRepositoryShape;
});

export const OrchestratorStateRepositoryLive = Layer.effect(
  OrchestratorStateRepository,
  makeRepository,
);
