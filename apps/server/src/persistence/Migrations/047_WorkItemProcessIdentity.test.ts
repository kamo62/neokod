import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_WorkItemProcessIdentity", (it) => {
  it.effect("adds nullable group identity columns without inferring them for legacy rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      yield* sql`
        INSERT INTO symphony_work_items (
          id, project_id, tracker_kind, tracker_issue_id, objective, lifecycle,
          source_json, owner_pid, created_at, updated_at
        ) VALUES (
          'item-legacy-claim', 'project-1', 'github', '1', 'Legacy claim', 'running',
          '{"kind":"manual"}', 4242, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_work_items)
      `;
      const names = columns.map((column) => column.name);
      assert.include(names, "owner_pgid");
      assert.include(names, "owner_birth_token");

      const rows = yield* sql<{
        readonly ownerPid: number | null;
        readonly ownerPgid: number | null;
        readonly ownerBirthToken: string | null;
      }>`
        SELECT
          owner_pid AS "ownerPid",
          owner_pgid AS "ownerPgid",
          owner_birth_token AS "ownerBirthToken"
        FROM symphony_work_items
        WHERE id = 'item-legacy-claim'
      `;
      // The bare pid stays readable, but no group id or birth token is invented.
      assert.deepStrictEqual(rows, [{ ownerPid: 4242, ownerPgid: null, ownerBirthToken: null }]);
    }),
  );
});
