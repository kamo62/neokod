import type {
  AttentionItem,
  AttentionItemId,
  EnvironmentId,
  ProviderInstanceRef,
  RunAttemptId,
  RunAttemptStatus,
  SymphonyBoardCard,
  SymphonyDispatchRefusalReason,
  SymphonyProjectId,
  WorkItem,
  WorkItemId,
  WorkLifecycle,
} from "@neokod/contracts";
import { attentionMode, type AttentionMode } from "./components/symphony/attention.logic";
import { ACTIVE_RUN_STATUSES } from "./components/symphony/symphonyRuns.logic";

/**
 * One semantic projection of Symphony work: current lifecycle, independent
 * attention, attempt history, evidence freshness, ownership and the actions
 * the client can actually support.
 *
 * Source boundaries that shape this module:
 *
 * - `subscribeProjectBoard` returns every active item (up to 5,000) and only
 *   the newest 100 finished items. `truncated` is the server's own statement
 *   that more rows exist.
 * - `listRuns` filters the newest 1,000 attempts and `listAttention` reads
 *   capped pending/open lists. Neither reports completeness, and the server
 *   maps some read failures to `[]`/`null`. A successful empty list therefore
 *   is not proof of an empty domain.
 * - A board card's lifecycle is the current item fact. A run attempt's status
 *   is an attempt outcome, not the item lifecycle.
 * - Cancellation statuses record a requested stop, not confirmed process exit.
 *   Positive closure must be supplied by an authoritative observer.
 *
 * The projection never reads a clock. Callers pass observed timestamps.
 */

export type SymphonyWorkEvidence<A> =
  | {
      readonly state: "known";
      readonly value: A;
      /** Last-known data retained after a live read failed. */
      readonly staleReason?: string | undefined;
    }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string; readonly retryable: boolean };

export type SymphonyWorkEvidenceStatus = "known" | "unknown" | "unavailable";

export type SymphonyWorkFreshness =
  | { readonly state: "fresh" }
  | { readonly state: "stale"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string };

export type SymphonyWorkCoverage =
  | { readonly state: "exhaustive" }
  | { readonly state: "bounded"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string };

export interface SymphonyWorkBoardFacts {
  readonly cards: ReadonlyArray<SymphonyBoardCard>;
  readonly coverage: SymphonyWorkCoverage;
  readonly generatedAt: string;
}

export interface SymphonyWorkAttemptFact {
  readonly runAttemptId: RunAttemptId;
  readonly workItemId: WorkItemId;
  readonly projectId?: SymphonyProjectId | undefined;
  readonly attemptNumber: number;
  readonly status: RunAttemptStatus;
  readonly startedAt: string;
  readonly finishedAt?: string | null | undefined;
  readonly provider?: ProviderInstanceRef | undefined;
  readonly model?: string | undefined;
}

export interface SymphonyWorkRunFacts {
  readonly runs: ReadonlyArray<SymphonyWorkAttemptFact>;
  readonly coverage: SymphonyWorkCoverage;
}

export interface SymphonyWorkAttentionFacts {
  readonly items: ReadonlyArray<AttentionItem>;
  readonly coverage: SymphonyWorkCoverage;
}

/**
 * Positive closure for a stop. The current server does not publish this in the
 * board/run payloads, so the UI passes it only when an authoritative observer
 * (recovery `stop_confirmed`) supplies it. It is never synthesised.
 */
export interface SymphonyWorkClosureEvidence {
  readonly workItemId: WorkItemId;
  /** Omit only when the observer confirms closure for the work item itself. */
  readonly runAttemptId?: RunAttemptId | undefined;
  readonly observedAt: string;
  readonly source: string;
}

export interface SymphonyWorkRefusal {
  readonly reason: SymphonyDispatchRefusalReason;
  readonly detail?: string | undefined;
  /**
   * Lifecycle the client observed immediately before sending the refused
   * dispatch. A terminal prior lifecycle plus a queued card identifies the
   * server's failed/cancelled -> queued -> refused path.
   */
  readonly priorLifecycle?: WorkLifecycle | undefined;
}

export interface SymphonyWorkPendingDispatch {
  readonly requestedAt?: string | undefined;
}

export interface SymphonyWorkDispatchFacts {
  readonly pending: ReadonlyArray<{
    readonly workItemId: WorkItemId;
    readonly requestedAt?: string | undefined;
  }>;
  readonly refusals: ReadonlyArray<{
    readonly workItemId: WorkItemId;
    readonly refusal: SymphonyWorkRefusal;
  }>;
}

export interface SymphonyWorkItemInput {
  readonly environmentId: EnvironmentId;
  readonly workItemId: WorkItemId;
  readonly projectId?: SymphonyProjectId | undefined;
  /** Current board card. Absent means "not loaded", never "no card". */
  readonly card?: SymphonyWorkEvidence<SymphonyBoardCard> | undefined;
  /** Durable work-item record, used when no board card is loaded. */
  readonly workItem?: SymphonyWorkEvidence<WorkItem> | undefined;
  /** The current attempt reported by the board (`latestRunAttemptId`). */
  readonly currentRunAttemptId?: RunAttemptId | undefined;
  /** Run attempts for the item, including older attempts. */
  readonly runs?: SymphonyWorkEvidence<SymphonyWorkRunFacts> | undefined;
  /** Open and closed attention items for the item and its attempts. */
  readonly attention?: SymphonyWorkEvidence<SymphonyWorkAttentionFacts> | undefined;
  /** A client command whose acknowledgement has not been observed. */
  readonly pendingDispatch?: SymphonyWorkPendingDispatch | undefined;
  /** The most recent dispatch refusal observed by this client. */
  readonly refusal?: SymphonyWorkRefusal | undefined;
  /** Positive stop closure, when an authoritative observer supplied it. */
  readonly closures?: ReadonlyArray<SymphonyWorkClosureEvidence> | undefined;
}

export type SymphonyWorkFilter = "all" | "not_started" | "in_progress" | "attention" | "history";

export type SymphonyWorkConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

/**
 * A known board/run/attention value is only fresh while the environment is
 * connected. This uses the existing connection state and never reads a clock.
 */
export function symphonyWorkConnectionStaleReason(
  phase: SymphonyWorkConnectionPhase | null,
  networkStatus: "unknown" | "offline" | "online" = "online",
): string | null {
  if (networkStatus === "offline") return "Disconnected from the network.";
  if (networkStatus === "unknown") return "Network status is unknown.";
  switch (phase) {
    case "connected":
      return null;
    case "available":
      return "The environment connection is not started.";
    case "offline":
      return "Disconnected from the environment (offline).";
    case "connecting":
      return "Not connected to the environment (connecting).";
    case "reconnecting":
      return "Not connected to the environment (reconnecting).";
    case "error":
      return "Connection to the environment failed.";
    case null:
      return "Environment connection state is unknown.";
  }
}

export interface SymphonyWorkCollectionInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: SymphonyProjectId;
  readonly board: SymphonyWorkEvidence<SymphonyWorkBoardFacts>;
  readonly runs: SymphonyWorkEvidence<SymphonyWorkRunFacts>;
  readonly attention: SymphonyWorkEvidence<SymphonyWorkAttentionFacts>;
  readonly dispatch?: SymphonyWorkDispatchFacts | undefined;
  readonly closures?: ReadonlyArray<SymphonyWorkClosureEvidence> | undefined;
  readonly filter?: SymphonyWorkFilter | undefined;
}

export interface SymphonyWorkIdentity {
  readonly environmentId: EnvironmentId;
  readonly projectId: SymphonyProjectId | null;
  readonly workItemId: WorkItemId;
  readonly trackerIdentifier: string | null;
  readonly title: string | null;
  readonly issueUrl: string | null;
}

export type SymphonyWorkLifecycle =
  | {
      readonly phase: "not_started";
      readonly lifecycle: WorkLifecycle;
      readonly reason: "draft" | "ineligible" | "refused";
      readonly detail: string | null;
    }
  | { readonly phase: "in_progress"; readonly lifecycle: WorkLifecycle }
  | {
      readonly phase: "finished";
      readonly lifecycle: WorkLifecycle;
      readonly outcome: "completed" | "cancelled" | "failed";
    }
  | {
      readonly phase: "unknown";
      readonly lifecycle: WorkLifecycle | null;
      readonly reason: string;
    };

/** `not_observed` is not proof that nothing is running on the target. */
export type SymphonyWorkExecution = "observed" | "not_observed" | "unknown";

export interface SymphonyWorkOwnership {
  readonly state: "admitted" | "none_observed" | "unknown";
  readonly reason: string;
}

export interface SymphonyWorkAttentionEntry {
  readonly item: AttentionItem;
  readonly mode: AttentionMode;
  readonly runAttemptId: RunAttemptId | null;
  /** True when the referenced attempt is present in the loaded run evidence. */
  readonly attemptLoaded: boolean;
}

export type SymphonyWorkAttention =
  | {
      readonly state: "needs_attention";
      readonly items: ReadonlyArray<SymphonyWorkAttentionEntry>;
      readonly coverage: SymphonyWorkCoverage;
    }
  | { readonly state: "none"; readonly coverage: SymphonyWorkCoverage }
  | { readonly state: "unknown"; readonly reason: string; readonly coverage: SymphonyWorkCoverage }
  | { readonly state: "unavailable"; readonly reason: string; readonly retryable: boolean };

export type SymphonyWorkAttemptOutcome =
  | { readonly state: "active" }
  | { readonly state: "succeeded" }
  | { readonly state: "failed" }
  | { readonly state: "stopped" }
  | { readonly state: "stop_requested"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string };

export interface SymphonyWorkAttempt {
  readonly runAttemptId: RunAttemptId;
  readonly workItemId: WorkItemId;
  readonly attemptNumber: number;
  /** Null when duplicate evidence reported conflicting statuses. */
  readonly status: RunAttemptStatus | null;
  readonly statuses: ReadonlyArray<RunAttemptStatus>;
  readonly outcome: SymphonyWorkAttemptOutcome;
  readonly isCurrent: boolean;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly provider: ProviderInstanceRef | null;
  readonly model: string | null;
  readonly attentionItemIds: ReadonlyArray<AttentionItemId>;
  readonly hasOutstandingAttention: boolean;
}

export interface SymphonyWorkAttempts {
  readonly current: SymphonyWorkAttempt | null;
  /** `none` is only claimed when run history is known exhaustive and empty. */
  readonly currentState: "known" | "none" | "unknown";
  readonly currentReason: string | null;
  /** Every known attempt, newest first, including the current one. */
  readonly history: ReadonlyArray<SymphonyWorkAttempt>;
  readonly outstanding: ReadonlyArray<SymphonyWorkAttempt>;
  readonly olderOutstanding: ReadonlyArray<SymphonyWorkAttempt>;
  readonly coverage: SymphonyWorkCoverage;
  readonly freshness: SymphonyWorkFreshness;
}

export type SymphonyWorkActionKind =
  | "start"
  | "run_again"
  | "cancel"
  | "answer"
  | "approve"
  | "reject";

export type SymphonyWorkActionState = "available" | "blocked" | "unknown";

export interface SymphonyWorkAction {
  readonly kind: SymphonyWorkActionKind;
  readonly state: SymphonyWorkActionState;
  readonly reason: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: SymphonyProjectId | null;
  readonly workItemId: WorkItemId;
  readonly runAttemptId?: RunAttemptId | undefined;
  readonly attentionItemId?: AttentionItemId | undefined;
}

export interface SymphonyWorkMembership {
  readonly all: boolean;
  readonly notStarted: boolean;
  readonly inProgress: boolean;
  readonly needsAttention: boolean;
  readonly history: boolean;
  /** True when unresolved acknowledgement, closure or ownership keeps the row current. */
  readonly reconciliation: boolean;
}

export interface SymphonyWorkObservedTarget {
  /**
   * These are current observations. They are not an immutable accepted-attempt
   * target and must not be presented as historical admission evidence.
   */
  readonly scope: "current_observation";
  readonly source: "current_attempt" | "historical_attempt" | "work_item" | "none";
  readonly workspacePath: string | null;
  readonly provider: ProviderInstanceRef | null;
  readonly model: string | null;
  readonly observedAt: string | null;
}

export type SymphonyWorkContradictionCode =
  | "identity_mismatch"
  | "project_mismatch"
  | "duplicate_work_item_card"
  | "lifecycle_mismatch"
  | "current_attempt_mismatch"
  | "duplicate_attempt_evidence"
  | "active_attempt_behind_latest"
  | "multiple_outstanding_attempts"
  | "active_attempt_after_terminal_lifecycle"
  | "run_observed_for_not_started_item";

export interface SymphonyWorkContradiction {
  readonly code: SymphonyWorkContradictionCode;
  readonly workItemId: WorkItemId;
  readonly detail: string;
  readonly runAttemptId?: RunAttemptId | undefined;
}

export interface SymphonyWorkItemProjection {
  readonly identity: SymphonyWorkIdentity;
  readonly lifecycle: SymphonyWorkLifecycle;
  readonly execution: SymphonyWorkExecution;
  readonly ownership: SymphonyWorkOwnership;
  readonly attention: SymphonyWorkAttention;
  readonly attempts: SymphonyWorkAttempts;
  readonly actions: ReadonlyArray<SymphonyWorkAction>;
  readonly evidence: {
    readonly lifecycle: SymphonyWorkEvidenceStatus;
    readonly runs: SymphonyWorkEvidenceStatus;
    readonly attention: SymphonyWorkEvidenceStatus;
  };
  readonly freshness: {
    readonly card: SymphonyWorkFreshness;
    readonly lifecycle: SymphonyWorkFreshness;
    readonly runs: SymphonyWorkFreshness;
    readonly attention: SymphonyWorkFreshness;
  };
  readonly contradictions: ReadonlyArray<SymphonyWorkContradiction>;
  readonly membership: SymphonyWorkMembership;
  readonly observedTarget: SymphonyWorkObservedTarget;
  readonly pendingDispatch: SymphonyWorkPendingDispatch | null;
  readonly refusal: SymphonyWorkRefusal | null;
}

export type SymphonyWorkCountState = "known" | "observed" | "unknown" | "unavailable";

export interface SymphonyWorkCollection {
  readonly environmentId: EnvironmentId;
  readonly projectId: SymphonyProjectId;
  readonly state: SymphonyWorkEvidenceStatus;
  readonly filter: SymphonyWorkFilter;
  readonly items: ReadonlyArray<SymphonyWorkItemProjection>;
  readonly visibleItems: ReadonlyArray<SymphonyWorkItemProjection>;
  readonly counts: {
    readonly items: {
      readonly state: SymphonyWorkCountState;
      readonly all: number;
      readonly notStarted: number;
      readonly inProgress: number;
      readonly history: number;
      readonly reconciliation: number;
      readonly coverage: SymphonyWorkCoverage;
      readonly freshness: SymphonyWorkFreshness;
    };
    readonly attention: {
      readonly state: SymphonyWorkCountState;
      /** Work items on this board that need attention or reconciliation. */
      readonly workItems: number;
      /** Open attention requests attached to items on this board. */
      readonly items: number;
      readonly outsideBoardWorkItems: number;
      readonly outsideBoardItems: number;
      readonly coverage: SymphonyWorkCoverage;
      readonly freshness: SymphonyWorkFreshness;
    };
  };
  readonly attentionOutsideFilter: {
    readonly state: SymphonyWorkCountState;
    readonly workItems: number;
    readonly items: number;
    readonly coverage: SymphonyWorkCoverage;
    readonly freshness: SymphonyWorkFreshness;
  };
  /** Attention for work items outside the board caps. Never inserted as rows. */
  readonly attentionOutsideBoard: ReadonlyArray<SymphonyWorkAttentionEntry>;
  /** Run attempts whose work item is outside the board caps. */
  readonly unmatchedRuns: ReadonlyArray<SymphonyWorkAttemptFact>;
  readonly contradictions: ReadonlyArray<SymphonyWorkContradiction>;
  readonly evidence: {
    readonly board: SymphonyWorkEvidenceStatus;
    readonly runs: SymphonyWorkEvidenceStatus;
    readonly attention: SymphonyWorkEvidenceStatus;
  };
  readonly freshness: {
    readonly board: SymphonyWorkFreshness;
    readonly runs: SymphonyWorkFreshness;
    readonly attention: SymphonyWorkFreshness;
  };
  readonly coverage: {
    readonly board: SymphonyWorkCoverage;
    readonly runs: SymphonyWorkCoverage;
    readonly attention: SymphonyWorkCoverage;
  };
}

const TERMINAL_LIFECYCLES = new Set<WorkLifecycle>(["completed", "cancelled", "failed"]);
const NOT_STARTED_LIFECYCLES = new Set<WorkLifecycle>(["draft", "ineligible"]);
const EXECUTING_LIFECYCLES = new Set<WorkLifecycle>(["preparing", "running", "testing"]);
const MANUALLY_DISPATCHABLE_LIFECYCLES = new Set<WorkLifecycle>([
  "queued",
  "retry_scheduled",
  "changes_requested",
  "validation_failed",
]);
const RUN_AGAIN_LIFECYCLES = new Set<WorkLifecycle>([
  "changes_requested",
  "validation_failed",
  "failed",
  "cancelled",
]);
const FAILED_RUN_STATUSES = new Set<RunAttemptStatus>([
  "failed",
  "timed_out",
  "stalled",
  "process_failed",
  "validation_failed",
  "workflow_error",
  "provider_error",
  "retries_exhausted",
]);
const STOPPED_RUN_STATUSES = new Set<RunAttemptStatus>([
  "canceled_by_reconciliation",
  "user_cancelled",
  "tracker_cancelled",
  "interrupted",
]);

const unknownCoverage = (reason: string): SymphonyWorkCoverage => ({ state: "unknown", reason });

const evidenceStatus = <A>(
  evidence: SymphonyWorkEvidence<A> | undefined,
): SymphonyWorkEvidenceStatus =>
  evidence === undefined
    ? "unknown"
    : evidence.state === "known"
      ? "known"
      : evidence.state === "unavailable"
        ? "unavailable"
        : "unknown";

const freshnessOf = <A>(
  evidence: SymphonyWorkEvidence<A> | undefined,
  missingReason: string,
): SymphonyWorkFreshness =>
  evidence === undefined
    ? { state: "unknown", reason: missingReason }
    : evidence.state === "known"
      ? evidence.staleReason === undefined
        ? { state: "fresh" }
        : { state: "stale", reason: evidence.staleReason }
      : { state: "unknown", reason: evidence.reason };

function attentionEntry(input: {
  readonly item: AttentionItem;
  readonly attemptIds: ReadonlySet<string>;
}): SymphonyWorkAttentionEntry {
  const runAttemptId = input.item.runAttemptId ?? null;
  return {
    item: input.item,
    mode: attentionMode(input.item),
    runAttemptId,
    attemptLoaded: runAttemptId === null ? true : input.attemptIds.has(String(runAttemptId)),
  };
}

function positiveTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function closureCoversAttempt(
  closure: SymphonyWorkClosureEvidence,
  workItemId: WorkItemId,
  runAttemptId: RunAttemptId,
  startedAt: string,
): boolean {
  if (String(closure.workItemId) !== String(workItemId)) return false;
  const closureTime = positiveTimestamp(closure.observedAt);
  const attemptTime = positiveTimestamp(startedAt);
  if (closureTime === null || attemptTime === null) return false;
  if (closure.runAttemptId !== undefined) {
    return String(closure.runAttemptId) === String(runAttemptId) && attemptTime <= closureTime;
  }
  return attemptTime <= closureTime;
}

function closureFor(
  closures: ReadonlyArray<SymphonyWorkClosureEvidence> | undefined,
  workItemId: WorkItemId,
  runAttemptId: RunAttemptId,
  startedAt: string,
): SymphonyWorkClosureEvidence | null {
  if (closures === undefined) return null;
  return (
    closures.find((closure) =>
      closureCoversAttempt(closure, workItemId, runAttemptId, startedAt),
    ) ?? null
  );
}

function hasConfirmedWorkItemClosure(
  closures: ReadonlyArray<SymphonyWorkClosureEvidence> | undefined,
  workItemId: WorkItemId,
  attempts: ReadonlyArray<SymphonyWorkAttempt>,
): boolean {
  if (closures === undefined) return false;
  return closures.some((closure) => {
    if (String(closure.workItemId) !== String(workItemId)) return false;
    if (closure.runAttemptId !== undefined) return false;
    const closureTime = positiveTimestamp(closure.observedAt);
    if (closureTime === null) return false;
    return attempts.every((attempt) => {
      const attemptTime = positiveTimestamp(attempt.startedAt);
      return attemptTime !== null && attemptTime <= closureTime;
    });
  });
}

function attemptOutcome(input: {
  readonly statuses: ReadonlyArray<RunAttemptStatus>;
  readonly workItemId: WorkItemId;
  readonly runAttemptId: RunAttemptId;
  readonly startedAt: string;
  readonly closures: ReadonlyArray<SymphonyWorkClosureEvidence> | undefined;
}): SymphonyWorkAttemptOutcome {
  if (input.statuses.length === 0) {
    return { state: "unknown", reason: "No status evidence was loaded." };
  }
  const distinct = new Set(input.statuses);
  if (distinct.size > 1) {
    return { state: "unknown", reason: "Conflicting status evidence was loaded." };
  }
  const status = input.statuses[0];
  if (status === undefined) {
    return { state: "unknown", reason: "No status evidence was loaded." };
  }
  if (ACTIVE_RUN_STATUSES.has(status)) return { state: "active" };
  if (status === "succeeded") return { state: "succeeded" };
  if (FAILED_RUN_STATUSES.has(status)) return { state: "failed" };
  if (STOPPED_RUN_STATUSES.has(status)) {
    return closureFor(input.closures, input.workItemId, input.runAttemptId, input.startedAt) ===
      null
      ? {
          state: "stop_requested",
          reason:
            "A stop was recorded, but no authoritative process closure was supplied; the old process may still be running.",
        }
      : { state: "stopped" };
  }
  return { state: "unknown", reason: `Unmapped run status: ${status}` };
}

function buildAttempts(input: {
  readonly workItemId: WorkItemId;
  readonly runs: SymphonyWorkEvidence<SymphonyWorkRunFacts> | undefined;
  readonly explicitCurrentRunAttemptId: RunAttemptId | undefined;
  readonly attentionByAttempt: ReadonlyMap<string, ReadonlyArray<AttentionItemId>>;
  readonly closures: ReadonlyArray<SymphonyWorkClosureEvidence> | undefined;
  readonly contradictions: SymphonyWorkContradiction[];
}): SymphonyWorkAttempts {
  const facts = input.runs?.state === "known" ? input.runs.value.runs : [];
  const coverage =
    input.runs?.state === "known"
      ? input.runs.value.coverage
      : unknownCoverage("Run attempts were not loaded for this item.");

  const grouped = new Map<string, SymphonyWorkAttemptFact[]>();
  for (const fact of facts) {
    const key = String(fact.runAttemptId);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [fact]);
    } else {
      existing.push(fact);
    }
  }

  const attempts: SymphonyWorkAttempt[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const statuses = [...new Set(group.map((entry) => entry.status))];
    const conflictingNumbers = new Set(group.map((entry) => entry.attemptNumber));
    if (statuses.length > 1 || conflictingNumbers.size > 1) {
      input.contradictions.push({
        code: "duplicate_attempt_evidence",
        workItemId: input.workItemId,
        runAttemptId: first.runAttemptId,
        detail:
          "The same run attempt was loaded with conflicting status or attempt-number evidence.",
      });
    }
    const attentionItemIds = input.attentionByAttempt.get(String(first.runAttemptId)) ?? [];
    attempts.push({
      runAttemptId: first.runAttemptId,
      workItemId: first.workItemId,
      attemptNumber: first.attemptNumber,
      status: statuses.length === 1 ? (statuses[0] ?? null) : null,
      statuses,
      outcome: attemptOutcome({
        statuses,
        workItemId: input.workItemId,
        runAttemptId: first.runAttemptId,
        startedAt: first.startedAt,
        closures: input.closures,
      }),
      isCurrent:
        input.explicitCurrentRunAttemptId !== undefined &&
        String(input.explicitCurrentRunAttemptId) === String(first.runAttemptId),
      startedAt: first.startedAt,
      finishedAt: first.finishedAt ?? null,
      provider: first.provider ?? null,
      model: first.model ?? null,
      attentionItemIds,
      hasOutstandingAttention: attentionItemIds.length > 0,
    });
  }

  attempts.sort(
    (left, right) =>
      right.attemptNumber - left.attemptNumber ||
      right.startedAt.localeCompare(left.startedAt) ||
      String(right.runAttemptId).localeCompare(String(left.runAttemptId)),
  );

  const current =
    input.explicitCurrentRunAttemptId === undefined
      ? null
      : (attempts.find(
          (attempt) => String(attempt.runAttemptId) === String(input.explicitCurrentRunAttemptId),
        ) ?? null);

  let currentState: SymphonyWorkAttempts["currentState"];
  let currentReason: string | null;
  if (input.explicitCurrentRunAttemptId !== undefined) {
    if (current !== null) {
      currentState = "known";
      currentReason = null;
    } else {
      currentState = "unknown";
      currentReason =
        "The current attempt is not present in the loaded run evidence; history is not promoted to current.";
    }
  } else if (attempts.length === 0) {
    if (coverage.state === "exhaustive") {
      currentState = "none";
      currentReason = null;
    } else {
      currentState = "unknown";
      currentReason =
        "No attempts were observed, but run-history completeness is not reported; absence is not an empty history.";
    }
  } else {
    currentState = "unknown";
    currentReason =
      "No current attempt identity was reported; attempts are shown as history rather than choosing a latest.";
  }

  const outstanding = attempts.filter(
    (attempt) => attempt.outcome.state === "active" || attempt.hasOutstandingAttention,
  );
  return {
    current,
    currentState,
    currentReason,
    history: attempts,
    outstanding,
    olderOutstanding: outstanding.filter((attempt) => !attempt.isCurrent),
    coverage,
    freshness: freshnessOf(input.runs, "Run attempts were not loaded for this item."),
  };
}

function resolveLifecycle(input: {
  readonly card: SymphonyWorkEvidence<SymphonyBoardCard> | undefined;
  readonly workItem: SymphonyWorkEvidence<WorkItem> | undefined;
  readonly refusal: SymphonyWorkRefusal | undefined;
  readonly hasPositiveOwnership: boolean;
  readonly contradictions: SymphonyWorkContradiction[];
}): {
  readonly lifecycle: SymphonyWorkLifecycle;
  readonly evidence: SymphonyWorkEvidenceStatus;
  readonly freshness: SymphonyWorkFreshness;
} {
  const card = input.card?.state === "known" ? input.card.value : null;
  const workItem = input.workItem?.state === "known" ? input.workItem.value : null;

  if (card !== null && workItem !== null && card.lifecycle !== workItem.lifecycle) {
    input.contradictions.push({
      code: "lifecycle_mismatch",
      workItemId: card.workItemId,
      detail: `The board reports ${card.lifecycle} while the durable work item reports ${workItem.lifecycle}.`,
    });
  }

  const rawLifecycle = card?.lifecycle ?? workItem?.lifecycle ?? null;
  const freshness =
    card !== null
      ? freshnessOf(input.card, "The board card was not loaded.")
      : workItem !== null
        ? freshnessOf(input.workItem, "The durable work item was not loaded.")
        : input.card?.state === "unavailable" || input.workItem?.state === "unavailable"
          ? {
              state: "unknown" as const,
              reason: "The current work record could not be read.",
            }
          : {
              state: "unknown" as const,
              reason: "No current work record was loaded.",
            };

  if (rawLifecycle === null) {
    return {
      lifecycle: {
        phase: "unknown",
        lifecycle: null,
        reason:
          freshness.state === "fresh" ? "No current work record was loaded." : freshness.reason,
      },
      evidence:
        input.card?.state === "unavailable" || input.workItem?.state === "unavailable"
          ? "unavailable"
          : "unknown",
      freshness,
    };
  }

  const refusedAdmission =
    input.refusal?.priorLifecycle !== undefined &&
    TERMINAL_LIFECYCLES.has(input.refusal.priorLifecycle) &&
    MANUALLY_DISPATCHABLE_LIFECYCLES.has(rawLifecycle);

  if (refusedAdmission && !input.hasPositiveOwnership) {
    return {
      lifecycle: {
        phase: "not_started",
        lifecycle: rawLifecycle,
        reason: "refused",
        detail: input.refusal?.detail ?? null,
      },
      evidence: "known",
      freshness,
    };
  }

  if (TERMINAL_LIFECYCLES.has(rawLifecycle)) {
    return {
      lifecycle: {
        phase: "finished",
        lifecycle: rawLifecycle,
        outcome: rawLifecycle as "completed" | "cancelled" | "failed",
      },
      evidence: "known",
      freshness,
    };
  }

  if (NOT_STARTED_LIFECYCLES.has(rawLifecycle)) {
    const detail =
      input.refusal?.detail ??
      (rawLifecycle === "ineligible"
        ? (card?.eligibilityReasons ?? workItem?.eligibilityReasons ?? []).join("; ")
        : null);
    return {
      lifecycle: {
        phase: "not_started",
        lifecycle: rawLifecycle,
        reason:
          input.refusal !== undefined
            ? "refused"
            : rawLifecycle === "draft"
              ? "draft"
              : "ineligible",
        detail: detail === null || detail.length === 0 ? null : detail,
      },
      evidence: "known",
      freshness,
    };
  }

  return {
    lifecycle: { phase: "in_progress", lifecycle: rawLifecycle },
    evidence: "known",
    freshness,
  };
}

function projectAttention(input: {
  readonly workItemId: WorkItemId;
  readonly projectId: SymphonyProjectId | undefined;
  readonly attention: SymphonyWorkEvidence<SymphonyWorkAttentionFacts> | undefined;
  readonly attemptIds: ReadonlySet<string>;
  readonly contradictions: SymphonyWorkContradiction[];
}): SymphonyWorkAttention {
  if (input.attention === undefined) {
    return {
      state: "unknown",
      reason: "Attention was not loaded for this item.",
      coverage: unknownCoverage("Attention was not loaded for this item."),
    };
  }
  if (input.attention.state === "unavailable") {
    return {
      state: "unavailable",
      reason: input.attention.reason,
      retryable: input.attention.retryable,
    };
  }
  if (input.attention.state === "unknown") {
    return {
      state: "unknown",
      reason: input.attention.reason,
      coverage: unknownCoverage(input.attention.reason),
    };
  }

  const facts = input.attention.value;
  const matching: AttentionItem[] = [];
  const seen = new Set<string>();
  for (const item of facts.items) {
    if (String(item.workItemId) !== String(input.workItemId)) continue;
    if (
      item.projectId !== undefined &&
      input.projectId !== undefined &&
      String(item.projectId) !== String(input.projectId)
    ) {
      input.contradictions.push({
        code: "project_mismatch",
        workItemId: input.workItemId,
        detail: `Attention item ${String(item.id)} belongs to project ${String(item.projectId)}.`,
      });
      continue;
    }
    const key = String(item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.state === "open") matching.push(item);
  }

  if (matching.length > 0) {
    return {
      state: "needs_attention",
      items: matching.map((item) => attentionEntry({ item, attemptIds: input.attemptIds })),
      coverage: facts.coverage,
    };
  }
  if (facts.coverage.state === "exhaustive") {
    return { state: "none", coverage: facts.coverage };
  }
  return {
    state: "unknown",
    reason:
      "No open requests were observed, but attention completeness is not reported; absence is not a known empty queue.",
    coverage: facts.coverage,
  };
}

function firstStale(
  sources: ReadonlyArray<{ readonly name: string; readonly freshness: SymphonyWorkFreshness }>,
): { readonly name: string; readonly reason: string } | null {
  for (const source of sources) {
    if (source.freshness.state === "stale") {
      return { name: source.name, reason: source.freshness.reason };
    }
  }
  return null;
}

function resolveOwnership(input: {
  readonly lifecycle: SymphonyWorkLifecycle;
  readonly lifecycleFreshness: SymphonyWorkFreshness;
  readonly runsFreshness: SymphonyWorkFreshness;
  readonly attempts: SymphonyWorkAttempts;
  readonly pendingDispatch: SymphonyWorkPendingDispatch | null;
  readonly hasContradictions: boolean;
  readonly hasUnconfirmedCancellation: boolean;
}): SymphonyWorkOwnership {
  if (input.pendingDispatch !== null) {
    return {
      state: "unknown",
      reason: "A dispatch request has no observed acknowledgement.",
    };
  }
  if (input.lifecycle.phase === "unknown") {
    return {
      state: "unknown",
      reason: "No authoritative lifecycle was loaded, so ownership cannot be established.",
    };
  }
  if (input.lifecycleFreshness.state !== "fresh") {
    return {
      state: "unknown",
      reason:
        "The lifecycle source is not fresh; last-known lifecycle does not establish ownership.",
    };
  }
  const active = input.attempts.history.filter((attempt) => attempt.outcome.state === "active");
  if (active.length > 0) {
    return { state: "admitted", reason: "An exact attempt is observed as active." };
  }
  if (input.attempts.history.some((attempt) => attempt.outcome.state === "stop_requested")) {
    return {
      state: "unknown",
      reason:
        "A stop was recorded without authoritative process closure; the old process may still be running.",
    };
  }
  if (input.hasUnconfirmedCancellation) {
    return {
      state: "unknown",
      reason:
        "The cancellation outcome is recorded without authoritative process closure; the old process may still be running.",
    };
  }
  if (input.hasContradictions) {
    return {
      state: "unknown",
      reason: "Contradictory ownership evidence must be reconciled before start is authorised.",
    };
  }
  if (input.lifecycle.phase === "in_progress") {
    return { state: "admitted", reason: "The server reports admitted or observed work." };
  }
  if (input.runsFreshness.state !== "fresh") {
    return {
      state: "unknown",
      reason:
        "Run history is not fresh; capped or failed reads cannot prove earlier ownership ended.",
    };
  }
  if (input.attempts.coverage.state !== "exhaustive") {
    return {
      state: "unknown",
      reason:
        "Run history coverage is incomplete; a capped absence cannot prove an earlier process closed.",
    };
  }
  return {
    state: "none_observed",
    reason: "Known exhaustive run history reports no outstanding execution admission.",
  };
}

function startAction(input: {
  readonly kind: "start" | "run_again";
  readonly lifecycle: SymphonyWorkLifecycle;
  readonly freshness: SymphonyWorkItemProjection["freshness"];
  readonly workItem: WorkItem | null;
  readonly card: SymphonyBoardCard | null;
  readonly attention: SymphonyWorkAttention;
  readonly attempts: SymphonyWorkAttempts;
  readonly ownership: SymphonyWorkOwnership;
  readonly pendingDispatch: SymphonyWorkPendingDispatch | null;
  readonly refusal: SymphonyWorkRefusal | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: SymphonyProjectId | undefined;
  readonly workItemId: WorkItemId;
}): SymphonyWorkAction {
  const base = {
    kind: input.kind,
    environmentId: input.environmentId,
    projectId: input.projectId ?? null,
    workItemId: input.workItemId,
  } as const;
  const blocked = (reason: string): SymphonyWorkAction => ({ ...base, state: "blocked", reason });
  const unknown = (reason: string): SymphonyWorkAction => ({ ...base, state: "unknown", reason });

  if (input.lifecycle.phase === "unknown") {
    return unknown(input.lifecycle.reason);
  }
  const stale = firstStale([
    { name: "lifecycle", freshness: input.freshness.lifecycle },
    { name: "run history", freshness: input.freshness.runs },
    { name: "attention", freshness: input.freshness.attention },
  ]);
  if (stale !== null) {
    return unknown(
      `The ${stale.name} source is stale after a failed read: ${stale.reason} Refresh before starting.`,
    );
  }
  if (input.pendingDispatch !== null) {
    return unknown(
      "A dispatch request was sent, but no authoritative acknowledgement has been observed.",
    );
  }
  const actionableAttention =
    input.attention.state === "needs_attention" &&
    input.attention.items.some((entry) => entry.mode !== "info");
  if (actionableAttention) {
    return blocked(
      "An outstanding request needs a response before another attempt can be started.",
    );
  }
  if (input.attempts.olderOutstanding.length > 0) {
    return blocked(
      "An older attempt still has active work or an outstanding request; reconcile it before starting again.",
    );
  }
  if (input.attempts.history.some((attempt) => attempt.outcome.state === "active")) {
    return blocked("An attempt is still observed as active for this item.");
  }
  if (input.attempts.history.some((attempt) => attempt.outcome.state === "stop_requested")) {
    return unknown(
      "A stop was requested but process closure is not confirmed. Refresh or reconcile before starting again.",
    );
  }
  if (input.ownership.state === "unknown") {
    return unknown(`${input.ownership.reason} Refresh or reconcile before starting.`);
  }
  if (input.attempts.coverage.state !== "exhaustive") {
    return unknown(
      "Run history coverage is incomplete; a capped absence cannot prove earlier ownership ended. Refresh or reconcile before starting.",
    );
  }
  if (input.attention.state === "unknown" || input.attention.state === "unavailable") {
    return unknown(
      "Attention evidence is not available; a pending request cannot be ruled out. Refresh before starting.",
    );
  }
  if (input.workItem?.excluded === true) {
    return blocked("This item is excluded from Symphony work. Include it before running it.");
  }
  if (input.workItem?.blocked === true) {
    return blocked("The work item is marked blocked.");
  }
  const eligibilityReasons =
    input.card?.eligibilityReasons ?? input.workItem?.eligibilityReasons ?? [];
  if (eligibilityReasons.length > 0) {
    return blocked(`Not eligible: ${eligibilityReasons.join("; ")}`);
  }

  if (input.lifecycle.phase === "finished") {
    return input.lifecycle.outcome === "completed"
      ? blocked("The item is completed; start a new work item instead.")
      : {
          ...base,
          state: "available",
          reason: "Known terminal evidence and exhaustive run history allow an explicit retry.",
        };
  }
  if (input.lifecycle.phase === "not_started") {
    switch (input.lifecycle.reason) {
      case "draft":
        return blocked("The item is a draft and has not been admitted for execution.");
      case "ineligible":
        return blocked(
          input.lifecycle.detail === null
            ? "The item is not eligible for dispatch."
            : `Not eligible: ${input.lifecycle.detail}`,
        );
      case "refused":
        return {
          ...base,
          state: "available",
          reason:
            input.refusal === null
              ? "The last dispatch was refused. The row remains Not started until the server accepts it."
              : `The last dispatch was refused (${input.refusal.reason})${
                  input.refusal.detail === undefined ? "." : `: ${input.refusal.detail}.`
                } The row remains Not started until the server accepts it.`,
        };
    }
  }
  return MANUALLY_DISPATCHABLE_LIFECYCLES.has(input.lifecycle.lifecycle)
    ? {
        ...base,
        state: "available",
        reason:
          input.refusal === null
            ? "The server can start this admitted item now."
            : `The server can recheck this admitted item; the last command was refused (${input.refusal.reason}).`,
      }
    : blocked("The item is already admitted; wait for its current stage or resolve attention.");
}

function cancelActions(input: {
  readonly attempts: SymphonyWorkAttempts;
  readonly environmentId: EnvironmentId;
  readonly projectId: SymphonyProjectId | undefined;
  readonly workItemId: WorkItemId;
}): SymphonyWorkAction[] {
  const base = {
    kind: "cancel",
    environmentId: input.environmentId,
    projectId: input.projectId ?? null,
    workItemId: input.workItemId,
  } as const;
  const stale = input.attempts.freshness.state === "stale";
  return input.attempts.history
    .filter((attempt) => attempt.outcome.state === "active")
    .map((attempt) => ({
      ...base,
      runAttemptId: attempt.runAttemptId,
      state: stale ? ("unknown" as const) : ("available" as const),
      reason: stale
        ? "The run history is stale after a failed read; refresh before cancelling."
        : "The exact active attempt can be asked to cancel.",
    }));
}

function attentionActions(input: {
  readonly entries: ReadonlyArray<SymphonyWorkAttentionEntry>;
  readonly freshness: SymphonyWorkFreshness;
  readonly environmentId: EnvironmentId;
  readonly projectId: SymphonyProjectId | undefined;
  readonly workItemId: WorkItemId;
}): SymphonyWorkAction[] {
  const actions: SymphonyWorkAction[] = [];
  const stale = input.freshness.state === "stale";
  for (const entry of input.entries) {
    const base = {
      environmentId: input.environmentId,
      projectId: input.projectId ?? null,
      workItemId: input.workItemId,
      attentionItemId: entry.item.id,
      ...(entry.runAttemptId === null ? {} : { runAttemptId: entry.runAttemptId }),
    } as const;
    const reason = stale
      ? `The attention source is stale after a failed read: ${input.freshness.state === "stale" ? input.freshness.reason : "unknown"} Refresh before responding.`
      : null;
    if (entry.mode === "question" && entry.item.availableActions.includes("answer")) {
      actions.push({
        ...base,
        kind: "answer",
        state: stale ? "unknown" : "available",
        reason: reason ?? "The agent is waiting for an answer.",
      });
    }
    if (entry.mode === "approval" && entry.item.availableActions.includes("approve")) {
      actions.push({
        ...base,
        kind: "approve",
        state: stale ? "unknown" : "available",
        reason: reason ?? "The request is waiting for an approval decision.",
      });
    }
    if (entry.mode === "approval" && entry.item.availableActions.includes("reject")) {
      actions.push({
        ...base,
        kind: "reject",
        state: stale ? "unknown" : "available",
        reason: reason ?? "The request can be rejected.",
      });
    }
  }
  return actions;
}

function observedTarget(input: {
  readonly current: SymphonyWorkAttempt | null;
  readonly history: ReadonlyArray<SymphonyWorkAttempt>;
  readonly workItem: WorkItem | null;
}): SymphonyWorkObservedTarget {
  const attempt = input.current ?? input.history[0] ?? null;
  if (attempt !== null) {
    return {
      scope: "current_observation",
      source: attempt.isCurrent ? "current_attempt" : "historical_attempt",
      workspacePath: input.workItem?.workspacePath ?? null,
      provider: attempt.provider,
      model: attempt.model,
      observedAt: attempt.startedAt,
    };
  }
  if (input.workItem !== null) {
    return {
      scope: "current_observation",
      source: "work_item",
      workspacePath: input.workItem.workspacePath ?? null,
      provider: input.workItem.provider ?? null,
      model: null,
      observedAt: input.workItem.updatedAt,
    };
  }
  return {
    scope: "current_observation",
    source: "none",
    workspacePath: null,
    provider: null,
    model: null,
    observedAt: null,
  };
}

export function projectSymphonyWorkItem(input: SymphonyWorkItemInput): SymphonyWorkItemProjection {
  const contradictions: SymphonyWorkContradiction[] = [];

  const rawCard = input.card?.state === "known" ? input.card.value : null;
  const card =
    rawCard !== null && String(rawCard.workItemId) === String(input.workItemId) ? rawCard : null;
  if (rawCard !== null && card === null) {
    contradictions.push({
      code: "identity_mismatch",
      workItemId: input.workItemId,
      detail: `The board card identifies ${String(rawCard.workItemId)} instead of ${String(input.workItemId)}.`,
    });
  }
  if (
    card !== null &&
    input.projectId !== undefined &&
    String(card.projectId) !== String(input.projectId)
  ) {
    contradictions.push({
      code: "project_mismatch",
      workItemId: input.workItemId,
      detail: `The board card belongs to project ${String(card.projectId)}.`,
    });
  }

  const rawWorkItem = input.workItem?.state === "known" ? input.workItem.value : null;
  const workItem =
    rawWorkItem !== null && String(rawWorkItem.id) === String(input.workItemId)
      ? rawWorkItem
      : null;
  if (rawWorkItem !== null && workItem === null) {
    contradictions.push({
      code: "identity_mismatch",
      workItemId: input.workItemId,
      detail: `The durable work item identifies ${String(rawWorkItem.id)}.`,
    });
  }
  if (
    workItem !== null &&
    input.projectId !== undefined &&
    workItem.projectId !== undefined &&
    String(workItem.projectId) !== String(input.projectId)
  ) {
    contradictions.push({
      code: "project_mismatch",
      workItemId: input.workItemId,
      detail: `The durable work item belongs to project ${String(workItem.projectId)}.`,
    });
  }

  const cardEvidence: SymphonyWorkEvidence<SymphonyBoardCard> | undefined =
    input.card === undefined
      ? undefined
      : input.card.state !== "known"
        ? input.card
        : card === null
          ? {
              state: "unknown",
              reason: "The board card identity did not match this work item.",
            }
          : { ...input.card, value: card };
  const workItemEvidence: SymphonyWorkEvidence<WorkItem> | undefined =
    input.workItem === undefined
      ? undefined
      : input.workItem.state !== "known"
        ? input.workItem
        : workItem === null
          ? {
              state: "unknown",
              reason: "The durable work item identity did not match this work item.",
            }
          : { ...input.workItem, value: workItem };

  const projectId = input.projectId ?? card?.projectId ?? workItem?.projectId ?? undefined;
  const runs = input.runs;
  const runFacts = runs?.state === "known" ? runs.value.runs : [];
  const attentionFacts = input.attention?.state === "known" ? input.attention.value.items : [];

  const filteredRuns: SymphonyWorkAttemptFact[] = [];
  for (const fact of runFacts) {
    if (String(fact.workItemId) !== String(input.workItemId)) continue;
    if (
      fact.projectId !== undefined &&
      projectId !== undefined &&
      String(fact.projectId) !== String(projectId)
    ) {
      contradictions.push({
        code: "project_mismatch",
        workItemId: input.workItemId,
        runAttemptId: fact.runAttemptId,
        detail: `Run attempt ${String(fact.runAttemptId)} belongs to project ${String(fact.projectId)}.`,
      });
      continue;
    }
    filteredRuns.push(fact);
  }

  const explicitCurrentRunAttemptId = input.currentRunAttemptId ?? card?.latestRunAttemptId;
  if (
    input.currentRunAttemptId !== undefined &&
    card?.latestRunAttemptId !== undefined &&
    String(input.currentRunAttemptId) !== String(card.latestRunAttemptId)
  ) {
    contradictions.push({
      code: "current_attempt_mismatch",
      workItemId: input.workItemId,
      runAttemptId: input.currentRunAttemptId,
      detail: "The explicit current attempt differs from the board's latest attempt.",
    });
  }

  const attentionByAttempt = new Map<string, AttentionItemId[]>();
  for (const item of attentionFacts) {
    if (String(item.workItemId) !== String(input.workItemId)) continue;
    if (
      item.projectId !== undefined &&
      projectId !== undefined &&
      String(item.projectId) !== String(projectId)
    ) {
      continue;
    }
    if (item.state !== "open" || item.runAttemptId === undefined) continue;
    const key = String(item.runAttemptId);
    const existing = attentionByAttempt.get(key);
    if (existing === undefined) {
      attentionByAttempt.set(key, [item.id]);
    } else {
      existing.push(item.id);
    }
  }

  const filteredRunEvidence: SymphonyWorkEvidence<SymphonyWorkRunFacts> | undefined =
    runs === undefined
      ? undefined
      : runs.state === "known"
        ? {
            state: "known",
            value: { runs: filteredRuns, coverage: runs.value.coverage },
            ...(runs.staleReason === undefined ? {} : { staleReason: runs.staleReason }),
          }
        : runs;

  const attempts = buildAttempts({
    workItemId: input.workItemId,
    runs: filteredRunEvidence,
    explicitCurrentRunAttemptId,
    attentionByAttempt,
    closures: input.closures,
    contradictions,
  });

  const attention = projectAttention({
    workItemId: input.workItemId,
    projectId,
    attention: input.attention,
    attemptIds: new Set(attempts.history.map((attempt) => String(attempt.runAttemptId))),
    contradictions,
  });

  const activeAttempts = attempts.history.filter((attempt) => attempt.outcome.state === "active");
  const stopRequestedAttempts = attempts.history.filter(
    (attempt) => attempt.outcome.state === "stop_requested",
  );
  const unresolvedStopAttempts = stopRequestedAttempts.filter(
    (stop) =>
      !attempts.history.some(
        (other) =>
          String(other.runAttemptId) !== String(stop.runAttemptId) &&
          (other.attemptNumber > stop.attemptNumber ||
            (other.attemptNumber === stop.attemptNumber && other.startedAt > stop.startedAt)) &&
          other.outcome.state === "succeeded",
      ),
  );
  const hasUnresolvedStop = unresolvedStopAttempts.length > 0;
  const hasPositiveOwnership =
    activeAttempts.length > 0 ||
    hasUnresolvedStop ||
    attempts.outstanding.length > 0 ||
    attention.state === "needs_attention";

  if (attempts.olderOutstanding.some((attempt) => attempt.outcome.state === "active")) {
    contradictions.push({
      code: "active_attempt_behind_latest",
      workItemId: input.workItemId,
      detail:
        "An older attempt is active behind the current attempt; the latest attempt does not prove ownership.",
    });
  }
  if (attempts.outstanding.length > 1) {
    contradictions.push({
      code: "multiple_outstanding_attempts",
      workItemId: input.workItemId,
      detail:
        "More than one attempt has active work or an outstanding request; the latest attempt does not hide the others.",
    });
  }

  const resolved = resolveLifecycle({
    card: cardEvidence,
    workItem: workItemEvidence,
    refusal: input.refusal,
    hasPositiveOwnership,
    contradictions,
  });

  if (resolved.lifecycle.phase === "finished" && activeAttempts.length > 0) {
    contradictions.push({
      code: "active_attempt_after_terminal_lifecycle",
      workItemId: input.workItemId,
      runAttemptId: activeAttempts[0]?.runAttemptId,
      detail: "The item lifecycle is terminal but an attempt is still observed as active.",
    });
  }
  if (resolved.lifecycle.phase === "not_started" && activeAttempts.length > 0) {
    contradictions.push({
      code: "run_observed_for_not_started_item",
      workItemId: input.workItemId,
      runAttemptId: activeAttempts[0]?.runAttemptId,
      detail: "The item lifecycle is not started but an attempt is observed as active.",
    });
  }

  const freshness = {
    card: freshnessOf(cardEvidence, "The board card was not loaded."),
    lifecycle: resolved.freshness,
    runs: attempts.freshness,
    attention: freshnessOf(input.attention, "Attention was not loaded for this item."),
  } as const;

  const hasConfirmedStop =
    attempts.history.some((attempt) => attempt.outcome.state === "stopped") ||
    hasConfirmedWorkItemClosure(input.closures, input.workItemId, attempts.history);
  const hasUnconfirmedCancellation =
    resolved.lifecycle.phase === "finished" &&
    resolved.lifecycle.outcome === "cancelled" &&
    (hasUnresolvedStop || !hasConfirmedStop);

  const execution: SymphonyWorkExecution =
    activeAttempts.length > 0
      ? "observed"
      : stopRequestedAttempts.length > 0 || hasUnconfirmedCancellation
        ? "unknown"
        : resolved.lifecycle.phase === "unknown"
          ? "unknown"
          : resolved.lifecycle.phase === "in_progress" &&
              EXECUTING_LIFECYCLES.has(resolved.lifecycle.lifecycle)
            ? "observed"
            : "not_observed";

  const reconciliation =
    input.pendingDispatch !== undefined ||
    stopRequestedAttempts.length > 0 ||
    hasUnconfirmedCancellation ||
    contradictions.length > 0;

  const ownership = resolveOwnership({
    lifecycle: resolved.lifecycle,
    lifecycleFreshness: resolved.freshness,
    runsFreshness: attempts.freshness,
    attempts,
    pendingDispatch: input.pendingDispatch ?? null,
    hasContradictions: contradictions.length > 0,
    hasUnconfirmedCancellation,
  });

  const startKind: "start" | "run_again" =
    (resolved.lifecycle.phase === "finished" &&
      RUN_AGAIN_LIFECYCLES.has(resolved.lifecycle.lifecycle)) ||
    (resolved.lifecycle.phase === "in_progress" &&
      RUN_AGAIN_LIFECYCLES.has(resolved.lifecycle.lifecycle))
      ? "run_again"
      : "start";

  const start = startAction({
    kind: startKind,
    lifecycle: resolved.lifecycle,
    freshness,
    workItem,
    card,
    attention,
    attempts,
    ownership,
    pendingDispatch: input.pendingDispatch ?? null,
    refusal: input.refusal ?? null,
    environmentId: input.environmentId,
    projectId,
    workItemId: input.workItemId,
  });

  const actions = [
    start,
    ...cancelActions({
      attempts,
      environmentId: input.environmentId,
      projectId,
      workItemId: input.workItemId,
    }),
    ...attentionActions({
      entries: attention.state === "needs_attention" ? attention.items : [],
      freshness: freshness.attention,
      environmentId: input.environmentId,
      projectId,
      workItemId: input.workItemId,
    }),
  ];

  const membership: SymphonyWorkMembership = {
    all: resolved.lifecycle.phase !== "finished" || reconciliation,
    notStarted: resolved.lifecycle.phase === "not_started",
    inProgress:
      resolved.lifecycle.phase === "in_progress" ||
      input.pendingDispatch !== undefined ||
      hasUnconfirmedCancellation ||
      hasUnresolvedStop ||
      (reconciliation && activeAttempts.length > 0),
    needsAttention:
      attention.state === "needs_attention" ||
      input.pendingDispatch !== undefined ||
      hasUnconfirmedCancellation ||
      hasUnresolvedStop ||
      contradictions.length > 0,
    history: resolved.lifecycle.phase === "finished",
    reconciliation,
  };

  const title = card?.title ?? workItem?.objective ?? null;
  const trackerIdentifier = card?.trackerIdentifier ?? workItem?.trackerIdentifier ?? null;
  const issueUrl =
    card?.issueUrl ??
    (workItem !== null && workItem.source.kind !== "manual" ? workItem.source.externalUrl : null);

  return {
    identity: {
      environmentId: input.environmentId,
      projectId: projectId ?? null,
      workItemId: input.workItemId,
      trackerIdentifier,
      title,
      issueUrl,
    },
    lifecycle: resolved.lifecycle,
    execution,
    ownership,
    attention,
    attempts,
    actions,
    evidence: {
      lifecycle: resolved.evidence,
      runs: evidenceStatus(runs),
      attention: evidenceStatus(input.attention),
    },
    freshness,
    contradictions,
    membership,
    observedTarget: observedTarget({
      current: attempts.current,
      history: attempts.history,
      workItem,
    }),
    pendingDispatch: input.pendingDispatch ?? null,
    refusal: input.refusal ?? null,
  };
}

function dedupeCards(
  cards: ReadonlyArray<SymphonyBoardCard>,
  contradictions: SymphonyWorkContradiction[],
): SymphonyBoardCard[] {
  const byWorkItem = new Map<string, SymphonyBoardCard>();
  for (const card of cards) {
    const key = String(card.workItemId);
    const existing = byWorkItem.get(key);
    if (existing === undefined) {
      byWorkItem.set(key, card);
      continue;
    }
    contradictions.push({
      code: "duplicate_work_item_card",
      workItemId: card.workItemId,
      detail: `The board returned more than one card for this item (${existing.lifecycle} and ${card.lifecycle}).`,
    });
  }
  return [...byWorkItem.values()];
}

function dispatchFor(
  dispatch: SymphonyWorkDispatchFacts | undefined,
  workItemId: WorkItemId,
): {
  readonly pending: SymphonyWorkPendingDispatch | undefined;
  readonly refusal: SymphonyWorkRefusal | undefined;
} {
  if (dispatch === undefined) return { pending: undefined, refusal: undefined };
  const pending = dispatch.pending.find((entry) => String(entry.workItemId) === String(workItemId));
  const refusal = dispatch.refusals.find(
    (entry) => String(entry.workItemId) === String(workItemId),
  );
  const pendingDispatch =
    pending === undefined
      ? undefined
      : pending.requestedAt === undefined
        ? {}
        : { requestedAt: pending.requestedAt };
  return { pending: pendingDispatch, refusal: refusal?.refusal };
}

function groupRuns(
  runs: ReadonlyArray<SymphonyWorkAttemptFact>,
  projectId: SymphonyProjectId,
  contradictions: SymphonyWorkContradiction[],
): {
  readonly byWorkItem: ReadonlyMap<string, ReadonlyArray<SymphonyWorkAttemptFact>>;
  readonly attemptIds: ReadonlySet<string>;
} {
  const byWorkItem = new Map<string, SymphonyWorkAttemptFact[]>();
  const attemptIds = new Set<string>();
  for (const fact of runs) {
    if (fact.projectId !== undefined && String(fact.projectId) !== String(projectId)) {
      contradictions.push({
        code: "project_mismatch",
        workItemId: fact.workItemId,
        runAttemptId: fact.runAttemptId,
        detail: `Run attempt ${String(fact.runAttemptId)} belongs to project ${String(fact.projectId)}.`,
      });
      continue;
    }
    attemptIds.add(String(fact.runAttemptId));
    const key = String(fact.workItemId);
    const existing = byWorkItem.get(key);
    if (existing === undefined) {
      byWorkItem.set(key, [fact]);
    } else {
      existing.push(fact);
    }
  }
  return { byWorkItem, attemptIds };
}

function groupAttention(
  items: ReadonlyArray<AttentionItem>,
  projectId: SymphonyProjectId,
  contradictions: SymphonyWorkContradiction[],
): {
  readonly byWorkItem: ReadonlyMap<string, ReadonlyArray<AttentionItem>>;
  readonly openByWorkItem: ReadonlyMap<string, ReadonlyArray<AttentionItem>>;
} {
  const byWorkItem = new Map<string, AttentionItem[]>();
  const openByWorkItem = new Map<string, AttentionItem[]>();
  const seen = new Set<string>();
  for (const item of items) {
    if (item.projectId !== undefined && String(item.projectId) !== String(projectId)) {
      contradictions.push({
        code: "project_mismatch",
        workItemId: item.workItemId,
        detail: `Attention item ${String(item.id)} belongs to project ${String(item.projectId)}.`,
      });
      continue;
    }
    const key = String(item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const workItemKey = String(item.workItemId);
    const existing = byWorkItem.get(workItemKey);
    if (existing === undefined) {
      byWorkItem.set(workItemKey, [item]);
    } else {
      existing.push(item);
    }
    if (item.state === "open") {
      const open = openByWorkItem.get(workItemKey);
      if (open === undefined) {
        openByWorkItem.set(workItemKey, [item]);
      } else {
        open.push(item);
      }
    }
  }
  return { byWorkItem, openByWorkItem };
}

export function projectSymphonyWorkCollection(
  input: SymphonyWorkCollectionInput,
): SymphonyWorkCollection {
  const contradictions: SymphonyWorkContradiction[] = [];
  const filter = input.filter ?? "all";
  const board = input.board.state === "known" ? input.board.value : null;
  const runFacts = input.runs.state === "known" ? input.runs.value.runs : [];
  const attentionFacts = input.attention.state === "known" ? input.attention.value.items : [];

  const cards =
    board === null
      ? []
      : dedupeCards(
          board.cards.filter((card) => {
            if (String(card.projectId) === String(input.projectId)) return true;
            contradictions.push({
              code: "project_mismatch",
              workItemId: card.workItemId,
              detail: `The board returned a card for project ${String(card.projectId)}.`,
            });
            return false;
          }),
          contradictions,
        );
  const cardIds = new Set(cards.map((card) => String(card.workItemId)));
  const runs = groupRuns(runFacts, input.projectId, contradictions);
  const attention = groupAttention(attentionFacts, input.projectId, contradictions);
  const boardFreshness = freshnessOf(input.board, "The project board was not read.");
  const runsFreshness = freshnessOf(input.runs, "Project runs were not read.");
  const attentionFreshness = freshnessOf(input.attention, "Attention was not read.");

  const items = cards.map((card) => {
    const key = String(card.workItemId);
    const dispatch = dispatchFor(input.dispatch, card.workItemId);
    const itemRuns = runs.byWorkItem.get(key) ?? [];
    const itemAttention = attention.byWorkItem.get(key) ?? [];
    const item = projectSymphonyWorkItem({
      environmentId: input.environmentId,
      workItemId: card.workItemId,
      projectId: input.projectId,
      card: {
        state: "known",
        value: card,
        ...(input.board.state === "known" && input.board.staleReason !== undefined
          ? { staleReason: input.board.staleReason }
          : {}),
      },
      currentRunAttemptId: card.latestRunAttemptId,
      runs:
        input.runs.state === "known"
          ? {
              state: "known",
              value: { runs: itemRuns, coverage: input.runs.value.coverage },
              ...(input.runs.staleReason === undefined
                ? {}
                : { staleReason: input.runs.staleReason }),
            }
          : input.runs,
      attention:
        input.attention.state === "known"
          ? {
              state: "known",
              value: { items: itemAttention, coverage: input.attention.value.coverage },
              ...(input.attention.staleReason === undefined
                ? {}
                : { staleReason: input.attention.staleReason }),
            }
          : input.attention,
      ...(dispatch.pending === undefined ? {} : { pendingDispatch: dispatch.pending }),
      ...(dispatch.refusal === undefined ? {} : { refusal: dispatch.refusal }),
      ...(input.closures === undefined ? {} : { closures: input.closures }),
    });
    contradictions.push(...item.contradictions);
    return item;
  });

  const unmatchedRuns: SymphonyWorkAttemptFact[] = [];
  for (const [workItemId, facts] of runs.byWorkItem) {
    if (cardIds.has(workItemId)) continue;
    unmatchedRuns.push(...facts);
  }

  const outsideBoard: SymphonyWorkAttentionEntry[] = [];
  for (const [workItemId, facts] of attention.openByWorkItem) {
    if (cardIds.has(workItemId)) continue;
    for (const item of facts) {
      outsideBoard.push(attentionEntry({ item, attemptIds: runs.attemptIds }));
    }
  }

  const visibleItems = items.filter((item) => {
    switch (filter) {
      case "all":
        return item.membership.all;
      case "not_started":
        return item.membership.notStarted;
      case "in_progress":
        return item.membership.inProgress;
      case "attention":
        return item.membership.needsAttention;
      case "history":
        return item.membership.history;
    }
  });
  const visibleIds = new Set(visibleItems.map((item) => String(item.identity.workItemId)));

  const boardCoverage = board?.coverage ?? unknownCoverage("The project board was not read.");
  const runsCoverage =
    input.runs.state === "known"
      ? input.runs.value.coverage
      : unknownCoverage("Run attempts were not read.");
  const attentionCoverage =
    input.attention.state === "known"
      ? input.attention.value.coverage
      : unknownCoverage("Attention was not read.");

  const itemsState: SymphonyWorkCountState =
    input.board.state === "known"
      ? boardCoverage.state === "exhaustive"
        ? "known"
        : "observed"
      : input.board.state === "unavailable"
        ? "unavailable"
        : "unknown";

  let attachedAttentionItems = 0;
  let needsAttentionWorkItems = 0;
  let outsideFilterItems = 0;
  let outsideFilterWorkItems = 0;
  let reconciliationWorkItems = 0;
  for (const item of items) {
    if (item.membership.reconciliation) reconciliationWorkItems += 1;
    if (item.attention.state === "needs_attention") {
      attachedAttentionItems += item.attention.items.length;
    }
    if (item.membership.needsAttention) {
      needsAttentionWorkItems += 1;
      if (!visibleIds.has(String(item.identity.workItemId))) {
        outsideFilterWorkItems += 1;
        outsideFilterItems +=
          item.attention.state === "needs_attention" ? item.attention.items.length : 0;
      }
    }
  }

  const attentionState: SymphonyWorkCountState =
    input.attention.state === "known"
      ? needsAttentionWorkItems > 0 || outsideBoard.length > 0
        ? "observed"
        : attentionCoverage.state === "exhaustive" && attentionFreshness.state === "fresh"
          ? "known"
          : "unknown"
      : input.attention.state === "unavailable"
        ? "unavailable"
        : "unknown";

  const outsideFilterState: SymphonyWorkCountState =
    input.attention.state === "known"
      ? outsideFilterWorkItems > 0
        ? "observed"
        : attentionCoverage.state === "exhaustive" && attentionFreshness.state === "fresh"
          ? "known"
          : "unknown"
      : input.attention.state === "unavailable"
        ? "unavailable"
        : "unknown";

  return {
    environmentId: input.environmentId,
    projectId: input.projectId,
    state:
      input.board.state === "known"
        ? "known"
        : input.board.state === "unavailable"
          ? "unavailable"
          : "unknown",
    filter,
    items,
    visibleItems,
    counts: {
      items: {
        state: itemsState,
        all: items.filter((item) => item.membership.all).length,
        notStarted: items.filter((item) => item.membership.notStarted).length,
        inProgress: items.filter((item) => item.membership.inProgress).length,
        history: items.filter((item) => item.membership.history).length,
        reconciliation: reconciliationWorkItems,
        coverage: boardCoverage,
        freshness: boardFreshness,
      },
      attention: {
        state: attentionState,
        workItems: needsAttentionWorkItems,
        items: attachedAttentionItems,
        outsideBoardWorkItems: new Set(outsideBoard.map((entry) => String(entry.item.workItemId)))
          .size,
        outsideBoardItems: outsideBoard.length,
        coverage: attentionCoverage,
        freshness: attentionFreshness,
      },
    },
    attentionOutsideFilter: {
      state: outsideFilterState,
      workItems: outsideFilterWorkItems,
      items: outsideFilterItems,
      coverage: attentionCoverage,
      freshness: attentionFreshness,
    },
    attentionOutsideBoard: outsideBoard,
    unmatchedRuns,
    contradictions,
    evidence: {
      board: evidenceStatus(input.board),
      runs: evidenceStatus(input.runs),
      attention: evidenceStatus(input.attention),
    },
    freshness: {
      board: boardFreshness,
      runs: runsFreshness,
      attention: attentionFreshness,
    },
    coverage: {
      board: boardCoverage,
      runs: runsCoverage,
      attention: attentionCoverage,
    },
  };
}

export const needsSymphonyWorkAttention = (
  attention: SymphonyWorkAttention,
): attention is Extract<SymphonyWorkAttention, { readonly state: "needs_attention" }> =>
  attention.state === "needs_attention";
