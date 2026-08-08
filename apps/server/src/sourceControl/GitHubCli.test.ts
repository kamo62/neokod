import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@neokod/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

/**
 * `listUnresolvedReviewComments` is optional on the `GitHubCli["Service"]`
 * interface (fakes elsewhere don't need to implement it), but the real
 * `GitHubCli.layer` under test here always provides it. This helper keeps
 * the tests below type-safe without a non-null assertion at every call site.
 */
const listUnresolvedReviewComments = (
  input: Parameters<NonNullable<GitHubCli.GitHubCli["Service"]["listUnresolvedReviewComments"]>>[0],
) =>
  Effect.gen(function* () {
    const gh = yield* GitHubCli.GitHubCli;
    const method = gh.listUnresolvedReviewComments;
    if (method === undefined) {
      return yield* Effect.die("listUnresolvedReviewComments not implemented");
    }
    return yield* method(input);
  });

afterEach(() => {
  mockRun.mockReset();
});

describe("GitHubCli.layer", () => {
  it("does not classify a missing cwd as an unavailable gh executable", () => {
    const context = { command: "gh", cwd: "/repo" } as const;
    const missingCwd = new VcsProcessSpawnError({
      operation: "GitHubCli.execute",
      command: "gh",
      cwd: context.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: context.cwd,
      }),
    });

    const commandFailure = GitHubCli.fromVcsError(context, missingCwd);

    assert.equal(commandFailure._tag, "GitHubCliCommandError");
    assert.strictEqual(commandFailure.cause, missingCwd);
    assert.notProperty(commandFailure, "operation");
  });

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps pull requests from gh versions without headRepository.nameWithOwner", () =>
    // gh < 2.47 (e.g. Ubuntu-packaged 2.46) exports headRepository as
    // {id, name} only. These entries must decode instead of being dropped,
    // with nameWithOwner rebuilt from the owner login.
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson([
              {
                number: 2829,
                title: "Codex turn mapping",
                url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
                baseRefName: "main",
                headRefName: "t3code/codex-turn-mapping",
                state: "OPEN",
                mergedAt: null,
                isCrossRepository: false,
                headRepository: {
                  id: "R_kgDORLtfbQ",
                  name: "codething-mvp",
                },
                headRepositoryOwner: {
                  id: "MDEyOk9yZ2FuaXphdGlvbjg5MTkxNzI3",
                  login: "pingdotgg",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "t3code/codex-turn-mapping",
      });

      assert.deepStrictEqual(result, [
        {
          number: 2829,
          title: "Codex turn mapping",
          url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
          baseRefName: "main",
          headRefName: "t3code/codex-turn-mapping",
          state: "open",
          isCrossRepository: false,
          headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
          headRepositoryOwnerLogin: "pingdotgg",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh pr view",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "not-found",
        detail:
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
      assert.strictEqual(error._tag, "GitHubPullRequestNotFoundError");
      assert.strictEqual(error.command, "gh");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses change request status with failing CI and changes requested", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              mergeable: "MERGEABLE",
              reviewDecision: "CHANGES_REQUESTED",
              statusCheckRollup: [
                { status: "COMPLETED", conclusion: "FAILURE" },
                { status: "COMPLETED", conclusion: "SUCCESS" },
              ],
              reviews: [{ state: "CHANGES_REQUESTED" }],
              latestCommit: { oid: "deadbeef0001" },
            }),
          ),
        ),
      );
      // GraphQL reviewThreads follow-up: 1 unresolved thread.
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [{ isResolved: false }, { isResolved: true }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getChangeRequestStatus({ cwd: "/repo", reference: "#42" });

      assert.deepStrictEqual(result, {
        ciStatus: "failure",
        reviewState: "changes_requested",
        mergeable: "mergeable",
        unresolvedComments: 1,
        latestCommit: "deadbeef0001",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("queries reviewThreads with real owner/name variables, not empty literals", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(encodeJson({ mergeable: "MERGEABLE", statusCheckRollup: [], reviews: [] })),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.getChangeRequestStatus({ cwd: "/repo", reference: "#42" });

      // Fix-lane item 11: the GraphQL query must not hard-code empty
      // owner/name (real GitHub returns null and the gate becomes a dead 0),
      // and gh's :owner/:repo magic variables must be passed through.
      const graphqlCall = mockRun.mock.calls[1]?.[0];
      assert.equal(graphqlCall?.args[0], "api");
      assert.equal(graphqlCall?.args[1], "graphql");
      const query = String(graphqlCall?.args[3] ?? "");
      assert.equal(query.includes('repository(owner: "", name: "")'), false);
      assert.equal(query.includes("$owner: String!, $name: String!"), true);
      const args = (graphqlCall?.args ?? []).join(" ");
      assert.equal(args.includes("-F owner=:owner"), true);
      assert.equal(args.includes("-F name=:repo"), true);
      assert.equal(args.includes("-F pr=42"), true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses change request status with approved review and pending CI", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              mergeable: "MERGEABLE",
              reviewDecision: "APPROVED",
              statusCheckRollup: [
                { status: "IN_PROGRESS", conclusion: null },
                { status: "COMPLETED", conclusion: "SUCCESS" },
              ],
              reviews: [{ state: "APPROVED" }],
            }),
          ),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getChangeRequestStatus({ cwd: "/repo", reference: "#42" });

      assert.deepStrictEqual(result, {
        ciStatus: "pending",
        reviewState: "approved",
        mergeable: "mergeable",
        unresolvedComments: 0,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("maps no checks and no reviews to unknown/none", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              mergeable: "UNKNOWN",
              statusCheckRollup: [],
              reviews: [],
            }),
          ),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getChangeRequestStatus({ cwd: "/repo", reference: "#42" });

      assert.deepStrictEqual(result, {
        ciStatus: "unknown",
        reviewState: "none",
        mergeable: "unknown",
        unresolvedComments: 0,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists the opening comment of each unresolved review thread", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          isResolved: false,
                          comments: {
                            nodes: [
                              { body: "Please add a null check.", author: { login: "rev1" } },
                            ],
                          },
                        },
                        {
                          isResolved: true,
                          comments: {
                            nodes: [{ body: "Already fixed.", author: { login: "rev2" } }],
                          },
                        },
                        {
                          isResolved: false,
                          comments: { nodes: [{ body: "This needs a test." }] },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const result = yield* listUnresolvedReviewComments({ cwd: "/repo", reference: "#42" });

      assert.deepStrictEqual(result, [
        { body: "Please add a null check.", author: "rev1" },
        { body: "This needs a test." },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("bounds the unresolved comment list to the given limit", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: Array.from({ length: 5 }, (_unused, index) => ({
                        isResolved: false,
                        comments: { nodes: [{ body: `comment ${index}` }] },
                      })),
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const result = yield* listUnresolvedReviewComments({
        cwd: "/repo",
        reference: "#42",
        limit: 2,
      });

      assert.deepStrictEqual(result, [{ body: "comment 0" }, { body: "comment 1" }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("queries unresolved comments with real owner/name variables, not empty literals", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      yield* listUnresolvedReviewComments({ cwd: "/repo", reference: "#42" });

      const graphqlCall = mockRun.mock.calls[0]?.[0];
      assert.equal(graphqlCall?.args[0], "api");
      assert.equal(graphqlCall?.args[1], "graphql");
      const query = String(graphqlCall?.args[3] ?? "");
      assert.equal(query.includes('repository(owner: "", name: "")'), false);
      assert.equal(query.includes("$owner: String!, $name: String!"), true);
      const args = (graphqlCall?.args ?? []).join(" ");
      assert.equal(args.includes("-F owner=:owner"), true);
      assert.equal(args.includes("-F name=:repo"), true);
      assert.equal(args.includes("-F pr=42"), true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("paginates reviewThreads before reporting the unresolved count", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(encodeJson({ mergeable: "MERGEABLE", statusCheckRollup: [], reviews: [] })),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [{ isResolved: true }],
                      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [{ isResolved: false }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const status = yield* gh.getChangeRequestStatus({ cwd: "/repo", reference: "#42" });

      expect(status.unresolvedComments).toBe(1);
      expect((mockRun.mock.calls[2]?.[0].args ?? []).join(" ")).toContain("-F cursor=cursor-1");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails closed when reviewThreads nodes are missing", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(encodeJson({ mergeable: "MERGEABLE", statusCheckRollup: [], reviews: [] })),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* Effect.result(
        gh.getChangeRequestStatus({ cwd: "/repo", reference: "#42" }),
      );
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails with a typed error when the reviewThreads query fails", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.fail(new Error("gh api graphql failed") as never));

      const result = yield* Effect.result(
        listUnresolvedReviewComments({ cwd: "/repo", reference: "#42" }),
      );
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("records latestCommit and fails when the reviewThreads query fails", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeJson({
              mergeable: "MERGEABLE",
              statusCheckRollup: [],
              reviews: [],
              latestCommit: { oid: "abc123def456" },
            }),
          ),
        ),
      );
      // The follow-up GraphQL query fails: the whole status read must fail
      // (audit item 5 — an unknown thread count must not pass the merge gate
      // as 0).
      mockRun.mockReturnValueOnce(Effect.fail(new Error("gh api graphql failed") as never));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* Effect.result(
        gh.getChangeRequestStatus({ cwd: "/repo", reference: "#42" }),
      );
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );
});
