import type { EffectiveWorkflowConfig, WorkflowRecord } from "@neokod/contracts";
import { WorkflowDefinitionSchema, WorkflowId, WorkflowStatusSchema } from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import { decodeJson, encodeJson } from "../Json.ts";
import {
  WorkflowRepository,
  type WorkflowRepositoryShape,
} from "../Services/WorkflowRepository.ts";

const WorkflowRowSchema = Schema.Struct({
  id: WorkflowId,
  repositoryPath: Schema.String,
  workflowPath: Schema.String,
  status: WorkflowStatusSchema,
  autonomyLevel: Schema.String,
  definitionJson: Schema.String,
  effectiveConfigJson: Schema.NullOr(Schema.String),
  validationError: Schema.NullOr(Schema.String),
  enabledAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const rowToWorkflow = (row: Schema.Schema.Type<typeof WorkflowRowSchema>): WorkflowRecord => ({
  id: row.id,
  repositoryPath: row.repositoryPath,
  workflowPath: row.workflowPath,
  status: row.status,
  autonomy: (row.autonomyLevel as WorkflowRecord["autonomy"]) ?? "execute",
  validationError: row.validationError,
  definition: decodeJson(row.definitionJson) as WorkflowRecord["definition"],
  effectiveConfig:
    row.effectiveConfigJson === null
      ? null
      : (decodeJson(row.effectiveConfigJson) as EffectiveWorkflowConfig),
  enabledAt: row.enabledAt === null ? null : row.enabledAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const workflowToRow = (workflow: WorkflowRecord): Schema.Schema.Type<typeof WorkflowRowSchema> => ({
  id: workflow.id,
  repositoryPath: workflow.repositoryPath,
  workflowPath: workflow.workflowPath,
  status: workflow.status,
  autonomyLevel: workflow.autonomy,
  definitionJson: encodeJson(workflow.definition),
  effectiveConfigJson:
    workflow.effectiveConfig === null ? null : encodeJson(workflow.effectiveConfig),
  validationError: workflow.validationError,
  enabledAt: workflow.enabledAt ?? null,
  createdAt: workflow.createdAt,
  updatedAt: workflow.updatedAt,
});

const SELECT_COLUMNS = `
  id, repository_path AS "repositoryPath", workflow_path AS "workflowPath",
  status, autonomy_level AS "autonomyLevel", definition_json AS "definitionJson",
  effective_config_json AS "effectiveConfigJson",
  validation_error AS "validationError", enabled_at AS "enabledAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const insertRow = SqlSchema.findOneOption({
    Request: WorkflowRowSchema,
    Result: WorkflowRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO symphony_workflows (
          id, repository_path, workflow_path, status, autonomy_level,
          definition_json, effective_config_json, validation_error,
          enabled_at, created_at, updated_at
        )
        VALUES (
          ${row.id}, ${row.repositoryPath}, ${row.workflowPath}, ${row.status},
          ${row.autonomyLevel}, ${row.definitionJson}, ${row.effectiveConfigJson},
          ${row.validationError}, ${row.enabledAt}, ${row.createdAt}, ${row.updatedAt}
        )
        ON CONFLICT(repository_path) DO NOTHING
        RETURNING ${cols}
      `,
  });

  const updateRow = SqlSchema.findOneOption({
    Request: WorkflowRowSchema,
    Result: WorkflowRowSchema,
    execute: (row) =>
      sql`
        UPDATE symphony_workflows SET
          workflow_path = ${row.workflowPath},
          status = ${row.status},
          autonomy_level = ${row.autonomyLevel},
          definition_json = ${row.definitionJson},
          effective_config_json = ${row.effectiveConfigJson},
          validation_error = ${row.validationError},
          enabled_at = ${row.enabledAt},
          updated_at = ${row.updatedAt}
        WHERE id = ${row.id}
        RETURNING ${cols}
      `,
  });

  const upsert: WorkflowRepositoryShape["upsert"] = (workflow) => {
    const row = workflowToRow(workflow);
    return insertRow(row).pipe(
      Effect.mapError(toSqlError("WorkflowRepository.upsert:insert")),
      Effect.flatMap((inserted) =>
        Option.match(inserted, {
          onNone: () =>
            updateRow(row).pipe(
              Effect.mapError(toSqlError("WorkflowRepository.upsert:update")),
              Effect.flatMap((updated) =>
                Option.match(updated, {
                  onNone: () =>
                    Effect.fail(
                      new SymphonyPersistenceSqlError({
                        operation: "WorkflowRepository.upsert",
                        detail: `Missing workflow row after upsert for ${workflow.id}`,
                      }),
                    ),
                  onSome: (row) => Effect.succeed(rowToWorkflow(row)),
                }),
              ),
            ),
          onSome: (row) => Effect.succeed(rowToWorkflow(row)),
        }),
      ),
    );
  };

  const selectById = (id: WorkflowId) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: WorkflowId }),
      Result: WorkflowRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_workflows
          WHERE id = ${request.id}
        `,
    })({ id });

  const getById: WorkflowRepositoryShape["getById"] = (id) =>
    selectById(id).pipe(
      Effect.mapError(toSqlError("WorkflowRepository.getById")),
      Effect.map(Option.match({ onNone: () => null, onSome: rowToWorkflow })),
    );

  const getByRepository: WorkflowRepositoryShape["getByRepository"] = (repositoryPath) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ repositoryPath: Schema.String }),
      Result: WorkflowRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_workflows
          WHERE repository_path = ${request.repositoryPath}
        `,
    })({ repositoryPath }).pipe(
      Effect.mapError(toSqlError("WorkflowRepository.getByRepository")),
      Effect.map(Option.match({ onNone: () => null, onSome: rowToWorkflow })),
    );

  const list: WorkflowRepositoryShape["list"] = () =>
    sql<Schema.Schema.Type<typeof WorkflowRowSchema>>`
      SELECT ${cols}
      FROM symphony_workflows
      ORDER BY created_at ASC
    `.pipe(
      Effect.mapError(toSqlError("WorkflowRepository.list")),
      Effect.map((rows) => rows.map(rowToWorkflow)),
    );

  const setStatus: WorkflowRepositoryShape["setStatus"] = (
    id,
    status,
    validationError,
    effectiveConfig,
  ) =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      yield* sql`
        UPDATE symphony_workflows SET
          status = ${status},
          validation_error = ${validationError},
          effective_config_json = ${effectiveConfig === null ? null : encodeJson(effectiveConfig)},
          updated_at = ${timestamp}
        WHERE id = ${id}
      `.pipe(Effect.mapError(toSqlError("WorkflowRepository.setStatus")));
    });

  return {
    upsert,
    getById,
    getByRepository,
    list,
    setStatus,
  } satisfies WorkflowRepositoryShape;
});

export const WorkflowRepositoryLive = Layer.effect(WorkflowRepository, makeRepository);

// Keep the schema import referenced for the JSON round-trip casts.
export type { WorkflowDefinitionSchema, WorkflowStatusSchema };
