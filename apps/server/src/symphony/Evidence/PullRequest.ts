import type {
  EffectiveWorkflowConfig,
  EvidenceBundle,
  PullRequestEvidence,
  RunAttemptId,
  WorkItem,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { nowIso } from "../Domain/Time.ts";
import type { ReviewFeedbackComment } from "../Runner/Prompt.ts";

/**
 * Orchestrator-owned PR creation (plan D4, 10.1; WS-L).
 *
 * Creates the review-ready pull request for a completed run. The flow goes
 * strictly through the SourceControlProvider abstraction — never a hard-coded
 * CLI — so GitHub, GitLab, Bitbucket and Azure DevOps all work at no extra
 * cost. Steps:
 *
 * 1. Push the work branch from the workspace (a PR needs an upstream).
 * 2. Write a deterministic, host-derived PR body from the evidence bundle
 *    (summary, changed files, validation table). No model-generated prose:
 *    this is an inventory, and it is honest about what it is.
 * 3. `createChangeRequest` via the provider.
 * 4. Look up the open PR for the branch to record number/url as
 *    PullRequestEvidence.
 */

export class PullRequestCreationError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Pull request creation failed: ${detail}`);
    this.name = "PullRequestCreationError";
    this.detail = detail;
  }
}

export interface CreatePullRequestInput {
  readonly workItem: WorkItem;
  readonly config: EffectiveWorkflowConfig;
  readonly runAttemptId: RunAttemptId;
  readonly workspacePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly evidence: EvidenceBundle;
  /** Where to write the PR body file (temp dir). */
  readonly bodyFileDir: string;
}

export class PullRequestService extends Context.Service<
  PullRequestService,
  {
    readonly create: (
      input: CreatePullRequestInput,
    ) => Effect.Effect<PullRequestEvidence | null, PullRequestCreationError>;

    /**
     * Re-fetch the open PR for a branch via the provider abstraction and
     * return refreshed evidence (plan 10.1: status, review state and
     * mergeability are enriched host-by-host in Phase 5; the provider shape
     * today carries number/title/url/base/head/state, which is what this
     * refresh propagates).
     */
    readonly refresh: (input: {
      readonly config: EffectiveWorkflowConfig;
      readonly branch: string;
      readonly baseBranch: string;
      readonly title: string;
    }) => Effect.Effect<PullRequestEvidence | null, PullRequestCreationError>;

    /**
     * Unresolved review-thread comment bodies for a continuation dispatch
     * (plan FR-102-104). GitHub only, since the SourceControlProvider
     * abstraction has no cross-host comment-body method yet — `null` means
     * the host cannot supply comment bodies (non-GitHub, an unresolvable
     * handle, or the enrichment call itself failed), and callers fall back
     * to counts-only review context rather than silently implying there are
     * no comments.
     */
    readonly listUnresolvedComments: (input: {
      readonly config: EffectiveWorkflowConfig;
      readonly pullRequestNumber: number;
    }) => Effect.Effect<ReadonlyArray<ReviewFeedbackComment> | null>;
  }
>()("neokod/symphony/Evidence/PullRequest/PullRequestService") {}

export interface PullRequestServiceDeps {
  readonly git: GitVcsDriver["Service"];
  readonly providers: SourceControlProviderRegistry["Service"];
  /** Optional: absent in tests that never exercise `listUnresolvedComments`,
   * which degrades to `null` (counts-only) without it. */
  readonly githubCli?: GitHubCli["Service"];
  readonly writeBodyFile?: (path: string, content: string) => Effect.Effect<void, Error>;
  readonly makeBodyFileDir?: (dir: string) => Effect.Effect<void, Error>;
  readonly nowIsoEffect?: () => Effect.Effect<string>;
  /** Resolve the default PR-body directory when the caller supplies none. */
  readonly resolveBodyFileDir?: () => string;
}

const buildPullRequestBody = (evidence: EvidenceBundle): string => {
  const lines: string[] = [];
  lines.push(`## Summary`);
  lines.push(evidence.implementationSummary ?? "*No agent summary supplied.*");
  lines.push("");
  if (evidence.changedFiles.length > 0) {
    lines.push(`## Changed files`);
    lines.push("");
    lines.push("| Path | Additions | Deletions |");
    lines.push("| --- | ---: | ---: |");
    for (const file of evidence.changedFiles) {
      lines.push(`| ${file.path} | ${file.additions ?? 0} | ${file.deletions ?? 0} |`);
    }
    lines.push("");
  }
  if (evidence.validationResults.length > 0) {
    lines.push(`## Validation`);
    lines.push("");
    lines.push("| Command | Status |");
    lines.push("| --- | --- |");
    for (const result of evidence.validationResults) {
      lines.push(`| \`${result.command}\` | ${result.status} |`);
    }
    lines.push("");
  }
  if (evidence.risks.length > 0) {
    lines.push(`## Risks`);
    for (const risk of evidence.risks) {
      lines.push(`- **[${risk.severity}]** ${risk.text}`);
    }
    lines.push("");
  }
  lines.push(`---
_Opened by Neokod Symphony. Assessment: \`${evidence.overallAssessment}\`._`);
  return lines.join("\n");
};

export const makePullRequestService = (
  deps: PullRequestServiceDeps,
): PullRequestService["Service"] => {
  const create: PullRequestService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      // 1. Push the work branch so the provider can open a PR for it.
      //    Consume the pushed branch so evidence, headSelector and lookup all
      //    use the branch the agent actually checked out (RECONCILE binding
      //    constraint: Symphony branch identity must be authoritative).
      const pushed = yield* deps.git.pushCurrentBranch(input.workspacePath, input.branch).pipe(
        Effect.mapError((cause) => new PullRequestCreationError(cause.message)),
        Effect.tapError((error) =>
          Effect.logWarning(`Symphony PR: branch push failed: ${error.message}`),
        ),
      );
      const effectiveBranch = pushed.branch.length > 0 ? pushed.branch : input.branch;

      // 2. Write the body file. `bodyFileDir` falls back to the live layer's
      //    default so the file always lands somewhere writable (REVIEW P0:
      //    an empty dir produced `/pr-...md` at the filesystem root and the
      //    PR creation failed silently).
      const now = yield* deps.nowIsoEffect?.() ?? nowIso;
      const safeRunId = String(input.runAttemptId).replace(/[^a-zA-Z0-9._-]/g, "_");
      const bodyFileDir =
        input.bodyFileDir.length > 0 ? input.bodyFileDir : (deps.resolveBodyFileDir?.() ?? "");
      if (bodyFileDir.length === 0) {
        return yield* Effect.fail(new PullRequestCreationError("no PR body directory configured"));
      }
      if (deps.writeBodyFile === undefined) {
        return yield* Effect.fail(new PullRequestCreationError("PR body file writer is not wired"));
      }
      const bodyFilePath = `${bodyFileDir}/pr-${safeRunId}-${now.replace(/[^0-9]/g, "")}.md`;
      const body = buildPullRequestBody(input.evidence);
      // The write is typed and mandatory (REVIEW fix-lane item 1): a missing
      // directory must fail create() so the run cannot reach ready_for_review
      // with no PR and the failure swallowed.
      if (deps.makeBodyFileDir !== undefined) {
        yield* deps
          .makeBodyFileDir(bodyFileDir)
          .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message)));
      }
      yield* deps
        .writeBodyFile(bodyFilePath, body)
        .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message)));

      // 3. Create the change request through the provider abstraction.
      const handle = yield* deps.providers
        .resolveHandle({ cwd: input.config.repositoryPath })
        .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message)));
      yield* handle.provider
        .createChangeRequest({
          cwd: input.config.repositoryPath,
          ...(handle.context !== null ? { context: handle.context } : {}),
          baseRefName: input.baseBranch,
          headSelector: effectiveBranch,
          title: input.workItem.objective,
          bodyFile: bodyFilePath,
        })
        .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message)));

      // 4. Look up the created PR to record number/url, matching on the
      //    effective (pushed) branch.
      const open = yield* handle.provider
        .listChangeRequests({
          cwd: input.config.repositoryPath,
          ...(handle.context !== null ? { context: handle.context } : {}),
          headSelector: effectiveBranch,
          state: "open",
          limit: 10,
        })
        .pipe(
          Effect.mapError((cause) => new PullRequestCreationError(cause.message)),
          Effect.orElseSucceed(() => []),
        );
      const found = open.find((pullRequest) => pullRequest.headRefName === effectiveBranch);

      if (found === undefined) {
        // The created PR could not be located: that is the absence of
        // evidence, not evidence (REVIEW P2: a fabricated number:0 record
        // later passed merge gating). The caller records the failure.
        return null;
      }

      return {
        number: found.number,
        title: found.title,
        branch: effectiveBranch,
        baseBranch: input.baseBranch,
        url: found.url,
        status: "open",
      } satisfies PullRequestEvidence;
    });

  const refresh: PullRequestService["Service"]["refresh"] = (input) =>
    Effect.gen(function* () {
      const handle = yield* deps.providers
        .resolveHandle({ cwd: input.config.repositoryPath })
        .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message)));
      const open = yield* handle.provider
        .listChangeRequests({
          cwd: input.config.repositoryPath,
          ...(handle.context !== null ? { context: handle.context } : {}),
          headSelector: input.branch,
          // Query all states so a merged/closed PR is reflected in evidence
          // (REVIEW P2: filtering on "open" froze the status at "open"
          // forever after merge).
          state: "all",
          limit: 10,
        })
        .pipe(
          Effect.mapError((cause) => new PullRequestCreationError(cause.message)),
          Effect.orElseSucceed(() => []),
        );
      const found = open.find((pullRequest) => pullRequest.headRefName === input.branch);
      if (found === undefined) {
        return null;
      }
      // Host-enriched status (plan 10.1, Phase 5): CI status, review state,
      // mergeability and unresolved-comment count. Hosts without enrichment
      // return null, leaving these fields absent.
      const status = yield* handle.provider
        .getChangeRequestStatus({
          cwd: input.config.repositoryPath,
          ...(handle.context !== null ? { context: handle.context } : {}),
          reference: String(found.number),
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return {
        number: found.number,
        title: found.title,
        branch: input.branch,
        baseBranch: input.baseBranch,
        url: found.url,
        status: found.state === "merged" ? "merged" : found.state === "closed" ? "closed" : "open",
        ...(status !== null
          ? {
              ciStatus: status.ciStatus,
              reviewState: status.reviewState,
              mergeable: status.mergeable,
              unresolvedComments: status.unresolvedComments,
              ...(status.latestCommit !== undefined ? { latestCommit: status.latestCommit } : {}),
            }
          : {}),
      } satisfies PullRequestEvidence;
    });

  const listUnresolvedComments: PullRequestService["Service"]["listUnresolvedComments"] = (input) =>
    Effect.gen(function* () {
      const githubCli = deps.githubCli;
      if (githubCli === undefined || githubCli.listUnresolvedReviewComments === undefined) {
        return null;
      }
      const handle = yield* deps.providers
        .resolveHandle({ cwd: input.config.repositoryPath })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      // Honest degradation (plan 10.1, FR-102-104): only GitHub has
      // comment-body enrichment today. Other hosts — and a handle that
      // cannot be resolved — fall back to counts-only review context rather
      // than a fabricated empty list.
      if (handle === null || handle.provider.kind !== "github") {
        return null;
      }
      return yield* githubCli
        .listUnresolvedReviewComments({
          cwd: input.config.repositoryPath,
          reference: String(input.pullRequestNumber),
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
    });

  return { create, refresh, listUnresolvedComments };
};

export const PullRequestServiceLive: Layer.Layer<
  PullRequestService,
  never,
  GitVcsDriver | SourceControlProviderRegistry | FileSystem.FileSystem | GitHubCli
> = Layer.effect(
  PullRequestService,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const providers = yield* SourceControlProviderRegistry;
    const fileSystem = yield* FileSystem.FileSystem;
    const githubCli = yield* GitHubCli;
    return makePullRequestService({
      git,
      providers,
      githubCli,
      // The PR body file must be written by the production wiring (plan 10:
      // deterministic host-derived body). A missing write would make
      // `gh pr create --body-file` fail on the first live run. Failures are
      // typed, not swallowed (fix-lane item 1: ENOENT must fail create()).
      writeBodyFile: (path, content) =>
        fileSystem
          .writeFileString(path, content)
          .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message))),
      makeBodyFileDir: (dir) =>
        fileSystem
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message))),
    });
  }),
);
