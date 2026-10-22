import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
import * as Stream from "effect/Stream";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
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

const TestLayer = Layer.mergeAll(
  EngineLayer,
  OrchestrationProjectionSnapshotQueryLive,
  ProjectionTurnRepositoryLive,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(WorktreeRemovalLeaseLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "neokod-turn-settlement-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * Build a fresh reactor instance from the shared engine and durable turn
 * projection. Building a new instance models a process restart: its in-memory
 * publication set is empty and it reconciles durable settlements at startup.
 */
const buildReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const turnRepository = yield* ProjectionTurnRepository;
  // Build in the caller's scope: the reactor owns a scoped worker fiber, so
  // it must outlive this effect until the surrounding scope closes.
  const context = yield* Layer.build(
    TurnSettlementReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionTurnRepository, turnRepository)),
    ),
  );
  return Context.get(context, TurnSettlementReactor);
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
          const reactor = yield* buildReactor;
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

      // Restart with no further thread events: startup reconciliation must
      // publish the durable settlement.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* buildReactor;
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
          const firstReactor = yield* buildReactor;
          yield* firstReactor.start();
          const closure = yield* commitClosure(run);
          yield* firstReactor.drain;
          return closure;
        }),
      );
      expect(yield* readSettlements(threadId)).toHaveLength(1);

      // A fresh instance has an empty in-memory publication set and reconciles
      // the durable closure again. The durable command receipt dedupes it.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restartedReactor = yield* buildReactor;
          yield* restartedReactor.start();
          yield* restartedReactor.drain;
        }),
      );

      const settlements = yield* readSettlements(threadId);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.payload).toEqual({ threadId, turnId, completedAt });
    }),
  );
});
