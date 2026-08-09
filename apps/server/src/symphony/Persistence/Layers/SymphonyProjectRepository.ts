import {
  type EffectiveWorkflowConfig,
  EffectiveWorkflowConfigSchema,
  ProjectId,
  type SymphonyProject,
  type SymphonyProjectConfiguration,
  SymphonyProjectConfigurationSchema,
  SymphonyProjectId,
  SymphonyProjectSetupStateSchema,
  SymphonyProjectStatusSchema,
  WorkflowId,
} from "@neokod/contracts";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { SymphonyPersistenceSqlError } from "../Errors.ts";
import { decodeJson, encodeJson } from "../Json.ts";
import {
  SymphonyProjectRepository,
  type SymphonyProjectRepositoryShape,
} from "../Services/SymphonyProjectRepository.ts";

const ProjectRowSchema = Schema.Struct({
  id: SymphonyProjectId,
  codeProjectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  repositoryPath: Schema.String,
  status: SymphonyProjectStatusSchema,
  setupState: SymphonyProjectSetupStateSchema,
  configurationJson: Schema.NullOr(Schema.String),
  legacyConfigJson: Schema.NullOr(Schema.String),
  revision: Schema.Int,
  legacyWorkflowId: Schema.NullOr(WorkflowId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

type ProjectRow = Schema.Schema.Type<typeof ProjectRowSchema>;

const decodeProjectConfigurationOption = Schema.decodeUnknownOption(
  SymphonyProjectConfigurationSchema,
);
const decodeLegacyConfigurationOption = Schema.decodeUnknownOption(EffectiveWorkflowConfigSchema);

const providerString = (config: EffectiveWorkflowConfig, key: string): string | undefined => {
  const value = config.trackerProvider[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const legacyTrackerScope = (
  config: EffectiveWorkflowConfig,
): SymphonyProjectConfiguration["tracker"] | null => {
  switch (config.trackerKind) {
    case "github": {
      const repository = providerString(config, "repo");
      return repository ? { kind: "github", repository } : null;
    }
    case "jira": {
      const projectKey = providerString(config, "project_key");
      return projectKey ? { kind: "jira", projectKey } : null;
    }
    case "linear": {
      const projectSlug = providerString(config, "project_slug");
      return projectSlug ? { kind: "linear", projectSlug } : null;
    }
    case "gitlab": {
      const projectPath = providerString(config, "project_path");
      return projectPath ? { kind: "gitlab", projectPath } : null;
    }
    case "asana": {
      const projectGid = providerString(config, "project_gid");
      return projectGid ? { kind: "asana", projectGid } : null;
    }
    case "azure_boards": {
      const organization = providerString(config, "organization");
      const project = providerString(config, "project");
      return organization && project ? { kind: "azure_boards", organization, project } : null;
    }
    case "github_projects": {
      const owner = providerString(config, "owner");
      const number = Number(config.trackerProvider.number);
      return owner && Number.isSafeInteger(number) && number > 0
        ? { kind: "github_projects", owner, number }
        : null;
    }
  }
};

const decodeProjectConfiguration = (row: ProjectRow): SymphonyProjectConfiguration | null => {
  if (row.configurationJson !== null) {
    try {
      return decodeProjectConfigurationOption(decodeJson(row.configurationJson)).pipe(
        Option.getOrNull,
      );
    } catch {
      return null;
    }
  }
  if (row.legacyConfigJson === null) {
    return null;
  }
  let legacy: EffectiveWorkflowConfig;
  try {
    const decoded = decodeLegacyConfigurationOption(decodeJson(row.legacyConfigJson));
    if (Option.isNone(decoded)) return null;
    legacy = decoded.value;
  } catch {
    return null;
  }
  const tracker = legacyTrackerScope(legacy);
  if (!tracker) {
    return null;
  }
  return {
    tracker,
    trackerRequiredLabels: [...legacy.trackerRequiredLabels],
    trackerActiveStates: [...legacy.trackerActiveStates],
    trackerTerminalStates: [...legacy.trackerTerminalStates],
    autonomy: legacy.autonomy,
    agentProvider: legacy.agentProvider,
    ...(legacy.agentModel === undefined ? {} : { agentModel: legacy.agentModel }),
    validationRequired: [...legacy.validationRequired],
    maxConcurrentAgents: legacy.maxConcurrentAgents ?? 1,
    maxTurns: legacy.maxTurns ?? 20,
    maxAttempts: legacy.maxAttempts ?? 3,
    approvalsBeforePush: legacy.approvalsBeforePush ?? false,
    approvalsBeforePullRequest: legacy.approvalsBeforePullRequest ?? false,
    approvalsBeforeMerge: legacy.approvalsBeforeMerge ?? true,
  };
};

const rowToProject = (row: ProjectRow): SymphonyProject => {
  const configuration = decodeProjectConfiguration(row);
  return {
    id: row.id,
    codeProjectId: row.codeProjectId,
    title: row.title,
    repositoryPath: row.repositoryPath,
    status: row.status,
    setupState: configuration === null ? "needs_setup" : row.setupState,
    configuration,
    revision: row.revision,
    legacyWorkflowId: row.legacyWorkflowId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const projectToRow = (project: SymphonyProject): ProjectRow => ({
  id: project.id,
  codeProjectId: project.codeProjectId,
  title: project.title,
  repositoryPath: project.repositoryPath,
  status: project.status,
  setupState: project.setupState,
  configurationJson: project.configuration === null ? null : encodeJson(project.configuration),
  legacyConfigJson: null,
  revision: project.revision,
  legacyWorkflowId: project.legacyWorkflowId,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const SELECT_COLUMNS = `
  id, code_project_id AS "codeProjectId", title,
  repository_path AS "repositoryPath", status, setup_state AS "setupState",
  configuration_json AS "configurationJson", legacy_config_json AS "legacyConfigJson",
  revision, legacy_workflow_id AS "legacyWorkflowId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(SELECT_COLUMNS);

  const selectById = (id: SymphonyProjectId) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: SymphonyProjectId }),
      Result: ProjectRowSchema,
      execute: (request) => sql`SELECT ${columns} FROM symphony_projects WHERE id = ${request.id}`,
    })({ id });

  const getById: SymphonyProjectRepositoryShape["getById"] = (id) =>
    selectById(id).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.getById")),
      Effect.map(Option.match({ onNone: () => null, onSome: rowToProject })),
    );

  const getByCodeProjectId: SymphonyProjectRepositoryShape["getByCodeProjectId"] = (
    codeProjectId,
  ) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ codeProjectId: Schema.String }),
      Result: ProjectRowSchema,
      execute: (request) =>
        sql`SELECT ${columns} FROM symphony_projects WHERE code_project_id = ${request.codeProjectId}`,
    })({ codeProjectId }).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.getByCodeProjectId")),
      Effect.map(Option.match({ onNone: () => null, onSome: rowToProject })),
    );

  const create: SymphonyProjectRepositoryShape["create"] = (project) => {
    const row = projectToRow(project);
    return SqlSchema.findOneOption({
      Request: ProjectRowSchema,
      Result: ProjectRowSchema,
      execute: (request) => sql`
        INSERT INTO symphony_projects (
          id, code_project_id, title, repository_path, status, setup_state,
          configuration_json, legacy_config_json, revision, legacy_workflow_id,
          created_at, updated_at
        ) VALUES (
          ${request.id}, ${request.codeProjectId}, ${request.title}, ${request.repositoryPath},
          ${request.status}, ${request.setupState}, ${request.configurationJson},
          ${request.legacyConfigJson}, ${request.revision}, ${request.legacyWorkflowId},
          ${request.createdAt}, ${request.updatedAt}
        )
        ON CONFLICT(code_project_id) DO NOTHING
        RETURNING ${columns}
      `,
    })(row).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.create")),
      Effect.flatMap(
        Option.match({
          onNone: () => getByCodeProjectId(String(project.codeProjectId)),
          onSome: (created) => Effect.succeed(rowToProject(created)),
        }),
      ),
      Effect.flatMap((created) =>
        created === null
          ? Effect.fail(
              new SymphonyPersistenceSqlError({
                operation: "SymphonyProjectRepository.create",
                detail: `Project was not created for ${project.codeProjectId}`,
              }),
            )
          : Effect.succeed(created),
      ),
    );
  };

  const list: SymphonyProjectRepositoryShape["list"] = () =>
    sql<ProjectRow>`SELECT ${columns} FROM symphony_projects ORDER BY created_at ASC`.pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.list")),
      Effect.map((rows) => rows.map(rowToProject)),
    );

  const update: SymphonyProjectRepositoryShape["update"] = (project, expectedRevision) => {
    const row = projectToRow(project);
    return SqlSchema.findOneOption({
      Request: Schema.Struct({ row: ProjectRowSchema, expectedRevision: Schema.Int }),
      Result: ProjectRowSchema,
      execute: (request) => sql`
        UPDATE symphony_projects SET
          title = ${request.row.title},
          status = ${request.row.status},
          setup_state = ${request.row.setupState},
          configuration_json = ${request.row.configurationJson},
          legacy_config_json = NULL,
          revision = revision + 1,
          updated_at = ${request.row.updatedAt}
        WHERE id = ${request.row.id} AND revision = ${request.expectedRevision}
        RETURNING ${columns}
      `,
    })({ row, expectedRevision }).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.update")),
      Effect.map(Option.match({ onNone: () => null, onSome: rowToProject })),
    );
  };

  return {
    create,
    getById,
    getByCodeProjectId,
    list,
    update,
  } satisfies SymphonyProjectRepositoryShape;
});

export const SymphonyProjectRepositoryLive = Layer.effect(
  SymphonyProjectRepository,
  makeRepository,
);
