import type {
  OrchestrationLatestTurn,
  OrchestrationReadModel,
  OrchestrationSession,
  ProviderSession,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderRuntimeBinding } from "./ProviderSessionDirectory.ts";

export interface ProviderSessionReconcileAction {
  readonly threadId: OrchestrationReadModel["threads"][number]["id"];
  readonly turnId: OrchestrationLatestTurn["turnId"];
  readonly providerName: NonNullable<OrchestrationSession["providerName"]>;
  readonly providerInstanceId?: OrchestrationSession["providerInstanceId"];
  readonly runtimeMode: OrchestrationSession["runtimeMode"];
  readonly status: OrchestrationSession["status"];
  readonly lastError: string | null;
}

export interface ProviderSessionReconcileInputs {
  readonly projected: OrchestrationReadModel;
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly bindings: ReadonlyArray<ProviderRuntimeBinding>;
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
      // Releasing a stuck turn id is not a reason to discard why the turn died.
      // Overwriting this with null loses the provider's own explanation, which
      // is the only place a quota or auth failure is reported to the user.
      return [
        {
          ...action,
          status,
          lastError: session.lastError,
        },
      ];
    }

    if (liveThreadIds.has(thread.id)) {
      return [];
    }

    const binding = bindingsByThreadId.get(thread.id);
    if (
      binding === undefined ||
      (binding.status !== "stopped" && binding.status !== "error") ||
      binding.provider !== session.providerName ||
      (session.providerInstanceId !== undefined &&
        binding.providerInstanceId !== undefined &&
        binding.providerInstanceId !== session.providerInstanceId)
    ) {
      return [];
    }

    return [
      {
        ...action,
        status: "interrupted",
        lastError: exactBindingError(binding, turn.turnId),
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
