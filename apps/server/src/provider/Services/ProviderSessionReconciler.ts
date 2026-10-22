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
   * is the last moment server-owned evidence actually observed that turn.
   * Event ordering still comes from the server clock, but the turn's completion
   * must not absorb the downtime between that observation and this boot.
   *
   * Omitted means the action does not settle a running turn. Explicit `null`
   * means the turn is being settled but no current-turn observation exists, so
   * completion stays unknown rather than inheriting the recovery time.
   */
  readonly lastObservedAt?: string | null;
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

type ReconciledThread = OrchestrationReadModel["threads"][number];

const parseObservationMs = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const turnStartMs = (turn: OrchestrationLatestTurn): number | null =>
  parseObservationMs(turn.startedAt ?? turn.requestedAt);

/**
 * Fetch the latest observation that belongs to the recovered turn. Session
 * bindings are rewritten when a turn starts, so their `lastSeenAt` can predate
 * the turn. Thread metadata is also rewritten for unrelated changes. Only
 * server-owned rows tagged with this turn qualify, and every candidate must
 * fall at or after the turn start.
 */
function* currentTurnObservationCandidates(
  thread: ReconciledThread,
  turn: OrchestrationLatestTurn,
): Generator<string | null | undefined> {
  // A running durable turn may hold a mid-turn checkpoint placeholder; that is
  // a real observation of this turn, not an authoritative completion.
  if (turn.state === "running") {
    yield turn.completedAt;
  }
  for (const message of thread.messages) {
    if (message.turnId === turn.turnId) {
      yield message.updatedAt;
    }
  }
  for (const activity of thread.activities) {
    if (activity.turnId === turn.turnId) {
      yield activity.createdAt;
    }
  }
  for (const plan of thread.proposedPlans) {
    if (plan.turnId === turn.turnId) {
      yield plan.updatedAt;
    }
  }
  for (const checkpoint of thread.checkpoints) {
    if (checkpoint.turnId === turn.turnId) {
      yield checkpoint.completedAt;
    }
  }
}

const latestBoundedObservation = (
  startMs: number | null,
  candidates: Iterable<string | null | undefined>,
): string | null => {
  if (startMs === null) {
    return null;
  }
  let latestAt: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) {
      continue;
    }
    const candidateMs = parseObservationMs(candidate);
    if (candidateMs === null || candidateMs < startMs || candidateMs < latestMs) {
      continue;
    }
    latestAt = candidate;
    latestMs = candidateMs;
  }
  return latestAt;
};

const bindingMatchesSession = (
  binding: ProviderRuntimeBinding,
  session: OrchestrationSession,
): boolean =>
  session.providerName !== null &&
  binding.provider === session.providerName &&
  (session.providerInstanceId === undefined ||
    binding.providerInstanceId === undefined ||
    binding.providerInstanceId === session.providerInstanceId);

const lastObservedForTurn = (
  thread: ReconciledThread,
  turn: OrchestrationLatestTurn,
): string | null =>
  latestBoundedObservation(turnStartMs(turn), currentTurnObservationCandidates(thread, turn));

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
        // A legacy interrupted turn can have its request-derived completion
        // cleared while the session still reports it as running. Recover the
        // session through the same host-loss path as a running turn, keeping
        // completion explicitly unknown instead of inventing closure evidence.
        if (turn.state !== "interrupted" || liveThreadIds.has(thread.id)) {
          return [];
        }
        const binding = bindingsByThreadId.get(thread.id);
        if (binding === undefined || !bindingMatchesSession(binding, session)) {
          return [];
        }
        if (binding.status === "stopped" || binding.status === "error") {
          // A previous boot already recorded the host-loss binding; only the
          // session still needs repair. The host-loss payload clears
          // `activeTurnId`, so restore the warning from the persisted outcome
          // instead of reporting an unexplained interruption.
          const persistedOutcome = readPersistedStopOutcome(binding.runtimePayload);
          return [
            {
              ...action,
              status: "interrupted",
              lastError:
                exactBindingError(binding, turn.turnId) ??
                (isHostLostStopOutcome(persistedOutcome) ? HOST_LOST_SESSION_ERROR : null),
              lastObservedAt: null,
            },
          ];
        }
        return [
          {
            ...action,
            status: "interrupted",
            lastError: HOST_LOST_SESSION_ERROR,
            bindingSettlement: "host_lost",
            lastObservedAt: null,
          },
        ];
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
    if (binding === undefined || !bindingMatchesSession(binding, session)) {
      return [];
    }

    if (binding.status === "stopped" || binding.status === "error") {
      const persistedOutcome = readPersistedStopOutcome(binding.runtimePayload);
      const startMs = turnStartMs(turn);
      // A confirmed stop or orphan observation is current-turn stop evidence
      // and stays authoritative when it is temporally consistent. A failed
      // stop has no end timestamp; fall back to this turn's own observations.
      const persistedStopAt =
        persistedOutcome?.status === "stopped_confirmed" ||
        persistedOutcome?.status === "orphan_possible"
          ? persistedOutcome.stoppedAt
          : null;
      // A `host_lost` outcome is written from binding state and can be the
      // turn-start write that survived a crash between binding and session
      // dispatch. It is not authoritative turn completion, so recompute from
      // this turn's own rows. Other stop outcomes are real server-owned stop
      // evidence; still take the max so later turn rows are never hidden.
      const lastObservedAt = isHostLostStopOutcome(persistedOutcome)
        ? lastObservedForTurn(thread, turn)
        : latestBoundedObservation(startMs, [
            persistedStopAt,
            ...currentTurnObservationCandidates(thread, turn),
          ]);
      return [
        {
          ...action,
          status: "interrupted",
          lastObservedAt,
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
        // The binding write happens when the turn starts, so its `lastSeenAt`
        // is not current-turn evidence. Freeze at the latest turn-scoped row
        // instead; with none, completion stays explicitly unknown rather than
        // absorbing this boot's clock.
        lastObservedAt: lastObservedForTurn(thread, turn),
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
