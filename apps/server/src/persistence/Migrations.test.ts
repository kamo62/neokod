import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnId, type OrchestrationCommand, ProviderDriverKind } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderSessionReconcilerLive } from "../provider/Layers/ProviderSessionReconciler.ts";
import {
  HOST_LOST_SESSION_ERROR,
  ProviderSessionReconciler,
} from "../provider/Services/ProviderSessionReconciler.ts";
import {
  ProviderSessionDirectory as ProviderSessionDirectoryService,
  type ProviderRuntimeBinding,
  type ProviderRuntimeBindingWithMetadata,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { findMigrationIdentityProblems, runMigrations } from "./Migrations.ts";
import { migrationEntries } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

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

it.effect("clears legacy interrupt-request completions during the settlement upgrade", () =>
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
            ${encodeJson(input.payload)},
            '{}'
          )
        `;
      const sessionSet = (
        sequence: number,
        threadId: string,
        version: number,
        status: string,
        activeTurnId: string | null,
        updatedAt: string,
      ) =>
        insertEvent({
          sequence,
          threadId,
          version,
          type: "thread.session-set",
          payload: {
            threadId,
            session: { status, activeTurnId, updatedAt },
          },
        });
      const interruptRequested = (
        sequence: number,
        threadId: string,
        version: number,
        turnIdValue: string,
        createdAt: string,
      ) =>
        insertEvent({
          sequence,
          threadId,
          version,
          type: "thread.turn-interrupt-requested",
          payload: { threadId, turnId: turnIdValue, createdAt },
        });

      // The request at :10 was copied to the turn completion. A later closure
      // at :30 belongs to the session but cannot be attributed to this turn by
      // the migration, so the completion stays explicitly unknown.
      yield* insertThread("thread-recovered", "turn-recovered");
      yield* insertTurn("thread-recovered", "turn-recovered", "2026-01-01T00:00:10.000Z");
      yield* sessionSet(
        1,
        "thread-recovered",
        1,
        "running",
        "turn-recovered",
        "2026-01-01T00:00:00.000Z",
      );
      yield* interruptRequested(
        2,
        "thread-recovered",
        2,
        "turn-recovered",
        "2026-01-01T00:00:10.000Z",
      );
      yield* sessionSet(3, "thread-recovered", 3, "interrupted", null, "2026-01-01T00:00:30.000Z");

      // No later closure exists at all.
      yield* insertThread("thread-unknown", "turn-unknown");
      yield* insertTurn("thread-unknown", "turn-unknown", "2026-01-01T00:00:15.000Z");
      yield* sessionSet(
        4,
        "thread-unknown",
        1,
        "running",
        "turn-unknown",
        "2026-01-01T00:00:00.000Z",
      );
      yield* interruptRequested(5, "thread-unknown", 2, "turn-unknown", "2026-01-01T00:00:15.000Z");

      // Turn B supersedes A and later becomes ready. B's closure must never be
      // attributed to A.
      yield* insertThread("thread-superseded", "turn-a");
      yield* insertTurn("thread-superseded", "turn-a", "2026-01-01T00:00:10.000Z");
      yield* sessionSet(6, "thread-superseded", 1, "running", "turn-a", "2026-01-01T00:00:00.000Z");
      yield* interruptRequested(7, "thread-superseded", 2, "turn-a", "2026-01-01T00:00:10.000Z");
      yield* sessionSet(8, "thread-superseded", 3, "running", "turn-b", "2026-01-01T00:00:20.000Z");
      yield* sessionSet(9, "thread-superseded", 4, "ready", null, "2026-01-01T00:01:00.000Z");

      // A genuine completion without an interrupt request is untouched.
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
            superseded: yield* read("thread-superseded"),
            untouched: yield* read("thread-legit"),
          };
        }),
      );

      assert.deepStrictEqual(settlements.recovered, {
        [TurnId.make("turn-recovered")]: null,
      });
      assert.deepStrictEqual(settlements.unknown, {
        [TurnId.make("turn-unknown")]: null,
      });
      assert.deepStrictEqual(settlements.superseded, {
        [TurnId.make("turn-a")]: null,
      });
      assert.deepStrictEqual(settlements.untouched, {
        [TurnId.make("turn-legit")]: "2026-01-01T00:00:05.000Z",
      });
    }),
  ),
);

it.effect("recovers a legacy interrupted turn whose session still reports it running", () =>
  withMemoryDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });

      const threadId = "thread-running-session";
      const turnId = "turn-running-session";

      yield* sql`
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
          'Legacy running thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          NULL,
          NULL,
          ${turnId},
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:05.000Z',
          NULL
        )
      `;
      yield* sql`
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
          '2026-01-01T00:00:10.000Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;
      // The session never observed the stop: it still reports the turn running.
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          ${threadId},
          'running',
          'codex',
          'full-access',
          ${turnId},
          NULL,
          '2026-01-01T00:00:05.000Z'
        )
      `;
      // A running binding survived the crash, but no live provider session did.
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${threadId},
          'codex',
          'codex',
          'full-access',
          'running',
          '2026-01-01T00:00:05.000Z',
          NULL,
          ${encodeJson({ activeTurnId: turnId })}
        )
      `;
      for (const [sequence, version, type, payload] of [
        [
          1,
          1,
          "thread.session-set",
          {
            threadId,
            session: {
              status: "running",
              activeTurnId: turnId,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        ],
        [
          2,
          2,
          "thread.turn-interrupt-requested",
          { threadId, turnId, createdAt: "2026-01-01T00:00:10.000Z" },
        ],
      ] as const) {
        yield* sql`
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
            ${sequence},
            ${`event-${sequence}`},
            'thread',
            ${threadId},
            ${version},
            ${type},
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'server',
            ${encodeJson(payload)},
            '{}'
          )
        `;
      }

      yield* runMigrations();

      const commands: OrchestrationCommand[] = [];
      const upserts: ProviderRuntimeBinding[] = [];

      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            OrchestrationProjectionSnapshotQueryLive.pipe(
              Layer.provide(RepositoryIdentityResolver.layer),
              Layer.provide(NodeServices.layer),
            ),
          );
          const query = Context.get(context, ProjectionSnapshotQuery);

          // The migration cleared the request time; the session is still
          // running until startup reconciliation repairs it.
          const snapshot = yield* query.getThreadDetailSnapshot(ThreadId.make(threadId));
          assert.isTrue(Option.isSome(snapshot));
          if (Option.isNone(snapshot)) return;
          assert.deepStrictEqual(snapshot.value.thread.settledTurnCompletions, {
            [TurnId.make(turnId)]: null,
          });
          assert.equal(snapshot.value.thread.session?.status, "running");

          const binding: ProviderRuntimeBindingWithMetadata = {
            threadId: ThreadId.make(threadId),
            provider: ProviderDriverKind.make("codex"),
            status: "running",
            lastSeenAt: "2026-01-01T00:00:05.000Z",
            runtimePayload: { activeTurnId: TurnId.make(turnId) },
          };

          const reconciler = yield* ProviderSessionReconciler.pipe(
            Effect.provide(
              ProviderSessionReconcilerLive.pipe(
                Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
                Layer.provideMerge(
                  Layer.succeed(OrchestrationEngineService, {
                    dispatch: (command: OrchestrationCommand) =>
                      Effect.sync(() => {
                        commands.push(command);
                        return { sequence: 1 };
                      }),
                  } as unknown as OrchestrationEngineService["Service"]),
                ),
                Layer.provideMerge(
                  Layer.succeed(ProviderSessionDirectoryService, {
                    listBindings: () => Effect.succeed([binding]),
                    upsert: (next: ProviderRuntimeBinding) =>
                      Effect.sync(() => {
                        upserts.push(next);
                      }),
                  } as unknown as ProviderSessionDirectoryService["Service"]),
                ),
                Layer.provideMerge(
                  Layer.succeed(ProviderService, {
                    listSessions: () => Effect.succeed([]),
                  } as unknown as ProviderService["Service"]),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ),
          );
          yield* reconciler.reconcile;
        }),
      );

      const command = commands.find((entry) => entry.type === "thread.session.set");
      assert.isDefined(command);
      if (command?.type !== "thread.session.set") return;
      assert.equal(command.session.status, "interrupted");
      assert.equal(command.session.activeTurnId, null);
      assert.equal(command.session.lastError, HOST_LOST_SESSION_ERROR);
      assert.equal(command.interruptedTurnId, TurnId.make(turnId));
      // The completion stays unknown instead of inheriting boot time.
      assert.isNull(command.latestTurnCompletedAt ?? null);

      assert.equal(upserts.length, 1);
      assert.equal(upserts[0]?.status, "error");
      const runtimePayload = upserts[0]?.runtimePayload as {
        readonly stopOutcome?: { readonly status?: string; readonly reason?: string };
      };
      assert.equal(runtimePayload.stopOutcome?.status, "orphan_possible");
      assert.equal(runtimePayload.stopOutcome?.reason, "host_lost");
    }),
  ),
);
