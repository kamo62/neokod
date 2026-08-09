import type { TrackersSettings } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";

import { effectiveTrackerProvider, trackerSettingsOverlay } from "./SettingsOverlay.ts";

it("maps scope, credentials, and connection config to provider keys", () => {
  const settings: TrackersSettings = {
    jira: {
      enabled: true,
      credential: "",
      credentialRedacted: false,
      scope: "OPS",
      credentialRef: "$JIRA_TOKEN",
      config: { base_url: "https://example.atlassian.net", email: "dev@example.com" },
    },
  };

  expect(trackerSettingsOverlay("jira", settings)).toEqual({
    base_url: "https://example.atlassian.net",
    email: "dev@example.com",
    project_key: "OPS",
    api_token: "$JIRA_TOKEN",
  });
});

it("normalizes GitHub's token env name and leaves blank credentials on gh login", () => {
  expect(
    trackerSettingsOverlay("github", {
      github: {
        enabled: true,
        credential: "",
        credentialRedacted: false,
        scope: "kamo62/neokod",
        credentialRef: "$GH_TOKEN",
        config: {},
      },
    }),
  ).toEqual({ repo: "kamo62/neokod", tokenEnv: "GH_TOKEN" });
  expect(
    trackerSettingsOverlay("github", {
      github: { enabled: true, credential: "", credentialRedacted: false, config: {} },
    }),
  ).toEqual({});
});

it("passes materialized credentials without exposing project scope globally", () => {
  expect(
    trackerSettingsOverlay("github", {
      github: {
        enabled: true,
        credential: "ghp_secret",
        credentialRedacted: true,
        config: {},
      },
    }),
  ).toEqual({ token: "ghp_secret" });
});

it("lets WORKFLOW.md override settings defaults", () => {
  expect(
    effectiveTrackerProvider(
      "gitlab",
      { project_path: "workflow/project", api_url: "https://gitlab.example/api/v4" },
      {
        gitlab: {
          enabled: true,
          credential: "",
          credentialRedacted: false,
          scope: "settings/project",
          credentialRef: "$GITLAB_PAT",
          config: { api_url: "https://gitlab.com/api/v4" },
        },
      },
    ),
  ).toEqual({
    project_path: "workflow/project",
    api_key: "$GITLAB_PAT",
    api_url: "https://gitlab.example/api/v4",
  });
});
