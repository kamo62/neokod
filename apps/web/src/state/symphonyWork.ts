import { useAtomValue } from "@effect/atom-react";
import type {
  AttentionItem,
  EnvironmentId,
  RunSummary,
  SymphonyProjectBoard,
  SymphonyProjectId,
} from "@neokod/contracts";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  projectSymphonyWorkCollection,
  symphonyWorkConnectionStaleReason,
  type SymphonyWorkAttentionFacts,
  type SymphonyWorkAttemptFact,
  type SymphonyWorkBoardFacts,
  type SymphonyWorkClosureEvidence,
  type SymphonyWorkCollection,
  type SymphonyWorkCoverage,
  type SymphonyWorkDispatchFacts,
  type SymphonyWorkEvidence,
  type SymphonyWorkFilter,
  type SymphonyWorkRunFacts,
} from "../symphonyWork.logic";
import { useEnvironmentPresentation } from "./presentation";
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

function evidenceFromQuery<A, B>(input: {
  readonly data: A | null;
  readonly error: string | null;
  readonly staleReason: string | null;
  readonly toValue: (value: A) => B;
  readonly pendingReason: string;
}): SymphonyWorkEvidence<B> {
  if (input.data !== null) {
    const staleReasons = [input.staleReason, input.error].filter(
      (reason): reason is string => reason !== null && reason.length > 0,
    );
    return {
      state: "known",
      value: input.toValue(input.data),
      ...(staleReasons.length === 0 ? {} : { staleReason: staleReasons.join(" ") }),
    };
  }
  if (input.error !== null) {
    return {
      state: "unavailable",
      reason: input.error,
      retryable: true,
    };
  }
  return {
    state: "unknown",
    reason: input.staleReason ?? input.pendingReason,
  };
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
   * unknown, the latest refusal per item, and the lifecycle observed before
   * sending. The hook adds no clock.
   */
  readonly dispatch?: SymphonyWorkDispatchFacts | undefined;
  /** Positive stop closure supplied by an authoritative observer, if any. */
  readonly closures?: ReadonlyArray<SymphonyWorkClosureEvidence> | undefined;
}

export interface SymphonyProjectWorkErrors {
  readonly connection: string | null;
  readonly board: string | null;
  readonly runs: string | null;
  readonly attention: string | null;
}

export interface SymphonyProjectWorkView {
  readonly work: SymphonyWorkCollection | null;
  readonly isPending: boolean;
  /** Board failure, retained for existing callers. */
  readonly error: string | null;
  /** Per-source failures, including stale retained data. */
  readonly errors: SymphonyProjectWorkErrors;
  readonly refresh: () => void;
}

/**
 * Project work projection. Each source keeps its own last-known data, failure
 * reason and coverage. A failed run or attention read is never flattened to an
 * empty known result, and stale sources cannot authorise actions.
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
  const environment = useEnvironmentPresentation(environmentId);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const connectionStaleReason =
    environmentId === null
      ? null
      : symphonyWorkConnectionStaleReason(
          environment.presentation?.connection.phase ?? null,
          networkStatus,
        );

  const filter = options?.filter ?? "all";
  const dispatch = options?.dispatch;
  const closures = options?.closures;
  const work = useMemo(() => {
    if (environmentId === null) return null;
    return projectSymphonyWorkCollection({
      environmentId,
      projectId,
      board: evidenceFromQuery({
        data: boardQuery.data,
        error: boardQuery.error,
        staleReason: connectionStaleReason,
        toValue: boardFacts,
        pendingReason: "The project board has not loaded.",
      }),
      runs: evidenceFromQuery({
        data: runsQuery.data,
        error: runsQuery.error,
        staleReason: connectionStaleReason,
        toValue: runFacts,
        pendingReason: "Project runs have not loaded.",
      }),
      attention: evidenceFromQuery({
        data: attentionQuery.data,
        error: attentionQuery.error,
        staleReason: connectionStaleReason,
        toValue: attentionFacts,
        pendingReason: "Attention has not loaded.",
      }),
      ...(dispatch === undefined ? {} : { dispatch }),
      ...(closures === undefined ? {} : { closures }),
      filter,
    });
  }, [
    attentionQuery.data,
    attentionQuery.error,
    boardQuery.data,
    boardQuery.error,
    closures,
    connectionStaleReason,
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
    errors: {
      connection: connectionStaleReason,
      board: boardQuery.error,
      runs: runsQuery.error,
      attention: attentionQuery.error,
    },
    refresh: () => {
      boardQuery.refresh();
      runsQuery.refresh();
      attentionQuery.refresh();
    },
  };
}
