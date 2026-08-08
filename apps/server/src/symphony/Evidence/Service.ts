import type {
  ChangedFileEvidence,
  CommitEvidence,
  EffectiveWorkflowConfig,
  EvidenceBundle,
  GitCommandError,
  NormalizedIssue,
  OverallAssessment,
  RunAttempt,
  ValidationResult,
  WorkItem,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { nowIso } from "../Domain/Time.ts";
import { matchesAnyPattern } from "./Glob.ts";
import { parseEvidenceFile } from "./HandoffFile.ts";

/**
 * Evidence service (plan 10, WS-L).
 *
 * Assembles the evidence bundle when a run reaches a stopping point
 * (review-ready, failed validation, changes-requested resolution).
 *
 * Host-derived facts (changed files from the base..head range, commits,
 * validation results, tests changed per the workflow's test path patterns)
 * are computed here so the agent cannot overstate them. Agent-authored fields
 * come exclusively from the structured `SYMPHONY_EVIDENCE.md` handoff file in
 * the workspace; there is no generated fallback. When the file is missing or
 * incomplete the fields stay empty and `overallAssessment` is `insufficient`.
 *
 * `overallAssessment` rules (plan 10):
 * - any failed required validation with no open resolution => `failed`
 * - incomplete required evidence => `insufficient`
 * - all required checks pass with risks => `ready_with_warnings`
 * - clean => `ready_for_review`
 * - `ready_to_merge` only after the merge policy checks (Phase 5); never here.
 */

export interface AssembleEvidenceInput {
  readonly workItem: WorkItem;
  readonly issue: NormalizedIssue;
  readonly runAttempt: RunAttempt;
  readonly config: EffectiveWorkflowConfig;
  readonly workspacePath: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly validationResults: ReadonlyArray<ValidationResult>;
  readonly evidenceFileContent: string | null;
}

export class EvidenceService extends Context.Service<
  EvidenceService,
  {
    readonly assemble: (input: AssembleEvidenceInput) => Effect.Effect<EvidenceBundle, never>;
  }
>()("neokod/symphony/Evidence/Service/EvidenceService") {}

export interface EvidenceServiceDeps {
  readonly git: GitVcsDriver["Service"];
  readonly nowIsoEffect?: () => Effect.Effect<string>;
}

export const makeEvidenceService = (deps: EvidenceServiceDeps): EvidenceService["Service"] => {
  const assemble: EvidenceService["Service"]["assemble"] = (input) =>
    Effect.gen(function* () {
      const createdAt = yield* deps.nowIsoEffect?.() ?? nowIso;

      const changedFiles = yield* loadChangedFiles(input.workspacePath, input.baseBranch).pipe(
        Effect.orElseSucceed(() => [] as ChangedFileEvidence[]),
      );

      const parsed =
        input.evidenceFileContent === null ? null : parseEvidenceFile(input.evidenceFileContent);

      const testsChanged = changedFiles.filter((file) =>
        matchesAnyPattern(file.path, input.config.validationTestPathPatterns ?? []),
      );

      const commits = yield* loadCommits(input.workspacePath, input.baseBranch).pipe(
        Effect.orElseSucceed(() => [] as CommitEvidence[]),
      );

      // A `skipped` required check is not a pass: it must degrade the
      // assessment like an unavailable check (plan section 19 suite 7,
      // REVIEW P1). And an empty handoff file is incomplete evidence, not
      // sufficient evidence (REVIEW P1: `touch SYMPHONY_EVIDENCE.md` moved
      // the assessment to ready_for_review).
      const hasFailedValidation = input.validationResults.some(
        (result) =>
          result.status === "failed" ||
          result.status === "unavailable" ||
          result.status === "skipped",
      );
      const hasSubstantiveEvidence =
        parsed !== null && parsed.implementationSummary.trim().length > 0;
      const overallAssessment = assess({
        hasFailedValidation,
        hasSubstantiveEvidence,
        hasRisks: (parsed?.risks.length ?? 0) > 0,
      });

      return {
        objective: input.issue.title,
        ...(parsed !== null && parsed.implementationSummary.length > 0
          ? { implementationSummary: parsed.implementationSummary }
          : {}),
        changedFiles,
        testsChanged,
        commits,
        validationResults: [...input.validationResults],
        assumptions: parsed?.assumptions ?? [],
        risks: parsed?.risks ?? [],
        unresolved: parsed?.unresolved ?? [],
        artefacts: [],
        pullRequest: null,
        modelReview: null,
        overallAssessment,
        workflowVersion:
          input.workItem.workflowId === undefined ? undefined : String(input.workItem.workflowId),
        ...(input.runAttempt.model !== undefined
          ? { agent: String(input.config.agentProvider.driver), model: input.runAttempt.model }
          : {}),
        totalDurationMs: computeDurationMs(input.runAttempt),
        tokenUsage: input.runAttempt.tokenUsage,
        createdAt,
      } satisfies EvidenceBundle;
    });

  const loadChangedFiles = (
    workspacePath: string,
    baseBranch: string,
  ): Effect.Effect<ChangedFileEvidence[], GitCommandError> =>
    deps.git.readRangeContext(workspacePath, baseBranch).pipe(
      Effect.map((context) =>
        parseTurnDiffFilesFromUnifiedDiff(context.diffPatch).map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
    );

  const loadCommits = (
    workspacePath: string,
    baseBranch: string,
  ): Effect.Effect<CommitEvidence[], GitCommandError> =>
    deps.git
      .execute({
        operation: "EvidenceService.loadCommits",
        cwd: workspacePath,
        args: ["log", "--pretty=format:%H|%aI|%s", `${baseBranch}..HEAD`],
      })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
              const [sha, authoredAt, ...rest] = line.split("|");
              if (sha === undefined || authoredAt === undefined) {
                return null;
              }
              const message = rest.join("|");
              if (Number.isNaN(Date.parse(authoredAt))) {
                return null;
              }
              return {
                sha,
                message,
                authoredAt,
              } satisfies CommitEvidence;
            })
            .filter((commit): commit is CommitEvidence => commit !== null),
        ),
      );

  return { assemble };
};

const computeDurationMs = (runAttempt: RunAttempt): number | undefined => {
  if (runAttempt.finishedAt === null) {
    return undefined;
  }
  const started = Date.parse(runAttempt.startedAt);
  const finished = Date.parse(runAttempt.finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) {
    return undefined;
  }
  return Math.max(0, finished - started);
};

const assess = (input: {
  readonly hasFailedValidation: boolean;
  readonly hasSubstantiveEvidence: boolean;
  readonly hasRisks: boolean;
}): OverallAssessment => {
  if (input.hasFailedValidation) {
    return "failed";
  }
  if (!input.hasSubstantiveEvidence) {
    return "insufficient";
  }
  return input.hasRisks ? "ready_with_warnings" : "ready_for_review";
};

export const EvidenceServiceLive: Layer.Layer<EvidenceService, never, GitVcsDriver> = Layer.effect(
  EvidenceService,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    return makeEvidenceService({ git });
  }),
);
