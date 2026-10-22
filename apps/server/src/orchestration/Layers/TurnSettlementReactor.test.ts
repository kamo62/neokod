import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ThreadId as ThreadIdType,
  type TurnId as TurnIdType,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { WorktreeRemovalLeaseLive } from "../../git/WorktreeRemovalLease.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { TurnSettlementReactorLive } from "./TurnSettlementReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TurnSettlementReactor } from "../Services/TurnSettlementReactor.ts";

const EngineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
);

const TestLayer = Layer.mergeAll(EngineLayer, OrchestrationProjectionSnapshotQueryLive).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(WorktreeRemovalLeaseLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "neokod-turn-settlement-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * Build a fresh reactor instance from the shared engine. Building a new
 * instance models a process restart: its startup drain sees the durable outbox.
 * A recorder captures the commands the reactor dispatches.
 */
const buildReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand["type"]>>([]);
  const recordingEngine = {
    ...engine,
    dispatch: (command: OrchestrationCommand) =>
      Ref.update(dispatched, (current) => [...current, command.type]).pipe(
        Effect.andThen(engine.dispatch(command)),
      ),
  };
  const context = yield* Layer.build(
    TurnSettlementReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, recordingEngine)),
    ),
  );
  return { reactor: Context.get(context, TurnSettlementReactor), dispatched };
});

/**
 * Commit the review's sequence: turn A starts, the session becomes `starting`,
 * a completed assistant message closes A at its own observation, and the
 * session becomes ready later.
 */
const commitClosure = (run: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projectId = ProjectId.make(`project-turn-settlement-${run}`);
    const threadId = ThreadId.make(`thread-turn-settlement-${run}`);
    const turnId = TurnId.make(`turn-turn-settlement-${run}`);

    const session = (
      status: "running" | "starting" | "ready",
      activeTurnId: TurnIdType | null,
      updatedAt: string,
    ) => ({
      threadId,
      status,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId,
      lastError: null,
      updatedAt,
    });

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-settlement-${run}-project-create`),
      projectId,
      title: `Turn settlement ${run}`,
      workspaceRoot: `/tmp/turn-settlement-${run}`,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-settlement-${run}-thread-create`),
      threadId,
      projectId,
      title: `Turn settlement ${run}`,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-settlement-${run}-session-running`),
      threadId,
      session: session("running", turnId, "2026-01-01T00:00:00.000Z"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-settlement-${run}-session-starting`),
      threadId,
      session: session("starting", null, "2026-01-01T00:00:10.000Z"),
      createdAt: "2026-01-01T00:00:10.000Z",
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(`cmd-settlement-${run}-message-complete`),
      threadId,
      messageId: MessageId.make(`message-settlement-${run}`),
      turnId,
      lastObservedAt: "2026-01-01T00:00:20.000Z",
      createdAt: "2026-01-01T00:00:20.000Z",
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-settlement-${run}-session-ready`),
      threadId,
      session: session("ready", null, "2026-01-01T00:00:30.000Z"),
      createdAt: "2026-01-01T00:00:30.000Z",
    });

    return { threadId, turnId, completedAt: "2026-01-01T00:00:20.000Z" };
  });

const readSettlements = (threadId: ThreadIdType) =>
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore;
    const events = yield* Stream.runCollect(eventStore.readAll());
    return Array.from(events).filter(
      (event): event is Extract<OrchestrationEvent, { type: "thread.turn-settled" }> =>
        event.type === "thread.turn-settled" && event.payload.threadId === threadId,
    );
  });

const readSettledCompletions = (threadId: ThreadIdType) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadId);
    return Option.isSome(snapshot) ? snapshot.value.thread.settledTurnCompletions : undefined;
  });

it.layer(TestLayer)("TurnSettlementReactor", (it) => {
  it.effect("publishes the completion the durable turn projection persisted", () =>
    Effect.gen(function* () {
      const run = "live";

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { reactor } = yield* buildReactor;
          yield* reactor.start();
          const { threadId, turnId, completedAt } = yield* commitClosure(run);
          yield* reactor.drain;

          const settlements = yield* readSettlements(threadId);
          expect(settlements).toHaveLength(1);
          expect(settlements[0]?.payload).toEqual({ threadId, turnId, completedAt });
          expect(yield* readSettledCompletions(threadId)).toEqual({ [turnId]: completedAt });
        }),
      );
    }),
  );

  it.effect("reconciles a closure committed before the reactor started", () =>
    Effect.gen(function* () {
      const run = "crash";
      // The closure becomes durable while no reactor is running: this is the
      // crash window between durable closure and settlement publication.
      const { threadId, turnId, completedAt } = yield* commitClosure(run);
      expect(yield* readSettlements(threadId)).toHaveLength(0);

      const engine = yield* OrchestrationEngineService;
      const cacheSequence = yield* engine.latestSequence;

      // Restart with no further thread events: the startup outbox drain must
      // publish the durable settlement.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { reactor } = yield* buildReactor;
          yield* reactor.start();
          yield* reactor.drain;
        }),
      );

      const settlements = yield* readSettlements(threadId);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.payload).toEqual({ threadId, turnId, completedAt });
      // A warm-cache client resuming from its cached sequence receives it.
      expect(settlements[0]?.sequence).toBeGreaterThan(cacheSequence);
      expect(yield* readSettledCompletions(threadId)).toEqual({ [turnId]: completedAt });
    }),
  );

  it.effect("does not duplicate a settlement after a restart", () =>
    Effect.gen(function* () {
      const run = "restart";
      const { threadId, turnId, completedAt } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { reactor } = yield* buildReactor;
          yield* reactor.start();
          const closure = yield* commitClosure(run);
          yield* reactor.drain;
          return closure;
        }),
      );
      expect(yield* readSettlements(threadId)).toHaveLength(1);

      // The outbox row is marked published and the durable command receipt
      // dedupes a republished turn, so a restart emits nothing new.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { reactor } = yield* buildReactor;
          yield* reactor.start();
          yield* reactor.drain;
        }),
      );

      const settlements = yield* readSettlements(threadId);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.payload).toEqual({ threadId, turnId, completedAt });
    }),
  );

  it.effect("dispatches no historical settlements on a later boot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A long-lived database whose settlements were already published.
      yield* sql`
        WITH RECURSIVE seq(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM seq WHERE n < 2000
        )
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
        SELECT
          'thread-history',
          'turn-history-' || n,
          NULL,
          NULL,
          NULL,
          NULL,
          'completed',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '[]'
        FROM seq
      `;
      yield* sql`
        WITH RECURSIVE seq(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM seq WHERE n < 2000
        )
        INSERT INTO projection_turn_settlements (
          thread_id,
          turn_id,
          completed_at,
          published_at
        )
        SELECT
          'thread-history',
          'turn-history-' || n,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        FROM seq
      `;

      const { reactor, dispatched } = yield* buildReactor;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* reactor.start();
          yield* reactor.drain;
        }),
      );

      const commands = yield* Ref.get(dispatched);
      expect(commands.filter((type) => type === "thread.turn.settle")).toHaveLength(0);
    }),
  );
});
