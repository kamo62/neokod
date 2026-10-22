import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_SymphonyIneligibleLifecycle", (it) => {
  it.effect("renames eligible to ineligible and requeues items without reasons", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });

      yield* sql`
        INSERT INTO symphony_work_items (
          id, project_id, tracker_kind, tracker_issue_id, objective, lifecycle,
          source_json, created_at, updated_at
        ) VALUES
          (
            'item-empty-reasons', 'project-1', 'github', '1', 'No reasons', 'eligible',
            '{"kind":"manual"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
          ),
          (
            'item-with-reasons', 'project-1', 'github', '2', 'Has reasons', 'eligible',
            '{"kind":"manual"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
          ),
          (
            'item-queued', 'project-1', 'github', '3', 'Already queued', 'queued',
            '{"kind":"manual"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
          )
      `;
      yield* sql`
        UPDATE symphony_work_items
        SET eligibility_reasons_json = '["missing_label:x"]'
        WHERE id = 'item-with-reasons'
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const rows = yield* sql<{ readonly id: string; readonly lifecycle: string }>`
        SELECT id, lifecycle FROM symphony_work_items ORDER BY id
      `;
      assert.deepStrictEqual(rows, [
        { id: "item-empty-reasons", lifecycle: "queued" },
        { id: "item-queued", lifecycle: "queued" },
        { id: "item-with-reasons", lifecycle: "ineligible" },
      ]);
    }),
  );
});
