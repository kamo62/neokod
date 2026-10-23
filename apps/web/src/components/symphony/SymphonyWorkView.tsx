import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  SymphonyBoardCard,
  SymphonyProject,
  SymphonyProjectBoard,
  SymphonyProjectId,
  WorkItemId,
  WorkLifecycle,
} from "@neokod/contracts";
import { RunAttemptId, WorkLifecycleSchema } from "@neokod/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type {
  SymphonyWorkAction,
  SymphonyWorkAttentionEntry,
  SymphonyWorkCollection,
  SymphonyWorkDispatchFacts,
  SymphonyWorkAttemptFact,
  SymphonyWorkItemProjection,
  SymphonyWorkRefusal,
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
  workLifecyclePresentation,
  type SymphonyWorkRunAction,
} from "./SymphonyWorkDetail";
import { dispatchRefusalMessage } from "./dispatchRefusal.logic";
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
  readonly projectRevision: number;
  readonly projectStatus: SymphonyProject["status"];
}

const lifecycleOf = (item: SymphonyWorkItemProjection): WorkLifecycle | null =>
  item.lifecycle.phase === "unknown" ? null : item.lifecycle.lifecycle;

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
  return notes.length === 0 ? null : notes.join(" · ");
};

const evidenceCaveat = (collection: SymphonyWorkCollection): string => {
  if (collection.counts.items.state === "unavailable") {
    return "The work record could not be read, so nothing can be concluded.";
  }
  if (collection.counts.items.state === "unknown") {
    return "Completeness is not reported; this is not proof that no work exists.";
  }
  if (collection.counts.items.state === "observed") {
    return "This is an observed count from incomplete coverage, not a complete total.";
  }
  return "";
};

const attentionCaveat = (collection: SymphonyWorkCollection): string => {
  if (collection.counts.attention.state === "unavailable") {
    return "The attention read failed, so no claim is made that nothing needs you.";
  }
  if (collection.counts.attention.state === "unknown") {
    return "Attention completeness is not reported; this is not proof that nothing needs you.";
  }
  if (collection.counts.attention.state === "observed") {
    return "This is an observed attention count from incomplete coverage, not a complete total.";
  }
  return "";
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
  if (filter === "attention") {
    const outside = collection.attentionOutsideBoard.length;
    if (outside > 0) {
      return {
        title: "No open requests in loaded work",
        description: `${outside} open ${outside === 1 ? "request is" : "requests are"} attached to work outside the loaded list. Open \u201cOutside loaded work\u201d below for the exact attempts.`,
      };
    }
    if (collection.counts.attention.state === "unavailable") {
      return {
        title: "Attention unavailable",
        description: attentionCaveat(collection),
      };
    }
    const confirmed =
      collection.counts.attention.state === "known" &&
      collection.counts.attention.coverage.state === "exhaustive";
    return {
      title: confirmed ? "Nothing needs you" : "No open requests observed",
      description: confirmed
        ? "There is no open question or approval attached to this project's work."
        : attentionCaveat(collection) ||
          "No open request was observed in the loaded attention evidence.",
    };
  }
  if (collection.counts.items.state === "unavailable") {
    return { title: "Work unavailable", description: evidenceCaveat(collection) };
  }
  const confirmed =
    collection.counts.items.state === "known" &&
    collection.counts.items.coverage.state === "exhaustive";
  const description = evidenceCaveat(collection);
  if (history) {
    return {
      title: confirmed ? "No finished work recorded" : "No finished work observed",
      description:
        description ||
        "Finished attempts appear here when the server reports them. History never replaces the current Work list.",
    };
  }
  if (!confirmed) {
    return {
      title: "No work shown",
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
              These run attempts are not matched to a loaded work item:
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
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
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
    selectedItem === null
      ? null
      : (selectedItem.actions.find(
          (action) => action.kind === "start" || action.kind === "run_again",
        ) ?? null);
  const runAction =
    selectedItem === null || selectedStartAction === null
      ? null
      : actionFor(selectedItem, selectedStartAction);
  const cancelActions =
    selectedItem === null
      ? []
      : selectedItem.actions
          .filter(
            (action): action is SymphonyWorkAction & { readonly runAttemptId: RunAttemptId } =>
              action.kind === "cancel" && action.runAttemptId !== undefined,
          )
          .map((action) => {
            const attempt = selectedItem.attempts.history.find(
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
    selectedItem === null ? null : workLifecyclePresentation(selectedItem);
  const selectedAttentionEntries =
    selectedItem !== null && selectedItem.attention.state === "needs_attention"
      ? selectedItem.attention.items
      : [];
  const visibleRows = (collection?.visibleItems ?? []).map(rowFor);
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
      ? "The last dispatch request's acknowledgement is unknown. Capped or unchanged reads cannot prove it failed, and this build has no durable dispatch receipt to reconcile it. Check the exact run before starting another attempt."
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
      const policyChanged =
        snapshot.projectRevision !== project.revision || snapshot.projectStatus !== project.status;
      const lifecycleChanged =
        currentLifecycle !== null &&
        snapshot.priorLifecycle !== null &&
        currentLifecycle !== snapshot.priorLifecycle;
      if (policyChanged || lifecycleChanged) {
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
              unmatchedRuns={collection.unmatchedRuns}
              environmentId={environmentId}
              onRefresh={refresh}
            />
          )
        }
      />
      {selectedCard === null || selectedItem === null || collection === null ? null : (
        <SymphonyWorkDetail
          key={selectedCard.workItemId}
          open
          project={project}
          card={selectedCard}
          details={detailQuery.data}
          attentionEntries={selectedAttentionEntries}
          actions={selectedItem.actions}
          attempts={selectedItem.attempts.history}
          currentAttemptNote={
            selectedItem.attempts.currentState === "unknown"
              ? selectedItem.attempts.currentReason
              : null
          }
          knownRunAttemptId={knownRunAttemptId}
          attemptState={selectedItem.attempts.currentState}
          attemptReason={selectedItem.attempts.currentReason}
          lifecycleLabel={selectedPresentation?.label ?? "Unknown"}
          lifecycleTone={selectedPresentation?.tone ?? "warning"}
          needsAttention={selectedItem.attention.state === "needs_attention"}
          attentionLabel={
            selectedItem.attention.state === "needs_attention"
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
