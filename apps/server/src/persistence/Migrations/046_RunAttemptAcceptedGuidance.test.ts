import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_RunAttemptAcceptedGuidance", (it) => {
  it.effect("adds a nullable accepted-guidance column without inventing a snapshot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      yield* sql`
        INSERT INTO symphony_work_items (
          id, project_id, tracker_kind, tracker_issue_id, objective, lifecycle,
          source_json, created_at, updated_at
        ) VALUES (
          'item-guidance', 'project-1', 'github', '1', 'Guidance target', 'running',
          '{"kind":"manual"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO symphony_run_attempts (
          id, work_item_id, attempt_number, provider, status, workspace_path, started_at
        ) VALUES (
          'attempt-legacy', 'item-guidance', 1, 'codex',
          'streaming_turn', '/ws/1', '2026-10-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 46 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_run_attempts)
      `;
      assert.include(
        columns.map((column) => column.name),
        "accepted_guidance_json",
      );

      const rows = yield* sql<{ readonly acceptedGuidanceJson: string | null }>`
        SELECT accepted_guidance_json AS "acceptedGuidanceJson"
        FROM symphony_run_attempts
        WHERE id = 'attempt-legacy'
      `;
      assert.deepStrictEqual(rows, [{ acceptedGuidanceJson: null }]);
    }),
  );
});
