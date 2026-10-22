import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
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

const projectId = ProjectId.make("project-turn-settlement");
const threadId = ThreadId.make("thread-turn-settlement");
const turnId = TurnId.make("turn-turn-settlement");

const EngineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
);

const ReactorLayer = TurnSettlementReactorLive.pipe(
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provide(EngineLayer),
);

const TestLayer = Layer.mergeAll(
  EngineLayer,
  OrchestrationProjectionSnapshotQueryLive,
  ReactorLayer,
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

it.layer(TestLayer)("TurnSettlementReactor", (it) => {
  it.effect("publishes the completion the durable turn projection persisted", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const reactor = yield* TurnSettlementReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const eventStore = yield* OrchestrationEventStore;

      const session = (
        status: "running" | "starting" | "ready",
        activeTurnId: TurnId | null,
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* reactor.start();

          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-settlement-project-create"),
            projectId,
            title: "Turn settlement",
            workspaceRoot: "/tmp/turn-settlement",
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-settlement-thread-create"),
            threadId,
            projectId,
            title: "Turn settlement",
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

          // 1. Turn A starts.
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-settlement-session-running"),
            threadId,
            session: session("running", turnId, "2026-01-01T00:00:00.000Z"),
            createdAt: "2026-01-01T00:00:00.000Z",
          });
          // 2. The session leaves the running status without settling A.
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-settlement-session-starting"),
            threadId,
            session: session("starting", null, "2026-01-01T00:00:10.000Z"),
            createdAt: "2026-01-01T00:00:10.000Z",
          });
          // 3. A completed assistant message closes A at its own observation.
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("cmd-settlement-message-complete"),
            threadId,
            messageId: MessageId.make("message-settlement"),
            turnId,
            lastObservedAt: "2026-01-01T00:00:20.000Z",
            createdAt: "2026-01-01T00:00:20.000Z",
          });
          // 4. The session becomes ready later; the turn is already settled.
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-settlement-session-ready"),
            threadId,
            session: session("ready", null, "2026-01-01T00:00:30.000Z"),
            createdAt: "2026-01-01T00:00:30.000Z",
          });

          yield* reactor.drain;
        }),
      );

      const events = yield* Stream.runCollect(eventStore.readAll());
      const settlements = Array.from(events).filter(
        (event) => event.type === "thread.turn-settled" && event.payload.threadId === threadId,
      );
      expect(settlements).toHaveLength(1);
      const settlement = settlements[0];
      expect(
        settlement?.type === "thread.turn-settled" ? settlement.payload.completedAt : null,
      ).toBe("2026-01-01T00:00:20.000Z");

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadId);
      expect(Option.isSome(snapshot)).toBe(true);
      if (Option.isNone(snapshot)) return;
      // The emitted settlement is exactly what the durable snapshot records.
      expect(snapshot.value.thread.settledTurnCompletions).toEqual({
        [turnId]: "2026-01-01T00:00:20.000Z",
      });
    }),
  );
});
