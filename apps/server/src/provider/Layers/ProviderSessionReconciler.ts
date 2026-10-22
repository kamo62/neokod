import { CommandId, type OrchestrationReadModel } from "@neokod/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  planProviderSessionReconciliation,
  ProviderSessionReconciler,
  type ProviderSessionReconcilerShape,
} from "../Services/ProviderSessionReconciler.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { orphanPossible } from "../providerStopOutcome.ts";

const makeProviderSessionReconciler = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;

  // The lightweight command read model omits message and activity bodies, so
  // the reconciler normally has no turn-scoped completion evidence. Hydrate
  // only threads whose running turn is eligible for settlement; these are the
  // rows that can supply a current-turn observation. A failed detail read
  // leaves the thread as-is, which settles with an explicitly unknown
  // completion instead of blocking recovery or inventing a timestamp.
  const withTurnEvidence = (
    projected: OrchestrationReadModel,
    liveThreadIds: ReadonlySet<string>,
  ): Effect.Effect<OrchestrationReadModel> =>
    Effect.forEach(
      projected.threads,
      (thread) => {
        const turn = thread.latestTurn;
        if (
          turn?.state !== "running" ||
          thread.session?.status !== "running" ||
          liveThreadIds.has(thread.id)
        ) {
          return Effect.succeed(thread);
        }
        return projectionSnapshotQuery.getThreadDetailById(thread.id).pipe(
          Effect.map((detail) => Option.getOrElse(detail, () => thread)),
          Effect.catch((cause) =>
            Effect.logWarning("provider.session.reconciliation-detail-failed", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(thread)),
          ),
        );
      },
      { concurrency: 4 },
    ).pipe(Effect.map((threads) => ({ ...projected, threads })));

  const reconcile: ProviderSessionReconcilerShape["reconcile"] = Effect.gen(function* () {
    // Boot reconciliation only needs thread, latest turn and session rows; the
    // running-turn candidates are then enriched with their turn-scoped rows.
    const [projected, liveSessions, bindings] = yield* Effect.all([
      projectionSnapshotQuery.getCommandReadModel(),
      providerService.listSessions(),
      directory.listBindings(),
    ]);
    const liveThreadIds = new Set(liveSessions.map((session) => session.threadId));
    const actions = planProviderSessionReconciliation({
      projected: yield* withTurnEvidence(projected, liveThreadIds),
      liveSessions,
      bindings,
    });

    for (const action of actions) {
      // Write the binding before the session so a crash between the two writes
      // is repaired by the next boot: the next run sees an `error` binding and
      // the existing terminal binding branch settles the thread. A failed
      // binding write is logged and the thread is still settled, because the
      // thread is what the user sees stuck.
      if (action.bindingSettlement === "host_lost") {
        const binding = bindings.find((entry) => entry.threadId === action.threadId);
        if (binding !== undefined) {
          yield* directory
            .upsert({
              threadId: binding.threadId,
              provider: binding.provider,
              ...(binding.providerInstanceId !== undefined
                ? { providerInstanceId: binding.providerInstanceId }
                : {}),
              status: "error",
              runtimePayload: {
                activeTurnId: null,
                stopPhase: "settled",
                stopOutcome: orphanPossible({
                  // The last persisted observation is the honest end of the
                  // evidence we hold. Boot time is when recovery ran, not when
                  // the lost turn or its items were last seen.
                  stoppedAt: binding.lastSeenAt,
                  reason: "host_lost",
                }),
              },
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("provider.session.reconciliation-binding-failed", {
                  threadId: action.threadId,
                  cause,
                }),
              ),
            );
        }
      }

      const now = DateTime.formatIso(yield* DateTime.now);

      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId: action.threadId,
        session: {
          threadId: action.threadId,
          status: action.status,
          providerName: action.providerName,
          ...(action.providerInstanceId !== undefined
            ? { providerInstanceId: action.providerInstanceId }
            : {}),
          runtimeMode: action.runtimeMode,
          activeTurnId: null,
          lastError: action.lastError,
          // The session update is server-owned: it orders the recovery event
          // and bounds live runtime-item closure. The turn's own completion
          // travels separately below.
          updatedAt: now,
        },
        ...(action.lastObservedAt !== undefined
          ? { latestTurnCompletedAt: action.lastObservedAt }
          : {}),
        createdAt: now,
      });
    }

    if (actions.length > 0) {
      yield* Effect.logInfo("provider.session.reconciliation-complete", {
        settledCount: actions.length,
        hostLostCount: actions.filter((action) => action.bindingSettlement === "host_lost").length,
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("provider.session.reconciliation-failed", {
        cause,
      }),
    ),
  );

  return { reconcile } satisfies ProviderSessionReconcilerShape;
});

export const ProviderSessionReconcilerLive = Layer.effect(
  ProviderSessionReconciler,
  makeProviderSessionReconciler,
);
