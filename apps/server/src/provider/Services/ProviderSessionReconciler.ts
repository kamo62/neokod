import type {
  OrchestrationLatestTurn,
  OrchestrationReadModel,
  OrchestrationSession,
  ProviderSession,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProviderRuntimeBinding,
  ProviderRuntimeBindingWithMetadata,
} from "./ProviderSessionDirectory.ts";
import { isHostLostStopOutcome, readPersistedStopOutcome } from "../providerStopOutcome.ts";

export interface ProviderSessionReconcileAction {
  readonly threadId: OrchestrationReadModel["threads"][number]["id"];
  readonly turnId: OrchestrationLatestTurn["turnId"];
  readonly providerName: NonNullable<OrchestrationSession["providerName"]>;
  readonly providerInstanceId?: OrchestrationSession["providerInstanceId"];
  readonly runtimeMode: OrchestrationSession["runtimeMode"];
  readonly status: OrchestrationSession["status"];
  readonly lastError: string | null;
  readonly bindingSettlement?: "host_lost";
  /**
   * When recovery settles a turn that was running when the server died, this
   * is the last moment we actually observed the turn. Event ordering still
   * comes from the server clock, but the turn's completion must not absorb the
   * downtime between that observation and this boot.
   */
  readonly lastObservedAt?: string;
}

/** Shown on a thread whose provider session was lost with the server process. */
export const HOST_LOST_SESSION_ERROR =
  "Neokod restarted while this turn was running. The turn's outcome is unknown and its process may still be running.";

export interface ProviderSessionReconcileInputs {
  readonly projected: OrchestrationReadModel;
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactBindingError = (
  binding: ProviderRuntimeBinding,
  turnId: OrchestrationLatestTurn["turnId"],
): string | null => {
  if (!isRecord(binding.runtimePayload) || binding.runtimePayload.activeTurnId !== turnId) {
    return null;
  }
  const lastError = binding.runtimePayload.lastError;
  if (typeof lastError !== "string" || lastError.trim().length === 0) {
    return null;
  }
  return lastError.trim();
};

export const planProviderSessionReconciliation = ({
  projected,
  liveSessions,
  bindings,
}: ProviderSessionReconcileInputs): ReadonlyArray<ProviderSessionReconcileAction> => {
  const liveThreadIds = new Set(liveSessions.map((session) => session.threadId));
  // Safe to collapse by thread: `provider_session_runtime.thread_id` is the
  // table's PRIMARY KEY, so a thread has at most one binding. If that ever
  // becomes one row per provider instance, this must filter by provider and
  // terminal status before collapsing, or a live binding could hide an eligible
  // stopped one and leave the turn stuck running.
  const bindingsByThreadId = new Map(bindings.map((binding) => [binding.threadId, binding]));

  return projected.threads.flatMap<ProviderSessionReconcileAction>((thread) => {
    const turn = thread.latestTurn;
    const session = thread.session;
    if (
      turn === null ||
      session?.status !== "running" ||
      session.activeTurnId !== turn.turnId ||
      session.providerName === null
    ) {
      return [];
    }

    const action = {
      threadId: thread.id,
      turnId: turn.turnId,
      providerName: session.providerName,
      ...(session.providerInstanceId !== undefined
        ? { providerInstanceId: session.providerInstanceId }
        : {}),
      runtimeMode: session.runtimeMode,
    };

    if (turn.state !== "running") {
      if (turn.completedAt === null) {
        return [];
      }
      const status =
        turn.state === "completed"
          ? ("ready" as const)
          : turn.state === "error"
            ? ("error" as const)
            : ("interrupted" as const);
      // Same rule the live ingestion path uses: becoming `ready` clears the
      // error, anything else keeps it. Clearing unconditionally would lose the
      // provider's own explanation of a quota or auth failure, which is the
      // only place the user is told why the turn died. Keeping it
      // unconditionally is worse in the other direction: `ThreadErrorBanner`
      // renders any non-null error regardless of session status, so a thread
      // that recovered and completed would still show a banner from an earlier
      // failure.
      return [
        {
          ...action,
          status,
          lastError: status === "ready" ? null : session.lastError,
        },
      ];
    }

    if (liveThreadIds.has(thread.id)) {
      return [];
    }

    const binding = bindingsByThreadId.get(thread.id);
    if (
      binding === undefined ||
      binding.provider !== session.providerName ||
      (session.providerInstanceId !== undefined &&
        binding.providerInstanceId !== undefined &&
        binding.providerInstanceId !== session.providerInstanceId)
    ) {
      return [];
    }

    if (binding.status === "stopped" || binding.status === "error") {
      const persistedOutcome = readPersistedStopOutcome(binding.runtimePayload);
      return [
        {
          ...action,
          status: "interrupted",
          lastObservedAt:
            persistedOutcome?.status === "stopped_confirmed" ||
            persistedOutcome?.status === "orphan_possible"
              ? persistedOutcome.stoppedAt
              : binding.lastSeenAt,
          // The binding may already carry the host-loss warning from a boot that
          // crashed between writing the binding and dispatching the session. The
          // payload has no `activeTurnId` then, so recover the warning from the
          // persisted outcome instead of reporting the turn with no explanation.
          lastError:
            exactBindingError(binding, turn.turnId) ??
            (isHostLostStopOutcome(persistedOutcome) ? HOST_LOST_SESSION_ERROR : null),
        },
      ];
    }

    // `running` or `starting` with no live session: the previous server process
    // was lost. A binding without a status is treated the same way; the
    // persistence layer always fills it, so undefined behaves like `running`.
    // The turn's outcome and whether its child process is still running are
    // unknown, so the session is interrupted and the binding records
    // `orphan_possible` rather than a confirmed stop.
    return [
      {
        ...action,
        status: "interrupted",
        lastError: HOST_LOST_SESSION_ERROR,
        bindingSettlement: "host_lost",
        // The binding's last write is the last observation this process holds.
        // The turn ended when that evidence did, not when this boot ran.
        lastObservedAt: binding.lastSeenAt,
      },
    ];
  });
};

export interface ProviderSessionReconcilerShape {
  readonly reconcile: Effect.Effect<void>;
}

export class ProviderSessionReconciler extends Context.Service<
  ProviderSessionReconciler,
  ProviderSessionReconcilerShape
>()("neokod/provider/Services/ProviderSessionReconciler") {}
