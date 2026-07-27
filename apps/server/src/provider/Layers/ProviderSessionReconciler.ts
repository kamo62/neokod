import { CommandId } from "@neokod/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  planProviderSessionReconciliation,
  ProviderSessionReconciler,
  type ProviderSessionReconcilerShape,
} from "../Services/ProviderSessionReconciler.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const makeProviderSessionReconciler = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;

  const reconcile: ProviderSessionReconcilerShape["reconcile"] = Effect.gen(function* () {
    const [projected, liveSessions, bindings] = yield* Effect.all([
      projectionSnapshotQuery.getSnapshot(),
      providerService.listSessions(),
      directory.listBindings(),
    ]);
    const actions = planProviderSessionReconciliation({
      projected,
      liveSessions,
      bindings,
    });

    for (const action of actions) {
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId: action.threadId,
        session: {
          threadId: action.threadId,
          status: "interrupted",
          providerName: action.providerName,
          ...(action.providerInstanceId !== undefined
            ? { providerInstanceId: action.providerInstanceId }
            : {}),
          runtimeMode: action.runtimeMode,
          activeTurnId: null,
          lastError: action.lastError,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        },
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
    }

    if (actions.length > 0) {
      yield* Effect.logInfo("provider.session.reconciliation-complete", {
        settledCount: actions.length,
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
