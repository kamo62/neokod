import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import {
  OrchestratorStateRepository,
  type OrchestratorStateRepositoryShape,
} from "../Services/OrchestratorStateRepository.ts";

const StateRowSchema = Schema.Struct({
  id: Schema.String,
  globalPaused: Schema.Int,
  lockToken: Schema.NullOr(Schema.String),
  lockAcquiredAt: Schema.NullOr(Schema.String),
  lockExpiresAt: Schema.NullOr(Schema.String),
});

const SINGLETON_ID = "orchestrator";

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = () => new Date().getTime();

  const ensureSingleton = SqlSchema.findOne({
    Request: Schema.Struct({ id: Schema.String, nowIso: Schema.String }),
    Result: StateRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO symphony_orchestrator_state (id, global_paused, updated_at)
        VALUES (${request.id}, 0, ${request.nowIso})
        ON CONFLICT(id) DO NOTHING
        RETURNING id, global_paused AS "globalPaused",
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

  const acquireLock: OrchestratorStateRepositoryShape["acquireLock"] = ({ ownerToken, leaseMs }) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      const nowMs = now();
      const expiresAt = new Date(nowMs + leaseMs).toISOString();
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
      const expiresAt = new Date(now() + leaseMs).toISOString();
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
    acquireLock,
    renewLock,
    releaseLock,
  } satisfies OrchestratorStateRepositoryShape;
});

export const OrchestratorStateRepositoryLive = Layer.effect(
  OrchestratorStateRepository,
  makeRepository,
);
