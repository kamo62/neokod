/**
 * Symphony project sections.
 *
 * Work is the single operating list. History and Settings are secondary.
 * The removed board/runs/attention tabs survive only as inbound aliases so
 * links written before this change still land on Work.
 */
export const PROJECT_TABS = ["work", "history", "settings"] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

export const WORK_FILTERS = ["all", "not_started", "in_progress", "attention"] as const;

export type WorkFilter = (typeof WORK_FILTERS)[number];

export const DEFAULT_WORK_FILTER: WorkFilter = "all";

const LEGACY_PROJECT_TABS: Readonly<Record<string, ProjectTab>> = {
  board: "work",
  runs: "work",
  attention: "work",
};

export const parseProjectTab = (value: unknown): ProjectTab | undefined => {
  if (typeof value !== "string") return undefined;
  if (PROJECT_TABS.includes(value as ProjectTab)) return value as ProjectTab;
  return LEGACY_PROJECT_TABS[value];
};

export const parseWorkFilter = (value: unknown): WorkFilter | undefined =>
  typeof value === "string" && WORK_FILTERS.includes(value as WorkFilter)
    ? (value as WorkFilter)
    : undefined;

/**
 * Resolve the project address. `tab=attention` predates the Work filters and
 * still means "show me what needs a person", so the alias carries its filter.
 */
export const parseProjectSearch = (
  search: Readonly<Record<string, unknown>>,
): { tab?: ProjectTab; filter?: WorkFilter } => {
  const tab = parseProjectTab(search.tab);
  const filter =
    search.tab === "attention" ? "attention" : (parseWorkFilter(search.filter) ?? undefined);
  return {
    ...(tab === undefined ? {} : { tab }),
    ...(filter === undefined ? {} : { filter }),
  };
};
