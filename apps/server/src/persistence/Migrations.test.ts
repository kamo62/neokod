import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { findMigrationIdentityProblems, runMigrations } from "./Migrations.ts";
import { migrationEntries } from "./Migrations.ts";
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
      const expected = migrationEntries
        .filter(([id]) => id > 40)
        .map(([id, name]) => [id, name] as const);
      assert.deepStrictEqual(second, expected);
      const third = yield* runMigrations();
      assert.deepStrictEqual(third, []);
    }),
  ),
);

it.effect("repairs legacy interrupt-request completions during the settlement upgrade", () =>
  withMemoryDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });

      const insertThread = (threadId: string, turnId: string) =>
        sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            branch,
            worktree_path,
            latest_turn_id,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            ${threadId},
            'project-legacy',
            'Legacy thread',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            NULL,
            NULL,
            ${turnId},
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:30.000Z',
            NULL
          )
        `;
      const insertTurn = (threadId: string, turnId: string, completedAt: string) =>
        sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            source_proposed_plan_thread_id,
            source_proposed_plan_id,
            assistant_message_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json
          )
          VALUES (
            ${threadId},
            ${turnId},
            NULL,
            NULL,
            NULL,
            NULL,
            'interrupted',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            ${completedAt},
            NULL,
            NULL,
            NULL,
            '[]'
          )
        `;
      const insertEvent = (input: {
        readonly sequence: number;
        readonly threadId: string;
        readonly version: number;
        readonly type: string;
        readonly payload: unknown;
      }) =>
        sql`
          INSERT INTO orchestration_events (
            sequence,
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            causation_event_id,
            correlation_id,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES (
            ${input.sequence},
            ${`event-${input.sequence}`},
            'thread',
            ${input.threadId},
            ${input.version},
            ${input.type},
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'server',
            ${JSON.stringify(input.payload)},
            '{}'
          )
        `;

      // Base-version legacy state: the interrupt request at :10 was written as
      // the turn completion even though the session observed the stop at :30.
      yield* insertThread("thread-recovered", "turn-recovered");
      yield* insertTurn("thread-recovered", "turn-recovered", "2026-01-01T00:00:10.000Z");
      yield* insertEvent({
        sequence: 1,
        threadId: "thread-recovered",
        version: 1,
        type: "thread.session-set",
        payload: {
          threadId: "thread-recovered",
          session: {
            status: "running",
            activeTurnId: "turn-recovered",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      yield* insertEvent({
        sequence: 2,
        threadId: "thread-recovered",
        version: 2,
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: "thread-recovered",
          turnId: "turn-recovered",
          createdAt: "2026-01-01T00:00:10.000Z",
        },
      });
      yield* insertEvent({
        sequence: 3,
        threadId: "thread-recovered",
        version: 3,
        type: "thread.session-set",
        payload: {
          threadId: "thread-recovered",
          session: {
            status: "interrupted",
            activeTurnId: null,
            updatedAt: "2026-01-01T00:00:30.000Z",
          },
        },
      });

      // No later closure evidence exists: the request time must not survive.
      yield* insertThread("thread-unknown", "turn-unknown");
      yield* insertTurn("thread-unknown", "turn-unknown", "2026-01-01T00:00:15.000Z");
      yield* insertEvent({
        sequence: 4,
        threadId: "thread-unknown",
        version: 1,
        type: "thread.session-set",
        payload: {
          threadId: "thread-unknown",
          session: {
            status: "running",
            activeTurnId: "turn-unknown",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      yield* insertEvent({
        sequence: 5,
        threadId: "thread-unknown",
        version: 2,
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: "thread-unknown",
          turnId: "turn-unknown",
          createdAt: "2026-01-01T00:00:15.000Z",
        },
      });

      // A genuine completion with no interrupt request is untouched.
      yield* insertThread("thread-legit", "turn-legit");
      yield* insertTurn("thread-legit", "turn-legit", "2026-01-01T00:00:05.000Z");

      yield* runMigrations();

      const settlements = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            OrchestrationProjectionSnapshotQueryLive.pipe(
              Layer.provide(RepositoryIdentityResolver.layer),
              Layer.provide(NodeServices.layer),
            ),
          );
          const query = Context.get(context, ProjectionSnapshotQuery);
          const read = (threadId: string) =>
            query
              .getThreadDetailSnapshot(ThreadId.make(threadId))
              .pipe(
                Effect.map((snapshot) =>
                  Option.isSome(snapshot)
                    ? snapshot.value.thread.settledTurnCompletions
                    : undefined,
                ),
              );
          return {
            recovered: yield* read("thread-recovered"),
            unknown: yield* read("thread-unknown"),
            untouched: yield* read("thread-legit"),
          };
        }),
      );

      // The durable row is rebuilt from the server-observed closure, never the
      // request timestamp.
      assert.deepStrictEqual(settlements.recovered, {
        [TurnId.make("turn-recovered")]: "2026-01-01T00:00:30.000Z",
      });
      assert.deepStrictEqual(settlements.unknown, {
        [TurnId.make("turn-unknown")]: null,
      });
      assert.deepStrictEqual(settlements.untouched, {
        [TurnId.make("turn-legit")]: "2026-01-01T00:00:05.000Z",
      });
    }),
  ),
);
