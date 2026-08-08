import {
  ProviderDriverKind,
  type EffectiveWorkflowConfig,
  type ModelReviewArtefact,
  type ModelReviewerResult,
  type ServerProvider,
  type WorkItem,
} from "@neokod/contracts";
import { createModelSelection } from "@neokod/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ReviewService } from "../../review/ReviewService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { nowIso } from "../Domain/Time.ts";

export interface ModelReviewInput {
  readonly config: EffectiveWorkflowConfig;
  readonly workItem: WorkItem;
  readonly workspacePath: string;
  readonly baseRef: string;
  readonly headRef: string;
}

export class SymphonyModelReviewer extends Context.Service<
  SymphonyModelReviewer,
  {
    readonly review: (input: ModelReviewInput) => Effect.Effect<ModelReviewArtefact | null, never>;
  }
>()("neokod/symphony/Review/ModelReviewer/SymphonyModelReviewer") {}

export interface SymphonyModelReviewerDeps {
  readonly registry: ProviderInstanceRegistry["Service"];
  readonly reviewService: ReviewService["Service"];
  readonly git: GitVcsDriver["Service"];
  readonly nowIsoEffect?: () => Effect.Effect<string>;
}

const failureResult = (input: {
  readonly model: string;
  readonly provider?: string;
  readonly error: string;
  readonly reviewedAt: string;
}): ModelReviewerResult => ({
  provenance: "model",
  provider: input.provider ?? "unresolved",
  model: input.model,
  status: "failed",
  summary: "Model review did not complete.",
  findings: [],
  error: input.error,
  reviewedAt: input.reviewedAt,
});

interface ProviderSnapshot {
  readonly instance: ProviderInstance;
  readonly snapshot: ServerProvider;
}

const resolveModel = (
  providers: ReadonlyArray<ProviderSnapshot>,
  model: string,
): { readonly instance: ProviderInstance } | { readonly error: string } => {
  const matches = providers.filter(
    ({ instance, snapshot }) =>
      instance.enabled &&
      instance.driverKind !== ProviderDriverKind.make("kiro") &&
      snapshot.availability !== "unavailable" &&
      snapshot.models.some((candidate) => candidate.slug === model),
  );
  if (matches.length === 0) {
    return { error: `No enabled provider instance exposes reviewer model '${model}'.` };
  }
  if (matches.length > 1) {
    return {
      error: `Reviewer model '${model}' is ambiguous across provider instances: ${matches
        .map(({ instance }) => String(instance.instanceId))
        .join(", ")}.`,
    };
  }
  return { instance: matches[0]!.instance };
};

const normalizeCompletedResult = (input: {
  readonly instance: ProviderInstance;
  readonly model: string;
  readonly reviewedAt: string;
  readonly generated: {
    readonly verdict: "approve" | "request_changes";
    readonly summary: string;
    readonly findings: ReadonlyArray<{
      readonly severity: "info" | "warning" | "blocking";
      readonly title: string;
      readonly detail: string;
      readonly path?: string | undefined;
    }>;
  };
}): ModelReviewerResult => {
  const findings = input.generated.findings.flatMap((finding) => {
    const title = finding.title.trim();
    const detail = finding.detail.trim();
    if (title.length === 0 || detail.length === 0) {
      return [];
    }
    const path = finding.path?.trim();
    return [
      {
        severity: finding.severity,
        title,
        detail,
        ...(path !== undefined && path.length > 0 ? { path } : {}),
      },
    ];
  });
  const hasBlockingFinding = findings.some((finding) => finding.severity === "blocking");
  return {
    provenance: "model",
    provider: String(input.instance.instanceId),
    model: input.model,
    status: "completed",
    verdict: hasBlockingFinding ? "request_changes" : input.generated.verdict,
    summary: input.generated.summary.trim(),
    findings,
    reviewedAt: input.reviewedAt,
  };
};

const aggregateReview = (input: {
  readonly requirement: "all-approve" | "any-approve" | "advisory";
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly sourceHashes: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<ModelReviewerResult>;
  readonly reviewedAt: string;
}): ModelReviewArtefact => {
  const approvals = input.reviewers.filter(
    (reviewer) => reviewer.status === "completed" && reviewer.verdict === "approve",
  ).length;
  const passed =
    input.requirement === "advisory"
      ? true
      : input.requirement === "all-approve"
        ? input.reviewers.length > 0 && approvals === input.reviewers.length
        : approvals > 0;
  return {
    provenance: "model",
    target: "baseBranch",
    baseRef: input.baseRef,
    headRef: input.headRef,
    ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
    ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
    sourceHashes: [...input.sourceHashes],
    require: input.requirement,
    verdict: input.requirement === "advisory" ? "advisory" : passed ? "approve" : "request_changes",
    passed,
    reviewers: [...input.reviewers],
    reviewedAt: input.reviewedAt,
  };
};

export const makeSymphonyModelReviewer = (
  deps: SymphonyModelReviewerDeps,
): SymphonyModelReviewer["Service"] => {
  const review: SymphonyModelReviewer["Service"]["review"] = (input) =>
    Effect.gen(function* () {
      const models = input.config.reviewAgents ?? [];
      if (models.length === 0) {
        return null;
      }
      const requirement = input.config.reviewRequirement ?? "advisory";
      const reviewedAt = yield* deps.nowIsoEffect?.() ?? nowIso;
      const instances = yield* deps.registry.listInstances;
      const [providers, diffResult, revisionResult] = yield* Effect.all([
        Effect.forEach(instances, (instance) =>
          instance.snapshot.getSnapshot.pipe(
            Effect.map((snapshot) => ({ instance, snapshot }) satisfies ProviderSnapshot),
          ),
        ),
        deps.reviewService
          .getDiffPreview({ cwd: input.workspacePath, baseRef: input.baseRef })
          .pipe(Effect.result),
        Effect.all([
          deps.git.execute({
            operation: "SymphonyModelReviewer.resolveBaseSha",
            cwd: input.workspacePath,
            args: ["rev-parse", "--verify", `${input.baseRef}^{commit}`],
          }),
          deps.git.execute({
            operation: "SymphonyModelReviewer.resolveHeadSha",
            cwd: input.workspacePath,
            args: ["rev-parse", "--verify", `${input.headRef}^{commit}`],
          }),
        ]).pipe(
          Effect.map(([base, head]) => ({
            baseSha: base.stdout.trim(),
            headSha: head.stdout.trim(),
          })),
          Effect.result,
        ),
      ]);
      const sourceHashes =
        diffResult._tag === "Success"
          ? diffResult.success.sources.map((source) => source.diffHash)
          : [];
      const revisions =
        revisionResult._tag === "Success" &&
        revisionResult.success.baseSha.length > 0 &&
        revisionResult.success.headSha.length > 0
          ? revisionResult.success
          : null;
      const failedAggregate = (error: string) => {
        const reviewers = models.map((model) => failureResult({ model, error, reviewedAt }));
        return aggregateReview({
          requirement,
          baseRef: input.baseRef,
          headRef: input.headRef,
          ...revisions,
          sourceHashes,
          reviewers,
          reviewedAt,
        });
      };

      if (diffResult._tag === "Failure") {
        return failedAggregate(
          `Unable to load the bounded review diff: ${String(diffResult.failure)}`,
        );
      }
      if (revisions === null) {
        return failedAggregate(
          revisionResult._tag === "Failure"
            ? `Unable to resolve reviewed revisions: ${String(revisionResult.failure)}`
            : "Git returned an empty reviewed revision.",
        );
      }

      const diffPatch = diffResult.success.sources
        .map((source) => `# ${source.title}\n${source.diff}`)
        .join("\n\n");
      if (diffPatch.trim().length === 0) {
        return failedAggregate("No changed diff was available for model review.");
      }

      const reviewers = yield* Effect.forEach(
        models,
        (model) => {
          const resolved = resolveModel(providers, model);
          if ("error" in resolved) {
            return Effect.succeed(failureResult({ model, error: resolved.error, reviewedAt }));
          }
          const instance = resolved.instance;
          return instance.textGeneration
            .generateCodeReview({
              cwd: input.workspacePath,
              objective: input.workItem.objective,
              acceptanceCriteria: input.workItem.acceptanceCriteria,
              baseRef: input.baseRef,
              headRef: input.headRef,
              diffPatch,
              modelSelection: createModelSelection(instance.instanceId, model),
            })
            .pipe(
              Effect.map((generated) =>
                normalizeCompletedResult({ instance, model, reviewedAt, generated }),
              ),
              Effect.catch((cause) =>
                Effect.succeed(
                  failureResult({
                    model,
                    provider: String(instance.instanceId),
                    error: cause.message,
                    reviewedAt,
                  }),
                ),
              ),
            );
        },
        { concurrency: 2 },
      );

      return aggregateReview({
        requirement,
        baseRef: input.baseRef,
        headRef: input.headRef,
        ...revisions,
        sourceHashes,
        reviewers,
        reviewedAt,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError(`Symphony model review failed unexpectedly: ${String(cause)}`).pipe(
          Effect.as(null),
        ),
      ),
    );

  return { review };
};

export const SymphonyModelReviewerLive: Layer.Layer<
  SymphonyModelReviewer,
  never,
  ProviderInstanceRegistry | ReviewService | GitVcsDriver
> = Layer.effect(
  SymphonyModelReviewer,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const reviewService = yield* ReviewService;
    const git = yield* GitVcsDriver;
    return makeSymphonyModelReviewer({ registry, reviewService, git });
  }),
);
