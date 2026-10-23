import type {
  AcceptedGuidanceSnapshot,
  EffectiveWorkflowConfig,
  EvidenceBundle,
  NormalizedIssue,
  RunAttemptId,
  WorkItem,
} from "@neokod/contracts";
import { AttentionItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { EvidenceRepository } from "../Persistence/Services/EvidenceRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { AttentionRepository } from "../Persistence/Services/AttentionRepository.ts";
import { nowIso } from "../Domain/Time.ts";
import { EvidenceService } from "../Evidence/Service.ts";
import { PullRequestService } from "../Evidence/PullRequest.ts";
import { SymphonyModelReviewer } from "../Review/ModelReviewer.ts";
import { ValidationRunner } from "../Validation/Runner.ts";
import { narrowAcceptedPermissions, resolveAcceptedPermissions } from "./AcceptedGuidance.ts";

/**
 * Execution finalizer (plan 10, WS-L exit).
 *
 * Runs when an execute/deliver turn completes: runs the workflow's required
 * validation, assembles the evidence bundle, and lands the work item in a
 * stopping state.
 *
 * - All required validation passed (or none configured): create the PR
 *   (orchestrator-owned, best-effort), persist the bundle, transition the
 *   work item to `ready_for_review`.
 * - A required check failed or was unavailable: persist the bundle with a
 *   `failed` assessment, mark the attempt `validation_failed`, transition the
 *   work item to `validation_failed` so the retry scheduler (WS-M) can pick it
 *   up.
 *
 * The agent handoff file (`SYMPHONY_EVIDENCE.md`) is read from the workspace;
 * a missing file leaves the agent fields empty and the assessment
 * `insufficient`, per plan 10 (no generated fallback).
 */

export type FinalizeOutcome = "review_ready" | "validation_failed" | "delivery_refused";

/**
 * Narrow publication-policy result. `refused` means the owner already recorded
 * the refusal; the finalizer must not publish and must not duplicate lifecycle
 * ownership. `null` means the reader was unavailable.
 */
export type PublicationPolicyRefresh =
  | { readonly status: "available"; readonly config: EffectiveWorkflowConfig }
  | { readonly status: "refused"; readonly reason?: string }
  | null;

export class ExecutionFinalizer extends Context.Service<
  ExecutionFinalizer,
  {
    readonly finalize: (input: {
      readonly workItem: WorkItem;
      readonly issue: NormalizedIssue;
      readonly runAttemptId: RunAttemptId;
      readonly config: EffectiveWorkflowConfig;
      readonly workspacePath: string;
      readonly branch: string;
      readonly baseBranch: string;
      readonly ownerToken: string;
      readonly generation: number;
      readonly bodyFileDir?: string;
      /**
       * Re-read the accepted workflow policy immediately before push/PR.
       * Production Dispatcher supplies this; accepted attempts without it
       * refuse publication rather than using a stale admission-time config.
       */
      readonly refreshPublicationPolicy?: () => Effect.Effect<PublicationPolicyRefresh>;
    }) => Effect.Effect<FinalizeOutcome, never>;
  }
>()("neokod/symphony/Runner/ExecutionFinalizer") {}

const EVIDENCE_FILE_NAME = "SYMPHONY_EVIDENCE.md";

interface DeliveryGateDecision {
  readonly required: boolean;
  readonly reason: string;
  readonly approvalBeforePush: boolean | null;
  readonly approvalBeforePullRequest: boolean | null;
}

/**
 * Publication is bounded by the persisted accepted permission when one exists,
 * intersected with the current workflow. Until a durable push/pull-request
 * approval authority exists, any required gate refuses publication outright:
 * the finalizer must not push a branch or open a PR on the strength of the
 * workflow text alone.
 */
const resolveDeliveryGate = (
  config: EffectiveWorkflowConfig,
  acceptedGuidance: AcceptedGuidanceSnapshot | undefined,
): DeliveryGateDecision => {
  const livePermission = resolveAcceptedPermissions(config);
  const permission =
    acceptedGuidance === undefined
      ? { _tag: "narrowed" as const, permission: livePermission }
      : narrowAcceptedPermissions(acceptedGuidance.permission, livePermission);
  if (permission._tag === "unrepresentable") {
    return {
      required: true,
      reason:
        `Publication refused: the accepted and current workflow approval policies cannot be combined ` +
        `without changing approval requirements (${permission.reason}: accepted ` +
        `${permission.acceptedApprovalPolicy}, live ${permission.liveApprovalPolicy}).`,
      approvalBeforePush: null,
      approvalBeforePullRequest: null,
    };
  }
  const gates = permission.permission.delivery;
  const pushRequired = gates.approvalBeforePush === true;
  const pullRequestRequired = gates.approvalBeforePullRequest === true;
  if (!pushRequired && !pullRequestRequired) {
    return {
      required: false,
      reason: "",
      approvalBeforePush: gates.approvalBeforePush,
      approvalBeforePullRequest: gates.approvalBeforePullRequest,
    };
  }
  const requirements = [
    ...(pushRequired ? ["push"] : []),
    ...(pullRequestRequired ? ["pull request"] : []),
  ].join(" and ");
  return {
    required: true,
    reason:
      `Publication refused: approval before ${requirements} is required, but no durable ` +
      `push/pull-request approval authority exists. No branch was pushed and no pull request was opened.`,
    approvalBeforePush: gates.approvalBeforePush,
    approvalBeforePullRequest: gates.approvalBeforePullRequest,
  };
};

export const makeExecutionFinalizer = Effect.gen(function* () {
  const validationRunner = yield* ValidationRunner;
  const evidenceService = yield* EvidenceService;
  const modelReviewer = yield* SymphonyModelReviewer;
  const pullRequestService = yield* PullRequestService;
  const evidenceRepository = yield* EvidenceRepository;
  const runAttempts = yield* RunAttemptRepository;
  const runEvents = yield* RunEventRepository;
  const workItems = yield* WorkItemRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const attention = yield* AttentionRepository;

  const appendEvent = (
    runAttemptId: RunAttemptId,
    eventType: string,
    payload?: Record<string, unknown>,
  ) => runEvents.append(runAttemptId, eventType, payload).pipe(Effect.catch(() => Effect.void));

  const settleLifecycle = (
    input: {
      readonly workItem: WorkItem;
      readonly runAttemptId: RunAttemptId;
      readonly ownerToken: string;
      readonly generation: number;
    },
    lifecycle: "retry_scheduled" | "validation_failed" | "ready_for_review" | "failed",
  ) =>
    workItems
      .transition(input.workItem.id, lifecycle, {
        ownerToken: input.ownerToken,
        generation: input.generation,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("symphony.finalizer.transition_error", {
            workItemId: String(input.workItem.id),
            to: lifecycle,
            cause: String(cause),
          }).pipe(Effect.as(false)),
        ),
        Effect.flatMap((moved) =>
          moved
            ? Effect.void
            : Effect.logWarning("symphony.finalizer.transition_refused", {
                workItemId: String(input.workItem.id),
                to: lifecycle,
              }).pipe(
                Effect.andThen(
                  appendEvent(input.runAttemptId, "lifecycle_transition_refused", {
                    to: lifecycle,
                  }),
                ),
              ),
        ),
      );

  const finalize: ExecutionFinalizer["Service"]["finalize"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;

      const enteredTesting = yield* workItems
        .transition(input.workItem.id, "testing", {
          ownerToken: input.ownerToken,
          generation: input.generation,
          from: ["running"],
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (enteredTesting && input.config.validationRequired.length > 0) {
        yield* appendEvent(input.runAttemptId, "validation_started");
      }

      // 1. Read the current attempt WITHOUT mutating it. Missing and unreadable
      //    attempts are distinct from a legacy row whose accepted snapshot is
      //    absent; neither may be treated as an accepted brief. Refuse
      //    publication before validation, push or PR creation can run.
      const attemptRead = yield* Effect.result(runAttempts.getById(input.runAttemptId));
      if (attemptRead._tag === "Failure" || attemptRead.success === null) {
        const unreadable = attemptRead._tag === "Failure";
        const reason = unreadable
          ? "Publication refused: the run attempt could not be read, so its accepted publication policy cannot be established. No branch was pushed and no pull request was opened."
          : "Publication refused: the run attempt is missing, so its accepted publication policy cannot be established. No branch was pushed and no pull request was opened.";
        yield* appendEvent(input.runAttemptId, "delivery_refused", {
          reason,
          attemptRead: unreadable ? "failed" : "missing",
          ...(unreadable ? { cause: String(attemptRead.failure) } : {}),
        });
        yield* runAttempts
          .updateStatus(input.runAttemptId, "workflow_error", {
            finishedAt: now,
            error: { category: "workflow_error", message: reason },
          })
          .pipe(Effect.catch(() => Effect.void));
        yield* settleLifecycle(input, "failed");
        yield* attention
          .create({
            id: AttentionItemId.make(
              `delivery-attempt-unavailable-${String(input.runAttemptId).replace(/[^a-zA-Z0-9._-]/g, "_")}`,
            ),
            workItemId: input.workItem.id,
            runAttemptId: String(input.runAttemptId),
            kind: "workflow_invalid",
            severity: "high",
            whatHappened: reason,
            whyHuman:
              "Neokod cannot prove the attempt's accepted publication policy or ownership, so it must not publish.",
            recommendedResponse:
              "Inspect the run attempt and its workspace. No branch was pushed and no pull request was opened.",
            availableActions: ["take-over", "abandon"],
          })
          .pipe(Effect.catch(() => Effect.void));
        return "delivery_refused" as const;
      }
      const attempt = attemptRead.success;

      // 2. Validation (no-op when nothing is configured).
      const validationResults = yield* validationRunner.runAll({
        config: input.config,
        runAttemptId: input.runAttemptId,
        workspacePath: input.workspacePath,
      });

      // 3. Agent handoff file; missing is a fact, not an error.
      const evidenceFileContent = yield* fileSystem
        .readFileString(`${input.workspacePath}/${EVIDENCE_FILE_NAME}`)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      // 4. Assemble the bundle against the exact durable attempt. A legacy row
      //    with no accepted snapshot remains supported through the live
      //    workflow policy; no snapshot is synthesised here.
      let evidence: EvidenceBundle = yield* evidenceService.assemble({
        workItem: input.workItem,
        issue: input.issue,
        runAttempt: attempt,
        config: input.config,
        workspacePath: input.workspacePath,
        baseBranch: input.baseBranch,
        branch: input.branch,
        validationResults,
        evidenceFileContent,
      });

      const refusePublication = (
        reason: string,
        extra?: Readonly<Record<string, unknown>>,
      ): Effect.Effect<FinalizeOutcome> =>
        Effect.gen(function* () {
          yield* evidenceRepository
            .upsert(input.workItem.id, evidence)
            .pipe(Effect.catch(() => Effect.void));
          yield* runAttempts
            .updateStatus(input.runAttemptId, "workflow_error", {
              finishedAt: now,
              error: { category: "workflow_error", message: reason },
            })
            .pipe(Effect.catch(() => Effect.void));
          yield* settleLifecycle(input, "failed");
          yield* appendEvent(input.runAttemptId, "delivery_refused", {
            reason,
            ...extra,
          });
          yield* attention
            .create({
              id: AttentionItemId.make(
                `delivery-gated-${String(input.runAttemptId).replace(/[^a-zA-Z0-9._-]/g, "_")}`,
              ),
              workItemId: input.workItem.id,
              runAttemptId: String(input.runAttemptId),
              kind: "workflow_invalid",
              severity: "high",
              whatHappened: reason,
              whyHuman:
                "Publication cannot proceed under the accepted or current workflow policy, and no durable push/pull-request approval authority exists.",
              recommendedResponse:
                "Lower the workflow gate or take over the workspace and publish manually. This attempt did not push or open a pull request.",
              availableActions: ["take-over", "abandon"],
            })
            .pipe(Effect.catch(() => Effect.void));
          return "delivery_refused" as const;
        });

      const failed = validationResults.some(
        (result) => result.status === "failed" || result.status === "unavailable",
      );

      if (failed) {
        yield* runAttempts
          .updateStatus(input.runAttemptId, "validation_failed", {
            finishedAt: now,
            error: {
              category: "validation_failed",
              message: "one or more required validation checks failed",
            },
          })
          .pipe(Effect.catch(() => Effect.void));
        yield* evidenceRepository
          .upsert(input.workItem.id, evidence)
          .pipe(Effect.catch(() => Effect.void));
        // Validation failure is retryable (plan 9.5): re-schedule while
        // attempts remain, otherwise land the item in validation_failed where
        // it can only be re-dispatched manually.
        const attemptNumber = attempt?.attemptNumber ?? 1;
        const maxAttempts = input.config.maxAttempts ?? 5;
        if (attemptNumber < maxAttempts) {
          yield* settleLifecycle(input, "retry_scheduled");
        } else {
          yield* settleLifecycle(input, "validation_failed");
        }
        yield* appendEvent(input.runAttemptId, "validation_failed", {
          results: validationResults.map((result) => ({
            command: result.command,
            status: result.status,
          })),
        });
        return "validation_failed" as const;
      }

      // 5. Model review runs only after host validation succeeds. Its evidence
      //    may downgrade readiness or block the later merge gate, but can
      //    never upgrade host-derived assessment.
      const modelReview = yield* modelReviewer.review({
        config: input.config,
        workItem: input.workItem,
        workspacePath: input.workspacePath,
        baseRef: input.baseBranch,
        headRef: "HEAD",
      });
      if (modelReview !== null) {
        const hasReviewWarnings = modelReview.reviewers.some(
          (reviewer) => reviewer.status !== "completed" || reviewer.verdict === "request_changes",
        );
        const overallAssessment: EvidenceBundle["overallAssessment"] =
          hasReviewWarnings && evidence.overallAssessment === "ready_for_review"
            ? "ready_with_warnings"
            : evidence.overallAssessment;
        evidence = { ...evidence, modelReview, overallAssessment };
        yield* appendEvent(input.runAttemptId, "model_review_completed", {
          requirement: modelReview.require,
          verdict: modelReview.verdict,
          passed: modelReview.passed,
          reviewers: modelReview.reviewers.map((reviewer) => ({
            provider: reviewer.provider,
            model: reviewer.model,
            status: reviewer.status,
            ...(reviewer.verdict !== undefined ? { verdict: reviewer.verdict } : {}),
          })),
        });
      }

      // 6. Re-read the accepted workflow policy immediately before publication.
      //    Validation and model review may take long enough for approvals,
      //    autonomy, target or provider pins to change. A stale admission
      //    config is never used for an accepted attempt.
      const refreshPublicationPolicy = input.refreshPublicationPolicy;
      if (attempt.acceptedGuidance !== undefined && refreshPublicationPolicy === undefined) {
        return yield* refusePublication(
          "Publication refused: no fresh accepted-workflow policy reader is available, so the current publication policy cannot be established. No branch was pushed and no pull request was opened.",
        );
      }
      const refreshedPolicy =
        refreshPublicationPolicy === undefined
          ? ({ status: "available", config: input.config } as const)
          : yield* refreshPublicationPolicy().pipe(Effect.catch(() => Effect.succeed(null)));
      if (refreshedPolicy === null) {
        return yield* refusePublication(
          "Publication refused: the current accepted-workflow policy is unavailable after validation and review. No branch was pushed and no pull request was opened.",
        );
      }
      if (refreshedPolicy.status === "refused") {
        yield* evidenceRepository
          .upsert(input.workItem.id, evidence)
          .pipe(Effect.catch(() => Effect.void));
        yield* appendEvent(input.runAttemptId, "delivery_refused", {
          reason:
            refreshedPolicy.reason ??
            "Publication refused: the accepted-workflow policy reevaluation refused publication.",
        });
        return "delivery_refused" as const;
      }
      const publicationConfig = refreshedPolicy.config;

      // 7. Publication gate. The accepted snapshot (when recorded) and the
      //    refreshed live workflow are intersected; a required push/PR
      //    approval cannot be satisfied by prose, prompt text or a missing
      //    durable authority.
      const deliveryGate = resolveDeliveryGate(publicationConfig, attempt.acceptedGuidance);
      if (deliveryGate.required) {
        return yield* refusePublication(deliveryGate.reason, {
          approvalBeforePush: deliveryGate.approvalBeforePush,
          approvalBeforePullRequest: deliveryGate.approvalBeforePullRequest,
        });
      }

      // 8. Review-ready: create the PR and persist the bundle. The evidence
      //    survives a provider failure, but the failure itself must be
      //    durably recorded — a run without a PR and without a recorded
      //    reason is indistinguishable from success in review.
      const pullRequestResult = yield* Effect.result(
        pullRequestService.create({
          workItem: input.workItem,
          config: publicationConfig,
          runAttemptId: input.runAttemptId,
          workspacePath: input.workspacePath,
          branch: input.branch,
          baseBranch: input.baseBranch,
          evidence,
          bodyFileDir: input.bodyFileDir ?? "",
        }),
      );
      const pullRequest = pullRequestResult._tag === "Success" ? pullRequestResult.success : null;
      if (pullRequestResult._tag === "Failure") {
        const failure = pullRequestResult.failure;
        const message = failure instanceof Error ? failure.message : String(failure);
        yield* Effect.logError(
          `symphony PR creation failed for ${input.workItem.id} (attempt ${input.runAttemptId}): ${message}`,
        );
        yield* appendEvent(input.runAttemptId, "pr_creation_failed", { message });
        // Raise a durable attention item (audit item 7): the run cannot be
        // reviewed without a PR, so a human must look at why creation failed.
        // The attention table existed (migration 037) with no writers.
        yield* attention
          .create({
            id: AttentionItemId.make(
              `pr-failed-${String(input.runAttemptId).replace(/[^a-zA-Z0-9._-]/g, "_")}`,
            ),
            workItemId: input.workItem.id,
            runAttemptId: String(input.runAttemptId),
            kind: "merge_conflict",
            severity: "high",
            whatHappened: `PR creation failed for ${input.workItem.objective}: ${message}`,
            whyHuman:
              "Without a PR the run cannot be reviewed or merged; the failure needs a human decision (retry, fix the branch, or abandon).",
            recommendedResponse:
              "Inspect the workspace branch and the host error, then re-dispatch or take over.",
            availableActions: ["re-dispatch", "take-over", "abandon"],
          })
          .pipe(Effect.catch(() => Effect.void));
      }

      if (pullRequest !== null) {
        evidence = { ...evidence, pullRequest };
      }
      // The terminal status is written exactly once, after the verdict.
      yield* runAttempts
        .updateStatus(input.runAttemptId, "succeeded", { finishedAt: now })
        .pipe(Effect.catch(() => Effect.void));
      yield* evidenceRepository
        .upsert(input.workItem.id, evidence)
        .pipe(Effect.catch(() => Effect.void));
      yield* settleLifecycle(input, "ready_for_review");
      yield* appendEvent(input.runAttemptId, "evidence_assembled", {
        overallAssessment: evidence.overallAssessment,
      });
      if (pullRequest !== null) {
        yield* appendEvent(input.runAttemptId, "pull_request_opened", {
          number: pullRequest.number,
          ...(pullRequest.url !== undefined ? { url: pullRequest.url } : {}),
        });
      }
      return "review_ready" as const;
    });

  return { finalize };
});

export const ExecutionFinalizerLive: Layer.Layer<
  ExecutionFinalizer,
  never,
  | ValidationRunner
  | EvidenceService
  | SymphonyModelReviewer
  | PullRequestService
  | EvidenceRepository
  | RunAttemptRepository
  | RunEventRepository
  | WorkItemRepository
  | FileSystem.FileSystem
  | AttentionRepository
> = Layer.effect(ExecutionFinalizer, makeExecutionFinalizer);
