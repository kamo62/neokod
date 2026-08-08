import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  type ChangeRequestStatus,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@neokod/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
} from "./gitHubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedErrorClass<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI (`gh`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedErrorClass<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedErrorClass<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliCommandError extends Schema.TaggedErrorClass<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI command failed.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenPullRequests: ${this.detail}`;
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedErrorClass<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listChangeRequests: ${this.detail}`;
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class GitHubChangeRequestStatusDecodeError extends Schema.TaggedErrorClass<GitHubChangeRequestStatusDecodeError>()(
  "GitHubChangeRequestStatusDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change-request status JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getChangeRequestStatus: ${this.detail}`;
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedErrorClass<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export class GitHubReviewCommentsDecodeError extends Schema.TaggedErrorClass<GitHubReviewCommentsDecodeError>()(
  "GitHubReviewCommentsDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid review-thread comments JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listUnresolvedReviewComments: ${this.detail}`;
  }
}

export class GitHubReviewThreadsDecodeError extends Schema.TaggedErrorClass<GitHubReviewThreadsDecodeError>()(
  "GitHubReviewThreadsDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid review-thread JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed while reading review threads: ${this.detail}`;
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubChangeRequestStatusDecodeError,
  GitHubRepositoryDecodeError,
  GitHubReviewCommentsDecodeError,
  GitHubReviewThreadsDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

export function fromVcsError(
  context: {
    readonly command: "gh";
    readonly cwd: string;
  },
  error: VcsError,
): GitHubCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new GitHubCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GitHubCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GitHubPullRequestNotFoundError({ ...context, cause: error });
    }
  }

  return new GitHubCliCommandError({ ...context, cause: error });
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

/**
 * One unresolved review-thread comment (plan FR-102-104): the opening
 * comment of a thread the reviewer has not marked resolved. Bodies are
 * returned raw here; bounding the count and truncating each body is the
 * prompt-building layer's job (`Runner/Prompt.ts`), not this client's.
 */
export interface GitHubReviewComment {
  readonly body: string;
  readonly author?: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getChangeRequestStatus: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<ChangeRequestStatus, GitHubCliError>;

    /**
     * Comment bodies for unresolved review threads (plan FR-102-104): a
     * continuation dispatch needs the actual feedback text, not just the
     * count `getChangeRequestStatus` returns. Same reviewThreads GraphQL
     * shape and `$owner`/`$name` variable pattern as `getChangeRequestStatus`
     * — the `:owner`/`:repo` magic variables are gh's own repo resolution
     * from `cwd`, not literal empty strings (fix-lane item 11 applies here
     * too). `limit` bounds how many unresolved threads are read (default 20);
     * one comment — the thread's opening comment — is returned per thread.
     *
     * Optional on the interface (not every `GitHubCli["Service"]` fake needs
     * it wired) — callers that need honest degradation when it is absent
     * treat a missing method the same as a host with no comment-body
     * enrichment.
     */
    readonly listUnresolvedReviewComments?: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubReviewComment>, GitHubCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;
  }
>()("neokod/sourceControl/GitHubCli") {}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
const decodeRawGitHubRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubRepositoryCloneUrlsSchema),
);

/**
 * Raw `gh pr view --json statusCheckRollup,reviews,mergeable,comments`
 * payload for host-enriched change-request status (plan 10.1).
 */
const RawGitHubChangeRequestStatusSchema = Schema.Struct({
  mergeable: Schema.optional(
    Schema.NullOr(Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"])),
  ),
  statusCheckRollup: Schema.optional(
    Schema.Array(
      Schema.Struct({
        status: Schema.optional(Schema.String),
        conclusion: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  reviews: Schema.optional(
    Schema.Array(
      Schema.Struct({
        state: Schema.optional(Schema.String),
      }),
    ),
  ),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  latestCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ oid: Schema.optional(Schema.String) })),
  ),
});

const decodeRawGitHubChangeRequestStatus = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubChangeRequestStatusSchema),
);

const RawGitHubReviewThreadSchema = Schema.Struct({
  isResolved: Schema.Boolean,
  comments: Schema.optionalKey(
    Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          body: Schema.String,
          author: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({
                login: Schema.String,
              }),
            ),
          ),
        }),
      ),
    }),
  ),
});

const RawGitHubReviewThreadsPageSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        reviewThreads: Schema.Struct({
          nodes: Schema.Array(RawGitHubReviewThreadSchema),
          pageInfo: Schema.Struct({
            hasNextPage: Schema.Boolean,
            endCursor: Schema.NullOr(Schema.String),
          }),
        }),
      }),
    }),
  }),
});

type RawGitHubReviewThread = typeof RawGitHubReviewThreadSchema.Type;

const decodeRawGitHubReviewThreadsPage = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubReviewThreadsPageSchema),
);

const normalizeChangeRequestStatus = (
  raw: Schema.Schema.Type<typeof RawGitHubChangeRequestStatusSchema>,
): ChangeRequestStatus => {
  const checks = raw.statusCheckRollup ?? [];
  const hasPending = checks.some(
    (check) =>
      check.status === "IN_PROGRESS" || check.status === "QUEUED" || check.status === "PENDING",
  );
  const hasFailed = checks.some(
    (check) =>
      check.conclusion === "FAILURE" ||
      check.conclusion === "TIMED_OUT" ||
      check.conclusion === "ACTION_REQUIRED",
  );
  const ciStatus =
    checks.length === 0 ? "unknown" : hasFailed ? "failure" : hasPending ? "pending" : "success";

  const reviews = (raw.reviews ?? []).map((review) => review.state ?? "").filter(Boolean);
  const latestDecision = reviews.length > 0 ? (reviews[reviews.length - 1] ?? "") : "";
  const reviewState: ChangeRequestStatus["reviewState"] =
    raw.reviewDecision === "APPROVED" || latestDecision === "APPROVED"
      ? "approved"
      : raw.reviewDecision === "CHANGES_REQUESTED" || latestDecision === "CHANGES_REQUESTED"
        ? "changes_requested"
        : raw.reviewDecision === "REVIEW_REQUIRED" || latestDecision === "REVIEW_REQUIRED"
          ? "review_required"
          : "none";

  // Unresolved comments are filled by the follow-up reviewThreads GraphQL
  // query in getChangeRequestStatus; the base view JSON cannot source them.
  const mergeable: ChangeRequestStatus["mergeable"] =
    raw.mergeable === "MERGEABLE"
      ? "mergeable"
      : raw.mergeable === "CONFLICTING"
        ? "conflicting"
        : "unknown";
  return {
    ciStatus,
    reviewState,
    mergeable,
    unresolvedComments: 0,
    // Audit item 5: record the head commit so merge gating and the UI can
    // tell "checked this commit" from "checked something older".
    ...(raw.latestCommit?.oid !== undefined && raw.latestCommit.oid.length > 0
      ? { latestCommit: raw.latestCommit.oid }
      : {}),
  };
};

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));

  const loadReviewThreads = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly includeComments: boolean;
  }): Effect.Effect<readonly RawGitHubReviewThread[], GitHubCliError> => {
    const query = input.includeComments
      ? "query=query($pr: Int!, $owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $cursor) { nodes { isResolved comments(first: 1) { nodes { body author { login } } } } pageInfo { hasNextPage endCursor } } } } }"
      : "query=query($pr: Int!, $owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } } } } }";

    const loadPage = (
      cursor: string | undefined,
      accumulated: readonly RawGitHubReviewThread[],
    ): Effect.Effect<readonly RawGitHubReviewThread[], GitHubCliError> =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "-f",
          query,
          "-F",
          `pr=${input.reference.replace(/^#/, "")}`,
          "-F",
          "owner=:owner",
          "-F",
          "name=:repo",
          ...(cursor === undefined ? [] : ["-F", `cursor=${cursor}`]),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubReviewThreadsPage(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubReviewThreadsDecodeError({ command: "gh", cwd: input.cwd, cause }),
            ),
          ),
        ),
        Effect.flatMap((page) => {
          const connection = page.data.repository.pullRequest.reviewThreads;
          const nodes = [...accumulated, ...connection.nodes];
          if (!connection.pageInfo.hasNextPage) {
            return Effect.succeed(nodes);
          }
          if (connection.pageInfo.endCursor === null) {
            return Effect.fail(
              new GitHubReviewThreadsDecodeError({
                command: "gh",
                cwd: input.cwd,
                cause: "page hasNextPage without an endCursor",
              }),
            );
          }
          return loadPage(connection.pageInfo.endCursor, nodes);
        }),
      );

    return loadPage(undefined, []);
  };

  return GitHubCli.of({
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubPullRequestListDecodeError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(
                    decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                  );
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubPullRequestDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(
                (({ updatedAt: _updatedAt, ...summary }) => summary)(decoded.success),
              );
            }),
          ),
        ),
      ),
    getChangeRequestStatus: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "mergeable,statusCheckRollup,reviews,reviewDecision,latestCommit",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          // Schema.fromJsonString folds a parse failure into the typed error
          // channel; a bare JSON.parse would escape as a defect (REVIEW P1).
          decodeRawGitHubChangeRequestStatus(raw).pipe(
            Effect.map(normalizeChangeRequestStatus),
            Effect.mapError(
              (cause) =>
                new GitHubChangeRequestStatusDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        // Unresolved review-thread count comes from GraphQL; `gh pr view
        // --json comments` returns conversation comments without
        // isResolved/line, so the field was always 0 against real GitHub
        // (REVIEW P1). Query reviewThreads and merge the count in. The
        // owner/name come from gh's :owner/:repo magic variables, which gh
        // expands from the cwd repository (fix-lane item 11: a literal
        // repository(owner: "", name: "") made real GitHub return null and
        // the gate a dead 0).
        Effect.flatMap((status) =>
          loadReviewThreads({
            cwd: input.cwd,
            reference: input.reference,
            includeComments: false,
          }).pipe(
            Effect.map((threads) => threads.filter((thread) => thread.isResolved !== true).length),
            Effect.mapError(
              (cause) =>
                new GitHubChangeRequestStatusDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
            Effect.map((unresolved) => ({ ...status, unresolvedComments: unresolved })),
          ),
        ),
      ),
    listUnresolvedReviewComments: (input) =>
      loadReviewThreads({
        cwd: input.cwd,
        reference: input.reference,
        includeComments: true,
      }).pipe(
        Effect.map((threads) => {
          const limit = input.limit ?? 20;
          const comments: GitHubReviewComment[] = [];
          for (const thread of threads) {
            if (thread.isResolved) {
              continue;
            }
            const node = thread.comments?.nodes[0];
            if (node === undefined) {
              continue;
            }
            const login = node.author?.login;
            comments.push({
              body: node.body,
              ...(login !== undefined ? { author: login } : {}),
            });
            if (comments.length >= limit) {
              break;
            }
          }
          return comments;
        }),
        Effect.mapError(
          (cause) =>
            new GitHubReviewCommentsDecodeError({
              command: "gh",
              cwd: input.cwd,
              cause,
            }),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRepositoryDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make);
