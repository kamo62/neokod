// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
  VcsProcessExitError,
} from "@neokod/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { WorktreeRemovalLeaseLive } from "../../git/WorktreeRemovalLease.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { RECOVERY_REFS_PREFIX, checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
  extraSessions: ReadonlyArray<ProviderSession> = [],
  listSessionsFailure = false,
  sessionActiveTurnId?: string,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const baseSessions: ReadonlyArray<ProviderSession> = hasSession
    ? [
        {
          provider: providerName,
          status: "ready",
          runtimeMode: "full-access",
          threadId: ThreadId.make("thread-1"),
          cwd: sessionCwd,
          ...(sessionActiveTurnId !== undefined
            ? { activeTurnId: TurnId.make(sessionActiveTurnId) }
            : {}),
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [];
  const listSessions = () =>
    listSessionsFailure
      ? Effect.die(new Error("provider session list unavailable"))
      : Effect.succeed([...baseSessions, ...extraSessions]);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    stopAllSessions: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

type ThreadActivitySummary = {
  readonly kind: string;
  readonly turnId?: string | null;
  readonly payload?: unknown;
};

type ThreadStateSummary = {
  latestTurn: { turnId: string } | null;
  checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
  activities: ReadonlyArray<ThreadActivitySummary>;
};

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<ThreadStateSummary & { readonly id: ThreadId }>;
  }>,
  predicate: (thread: ThreadStateSummary) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<ThreadStateSummary> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForRevertOutcome(engine: OrchestrationEngineShape) {
  return waitForEvent(engine, (event) => {
    if (event.type === "thread.reverted") {
      return true;
    }
    if (event.type !== "thread.activity-appended") {
      return false;
    }
    const activity = (event as unknown as { payload: { activity: { kind: string } } }).payload
      .activity;
    return activity.kind === "checkpoint.revert.failed";
  });
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "neokod-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function listRecoveryRefs(cwd: string): string[] {
  return runGit(cwd, ["for-each-ref", "--format=%(refname)", `${RECOVERY_REFS_PREFIX}/`])
    .split("\n")
    .filter((ref) => ref.length > 0);
}

const threadTurnStartCommand = (input: {
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
}) =>
  ({
    type: "thread.turn.start" as const,
    commandId: CommandId.make(input.commandId),
    threadId: ThreadId.make(input.threadId),
    message: {
      messageId: MessageId.make(input.messageId),
      role: "user" as const,
      text: "start a turn",
      attachments: [],
    },
    runtimeMode: "approval-required" as const,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as const;

async function revertToTurnOne(
  harness: {
    readonly engine: OrchestrationEngineShape;
    readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  },
  options?: { readonly beforeRevert?: () => Promise<unknown> },
) {
  const createdAt = "2026-01-01T00:00:00.000Z";

  await harness.runPromise(
    harness.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-revert-helper-session-set"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    }),
  );

  for (const turnCount of [1, 2]) {
    await harness.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(`cmd-revert-helper-diff-${turnCount}`),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId(`turn-${turnCount}`),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
        status: "ready",
        files: [],
        checkpointTurnCount: turnCount,
        createdAt,
      }),
    );
  }

  await options?.beforeRevert?.();
  await harness.runPromise(
    harness.engine.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-revert-helper-request"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt,
    }),
  );
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore.CheckpointStore
    | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly threadBranch?: string | null;
    readonly secondThreadSharingWorktree?: boolean;
    readonly localStatusRefName?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly otherSessions?: ReadonlyArray<{
      readonly threadId: string;
      readonly status: ProviderSession["status"];
      readonly activeTurnId?: string;
      readonly cwd?: string;
    }>;
    readonly ownSessionActiveTurnId?: string;
    readonly failRecoveryCapture?: boolean;
    readonly listSessionsFailure?: boolean;
    readonly prepareRepository?: (cwd: string) => void;
    readonly providerSessionSubdirectory?: string;
    readonly truncateIgnoredEnumeration?: boolean;
    readonly fixedClock?: boolean;
    readonly recoveryCaptureGate?: {
      readonly markStarted: () => void;
      readonly release: Promise<void>;
    };
    readonly repositoryCwd?: string;
  }) {
    const cwd = options?.repositoryCwd ?? createGitRepository();
    if (options?.repositoryCwd === undefined) {
      tempDirs.push(cwd);
    }
    options?.prepareRepository?.(cwd);
    const sessionCwd =
      options?.providerSessionSubdirectory !== undefined
        ? NodePath.join(cwd, options.providerSessionSubdirectory)
        : (options?.providerSessionCwd ?? cwd);
    const sessionsNow = "2026-01-01T00:00:00.000Z";
    const extraSessions: ReadonlyArray<ProviderSession> = (options?.otherSessions ?? []).map(
      (session) => ({
        provider: ProviderDriverKind.make("codex"),
        status: session.status,
        runtimeMode: "full-access",
        threadId: ThreadId.make(session.threadId),
        cwd: session.cwd ?? cwd,
        ...(session.activeTurnId !== undefined
          ? { activeTurnId: TurnId.make(session.activeTurnId) }
          : {}),
        createdAt: sessionsNow,
        updatedAt: sessionsNow,
      }),
    );
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      sessionCwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
      extraSessions,
      options?.listSessionsFailure ?? false,
      options?.ownSessionActiveTurnId,
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "neokod-checkpoint-reactor-test-",
    });
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName:
              options?.localStatusRefName !== undefined ? options.localStatusRefName : "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      streamStatus: () => Stream.empty,
    });

    const checkpointStoreBaseLayer = CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
    );
    const checkpointStoreLayer =
      options?.failRecoveryCapture === true || options?.recoveryCaptureGate !== undefined
        ? Layer.effect(
            CheckpointStore.CheckpointStore,
            Effect.map(CheckpointStore.CheckpointStore, (store) =>
              CheckpointStore.CheckpointStore.of({
                ...store,
                captureCheckpoint: (input) => {
                  if (!input.checkpointRef.startsWith(`${RECOVERY_REFS_PREFIX}/`)) {
                    return store.captureCheckpoint(input);
                  }
                  if (options?.failRecoveryCapture === true) {
                    return Effect.fail(
                      new VcsProcessExitError({
                        operation: "CheckpointReactor.test.captureRecovery",
                        command: "git update-ref",
                        cwd: input.cwd,
                        exitCode: 1,
                        detail: "simulated recovery capture failure",
                      }),
                    );
                  }
                  const gate = options?.recoveryCaptureGate;
                  if (gate !== undefined) {
                    return Effect.promise(async () => {
                      gate.markStarted();
                      await gate.release;
                    }).pipe(Effect.andThen(store.captureCheckpoint(input)));
                  }
                  return store.captureCheckpoint(input);
                },
              }),
            ),
          ).pipe(Layer.provide(checkpointStoreBaseLayer))
        : checkpointStoreBaseLayer;

    const vcsProcessBaseLayer = VcsProcess.layer;
    const vcsProcessLayer = options?.truncateIgnoredEnumeration
      ? Layer.effect(
          VcsProcess.VcsProcess,
          Effect.map(VcsProcess.VcsProcess, (base) =>
            VcsProcess.VcsProcess.of({
              run: (input) => {
                const isIgnoredEnumeration =
                  input.command === "git" &&
                  input.args.includes("ls-files") &&
                  input.args.includes("--ignored");
                return base
                  .run(input)
                  .pipe(
                    Effect.map((output) =>
                      isIgnoredEnumeration
                        ? { ...output, stdout: "", stdoutTruncated: true }
                        : output,
                    ),
                  );
              },
            }),
          ),
        ).pipe(Layer.provide(vcsProcessBaseLayer))
      : vcsProcessBaseLayer;

    const liveLayer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(vcsProcessLayer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(WorktreeRemovalLeaseLive),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = options?.fixedClock
      ? liveLayer.pipe(Layer.provideMerge(TestClock.layer()))
      : liveLayer;

    const managedRuntime = ManagedRuntime.make(layer);
    runtime = managedRuntime;
    const engine = await managedRuntime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await managedRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await managedRuntime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await managedRuntime.runPromise(
      Effect.service(CheckpointStore.CheckpointStore),
    );
    const harnessScope = await Effect.runPromise(Scope.make("sequential"));
    scope = harnessScope;
    await Effect.runPromise(reactor.start().pipe(Scope.provide(harnessScope)));
    const drain = () => Effect.runPromise(reactor.drain);
    let disposed = false;
    const dispose = async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      await managedRuntime.runPromise(Scope.close(harnessScope, Exit.void)).catch(() => undefined);
      await managedRuntime.dispose();
      if (scope === harnessScope) {
        scope = null;
      }
      if (runtime === managedRuntime) {
        runtime = null;
      }
    };

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: options?.threadBranch ?? null,
          worktreePath: options?.threadWorktreePath ?? cwd,
          createdAt,
        })
        .pipe(
          options?.secondThreadSharingWorktree
            ? Effect.andThen(
                engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("cmd-thread-create-2"),
                  threadId: ThreadId.make("thread-2"),
                  projectId: asProjectId("project-1"),
                  title: "Thread 2",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5-codex",
                  },
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  runtimeMode: "approval-required",
                  branch: null,
                  worktreePath: options?.threadWorktreePath ?? cwd,
                  createdAt,
                }),
              )
            : Effect.asVoid,
        ),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      runPromise: <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
        managedRuntime.runPromise(effect),
      provider,
      checkpointStore,
      cwd,
      drain,
      dispose,
    };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("adopts a drifted checkout as the thread branch on a dedicated worktree", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "neokod/original-branch",
      localStatusRefName: "neokod/renamed-by-agent",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.meta-updated" &&
        (event as unknown as { payload: { branch?: string } }).payload.branch ===
          "neokod/renamed-by-agent",
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("neokod/renamed-by-agent");
  });

  it("does not adopt a drifted checkout when the worktree is shared by another thread", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "neokod/original-branch",
      localStatusRefName: "neokod/renamed-by-agent",
      secondThreadSharingWorktree: true,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-shared"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("neokod/original-branch");
  });

  it("does not adopt a temporary placeholder checkout as the thread branch", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "neokod/original-branch",
      localStatusRefName: "neokod/0a1b2c3d",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-temp"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-temp"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("neokod/original-branch");
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-baseline"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "neokod-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-no-session"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("saves the current files to a recovery ref before reverting", async () => {
    const harness = await createHarness();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v4-unsaved\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "scratch.txt"), "mine\n", "utf8");

    await revertToTurnOne(harness);
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.recovery-saved"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(NodeFS.existsSync(NodePath.join(harness.cwd, "scratch.txt"))).toBe(false);

    const recoveryRefs = listRecoveryRefs(harness.cwd);
    expect(recoveryRefs).toHaveLength(1);
    const recoveryRef = recoveryRefs[0]!;
    expect(recoveryRef.startsWith(`${RECOVERY_REFS_PREFIX}/`)).toBe(true);
    expect(gitShowFileAtRef(harness.cwd, recoveryRef, "README.md")).toBe("v4-unsaved\n");
    expect(gitShowFileAtRef(harness.cwd, recoveryRef, "scratch.txt")).toBe("mine\n");

    const recoveryActivity = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.recovery-saved",
    );
    expect(recoveryActivity?.turnId).toBeNull();
    expect(recoveryActivity?.payload).toEqual({
      turnCount: 1,
      recoveryRef,
      cwd: harness.cwd,
    });

    // Stale checkpoint cleanup removes the newer turn ref but keeps the recovery ref.
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
    expect(gitRefExists(harness.cwd, recoveryRef)).toBe(true);
  });

  for (const status of ["running", "connecting"] as const) {
    it(`refuses to revert while another thread is ${status} in the same folder`, async () => {
      const harness = await createHarness({
        secondThreadSharingWorktree: true,
        otherSessions: [{ threadId: "thread-2", status }],
      });

      await revertToTurnOne(harness);
      const thread = await waitForThread(harness.readModel, (entry) =>
        entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
      );

      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      expect(listRecoveryRefs(harness.cwd)).toEqual([]);
      expect(thread.checkpoints).toHaveLength(2);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
      ).toBe(true);

      const failure = thread.activities.find(
        (activity) => activity.kind === "checkpoint.revert.failed",
      );
      const payload = failure?.payload as { readonly detail?: string } | undefined;
      expect(payload?.detail).toContain("thread-2");
      expect(payload?.detail).toContain("Nothing was changed");
    });
  }

  it("refuses when a ready session has an active turn in the same folder", async () => {
    const harness = await createHarness({
      otherSessions: [{ threadId: "thread-2", status: "ready", activeTurnId: "turn-busy" }],
    });

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("refuses when the reverting thread's own session has an active turn", async () => {
    const harness = await createHarness({ ownSessionActiveTurnId: "turn-own-busy" });

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("refuses when the read model records an active turn the session list omits", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await revertToTurnOne(harness, {
      beforeRevert: () =>
        harness.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-read-model-busy-session"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: asTurnId("turn-read-model-busy"),
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
    });
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("refuses a revert when another shared-folder turn was admitted first", async () => {
    const harness = await createHarness({ secondThreadSharingWorktree: true });

    await harness.runPromise(
      harness.engine.dispatch(
        threadTurnStartCommand({
          threadId: "thread-2",
          commandId: "cmd-turn-start-admitted-first",
          messageId: "message-turn-start-admitted-first",
        }),
      ),
    );

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);

    const events = await harness.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    expect(
      events.some(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.payload.threadId === ThreadId.make("thread-2"),
      ),
    ).toBe(true);
  });

  it("refuses a subfolder revert when a turn is admitted in its parent workspace", async () => {
    const harness = await createHarness({
      providerSessionSubdirectory: "sub",
      prepareRepository: (repository) => {
        NodeFS.mkdirSync(NodePath.join(repository, "sub"), { recursive: true });
      },
      secondThreadSharingWorktree: true,
    });
    const sub = NodePath.join(harness.cwd, "sub");
    NodeFS.writeFileSync(NodePath.join(sub, "keep.txt"), "keep parent overlap\n", "utf8");

    await harness.runPromise(
      harness.engine.dispatch(
        threadTurnStartCommand({
          threadId: "thread-2",
          commandId: "cmd-turn-start-parent-admitted-first",
          messageId: "message-turn-start-parent-admitted-first",
        }),
      ),
    );

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(sub, "keep.txt"), "utf8")).toBe(
      "keep parent overlap\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("blocks a new overlapping turn while a revert reservation is held", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await createHarness({
      secondThreadSharingWorktree: true,
      recoveryCaptureGate: {
        markStarted: () => started.resolve(),
        release: release.promise,
      },
    });

    await revertToTurnOne(harness);
    await started.promise;
    try {
      const outcome = await harness.runPromise(
        Effect.exit(
          harness.engine.dispatch(
            threadTurnStartCommand({
              threadId: "thread-2",
              commandId: "cmd-turn-start-blocked-by-reservation",
              messageId: "message-turn-start-blocked-by-reservation",
            }),
          ),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
    } finally {
      release.resolve();
    }

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const events = await harness.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    expect(
      events.some(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.payload.threadId === ThreadId.make("thread-2"),
      ),
    ).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(listRecoveryRefs(harness.cwd)).toHaveLength(1);
  });

  it("refuses a revert when a pending thread moved out of the shared folder", async () => {
    const harness = await createHarness({ secondThreadSharingWorktree: true });
    const moveTarget = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "neokod-pending-thread-move-"),
    );
    tempDirs.push(moveTarget);

    await harness.runPromise(
      harness.engine.dispatch(
        threadTurnStartCommand({
          threadId: "thread-2",
          commandId: "cmd-turn-start-before-workspace-move",
          messageId: "message-turn-start-before-workspace-move",
        }),
      ),
    );

    await harness.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-move-pending-thread-2"),
        threadId: ThreadId.make("thread-2"),
        worktreePath: moveTarget,
      }),
    );
    const movedReadModel = await harness.readModel();
    expect(
      movedReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-2"))?.worktreePath,
    ).toBe(moveTarget);

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("refuses a revert when a project root moved away from a pending admission", async () => {
    const harness = await createHarness({ secondThreadSharingWorktree: true });
    const projectRootTarget = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "neokod-pending-project-root-"),
    );
    tempDirs.push(projectRootTarget);

    // Make thread-2 inherit the project workspace root instead of its own worktree.
    await harness.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-2-inherit-project-root"),
        threadId: ThreadId.make("thread-2"),
        worktreePath: null,
      }),
    );

    await harness.runPromise(
      harness.engine.dispatch(
        threadTurnStartCommand({
          threadId: "thread-2",
          commandId: "cmd-turn-start-before-project-root-move",
          messageId: "message-turn-start-before-project-root-move",
        }),
      ),
    );

    await harness.runPromise(
      harness.engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-move-pending-project-root"),
        projectId: asProjectId("project-1"),
        workspaceRoot: projectRootTarget,
      }),
    );

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("refuses a revert when an archived thread has an admitted turn", async () => {
    const harness = await createHarness({ secondThreadSharingWorktree: true });

    await harness.runPromise(
      harness.engine.dispatch(
        threadTurnStartCommand({
          threadId: "thread-2",
          commandId: "cmd-turn-start-archived",
          messageId: "message-turn-start-archived",
        }),
      ),
    );
    await harness.runPromise(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-archive-thread-2-busy"),
        threadId: ThreadId.make("thread-2"),
      }),
    );

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("allows a revert after a rejected provider start settles its pending turn", async () => {
    const harness = await createHarness({ secondThreadSharingWorktree: true });
    const messageId = "message-turn-start-rejected";

    await harness.runPromise(
      harness.engine.dispatch(
        threadTurnStartCommand({
          threadId: "thread-2",
          commandId: "cmd-turn-start-rejected",
          messageId,
        }),
      ),
    );
    await harness.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-provider-turn-start-failed"),
        threadId: ThreadId.make("thread-2"),
        activity: {
          id: EventId.make("activity-provider-turn-start-failed"),
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          payload: { messageId, detail: "provider unavailable" },
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await revertToTurnOne(harness);
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(listRecoveryRefs(harness.cwd)).toHaveLength(1);
  });

  it("refuses when a currently ignored file would be lost by the checkpoint's ignore rules", async () => {
    const harness = await createHarness();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "scratch.dat\n", "utf8");
    NodeFS.writeFileSync(
      NodePath.join(harness.cwd, "scratch.dat"),
      "keep this ignored file\n",
      "utf8",
    );

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "scratch.dat"), "utf8")).toBe(
      "keep this ignored file\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("scratch.dat");
    expect(payload?.detail?.toLowerCase()).toContain("ignored");
    expect(payload?.detail).toContain("Nothing was changed");
  });

  it("allows a revert when the checkpoint keeps the ignored file ignored", async () => {
    const harness = await createHarness();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "scratch.dat\n", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "scratch.dat"), "keep me\n", "utf8");

    await revertToTurnOne(harness);
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "scratch.dat"), "utf8")).toBe(
      "keep me\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, ".gitignore"), "utf8")).toBe(
      "scratch.dat\n",
    );
    expect(listRecoveryRefs(harness.cwd)).toHaveLength(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
  });

  it("refuses a subfolder revert when only the restored sub/.gitignore changes", async () => {
    const harness = await createHarness({
      providerSessionSubdirectory: "sub",
      prepareRepository: (repository) => {
        NodeFS.mkdirSync(NodePath.join(repository, "sub"), { recursive: true });
      },
    });
    const sub = NodePath.join(harness.cwd, "sub");
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "/sub/scratch.dat\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(sub, ".gitignore"), "", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "", "utf8");
    NodeFS.writeFileSync(NodePath.join(sub, ".gitignore"), "scratch.dat\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(sub, "scratch.dat"), "keep sub file\n", "utf8");

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(sub, "scratch.dat"), "utf8")).toBe("keep sub file\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("scratch.dat");
  });

  it("allows a subfolder revert when only an ancestor ignore rule changed", async () => {
    const harness = await createHarness({
      providerSessionSubdirectory: "sub",
      prepareRepository: (repository) => {
        NodeFS.mkdirSync(NodePath.join(repository, "sub"), { recursive: true });
      },
    });
    const sub = NodePath.join(harness.cwd, "sub");
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "", "utf8");
    NodeFS.writeFileSync(NodePath.join(sub, ".gitignore"), "", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "/sub/scratch.dat\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(sub, "scratch.dat"), "keep sub file\n", "utf8");

    await revertToTurnOne(harness);
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");

    expect(NodeFS.readFileSync(NodePath.join(sub, "scratch.dat"), "utf8")).toBe("keep sub file\n");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(listRecoveryRefs(harness.cwd)).toHaveLength(1);
  });

  it("refuses when ignored-file enumeration output is truncated", async () => {
    const harness = await createHarness({ truncateIgnoredEnumeration: true });
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "scratch.dat\n", "utf8");
    NodeFS.writeFileSync(
      NodePath.join(harness.cwd, "scratch.dat"),
      "keep truncated file\n",
      "utf8",
    );

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "scratch.dat"), "utf8")).toBe(
      "keep truncated file\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("truncated");
  });

  it("refuses when a tracked checkpoint entry collides with an ignored file", async () => {
    const harness = await createHarness();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "config.local\n", "utf8");
    NodeFS.writeFileSync(
      NodePath.join(harness.cwd, "config.local"),
      "checkpoint content\n",
      "utf8",
    );
    runGit(harness.cwd, ["add", "-f", "config.local"]);
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    runGit(harness.cwd, ["rm", "--cached", "config.local"]);
    NodeFS.writeFileSync(
      NodePath.join(harness.cwd, "config.local"),
      "current ignored content\n",
      "utf8",
    );

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "config.local"), "utf8")).toBe(
      "current ignored content\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("config.local");
    expect(payload?.detail).toContain("tracked");
  });

  it("refuses when an ignored path differs only by case from a tracked checkpoint entry", async () => {
    const harness = await createHarness();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "config.local\n", "utf8");
    NodeFS.writeFileSync(
      NodePath.join(harness.cwd, "Config.local"),
      "checkpoint content\n",
      "utf8",
    );
    runGit(harness.cwd, ["add", "-f", "Config.local"]);
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    runGit(harness.cwd, ["rm", "--cached", "Config.local"]);
    const original = NodePath.join(harness.cwd, "Config.local");
    const intermediate = NodePath.join(harness.cwd, ".config-local-case-rename");
    const current = NodePath.join(harness.cwd, "config.local");
    NodeFS.renameSync(original, intermediate);
    NodeFS.renameSync(intermediate, current);
    NodeFS.writeFileSync(current, "current ignored content\n", "utf8");

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(current, "utf8")).toBe("current ignored content\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("config.local");
  });

  it("refuses a subfolder revert when the folder name starts with a space", async () => {
    const harness = await createHarness({
      providerSessionSubdirectory: " sub",
      prepareRepository: (repository) => {
        NodeFS.mkdirSync(NodePath.join(repository, " sub"), { recursive: true });
      },
    });
    const sub = NodePath.join(harness.cwd, " sub");
    NodeFS.writeFileSync(NodePath.join(sub, ".gitignore"), "", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(sub, ".gitignore"), "scratch.dat\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(sub, "scratch.dat"), "keep spaced sub file\n", "utf8");

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(sub, "scratch.dat"), "utf8")).toBe(
      "keep spaced sub file\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("scratch.dat");
  });

  it("refuses a subfolder revert when the folder name looks like pathspec magic", async () => {
    // oxlint-disable-next-line neokod/no-global-process-runtime -- This path name is not valid on Windows.
    if (process.platform === "win32") {
      return;
    }
    const harness = await createHarness({
      providerSessionSubdirectory: ":(literal)sub",
      prepareRepository: (repository) => {
        NodeFS.mkdirSync(NodePath.join(repository, ":(literal)sub"), { recursive: true });
      },
    });
    const sub = NodePath.join(harness.cwd, ":(literal)sub");
    NodeFS.writeFileSync(NodePath.join(sub, ".gitignore"), "", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(sub, ".gitignore"), "scratch.dat\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(sub, "scratch.dat"), "keep magic sub file\n", "utf8");

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(sub, "scratch.dat"), "utf8")).toBe(
      "keep magic sub file\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
  });

  it("refuses when only a mixed-case .GitIgnore rule changes", async () => {
    const harness = await createHarness();
    // info/exclude guarantees an ignored entry on case-sensitive hosts; the
    // mixed-case rule file is still the changed rule under test.
    NodeFS.writeFileSync(
      NodePath.join(harness.cwd, ".git", "info", "exclude"),
      "scratch.dat\n",
      "utf8",
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".GitIgnore"), "", "utf8");
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".GitIgnore"), "scratch.dat\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "scratch.dat"), "keep mixed case\n", "utf8");

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "scratch.dat"), "utf8")).toBe(
      "keep mixed case\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("scratch.dat");
  });

  it("refuses when the checkpoint's .gitignore is a symlink", async () => {
    const harness = await createHarness();
    NodeFS.symlinkSync("scratch.dat", NodePath.join(harness.cwd, ".gitignore"));
    await harness.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );
    NodeFS.unlinkSync(NodePath.join(harness.cwd, ".gitignore"));
    NodeFS.writeFileSync(NodePath.join(harness.cwd, ".gitignore"), "scratch.dat\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "scratch.dat"), "keep symlink file\n", "utf8");

    await revertToTurnOne(harness);
    await waitForRevertOutcome(harness.engine);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "scratch.dat"), "utf8")).toBe(
      "keep symlink file\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain(".gitignore");
  });

  it("does not refuse for a ready session or a running session in another folder", async () => {
    const harness = await createHarness({
      otherSessions: [
        { threadId: "thread-2", status: "ready" },
        { threadId: "thread-3", status: "running", cwd: "/somewhere/else" },
      ],
    });

    await revertToTurnOne(harness);
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(listRecoveryRefs(harness.cwd)).toHaveLength(1);
  });

  it("refuses without restoring when the recovery capture fails", async () => {
    const harness = await createHarness({ failRecoveryCapture: true });
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v4-unsaved\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "scratch.txt"), "mine\n", "utf8");

    await revertToTurnOne(harness);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(
      "v4-unsaved\n",
    );
    expect(NodeFS.existsSync(NodePath.join(harness.cwd, "scratch.txt"))).toBe(true);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(true);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("could not be saved");
    expect(payload?.detail).toContain("nothing was changed");

    await harness.drain();
    const events = await harness.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    expect(events.some((event) => event.type === "thread.reverted")).toBe(false);
  });

  it("refuses when the provider session list cannot be read", async () => {
    const harness = await createHarness({ listSessionsFailure: true });

    await revertToTurnOne(harness);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(listRecoveryRefs(harness.cwd)).toEqual([]);
    expect(thread.checkpoints).toHaveLength(2);

    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { readonly detail?: string } | undefined;
    expect(payload?.detail).toContain("could not be read");
  });

  it("keeps a distinct recovery ref for each serial revert when the clock does not advance", async () => {
    const harness = await createHarness({ fixedClock: true });

    await revertToTurnOne(harness);
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    await waitForThread(harness.readModel, (entry) => entry.checkpoints.length === 1);

    await harness.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-helper-request-second"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await waitForThread(harness.readModel, (entry) => entry.checkpoints.length === 0);

    const recoveryRefs = listRecoveryRefs(harness.cwd);
    expect(recoveryRefs).toHaveLength(2);
    expect(new Set(recoveryRefs).size).toBe(2);
    const suffixes = recoveryRefs
      .map((ref) => Number((ref.split("/").at(-1) ?? "").split("-")[0]))
      .toSorted((left, right) => left - right);
    expect(suffixes[1]).toBe((suffixes[0] ?? 0) + 1);
    expect(
      recoveryRefs.map((ref) => gitShowFileAtRef(harness.cwd, ref, "README.md")).toSorted(),
    ).toEqual(["v2\n", "v3\n"]);
  });

  it("keeps recovery refs unique across reactor restarts", async () => {
    const first = await createHarness({ fixedClock: true });
    await revertToTurnOne(first);
    await waitForEvent(first.engine, (event) => event.type === "thread.reverted");
    const firstRecoveryRefs = listRecoveryRefs(first.cwd);
    expect(firstRecoveryRefs).toHaveLength(1);
    expect(gitShowFileAtRef(first.cwd, firstRecoveryRefs[0]!, "README.md")).toBe("v3\n");
    await first.dispose();

    const second = await createHarness({ fixedClock: true, repositoryCwd: first.cwd });
    NodeFS.writeFileSync(NodePath.join(second.cwd, "README.md"), "v4-second\n", "utf8");
    await revertToTurnOne(second);
    await waitForEvent(second.engine, (event) => event.type === "thread.reverted");

    const recoveryRefs = listRecoveryRefs(second.cwd);
    expect(recoveryRefs).toHaveLength(2);
    expect(new Set(recoveryRefs).size).toBe(2);
    expect(
      recoveryRefs.map((ref) => gitShowFileAtRef(second.cwd, ref, "README.md")).toSorted(),
    ).toEqual(["v3\n", "v4-second\n"]);
  });
});
