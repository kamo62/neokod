import type {
  EffectiveWorkflowConfig,
  EvidenceBundle,
  PullRequestEvidence,
  RunAttemptId,
  WorkItem,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { nowIso } from "../Domain/Time.ts";

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
    ) => Effect.Effect<PullRequestEvidence, PullRequestCreationError>;

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
  }
>()("neokod/symphony/Evidence/PullRequest/PullRequestService") {}

export interface PullRequestServiceDeps {
  readonly git: GitVcsDriver["Service"];
  readonly providers: SourceControlProviderRegistry["Service"];
  readonly writeBodyFile?: (path: string, content: string) => Effect.Effect<void>;
  readonly nowIsoEffect?: () => Effect.Effect<string>;
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
      yield* deps.git.pushCurrentBranch(input.workspacePath, input.branch).pipe(
        Effect.mapError((cause) => new PullRequestCreationError(cause.message)),
        Effect.tapError((error) =>
          Effect.logWarning(`Symphony PR: branch push failed: ${error.message}`),
        ),
      );

      // 2. Write the body file.
      const now = yield* deps.nowIsoEffect?.() ?? nowIso;
      const safeRunId = String(input.runAttemptId).replace(/[^a-zA-Z0-9._-]/g, "_");
      const bodyFilePath = `${input.bodyFileDir}/pr-${safeRunId}-${now.replace(/[^0-9]/g, "")}.md`;
      const body = buildPullRequestBody(input.evidence);
      yield* (
        deps.writeBodyFile?.(bodyFilePath, body).pipe(Effect.catch(() => Effect.void)) ??
          Effect.void
      );

      // 3. Create the change request through the provider abstraction.
      const handle = yield* deps.providers
        .resolveHandle({ cwd: input.config.repositoryPath })
        .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message)));
      yield* handle.provider
        .createChangeRequest({
          cwd: input.config.repositoryPath,
          ...(handle.context !== null ? { context: handle.context } : {}),
          baseRefName: input.baseBranch,
          headSelector: input.branch,
          title: input.workItem.objective,
          bodyFile: bodyFilePath,
        })
        .pipe(Effect.mapError((cause) => new PullRequestCreationError(cause.message)));

      // 4. Look up the created PR to record number/url.
      const open = yield* handle.provider
        .listChangeRequests({
          cwd: input.config.repositoryPath,
          ...(handle.context !== null ? { context: handle.context } : {}),
          headSelector: input.branch,
          state: "open",
          limit: 10,
        })
        .pipe(
          Effect.mapError((cause) => new PullRequestCreationError(cause.message)),
          Effect.orElseSucceed(() => []),
        );
      const found = open.find((pullRequest) => pullRequest.headRefName === input.branch);

      if (found === undefined) {
        return {
          number: 0,
          title: input.workItem.objective,
          branch: input.branch,
          baseBranch: input.baseBranch,
          status: "open",
        } satisfies PullRequestEvidence;
      }

      return {
        number: found.number,
        title: found.title,
        branch: input.branch,
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
          state: "open",
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

  return { create, refresh };
};

export const PullRequestServiceLive: Layer.Layer<
  PullRequestService,
  never,
  GitVcsDriver | SourceControlProviderRegistry
> = Layer.effect(
  PullRequestService,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const providers = yield* SourceControlProviderRegistry;
    return makePullRequestService({ git, providers });
  }),
);
