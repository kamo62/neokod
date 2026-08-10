import {
  ProviderDriverKind,
  ProviderInstanceId,
  type SymphonyProjectConfiguration,
} from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";

import { isSymphonyProjectConfigurationComplete } from "./SymphonyProjectConfigurationForm";

describe("Symphony project configuration", () => {
  it("requires a real tracker scope before project creation", () => {
    const configuration: SymphonyProjectConfiguration = {
      tracker: { kind: "github", repository: "" },
      trackerRequiredLabels: [],
      trackerActiveStates: ["open"],
      trackerTerminalStates: ["closed"],
      autonomy: "observe",
      agentProvider: {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
      },
      validationRequired: [],
      maxConcurrentAgents: 1,
      maxTurns: 20,
      maxAttempts: 3,
      approvalsBeforePush: false,
      approvalsBeforePullRequest: false,
      approvalsBeforeMerge: true,
    };

    expect(isSymphonyProjectConfigurationComplete(configuration)).toBe(false);
    expect(
      isSymphonyProjectConfigurationComplete({
        ...configuration,
        tracker: { kind: "jira", projectKey: "OPS" },
      }),
    ).toBe(true);
  });
});
