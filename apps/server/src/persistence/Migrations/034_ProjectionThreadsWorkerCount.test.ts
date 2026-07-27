import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration034 from "./034_ProjectionThreadsWorkerCount.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ProjectionThreadsWorkerCount", (it) => {
  it.effect("defaults legacy rows to zero and re-applies safely", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          created_at,
          updated_at
        )
        VALUES (
          'thread-legacy-worker-count',
          'project-1',
          'Legacy thread',
          '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{ readonly workerCount: number }>`
        SELECT worker_count AS "workerCount"
        FROM projection_threads
      `;
      assert.deepStrictEqual(rows, [{ workerCount: 0 }]);

      yield* Migration034;

      const rowsAfterRerun = yield* sql<{ readonly workerCount: number }>`
        SELECT worker_count AS "workerCount"
        FROM projection_threads
      `;
      assert.deepStrictEqual(rowsAfterRerun, [{ workerCount: 0 }]);
    }),
  );
});
