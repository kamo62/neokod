import type {
  EffectiveWorkflowConfig,
  EvidenceBundle,
  NormalizedIssue,
  RunAttemptId,
  WorkItem,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { EvidenceRepository } from "../Persistence/Services/EvidenceRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { nowIso } from "../Domain/Time.ts";
import { EvidenceService } from "../Evidence/Service.ts";
import { PullRequestService } from "../Evidence/PullRequest.ts";
import { ValidationRunner } from "../Validation/Runner.ts";

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

export type FinalizeOutcome = "review_ready" | "validation_failed";

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
    }) => Effect.Effect<FinalizeOutcome, never>;
  }
>()("neokod/symphony/Runner/ExecutionFinalizer") {}

const EVIDENCE_FILE_NAME = "SYMPHONY_EVIDENCE.md";

export const makeExecutionFinalizer = Effect.gen(function* () {
  const validationRunner = yield* ValidationRunner;
  const evidenceService = yield* EvidenceService;
  const pullRequestService = yield* PullRequestService;
  const evidenceRepository = yield* EvidenceRepository;
  const runAttempts = yield* RunAttemptRepository;
  const runEvents = yield* RunEventRepository;
  const workItems = yield* WorkItemRepository;
  const fileSystem = yield* FileSystem.FileSystem;

  const appendEvent = (
    runAttemptId: RunAttemptId,
    eventType: string,
    payload?: Record<string, unknown>,
  ) => runEvents.append(runAttemptId, eventType, payload).pipe(Effect.catch(() => Effect.void));

  const finalize: ExecutionFinalizer["Service"]["finalize"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;

      // 1. Validation (no-op when nothing is configured).
      const validationResults = yield* validationRunner.runAll({
        config: input.config,
        runAttemptId: input.runAttemptId,
        workspacePath: input.workspacePath,
      });

      // 2. Agent handoff file; missing is a fact, not an error.
      const evidenceFileContent = yield* fileSystem
        .readFileString(`${input.workspacePath}/${EVIDENCE_FILE_NAME}`)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      // 3. Read the current attempt WITHOUT mutating it: the terminal status
      //    must be written once, after the validation verdict is known
      //    (REVIEW P1: `succeeded` was written first, so a crash between the
      //    write and the verdict left a failed run recorded as succeeded).
      const attempt = yield* runAttempts
        .getById(input.runAttemptId)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      // 4. Assemble the bundle against a synthetic finished attempt so the
      //    duration is real without a durable status write.
      const assembledAttempt = attempt ?? {
        id: input.runAttemptId,
        workItemId: input.workItem.id,
        attemptNumber: 1,
        workspacePath: input.workspacePath,
        provider: input.config.agentProvider,
        status: "streaming_turn" as const,
        startedAt: input.workItem.updatedAt,
        finishedAt: now,
        error: null,
      };
      let evidence: EvidenceBundle = yield* evidenceService.assemble({
        workItem: input.workItem,
        issue: input.issue,
        runAttempt: assembledAttempt,
        config: input.config,
        workspacePath: input.workspacePath,
        baseBranch: input.baseBranch,
        branch: input.branch,
        validationResults,
        evidenceFileContent,
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
          yield* workItems
            .transition(input.workItem.id, "retry_scheduled", {
              ownerToken: input.ownerToken,
              generation: input.generation,
            })
            .pipe(Effect.catch(() => Effect.void));
        } else {
          yield* workItems
            .transition(input.workItem.id, "validation_failed", {
              ownerToken: input.ownerToken,
              generation: input.generation,
            })
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* appendEvent(input.runAttemptId, "validation_failed", {
          results: validationResults.map((result) => ({
            command: result.command,
            status: result.status,
          })),
        });
        return "validation_failed" as const;
      }

      // 5. Review-ready: create the PR and persist the bundle. The evidence
      //    survives a provider failure, but the failure itself must be
      //    durably recorded — a run without a PR and without a recorded
      //    reason is indistinguishable from success in review.
      const pullRequestResult = yield* Effect.result(
        pullRequestService.create({
          workItem: input.workItem,
          config: input.config,
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
      yield* workItems
        .transition(input.workItem.id, "ready_for_review", {
          ownerToken: input.ownerToken,
          generation: input.generation,
        })
        .pipe(Effect.catch(() => Effect.void));
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
  | PullRequestService
  | EvidenceRepository
  | RunAttemptRepository
  | RunEventRepository
  | WorkItemRepository
  | FileSystem.FileSystem
> = Layer.effect(ExecutionFinalizer, makeExecutionFinalizer);
