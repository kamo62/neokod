import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionTurnsPendingWorkspace", (it) => {
  it.effect("leaves legacy pending admission workspaces unknown", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });

      // A legacy admission was accepted before either the thread or its
      // project moved. The current locations are not evidence of the folder
      // the pending start will use, so the migration must not copy them.
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-moved', 'Moved project', '/current/project-root', '{}',
          '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, worktree_path, created_at, updated_at
        ) VALUES (
          'thread-moved', 'project-moved', 'Moved thread', '/current/worktree',
          '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          checkpoint_files_json
        ) VALUES (
          'thread-moved', NULL, 'message-legacy', 'pending',
          '2026-08-09T00:00:00.000Z', '[]'
        )
      `;

      yield* runMigrations();

      const rows = yield* sql<{ readonly admittedWorkspacePath: string | null }>`
        SELECT admitted_workspace_path AS "admittedWorkspacePath"
        FROM projection_turns
        WHERE thread_id = 'thread-moved'
      `;
      assert.deepStrictEqual(rows, [{ admittedWorkspacePath: null }]);
    }),
  );
});
