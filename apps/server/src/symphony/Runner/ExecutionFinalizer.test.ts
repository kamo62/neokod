import type {
  EffectiveWorkflowConfig,
  NormalizedIssue,
  RunAttemptStatus,
  WorkItem,
} from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { nowIso } from "../Domain/Time.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "../Persistence/Layers/RunEventRepository.ts";
import { EvidenceRepository } from "../Persistence/Services/EvidenceRepository.ts";
import { EvidenceRepositoryLive } from "../Persistence/Layers/EvidenceRepository.ts";
import { EvidenceService } from "../Evidence/Service.ts";
import { PullRequestService } from "../Evidence/PullRequest.ts";
import { ValidationRunner } from "../Validation/Runner.ts";
import { ExecutionFinalizer, ExecutionFinalizerLive } from "./ExecutionFinalizer.ts";
import type { EvidenceBundle } from "@neokod/contracts";
import type { PullRequestEvidence } from "@neokod/contracts";

const makeConfig = (overrides: Partial<EffectiveWorkflowConfig> = {}): EffectiveWorkflowConfig => ({
  repositoryPath: "/repo",
  workflowPath: "/repo/WORKFLOW.md",
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
  validationRequired: ["npm test"],
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
  ...overrides,
});

const seedWorkItem = (id: string, ownerToken: string) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const now = yield* nowIso;
    const workItem: WorkItem = {
      id: WorkItemId.make(id),
      mode: "symphony",
      objective: `Implement issue ${id}`,
      description: "Seeded for finalizer tests",
      acceptanceCriteria: [],
      source: { kind: "manual" },
      trackerIssueId: `manual-${id}`,
      lifecycle: "queued",
      priority: 1,
      eligibilityReasons: [],
      evidence: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* workItems.upsert(workItem);
    // Claim so the owner fence matches; the finalizer's transitions assert
    // owner_token + generation (plan 4).
    const claimed = yield* workItems.claim(workItem.id, ownerToken);
    return claimed.workItem;
  });

const seedAttempt = (workItemId: string, attemptNumber = 1) =>
  Effect.gen(function* () {
    const runAttempts = yield* RunAttemptRepository;
    const id = RunAttemptId.make(`run-${workItemId}-${attemptNumber}`);
    const startedAt = yield* nowIso;
    yield* runAttempts.create({
      id,
      workItemId: WorkItemId.make(workItemId),
      attemptNumber,
      workspacePath: `/ws/${workItemId}`,
      provider: {
        instanceId: ProviderInstanceId.make("codex_default"),
        driver: ProviderDriverKind.make("codex"),
      },
      status: "streaming_turn",
      startedAt,
      finishedAt: null,
      error: null,
    });
    return id;
  });
const makeIssue = (id: string): NormalizedIssue => ({
  id,
  nativeRef: null,
  identifier: `#${id}`,
  title: `Implement issue ${id}`,
  description: null,
  priority: null,
  state: "open",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
});

const makeEvidence = (): EvidenceBundle => ({
  objective: "Implement issue 1",
  changedFiles: [{ path: "src/lib.ts", additions: 1, deletions: 0 }],
  testsChanged: [],
  commits: [],
  validationResults: [],
  assumptions: [],
  risks: [],
  unresolved: [],
  artefacts: [],
  pullRequest: null,
  modelReview: null,
  overallAssessment: "ready_for_review",
  createdAt: "2026-08-05T00:00:00.000Z",
});

const makePullRequest = (): PullRequestEvidence => ({
  number: 7,
  title: "Implement issue 1",
  branch: "symphony/issue-1",
  baseBranch: "main",
  url: "https://github.com/o/r/pull/7",
  status: "open",
});

const fakeValidationRunner = (statuses: ReadonlyArray<string>) =>
  Layer.succeed(ValidationRunner, {
    runAll: () =>
      Effect.succeed(
        statuses.map((status, index) => ({
          command: `check-${index}`,
          status: status as "passed" | "failed" | "unavailable",
        })),
      ),
  });

const fakeEvidenceService = Layer.succeed(EvidenceService, {
  assemble: () => Effect.succeed(makeEvidence()),
});

const fakePullRequestService = (pr: PullRequestEvidence | null) =>
  Layer.succeed(PullRequestService, {
    create: () => Effect.succeed(pr as PullRequestEvidence),
    refresh: () => Effect.succeed(null),
  });

const layer = (validationStatuses: ReadonlyArray<string>, pr: PullRequestEvidence | null) =>
  it.layer(
    ExecutionFinalizerLive.pipe(
      Layer.provideMerge(WorkItemRepositoryLive),
      Layer.provideMerge(RunAttemptRepositoryLive),
      Layer.provideMerge(RunEventRepositoryLive),
      Layer.provideMerge(EvidenceRepositoryLive),
      Layer.provideMerge(fakeValidationRunner(validationStatuses)),
      Layer.provideMerge(fakeEvidenceService),
      Layer.provideMerge(fakePullRequestService(pr)),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

layer(["passed"], makePullRequest())("ExecutionFinalizer review-ready path", (it) => {
  it.effect("persists evidence, opens the PR and lands ready_for_review", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1", "owner-1");
      const runAttemptId = yield* seedAttempt("1");
      const finalizer = yield* ExecutionFinalizer;

      const outcome = yield* finalizer.finalize({
        workItem,
        issue: makeIssue("1"),
        runAttemptId,
        config: makeConfig(),
        workspacePath: "/ws/1",
        branch: "symphony/issue-1",
        baseBranch: "main",
        ownerToken: "owner-1",
        generation: 1,
        bodyFileDir: "/tmp/neokod",
      });

      expect(outcome).toBe("review_ready");

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId);
      expect(attempt?.status).toBe("succeeded");
      expect(attempt?.finishedAt).not.toBeNull();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("ready_for_review");

      const evidenceRepo = yield* EvidenceRepository;
      const stored = yield* evidenceRepo.getByWorkItem(workItem.id);
      expect(stored?.pullRequest?.number).toBe(7);
      expect(stored?.pullRequest?.url).toContain("pull/7");

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.map((e) => e.eventType)).toContain("pull_request_opened");
      expect(events.map((e) => e.eventType)).toContain("evidence_assembled");
    }),
  );
});

layer(["failed"], makePullRequest())("ExecutionFinalizer validation failure path", (it) => {
  it.effect("marks the attempt validation_failed and re-schedules the item for retry", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("2", "owner-2");
      const runAttemptId = yield* seedAttempt("2");
      const finalizer = yield* ExecutionFinalizer;

      const outcome = yield* finalizer.finalize({
        workItem,
        issue: makeIssue("2"),
        runAttemptId,
        config: makeConfig(),
        workspacePath: "/ws/2",
        branch: "symphony/issue-2",
        baseBranch: "main",
        ownerToken: "owner-2",
        generation: 1,
      });

      expect(outcome).toBe("validation_failed");

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId);
      expect(attempt?.status).toBe("validation_failed");
      expect(attempt?.error?.category).toBe("validation_failed");

      // Attempt 1 of 5: retryable, so the item is re-scheduled (plan 9.5).
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("retry_scheduled");

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.map((e) => e.eventType)).toContain("validation_failed");
    }),
  );

  it.effect("lands validation_failed when attempts are exhausted", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("5", "owner-5");
      const runAttemptId = yield* seedAttempt("5", 5);
      const finalizer = yield* ExecutionFinalizer;

      const outcome = yield* finalizer.finalize({
        workItem,
        issue: makeIssue("5"),
        runAttemptId,
        config: makeConfig({ maxAttempts: 5 }),
        workspacePath: "/ws/5",
        branch: "symphony/issue-5",
        baseBranch: "main",
        ownerToken: "owner-5",
        generation: 1,
      });

      expect(outcome).toBe("validation_failed");

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("validation_failed");
    }),
  );
});

layer(["passed"], null)("ExecutionFinalizer without PR", (it) => {
  it.effect("still persists evidence and lands review-ready when PR creation fails", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("3", "owner-3");
      const runAttemptId = yield* seedAttempt("3");
      const finalizer = yield* ExecutionFinalizer;

      const outcome = yield* finalizer.finalize({
        workItem,
        issue: makeIssue("3"),
        runAttemptId,
        config: makeConfig(),
        workspacePath: "/ws/3",
        branch: "symphony/issue-3",
        baseBranch: "main",
        ownerToken: "owner-3",
        generation: 1,
      });

      expect(outcome).toBe("review_ready");

      const evidenceRepo = yield* EvidenceRepository;
      const stored = yield* evidenceRepo.getByWorkItem(workItem.id);
      expect(stored?.pullRequest).toBeNull();
    }),
  );
});

layer([], makePullRequest())("ExecutionFinalizer no validation configured", (it) => {
  it.effect("lands review-ready when no validation is required", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("4", "owner-4");
      const runAttemptId = yield* seedAttempt("4");
      const finalizer = yield* ExecutionFinalizer;

      const outcome = yield* finalizer.finalize({
        workItem,
        issue: makeIssue("4"),
        runAttemptId,
        config: makeConfig({ validationRequired: [] }),
        workspacePath: "/ws/4",
        branch: "symphony/issue-4",
        baseBranch: "main",
        ownerToken: "owner-4",
        generation: 1,
      });

      expect(outcome).toBe("review_ready");

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("ready_for_review");
    }),
  );
});

const statuses: ReadonlyArray<RunAttemptStatus> = [];
void statuses;
