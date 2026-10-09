import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { findMigrationIdentityProblems, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const withMemoryDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

describe("findMigrationIdentityProblems", () => {
  it("returns no problems for a matching list", () => {
    const entries = [
      [1, "One", 0],
      [2, "Two", 0],
    ] as const;
    const applied = [
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
    ];
    assert.deepStrictEqual(findMigrationIdentityProblems(applied, entries), []);
  });

  it("reports a swapped name at id 40", () => {
    const entries = [
      [40, "ProjectionRuntimeItems", 0],
      [41, "SymphonyProjects", 0],
    ] as const;
    const applied = [
      { id: 40, name: "SymphonyOwnerProcessGroup" },
      { id: 41, name: "SymphonyProjects" },
    ];
    const problems = findMigrationIdentityProblems(applied, entries);
    assert.strictEqual(problems.length, 1);
    assert.include(problems[0], "id 40");
    assert.include(problems[0], "SymphonyOwnerProcessGroup");
    assert.include(problems[0], "ProjectionRuntimeItems");
  });

  it("reports an applied id this build does not have", () => {
    const entries = [
      [1, "One", 0],
      [2, "Two", 0],
    ] as const;
    const applied = [
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
      { id: 99, name: "FromTheFuture" },
    ];
    const problems = findMigrationIdentityProblems(applied, entries);
    assert.strictEqual(problems.length, 1);
    assert.include(problems[0], "id 99");
  });

  it("reports a gap below the latest applied id as skipped", () => {
    const entries = [
      [1, "One", 0],
      [2, "Two", 0],
      [3, "Three", 0],
      [4, "Four", 0],
    ] as const;
    const applied = [
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
      { id: 4, name: "Four" },
    ];
    const problems = findMigrationIdentityProblems(applied, entries);
    assert.strictEqual(problems.length, 1);
    assert.include(problems[0], "id 3");
    assert.include(problems[0], "skipped");
  });

  it("accepts a partial run up to throughId", () => {
    const entries = [
      [1, "One", 0],
      [2, "Two", 0],
      [3, "Three", 0],
      [4, "Four", 0],
    ] as const;
    const applied = [
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
    ];
    assert.deepStrictEqual(findMigrationIdentityProblems(applied, entries, 2), []);
  });
});

it.effect("refuses a database whose migration 40 and 41 carry another branch's names", () =>
  withMemoryDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (40, 'SymphonyOwnerProcessGroup'), (41, 'ProjectionRuntimeItems')`;
      const error = yield* Effect.flip(runMigrations());
      assert.strictEqual(error._tag, "MigrationError");
      if (error._tag !== "MigrationError") return;
      assert.strictEqual(error.kind, "BadState");
      assert.include(error.message, "id 40");
      assert.include(error.message, "SymphonyOwnerProcessGroup");
      assert.include(error.message, "id 41");
      assert.include(error.message, "state.sqlite");
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symphony_projects'`;
      assert.deepStrictEqual(tables, []);
    }),
  ),
);

it.effect("refuses an applied id this build does not have", () =>
  withMemoryDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'FromTheFuture')`;
      const error = yield* Effect.flip(runMigrations());
      assert.strictEqual(error._tag, "MigrationError");
      if (error._tag !== "MigrationError") return;
      assert.include(error.message, "id 99");
    }),
  ),
);

it.effect("refuses a gap below the latest applied id", () =>
  withMemoryDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 40`;
      const error = yield* Effect.flip(runMigrations());
      assert.strictEqual(error._tag, "MigrationError");
      if (error._tag !== "MigrationError") return;
      assert.include(error.message, "id 40");
      assert.include(error.message, "skipped");
    }),
  ),
);

it.effect("accepts a database that was migrated in two steps and a repeated run", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 40 });
      const second = yield* runMigrations();
      assert.deepStrictEqual(second, [[41, "SymphonyProjects"]]);
      const third = yield* runMigrations();
      assert.deepStrictEqual(third, []);
    }),
  ),
);
