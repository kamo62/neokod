import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SymphonyProjectId,
  type SymphonyProject,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { SymphonyProjectConflict } from "../Errors.ts";
import { encodeJson } from "../Json.ts";
import { SymphonyProjectRepository } from "../Services/SymphonyProjectRepository.ts";
import { SymphonyProjectRepositoryLive } from "./SymphonyProjectRepository.ts";

const layer = it.layer(
  SymphonyProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const project = (id: string, codeProjectId: string): SymphonyProject => ({
  id: SymphonyProjectId.make(id),
  codeProjectId: ProjectId.make(codeProjectId),
  title: "Example",
  repositoryPath: `/repo/${id}`,
  status: "paused",
  setupState: "ready",
  configuration: {
    tracker: { kind: "jira", projectKey: "OPS" },
    trackerRequiredLabels: [],
    trackerActiveStates: ["open"],
    trackerTerminalStates: ["done"],
    autonomy: "observe",
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
    },
    validationRequired: [],
    maxConcurrentAgents: 1,
    maxTurns: 20,
    maxAttempts: 3,
    approvalsBeforePush: false,
    approvalsBeforePullRequest: false,
    approvalsBeforeMerge: true,
  },
  revision: 0,
  legacyWorkflowId: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

layer("SymphonyProjectRepository", (it) => {
  it.effect("enforces one project per Code project and revision-fenced updates", () =>
    Effect.gen(function* () {
      const repository = yield* SymphonyProjectRepository;
      const created = yield* repository.create(project("symphony-a", "code-a"));
      const duplicate = yield* Effect.result(repository.create(project("symphony-b", "code-a")));

      expect(duplicate._tag).toBe("Failure");
      if (duplicate._tag === "Failure") {
        expect(duplicate.failure).toBeInstanceOf(SymphonyProjectConflict);
      }
      const duplicateRepository = yield* Effect.result(
        repository.create({
          ...project("symphony-c", "code-c"),
          repositoryPath: created.repositoryPath,
        }),
      );
      expect(duplicateRepository._tag).toBe("Failure");
      if (
        duplicateRepository._tag === "Failure" &&
        duplicateRepository.failure._tag === "SymphonyProjectConflict"
      ) {
        expect(duplicateRepository.failure.field).toBe("repository_path");
      }
      expect(yield* repository.list()).toHaveLength(1);

      const updated = yield* repository.update(
        { ...created, title: "Renamed", updatedAt: "2026-08-10T00:01:00.000Z" },
        0,
      );
      expect(updated?.title).toBe("Renamed");
      expect(updated?.revision).toBe(1);

      const stale = yield* repository.update({ ...created, title: "Stale" }, 0);
      expect(stale).toBeNull();
    }),
  );

  it.effect("loads legacy configuration and clears it only after a decoded update", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* SymphonyProjectRepository;
      const legacyConfig = encodeJson({
        repositoryPath: "/repo/legacy",
        workflowPath: "/repo/legacy/WORKFLOW.md",
        trackerKind: "jira",
        trackerRequiredLabels: [],
        trackerActiveStates: ["open"],
        trackerTerminalStates: ["done"],
        trackerProvider: { project_key: "OPS" },
        workspaceRoot: "/tmp/legacy",
        autonomy: "observe",
        agentProvider: {
          instanceId: "codex",
          driver: "codex",
        },
        validationRequired: [],
        validationTestPathPatterns: [],
        approvalsProtectedPaths: [],
        approvalsPolicies: [],
      });
      yield* sql`
        INSERT INTO symphony_projects (
          id, code_project_id, title, repository_path, status, setup_state,
          configuration_json, legacy_config_json, revision, legacy_workflow_id,
          created_at, updated_at
        ) VALUES (
          'legacy-project', 'legacy-code', 'Legacy', '/repo/legacy', 'paused', 'ready',
          NULL, ${legacyConfig}, 0, 'legacy-workflow',
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;

      const loaded = yield* repository.getById(SymphonyProjectId.make("legacy-project"));
      expect(loaded?.configuration?.tracker).toEqual({ kind: "jira", projectKey: "OPS" });

      const updated = yield* repository.update(
        { ...loaded!, title: "Migrated", updatedAt: "2026-08-10T00:01:00.000Z" },
        0,
      );
      expect(updated?.revision).toBe(1);
      const rows = yield* sql<{ readonly legacyConfigJson: string | null }>`
        SELECT legacy_config_json AS "legacyConfigJson"
        FROM symphony_projects WHERE id = 'legacy-project'
      `;
      expect(rows[0]?.legacyConfigJson).toBeNull();
    }),
  );

  it.effect("preserves undecodable legacy configuration during unrelated updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* SymphonyProjectRepository;
      yield* sql`
        INSERT INTO symphony_projects (
          id, code_project_id, title, repository_path, status, setup_state,
          configuration_json, legacy_config_json, revision, legacy_workflow_id,
          created_at, updated_at
        ) VALUES (
          'invalid-legacy-project', 'invalid-legacy-code', 'Invalid legacy',
          '/repo/invalid-legacy', 'paused', 'needs_setup', NULL, '{"trackerKind":"jira"}',
          0, 'invalid-legacy-workflow',
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;

      const loaded = yield* repository.getById(SymphonyProjectId.make("invalid-legacy-project"));
      expect(loaded?.configuration).toBeNull();
      yield* repository.update(
        { ...loaded!, title: "Still recoverable", updatedAt: "2026-08-10T00:01:00.000Z" },
        0,
      );
      const rows = yield* sql<{ readonly legacyConfigJson: string | null }>`
        SELECT legacy_config_json AS "legacyConfigJson"
        FROM symphony_projects WHERE id = 'invalid-legacy-project'
      `;
      expect(rows[0]?.legacyConfigJson).toBe('{"trackerKind":"jira"}');
    }),
  );
});
