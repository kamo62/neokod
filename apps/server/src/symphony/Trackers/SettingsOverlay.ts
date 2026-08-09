import type { TrackerKind, TrackersSettings } from "@neokod/contracts";

const SCOPE_KEY: Partial<Record<TrackerKind, string>> = {
  github: "repo",
  jira: "project_key",
  linear: "project_slug",
  gitlab: "project_path",
  asana: "project_gid",
};

const SECRET_KEY: Partial<Record<TrackerKind, string>> = {
  github: "token",
  jira: "api_token",
  linear: "api_key",
  gitlab: "api_key",
  asana: "api_key",
  azure_boards: "api_key",
  github_projects: "api_key",
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
  if (secretKey !== undefined && tracker.credential.length > 0) {
    overlay[secretKey] = tracker.credential;
  } else if (tracker.credentialRef !== undefined) {
    overlay[kind === "github" ? "tokenEnv" : (secretKey ?? "credential")] =
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
