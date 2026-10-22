import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  OrchestrationReadModel,
  type OrchestrationCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  HOST_LOST_SESSION_ERROR,
  planProviderSessionReconciliation,
  ProviderSessionReconciler,
} from "./ProviderSessionReconciler.ts";
import { orphanPossible, stopFailed, stoppedConfirmed } from "../providerStopOutcome.ts";
import { ProviderSessionReconcilerLive } from "../Layers/ProviderSessionReconciler.ts";

const emptyPendingStartsLayer = Layer.succeed(ProjectionTurnRepository, {
  listPendingTurnStarts: () => Effect.succeed([]),
} as unknown as ProjectionTurnRepository["Service"]);

const threadId = ThreadId.make("thread-reconcile");
const turnId = TurnId.make("turn-reconcile");
const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project-reconcile");
const provider = ProviderDriverKind.make("codex");
const now = "2026-07-27T00:00:00.000Z";

type ReconciledThread = OrchestrationReadModel["threads"][number];

const activityAt = (
  id: string,
  turnIdValue: TurnId,
  createdAt: string,
): ReconciledThread["activities"][number] => ({
  id: EventId.make(id),
  tone: "tool",
  kind: "tool.completed",
  summary: "Ran command",
  payload: {},
  turnId: turnIdValue,
  createdAt,
});

const projected = (input?: {
  readonly sessionStatus?: "running" | "starting" | "interrupted";
  readonly turnState?: "running" | "completed" | "interrupted" | "error";
  readonly completedAt?: string | null;
  readonly activeTurnId?: TurnId | null;
  readonly lastError?: string | null;
  readonly startedAt?: string;
  readonly messages?: ReconciledThread["messages"];
  readonly activities?: ReconciledThread["activities"];
}): OrchestrationReadModel => {
  const turnState = input?.turnState ?? "running";
  const startedAt = input?.startedAt ?? now;
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId,
        title: "Reconcile",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: input?.messages ?? [],
        proposedPlans: [],
        activities: input?.activities ?? [],
        checkpoints: [],
        latestTurn: {
          turnId,
          state: turnState,
          requestedAt: startedAt,
          startedAt,
          completedAt:
            input?.completedAt === undefined
              ? turnState === "running"
                ? null
                : now
              : input.completedAt,
          assistantMessageId: null,
        },
        session: {
          threadId,
          status: input?.sessionStatus ?? "running",
          providerName: provider,
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: input?.activeTurnId === undefined ? turnId : input.activeTurnId,
          lastError: input?.lastError ?? null,
          updatedAt: now,
        },
      },
    ],
  } as unknown as OrchestrationReadModel;
};

const stoppedBinding = (
  runtimePayload: unknown = { activeTurnId: null },
): ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata => ({
  threadId,
  provider,
  providerInstanceId,
  status: "stopped" as const,
  runtimePayload,
  lastSeenAt: "2026-07-26T23:50:00.000Z",
});

const providerSession = {
  provider,
  providerInstanceId,
  status: "ready" as const,
  runtimeMode: "full-access" as const,
  threadId,
  activeTurnId: undefined,
  createdAt: now,
  updatedAt: now,
};

it("plans one interrupted settlement only for an authoritative stopped binding", () => {
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected({ startedAt: "2026-07-26T23:40:00.000Z" }),
      liveSessions: [],
      bindings: [
        stoppedBinding({
          activeTurnId: null,
          stopPhase: "settled",
          stopOutcome: stoppedConfirmed("2026-07-26T23:50:00.000Z"),
        }),
      ],
    }),
    [
      {
        threadId,
        turnId,
        providerName: provider,
        providerInstanceId,
        runtimeMode: "full-access",
        status: "interrupted",
        lastError: null,
        lastObservedAt: "2026-07-26T23:50:00.000Z",
      },
    ],
  );
});

it("plans terminal-turn settlement without requiring a stopped binding", () => {
  for (const [turnState, status] of [
    ["completed", "ready"],
    ["interrupted", "interrupted"],
    ["error", "error"],
  ] as const) {
    assert.deepStrictEqual(
      planProviderSessionReconciliation({
        projected: projected({ turnState }),
        liveSessions: [providerSession],
        bindings: [{ ...stoppedBinding(), status: "running" as const }],
      }),
      [
        {
          threadId,
          turnId,
          providerName: provider,
          providerInstanceId,
          runtimeMode: "full-access",
          status,
          lastError: null,
        },
      ],
    );
  }
});

it("keeps the session's existing error when settling a failed terminal turn", () => {
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected({ turnState: "error", lastError: "quota exceeded" }),
      liveSessions: [providerSession],
      bindings: [{ ...stoppedBinding(), status: "running" as const }],
    }),
    [
      {
        threadId,
        turnId,
        providerName: provider,
        providerInstanceId,
        runtimeMode: "full-access",
        status: "error",
        lastError: "quota exceeded",
      },
    ],
  );
});

it("clears a stale error when a terminal turn settles the session ready", () => {
  // An error survives into later turns: ingestion only clears it on `ready`.
  // Settling a completed turn must clear it too, or a thread that recovered
  // keeps showing a banner from a failure it already moved past.
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected({ turnState: "completed", lastError: "quota exceeded" }),
      liveSessions: [providerSession],
      bindings: [{ ...stoppedBinding(), status: "running" as const }],
    }),
    [
      {
        threadId,
        turnId,
        providerName: provider,
        providerInstanceId,
        runtimeMode: "full-access",
        status: "ready",
        lastError: null,
      },
    ],
  );
});

it("preserves only an error tied to the exact projected turn", () => {
  const action = planProviderSessionReconciliation({
    projected: projected(),
    liveSessions: [],
    bindings: [
      stoppedBinding({
        activeTurnId: turnId,
        lastError: "provider process exited",
      }),
    ],
  })[0];

  assert.equal(action?.lastError, "provider process exited");
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected(),
      liveSessions: [],
      bindings: [
        stoppedBinding({
          activeTurnId: "another-turn",
          lastError: "belongs to another turn",
        }),
      ],
    })[0]?.lastError,
    null,
  );
});

it("plans a host_lost settlement for a running or starting binding with no live session", () => {
  for (const status of ["running", "starting"] as const) {
    assert.deepStrictEqual(
      planProviderSessionReconciliation({
        projected: projected(),
        liveSessions: [],
        bindings: [{ ...stoppedBinding(), status }],
      }),
      [
        {
          threadId,
          turnId,
          providerName: provider,
          providerInstanceId,
          runtimeMode: "full-access",
          status: "interrupted",
          lastError: HOST_LOST_SESSION_ERROR,
          bindingSettlement: "host_lost",
          // The binding was written when the turn started (23:50), before the
          // turn's 00:00 start, so it is not completion evidence.
          lastObservedAt: null,
        },
      ],
    );
  }
});

it("freezes a recovered turn at its latest turn-scoped observation", () => {
  const action = planProviderSessionReconciliation({
    projected: projected({
      startedAt: "2026-07-26T23:40:00.000Z",
      activities: [
        activityAt("older-observation", turnId, "2026-07-26T23:45:00.000Z"),
        activityAt("latest-observation", turnId, "2026-07-26T23:58:00.000Z"),
      ],
      messages: [
        {
          id: MessageId.make("streaming-assistant-message"),
          role: "assistant",
          text: "still working",
          turnId,
          streaming: true,
          createdAt: "2026-07-26T23:50:00.000Z",
          updatedAt: "2026-07-26T23:59:00.000Z",
        },
      ],
    }),
    liveSessions: [],
    bindings: [{ ...stoppedBinding(), status: "running" as const }],
  })[0];

  // The latest turn-scoped row wins across messages and activities.
  assert.equal(action?.lastObservedAt, "2026-07-26T23:59:00.000Z");
});

it("does not let a persisted host_lost stop time override later turn evidence", () => {
  const action = planProviderSessionReconciliation({
    projected: projected({
      startedAt: "2026-07-26T23:40:00.000Z",
      messages: [
        {
          id: MessageId.make("streamed-assistant-message"),
          role: "assistant",
          text: "still working",
          turnId,
          streaming: true,
          createdAt: "2026-07-26T23:50:00.000Z",
          updatedAt: "2026-07-26T23:58:00.000Z",
        },
      ],
    }),
    liveSessions: [],
    bindings: [
      {
        ...stoppedBinding({
          activeTurnId: null,
          stopPhase: "settled",
          // The first recovery wrote the binding's turn-start write as the
          // host-loss observation, then crashed before the session dispatch.
          stopOutcome: orphanPossible({
            stoppedAt: "2026-07-26T23:41:00.000Z",
            reason: "host_lost",
          }),
        }),
        status: "error" as const,
      },
    ],
  })[0];

  // Host-loss stop evidence is binding state, not turn completion.
  assert.equal(action?.lastObservedAt, "2026-07-26T23:58:00.000Z");
});

it("ignores observations before the turn start and keeps completion unknown", () => {
  const action = planProviderSessionReconciliation({
    projected: projected({
      startedAt: "2026-07-26T23:40:00.000Z",
      activities: [activityAt("stale-observation", turnId, "2026-07-26T23:39:00.000Z")],
    }),
    liveSessions: [],
    bindings: [
      {
        ...stoppedBinding({
          activeTurnId: null,
          stopPhase: "settled",
          stopOutcome: stopFailed("process_group_termination_failed", "group remained alive"),
        }),
        status: "error" as const,
      },
    ],
  })[0];

  assert.equal(action?.lastObservedAt, null);
});

it("keeps a host_lost warning when the binding survived but the session dispatch did not", () => {
  const action = planProviderSessionReconciliation({
    projected: projected({ startedAt: "2026-07-26T23:40:00.000Z" }),
    liveSessions: [],
    bindings: [
      {
        ...stoppedBinding({
          activeTurnId: null,
          stopPhase: "settled",
          stopOutcome: orphanPossible({
            stoppedAt: "2026-07-26T23:59:00.000Z",
            reason: "host_lost",
          }),
        }),
        status: "error" as const,
      },
    ],
  })[0];

  assert.equal(action?.status, "interrupted");
  assert.equal(action?.lastError, HOST_LOST_SESSION_ERROR);
  // Host-loss stop evidence is binding state, not current-turn completion.
  // With no turn-scoped row, completion stays explicitly unknown.
  assert.equal(action?.lastObservedAt, null);
  // The binding is already settled; only the missing session update remains.
  assert.equal(action?.bindingSettlement, undefined);
});

it("leaves a running binding alone while a live session exists", () => {
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected(),
      liveSessions: [providerSession],
      bindings: [{ ...stoppedBinding(), status: "running" as const }],
    }),
    [],
  );
});

it("does not settle again once the thread session is interrupted", () => {
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected({ sessionStatus: "interrupted", activeTurnId: null }),
      liveSessions: [],
      bindings: [{ ...stoppedBinding(), status: "error" as const }],
    }),
    [],
  );
});

it("skips live, starting and missing bindings", () => {
  const cases = [
    { projected: projected(), liveSessions: [providerSession], bindings: [stoppedBinding()] },
    {
      projected: projected({ sessionStatus: "starting" }),
      liveSessions: [],
      bindings: [stoppedBinding()],
    },
    { projected: projected(), liveSessions: [], bindings: [] },
  ];

  for (const input of cases) {
    assert.deepStrictEqual(planProviderSessionReconciliation(input), []);
  }
  assert.equal(
    planProviderSessionReconciliation({
      projected: projected(),
      liveSessions: [],
      bindings: [stoppedBinding()],
    }).length,
    1,
  );
});

it("recovers an interrupted turn with unknown completion through the host-loss path", () => {
  const runningBinding = { ...stoppedBinding(), status: "running" as const };

  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected({ turnState: "interrupted", completedAt: null }),
      liveSessions: [],
      bindings: [runningBinding],
    }),
    [
      {
        threadId,
        turnId,
        providerName: provider,
        providerInstanceId,
        runtimeMode: "full-access",
        status: "interrupted",
        lastError: HOST_LOST_SESSION_ERROR,
        bindingSettlement: "host_lost",
        lastObservedAt: null,
      },
    ],
  );

  // A live session still owns the turn: recovery must not touch it.
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected({ turnState: "interrupted", completedAt: null }),
      liveSessions: [providerSession],
      bindings: [runningBinding],
    }),
    [],
  );

  // A previous boot already recorded the host-loss binding; only the session
  // still needs repair, and completion stays unknown.
  assert.deepStrictEqual(
    planProviderSessionReconciliation({
      projected: projected({ turnState: "interrupted", completedAt: null }),
      liveSessions: [],
      bindings: [stoppedBinding()],
    }),
    [
      {
        threadId,
        turnId,
        providerName: provider,
        providerInstanceId,
        runtimeMode: "full-access",
        status: "interrupted",
        lastError: null,
        lastObservedAt: null,
      },
    ],
  );
});

it.effect("dispatches terminal-turn settlement as a thread.session.set command", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const layer = ProviderSessionReconcilerLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(projected({ turnState: "interrupted" })),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getSnapshot: () => Effect.die("getSnapshot must not be used by boot reconciliation"),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) => {
            commands.push(command);
            return Effect.succeed({ sequence: 2 });
          },
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
          listBindings: () => Effect.succeed([stoppedBinding()]),
        } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderService.ProviderService, {
          listSessions: () => Effect.succeed([]),
        } as unknown as ProviderService.ProviderService["Service"]),
      ),
      Layer.provideMerge(emptyPendingStartsLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const reconciler = yield* ProviderSessionReconciler.pipe(Effect.provide(layer));
    yield* reconciler.reconcile;
    const command = commands[0];
    assert.equal(command?.type, "thread.session.set");
    if (command?.type !== "thread.session.set") return;
    assert.equal(command.session.status, "interrupted");
    assert.equal(command.session.activeTurnId, null);
  }),
);

it.effect("settles a crashed running binding before dispatching the session", () =>
  Effect.gen(function* () {
    const order: Array<"binding" | "session"> = [];
    const commands: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const evidenceReadModel = projected({
      startedAt: "2026-07-26T23:40:00.000Z",
    });
    const detailThread = {
      ...evidenceReadModel.threads[0]!,
      activities: [activityAt("runtime-observation", turnId, "2026-07-26T23:58:00.000Z")],
    };
    const layer = ProviderSessionReconcilerLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(evidenceReadModel),
          getThreadDetailById: () => Effect.succeed(Option.some(detailThread)),
          getSnapshot: () => Effect.die("getSnapshot must not be used by boot reconciliation"),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) => {
            order.push("session");
            commands.push(command);
            return Effect.succeed({ sequence: 2 });
          },
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
          listBindings: () =>
            Effect.succeed([
              {
                ...stoppedBinding(),
                status: "running" as const,
                // Written shortly after the turn started; not the turn's end.
                lastSeenAt: "2026-07-26T23:41:00.000Z",
              },
            ]),
          upsert: (binding: ProviderSessionDirectory.ProviderRuntimeBinding) =>
            Effect.sync(() => {
              order.push("binding");
              upserts.push(binding);
            }),
        } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderService.ProviderService, {
          listSessions: () => Effect.succeed([]),
        } as unknown as ProviderService.ProviderService["Service"]),
      ),
      Layer.provideMerge(emptyPendingStartsLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const reconciler = yield* ProviderSessionReconciler.pipe(Effect.provide(layer));
    yield* reconciler.reconcile;

    assert.deepStrictEqual(order, ["binding", "session"]);
    const binding = upserts[0];
    assert.equal(binding?.threadId, threadId);
    assert.equal(binding?.status, "error");
    const runtimePayload = binding?.runtimePayload as
      | {
          readonly activeTurnId?: unknown;
          readonly stopPhase?: unknown;
          readonly stopOutcome?: {
            readonly status?: unknown;
            readonly stoppedAt?: unknown;
            readonly reason?: unknown;
            readonly knownExternalRunIds?: unknown;
          };
        }
      | undefined;
    assert.equal(runtimePayload?.activeTurnId, null);
    assert.equal(runtimePayload?.stopPhase, "settled");
    assert.equal(runtimePayload?.stopOutcome?.status, "orphan_possible");
    // Orphan evidence records the latest turn-scoped observation, not the
    // binding write that happened when the turn started.
    assert.equal(runtimePayload?.stopOutcome?.stoppedAt, "2026-07-26T23:58:00.000Z");
    assert.equal(runtimePayload?.stopOutcome?.reason, "host_lost");
    assert.deepStrictEqual(runtimePayload?.stopOutcome?.knownExternalRunIds, []);

    const command = commands[0];
    assert.equal(command?.type, "thread.session.set");
    if (command?.type !== "thread.session.set") return;
    assert.equal(command.session.status, "interrupted");
    assert.equal(command.session.activeTurnId, null);
    assert.equal(command.session.lastError, HOST_LOST_SESSION_ERROR);
    // The recovery pins the turn it settled so message closure cannot drift to
    // newer work.
    assert.equal(command.interruptedTurnId, turnId);
    // The turn freezes at its latest turn-scoped observation, not the binding
    // write. The session update and event stay on the server clock.
    assert.equal(command.session.updatedAt, command.createdAt);
    assert.equal(command.latestTurnCompletedAt, "2026-07-26T23:58:00.000Z");
    assert.notEqual(command.latestTurnCompletedAt, command.createdAt);
  }),
);

it.effect("dispatches an explicitly unknown completion when no turn observation exists", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const layer = ProviderSessionReconcilerLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.succeed(projected({ startedAt: "2026-07-26T23:40:00.000Z" })),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getSnapshot: () => Effect.die("getSnapshot must not be used by boot reconciliation"),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) => {
            commands.push(command);
            return Effect.succeed({ sequence: 2 });
          },
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
          listBindings: () =>
            Effect.succeed([
              {
                ...stoppedBinding(),
                status: "running" as const,
                lastSeenAt: "2026-07-26T23:38:00.000Z",
              },
            ]),
          upsert: () => Effect.void,
        } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderService.ProviderService, {
          listSessions: () => Effect.succeed([]),
        } as unknown as ProviderService.ProviderService["Service"]),
      ),
      Layer.provideMerge(emptyPendingStartsLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const reconciler = yield* ProviderSessionReconciler.pipe(Effect.provide(layer));
    yield* reconciler.reconcile;

    const command = commands[0];
    assert.equal(command?.type, "thread.session.set");
    if (command?.type !== "thread.session.set") return;
    // Explicit null distinguishes unknown completion from legacy omission.
    assert.equal(command.latestTurnCompletedAt, null);
    assert.equal(command.session.updatedAt, command.createdAt);
  }),
);

it.effect("repairs only the session when the host_lost binding write already survived", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    let upsertCalled = false;
    const settledBinding = {
      ...stoppedBinding({
        activeTurnId: null,
        stopPhase: "settled",
        stopOutcome: orphanPossible({
          stoppedAt: "2026-07-26T23:41:00.000Z",
          reason: "host_lost",
        }),
      }),
      status: "error" as const,
      lastSeenAt: "2026-07-26T23:41:00.000Z",
    };
    const detailThread = {
      ...projected({ startedAt: "2026-07-26T23:40:00.000Z" }).threads[0]!,
      activities: [activityAt("repair-observation", turnId, "2026-07-26T23:58:00.000Z")],
    };
    const layer = ProviderSessionReconcilerLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.succeed(projected({ startedAt: "2026-07-26T23:40:00.000Z" })),
          getThreadDetailById: () => Effect.succeed(Option.some(detailThread)),
          getSnapshot: () => Effect.die("getSnapshot must not be used by boot reconciliation"),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) => {
            commands.push(command);
            return Effect.succeed({ sequence: 2 });
          },
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
          listBindings: () => Effect.succeed([settledBinding]),
          upsert: () =>
            Effect.sync(() => {
              upsertCalled = true;
            }),
        } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderService.ProviderService, {
          listSessions: () => Effect.succeed([]),
        } as unknown as ProviderService.ProviderService["Service"]),
      ),
      Layer.provideMerge(emptyPendingStartsLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const reconciler = yield* ProviderSessionReconciler.pipe(Effect.provide(layer));
    yield* reconciler.reconcile;

    // A repeated boot must not rewrite settled evidence, but it must still
    // repair the session update that the previous boot crashed before sending.
    assert.equal(upsertCalled, false);
    const command = commands[0];
    assert.equal(command?.type, "thread.session.set");
    if (command?.type !== "thread.session.set") return;
    assert.equal(command.session.status, "interrupted");
    assert.equal(command.session.lastError, HOST_LOST_SESSION_ERROR);
    // The later turn-scoped observation ends the turn, not the stale host-loss
    // stop timestamp or this boot's clock.
    assert.equal(command.session.updatedAt, command.createdAt);
    assert.equal(command.latestTurnCompletedAt, "2026-07-26T23:58:00.000Z");
    assert.notEqual(command.latestTurnCompletedAt, command.createdAt);
  }),
);
