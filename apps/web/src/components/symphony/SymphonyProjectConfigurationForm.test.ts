import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
  type SymphonyProjectConfiguration,
} from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  githubIssueRepositoryFromIdentity,
  isSymphonyProjectConfigurationComplete,
} from "./SymphonyProjectConfigurationForm";

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

  it("infers the GitHub issue repository from the Code project's Git identity", () => {
    const identity = {
      canonicalKey: "github.com/kamo62/neokod",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:kamo62/neokod.git",
      },
      provider: "github",
      owner: "kamo62",
      name: "neokod",
    } satisfies RepositoryIdentity;

    expect(githubIssueRepositoryFromIdentity(identity)).toBe("kamo62/neokod");
    expect(
      githubIssueRepositoryFromIdentity({
        canonicalKey: identity.canonicalKey,
        locator: {
          ...identity.locator,
          remoteUrl: "https://github.com/kamo62/neokod.git",
        },
      }),
    ).toBe("kamo62/neokod");
  });
});
