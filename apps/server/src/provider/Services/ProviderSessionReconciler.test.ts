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
  planProviderSessionReconciliation,
  ProviderSessionReconciler,
} from "./ProviderSessionReconciler.ts";
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
): ProviderSessionDirectory.ProviderRuntimeBinding => ({
  threadId,
  provider,
  providerInstanceId,
  status: "stopped" as const,
  runtimePayload,
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

it("skips live, starting, unsettled, missing, and still-running bindings", () => {
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
    {
      projected: projected(),
      liveSessions: [],
      bindings: [{ ...stoppedBinding(), status: "running" as const }],
    },
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
          getSnapshot: () => Effect.succeed(projected({ turnState: "interrupted" })),
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
