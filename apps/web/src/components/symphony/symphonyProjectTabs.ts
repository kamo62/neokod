export const PROJECT_TABS = ["board", "runs", "attention", "settings"] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

export const parseProjectTab = (value: unknown): ProjectTab | undefined =>
  PROJECT_TABS.find((tab) => tab === value);
