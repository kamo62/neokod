import { useEffect, useMemo, useState } from "react";

import { isAtomCommandInterrupted } from "@neokod/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SymphonyBoardCard,
  SymphonyProject,
  SymphonyProjectBoard,
  SymphonyProjectId,
  WorkItemId,
  WorkLifecycle,
} from "@neokod/contracts";
import { RunAttemptId } from "@neokod/contracts";

import type {
  SymphonyWorkAttentionEntry,
  SymphonyWorkCollection,
  SymphonyWorkDispatchFacts,
  SymphonyWorkItemProjection,
  SymphonyWorkRefusal,
} from "../../symphonyWork.logic";
import { useEnvironmentQuery } from "../../state/query";
import { useSymphonyProjectWork } from "../../state/symphonyWork";
import { symphonyEnvironment } from "../../state/symphony";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  EMPTY_WORK_COUNTS,
  SymphonyWorkList,
  type SymphonyWorkCounts,
  type SymphonyWorkRow,
  type WorkRowTone,
} from "./SymphonyWorkList";
import { SymphonyWorkDetail, type SymphonyWorkRunAction } from "./SymphonyWorkDetail";
import { dispatchRefusalMessage } from "./dispatchRefusal.logic";
import type { WorkFilter } from "./symphonyProjectTabs";

const humanize = (value: string): string => value.replaceAll("_", " ");

const lifecyclePresentation = (
  item: SymphonyWorkItemProjection,
): { readonly label: string; readonly tone: WorkRowTone } => {
  const lifecycle = item.lifecycle;
  if (lifecycle.phase === "not_started") {
    return {
      label: "Not started",
      tone: lifecycle.reason === "draft" ? "secondary" : "warning",
    };
  }
  if (lifecycle.phase === "in_progress") {
    return {
      label: humanize(lifecycle.lifecycle),
      tone: lifecycle.lifecycle === "waiting_for_approval" ? "warning" : "info",
    };
  }
  if (lifecycle.phase === "finished") {
    return {
      label: humanize(lifecycle.outcome),
      tone:
        lifecycle.outcome === "completed"
          ? "success"
          : lifecycle.outcome === "failed"
            ? "error"
            : "secondary",
    };
  }
  return { label: "Unknown", tone: "warning" };
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
  return notes.length === 0 ? undefined : notes.join(" ");
};

const rowFor = (item: SymphonyWorkItemProjection): SymphonyWorkRow => {
  const presentation = lifecyclePresentation(item);
  const current = item.attempts.current;
  const attentionItems =
    item.attention.state === "needs_attention" ? item.attention.items.length : 0;
  const note = unknownNote(item);
  const statusLabel =
    current === null ? null : current.status === null ? "status unknown" : humanize(current.status);
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

const attentionEntriesFor = (
  item: SymphonyWorkItemProjection | null,
): ReadonlyArray<SymphonyWorkAttentionEntry["item"]> =>
  item !== null && item.attention.state === "needs_attention"
    ? item.attention.items.map((entry) => entry.item)
    : [];

const coverageNote = (
  collection: SymphonyWorkCollection,
  filter: WorkFilter,
  history: boolean,
): string | null => {
  const notes: string[] = [];
  if (collection.coverage.board.state === "bounded") {
    notes.push("Finished work is limited to the newest 100 items.");
  }
  if (collection.evidence.runs === "unavailable") {
    notes.push("Run history is unavailable; attempts may be missing.");
  } else if (collection.coverage.runs.state === "bounded") {
    notes.push("Run history covers recent attempts only.");
  } else if (collection.coverage.runs.state === "unknown") {
    notes.push("Run history completeness is not reported.");
  }
  if (collection.evidence.attention === "unavailable") {
    notes.push("Attention is unavailable; open requests may be missing.");
  } else if (collection.coverage.attention.state === "unknown") {
    notes.push("Attention completeness is not reported.");
  }
  if (!history && filter !== "attention") {
    const outside = collection.attentionOutsideFilter;
    if (outside.state !== "unknown" && outside.state !== "unavailable" && outside.workItems > 0) {
      notes.push(
        `${outside.workItems} work ${outside.workItems === 1 ? "item" : "items"} outside this filter need attention.`,
      );
    }
  }
  if (collection.contradictions.length > 0) {
    notes.push(
      `${collection.contradictions.length} conflicting ${collection.contradictions.length === 1 ? "record needs" : "records need"} review.`,
    );
  }
  if (collection.attentionOutsideBoard.length > 0) {
    notes.push(
      `${collection.attentionOutsideBoard.length} open ${collection.attentionOutsideBoard.length === 1 ? "request is" : "requests are"} attached to work outside this list's loaded items.`,
    );
  }
  if (collection.unmatchedRuns.length > 0) {
    notes.push(
      `${collection.unmatchedRuns.length} run ${collection.unmatchedRuns.length === 1 ? "attempt is" : "attempts are"} not matched to a loaded work item.`,
    );
  }
  return notes.length === 0 ? null : notes.join(" · ");
};

const emptyCopy = (
  filter: WorkFilter,
  history: boolean,
): { title: string; description: string } => {
  if (history) {
    return {
      title: "No finished work recorded",
      description:
        "Finished attempts appear here when the server reports them. History never replaces the current Work list.",
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
    case "attention":
      return {
        title: "Nothing needs you in this scope",
        description:
          "There is no open question or approval attached to this project's current work. Unknown coverage is labelled rather than treated as empty.",
      };
    case "all":
      return {
        title: "No current work",
        description:
          "This project has no current work items yet. Finished items remain in History; new eligible tracker work appears here automatically.",
      };
  }
};

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
  const [pendingAcknowledgement, setPendingAcknowledgement] = useState<
    ReadonlyMap<
      string,
      { readonly lifecycle: WorkLifecycle | null; readonly attemptId: string | null }
    >
  >(new Map());
  const [refusals, setRefusals] = useState<ReadonlyMap<string, SymphonyWorkRefusal>>(new Map());
  const dispatchWorkItem = useAtomCommand(symphonyEnvironment.dispatchWorkItem, {
    reportFailure: false,
  });

  const dispatchFacts = useMemo<SymphonyWorkDispatchFacts>(
    () => ({
      pending: [...pendingAcknowledgement.keys()].map((workItemId) => ({
        workItemId: workItemId as WorkItemId,
      })),
      refusals: [...refusals.entries()].map(([workItemId, refusal]) => ({
        workItemId: workItemId as WorkItemId,
        refusal,
      })),
    }),
    [pendingAcknowledgement, refusals],
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
  const selectedRunAttemptId = selectedItem?.attempts.current?.runAttemptId ?? null;
  const detailQuery = useEnvironmentQuery(
    environmentId === null || selectedRunAttemptId === null
      ? null
      : symphonyEnvironment.getRun({
          environmentId,
          input: { runAttemptId: RunAttemptId.make(selectedRunAttemptId) },
        }),
  );

  const refresh = () => {
    projectWork.refresh();
    detailQuery.refresh();
  };

  const closeDetail = () => setSelectedWorkItemId(null);

  const handleFilterChange = (next: WorkFilter) => {
    setSelectedWorkItemId(null);
    onFilterChange(next);
  };

  const handleSelect = (row: SymphonyWorkRow) => {
    setSelectedWorkItemId(row.workItemId);
  };

  const runActionFor = (item: SymphonyWorkItemProjection): SymphonyWorkRunAction | null => {
    const action = item.actions.find(
      (candidate) => candidate.kind === "start" || candidate.kind === "run_again",
    );
    if (action === undefined) return null;
    return {
      label: action.kind === "run_again" ? "Run again" : "Run now",
      state: action.state,
      reason: action.reason,
      pending: dispatchingId === String(item.identity.workItemId),
      onRun: () => {
        if (action.state !== "available") return;
        void dispatch(action.workItemId);
      },
    };
  };

  const dispatch = async (workItemId: WorkItemId) => {
    if (environmentId === null || dispatchingId !== null) return;
    const id = String(workItemId);
    setDispatchingId(id);
    try {
      const result = await dispatchWorkItem({ environmentId, input: { workItemId } });
      if (result._tag === "Success" && result.value.status === "refused") {
        const refused = result.value;
        setPendingAcknowledgement((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        setRefusals((current) => {
          const next = new Map(current);
          next.set(id, {
            reason: refused.reason,
            ...(refused.detail === undefined ? {} : { detail: refused.detail }),
          });
          return next;
        });
      } else if (result._tag === "Success") {
        setPendingAcknowledgement((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        setRefusals((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      } else if (!isAtomCommandInterrupted(result)) {
        // The command failed after it may have reached the server. Keep the
        // item reserved as acknowledgement-unknown and reconcile; never invite
        // a blind second dispatch.
        const before = collection?.items.find(
          (candidate) => String(candidate.identity.workItemId) === id,
        );
        const currentAttempt = before?.attempts.current ?? null;
        setPendingAcknowledgement((current) =>
          new Map(current).set(id, {
            lifecycle:
              before === undefined || before.lifecycle.phase === "unknown"
                ? null
                : before.lifecycle.lifecycle,
            attemptId: currentAttempt === null ? null : String(currentAttempt.runAttemptId),
          }),
        );
      }
    } finally {
      setDispatchingId(null);
      refresh();
    }
  };

  const selectedPending =
    selectedWorkItemId !== null && pendingAcknowledgement.has(selectedWorkItemId);
  const runAction = selectedItem === null ? null : runActionFor(selectedItem);
  const selectedPresentation = selectedItem === null ? null : lifecyclePresentation(selectedItem);
  const selectedAttentionItems = attentionEntriesFor(selectedItem);
  const visibleRows = (collection?.visibleItems ?? []).map(rowFor);
  const counts = collection === null ? EMPTY_WORK_COUNTS : countsFor(collection);
  const note = collection === null ? null : coverageNote(collection, filter, history);
  const empty = emptyCopy(filter, history);

  useEffect(() => {
    if (pendingAcknowledgement.size === 0 || collection === null) return;
    const next = new Map(pendingAcknowledgement);
    let changed = false;
    for (const [id, snapshot] of pendingAcknowledgement) {
      const item = collection.items.find(
        (candidate) => String(candidate.identity.workItemId) === id,
      );
      if (item === undefined) continue;
      const lifecycle = item.lifecycle.phase === "unknown" ? null : item.lifecycle.lifecycle;
      const attemptId =
        item.attempts.current === null ? null : String(item.attempts.current.runAttemptId);
      const observed =
        item.execution === "observed" ||
        lifecycle !== snapshot.lifecycle ||
        attemptId !== snapshot.attemptId;
      if (observed) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setPendingAcknowledgement(next);
  }, [collection, pendingAcknowledgement]);

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
      />
      {selectedCard === null || selectedItem === null || collection === null ? null : (
        <SymphonyWorkDetail
          key={selectedCard.workItemId}
          open
          project={project}
          card={selectedCard}
          details={detailQuery.data}
          attentionItems={selectedAttentionItems}
          attempts={selectedItem.attempts.history}
          currentAttemptNote={
            selectedItem.attempts.currentState === "unknown"
              ? selectedItem.attempts.currentReason
              : null
          }
          lifecycleLabel={selectedPresentation?.label ?? "Unknown"}
          lifecycleTone={selectedPresentation?.tone ?? "warning"}
          needsAttention={selectedItem.attention.state === "needs_attention"}
          attentionLabel={
            selectedItem.attention.state === "needs_attention"
              ? selectedAttentionItems.length > 1
                ? `${selectedAttentionItems.length} requests`
                : "Needs your attention"
              : undefined
          }
          loading={detailQuery.isPending}
          error={detailQuery.error}
          environmentId={environmentId}
          repositoryPath={project.repositoryPath}
          machineLabel={machineLabel}
          runAction={runAction}
          dispatchNote={
            selectedPending
              ? "The last dispatch request's acknowledgement is unknown. It may have been accepted. Reconcile this item before starting another attempt."
              : null
          }
          onReconcile={refresh}
          onClose={closeDetail}
          onRefresh={refresh}
        />
      )}
    </>
  );
}
