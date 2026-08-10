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

import { SymphonyPersistenceSqlError, SymphonyProjectConflict } from "../Errors.ts";
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

type DecodedProjectConfiguration =
  | { readonly state: "decoded"; readonly configuration: SymphonyProjectConfiguration }
  | { readonly state: "absent"; readonly configuration: null }
  | { readonly state: "invalid"; readonly configuration: null; readonly issue: string };

const decodeProjectConfiguration = (row: ProjectRow): DecodedProjectConfiguration => {
  if (row.configurationJson !== null) {
    try {
      const decoded = decodeProjectConfigurationOption(decodeJson(row.configurationJson));
      return Option.isSome(decoded)
        ? { state: "decoded", configuration: decoded.value }
        : {
            state: "invalid",
            configuration: null,
            issue: "configuration_json does not match SymphonyProjectConfiguration",
          };
    } catch {
      return { state: "invalid", configuration: null, issue: "configuration_json is invalid JSON" };
    }
  }
  if (row.legacyConfigJson === null) {
    return { state: "absent", configuration: null };
  }
  let legacy: EffectiveWorkflowConfig;
  try {
    const decoded = decodeLegacyConfigurationOption(decodeJson(row.legacyConfigJson));
    if (Option.isNone(decoded)) {
      return {
        state: "invalid",
        configuration: null,
        issue: "legacy_config_json does not match EffectiveWorkflowConfig",
      };
    }
    legacy = decoded.value;
  } catch {
    return { state: "invalid", configuration: null, issue: "legacy_config_json is invalid JSON" };
  }
  const tracker = legacyTrackerScope(legacy);
  if (!tracker) {
    return {
      state: "invalid",
      configuration: null,
      issue: "legacy_config_json does not contain a usable tracker scope",
    };
  }
  return {
    state: "decoded",
    configuration: {
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
    },
  };
};

const rowToProject = (
  row: ProjectRow,
): { readonly project: SymphonyProject; readonly decodeIssue: string | null } => {
  const decoded = decodeProjectConfiguration(row);
  return {
    project: {
      id: row.id,
      codeProjectId: row.codeProjectId,
      title: row.title,
      repositoryPath: row.repositoryPath,
      status: row.status,
      setupState: decoded.configuration === null ? "needs_setup" : row.setupState,
      configuration: decoded.configuration,
      revision: row.revision,
      legacyWorkflowId: row.legacyWorkflowId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    decodeIssue: decoded.state === "invalid" ? decoded.issue : null,
  };
};

const decodeProjectRow = (row: ProjectRow): Effect.Effect<SymphonyProject> => {
  const decoded = rowToProject(row);
  return decoded.decodeIssue === null
    ? Effect.succeed(decoded.project)
    : Effect.logWarning("symphony.project.configuration.invalid", {
        projectId: row.id,
        issue: decoded.decodeIssue,
      }).pipe(Effect.as(decoded.project));
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
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: decodeProjectRow,
        }),
      ),
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
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: decodeProjectRow,
        }),
      ),
    );

  const getByRepositoryPath = (repositoryPath: string) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ repositoryPath: Schema.String }),
      Result: ProjectRowSchema,
      execute: (request) =>
        sql`SELECT ${columns} FROM symphony_projects WHERE repository_path = ${request.repositoryPath}`,
    })({ repositoryPath }).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.getByRepositoryPath")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: decodeProjectRow,
        }),
      ),
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
        ON CONFLICT DO NOTHING
        RETURNING ${columns}
      `,
    })(row).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.create")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.gen(function* () {
              if ((yield* getById(project.id)) !== null) {
                return yield* Effect.fail(
                  new SymphonyProjectConflict({ field: "id", value: project.id }),
                );
              }
              if (
                project.codeProjectId !== null &&
                (yield* getByCodeProjectId(project.codeProjectId)) !== null
              ) {
                return yield* Effect.fail(
                  new SymphonyProjectConflict({
                    field: "code_project_id",
                    value: project.codeProjectId,
                  }),
                );
              }
              if ((yield* getByRepositoryPath(project.repositoryPath)) !== null) {
                return yield* Effect.fail(
                  new SymphonyProjectConflict({
                    field: "repository_path",
                    value: project.repositoryPath,
                  }),
                );
              }
              return yield* Effect.fail(
                new SymphonyPersistenceSqlError({
                  operation: "SymphonyProjectRepository.create",
                  detail: `Project was not created for ${project.id}`,
                }),
              );
            }),
          onSome: decodeProjectRow,
        }),
      ),
    );
  };

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectRowSchema,
    execute: () => sql`SELECT ${columns} FROM symphony_projects ORDER BY created_at ASC`,
  });

  const list: SymphonyProjectRepositoryShape["list"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.list")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeProjectRow)),
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
          legacy_config_json = CASE
            WHEN ${request.row.configurationJson} IS NOT NULL THEN NULL
            ELSE legacy_config_json
          END,
          revision = revision + 1,
          updated_at = ${request.row.updatedAt}
        WHERE id = ${request.row.id} AND revision = ${request.expectedRevision}
        RETURNING ${columns}
      `,
    })({ row, expectedRevision }).pipe(
      Effect.mapError(toSqlError("SymphonyProjectRepository.update")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: decodeProjectRow,
        }),
      ),
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
