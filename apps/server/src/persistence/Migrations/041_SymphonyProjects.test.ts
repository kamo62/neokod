import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_SymphonyProjects", (it) => {
  it.effect("migrates workflows without files and scopes tracker identity by project", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'code-project-1', 'Matched project', '/repo/matched', '{}',
          '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO symphony_workflows (
          id, repository_path, workflow_path, status, autonomy_level,
          definition_json, effective_config_json, created_at, updated_at
        ) VALUES
          (
            'workflow-matched', '/repo/matched', '/repo/matched/WORKFLOW.md', 'active', 'execute',
            '{}', '{"trackerKind":"github"}',
            '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
          ),
          (
            'workflow-unmatched', '/repo/unmatched', '/repo/unmatched/WORKFLOW.md', 'active',
            'execute', '{}', '{"trackerKind":"jira"}',
            '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO symphony_work_items (
          id, workflow_id, tracker_kind, tracker_issue_id, objective, lifecycle,
          repository_path, source_json, created_at, updated_at
        ) VALUES
          (
            'item-1', 'workflow-matched', 'github', '42', 'First issue', 'queued',
            '/repo/matched', '{"kind":"github","externalId":"42","externalUrl":"https://example/42"}',
            '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
          ),
          (
            'item-repository-match', NULL, 'github', '43', 'Repository matched issue', 'queued',
            '/repo/matched', '{"kind":"github","externalId":"43","externalUrl":"https://example/43"}',
            '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO symphony_run_attempts (
          id, work_item_id, attempt_number, provider, status, workspace_path, started_at
        ) VALUES (
          'run-1', 'item-1', 1, 'codex', 'running', '/tmp/run-1',
          '2026-08-09T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const projects = yield* sql<{
        readonly id: string;
        readonly codeProjectId: string | null;
        readonly title: string;
        readonly status: string;
        readonly setupState: string;
        readonly legacyConfigJson: string | null;
      }>`
        SELECT id, code_project_id AS "codeProjectId", title, status,
          setup_state AS "setupState", legacy_config_json AS "legacyConfigJson"
        FROM symphony_projects
        ORDER BY id
      `;
      assert.deepStrictEqual(projects, [
        {
          id: "workflow-matched",
          codeProjectId: "code-project-1",
          title: "Matched project",
          status: "paused",
          setupState: "ready",
          legacyConfigJson: '{"trackerKind":"github"}',
        },
        {
          id: "workflow-unmatched",
          codeProjectId: null,
          title: "/repo/unmatched",
          status: "paused",
          setupState: "needs_setup",
          legacyConfigJson: '{"trackerKind":"jira"}',
        },
      ]);

      yield* sql`
        INSERT INTO symphony_work_items (
          id, project_id, workflow_id, tracker_kind, tracker_issue_id, objective, lifecycle,
          repository_path, source_json, created_at, updated_at
        ) VALUES (
          'item-2', 'workflow-unmatched', 'workflow-unmatched', 'github', '42',
          'Same tracker issue in another project', 'queued', '/repo/unmatched',
          '{"kind":"github","externalId":"42","externalUrl":"https://example/42"}',
          '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
        )
      `;

      const identities = yield* sql<{
        readonly projectId: string;
        readonly trackerIssueId: string;
      }>`
        SELECT project_id AS "projectId", tracker_issue_id AS "trackerIssueId"
        FROM symphony_work_items
        ORDER BY id
      `;
      assert.deepStrictEqual(identities, [
        { projectId: "workflow-matched", trackerIssueId: "42" },
        { projectId: "workflow-unmatched", trackerIssueId: "42" },
        { projectId: "workflow-matched", trackerIssueId: "43" },
      ]);

      const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`;
      assert.deepStrictEqual(foreignKeyViolations, []);
    }),
  );
});
