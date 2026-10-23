import type {
  AttentionItem,
  EnvironmentId,
  RunAttemptId,
  RunDetails,
  RunSummary,
  SymphonyProjectBoard,
  SymphonyProjectId,
} from "@neokod/contracts";
import { useMemo } from "react";

import {
  projectSymphonyWorkCollection,
  projectSymphonyWorkItem,
  type SymphonyWorkAttentionFacts,
  type SymphonyWorkAttemptFact,
  type SymphonyWorkBoardFacts,
  type SymphonyWorkCollection,
  type SymphonyWorkCoverage,
  type SymphonyWorkDispatchFacts,
  type SymphonyWorkEvidence,
  type SymphonyWorkFilter,
  type SymphonyWorkItemProjection,
  type SymphonyWorkRunFacts,
} from "../symphonyWork.logic";
import { useEnvironmentQuery } from "./query";
import { symphonyEnvironment } from "./symphony";

const UNREPORTED_BOARD_COVERAGE: SymphonyWorkCoverage = {
  state: "unknown",
  reason: "The project board did not report whether rows were truncated.",
};

const BOUNDED_BOARD_COVERAGE: SymphonyWorkCoverage = {
  state: "bounded",
  reason:
    "The project board includes every active item (up to 5,000) and only the newest 100 finished items; older finished items are omitted.",
};

const RUN_COVERAGE: SymphonyWorkCoverage = {
  state: "unknown",
  reason:
    "Project runs are filtered from the server's newest 1,000 attempts; older attempts may be absent, and some read failures are returned as an empty list.",
};

const ATTENTION_COVERAGE: SymphonyWorkCoverage = {
  state: "unknown",
  reason:
    "Attention is read from capped pending-request and open-item lists; some read failures are returned as an empty list, so an empty response is not known empty.",
};

const RUN_DETAIL_COVERAGE: SymphonyWorkCoverage = {
  state: "bounded",
  reason:
    "Only the exact run attempt is loaded; earlier and later attempts, and attention on them, are not included.",
};

const RUN_DETAIL_ATTENTION_COVERAGE: SymphonyWorkCoverage = {
  state: "unknown",
  reason:
    "Only pending requests for this attempt are loaded; some read failures are returned as an empty list, and attention on other attempts is not included.",
};

function attemptFactFromSummary(run: RunSummary): SymphonyWorkAttemptFact {
  return {
    runAttemptId: run.runAttemptId,
    workItemId: run.workItemId,
    ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
    attemptNumber: run.attemptNumber,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.provider === undefined ? {} : { provider: run.provider }),
    ...(run.model === undefined ? {} : { model: run.model }),
  };
}

function attemptFactFromDetail(details: RunDetails): SymphonyWorkAttemptFact {
  const attempt = details.runAttempt;
  return {
    runAttemptId: attempt.id,
    workItemId: attempt.workItemId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    provider: attempt.provider,
    ...(attempt.model === undefined ? {} : { model: attempt.model }),
  };
}

function evidenceFromQuery<A, B>(input: {
  readonly data: A | null;
  readonly error: string | null;
  readonly toValue: (value: A) => B;
  readonly pendingReason: string;
}): SymphonyWorkEvidence<B> {
  if (input.data !== null) {
    return {
      state: "known",
      value: input.toValue(input.data),
      ...(input.error === null ? {} : { stale: true }),
    };
  }
  if (input.error !== null) {
    return {
      state: "unavailable",
      reason: input.error,
      retryable: true,
    };
  }
  return { state: "unknown", reason: input.pendingReason };
}

function boardFacts(board: SymphonyProjectBoard): SymphonyWorkBoardFacts {
  return {
    cards: board.columns.flatMap((column) => column.cards),
    coverage:
      board.truncated === true
        ? BOUNDED_BOARD_COVERAGE
        : board.truncated === false
          ? { state: "exhaustive" }
          : UNREPORTED_BOARD_COVERAGE,
    generatedAt: board.generatedAt,
  };
}

function runFacts(runs: ReadonlyArray<RunSummary>): SymphonyWorkRunFacts {
  return {
    runs: runs.map(attemptFactFromSummary),
    coverage: RUN_COVERAGE,
  };
}

function attentionFacts(items: ReadonlyArray<AttentionItem>): SymphonyWorkAttentionFacts {
  return { items, coverage: ATTENTION_COVERAGE };
}

export interface SymphonyProjectWorkOptions {
  readonly filter?: SymphonyWorkFilter | undefined;
  /**
   * Local dispatch facts. Pass the command whose acknowledgement is still
   * unknown and the most recent refusal per item; the hook adds no clock.
   */
  readonly dispatch?: SymphonyWorkDispatchFacts | undefined;
}

export interface SymphonyProjectWorkView {
  readonly work: SymphonyWorkCollection | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * Project work projection. The board is the primary query; run and attention
 * reads remain explicit evidence inside the result even when one of them
 * fails, so a failed read is never flattened to "nothing here".
 */
export function useSymphonyProjectWork(
  environmentId: EnvironmentId | null,
  projectId: SymphonyProjectId,
  options?: SymphonyProjectWorkOptions,
): SymphonyProjectWorkView {
  const boardQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyEnvironment.projectBoard({ environmentId, input: { projectId } }),
  );
  const runsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyEnvironment.runs({ environmentId, input: { projectId } }),
  );
  const attentionQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : symphonyEnvironment.attention({ environmentId, input: { projectId } }),
  );

  const filter = options?.filter ?? "all";
  const dispatch = options?.dispatch;
  const work = useMemo(() => {
    if (environmentId === null) return null;
    const board = evidenceFromQuery({
      data: boardQuery.data,
      error: boardQuery.error,
      toValue: boardFacts,
      pendingReason: "The project board has not loaded.",
    });
    const runs = evidenceFromQuery({
      data: runsQuery.data,
      error: runsQuery.error,
      toValue: runFacts,
      pendingReason: "Project runs have not loaded.",
    });
    const attention = evidenceFromQuery({
      data: attentionQuery.data,
      error: attentionQuery.error,
      toValue: attentionFacts,
      pendingReason: "Attention has not loaded.",
    });
    return projectSymphonyWorkCollection({
      environmentId,
      projectId,
      board,
      runs,
      attention,
      ...(dispatch === undefined ? {} : { dispatch }),
      filter,
    });
  }, [
    attentionQuery.data,
    attentionQuery.error,
    boardQuery.data,
    boardQuery.error,
    dispatch,
    environmentId,
    filter,
    projectId,
    runsQuery.data,
    runsQuery.error,
  ]);

  return {
    work,
    isPending: environmentId !== null && boardQuery.isPending,
    error: boardQuery.error,
    refresh: () => {
      boardQuery.refresh();
      runsQuery.refresh();
      attentionQuery.refresh();
    },
  };
}

export interface SymphonyRunWorkView {
  readonly work: SymphonyWorkItemProjection | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * Exact run-attempt projection. Uses the durable work item and the exact
 * attempt; it does not infer a project-wide latest attempt from this one read.
 */
export function useSymphonyRunWork(
  environmentId: EnvironmentId | null,
  runAttemptId: RunAttemptId | null,
): SymphonyRunWorkView {
  const detail = useEnvironmentQuery(
    environmentId === null || runAttemptId === null
      ? null
      : symphonyEnvironment.getRun({
          environmentId,
          input: { runAttemptId },
        }),
  );

  const work = useMemo(() => {
    const details = detail.data;
    if (environmentId === null || runAttemptId === null || details === null) return null;
    const attention: SymphonyWorkEvidence<SymphonyWorkAttentionFacts> = {
      state: "known",
      value: {
        items: details.attentionItems,
        coverage: RUN_DETAIL_ATTENTION_COVERAGE,
      },
      ...(detail.error === null ? {} : { stale: true }),
    };
    return projectSymphonyWorkItem({
      environmentId,
      workItemId: details.workItem.id,
      ...(details.workItem.projectId === undefined
        ? {}
        : { projectId: details.workItem.projectId }),
      workItem: { state: "known", value: details.workItem },
      currentRunAttemptId: details.runAttempt.id,
      runs: {
        state: "known",
        value: {
          runs: [attemptFactFromDetail(details)],
          coverage: RUN_DETAIL_COVERAGE,
        },
      },
      attention,
    });
  }, [detail.data, detail.error, environmentId, runAttemptId]);

  return {
    work,
    isPending: environmentId !== null && runAttemptId !== null && detail.isPending,
    error: detail.error,
    refresh: detail.refresh,
  };
}
