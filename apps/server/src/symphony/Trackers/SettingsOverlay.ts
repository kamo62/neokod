import type { TrackerKind, TrackersSettings } from "@neokod/contracts";

const SCOPE_KEY: Partial<Record<TrackerKind, string>> = {
  github: "repo",
  jira: "project_key",
  linear: "project_slug",
  gitlab: "project_path",
  asana: "project_gid",
};

const SECRET_KEY: Partial<Record<TrackerKind, string>> = {
  github: "tokenEnv",
  jira: "api_token",
  linear: "api_key",
  gitlab: "api_key",
  asana: "api_key",
};

export const trackerSettingsOverlay = (
  kind: TrackerKind,
  settings: TrackersSettings,
): Readonly<Record<string, unknown>> => {
  const tracker = settings[kind];
  if (tracker === undefined) {
    return {};
  }
  const overlay: Record<string, unknown> = { ...tracker.config };
  const scopeKey = SCOPE_KEY[kind];
  if (scopeKey !== undefined && tracker.scope !== undefined) {
    overlay[scopeKey] = tracker.scope;
  }
  const secretKey = SECRET_KEY[kind];
  if (secretKey !== undefined && tracker.credentialRef !== undefined) {
    overlay[secretKey] =
      kind === "github" ? tracker.credentialRef.replace(/^\$/, "") : tracker.credentialRef;
  }
  return overlay;
};

export const effectiveTrackerProvider = (
  kind: TrackerKind,
  workflowProvider: Readonly<Record<string, unknown>>,
  settings: TrackersSettings,
): Readonly<Record<string, unknown>> => ({
  ...trackerSettingsOverlay(kind, settings),
  ...workflowProvider,
});
