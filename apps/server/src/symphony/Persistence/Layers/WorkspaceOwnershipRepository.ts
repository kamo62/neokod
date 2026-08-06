import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import {
  WorkspaceOwnershipRepository,
  WorkspaceRemovalGuard,
  makeWorkspaceRemovalGuard,
  type WorkspaceOwnershipRecord,
  type WorkspaceOwnershipRepositoryShape,
  type WorkspaceOwner,
} from "../Services/WorkspaceOwnershipRepository.ts";

const OwnershipRowSchema = Schema.Struct({
  workspacePath: Schema.String,
  owner: Schema.String,
  workItemId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  leaseExpiresAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const rowToRecord = (
  row: Schema.Schema.Type<typeof OwnershipRowSchema>,
): WorkspaceOwnershipRecord => ({
  workspacePath: row.workspacePath,
  owner: row.owner as WorkspaceOwner,
  workItemId:
    row.workItemId === null ? null : (row.workItemId as WorkspaceOwnershipRecord["workItemId"]),
  threadId: row.threadId,
  generation: row.generation,
  leaseExpiresAt: row.leaseExpiresAt,
  updatedAt: row.updatedAt,
});

const SELECT_COLUMNS = `
  workspace_path AS "workspacePath", owner, work_item_id AS "workItemId",
  thread_id AS "threadId", generation, lease_expires_at AS "leaseExpiresAt",
  updated_at AS "updatedAt"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const acquire: WorkspaceOwnershipRepositoryShape["acquire"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const row = yield* SqlSchema.findOneOption({
        Request: Schema.Struct({
          workspacePath: Schema.String,
          owner: Schema.String,
          workItemId: Schema.NullOr(Schema.String),
          threadId: Schema.NullOr(Schema.String),
          leaseExpiresAt: Schema.NullOr(Schema.String),
          now: Schema.String,
        }),
        Result: OwnershipRowSchema,
        execute: (request) =>
          sql`
            INSERT INTO symphony_workspace_ownership (
              workspace_path, owner, work_item_id, thread_id, generation,
              lease_expires_at, updated_at
            )
            VALUES (
              ${request.workspacePath}, ${request.owner}, ${request.workItemId},
              ${request.threadId}, 1, ${request.leaseExpiresAt}, ${request.now}
            )
            ON CONFLICT(workspace_path) DO UPDATE SET
              owner = ${request.owner},
              work_item_id = ${request.workItemId},
              thread_id = ${request.threadId},
              generation = symphony_workspace_ownership.generation + 1,
              lease_expires_at = ${request.leaseExpiresAt},
              updated_at = ${request.now}
            WHERE
              symphony_workspace_ownership.owner = ${request.owner}
              OR (
                symphony_workspace_ownership.lease_expires_at IS NOT NULL
                AND symphony_workspace_ownership.lease_expires_at < ${request.now}
              )
            RETURNING ${cols}
          `,
      })({
        workspacePath: input.workspacePath,
        owner: input.owner,
        workItemId: input.workItemId === undefined ? null : String(input.workItemId),
        threadId: input.threadId ?? null,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
        now,
      }).pipe(Effect.mapError(toSqlError("WorkspaceOwnershipRepository.acquire")));
      return row._tag === "None" ? null : rowToRecord(row.value);
    });

  const transfer: WorkspaceOwnershipRepositoryShape["transfer"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const row = yield* SqlSchema.findOneOption({
        Request: Schema.Struct({
          workspacePath: Schema.String,
          owner: Schema.String,
          workItemId: Schema.NullOr(Schema.String),
          threadId: Schema.NullOr(Schema.String),
          generation: Schema.Int,
          leaseExpiresAt: Schema.NullOr(Schema.String),
          now: Schema.String,
        }),
        Result: OwnershipRowSchema,
        execute: (request) =>
          sql`
            UPDATE symphony_workspace_ownership SET
              owner = ${request.owner},
              work_item_id = ${request.workItemId},
              thread_id = ${request.threadId},
              generation = generation + 1,
              lease_expires_at = ${request.leaseExpiresAt},
              updated_at = ${request.now}
            WHERE workspace_path = ${request.workspacePath}
              AND generation = ${request.generation}
            RETURNING ${cols}
          `,
      })({
        workspacePath: input.workspacePath,
        owner: input.owner,
        workItemId: input.workItemId === undefined ? null : String(input.workItemId),
        threadId: input.threadId === undefined ? null : input.threadId,
        generation: input.generation,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
        now,
      }).pipe(Effect.mapError(toSqlError("WorkspaceOwnershipRepository.transfer")));
      return row._tag === "None" ? null : rowToRecord(row.value);
    });

  const renew: WorkspaceOwnershipRepositoryShape["renew"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const row = yield* SqlSchema.findOneOption({
        Request: Schema.Struct({
          workspacePath: Schema.String,
          owner: Schema.String,
          generation: Schema.Int,
          leaseExpiresAt: Schema.String,
          now: Schema.String,
        }),
        Result: OwnershipRowSchema,
        execute: (request) =>
          sql`
            UPDATE symphony_workspace_ownership SET
              lease_expires_at = ${request.leaseExpiresAt},
              updated_at = ${request.now}
            WHERE workspace_path = ${request.workspacePath}
              AND owner = ${request.owner}
              AND generation = ${request.generation}
            RETURNING ${cols}
          `,
      })({
        workspacePath: input.workspacePath,
        owner: input.owner,
        generation: input.generation,
        leaseExpiresAt: input.leaseExpiresAt,
        now,
      }).pipe(Effect.mapError(toSqlError("WorkspaceOwnershipRepository.renew")));
      return row._tag === "None" ? null : rowToRecord(row.value);
    });

  const release: WorkspaceOwnershipRepositoryShape["release"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM symphony_workspace_ownership
        WHERE workspace_path = ${input.workspacePath}
          AND owner = ${input.owner}
          AND generation = ${input.generation}
      `.pipe(Effect.mapError(toSqlError("WorkspaceOwnershipRepository.release")));
      return true;
    });

  const getByWorkspacePath: WorkspaceOwnershipRepositoryShape["getByWorkspacePath"] = (
    workspacePath,
  ) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ workspacePath: Schema.String }),
      Result: OwnershipRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_workspace_ownership
          WHERE workspace_path = ${request.workspacePath}
        `,
    })({ workspacePath }).pipe(
      Effect.mapError(toSqlError("WorkspaceOwnershipRepository.getByWorkspacePath")),
      Effect.map((row) => (row._tag === "None" ? null : rowToRecord(row.value))),
    );

  return {
    acquire,
    transfer,
    renew,
    release,
    getByWorkspacePath,
  } satisfies WorkspaceOwnershipRepositoryShape;
});

export const WorkspaceOwnershipRepositoryLive = Layer.effect(
  WorkspaceOwnershipRepository,
  makeRepository,
);

export const WorkspaceRemovalGuardLive: Layer.Layer<
  WorkspaceRemovalGuard,
  never,
  WorkspaceOwnershipRepository
> = Layer.effect(
  WorkspaceRemovalGuard,
  Effect.gen(function* () {
    const repository = yield* WorkspaceOwnershipRepository;
    return makeWorkspaceRemovalGuard(repository);
  }),
);
