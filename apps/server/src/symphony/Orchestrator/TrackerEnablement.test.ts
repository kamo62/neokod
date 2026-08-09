import type { EffectiveWorkflowConfig, TrackerKind, TrackersSettings } from "@neokod/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeTrackerEnablement } from "./TrackerEnablement.ts";

const makeConfig = (
  trackerKind: TrackerKind,
  trackerProvider: Readonly<Record<string, unknown>>,
): EffectiveWorkflowConfig => ({
  repositoryPath: "/repo",
  workflowPath: "/repo/WORKFLOW.md",
  trackerKind,
  trackerRequiredLabels: [],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  trackerProvider,
  workspaceRoot: "/ws",
  autonomy: "observe",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  validationRequired: [],
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
});

const makeEnablement = (trackers: TrackersSettings) =>
  makeTrackerEnablement(() => Effect.succeed(trackers));

it.effect("composes settings defaults under the workflow provider", () =>
  Effect.gen(function* () {
    const service = makeEnablement({
      github: {
        enabled: true,
        credential: "",
        credentialRedacted: false,
        scope: "settings/repo",
        credentialRef: "$GH_TOKEN",
        config: {},
      },
    });
    const provider = yield* service.resolveProvider(makeConfig("github", { repo: "wf/repo" }));
    expect(provider).toEqual({ repo: "wf/repo", tokenEnv: "GH_TOKEN" });
  }),
);

it.effect("returns the workflow provider unchanged without tracker settings", () =>
  Effect.gen(function* () {
    const provider = yield* makeEnablement({}).resolveProvider(
      makeConfig("jira", { base_url: "https://acme.atlassian.net", project_key: "PROJ" }),
    );
    expect(provider).toEqual({ base_url: "https://acme.atlassian.net", project_key: "PROJ" });
  }),
);
