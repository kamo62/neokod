import * as NodeServices from "@effect/platform-node/NodeServices";
import {
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

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import {
  HOST_LOST_SESSION_ERROR,
  planProviderSessionReconciliation,
  ProviderSessionReconciler,
} from "./ProviderSessionReconciler.ts";
import { orphanPossible } from "../providerStopOutcome.ts";
import { ProviderSessionReconcilerLive } from "../Layers/ProviderSessionReconciler.ts";

const threadId = ThreadId.make("thread-reconcile");
const turnId = TurnId.make("turn-reconcile");
const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project-reconcile");
const provider = ProviderDriverKind.make("codex");
const now = "2026-07-27T00:00:00.000Z";

const projected = (input?: {
  readonly sessionStatus?: "running" | "starting" | "interrupted";
  readonly turnState?: "running" | "completed" | "interrupted" | "error";
  readonly completedAt?: string | null;
  readonly activeTurnId?: TurnId | null;
  readonly lastError?: string | null;
}): OrchestrationReadModel => {
  const turnState = input?.turnState ?? "running";
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
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        latestTurn: {
          turnId,
          state: turnState,
          requestedAt: now,
          startedAt: now,
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
      projected: projected(),
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
          lastObservedAt: "2026-07-26T23:50:00.000Z",
        },
      ],
    );
  }
});

it("keeps a host_lost warning when the binding survived but the session dispatch did not", () => {
  const action = planProviderSessionReconciliation({
    projected: projected(),
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
  // The persisted orphan observation ends the turn, not the binding's later
  // rewrite during the previous boot.
  assert.equal(action?.lastObservedAt, "2026-07-26T23:59:00.000Z");
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

it("skips live, starting, unsettled and missing bindings", () => {
  const cases = [
    { projected: projected(), liveSessions: [providerSession], bindings: [stoppedBinding()] },
    {
      projected: projected({ sessionStatus: "starting" }),
      liveSessions: [],
      bindings: [stoppedBinding()],
    },
    {
      projected: projected({ turnState: "interrupted", completedAt: null }),
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

it.effect("dispatches terminal-turn settlement as a thread.session.set command", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const layer = ProviderSessionReconcilerLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(projected({ turnState: "interrupted" })),
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
    const layer = ProviderSessionReconcilerLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(projected()),
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
                lastSeenAt: "2026-07-26T23:58:00.000Z",
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
    assert.equal(runtimePayload?.stopOutcome?.stoppedAt, "2026-07-26T23:58:00.000Z");
    assert.equal(runtimePayload?.stopOutcome?.reason, "host_lost");
    assert.deepStrictEqual(runtimePayload?.stopOutcome?.knownExternalRunIds, []);

    const command = commands[0];
    assert.equal(command?.type, "thread.session.set");
    if (command?.type !== "thread.session.set") return;
    assert.equal(command.session.status, "interrupted");
    assert.equal(command.session.activeTurnId, null);
    assert.equal(command.session.lastError, HOST_LOST_SESSION_ERROR);
    // The turn freezes at the last persisted observation. The session update
    // and event stay on the server clock.
    assert.equal(command.session.updatedAt, command.createdAt);
    assert.equal(command.latestTurnCompletedAt, "2026-07-26T23:58:00.000Z");
    assert.notEqual(command.latestTurnCompletedAt, command.createdAt);
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
          stoppedAt: "2026-07-26T23:58:00.000Z",
          reason: "host_lost",
        }),
      }),
      status: "error" as const,
      lastSeenAt: "2026-07-26T23:58:00.000Z",
    };
    const layer = ProviderSessionReconcilerLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(projected()),
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
    // The original orphan observation, not this boot's clock, ends the turn.
    assert.equal(command.session.updatedAt, command.createdAt);
    assert.equal(command.latestTurnCompletedAt, "2026-07-26T23:58:00.000Z");
    assert.notEqual(command.latestTurnCompletedAt, command.createdAt);
  }),
);
