import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration033 from "./033_ProjectionThreadsGoal.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProjectionThreadsGoal", (it) => {
  it.effect("adds goal columns to existing rows and re-applies safely", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          created_at,
          updated_at
        )
        VALUES (
          'thread-legacy',
          'project-1',
          'Legacy thread',
          '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(columns.some((column) => column.name === "goal"));
      assert.isTrue(columns.some((column) => column.name === "goal_status"));

      const rows = yield* sql<{
        readonly goal: string | null;
        readonly goalStatus: string;
      }>`
        SELECT goal, goal_status AS "goalStatus" FROM projection_threads
      `;
      assert.deepStrictEqual(rows, [{ goal: null, goalStatus: "active" }]);

      // The migration is guarded by PRAGMA table_info, so running its effect
      // again against an already-migrated database must be a no-op.
      yield* Migration033;

      const rowsAfterRerun = yield* sql<{
        readonly goal: string | null;
        readonly goalStatus: string;
      }>`
        SELECT goal, goal_status AS "goalStatus" FROM projection_threads
      `;
      assert.deepStrictEqual(rowsAfterRerun, [{ goal: null, goalStatus: "active" }]);
    }),
  );
});
