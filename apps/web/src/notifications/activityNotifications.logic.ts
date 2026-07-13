import { scopeThreadRef, scopedThreadKey } from "@neokod/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationLatestTurnState,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  TerminalSummary,
} from "@neokod/contracts";
import { projectThreadAwareness } from "@neokod/shared/agentAwareness";

const MAX_LRU_ENTRIES = 512;
const TOMBSTONE_MS = 10 * 60 * 1_000;
const COALESCE_MS = 250;

export type ActivityNotificationKind =
  | "agent-failed"
  | "approval-needed"
  | "input-needed"
  | "agent-completed"
  | "terminal-completed";

interface ActivityOccurrenceBase {
  readonly kind: ActivityNotificationKind;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly generation: number;
  readonly headline: string;
  readonly detail?: string;
  readonly observedAt: number;
}

export type ActivityOccurrence =
  | (ActivityOccurrenceBase & {
      readonly kind: "agent-failed" | "agent-completed";
      readonly reliability: "exact";
      readonly turnId: string;
    })
  | (ActivityOccurrenceBase & {
      readonly kind: "agent-failed" | "approval-needed" | "input-needed" | "terminal-completed";
      readonly reliability: "best-effort";
      readonly ordinal: number;
      readonly terminalId?: string;
    });

export interface EnvironmentActivityInput {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly catalogReady: boolean;
  readonly shellStatus: "empty" | "cached" | "synchronizing" | "live";
  readonly threads: readonly OrchestrationThreadShell[];
  readonly projects?: readonly OrchestrationProjectShell[];
  readonly terminals: readonly TerminalSummary[];
  /** Terminal metadata has delivered a snapshot for this supervisor generation. */
  readonly terminalMetadataReady?: boolean;
  /** Increments for each terminal metadata snapshot so reconnects can ignore sticky query data. */
  readonly terminalMetadataEpoch?: number;
  readonly notificationsEnabled: boolean;
  readonly nowMs: number;
}

interface ThreadObservation {
  activeTurnId: string | null;
  activeTurnSeenLive: boolean;
  latestTurnId: string | null;
  latestTurnState: OrchestrationLatestTurnState | null;
  latestTurnCompleted: boolean;
  rawFailure: boolean;
  rawFailureTurnId: string | null;
  pendingOutcome: {
    readonly kind: "agent-completed" | "agent-failed";
    readonly turnId: string;
  } | null;
  approvalPending: boolean;
  inputPending: boolean;
  approvalOrdinal: number;
  inputOrdinal: number;
  unidentifiedFailureOrdinal: number;
}

interface TerminalObservation {
  running: boolean;
  runningObservedLive: boolean;
  episode: number;
}

interface Tombstone extends ThreadObservation {
  expiresAt: number;
}

export interface ActivityObservationState {
  readonly liveGenerationByEnvironment: ReadonlyMap<string, number>;
  readonly terminalGenerationByEnvironment: ReadonlyMap<string, number>;
  readonly terminalMetadataEpochByEnvironment: ReadonlyMap<string, number>;
  readonly threads: ReadonlyMap<string, ThreadObservation>;
  readonly terminals: ReadonlyMap<string, TerminalObservation>;
  readonly tombstones: ReadonlyMap<string, Tombstone>;
  readonly deliveredKeys: ReadonlyMap<string, true>;
  readonly queuedByScope: ReadonlyMap<string, readonly ActivityOccurrence[]>;
  readonly queueWindowDeadlineByScope: ReadonlyMap<string, number>;
  readonly inFlightByKey: ReadonlyMap<string, ActivityOccurrence>;
}

export function createActivityObservationState(): ActivityObservationState {
  return {
    liveGenerationByEnvironment: new Map(),
    terminalGenerationByEnvironment: new Map(),
    terminalMetadataEpochByEnvironment: new Map(),
    threads: new Map(),
    terminals: new Map(),
    tombstones: new Map(),
    deliveredKeys: new Map(),
    queuedByScope: new Map(),
    queueWindowDeadlineByScope: new Map(),
    inFlightByKey: new Map(),
  };
}

export function activityOccurrenceKey(occurrence: ActivityOccurrence): string {
  const scope = scopedThreadKey(
    scopeThreadRef(occurrence.environmentId, occurrence.threadId as never),
  );
  if (occurrence.reliability === "exact") return `${scope}:${occurrence.kind}:${occurrence.turnId}`;
  if (occurrence.kind === "terminal-completed") {
    return `${scope}:terminal:${occurrence.terminalId}:${occurrence.generation}:${occurrence.ordinal}`;
  }
  return `${scope}:${occurrence.kind}:${occurrence.generation}:${occurrence.ordinal}`;
}

export function reduceEnvironmentActivityObservation(
  state: ActivityObservationState,
  input: EnvironmentActivityInput,
): {
  readonly state: ActivityObservationState;
  readonly occurrences: readonly ActivityOccurrence[];
} {
  const next = cloneState(state);
  pruneTombstones(next.tombstones, input.nowMs);
  const environmentKey = String(input.environmentId);
  const ready = input.catalogReady && input.shellStatus === "live";
  const baseline =
    ready && next.liveGenerationByEnvironment.get(environmentKey) !== input.generation;

  if (!ready) {
    next.liveGenerationByEnvironment.delete(environmentKey);
    baselineUnavailableEnvironment(next, input);
    return { state: next, occurrences: [] };
  }
  if (baseline) next.liveGenerationByEnvironment.set(environmentKey, input.generation);

  const occurrences: ActivityOccurrence[] = [];
  const seenScopes = new Set<string>();
  for (const thread of input.threads) {
    const scope = scopedThreadKey(scopeThreadRef(input.environmentId, thread.id));
    seenScopes.add(scope);
    const observation = observationFor(next, scope);
    next.tombstones.delete(scope);

    const retainedActiveTurnId = observation.activeTurnId;
    const retainedActiveTurnSeenLive = observation.activeTurnSeenLive;
    const activeTurnId = thread.session?.activeTurnId ?? null;
    const latestTurnId = thread.latestTurn?.turnId ?? null;
    const latestTurnState = thread.latestTurn?.state ?? null;
    const rawFailure = thread.session?.status === "error" || latestTurnState === "error";
    const failureTurnId = latestTurnId ?? activeTurnId ?? retainedActiveTurnId;
    const completedTurn = isCompletedTurn(thread);
    const settlesRetainedActive =
      latestTurnId === null &&
      retainedActiveTurnId !== null &&
      (thread.session?.status === "ready" || thread.session?.status === "idle");
    const pendingOutcome = baseline ? observation.pendingOutcome : null;
    const maySettleBaseline =
      baseline &&
      (pendingOutcome !== null ||
        (retainedActiveTurnSeenLive &&
          retainedActiveTurnId !== null &&
          (latestTurnId === retainedActiveTurnId ||
            settlesRetainedActive ||
            (activeTurnId === retainedActiveTurnId && rawFailure))));

    if (pendingOutcome?.kind === "agent-failed") {
      occurrences.push(agentOccurrence(thread, input, "agent-failed", pendingOutcome.turnId));
    } else if (pendingOutcome?.kind === "agent-completed") {
      occurrences.push(agentOccurrence(thread, input, "agent-completed", pendingOutcome.turnId));
    } else if ((!baseline || maySettleBaseline) && rawFailure) {
      const newFailure = !observation.rawFailure || failureTurnId !== observation.rawFailureTurnId;
      if (failureTurnId && newFailure) {
        occurrences.push(agentOccurrence(thread, input, "agent-failed", failureTurnId));
      } else if (!failureTurnId && !observation.rawFailure) {
        occurrences.push(
          agentOccurrence(
            thread,
            input,
            "agent-failed",
            undefined,
            ++observation.unidentifiedFailureOrdinal,
          ),
        );
      }
    } else if (
      (!baseline || maySettleBaseline) &&
      (pendingOutcome?.kind === "agent-completed" ||
        (completedTurn &&
          latestTurnId !== null &&
          (latestTurnId !== observation.latestTurnId || !observation.latestTurnCompleted)) ||
        settlesRetainedActive)
    ) {
      occurrences.push(
        agentOccurrence(
          thread,
          input,
          "agent-completed",
          pendingOutcome?.turnId ?? latestTurnId ?? retainedActiveTurnId ?? undefined,
        ),
      );
    }

    if (!baseline && !observation.approvalPending && thread.hasPendingApprovals) {
      occurrences.push(
        attentionOccurrence(thread, input, "approval-needed", ++observation.approvalOrdinal),
      );
    }
    if (!baseline && !observation.inputPending && thread.hasPendingUserInput) {
      occurrences.push(
        attentionOccurrence(thread, input, "input-needed", ++observation.inputOrdinal),
      );
    }

    if (activeTurnId) {
      if (activeTurnId !== retainedActiveTurnId) observation.activeTurnSeenLive = !baseline;
      observation.activeTurnId = activeTurnId;
      if (!baseline) observation.activeTurnSeenLive = true;
    } else if (
      baseline &&
      retainedActiveTurnId !== null &&
      !retainedActiveTurnSeenLive &&
      (settlesRetainedActive || rawFailure || completedTurn)
    ) {
      // The cached turn reached a terminal first-live snapshot; never settle it later as live work.
      observation.activeTurnId = null;
      observation.activeTurnSeenLive = false;
    }
    observation.latestTurnId = latestTurnId;
    observation.latestTurnState = latestTurnState;
    observation.latestTurnCompleted = completedTurn;
    observation.rawFailure = rawFailure;
    observation.rawFailureTurnId = rawFailure ? failureTurnId : null;
    observation.approvalPending = thread.hasPendingApprovals;
    observation.inputPending = thread.hasPendingUserInput;
    if (baseline) observation.pendingOutcome = null;
    next.threads.set(scope, observation);
  }

  for (const [scope, observation] of [...next.threads]) {
    if (!scope.startsWith(`${environmentKey}:`) || seenScopes.has(scope)) continue;
    lruSet(next.tombstones, scope, { ...observation, expiresAt: input.nowMs + TOMBSTONE_MS });
    next.threads.delete(scope);
  }

  const terminalGeneration = next.terminalGenerationByEnvironment.get(environmentKey);
  const terminalMetadataReady =
    input.terminalMetadataReady !== false &&
    (input.terminalMetadataEpoch === undefined ||
      terminalGeneration === input.generation ||
      next.terminalMetadataEpochByEnvironment.get(environmentKey) !== input.terminalMetadataEpoch);
  const terminalBaseline =
    ready && terminalMetadataReady && terminalGeneration !== input.generation;
  if (terminalMetadataReady && input.terminalMetadataEpoch !== undefined) {
    next.terminalMetadataEpochByEnvironment.set(environmentKey, input.terminalMetadataEpoch);
  }
  if (terminalBaseline) {
    next.terminalGenerationByEnvironment.set(environmentKey, input.generation);
  }
  const seenTerminals = new Set<string>();
  for (const terminal of terminalMetadataReady ? input.terminals : []) {
    const scope = scopedThreadKey(scopeThreadRef(input.environmentId, terminal.threadId as never));
    const key = `${scope}:terminal:${terminal.terminalId}`;
    seenTerminals.add(key);
    const previous = next.terminals.get(key);
    const observation = previous
      ? { ...previous }
      : {
          running: terminalBaseline ? terminal.hasRunningSubprocess : false,
          runningObservedLive: false,
          episode: 0,
        };
    if (
      !baseline &&
      !terminalBaseline &&
      observation.running &&
      observation.runningObservedLive &&
      !terminal.hasRunningSubprocess
    ) {
      const thread = input.threads.find((candidate) => String(candidate.id) === terminal.threadId);
      occurrences.push(terminalOccurrence(input, terminal, observation.episode, thread));
    }
    const runningObservedLive = terminal.hasRunningSubprocess && !baseline && !terminalBaseline;
    if (runningObservedLive && !observation.runningObservedLive) observation.episode += 1;
    observation.runningObservedLive = runningObservedLive;
    observation.running = terminal.hasRunningSubprocess;
    next.terminals.set(key, observation);
  }
  if (terminalMetadataReady) {
    for (const [key] of [...next.terminals]) {
      if (key.startsWith(`${environmentKey}:`) && !seenTerminals.has(key))
        next.terminals.delete(key);
    }
  }

  const freshOccurrences = occurrences.filter((occurrence) => !isSettledOrQueued(next, occurrence));
  let queued = enqueueActivityOccurrences(next, freshOccurrences);
  if (!input.notificationsEnabled) {
    for (const key of queued.inFlightByKey.keys()) {
      queued = settleActivityOccurrence(queued, key, "suppressed");
    }
    while (true) {
      const flushed = flushNextActivityOccurrence(queued, Number.POSITIVE_INFINITY);
      queued = flushed.state;
      if (!flushed.occurrence) break;
      queued = settleActivityOccurrence(
        queued,
        activityOccurrenceKey(flushed.occurrence),
        "suppressed",
      );
    }
  }
  return { state: queued, occurrences: freshOccurrences };
}

export function enqueueActivityOccurrences(
  state: ActivityObservationState,
  occurrences: readonly ActivityOccurrence[],
): ActivityObservationState {
  const next = cloneState(state);
  for (const occurrence of occurrences) {
    const key = activityOccurrenceKey(occurrence);
    const scope = scopedThreadKey(
      scopeThreadRef(occurrence.environmentId, occurrence.threadId as never),
    );
    const queue = next.queuedByScope.get(scope) ?? [];
    if (
      next.deliveredKeys.has(key) ||
      queue.some((queued) => activityOccurrenceKey(queued) === key)
    )
      continue;
    if (queue.length === 0)
      next.queueWindowDeadlineByScope.set(scope, occurrence.observedAt + COALESCE_MS);
    next.queuedByScope.set(scope, [...queue, occurrence]);
  }
  return next;
}

export function flushNextActivityOccurrence(
  state: ActivityObservationState,
  nowMs: number,
): { readonly state: ActivityObservationState; readonly occurrence: ActivityOccurrence | null } {
  let winner: { scope: string; occurrence: ActivityOccurrence } | null = null;
  for (const [scope, queue] of state.queuedByScope) {
    if (
      [...state.inFlightByKey.values()].some(
        (occurrence) =>
          scopedThreadKey(
            scopeThreadRef(occurrence.environmentId, occurrence.threadId as never),
          ) === scope,
      )
    ) {
      continue;
    }
    if (nowMs < (state.queueWindowDeadlineByScope.get(scope) ?? Number.POSITIVE_INFINITY)) continue;
    for (const occurrence of queue) {
      if (state.inFlightByKey.has(activityOccurrenceKey(occurrence))) continue;
      if (!winner || compareOccurrences(occurrence, winner.occurrence) < 0)
        winner = { scope, occurrence };
    }
  }
  if (!winner) return { state, occurrence: null };

  const next = cloneState(state);
  next.inFlightByKey.set(activityOccurrenceKey(winner.occurrence), winner.occurrence);
  return { state: next, occurrence: winner.occurrence };
}

export function settleActivityOccurrence(
  state: ActivityObservationState,
  occurrenceKey: string,
  outcome: "delivered" | "suppressed" | "failed",
): ActivityObservationState {
  const occurrence = state.inFlightByKey.get(occurrenceKey);
  if (!occurrence) return state;

  const next = cloneState(state);
  next.inFlightByKey.delete(occurrenceKey);
  if (outcome === "failed") return next;

  const scope = scopedThreadKey(
    scopeThreadRef(occurrence.environmentId, occurrence.threadId as never),
  );
  const queue = next.queuedByScope.get(scope) ?? [];
  const remaining = queue.filter((queued) => activityOccurrenceKey(queued) !== occurrenceKey);
  if (remaining.length) next.queuedByScope.set(scope, remaining);
  else {
    next.queuedByScope.delete(scope);
    next.queueWindowDeadlineByScope.delete(scope);
  }
  lruSet(next.deliveredKeys, occurrenceKey, true);
  return next;
}

export function retryActivityOccurrence(
  state: ActivityObservationState,
  occurrence: ActivityOccurrence,
  retryAtMs: number,
): ActivityObservationState {
  const key = activityOccurrenceKey(occurrence);
  if (!state.inFlightByKey.has(key)) return state;
  const next = cloneState(state);
  next.inFlightByKey.delete(key);
  next.queueWindowDeadlineByScope.set(
    scopedThreadKey(scopeThreadRef(occurrence.environmentId, occurrence.threadId as never)),
    retryAtMs,
  );
  return next;
}

function agentOccurrence(
  thread: OrchestrationThreadShell,
  input: EnvironmentActivityInput,
  kind: "agent-failed" | "agent-completed",
  turnId?: string,
  ordinal?: number,
): ActivityOccurrence {
  const base = occurrenceBase(thread, input, kind);
  if (turnId) return { ...base, kind, reliability: "exact", turnId };
  return { ...base, kind: "agent-failed", reliability: "best-effort", ordinal: ordinal as number };
}

function attentionOccurrence(
  thread: OrchestrationThreadShell,
  input: EnvironmentActivityInput,
  kind: "approval-needed" | "input-needed",
  ordinal: number,
): ActivityOccurrence {
  return { ...occurrenceBase(thread, input, kind), kind, reliability: "best-effort", ordinal };
}

function terminalOccurrence(
  input: EnvironmentActivityInput,
  terminal: TerminalSummary,
  episode: number,
  thread?: OrchestrationThreadShell,
): ActivityOccurrence {
  const awareness = thread ? awarenessCopy(thread, input) : null;
  return {
    kind: "terminal-completed",
    reliability: "best-effort",
    environmentId: input.environmentId,
    threadId: terminal.threadId,
    terminalId: terminal.terminalId,
    generation: input.generation,
    ordinal: episode,
    headline: `Terminal command finished — ${awareness?.threadTitle ?? terminal.threadId}`,
    detail: activityDetail(awareness, input.environmentId, terminal.threadId),
    observedAt: input.nowMs,
  };
}

function occurrenceBase(
  thread: OrchestrationThreadShell,
  input: EnvironmentActivityInput,
  kind: Exclude<ActivityNotificationKind, "terminal-completed">,
) {
  const awareness = awarenessCopy(thread, input);
  return {
    environmentId: input.environmentId,
    threadId: String(thread.id),
    generation: input.generation,
    headline: `${
      kind === "agent-failed"
        ? "Agent failed"
        : kind === "agent-completed"
          ? "Agent finished"
          : kind === "approval-needed"
            ? "Approval needed"
            : "Waiting for input"
    } — ${thread.title}`,
    detail: activityDetail(awareness, input.environmentId, String(thread.id)),
    observedAt: input.nowMs,
  };
}

function observationFor(state: ReturnType<typeof cloneState>, scope: string): ThreadObservation {
  const previous = state.threads.get(scope);
  if (previous) return { ...previous };
  const tombstone = state.tombstones.get(scope);
  if (tombstone) {
    const { expiresAt: _, ...observation } = tombstone;
    return observation;
  }
  return {
    activeTurnId: null,
    activeTurnSeenLive: false,
    latestTurnId: null,
    latestTurnState: null,
    latestTurnCompleted: false,
    rawFailure: false,
    rawFailureTurnId: null,
    pendingOutcome: null,
    approvalPending: false,
    inputPending: false,
    approvalOrdinal: 0,
    inputOrdinal: 0,
    unidentifiedFailureOrdinal: 0,
  };
}

function isCompletedTurn(thread: OrchestrationThreadShell): boolean {
  return (
    thread.latestTurn?.state === "completed" ||
    (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null)
  );
}

function awarenessCopy(thread: OrchestrationThreadShell, input: EnvironmentActivityInput) {
  const project = input.projects?.find((candidate) => candidate.id === thread.projectId);
  return project
    ? projectThreadAwareness({ environmentId: input.environmentId, project, thread })
    : null;
}

function activityDetail(
  awareness: ReturnType<typeof awarenessCopy>,
  environmentId: EnvironmentId,
  threadId: string,
): string {
  const context = awareness
    ? `${awareness.projectTitle} · ${awareness.threadTitle}`
    : `Thread ${threadId}`;
  return [context, String(environmentId), awareness?.detail].filter(Boolean).join(" · ");
}

function compareOccurrences(left: ActivityOccurrence, right: ActivityOccurrence): number {
  const priority = (kind: ActivityNotificationKind) =>
    ({
      "agent-failed": 0,
      "approval-needed": 1,
      "input-needed": 2,
      "agent-completed": 3,
      "terminal-completed": 4,
    })[kind];
  return priority(left.kind) - priority(right.kind) || left.observedAt - right.observedAt;
}

function cloneState(state: ActivityObservationState) {
  return {
    liveGenerationByEnvironment: new Map(state.liveGenerationByEnvironment),
    terminalGenerationByEnvironment: new Map(state.terminalGenerationByEnvironment),
    terminalMetadataEpochByEnvironment: new Map(state.terminalMetadataEpochByEnvironment),
    threads: new Map(state.threads),
    terminals: new Map(state.terminals),
    tombstones: new Map(state.tombstones),
    deliveredKeys: new Map(state.deliveredKeys),
    queuedByScope: new Map([...state.queuedByScope].map(([key, queue]) => [key, [...queue]])),
    queueWindowDeadlineByScope: new Map(state.queueWindowDeadlineByScope),
    inFlightByKey: new Map(state.inFlightByKey),
  };
}

function lruSet<Value>(map: Map<string, Value>, key: string, value: Value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_LRU_ENTRIES) map.delete(map.keys().next().value as string);
}

function pruneTombstones(tombstones: Map<string, Tombstone>, nowMs: number) {
  for (const [key, tombstone] of tombstones)
    if (tombstone.expiresAt <= nowMs) tombstones.delete(key);
}

function baselineUnavailableEnvironment(
  state: ReturnType<typeof cloneState>,
  input: EnvironmentActivityInput,
) {
  for (const thread of input.threads) {
    const scope = scopedThreadKey(scopeThreadRef(input.environmentId, thread.id));
    const observation = observationFor(state, scope);
    if (thread.session?.activeTurnId && thread.session.activeTurnId !== observation.activeTurnId) {
      observation.activeTurnId = thread.session.activeTurnId;
      observation.activeTurnSeenLive = false;
    }
    const retainedLiveTurnId = observation.activeTurnSeenLive ? observation.activeTurnId : null;
    const rawFailure = thread.session?.status === "error" || thread.latestTurn?.state === "error";
    const settlesRetainedActive =
      thread.latestTurn?.turnId === observation.activeTurnId ||
      thread.session?.status === "ready" ||
      thread.session?.status === "idle";
    if (
      observation.pendingOutcome === null &&
      retainedLiveTurnId &&
      (rawFailure || settlesRetainedActive || isCompletedTurn(thread))
    ) {
      observation.pendingOutcome = {
        kind: rawFailure ? "agent-failed" : "agent-completed",
        turnId: retainedLiveTurnId,
      };
    }
    observation.latestTurnId = thread.latestTurn?.turnId ?? null;
    observation.latestTurnState = thread.latestTurn?.state ?? null;
    observation.latestTurnCompleted = isCompletedTurn(thread);
    observation.rawFailure = rawFailure;
    observation.rawFailureTurnId = observation.rawFailure
      ? (thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? observation.activeTurnId)
      : null;
    observation.approvalPending = thread.hasPendingApprovals;
    observation.inputPending = thread.hasPendingUserInput;
    state.threads.set(scope, observation);
  }
  for (const terminal of input.terminals) {
    const scope = scopedThreadKey(scopeThreadRef(input.environmentId, terminal.threadId as never));
    const key = `${scope}:terminal:${terminal.terminalId}`;
    const previous = state.terminals.get(key);
    state.terminals.set(key, {
      running: terminal.hasRunningSubprocess,
      runningObservedLive: false,
      episode: previous?.episode ?? 0,
    });
  }
}

function isSettledOrQueued(
  state: ActivityObservationState,
  occurrence: ActivityOccurrence,
): boolean {
  const key = activityOccurrenceKey(occurrence);
  const scope = scopedThreadKey(
    scopeThreadRef(occurrence.environmentId, occurrence.threadId as never),
  );
  return (
    state.deliveredKeys.has(key) ||
    (state.queuedByScope.get(scope) ?? []).some((queued) => activityOccurrenceKey(queued) === key)
  );
}
