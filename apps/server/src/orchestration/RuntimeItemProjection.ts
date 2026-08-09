import type {
  OrchestrationRuntimeItem,
  RuntimeItemObservation,
  RuntimeItemSyntheticClosure,
  RuntimeItemSyntheticState,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import { EventId } from "@neokod/contracts";

function isProviderTerminal(state: OrchestrationRuntimeItem["providerState"]): boolean {
  return state !== null && state !== "active";
}

export function projectRuntimeItemObservation(input: {
  readonly existing: OrchestrationRuntimeItem | null;
  readonly threadId: ThreadId;
  readonly observation: RuntimeItemObservation;
  readonly sequence: number;
}): OrchestrationRuntimeItem {
  const { existing, observation } = input;
  const existingProviderTerminal = isProviderTerminal(existing?.providerState ?? null);
  const providerState = existingProviderTerminal
    ? existing!.providerState
    : observation.providerState;
  const providerTerminal = isProviderTerminal(providerState);
  const effectiveState = providerTerminal ? providerState! : (existing?.syntheticState ?? "active");
  const terminalSource = providerTerminal
    ? "provider"
    : existing?.syntheticState !== null && existing?.syntheticState !== undefined
      ? "synthetic"
      : null;

  return {
    runtimeItemId: observation.runtimeItemId,
    providerItemId: observation.providerItemId ?? existing?.providerItemId ?? null,
    threadId: input.threadId,
    sessionId: observation.sessionId,
    turnId: observation.turnId ?? existing?.turnId ?? null,
    kind: observation.kind,
    scope: observation.scope,
    label: observation.label,
    providerState,
    syntheticState: existing?.syntheticState ?? null,
    effectiveState,
    terminalSource,
    mayStillBeRunning: terminalSource === "synthetic" && effectiveState === "orphaned",
    providerEventId: observation.providerEventId,
    syntheticEventId: existing?.syntheticEventId ?? null,
    startedAt: existing?.startedAt ?? observation.observedAt,
    updatedAt: observation.observedAt,
    completedAt:
      effectiveState === "active"
        ? null
        : existingProviderTerminal || !providerTerminal
          ? (existing?.completedAt ?? observation.observedAt)
          : observation.observedAt,
    lastSequence: input.sequence,
  };
}

export function projectRuntimeItemClosure(input: {
  readonly item: OrchestrationRuntimeItem;
  readonly closure: RuntimeItemSyntheticClosure;
  readonly syntheticEventId: OrchestrationRuntimeItem["syntheticEventId"];
  readonly closedAt: string;
  readonly sequence: number;
}): OrchestrationRuntimeItem {
  const { closure, item } = input;
  const keyMatches =
    item.runtimeItemId === closure.runtimeItemId &&
    item.sessionId === closure.sessionId &&
    item.kind === closure.kind;
  const canUpgradeUncertainOrphan =
    item.scope !== "detached" &&
    item.syntheticState === "orphaned" &&
    closure.syntheticState !== "orphaned";
  if (
    !keyMatches ||
    (item.effectiveState !== "active" && !canUpgradeUncertainOrphan) ||
    isProviderTerminal(item.providerState) ||
    (item.syntheticState !== null && !canUpgradeUncertainOrphan)
  ) {
    return item;
  }

  const syntheticState = closure.syntheticState;
  return {
    ...item,
    syntheticState,
    effectiveState: syntheticState,
    terminalSource: "synthetic",
    mayStillBeRunning: syntheticState === "orphaned",
    syntheticEventId: input.syntheticEventId,
    updatedAt: input.closedAt,
    completedAt: input.closedAt,
    lastSequence: input.sequence,
  };
}

function syntheticStateForItem(input: {
  readonly item: OrchestrationRuntimeItem;
  readonly boundary: "turn" | "session";
  readonly outcome: "completed" | "failed" | "stopped";
  readonly terminationGuaranteed: boolean;
}): RuntimeItemSyntheticState {
  if (
    input.item.scope === "detached" ||
    (input.boundary === "session" && !input.terminationGuaranteed)
  ) {
    return "orphaned";
  }
  switch (input.item.kind) {
    case "approval":
    case "user-input":
      return "cancelled";
    case "assistant-message":
      return "interrupted";
    case "tool":
    case "delegated-task":
      return input.outcome;
  }
}

function syntheticActivity(input: {
  readonly item: OrchestrationRuntimeItem;
  readonly state: RuntimeItemSyntheticState;
  readonly boundaryEventId: EventId;
  readonly closedAt: string;
}): RuntimeItemSyntheticClosure["activity"] {
  const { item, state } = input;
  const commonPayload = {
    synthetic: true,
    status: state,
    mayStillBeRunning: state === "orphaned",
  } as const;
  const id = EventId.make(
    `runtime-terminal:${input.boundaryEventId}:${item.sessionId}:${item.kind}:${item.runtimeItemId}`,
  );

  switch (item.kind) {
    case "delegated-task":
      return {
        id,
        tone: state === "failed" ? "error" : "info",
        kind: "task.completed",
        summary: state === "orphaned" ? "Task orphaned" : `Task ${state}`,
        payload: { ...commonPayload, taskId: item.runtimeItemId, detail: item.label },
        turnId: item.turnId,
        createdAt: input.closedAt,
      };
    case "tool":
      return {
        id,
        tone: state === "failed" ? "error" : "tool",
        kind: "tool.completed",
        summary: state === "orphaned" ? "Tool may still be running" : `Tool ${state}`,
        payload: { ...commonPayload, itemId: item.runtimeItemId, detail: item.label },
        turnId: item.turnId,
        createdAt: input.closedAt,
      };
    case "approval":
      return {
        id,
        tone: "approval",
        kind: "approval.resolved",
        summary: state === "orphaned" ? "Approval orphaned" : "Approval cancelled",
        payload: {
          ...commonPayload,
          requestId: item.runtimeItemId,
          ...(state === "cancelled" ? { decision: "cancel" as const } : {}),
        },
        turnId: item.turnId,
        createdAt: input.closedAt,
      };
    case "user-input":
      return {
        id,
        tone: "approval",
        kind: "user-input.resolved",
        summary: state === "orphaned" ? "User input orphaned" : "User input cancelled",
        payload: { ...commonPayload, requestId: item.runtimeItemId },
        turnId: item.turnId,
        createdAt: input.closedAt,
      };
    case "assistant-message":
      return {
        id,
        tone: "info",
        kind: "assistant.interrupted",
        summary: state === "orphaned" ? "Assistant response orphaned" : "Assistant interrupted",
        payload: { ...commonPayload, itemId: item.runtimeItemId },
        turnId: item.turnId,
        createdAt: input.closedAt,
      };
  }
}

export function planRuntimeItemClosures(input: {
  readonly items: ReadonlyArray<OrchestrationRuntimeItem>;
  readonly boundary: "turn" | "session";
  readonly sessionId: RuntimeSessionId;
  readonly turnId: TurnId | null;
  readonly outcome: "completed" | "failed" | "stopped";
  readonly terminationGuaranteed: boolean;
  readonly boundaryEventId: EventId;
  readonly closedAt: string;
}): ReadonlyArray<RuntimeItemSyntheticClosure> {
  return input.items.flatMap((item) => {
    const boundaryMatches =
      item.sessionId === input.sessionId &&
      (input.boundary === "session" ||
        (input.turnId !== null &&
          item.turnId === input.turnId &&
          (item.scope === "turn" || item.scope === "detached")));
    const canUpgradeUncertainOrphan =
      input.boundary === "session" &&
      input.terminationGuaranteed &&
      item.scope !== "detached" &&
      item.syntheticState === "orphaned";
    if (
      !boundaryMatches ||
      (item.effectiveState !== "active" && !canUpgradeUncertainOrphan) ||
      isProviderTerminal(item.providerState)
    ) {
      return [];
    }
    const state = syntheticStateForItem({
      item,
      boundary: input.boundary,
      outcome: input.outcome,
      terminationGuaranteed: input.terminationGuaranteed,
    });
    return [
      {
        runtimeItemId: item.runtimeItemId,
        sessionId: item.sessionId,
        kind: item.kind,
        syntheticState: state,
        activity: syntheticActivity({
          item,
          state,
          boundaryEventId: input.boundaryEventId,
          closedAt: input.closedAt,
        }),
      },
    ];
  });
}
