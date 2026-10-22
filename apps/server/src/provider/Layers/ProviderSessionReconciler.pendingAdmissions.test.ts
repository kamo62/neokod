import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { WorktreeRemovalLeaseLive } from "../../git/WorktreeRemovalLease.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionReconciler } from "../Services/ProviderSessionReconciler.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionReconcilerLive } from "./ProviderSessionReconciler.ts";

const createdAt = "2026-08-09T00:00:00.000Z";
const projectId = ProjectId.make("project-pending-recovery");
const threadId = ThreadId.make("thread-pending-recovery");
const projectWorkspaceRoot = "/tmp/neokod-pending-recovery-workspace";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const makeStartupLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const orchestration = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(WorktreeRemovalLeaseLive),
    Layer.provide(persistence),
    Layer.provide(NodeServices.layer),
  );

  return ProviderSessionReconcilerLive.pipe(
    Layer.provideMerge(orchestration),
    Layer.provide(
      Layer.succeed(ProviderService, {
        listSessions: () => Effect.succeed([]),
      } as unknown as ProviderService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderSessionDirectory, {
        listBindings: () => Effect.succeed([]),
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectory["Service"]),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const createProjectAndThread = Effect.fn("createProjectAndThread")(function* (
  engine: OrchestrationEngineService["Service"],
) {
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-pending-recovery-project"),
    projectId,
    title: "Pending recovery project",
    workspaceRoot: projectWorkspaceRoot,
    defaultModelSelection: modelSelection,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-pending-recovery-thread"),
    threadId,
    projectId,
    title: "Pending recovery thread",
    modelSelection,
    interactionMode: "default",
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt,
  });
});

const startTurn = (
  engine: OrchestrationEngineService["Service"],
  messageId: string,
  suffix: string,
) =>
  engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-pending-recovery-turn-${suffix}`),
    threadId,
    message: {
      messageId: MessageId.make(messageId),
      role: "user",
      text: "continue",
      attachments: [],
    },
    interactionMode: "default",
    runtimeMode: "approval-required",
    createdAt,
  });

const settleConversationTurn = (engine: OrchestrationEngineService["Service"]) =>
  Effect.gen(function* () {
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-pending-recovery-session-running"),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.make("turn-pending-recovery-1"),
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-pending-recovery-session-ready"),
      threadId,
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
  });

const recoveryActivities = (
  detail: Option.Option<{
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly turnId: string | null;
      readonly payload: unknown;
    }>;
  }>,
  messageId: string,
) => {
  const thread = Option.getOrUndefined(detail);
  return (thread?.activities ?? []).filter((activity) => {
    if (activity.kind !== "provider.turn.start.failed") {
      return false;
    }
    const payload = activity.payload;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "messageId" in payload &&
      (payload as { readonly messageId?: unknown }).messageId === messageId
    );
  });
};

const runStartup = <A, E>(
  startupLayer: ReturnType<typeof makeStartupLayer>,
  run: (context: Context.Context<any>) => Effect.Effect<A, E>,
) => Effect.scoped(Layer.build(startupLayer).pipe(Effect.flatMap((context) => run(context))));

const verifySettled = (
  startupLayer: ReturnType<typeof makeStartupLayer>,
  pendingMessageId: string,
) =>
  runStartup(startupLayer, (context) =>
    Effect.gen(function* () {
      const reconciler = Context.get(context, ProviderSessionReconciler);
      const projectionTurns = Context.get(context, ProjectionTurnRepository);
      const snapshotQuery = Context.get(context, ProjectionSnapshotQuery);

      yield* reconciler.reconcile;
      yield* reconciler.reconcile;

      const pending = yield* projectionTurns.getPendingTurnStartByThreadId({ threadId });
      assert.isTrue(Option.isNone(pending));

      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      const activities = recoveryActivities(detail, pendingMessageId);
      assert.equal(activities.length, 1);
      assert.equal(activities[0]?.turnId, null);
      const payload = activities[0]?.payload as
        | { readonly detail?: string; readonly messageId?: string }
        | undefined;
      assert.equal(payload?.messageId, pendingMessageId);
      assert.include(payload?.detail ?? "", "outcome is unknown");
      assert.notInclude(payload?.detail ?? "", "completed");
    }),
  );

const verifySecondRestartAndFreshStart = (
  startupLayer: ReturnType<typeof makeStartupLayer>,
  pendingMessageId: string,
) =>
  runStartup(startupLayer, (context) =>
    Effect.gen(function* () {
      const reconciler = Context.get(context, ProviderSessionReconciler);
      const snapshotQuery = Context.get(context, ProjectionSnapshotQuery);
      const engine = Context.get(context, OrchestrationEngineService);
      yield* reconciler.reconcile;
      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.equal(recoveryActivities(detail, pendingMessageId).length, 1);

      const freshStart = yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-pending-recovery-fresh"),
          threadId,
          message: {
            messageId: MessageId.make("message-pending-recovery-fresh"),
            role: "user",
            text: "fresh start",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt,
        })
        .pipe(Effect.exit);
      assert.isTrue(freshStart._tag === "Success");
    }),
  );

it.effect("settles a first-turn pending admission across restarts", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const startupLayer = makeStartupLayer(dbPath);
    const pendingMessageId = "message-pending-recovery-first";

    yield* runStartup(startupLayer, (context) =>
      Effect.gen(function* () {
        const engine = Context.get(context, OrchestrationEngineService);
        yield* createProjectAndThread(engine);
        yield* startTurn(engine, pendingMessageId, "first");
        const projectionTurns = Context.get(context, ProjectionTurnRepository);
        const pending = yield* projectionTurns.getPendingTurnStartByThreadId({ threadId });
        assert.isTrue(Option.isSome(pending));
      }),
    );

    yield* verifySettled(startupLayer, pendingMessageId);
    yield* verifySecondRestartAndFreshStart(startupLayer, pendingMessageId);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "neokod-pending-recovery-first-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.effect("settles a pending admission after an existing conversation across restarts", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const startupLayer = makeStartupLayer(dbPath);
    const pendingMessageId = "message-pending-recovery-conversation";

    yield* runStartup(startupLayer, (context) =>
      Effect.gen(function* () {
        const engine = Context.get(context, OrchestrationEngineService);
        yield* createProjectAndThread(engine);
        yield* startTurn(engine, "message-pending-recovery-completed", "completed");
        yield* settleConversationTurn(engine);
        yield* startTurn(engine, pendingMessageId, "conversation");
        const projectionTurns = Context.get(context, ProjectionTurnRepository);
        const pending = yield* projectionTurns.getPendingTurnStartByThreadId({ threadId });
        assert.isTrue(Option.isSome(pending));
      }),
    );

    yield* verifySettled(startupLayer, pendingMessageId);
    yield* verifySecondRestartAndFreshStart(startupLayer, pendingMessageId);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "neokod-pending-recovery-conversation-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
