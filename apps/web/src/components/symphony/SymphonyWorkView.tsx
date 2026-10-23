import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import type {
  AttentionItem,
  EnvironmentId,
  SymphonyBoardCard,
  SymphonyProject,
  RunAttemptStatus,
  SymphonyProjectBoard,
  SymphonyProjectId,
  WorkItemId,
  WorkLifecycle,
} from "@neokod/contracts";
import { RunAttemptId, WorkLifecycleSchema } from "@neokod/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  projectSymphonyWorkItem,
  type SymphonyWorkAction,
  type SymphonyWorkAttempt,
  type SymphonyWorkAttentionEntry,
  type SymphonyWorkCollection,
  type SymphonyWorkDispatchFacts,
  type SymphonyWorkAttemptFact,
  type SymphonyWorkItemProjection,
  type SymphonyWorkRefusal,
} from "../../symphonyWork.logic";
import { useEnvironmentQuery } from "../../state/query";
import { useSymphonyProjectWork } from "../../state/symphonyWork";
import { symphonyEnvironment } from "../../state/symphony";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import {
  EMPTY_WORK_COUNTS,
  SymphonyWorkList,
  type SymphonyWorkCounts,
  type SymphonyWorkRow,
} from "./SymphonyWorkList";
import {
  ExactRequestActions,
  lifecycleLabel,
  SymphonyWorkDetail,
  stopAcknowledgementNote,
  workLifecyclePresentation,
  type SymphonyWorkRunAction,
} from "./SymphonyWorkDetail";
import { dispatchRefusalMessage } from "./dispatchRefusal.logic";
import { ACTIVE_RUN_STATUSES } from "./symphonyRuns.logic";
import type { WorkFilter } from "./symphonyProjectTabs";

const PENDING_DISPATCH_STORAGE_KEY = "neokod:symphony-work-pending-dispatch:v1";

const PendingDispatchEntrySchema = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  workItemId: Schema.String,
  lifecycle: Schema.NullOr(WorkLifecycleSchema),
  attemptId: Schema.NullOr(Schema.String),
  /** Local interaction timestamp, used only to distinguish a new attempt. */
  sentAt: Schema.String,
});
type PendingDispatchEntry = typeof PendingDispatchEntrySchema.Type;
const PendingDispatchEntriesSchema = Schema.Array(PendingDispatchEntrySchema);
const EMPTY_PENDING_DISPATCHES: PendingDispatchEntry[] = [];

interface RefusalSnapshot {
  readonly refusal: SymphonyWorkRefusal;
  readonly priorLifecycle: WorkLifecycle | null;
  readonly priorAttemptId: string | null;
  readonly recordedAt: string;
  readonly projectRevision: number;
  readonly projectStatus: SymphonyProject["status"];
}

const TERMINAL_REFUSAL_LIFECYCLES: ReadonlySet<WorkLifecycle> = new Set([
  "completed",
  "cancelled",
  "failed",
]);
const EXPECTED_REFUSAL_REQUEUE_LIFECYCLES: ReadonlySet<WorkLifecycle> = new Set([
  "queued",
  "retry_scheduled",
  "changes_requested",
  "validation_failed",
]);

/**
 * A refusal stays visible through the server's terminal -> queued requeue. A
 * refresh does not clear it; only a policy/attempt change or an authoritative
 * lifecycle outside that expected transition does.
 */
export const shouldClearWorkRefusal = (input: {
  readonly priorLifecycle: WorkLifecycle | null;
  readonly currentLifecycle: WorkLifecycle | null;
  readonly priorAttemptId: string | null;
  readonly currentAttemptId: string | null;
  readonly currentAttemptStartedAt: string | null;
  readonly recordedAt: string;
  readonly projectRevisionChanged: boolean;
  readonly projectStatusChanged: boolean;
}): boolean => {
  if (input.projectRevisionChanged || input.projectStatusChanged) return true;
  if (input.currentAttemptId !== null) {
    if (input.priorAttemptId !== null) {
      return input.currentAttemptId !== input.priorAttemptId;
    }
    return (
      input.currentAttemptStartedAt !== null &&
      new Date(input.currentAttemptStartedAt).getTime() > new Date(input.recordedAt).getTime()
    );
  }
  if (input.currentLifecycle === null) return false;
  if (
    input.priorLifecycle !== null &&
    TERMINAL_REFUSAL_LIFECYCLES.has(input.priorLifecycle) &&
    EXPECTED_REFUSAL_REQUEUE_LIFECYCLES.has(input.currentLifecycle)
  ) {
    return false;
  }
  return input.currentLifecycle !== input.priorLifecycle;
};

const lifecycleOf = (item: SymphonyWorkItemProjection): WorkLifecycle | null =>
  item.lifecycle.phase === "unknown" ? null : item.lifecycle.lifecycle;

const UNRESOLVED_UNMATCHED_RUN_STATUSES: ReadonlySet<RunAttemptStatus> = new Set([
  ...ACTIVE_RUN_STATUSES,
  "user_cancelled",
  "tracker_cancelled",
  "canceled_by_reconciliation",
  "interrupted",
]);

const attemptFactsFromProjection = (
  attempt: SymphonyWorkAttempt,
): ReadonlyArray<SymphonyWorkAttemptFact> => {
  const statuses =
    attempt.statuses.length > 0
      ? attempt.statuses
      : attempt.status === null
        ? []
        : [attempt.status];
  return statuses.map((status) => ({
    runAttemptId: attempt.runAttemptId,
    workItemId: attempt.workItemId,
    attemptNumber: attempt.attemptNumber,
    status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    ...(attempt.provider === null ? {} : { provider: attempt.provider }),
    ...(attempt.model === null ? {} : { model: attempt.model }),
  }));
};

const unknownNote = (item: SymphonyWorkItemProjection): string | undefined => {
  const notes: string[] = [];
  if (item.contradictions.length > 0) {
    notes.push(item.contradictions[0]?.detail ?? "Conflicting work records were reported.");
  }
  if (item.lifecycle.phase === "unknown") notes.push(item.lifecycle.reason);
  if (
    item.lifecycle.phase === "not_started" &&
    item.lifecycle.reason === "ineligible" &&
    item.lifecycle.detail !== null
  ) {
    notes.push(item.lifecycle.detail);
  }
  if (item.execution === "not_observed" && item.lifecycle.phase === "in_progress") {
    notes.push("Execution is not observed yet; this is not proof that nothing is running.");
  }
  if (item.pendingDispatch !== null) {
    notes.push("Dispatch acknowledgement unknown; reconcile before starting again.");
  }
  if (item.refusal !== null) {
    notes.push(dispatchRefusalMessage(item.refusal));
  }
  if (item.membership.reconciliation) {
    notes.push("This item needs reconciliation before its execution state is trusted.");
  }
  return notes.length === 0 ? undefined : notes.join(" ");
};

const rowFor = (item: SymphonyWorkItemProjection): SymphonyWorkRow => {
  const presentation = workLifecyclePresentation(item);
  const current = item.attempts.current;
  const attentionItems =
    item.attention.state === "needs_attention" ? item.attention.items.length : 0;
  const note = unknownNote(item);
  const statusLabel =
    current === null
      ? null
      : current.status === null
        ? "status unknown"
        : lifecycleLabel(current.status);
  const attemptLabel =
    current === null || statusLabel === null
      ? undefined
      : `Attempt ${current.attemptNumber} · ${statusLabel}${
          item.attempts.history.length > 1 ? ` · ${item.attempts.history.length} recorded` : ""
        }`;
  return {
    workItemId: String(item.identity.workItemId),
    ...(item.identity.trackerIdentifier === null
      ? {}
      : { trackerIdentifier: item.identity.trackerIdentifier }),
    title: item.identity.title ?? `Work item ${String(item.identity.workItemId)}`,
    lifecycleLabel: presentation.label,
    lifecycleTone: presentation.tone,
    needsAttention: attentionItems > 0,
    ...(attentionItems > 1 ? { attentionLabel: `${attentionItems} requests` } : {}),
    ...(current?.provider == null ? {} : { providerLabel: current.provider.instanceId }),
    ...(attemptLabel === undefined ? {} : { attemptLabel }),
    ...(note === undefined ? {} : { unknownNote: note }),
  };
};

const countsFor = (collection: SymphonyWorkCollection): SymphonyWorkCounts => {
  const items = collection.counts.items;
  const itemCount = (value: number) => ({ value, state: items.state });
  return {
    all: itemCount(items.all),
    notStarted: itemCount(items.notStarted),
    inProgress: itemCount(items.inProgress),
    attention: {
      value: collection.counts.attention.workItems,
      state: collection.counts.attention.state,
    },
  };
};

const coverageNote = (collection: SymphonyWorkCollection): string | null => {
  const notes: string[] = [];
  if (collection.freshness.board.state === "stale") {
    notes.push(`Board data is stale: ${collection.freshness.board.reason}`);
  } else if (collection.coverage.board.state === "bounded") {
    notes.push("Finished work is limited to the newest 100 items.");
  }
  if (collection.freshness.runs.state === "stale") {
    notes.push(`Run history is stale: ${collection.freshness.runs.reason}`);
  } else if (collection.evidence.runs === "unavailable") {
    notes.push("Run history is unavailable; attempts may be missing.");
  } else if (collection.coverage.runs.state === "bounded") {
    notes.push("Run history covers recent attempts only.");
  } else if (collection.coverage.runs.state === "unknown") {
    notes.push("Run history completeness is not reported.");
  }
  if (collection.freshness.attention.state === "stale") {
    notes.push(`Attention is stale: ${collection.freshness.attention.reason}`);
  } else if (collection.evidence.attention === "unavailable") {
    notes.push("Attention is unavailable; open requests may be missing.");
  } else if (collection.coverage.attention.state === "unknown") {
    notes.push("Attention completeness is not reported.");
  }
  if (collection.contradictions.length > 0) {
    notes.push(
      `${collection.contradictions.length} conflicting ${collection.contradictions.length === 1 ? "record needs" : "records need"} review.`,
    );
  }
  if (collection.attentionOutsideBoard.length > 0) {
    notes.push(
      `${collection.attentionOutsideBoard.length} open ${collection.attentionOutsideBoard.length === 1 ? "request" : "requests"} outside the loaded work list.`,
    );
  }
  return notes.length === 0 ? null : notes.join(" · ");
};

const noWorkCaveat = (collection: SymphonyWorkCollection): string => {
  const reasons: string[] = [];
  if (collection.counts.items.state === "unavailable") {
    reasons.push("The work record could not be read.");
  } else if (collection.counts.items.state === "unknown") {
    reasons.push("Work completeness is not reported.");
  } else if (collection.freshness.board.state === "stale") {
    reasons.push(`Board data is stale: ${collection.freshness.board.reason}`);
  } else if (collection.freshness.board.state === "unknown") {
    reasons.push(`Board freshness is unknown: ${collection.freshness.board.reason}`);
  }
  if (collection.counts.items.coverage.state !== "exhaustive") {
    reasons.push("The board may omit work outside its caps.");
  }
  if (collection.evidence.runs === "unavailable") {
    reasons.push("Run history could not be read.");
  } else if (collection.evidence.runs === "unknown") {
    reasons.push("Run history is not loaded.");
  } else if (collection.freshness.runs.state === "stale") {
    reasons.push(`Run history is stale: ${collection.freshness.runs.reason}`);
  } else if (collection.freshness.runs.state === "unknown") {
    reasons.push(`Run history freshness is unknown: ${collection.freshness.runs.reason}`);
  }
  if (collection.coverage.runs.state !== "exhaustive") {
    reasons.push("Run history coverage is incomplete.");
  }
  return reasons.join(" ");
};

const emptyCopy = (
  filter: WorkFilter,
  history: boolean,
  collection: SymphonyWorkCollection | null,
): { title: string; description: string } => {
  if (collection === null) {
    return {
      title: "Work not loaded",
      description: "The work projection has not loaded; no empty state can be confirmed.",
    };
  }

  // History is a separate scope. A hand-typed filter must not change this copy.
  if (history) {
    const confirmed =
      collection.counts.items.state === "known" &&
      collection.counts.items.coverage.state === "exhaustive" &&
      collection.freshness.board.state === "fresh" &&
      collection.evidence.runs === "known" &&
      collection.freshness.runs.state === "fresh";
    return {
      title: confirmed ? "No finished work recorded" : "No finished work observed",
      description: confirmed
        ? "Finished attempts appear here when the server reports them. History never replaces the current Work list."
        : noWorkCaveat(collection) || "No finished work was observed in the loaded evidence.",
    };
  }

  if (filter === "attention") {
    const outside = collection.attentionOutsideBoard.length;
    if (outside > 0) {
      return {
        title: "No open requests in loaded work",
        description: `${outside} open ${outside === 1 ? "request is" : "requests are"} attached to work outside the loaded list. Open \u201cOutside loaded work\u201d below for the exact attempts.`,
      };
    }
    const confirmed =
      collection.counts.attention.state === "known" &&
      collection.counts.attention.coverage.state === "exhaustive" &&
      collection.counts.attention.freshness.state === "fresh" &&
      collection.evidence.attention === "known" &&
      collection.freshness.attention.state === "fresh";
    if (confirmed) {
      return {
        title: "Nothing needs you",
        description: "There is no open question or approval attached to this project's work.",
      };
    }
    return {
      title: "No open requests observed",
      description:
        collection.counts.attention.state === "unavailable"
          ? "The attention read failed, so no claim is made that nothing needs you."
          : "Attention completeness or freshness is not reported; this is not proof that nothing needs you.",
    };
  }

  const confirmed =
    collection.counts.items.state === "known" &&
    collection.counts.items.coverage.state === "exhaustive" &&
    collection.freshness.board.state === "fresh" &&
    collection.evidence.runs === "known" &&
    collection.freshness.runs.state === "fresh";
  const description = noWorkCaveat(collection);
  if (!confirmed) {
    const title =
      filter === "in_progress"
        ? "No work in progress observed"
        : filter === "not_started"
          ? "No not-started work observed"
          : "No current work observed";
    return {
      title,
      description:
        description ||
        "The loaded evidence is incomplete, so an empty list is not proof of no work.",
    };
  }
  switch (filter) {
    case "not_started":
      return {
        title: "Nothing is waiting to start",
        description:
          "No item in this project is in a not-started state. Eligible work can still begin from its workflow policy.",
      };
    case "in_progress":
      return {
        title: "No work in progress",
        description:
          "Reserved, queued and observed work appears here. Attention can overlap this filter without adding a second row.",
      };
    case "all":
      return {
        title: "No current work",
        description:
          "This project has no current work items yet. Finished items remain in History; new eligible tracker work appears here automatically.",
      };
  }
};

function OutsideBoardAttention({
  entries,
  unmatchedRuns,
  environmentId,
  onRefresh,
}: {
  readonly entries: ReadonlyArray<SymphonyWorkAttentionEntry>;
  readonly unmatchedRuns: ReadonlyArray<SymphonyWorkAttemptFact>;
  readonly environmentId: EnvironmentId;
  readonly onRefresh: () => void;
}) {
  if (entries.length === 0 && unmatchedRuns.length === 0) return null;
  return (
    <details className="mt-3 rounded-2xl border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-[12px] font-medium text-foreground">
        Outside loaded work
        {entries.length === 0 ? null : (
          <span className="text-muted-foreground">
            {" "}
            · {entries.length} open {entries.length === 1 ? "request" : "requests"}
          </span>
        )}
        {unmatchedRuns.length === 0 ? null : (
          <span className="text-muted-foreground">
            {" "}
            · {unmatchedRuns.length} {unmatchedRuns.length === 1 ? "run" : "runs"}
          </span>
        )}
      </summary>
      <div className="space-y-4 border-t px-4 py-3">
        {entries.length === 0 ? null : (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">
              These requests belong to work outside the loaded board caps. They are not inserted
              into the list above.
            </p>
            <ul className="divide-y divide-border/60">
              {entries.map((entry) => (
                <li key={entry.item.id} className="space-y-2 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 flex-1 text-xs text-foreground">
                      {entry.item.whatHappened}
                    </span>
                    <Badge variant="warning" size="sm">
                      {lifecycleLabel(entry.item.kind)}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{entry.item.whyHuman}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.runAttemptId === null ? (
                      <span className="text-[11px] text-muted-foreground">
                        No exact attempt is attached to this request.
                      </span>
                    ) : (
                      <Link
                        to="/symphony/$runId"
                        params={{ runId: entry.runAttemptId }}
                        className="text-[11px] text-muted-foreground underline"
                      >
                        Open exact run
                      </Link>
                    )}
                    {entry.mode === "info" ? null : (
                      <ExactRequestActions
                        environmentId={environmentId}
                        entry={entry}
                        onRefresh={onRefresh}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {unmatchedRuns.length === 0 ? null : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              These active or unresolved run attempts are not matched to a loaded work item:
            </p>
            <ul className="divide-y divide-border/60">
              {unmatchedRuns.map((run) => (
                <li
                  key={run.runAttemptId}
                  className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-xs text-foreground">Attempt {run.attemptNumber}</span>
                  <Badge variant="secondary" size="sm">
                    {lifecycleLabel(run.status)}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    Work item {String(run.workItemId)}
                  </span>
                  <Link
                    to="/symphony/$runId"
                    params={{ runId: run.runAttemptId }}
                    className="ml-auto text-[11px] text-muted-foreground underline"
                  >
                    Open run
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

export function SymphonyWorkView({
  projectId,
  environmentId,
  project,
  board,
  boardLoading,
  boardError,
  tab,
  filter,
  onFilterChange,
  machineLabel,
}: {
  readonly projectId: SymphonyProjectId;
  readonly environmentId: EnvironmentId | null;
  readonly project: SymphonyProject;
  readonly board: SymphonyProjectBoard | null;
  readonly boardLoading: boolean;
  readonly boardError: string | null;
  readonly tab: "work" | "history";
  readonly filter: WorkFilter;
  readonly onFilterChange: (filter: WorkFilter) => void;
  readonly machineLabel: string | null;
}) {
  const history = tab === "history";
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<ReadonlyMap<string, RefusalSnapshot>>(new Map());
  const [storedPending, setStoredPending] = useLocalStorage(
    PENDING_DISPATCH_STORAGE_KEY,
    EMPTY_PENDING_DISPATCHES,
    PendingDispatchEntriesSchema,
  );
  const dispatchWorkItem = useAtomCommand(symphonyEnvironment.dispatchWorkItem, {
    reportFailure: false,
  });
  const cancelRun = useAtomCommand(symphonyEnvironment.cancelRun, {
    reportFailure: false,
  });

  const pendingForProject = useMemo(
    () =>
      environmentId === null
        ? []
        : storedPending.filter(
            (entry) =>
              entry.environmentId === String(environmentId) &&
              entry.projectId === String(projectId),
          ),
    [environmentId, projectId, storedPending],
  );

  const dispatchFacts = useMemo<SymphonyWorkDispatchFacts>(
    () => ({
      pending: pendingForProject.map((entry) => ({
        workItemId: entry.workItemId as WorkItemId,
      })),
      refusals: [...refusals.entries()].map(([workItemId, snapshot]) => ({
        workItemId: workItemId as WorkItemId,
        refusal: {
          ...snapshot.refusal,
          ...(snapshot.priorLifecycle === null ? {} : { priorLifecycle: snapshot.priorLifecycle }),
        },
      })),
    }),
    [pendingForProject, refusals],
  );

  const projectWork = useSymphonyProjectWork(environmentId, projectId, {
    filter: history ? "history" : filter,
    dispatch: dispatchFacts,
  });
  const collection = projectWork.work;

  const cards = useMemo(
    () => (board === null ? [] : board.columns.flatMap((column) => column.cards)),
    [board],
  );
  const selectedItem =
    collection === null || selectedWorkItemId === null
      ? null
      : (collection.items.find((item) => String(item.identity.workItemId) === selectedWorkItemId) ??
        null);
  const selectedCard: SymphonyBoardCard | null =
    selectedWorkItemId === null
      ? null
      : (cards.find((card) => String(card.workItemId) === selectedWorkItemId) ?? null);
  const knownRunAttemptId =
    selectedCard?.latestRunAttemptId ?? selectedItem?.attempts.current?.runAttemptId ?? null;
  const detailQuery = useEnvironmentQuery(
    environmentId === null || knownRunAttemptId === null
      ? null
      : symphonyEnvironment.getRun({
          environmentId,
          input: { runAttemptId: knownRunAttemptId },
        }),
  );

  // The collection is intentionally capped. When the exact card attempt has
  // loaded, feed that single authoritative fact through the same projection so
  // drawer actions see it without pretending the run history is complete.
  const projectedSelectedItem = useMemo(() => {
    if (environmentId === null || selectedItem === null || selectedCard === null) {
      return selectedItem;
    }
    const details = detailQuery.data;
    const exactAttempt = details?.runAttempt ?? null;
    const exactWasKnown =
      exactAttempt === null ||
      selectedItem.attempts.history.some(
        (attempt) => String(attempt.runAttemptId) === String(exactAttempt.id),
      );
    const runsCoverage =
      !exactWasKnown && selectedItem.attempts.coverage.state === "exhaustive"
        ? {
            state: "bounded" as const,
            reason:
              "The exact attempt was loaded separately from the capped run list; that does not prove complete history.",
          }
        : selectedItem.attempts.coverage;
    const facts: SymphonyWorkAttemptFact[] = selectedItem.attempts.history
      .filter(
        (attempt) =>
          exactAttempt === null || String(attempt.runAttemptId) !== String(exactAttempt.id),
      )
      .flatMap((attempt) => attemptFactsFromProjection(attempt));
    if (exactAttempt !== null) {
      facts.push({
        runAttemptId: exactAttempt.id,
        workItemId: exactAttempt.workItemId,
        attemptNumber: exactAttempt.attemptNumber,
        status: exactAttempt.status,
        startedAt: exactAttempt.startedAt,
        finishedAt: exactAttempt.finishedAt,
        provider: exactAttempt.provider,
        ...(exactAttempt.model === undefined ? {} : { model: exactAttempt.model }),
      });
    }

    const attentionById = new Map<string, AttentionItem>();
    if (selectedItem.attention.state === "needs_attention") {
      for (const entry of selectedItem.attention.items) {
        attentionById.set(String(entry.item.id), entry.item);
      }
    }
    for (const item of details?.attentionItems ?? []) {
      attentionById.set(String(item.id), item);
    }
    const attentionCoverage =
      selectedItem.attention.state === "needs_attention"
        ? selectedItem.attention.coverage
        : selectedItem.attention.state === "none" || selectedItem.attention.state === "unknown"
          ? selectedItem.attention.coverage
          : {
              state: "unknown" as const,
              reason: "Only pending requests from the exact attempt were loaded.",
            };

    const runsStaleReason =
      detailQuery.error ??
      (selectedItem.freshness.runs.state === "stale" ? selectedItem.freshness.runs.reason : null);
    const attentionStaleReason =
      detailQuery.error ??
      (selectedItem.freshness.attention.state === "stale"
        ? selectedItem.freshness.attention.reason
        : null);
    const closures: Array<{
      workItemId: WorkItemId;
      runAttemptId?: RunAttemptId;
      observedAt: string;
      source: string;
    }> = [];
    if (detailQuery.error === null && exactAttempt?.stopClosure !== undefined) {
      closures.push({
        workItemId: exactAttempt.workItemId,
        runAttemptId: exactAttempt.stopClosure.runAttemptId,
        observedAt: exactAttempt.stopClosure.observedAt,
        source: exactAttempt.stopClosure.source,
      });
    }
    if (detailQuery.error === null && details?.workItem.stopClosure !== undefined) {
      closures.push({
        workItemId: details.workItem.id,
        runAttemptId: details.workItem.stopClosure.runAttemptId,
        observedAt: details.workItem.stopClosure.observedAt,
        source: details.workItem.stopClosure.source,
      });
    }
    const pending = pendingForProject.some(
      (entry) => entry.workItemId === String(selectedCard.workItemId),
    );
    const refusal = refusals.get(String(selectedCard.workItemId));

    return projectSymphonyWorkItem({
      environmentId,
      workItemId: selectedCard.workItemId,
      projectId,
      card: { state: "known", value: selectedCard },
      ...(details === null
        ? {}
        : {
            workItem: {
              state: "known" as const,
              value: details.workItem,
              ...(detailQuery.error === null ? {} : { staleReason: detailQuery.error }),
            },
          }),
      ...(selectedCard.latestRunAttemptId === undefined
        ? {}
        : { currentRunAttemptId: selectedCard.latestRunAttemptId }),
      runs: {
        state: "known",
        value: { runs: facts, coverage: runsCoverage },
        ...(runsStaleReason === null ? {} : { staleReason: runsStaleReason }),
      },
      attention: {
        state: "known",
        value: { items: [...attentionById.values()], coverage: attentionCoverage },
        ...(attentionStaleReason === null ? {} : { staleReason: attentionStaleReason }),
      },
      ...(pending ? { pendingDispatch: {} } : {}),
      ...(refusal === undefined
        ? {}
        : {
            refusal: {
              ...refusal.refusal,
              ...(refusal.priorLifecycle === null
                ? {}
                : { priorLifecycle: refusal.priorLifecycle }),
            },
          }),
      ...(closures.length === 0 ? {} : { closures }),
    });
  }, [
    detailQuery.data,
    detailQuery.error,
    environmentId,
    pendingForProject,
    projectId,
    selectedCard,
    selectedItem,
    refusals,
  ]);

  const refresh = () => {
    projectWork.refresh();
    detailQuery.refresh();
  };

  const closeDetail = () => {
    setSelectedWorkItemId(null);
    setCancelNote(null);
  };

  const handleFilterChange = (next: WorkFilter) => {
    setSelectedWorkItemId(null);
    setCancelNote(null);
    onFilterChange(next);
  };

  const handleSelect = (row: SymphonyWorkRow) => {
    setCancelNote(null);
    setSelectedWorkItemId(row.workItemId);
  };

  const actionFor = (
    item: SymphonyWorkItemProjection,
    action: SymphonyWorkAction,
  ): SymphonyWorkRunAction => ({
    label: action.kind === "run_again" ? "Run again" : "Run now",
    state: action.state,
    reason: action.reason,
    pending: dispatchingId === String(item.identity.workItemId),
    onRun: () => {
      if (action.state !== "available") return;
      void dispatch(action.workItemId);
    },
  });

  const dispatch = async (workItemId: WorkItemId) => {
    if (environmentId === null || dispatchingId !== null) return;
    const id = String(workItemId);
    const before = collection?.items.find(
      (candidate) => String(candidate.identity.workItemId) === id,
    );
    // Persist the guard before the command can reach the server, so a tab
    // remount or reload cannot silently forget a dispatch in flight.
    setStoredPending((current) => [
      ...current.filter(
        (entry) =>
          !(
            entry.environmentId === String(environmentId) &&
            entry.projectId === String(projectId) &&
            entry.workItemId === id
          ),
      ),
      {
        environmentId: String(environmentId),
        projectId: String(projectId),
        workItemId: id,
        lifecycle: before === undefined ? null : lifecycleOf(before),
        attemptId:
          before?.attempts.current === undefined || before.attempts.current === null
            ? null
            : String(before.attempts.current.runAttemptId),
        sentAt: new Date().toISOString(),
      },
    ]);
    setDispatchingId(id);
    try {
      const result = await dispatchWorkItem({ environmentId, input: { workItemId } });
      if (result._tag === "Success" && result.value.status === "refused") {
        const refused = result.value;
        setStoredPending((current) =>
          current.filter(
            (entry) =>
              !(
                entry.environmentId === String(environmentId) &&
                entry.projectId === String(projectId) &&
                entry.workItemId === id
              ),
          ),
        );
        setRefusals((current) => {
          const next = new Map(current);
          next.set(id, {
            refusal: {
              reason: refused.reason,
              ...(refused.detail === undefined ? {} : { detail: refused.detail }),
            },
            priorLifecycle: before === undefined ? null : lifecycleOf(before),
            priorAttemptId:
              selectedCard?.latestRunAttemptId === undefined
                ? before?.attempts.current === undefined || before.attempts.current === null
                  ? null
                  : String(before.attempts.current.runAttemptId)
                : String(selectedCard.latestRunAttemptId),
            recordedAt: new Date().toISOString(),
            projectRevision: project.revision,
            projectStatus: project.status,
          });
          return next;
        });
      } else if (result._tag === "Success") {
        setStoredPending((current) =>
          current.filter(
            (entry) =>
              !(
                entry.environmentId === String(environmentId) &&
                entry.projectId === String(projectId) &&
                entry.workItemId === id
              ),
          ),
        );
        setRefusals((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      } else if (!isAtomCommandInterrupted(result)) {
        // The command failed after it may have reached the server. Keep the
        // persisted guard scoped to this exact environment/project/item.
        // Capped or absent reads cannot prove that nothing was accepted.
      }
    } finally {
      setDispatchingId(null);
      refresh();
    }
  };

  const cancel = async (runAttemptId: RunAttemptId) => {
    if (environmentId === null || cancelPending !== null) return;
    setCancelPending(String(runAttemptId));
    setCancelNote(null);
    try {
      const result = await cancelRun({ environmentId, input: { runAttemptId } });
      if (result._tag === "Success") {
        setCancelNote(stopAcknowledgementNote(result.value));
      } else if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setCancelNote(
          `Stop acknowledgement unknown. The attempt may still be running; check the exact run before requesting another stop.${
            cause instanceof Error ? ` ${cause.message}` : ""
          }`,
        );
      }
    } finally {
      setCancelPending(null);
      refresh();
    }
  };

  const selectedPending = pendingForProject.some(
    (entry) => entry.workItemId === selectedWorkItemId,
  );
  const selectedStartAction =
    projectedSelectedItem === null
      ? null
      : (projectedSelectedItem.actions.find(
          (action) => action.kind === "start" || action.kind === "run_again",
        ) ?? null);
  const runAction =
    projectedSelectedItem === null || selectedStartAction === null
      ? null
      : actionFor(projectedSelectedItem, selectedStartAction);
  const cancelActions =
    projectedSelectedItem === null
      ? []
      : projectedSelectedItem.actions
          .filter(
            (action): action is SymphonyWorkAction & { readonly runAttemptId: RunAttemptId } =>
              action.kind === "cancel" && action.runAttemptId !== undefined,
          )
          .map((action) => {
            const attempt = projectedSelectedItem.attempts.history.find(
              (candidate) => String(candidate.runAttemptId) === String(action.runAttemptId),
            );
            return {
              label:
                attempt === undefined
                  ? "Request stop"
                  : `Request stop · attempt ${attempt.attemptNumber}`,
              state: action.state,
              reason: action.reason,
              pending: cancelPending === String(action.runAttemptId),
              onRun: () => {
                if (action.state !== "available") return;
                void cancel(action.runAttemptId);
              },
            };
          });
  const selectedPresentation =
    projectedSelectedItem === null ? null : workLifecyclePresentation(projectedSelectedItem);
  const selectedAttentionEntries =
    projectedSelectedItem !== null && projectedSelectedItem.attention.state === "needs_attention"
      ? projectedSelectedItem.attention.items
      : [];
  const visibleRows = (collection?.visibleItems ?? []).map(rowFor);
  const visibleUnmatchedRuns = (collection?.unmatchedRuns ?? []).filter((run) =>
    UNRESOLVED_UNMATCHED_RUN_STATUSES.has(run.status),
  );
  const counts = collection === null ? EMPTY_WORK_COUNTS : countsFor(collection);
  const unresolvedPendingOutsideBoard =
    collection === null
      ? 0
      : pendingForProject.filter(
          (entry) =>
            !collection.items.some((item) => String(item.identity.workItemId) === entry.workItemId),
        ).length;
  const note =
    [
      collection === null ? null : coverageNote(collection),
      unresolvedPendingOutsideBoard === 0
        ? null
        : `${unresolvedPendingOutsideBoard} dispatch acknowledgement ${unresolvedPendingOutsideBoard === 1 ? "remains" : "remain"} unresolved for work outside the loaded list.`,
    ]
      .filter((value): value is string => value !== null)
      .join(" · ") || null;
  const empty = emptyCopy(filter, history, collection);
  const actionNote =
    cancelNote ??
    (selectedPending
      ? "The last dispatch request's acknowledgement is unknown. Capped or unchanged reads cannot prove it failed; refreshing evidence will not clear this guard, and this build has no durable dispatch receipt to reconcile it. Check the exact run before another attempt. Only an authoritative attempt or lifecycle change clears it."
      : null);

  useEffect(() => {
    if (pendingForProject.length === 0 || collection === null || environmentId === null) return;
    let changed = false;
    const next = storedPending.filter((entry) => {
      if (entry.environmentId !== String(environmentId) || entry.projectId !== String(projectId)) {
        return true;
      }
      const item = collection.items.find(
        (candidate) => String(candidate.identity.workItemId) === entry.workItemId,
      );
      if (item === undefined) return true; // Absence from a capped read is not reconciliation.
      const currentLifecycle = lifecycleOf(item);
      const currentAttempt = item.attempts.current;
      const lifecycleChanged =
        currentLifecycle !== null &&
        entry.lifecycle !== null &&
        currentLifecycle !== entry.lifecycle;
      const attemptChanged =
        currentAttempt !== null &&
        (entry.attemptId !== null
          ? String(currentAttempt.runAttemptId) !== entry.attemptId
          : new Date(currentAttempt.startedAt).getTime() > new Date(entry.sentAt).getTime());
      const observed = lifecycleChanged || attemptChanged;
      if (observed) {
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) setStoredPending(next);
  }, [
    collection,
    environmentId,
    pendingForProject.length,
    projectId,
    setStoredPending,
    storedPending,
  ]);

  useEffect(() => {
    if (refusals.size === 0 || collection === null) return;
    let changed = false;
    const next = new Map(refusals);
    for (const [id, snapshot] of refusals) {
      const item = collection.items.find(
        (candidate) => String(candidate.identity.workItemId) === id,
      );
      const currentLifecycle = item === undefined ? null : lifecycleOf(item);
      const currentAttemptId =
        item?.attempts.current === null || item?.attempts.current === undefined
          ? null
          : String(item.attempts.current.runAttemptId);
      if (
        shouldClearWorkRefusal({
          priorLifecycle: snapshot.priorLifecycle,
          currentLifecycle,
          priorAttemptId: snapshot.priorAttemptId,
          currentAttemptId,
          currentAttemptStartedAt: item?.attempts.current?.startedAt ?? null,
          recordedAt: snapshot.recordedAt,
          projectRevisionChanged: snapshot.projectRevision !== project.revision,
          projectStatusChanged: snapshot.projectStatus !== project.status,
        })
      ) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setRefusals(next);
  }, [collection, project.revision, project.status, refusals]);

  return (
    <>
      <SymphonyWorkList
        filter={filter}
        counts={counts}
        rows={visibleRows}
        selectedWorkItemId={selectedWorkItemId}
        onFilterChange={handleFilterChange}
        onSelect={handleSelect}
        loading={boardLoading || projectWork.isPending}
        error={boardError}
        coverageNote={note}
        emptyTitle={empty.title}
        emptyDescription={empty.description}
        onRefresh={refresh}
        showFilters={!history}
        footer={
          collection === null || environmentId === null ? null : (
            <OutsideBoardAttention
              entries={collection.attentionOutsideBoard}
              unmatchedRuns={visibleUnmatchedRuns}
              environmentId={environmentId}
              onRefresh={refresh}
            />
          )
        }
      />
      {selectedCard === null ||
      selectedItem === null ||
      projectedSelectedItem === null ||
      collection === null ? null : (
        <SymphonyWorkDetail
          key={selectedCard.workItemId}
          open
          project={project}
          card={selectedCard}
          details={detailQuery.data}
          attentionEntries={selectedAttentionEntries}
          actions={projectedSelectedItem.actions}
          attempts={projectedSelectedItem.attempts.history}
          currentAttemptNote={
            projectedSelectedItem.attempts.currentState === "unknown"
              ? projectedSelectedItem.attempts.currentReason
              : null
          }
          knownRunAttemptId={knownRunAttemptId}
          attemptState={projectedSelectedItem.attempts.currentState}
          attemptReason={projectedSelectedItem.attempts.currentReason}
          lifecycleLabel={selectedPresentation?.label ?? "Unknown"}
          lifecycleTone={selectedPresentation?.tone ?? "warning"}
          needsAttention={projectedSelectedItem.attention.state === "needs_attention"}
          attentionLabel={
            projectedSelectedItem.attention.state === "needs_attention"
              ? selectedAttentionEntries.length > 1
                ? `${selectedAttentionEntries.length} requests`
                : "Needs your attention"
              : undefined
          }
          loading={detailQuery.isPending}
          error={detailQuery.error}
          environmentId={environmentId}
          repositoryPath={project.repositoryPath}
          machineLabel={machineLabel}
          runAction={runAction}
          cancelActions={cancelActions}
          actionNote={actionNote}
          onReconcile={refresh}
          onClose={closeDetail}
          onRefresh={refresh}
        />
      )}
    </>
  );
}
