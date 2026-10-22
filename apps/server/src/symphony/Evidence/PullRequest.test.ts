import type {
  ChangeRequest,
  EffectiveWorkflowConfig,
  EvidenceBundle,
  WorkItem,
} from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SourceControlProviderError,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  makePullRequestService,
  PullRequestService,
  pullRequestRepositoryKey,
  type PullRequestServiceDeps,
} from "./PullRequest.ts";

const makeConfig = (repositoryPath = "/repo"): EffectiveWorkflowConfig => ({
  repositoryPath,
  workflowPath: `${repositoryPath}/WORKFLOW.md`,
  trackerKind: "github",
  trackerRequiredLabels: [],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  trackerProvider: {},
  workspaceRoot: "/ws",
  autonomy: "execute",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  validationRequired: [],
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
});

const makeWorkItem = (): WorkItem => ({
  id: WorkItemId.make("wi-1"),
  mode: "symphony",
  objective: "Implement issue 42",
  description: "desc",
  acceptanceCriteria: [],
  source: { kind: "manual" },
  lifecycle: "running",
  eligibilityReasons: [],
  evidence: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
});

const runAttemptId = RunAttemptId.make("run-1");

const makeEvidence = (): EvidenceBundle => ({
  objective: "Implement issue 42",
  implementationSummary: "Implemented the feature.",
  changedFiles: [
    { path: "src/lib.ts", additions: 2, deletions: 1 },
    { path: "src/lib.test.ts", additions: 2, deletions: 0 },
  ],
  testsChanged: [{ path: "src/lib.test.ts", additions: 2, deletions: 0 }],
  commits: [
    { sha: "abc1234", message: "Implement feature", authoredAt: "2026-08-05T01:00:00.000Z" },
  ],
  validationResults: [{ command: "npm test", status: "passed", exitCode: 0 }],
  assumptions: [],
  risks: [],
  unresolved: [],
  artefacts: [],
  pullRequest: null,
  modelReview: null,
  overallAssessment: "ready_for_review",
  createdAt: "2026-08-05T03:00:00.000Z",
});

const makeChangeRequest = (overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  provider: "github",
  number: 17,
  title: "Implement issue 42",
  url: "https://github.com/owner/repo/pull/17",
  baseRefName: "main",
  headRefName: "symphony/issue-42",
  state: "open",
  updatedAt: Option.some(DateTime.makeUnsafe("2026-08-05T04:00:00.000Z")),
  ...overrides,
});

const makeDeps = (overrides: Partial<PullRequestServiceDeps> = {}): PullRequestServiceDeps => ({
  git: {
    pushCurrentBranch: () => Effect.succeed({ status: "pushed", branch: "symphony/issue-42" }),
  } as unknown as PullRequestServiceDeps["git"],
  providers: {
    resolveHandle: () =>
      Effect.succeed({
        provider: {
          createChangeRequest: () => Effect.void,
          getChangeRequestStatus: () => Effect.succeed(null),
          listChangeRequests: (_input: { headSelector: string }) =>
            Effect.succeed([makeChangeRequest()]),
        },
        context: null,
      }),
  } as unknown as PullRequestServiceDeps["providers"],
  writeBodyFile: () => Effect.void,
  nowIsoEffect: () => Effect.succeed("2026-08-05T03:30:00.000Z"),
  ...overrides,
});

it.effect("pushes the branch then creates the change request via the provider", () =>
  Effect.gen(function* () {
    const pushed: string[] = [];
    const created: Array<{ title: string; baseRefName: string; headSelector: string }> = [];
    const service = makePullRequestService(
      makeDeps({
        git: {
          pushCurrentBranch: (cwd: string, branch: string | null) =>
            Effect.sync(() => {
              pushed.push(`${cwd}:${branch ?? ""}`);
              return { status: "pushed" as const, branch: branch ?? "" };
            }),
        } as unknown as PullRequestServiceDeps["git"],
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: (input: {
                  title: string;
                  baseRefName: string;
                  headSelector: string;
                }) =>
                  Effect.sync(() => {
                    created.push({
                      title: input.title,
                      baseRefName: input.baseRefName,
                      headSelector: input.headSelector,
                    });
                  }),
                getChangeRequestStatus: () => Effect.succeed(null),
                listChangeRequests: () => Effect.succeed([makeChangeRequest()]),
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );
    const evidence = yield* service.create({
      workItem: makeWorkItem(),
      config: makeConfig(),
      runAttemptId,
      workspacePath: "/ws/key-1",
      branch: "symphony/issue-42",
      baseBranch: "main",
      evidence: makeEvidence(),
      bodyFileDir: "/tmp/neokod",
    });
    expect(pushed).toEqual(["/ws/key-1:symphony/issue-42"]);
    expect(created).toEqual([
      { title: "Implement issue 42", baseRefName: "main", headSelector: "symphony/issue-42" },
    ]);
    expect(evidence).toMatchObject({
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
      branch: "symphony/issue-42",
      baseBranch: "main",
      status: "open",
    });
  }),
);

it.effect("writes a deterministic evidence-based body file", () =>
  Effect.gen(function* () {
    const written: Array<{ path: string; content: string }> = [];
    const service = makePullRequestService(
      makeDeps({
        writeBodyFile: (path, content) =>
          Effect.sync(() => {
            written.push({ path, content });
          }),
      }),
    );
    yield* service.create({
      workItem: makeWorkItem(),
      config: makeConfig(),
      runAttemptId,
      workspacePath: "/ws/key-1",
      branch: "symphony/issue-42",
      baseBranch: "main",
      evidence: makeEvidence(),
      bodyFileDir: "/tmp/neokod",
    });
    expect(written).toHaveLength(1);
    const body = written[0]?.content ?? "";
    expect(body).toContain("Implemented the feature.");
    expect(body).toContain("| src/lib.ts | 2 | 1 |");
    expect(body).toContain("| `npm test` | passed |");
    expect(body).toContain("ready_for_review");
  }),
);

it.effect("returns null when the created PR cannot be located", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: () => Effect.void,
                getChangeRequestStatus: () => Effect.succeed(null),
                listChangeRequests: () => Effect.succeed([]),
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );
    const evidence = yield* service.create({
      workItem: makeWorkItem(),
      config: makeConfig(),
      runAttemptId,
      workspacePath: "/ws/key-1",
      branch: "symphony/issue-42",
      baseBranch: "main",
      evidence: makeEvidence(),
      bodyFileDir: "/tmp/neokod",
    });
    expect(evidence).toBeNull();
  }),
);

it.effect("fails when the provider cannot be resolved", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () => Effect.fail(new Error("no provider") as never),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );
    const result = yield* Effect.result(
      service.create({
        workItem: makeWorkItem(),
        config: makeConfig(),
        runAttemptId,
        workspacePath: "/ws/key-1",
        branch: "symphony/issue-42",
        baseBranch: "main",
        evidence: makeEvidence(),
        bodyFileDir: "/tmp/neokod",
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("refresh re-fetches the open PR for the branch", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: () => Effect.void,
                getChangeRequestStatus: () => Effect.succeed(null),
                listChangeRequests: (_input: { headSelector: string }) =>
                  Effect.succeed([makeChangeRequest()]),
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );
    const refreshed = yield* service.refresh({
      config: makeConfig(),
      branch: "symphony/issue-42",
      baseBranch: "main",
      title: "Implement issue 42",
    });
    expect(refreshed).toMatchObject({
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
      status: "open",
    });
  }),
);

it.effect("refresh looks up a tracked number directly instead of scanning the branch", () =>
  Effect.gen(function* () {
    const directReferences: string[] = [];
    const listCalls: string[] = [];
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: () => Effect.void,
                getChangeRequestStatus: () => Effect.succeed(null),
                getChangeRequest: (request: { reference: string }) => {
                  directReferences.push(request.reference);
                  return Effect.succeed(makeChangeRequest({ number: 42, baseRefName: "main" }));
                },
                // The tracked PR is older than ten other PRs sharing the branch,
                // so a limited branch scan would not contain it.
                listChangeRequests: (request: { headSelector: string }) => {
                  listCalls.push(request.headSelector);
                  return Effect.succeed([makeChangeRequest({ number: 100 })]);
                },
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );

    const refreshed = yield* service.refresh({
      config: makeConfig(),
      branch: "symphony/issue-42",
      baseBranch: "main",
      title: "Implement issue 42",
      pullRequestNumber: 42,
    });

    expect(directReferences).toEqual(["42"]);
    expect(listCalls).toEqual([]);
    expect(refreshed).toMatchObject({ number: 42, baseBranch: "main" });
  }),
);

it.effect(
  "refresh returns null rather than another PR when the tracked number cannot be read",
  () =>
    Effect.gen(function* () {
      const listCalls: string[] = [];
      const service = makePullRequestService(
        makeDeps({
          providers: {
            resolveHandle: () =>
              Effect.succeed({
                provider: {
                  createChangeRequest: () => Effect.void,
                  getChangeRequestStatus: () => Effect.succeed(null),
                  getChangeRequest: () =>
                    Effect.fail(
                      new SourceControlProviderError({
                        provider: "github",
                        operation: "getChangeRequest",
                        cwd: "/repo",
                        detail: "not found",
                      }),
                    ),
                  listChangeRequests: (request: { headSelector: string }) => {
                    listCalls.push(request.headSelector);
                    return Effect.succeed([makeChangeRequest({ number: 100 })]);
                  },
                },
                context: null,
              }),
          } as unknown as PullRequestServiceDeps["providers"],
        }),
      );

      expect(
        yield* service.refresh({
          config: makeConfig(),
          branch: "symphony/issue-42",
          baseBranch: "main",
          title: "Implement issue 42",
          pullRequestNumber: 42,
        }),
      ).toBeNull();
      // A different PR on the branch is not a substitute for the tracked one.
      expect(listCalls).toEqual([]);
    }),
);

it("derives a comparable repository identity from change-request URLs", () => {
  expect(pullRequestRepositoryKey("https://github.com/owner/a/pull/42")).toBe(
    pullRequestRepositoryKey("https://www.github.com/owner/a/pull/7/"),
  );
  expect(pullRequestRepositoryKey("https://github.com/owner/a/pull/42")).not.toBe(
    pullRequestRepositoryKey("https://github.com/owner/b/pull/42"),
  );
  expect(pullRequestRepositoryKey("https://gitlab.com/group/project/-/merge_requests/42")).toBe(
    "gitlab.com/group/project",
  );
  expect(pullRequestRepositoryKey("https://bitbucket.org/owner/repo/pull-requests/42")).toBe(
    "bitbucket.org/owner/repo",
  );
  expect(
    pullRequestRepositoryKey("https://dev.azure.com/org/project/_git/repo/pullrequest/42"),
  ).toBe("dev.azure.com/org/project/_git/repo");
  expect(pullRequestRepositoryKey(undefined)).toBeNull();
  expect(pullRequestRepositoryKey("not a url")).toBeNull();
});

it.effect("refresh refuses a same-number PR that belongs to another repository", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: () => Effect.void,
                getChangeRequestStatus: () => Effect.succeed(null),
                // Same number, different repository: a number alone is not
                // identity.
                getChangeRequest: () =>
                  Effect.succeed(
                    makeChangeRequest({
                      number: 42,
                      url: "https://github.com/owner/b/pull/42",
                    }),
                  ),
                listChangeRequests: () => Effect.succeed([]),
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );

    expect(
      yield* service.refresh({
        config: makeConfig(),
        branch: "symphony/issue-42",
        baseBranch: "main",
        title: "Implement issue 42",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/owner/a/pull/42",
      }),
    ).toBeNull();
  }),
);

it.effect("refresh accepts the tracked PR in the same repository", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: () => Effect.void,
                getChangeRequestStatus: () => Effect.succeed(null),
                getChangeRequest: () =>
                  Effect.succeed(
                    makeChangeRequest({
                      number: 42,
                      url: "https://www.github.com/owner/a/pull/42/",
                    }),
                  ),
                listChangeRequests: () => Effect.succeed([]),
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );

    const refreshed = yield* service.refresh({
      config: makeConfig(),
      branch: "symphony/issue-42",
      baseBranch: "main",
      title: "Implement issue 42",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/owner/a/pull/42",
    });
    expect(refreshed).toMatchObject({ number: 42, url: "https://www.github.com/owner/a/pull/42/" });
  }),
);

it.effect("refresh returns null when no open PR exists for the branch", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: () => Effect.void,
                getChangeRequestStatus: () => Effect.succeed(null),
                listChangeRequests: () => Effect.succeed([]),
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );
    const refreshed = yield* service.refresh({
      config: makeConfig(),
      branch: "symphony/issue-42",
      baseBranch: "main",
      title: "Implement issue 42",
    });
    expect(refreshed).toBeNull();
  }),
);

it.effect("refresh carries host-enriched status when the provider supports it", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: {
                createChangeRequest: () => Effect.void,
                getChangeRequestStatus: () =>
                  Effect.succeed({
                    ciStatus: "success",
                    reviewState: "approved",
                    mergeable: "mergeable",
                    unresolvedComments: 0,
                  }),
                listChangeRequests: () => Effect.succeed([makeChangeRequest()]),
              },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
      }),
    );
    const refreshed = yield* service.refresh({
      config: makeConfig(),
      branch: "symphony/issue-42",
      baseBranch: "main",
      title: "Implement issue 42",
    });
    expect(refreshed).toMatchObject({
      number: 17,
      ciStatus: "success",
      reviewState: "approved",
      mergeable: "mergeable",
      unresolvedComments: 0,
    });
  }),
);

it.effect("listUnresolvedComments returns comment bodies for a github handle", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: { kind: "github" },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
        githubCli: {
          listUnresolvedReviewComments: (input: { reference: string }) =>
            Effect.succeed(input.reference === "17" ? [{ body: "Please add a null check." }] : []),
        } as unknown as NonNullable<PullRequestServiceDeps["githubCli"]>,
      }),
    );
    const comments = yield* service.listUnresolvedComments({
      config: makeConfig(),
      pullRequestNumber: 17,
    });
    expect(comments).toEqual([{ body: "Please add a null check." }]);
  }),
);

it.effect("listUnresolvedComments degrades to null for a non-github handle", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: { kind: "gitlab" },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
        githubCli: {
          listUnresolvedReviewComments: () =>
            Effect.sync(() => {
              calls.push("called");
              return [];
            }),
        } as unknown as NonNullable<PullRequestServiceDeps["githubCli"]>,
      }),
    );
    const comments = yield* service.listUnresolvedComments({
      config: makeConfig(),
      pullRequestNumber: 17,
    });
    expect(comments).toBeNull();
    // Honest degradation means the host is never even queried for a
    // non-GitHub handle.
    expect(calls).toEqual([]);
  }),
);

it.effect("listUnresolvedComments degrades to null when GitHubCli is not wired", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(makeDeps());
    const comments = yield* service.listUnresolvedComments({
      config: makeConfig(),
      pullRequestNumber: 17,
    });
    expect(comments).toBeNull();
  }),
);

it.effect("listUnresolvedComments degrades to null when the host call fails", () =>
  Effect.gen(function* () {
    const service = makePullRequestService(
      makeDeps({
        providers: {
          resolveHandle: () =>
            Effect.succeed({
              provider: { kind: "github" },
              context: null,
            }),
        } as unknown as PullRequestServiceDeps["providers"],
        githubCli: {
          listUnresolvedReviewComments: () => Effect.fail(new Error("gh failed") as never),
        } as unknown as NonNullable<PullRequestServiceDeps["githubCli"]>,
      }),
    );
    const comments = yield* service.listUnresolvedComments({
      config: makeConfig(),
      pullRequestNumber: 17,
    });
    expect(comments).toBeNull();
  }),
);

it("exposes the service tag through the class", () => {
  expect(PullRequestService.key).toContain("Evidence/PullRequest");
});
