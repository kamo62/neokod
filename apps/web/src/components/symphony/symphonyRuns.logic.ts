import type { RunAttemptStatus } from "@neokod/contracts";

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunAttemptStatus> = new Set([
  "preparing_workspace",
  "building_prompt",
  "launching_agent",
  "initializing_session",
  "streaming_turn",
  "finishing",
]);

export type RunFilter = "all" | "active" | "finished";

export const filterRuns = <T extends { readonly status: RunAttemptStatus }>(
  runs: ReadonlyArray<T>,
  filter: RunFilter,
): T[] => {
  if (filter === "all") return [...runs];
  return runs.filter((run) =>
    filter === "active"
      ? ACTIVE_RUN_STATUSES.has(run.status)
      : !ACTIVE_RUN_STATUSES.has(run.status),
  );
};
