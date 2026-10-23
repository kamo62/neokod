import type {
  EffectiveWorkflowConfig,
  EvidenceBundle,
  IsoDateTime,
  NormalizedIssue,
  PullRequestEvidence,
  SymphonyProjectConfiguration,
  WorkItem,
} from "@neokod/contracts";
import {
  ProjectId,
  RunDetailsSchema,
  WorkflowId,
  WorkItemId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunAttemptId,
  SymphonyProjectId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { nowIso } from "../../Domain/Time.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { WorkflowRepository } from "../../Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "../../Persistence/Layers/WorkflowRepository.ts";
import { SymphonyProjectRepositoryLive } from "../../Persistence/Layers/SymphonyProjectRepository.ts";
import { WorkItemRepository } from "../../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepository } from "../../Persistence/Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "../../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepository } from "../../Persistence/Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "../../Persistence/Layers/RunEventRepository.ts";
import { OrchestratorStateRepositoryLive } from "../../Persistence/Layers/OrchestratorStateRepository.ts";
import { ApprovalService } from "../../Runner/ApprovalService.ts";
import { ApprovalRepository } from "../../Persistence/Services/ApprovalRepository.ts";
import { ApprovalRepositoryLive } from "../../Persistence/Layers/ApprovalRepository.ts";
import { EvidenceRepositoryLive } from "../../Persistence/Layers/EvidenceRepository.ts";
import { AttentionRepositoryLive } from "../../Persistence/Services/AttentionRepository.ts";
import { TrackerCheckpointRepositoryLive } from "../../Persistence/Services/TrackerCheckpointRepository.ts";
import { AuditRepositoryLive } from "../../Persistence/Services/AuditRepository.ts";
import { NotificationCoordinatorLive } from "../../NotificationCoordinator.ts";
import { EvidenceRepository } from "../../Persistence/Services/EvidenceRepository.ts";
import { TrackerRegistryWithFactories } from "../../Trackers/Registry.ts";
import { makeMemoryTrackerAdapter } from "../../Trackers/MemoryAdapter.ts";
import { missingTrackerSecret } from "../../Trackers/Errors.ts";
import { TrackerEnablementLive } from "../TrackerEnablement.ts";
import { SymphonyOrchestrator } from "../SymphonyOrchestrator.ts";
import {
  SymphonyOrchestratorLive,
  modelReviewAllowsMerge,
  providerForRemoteUrl,
  trackerSourceMismatch,
} from "./SymphonyOrchestratorLive.ts";
import { RunDispatcher, RunDispatchError } from "../../Runner/Dispatcher.ts";
import { PullRequestService } from "../../Evidence/PullRequest.ts";
import { buildRunPrompt, type ReviewFeedbackContext } from "../../Runner/Prompt.ts";
import { WorkflowLoaderService, type WorkflowLoader } from "../../Workflow/Loader.ts";
import { layerTest as serverSettingsTestLayer } from "../../../serverSettings.ts";
import * as ServerConfig from "../../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const TEST_PROJECT_ID = SymphonyProjectId.make("orchestrator-test-project");

const makeProjectConfiguration = (): SymphonyProjectConfiguration => ({
  tracker: { kind: "github", repository: "owner/repo" },
  trackerRequiredLabels: [],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  autonomy: "observe",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  validationRequired: [],
  maxConcurrentAgents: 4,
  maxTurns: 20,
  maxAttempts: 3,
  approvalsBeforePush: false,
  approvalsBeforePullRequest: false,
  approvalsBeforeMerge: true,
});

const makeConfig = (repositoryPath: string): EffectiveWorkflowConfig => ({
  repositoryPath,
  workflowPath: `${repositoryPath}/WORKFLOW.md`,
  trackerKind: "github",
  trackerRequiredLabels: ["agent-ready"],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  trackerProvider: {},
  workspaceRoot: "/ws",
  autonomy: "observe",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  validationRequired: [],
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
  // The layer is shared across this suite and the mock dispatcher deliberately
  // leaves claimed items in `preparing`. Keep fixture bookkeeping from
  // exhausting the production default cap and obscuring the behavior under
  // test; dedicated concurrency tests override this value explicitly.
  concurrencyGlobal: 10_000,
});

const makeModelReviewEvidence = (
  overrides: Partial<NonNullable<EvidenceBundle["modelReview"]>> = {},
): EvidenceBundle => ({
  changedFiles: [],
  testsChanged: [],
  commits: [],
  validationResults: [],
  assumptions: [],
  risks: [],
  unresolved: [],
  artefacts: [],
  pullRequest: null,
  modelReview: {
    provenance: "model",
    target: "baseBranch",
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base-sha",
    headSha: "head-sha",
    sourceHashes: ["diff-hash"],
    require: "all-approve",
    verdict: "approve",
    passed: true,
    reviewers: [
      {
        provenance: "model",
        provider: "claude_review",
        model: "claude-fable-5",
        status: "completed",
        verdict: "approve",
        summary: "Looks good.",
        findings: [],
        reviewedAt: "2026-08-07T12:00:00.000Z",
      },
    ],
    reviewedAt: "2026-08-07T12:00:00.000Z",
    ...overrides,
  },
  overallAssessment: "ready_for_review",
  createdAt: "2026-08-07T12:00:00.000Z",
});

it("gates enforced model review on verdict, configuration, and reviewed head", () => {
  const config: EffectiveWorkflowConfig = {
    ...makeConfig("/repo/review-gate"),
    reviewAgents: ["claude-fable-5"],
    reviewRequirement: "all-approve",
  };
  const currentPr = { latestCommit: "head-sha" } as PullRequestEvidence;

  expect(modelReviewAllowsMerge(config, makeModelReviewEvidence(), currentPr)).toBe(true);
  expect(
    modelReviewAllowsMerge(config, makeModelReviewEvidence({ headSha: "stale-sha" }), currentPr),
  ).toBe(false);
  expect(
    modelReviewAllowsMerge(
      config,
      makeModelReviewEvidence({ passed: false, verdict: "request_changes" }),
      currentPr,
    ),
  ).toBe(false);
  expect(
    modelReviewAllowsMerge(
      { ...config, reviewAgents: ["different-model"] },
      makeModelReviewEvidence(),
      currentPr,
    ),
  ).toBe(false);
  expect(
    modelReviewAllowsMerge(
      { ...config, reviewRequirement: "advisory" },
      makeModelReviewEvidence({ passed: false, verdict: "advisory" }),
      {} as PullRequestEvidence,
    ),
  ).toBe(true);
});

it("classifies source-control providers by parsed remote host", () => {
  expect(providerForRemoteUrl("https://github.com/owner/repo.git")).toBe("github");
  expect(providerForRemoteUrl("github.com:owner/repo.git")).toBe("github");
  expect(providerForRemoteUrl("git@gitlab.com:owner/repo.git")).toBe("gitlab");
  expect(providerForRemoteUrl("https://dev.azure.com/org/project/_git/repo")).toBe("azure-devops");
  expect(providerForRemoteUrl("https://github.com.evil.test/owner/repo.git")).toBeNull();
  expect(providerForRemoteUrl("not a remote with github.com in the path")).toBeNull();
});

const makeIssue = (
  id: string,
  state = "open",
  labels: string[] = ["agent-ready"],
): NormalizedIssue => ({
  id,
  nativeRef: null,
  identifier: `#${id}`,
  title: `Issue ${id}`,
  description: null,
  priority: 1,
  state,
  branchName: null,
  url: null,
  assigneeId: null,
  labels,
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
});

it("qualified tracker source rejects scope changes and preserves manual provenance", () => {
  const baseItem: WorkItem = {
    id: WorkItemId.make("source-identity-item"),
    mode: "symphony",
    objective: "Source identity",
    acceptanceCriteria: [],
    source: {
      kind: "github",
      externalId: "1",
      externalUrl: "https://github.com/owner-a/repo-a/issues/1",
    },
    trackerIssueId: "1",
    lifecycle: "queued",
    eligibilityReasons: [],
    evidence: null,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
  };
  const issueAt = (url: string | null): NormalizedIssue => ({ ...makeIssue("1"), url });

  expect(
    trackerSourceMismatch(
      baseItem,
      issueAt("https://github.com/owner-b/repo-b/issues/1"),
      makeConfig("/repo"),
    ),
  ).toContain("scope changed");
  expect(
    trackerSourceMismatch(
      { ...baseItem, source: { kind: "manual" } },
      issueAt(null),
      makeConfig("/repo"),
    ),
  ).toBeNull();
  expect(
    trackerSourceMismatch(
      baseItem,
      issueAt("https://github.com/owner-a/repo-a/issues/1"),
      makeConfig("/repo"),
    ),
  ).toBeNull();
  expect(
    trackerSourceMismatch(
      {
        ...baseItem,
        source: { kind: "linear", externalId: "1", externalUrl: "https://linear.app/a" },
      },
      issueAt("https://linear.app/a"),
      makeConfig("/repo"),
    ),
  ).toContain("kind changed");
});

const pollCountsByRepository = new Map<string, number>();
const memoryFactory = (options: { readonly repositoryPath: string }) =>
  options.repositoryPath === "/repo/health-failure"
    ? Effect.fail(missingTrackerSecret("TEST_TOKEN"))
    : makeMemoryTrackerAdapter({
        issues: [makeIssue("1"), makeIssue("2", "closed"), makeIssue("3", "open", [])],
        activeStates: ["open"],
        terminalStates: ["closed"],
      }).pipe(
        Effect.map((adapter) => ({
          ...adapter,
          listCandidateIssues: () =>
            Effect.sync(() => {
              pollCountsByRepository.set(
                options.repositoryPath,
                (pollCountsByRepository.get(options.repositoryPath) ?? 0) + 1,
              );
            }).pipe(Effect.flatMap(() => adapter.listCandidateIssues())),
        })),
      );

const registryLayer = TrackerRegistryWithFactories(new Map([["github", memoryFactory]]));

const dispatchedIds: string[] = [];
// Gate and interruption flag for the forked-dispatch tests (card 1.8): the
// mock dispatcher can hold a run open so a test can prove the caller
// already moved on.
let dispatchGate: Deferred.Deferred<void> | null = null;
const dispatchStatus = { interrupted: false, completed: false };

const awaitDispatched = (id: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !dispatchedIds.includes(id); i++) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 millis");
    }
  });

const settle = Effect.repeat(Effect.yieldNow, { times: 50 });
// Captures the full dispatch input (plan FR-102-104: proves reviewFeedback
// actually reaches the dispatcher, not just that a dispatch happened).
const dispatchedInputs: Array<{
  readonly workItemId: string;
  readonly workflowId?: string;
  readonly workflowRevision?: string;
  readonly reviewFeedback?: ReviewFeedbackContext;
  readonly workflowInstructions?: string;
}> = [];

const mockDispatcherLayer = Layer.effect(
  RunDispatcher,
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    return {
      dispatchWorkItem: (input: {
        readonly workItem: { readonly id: WorkItemId };
        readonly workflowId?: WorkflowId;
        readonly workflowRevision?: IsoDateTime;
        readonly reviewFeedback?: ReviewFeedbackContext;
        readonly workflowInstructions?: string;
      }) =>
        workItems.claim(input.workItem.id, "mock-owner").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              dispatchedIds.push(String(input.workItem.id));
              dispatchedInputs.push({
                workItemId: String(input.workItem.id),
                ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
                ...(input.workflowRevision !== undefined
                  ? { workflowRevision: input.workflowRevision }
                  : {}),
                ...(input.reviewFeedback !== undefined
                  ? { reviewFeedback: input.reviewFeedback }
                  : {}),
                ...(input.workflowInstructions !== undefined
                  ? { workflowInstructions: input.workflowInstructions }
                  : {}),
              });
            }),
          ),
          Effect.andThen(dispatchGate === null ? Effect.void : Deferred.await(dispatchGate)),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              dispatchStatus.interrupted = true;
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              dispatchStatus.completed = true;
            }),
          ),
          Effect.mapError((cause) => new RunDispatchError(cause.message)),
          Effect.as("run-mock" as RunAttemptId),
        ),
      cancelRun: (runAttemptId) =>
        Effect.succeed({
          status: "confirmed",
          runAttemptId,
          evidence: "no_owner_recorded",
          released: false,
        } as const),
      isAgentActive: () => Effect.succeed(false),
      stopAllRuns: () => Effect.succeed({ confirmed: 0, held: 0 }),
    } satisfies RunDispatcher["Service"];
  }),
);

let reconciledDeliveryCalls = 0;
const mockApprovalsLayer = Layer.effect(
  ApprovalService,
  Effect.gen(function* () {
    const repository = yield* ApprovalRepository;
    return {
      recordPending: (input) =>
        repository.create({
          ...input,
          id: `sym-${input.requestId}`,
          workItemId: String(input.workItemId),
        }),
      approve: () => Effect.void,
      reject: () => Effect.void,
      respondToUserInput: () => Effect.void,
      listPending: (options) =>
        repository.listPending(options).pipe(Effect.orElseSucceed(() => [])),
      listForRun: (runAttemptId) =>
        repository.listForRun(runAttemptId).pipe(Effect.orElseSucceed(() => [])),
      expire: (requestId) =>
        repository.decide(requestId, "expired").pipe(Effect.catch(() => Effect.void)),
      interrupt: (requestId) =>
        repository.decide(requestId, "interrupted").pipe(Effect.catch(() => Effect.void)),
      reconcileUncertainDeliveries: () =>
        Effect.gen(function* () {
          reconciledDeliveryCalls += 1;
          const rows = yield* repository.listDelivering().pipe(Effect.orElseSucceed(() => []));
          let reconciled = 0;
          const failedIds: string[] = [];
          for (const row of rows) {
            const result = yield* Effect.result(
              repository.reconcileDelivery(row.id, "interrupted"),
            );
            if (result._tag === "Success") reconciled += 1;
            else failedIds.push(row.id);
          }
          return { reconciled, failedIds };
        }),
      expireRequest: (runAttemptId, requestId) =>
        repository.listForRun(runAttemptId).pipe(
          Effect.flatMap((records) => {
            const record = records.find(
              (candidate) => candidate.requestId === requestId && candidate.state === "pending",
            );
            return record === undefined
              ? Effect.succeed(false)
              : repository.decide(record.id, "expired").pipe(
                  Effect.catch(() => Effect.void),
                  Effect.as(true),
                );
          }),
          Effect.catch(() => Effect.succeed(false)),
        ),
    } satisfies ApprovalService["Service"];
  }),
);

// Fresh host query result for approveMerge (fix-lane item 8): tests set
// this to control what the gate sees, so the gate cannot be proven by a
// stub that always passes.
let pullRequestRefreshRef: Ref.Ref<PullRequestEvidence | null> | null = null;
const setPullRequestRefresh = (value: PullRequestEvidence | null) =>
  Effect.gen(function* () {
    if (pullRequestRefreshRef !== null) {
      yield* Ref.set(pullRequestRefreshRef, value);
    }
  });

// Every refresh input the orchestrator asked the host for. Used to prove the
// PR identity (branch/base branch) came from the right evidence, not from a
// stub that ignores its input.
// Branches whose host lookup is slow, so a sweep can be observed running while
// scheduling continues for other workflows.
const slowPullRequestBranches = new Set<string>();

const pullRequestRefreshInputs: Array<{
  readonly branch: string;
  readonly baseBranch: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
}> = [];

// Comment-body enrichment for FR-102-104 tests: `null` (the default) is the
// honest-degradation case — no GitHub comment enrichment, counts-only.
let pullRequestCommentsRef: Ref.Ref<ReadonlyArray<{
  readonly body: string;
  readonly author?: string;
}> | null> | null = null;
const setPullRequestComments = (
  value: ReadonlyArray<{ readonly body: string; readonly author?: string }> | null,
) =>
  Effect.gen(function* () {
    if (pullRequestCommentsRef !== null) {
      yield* Ref.set(pullRequestCommentsRef, value);
    }
  });

const workflowReloadCalls: string[] = [];
const mockWorkflowLoaderLayer = Layer.succeed(WorkflowLoaderService, {
  loadWorkflow: () => Effect.die(new Error("not used in orchestrator tests")),
  reloadChanged: ({ repositoryPath }) =>
    Effect.sync(() => {
      workflowReloadCalls.push(repositoryPath);
      return false;
    }),
  getWorkflowContent: () => Effect.die(new Error("not used in orchestrator tests")),
  saveWorkflowContent: () => Effect.die(new Error("not used in orchestrator tests")),
  createWorkflow: () => Effect.die(new Error("not used in orchestrator tests")),
} satisfies WorkflowLoader);

const layer = it.layer(
  SymphonyOrchestratorLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(SymphonyProjectRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(OrchestratorStateRepositoryLive),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(mockWorkflowLoaderLayer),
    Layer.provideMerge(TrackerEnablementLive),
    Layer.provideMerge(mockDispatcherLayer.pipe(Layer.provide(WorkItemRepositoryLive))),
    Layer.provideMerge(mockApprovalsLayer),
    Layer.provideMerge(ApprovalRepositoryLive),
    Layer.provideMerge(EvidenceRepositoryLive),
    Layer.provideMerge(AttentionRepositoryLive),
    Layer.provideMerge(TrackerCheckpointRepositoryLive),
    Layer.provideMerge(AuditRepositoryLive),
    Layer.provideMerge(NotificationCoordinatorLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(
          PullRequestService,
          Effect.gen(function* () {
            // Per-test control of the fresh host query (fix-lane item 8: the
            // gate must not be proven by a stub that always passes).
            pullRequestRefreshRef = yield* Ref.make<PullRequestEvidence | null>({
              number: 1,
              title: "t",
              branch: "b",
              baseBranch: "m",
              status: "open",
              ciStatus: "success",
              reviewState: "approved",
              mergeable: "mergeable",
              unresolvedComments: 0,
            });
            pullRequestCommentsRef = yield* Ref.make<ReadonlyArray<{
              readonly body: string;
              readonly author?: string;
            }> | null>(null);
            return {
              create: () => Effect.succeed(null as never),
              refresh: (input) =>
                (slowPullRequestBranches.has(input.branch)
                  ? Effect.sleep("10 seconds")
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      pullRequestRefreshInputs.push({
                        branch: input.branch,
                        baseBranch: input.baseBranch,
                        ...(input.pullRequestNumber !== undefined
                          ? { pullRequestNumber: input.pullRequestNumber }
                          : {}),
                        ...(input.pullRequestUrl !== undefined
                          ? { pullRequestUrl: input.pullRequestUrl }
                          : {}),
                      });
                    }),
                  ),
                  Effect.andThen(
                    Ref.get(pullRequestRefreshRef as Ref.Ref<PullRequestEvidence | null>),
                    // Providers always return a URL; only fixtures that test
                    // identity deliberately override it.
                  ),
                  Effect.map((value) =>
                    value === null || value.url !== undefined
                      ? value
                      : { ...value, url: `https://github.com/owner/repo/pull/${value.number}` },
                  ),
                ),
              listUnresolvedComments: () =>
                Ref.get(
                  pullRequestCommentsRef as Ref.Ref<ReadonlyArray<{
                    readonly body: string;
                    readonly author?: string;
                  }> | null>,
                ),
            } satisfies PullRequestService["Service"];
          }),
        ),
        serverSettingsTestLayer({ trackers: { github: { enabled: true } } }),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "neokod-symphony-orchestrator-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
        SqlitePersistenceMemory,
      ),
    ),
  ),
);

const seedWorkflow = (
  id: string,
  repositoryPath: string,
  overrides: Partial<EffectiveWorkflowConfig> = {},
) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    const now = yield* nowIso;
    const effectiveConfig = { ...makeConfig(repositoryPath), ...overrides };
    yield* workflows.upsert({
      id: WorkflowId.make(id),
      repositoryPath,
      workflowPath: `${repositoryPath}/WORKFLOW.md`,
      status: "active",
      autonomy: effectiveConfig.autonomy,
      validationError: null,
      definition: { config: {}, promptTemplate: "Implement." },
      effectiveConfig,
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

const openPullRequest = (
  number: number,
  branch: string,
  baseBranch = "main",
): PullRequestEvidence => ({
  number,
  title: "t",
  branch,
  baseBranch,
  // Real evidence always carries the host URL; number-only identity is what the
  // repository guards refuse.
  url: `https://github.com/owner/repo/pull/${number}`,
  status: "open",
  ciStatus: "success",
  reviewState: "approved",
  mergeable: "mergeable",
  unresolvedComments: 0,
});

/**
 * Merge-detection fixture (B-9): a work item parked at `ready_to_merge` with
 * stored PR evidence, the workflow that owns it, and one finished attempt for
 * the merge events to hang on. The poll interval is short so a scheduler test
 * can drive the sweep with the test clock.
 */
const seedMergeDetectionItem = (input: {
  readonly workItemId: string;
  readonly workflowId: string;
  readonly repositoryPath: string;
  readonly lifecycle?: WorkItem["lifecycle"];
  readonly workspaceKey?: string;
  readonly baseBranch?: string;
  readonly storedPullRequest?: PullRequestEvidence;
}) =>
  Effect.gen(function* () {
    yield* seedWorkflow(input.workflowId, input.repositoryPath, { pollIntervalMs: 5_000 });
    const workItems = yield* WorkItemRepository;
    const workItemId = WorkItemId.make(input.workItemId);
    yield* workItems.upsert({
      id: workItemId,
      mode: "symphony",
      projectId: TEST_PROJECT_ID,
      objective: "Merge detection target",
      acceptanceCriteria: [],
      source: { kind: "manual" },
      trackerIssueId: input.workItemId,
      workflowId: WorkflowId.make(input.workflowId),
      lifecycle: input.lifecycle ?? "ready_to_merge",
      priority: 1,
      eligibilityReasons: [],
      evidence: null,
      ...(input.workspaceKey !== undefined ? { workspaceKey: input.workspaceKey } : {}),
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    });
    const evidenceRepository = yield* EvidenceRepository;
    yield* evidenceRepository.upsert(workItemId, {
      changedFiles: [],
      testsChanged: [],
      commits: [],
      validationResults: [],
      assumptions: [],
      risks: [],
      unresolved: [],
      artefacts: [],
      pullRequest:
        input.storedPullRequest ??
        // A dispatched item's PR branch is derived from its workspace key; keep
        // the fixture consistent with that invariant.
        openPullRequest(42, `symphony/${input.workspaceKey ?? input.workItemId}`),
      modelReview: null,
      overallAssessment: "ready_for_review",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    const runAttempts = yield* RunAttemptRepository;
    const runAttemptId = RunAttemptId.make(`run-${input.workItemId}`);
    yield* runAttempts.create({
      id: runAttemptId,
      workItemId,
      attemptNumber: 1,
      workspacePath: `/ws/${input.workItemId}`,
      provider: {
        instanceId: ProviderInstanceId.make("codex_default"),
        driver: ProviderDriverKind.make("codex"),
      },
      status: "succeeded",
      startedAt: "2026-08-05T00:00:00.000Z",
      finishedAt: "2026-08-05T00:05:00.000Z",
      error: null,
    });
    return { workItemId, runAttemptId };
  });

layer("SymphonyOrchestrator Observe", (it) => {
  it.effect("creates project workflows, exposes boards, and distinguishes update failures", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workflows = yield* WorkflowRepository;
      const projectId = SymphonyProjectId.make("project-operations");
      const created = yield* orchestrator.createProject({
        id: projectId,
        codeProjectId: ProjectId.make("code-project-operations"),
        title: "Project operations",
        repositoryPath: "/repo/project-operations",
        configuration: makeProjectConfiguration(),
        now: "2026-08-10T00:00:00.000Z",
      });

      expect(created.status).toBe("paused");
      const syncedWorkflow = yield* workflows.getById(WorkflowId.make(projectId));
      expect(syncedWorkflow?.status).toBe("paused");
      expect(syncedWorkflow?.effectiveConfig?.concurrencyGlobal).toBe(4);
      expect((yield* orchestrator.getProjectBoard(projectId))?.sourceControl.state).toBe(
        "unavailable",
      );

      const updated = yield* orchestrator.updateProject({
        projectId,
        expectedRevision: 0,
        title: "Renamed project",
        now: "2026-08-10T00:01:00.000Z",
      });
      expect(updated._tag).toBe("updated");
      if (updated._tag === "updated") {
        expect(updated.project.title).toBe("Renamed project");
        expect(updated.project.revision).toBe(1);
      }

      expect(
        (yield* orchestrator.updateProject({
          projectId,
          expectedRevision: 0,
          title: "Stale",
          now: "2026-08-10T00:02:00.000Z",
        }))._tag,
      ).toBe("revision_conflict");
      expect(
        (yield* orchestrator.updateProject({
          projectId: SymphonyProjectId.make("missing-project"),
          expectedRevision: 0,
          title: "Missing",
          now: "2026-08-10T00:02:00.000Z",
        }))._tag,
      ).toBe("not_found");
    }),
  );

  it.effect("getProjectBoard cards link to the latest run attempt", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runAttempts = yield* RunAttemptRepository;
      const sql = yield* SqlClient.SqlClient;
      const projectId = SymphonyProjectId.make("project-board-run-link");
      yield* orchestrator.createProject({
        id: projectId,
        codeProjectId: ProjectId.make("code-project-board-run-link"),
        title: "Board run link",
        repositoryPath: "/repo/project-board-run-link",
        configuration: makeProjectConfiguration(),
        now: "2026-08-10T00:00:00.000Z",
      });
      const workItemId = WorkItemId.make("board-run-link-row");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId,
        objective: "Board run link row",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      });
      const firstAttemptId = RunAttemptId.make("board-run-link-attempt-1");
      const secondAttemptId = RunAttemptId.make("board-run-link-attempt-2");
      yield* runAttempts.create({
        id: firstAttemptId,
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/run-link-1",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "succeeded",
        startedAt: "2026-08-10T00:00:00.000Z",
        finishedAt: "2026-08-10T00:05:00.000Z",
        error: null,
      });
      yield* runAttempts.create({
        id: secondAttemptId,
        workItemId,
        attemptNumber: 2,
        workspacePath: "/ws/run-link-2",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt: "2026-08-11T00:00:00.000Z",
        finishedAt: null,
        error: null,
      });

      const board = yield* orchestrator.getProjectBoard(projectId).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* sql`DELETE FROM symphony_run_attempts WHERE work_item_id = ${workItemId}`.pipe(
              Effect.ignore,
            );
            yield* sql`DELETE FROM symphony_work_items WHERE project_id = ${projectId}`.pipe(
              Effect.ignore,
            );
            yield* sql`DELETE FROM symphony_workflows WHERE id = ${projectId}`.pipe(Effect.ignore);
            yield* sql`DELETE FROM symphony_projects WHERE id = ${projectId}`.pipe(Effect.ignore);
          }),
        ),
      );

      const card = board?.columns
        .flatMap((column) => column.cards)
        .find((candidate) => candidate.workItemId === workItemId);
      expect(card?.latestRunAttemptId).toBe(secondAttemptId);
    }),
  );

  it.effect("getProjectBoard fails with a typed decode error that names the corrupt row", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const sql = yield* SqlClient.SqlClient;
      const projectId = SymphonyProjectId.make("project-board-corrupt");
      yield* orchestrator.createProject({
        id: projectId,
        codeProjectId: ProjectId.make("code-project-board-corrupt"),
        title: "Corrupt board",
        repositoryPath: "/repo/project-board-corrupt",
        configuration: makeProjectConfiguration(),
        now: "2026-08-10T00:00:00.000Z",
      });
      const workItemId = WorkItemId.make("board-corrupt-row");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId,
        objective: "Corrupt board row",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      });
      yield* sql`UPDATE symphony_work_items SET acceptance_criteria_json = 'not json' WHERE id = ${workItemId}`;

      const result = yield* Effect.result(orchestrator.getProjectBoard(projectId)).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* sql`UPDATE symphony_work_items SET acceptance_criteria_json = '[]' WHERE id = ${workItemId}`.pipe(
              Effect.ignore,
            );
            yield* sql`DELETE FROM symphony_work_items WHERE project_id = ${projectId}`.pipe(
              Effect.ignore,
            );
            yield* sql`DELETE FROM symphony_workflows WHERE id = ${projectId}`.pipe(Effect.ignore);
            yield* sql`DELETE FROM symphony_projects WHERE id = ${projectId}`.pipe(Effect.ignore);
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SymphonyPersistenceDecodeError");
        expect(result.failure.message).toContain(String(workItemId));
      }
    }),
  );

  it.effect("getProjectBoard keeps all active items and the newest 100 finished items", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const sql = yield* SqlClient.SqlClient;
      const projectId = SymphonyProjectId.make("project-board-coverage");
      yield* orchestrator.createProject({
        id: projectId,
        codeProjectId: ProjectId.make("code-project-board-coverage"),
        title: "Board coverage",
        repositoryPath: "/repo/project-board-coverage",
        configuration: makeProjectConfiguration(),
        now: "2026-03-01T00:00:00.000Z",
      });

      const completedIds: Array<WorkItemId> = [];
      const seed = (id: string, lifecycle: WorkItem["lifecycle"], updatedAt: string) =>
        Effect.gen(function* () {
          const workItemId = WorkItemId.make(id);
          yield* workItems.upsert({
            id: workItemId,
            mode: "symphony",
            projectId,
            objective: id,
            acceptanceCriteria: [],
            source: { kind: "manual" },
            trackerIssueId: id,
            lifecycle,
            priority: 1,
            eligibilityReasons: [],
            evidence: null,
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt,
          });
          return workItemId;
        });
      for (let index = 0; index < 105; index++) {
        const minutes = String(Math.floor(index / 60)).padStart(2, "0");
        const seconds = String(index % 60).padStart(2, "0");
        completedIds.push(
          yield* seed(
            `board-coverage-completed-${String(index).padStart(3, "0")}`,
            "completed",
            `2026-03-01T00:${minutes}:${seconds}.000Z`,
          ),
        );
      }
      yield* seed("board-coverage-queued-1", "queued", "2026-03-01T00:00:00.000Z");
      yield* seed("board-coverage-queued-2", "queued", "2026-03-01T00:00:00.000Z");
      yield* seed("board-coverage-queued-3", "queued", "2026-03-01T00:00:00.000Z");

      const board = yield* orchestrator.getProjectBoard(projectId).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* sql`DELETE FROM symphony_work_items WHERE project_id = ${projectId}`.pipe(
              Effect.ignore,
            );
            yield* sql`DELETE FROM symphony_workflows WHERE id = ${projectId}`.pipe(Effect.ignore);
            yield* sql`DELETE FROM symphony_projects WHERE id = ${projectId}`.pipe(Effect.ignore);
          }),
        ),
      );

      const done = board?.columns.find((column) => column.id === "done");
      const notStarted = board?.columns.find((column) => column.id === "not_started");
      expect(done?.cards).toHaveLength(100);
      expect(done?.totalCount).toBe(105);
      expect(board?.truncated).toBe(true);
      expect(done?.cards.some((card) => card.workItemId === completedIds[0])).toBe(false);
      expect(done?.cards.some((card) => card.workItemId === completedIds[104])).toBe(true);
      expect(notStarted?.totalCount).toBe(3);
    }),
  );

  it.effect("rolls back project writes when workflow synchronization fails", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const sql = yield* SqlClient.SqlClient;
      const createProjectId = SymphonyProjectId.make("project-create-sync-failure");
      yield* seedWorkflow("conflicting-create-workflow", "/repo/project-create-sync-failure");

      const createResult = yield* Effect.result(
        orchestrator.createProject({
          id: createProjectId,
          codeProjectId: ProjectId.make("code-project-create-sync-failure"),
          title: "Create should roll back",
          repositoryPath: "/repo/project-create-sync-failure",
          configuration: makeProjectConfiguration(),
          now: "2026-08-10T00:00:00.000Z",
        }),
      );
      expect(createResult._tag).toBe("Failure");
      expect(yield* orchestrator.getProject(createProjectId)).toBeNull();
      yield* sql`DELETE FROM symphony_workflows WHERE id = ${WorkflowId.make("conflicting-create-workflow")}`;

      const updateProjectId = SymphonyProjectId.make("project-update-sync-failure");
      const created = yield* orchestrator.createProject({
        id: updateProjectId,
        codeProjectId: ProjectId.make("code-project-update-sync-failure"),
        title: "Original title",
        repositoryPath: "/repo/project-update-sync-failure",
        configuration: makeProjectConfiguration(),
        now: "2026-08-10T00:00:00.000Z",
      });
      yield* sql`
        UPDATE symphony_workflows
        SET id = ${WorkflowId.make("conflicting-update-workflow")}
        WHERE id = ${WorkflowId.make(updateProjectId)}
      `;

      const updateResult = yield* Effect.result(
        orchestrator.updateProject({
          projectId: updateProjectId,
          expectedRevision: created.revision,
          title: "Partially updated title",
          now: "2026-08-10T00:01:00.000Z",
        }),
      );
      expect(updateResult._tag).toBe("Failure");
      expect(yield* orchestrator.getProject(updateProjectId)).toMatchObject({
        title: "Original title",
        revision: 0,
      });
    }),
  );

  it.effect("polls an Observe workflow and projects an eligible queue without dispatching", () =>
    Effect.gen(function* () {
      dispatchedIds.length = 0;
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-observe-1", "/repo/observe");
      yield* orchestrator.refreshNow();

      const queue = yield* orchestrator.listQueue();
      // Issue 1 is open + labeled -> eligible and queued. Issue 3 is open but
      // missing the required label -> stored with ineligibility reasons.
      // Issue 2 is closed so it is not a candidate at all.
      const byTitle = new Map(queue.map((item) => [item.title, item]));
      expect(byTitle.get("Issue 1")?.lifecycle).toBe("queued");
      expect(byTitle.get("Issue 1")?.eligible).toBe(true);
      expect(byTitle.get("Issue 3")?.lifecycle).toBe("ineligible");
      expect(byTitle.get("Issue 3")?.eligible).toBe(false);
      expect(
        byTitle.get("Issue 3")?.ineligibilityReasons.some((r) => r.startsWith("missing_label")),
      ).toBe(true);
      expect(byTitle.get("Issue 2")).toBeUndefined();
      expect(
        (yield* orchestrator.listQueue({ projectId: SymphonyProjectId.make("wf-observe-1") }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        yield* orchestrator.listQueue({ projectId: SymphonyProjectId.make("other-project") }),
      ).toEqual([]);
      expect(dispatchedIds).toEqual([]);
    }),
  );

  it.effect("automatically dispatches newly queued execute work with workflow instructions", () =>
    Effect.gen(function* () {
      dispatchedIds.length = 0;
      dispatchedInputs.length = 0;
      yield* seedWorkflow("wf-execute-1", "/repo/execute", { autonomy: "execute" });

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;

      expect(dispatchedIds).toHaveLength(1);
      expect(dispatchedInputs[0]?.workflowInstructions).toBe("Implement.");
      const workflows = yield* WorkflowRepository;
      const workflow = yield* workflows.getById(WorkflowId.make("wf-execute-1"));
      if (workflow === null) {
        throw new Error("expected the execute workflow to exist");
      }
      expect(dispatchedInputs[0]?.workflowId).toBe("wf-execute-1");
      expect(dispatchedInputs[0]?.workflowRevision).toBe(workflow.updatedAt);
      const workItems = yield* WorkItemRepository;
      const dispatched = yield* workItems.getById(WorkItemId.make(dispatchedIds[0] ?? "missing"));
      expect(dispatched?.lifecycle).toBe("preparing");
    }),
  );

  it.effect("reloads active WORKFLOW.md files on every explicit tick", () =>
    Effect.gen(function* () {
      workflowReloadCalls.length = 0;
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-reload-1", "/repo/reload");

      yield* orchestrator.refreshNow();
      yield* orchestrator.refreshNow();

      expect(workflowReloadCalls.filter((path) => path === "/repo/reload")).toHaveLength(2);
    }),
  );

  it.effect("honors each workflow poll interval across scheduler scans", () =>
    Effect.gen(function* () {
      pollCountsByRepository.clear();
      yield* seedWorkflow("wf-cadence-1", "/repo/cadence", {
        pollIntervalMs: 15_000,
      });

      yield* TestClock.adjust("5 seconds");
      expect(pollCountsByRepository.get("/repo/cadence")).toBe(1);

      yield* TestClock.adjust("5 seconds");
      expect(pollCountsByRepository.get("/repo/cadence")).toBe(1);

      yield* TestClock.adjust("10 seconds");
      expect(pollCountsByRepository.get("/repo/cadence")).toBe(2);
    }),
  );

  it.effect("publishes the adapter profile without provider secrets", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-observe-2", "/repo/health", {
        trackerProvider: { api_key: "literal-token-must-not-leak" },
      });
      yield* orchestrator.refreshNow();

      const health = yield* orchestrator.listTrackerHealth();
      const github = health.find((h) => h.kind === "github");
      expect(github).toBeDefined();
      expect(github?.profile).toMatchObject({ kind: "github", displayName: "Memory (test)" });
      expect(encodeJson(github)).not.toContain("literal-token-must-not-leak");
    }),
  );

  it.effect("publishes an empty profile when adapter construction fails", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-health-failure", "/repo/health-failure", {
        trackerProvider: { api_key: "literal-token-must-not-leak" },
      });
      yield* orchestrator.refreshNow();

      const health = yield* orchestrator.listTrackerHealth();
      const github = health.find((entry) => entry.kind === "github");
      expect(github?.ok).toBe(false);
      expect(github?.profile).toEqual({});
      expect(github?.error).toContain("TEST_TOKEN");
      expect(encodeJson(github)).not.toContain("literal-token-must-not-leak");
    }),
  );

  it.effect("overview reports queued count from active workflows", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-observe-3", "/repo/overview");
      yield* orchestrator.refreshNow();
      const overview = yield* orchestrator.getOverview();
      expect(overview.activeWorkflowCount.state).toBe("known");
      if (overview.activeWorkflowCount.state === "known") {
        expect(overview.activeWorkflowCount.value).toBeGreaterThanOrEqual(1);
      }
      expect(overview.activeAgentCount.state).toBe("unavailable");
    }),
  );

  it.effect("listRuns returns seeded attempts newest first with latest event", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-runs-1", "/repo/runs");
      yield* orchestrator.refreshNow();
      const queue = yield* orchestrator.listQueue();
      const eligible = queue.find(
        (item) =>
          item.workflowId === WorkflowId.make("wf-runs-1") &&
          item.eligible === true &&
          item.excluded === false,
      );
      if (eligible === undefined) {
        return;
      }

      const runAttempts = yield* RunAttemptRepository;
      const runEvents = yield* RunEventRepository;
      const firstId = RunAttemptId.make(`run-${eligible.workItemId}-1`);
      const secondId = RunAttemptId.make(`run-${eligible.workItemId}-2`);
      yield* runAttempts.create({
        id: firstId,
        workItemId: eligible.workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/run-1",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "succeeded",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:05:00.000Z",
        error: null,
      });
      yield* runAttempts.create({
        id: secondId,
        workItemId: eligible.workItemId,
        attemptNumber: 2,
        workspacePath: "/ws/run-2",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt: "2026-01-02T00:00:00.000Z",
        finishedAt: null,
        error: null,
      });
      yield* runEvents.append(secondId, "turn_started");

      const runs = yield* orchestrator.listRuns({ limit: 10 });
      const matches = runs.filter((run) =>
        run.workItemId.toString().startsWith(eligible.workItemId.toString().slice(0, 6)),
      );
      const matchingIds = matches.map((run) => run.runAttemptId);
      expect(matchingIds).toContain(secondId);
      expect(matchingIds).toContain(firstId);
      const latest = matches.find((run) => run.runAttemptId === secondId);
      expect(latest?.status).toBe("streaming_turn");
      expect(latest?.latestEvent).toBe("turn_started");
      expect(latest?.lifecycle).toBe("running");
      expect(latest?.projectId).toBe(SymphonyProjectId.make("wf-runs-1"));
      const scopedRuns = yield* orchestrator.listRuns({
        projectId: SymphonyProjectId.make("wf-runs-1"),
      });
      expect(scopedRuns.some((run) => run.runAttemptId === secondId)).toBe(true);
      const history = yield* orchestrator.listHistory({
        projectId: SymphonyProjectId.make("wf-runs-1"),
        limit: 1,
      });
      expect(history.map((run) => run.runAttemptId)).toEqual([firstId]);
    }),
  );

  it.effect("getRun returns details with timeline and null for unknown runs", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-run-detail-1", "/repo/run-detail");
      yield* orchestrator.refreshNow();
      const queue = yield* orchestrator.listQueue();
      const eligible = queue.find((item) => item.eligible === true && item.excluded === false);
      if (eligible === undefined) {
        return;
      }

      const runAttempts = yield* RunAttemptRepository;
      const runEvents = yield* RunEventRepository;
      const runId = RunAttemptId.make(`run-${eligible.workItemId}-detail`);
      yield* runAttempts.create({
        id: runId,
        workItemId: eligible.workItemId,
        attemptNumber: 3,
        workspacePath: "/ws/run-detail",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt: "2026-01-03T00:00:00.000Z",
        finishedAt: null,
        error: null,
      });
      yield* runEvents.append(runId, "turn_started");
      yield* runEvents.append(runId, "tool_call", { tool: "edit" });

      const details = yield* orchestrator.getRun(runId.toString());
      expect(details).not.toBeNull();
      expect(details?.runAttempt.id).toEqual(runId);
      expect(details?.timeline.map((event) => event.eventType)).toEqual([
        "turn_started",
        "tool_call",
      ]);
      expect(details?.workItem.objective).toBe(eligible.title);

      const unknown = yield* orchestrator.getRun("run-does-not-exist");
      expect(unknown).toBeNull();
    }),
  );

  it.effect("getRun keeps a pending agent question with its durable row", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runAttempts = yield* RunAttemptRepository;
      const workItemId = WorkItemId.make("question-run-1");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Question target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "question-run-1",
        lifecycle: "running",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const runAttemptId = RunAttemptId.make("run-question-1");
      yield* runAttempts.create({
        id: runAttemptId,
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/question-run-1",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt: "2026-08-05T00:00:00.000Z",
        finishedAt: null,
        error: null,
      });
      const approvals = yield* ApprovalService;
      yield* approvals.recordPending({
        id: "question-1",
        workItemId,
        runAttemptId,
        requestId: "question-1",
        action: "user_input",
        scope: "once",
        reason: "Which branch should I target?",
      });

      const details = yield* orchestrator.getRun("run-question-1");
      const question = details?.attentionItems.find((item) =>
        item.id.toString().endsWith("question-1"),
      );
      expect(question?.kind).toBe("agent_question");
      expect(question?.availableActions).toEqual(["answer"]);
      expect(question?.whatHappened).toBe("Which branch should I target?");

      const row = details?.approvalRequests.find((request) =>
        request.id.toString().endsWith("question-1"),
      );
      expect(row?.kind).toBe("user_input");
      expect(row?.action).toBe("user_input");
      expect(row?.reason).toBe("Which branch should I target?");
      expect(row?.runAttemptId).toBe(runAttemptId);
      expect(yield* Schema.encodeUnknownEffect(RunDetailsSchema)(details)).toBeDefined();
    }),
  );

  it.effect("getRun keeps an answered question in the decided history", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runAttempts = yield* RunAttemptRepository;
      const approvals = yield* ApprovalService;
      const repository = yield* ApprovalRepository;
      const workItemId = WorkItemId.make("question-run-2");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Answered question target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "question-run-2",
        lifecycle: "running",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const runAttemptId = RunAttemptId.make("run-question-2");
      yield* runAttempts.create({
        id: runAttemptId,
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/question-run-2",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt: "2026-08-05T00:00:00.000Z",
        finishedAt: null,
        error: null,
      });
      const answered = yield* approvals.recordPending({
        id: "question-2",
        workItemId,
        runAttemptId,
        requestId: "question-2",
        action: "user_input",
        scope: "once",
        reason: "Which branch should I target?",
      });
      const expired = yield* approvals.recordPending({
        id: "question-2-expired",
        workItemId,
        runAttemptId,
        requestId: "question-2-expired",
        action: "user_input",
        scope: "once",
        reason: "Which environment?",
      });
      const interrupted = yield* approvals.recordPending({
        id: "approval-2",
        workItemId,
        runAttemptId,
        requestId: "approval-2",
        action: "commandExecution",
        scope: "once",
        command: "npm test",
      });
      yield* repository.decide(answered.id, "approved");
      yield* repository.decide(expired.id, "expired");
      yield* repository.decide(interrupted.id, "interrupted");

      const details = yield* orchestrator.getRun("run-question-2");
      // Nothing is waiting any more, but every decision is durable evidence.
      expect(details?.attentionItems).toEqual([]);
      const answeredRow = details?.approvalRequests.find((request) => request.id === answered.id);
      expect(answeredRow?.kind).toBe("user_input");
      // Shared feedback dependency (S4): a user-input answer is `answered`,
      // never presented as a permission approval.
      expect(answeredRow?.state).toBe("answered");
      expect(answeredRow?.reason).toBe("Which branch should I target?");
      expect(answeredRow?.decidedAt).not.toBeNull();
      expect(details?.approvalRequests.find((request) => request.id === expired.id)?.state).toBe(
        "expired",
      );
      expect(
        details?.approvalRequests.find((request) => request.id === interrupted.id)?.state,
      ).toBe("interrupted");
      expect(yield* Schema.encodeUnknownEffect(RunDetailsSchema)(details)).toBeDefined();
    }),
  );

  it.effect("getRun exposes exact confirmed Stop closure from the authoritative event", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runAttempts = yield* RunAttemptRepository;
      const runEvents = yield* RunEventRepository;
      const workItemId = WorkItemId.make("stop-closure-run-1");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Stop closure target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "stop-closure-run-1",
        lifecycle: "cancelled",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const runAttemptId = RunAttemptId.make("run-stop-closure-1");
      yield* runAttempts.create({
        id: runAttemptId,
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/stop-closure-run-1",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "user_cancelled",
        startedAt: "2026-08-05T00:00:00.000Z",
        finishedAt: "2026-08-05T00:05:00.000Z",
        error: null,
      });
      const confirmed = yield* runEvents.append(runAttemptId, "stop_confirmed", {
        workItemId: String(workItemId),
        closure: "group_terminated",
        released: true,
      });

      const details = yield* orchestrator.getRun(String(runAttemptId));
      expect(details?.runAttempt.stopClosure).toEqual({
        state: "confirmed",
        runAttemptId,
        observedAt: confirmed.occurredAt,
        source: "recovery.stop_confirmed",
      });
    }),
  );

  it.effect("getRun normalises a provider action recorded by the runtime", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runAttempts = yield* RunAttemptRepository;
      const approvals = yield* ApprovalService;
      const workItemId = WorkItemId.make("question-run-3");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Provider action target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "question-run-3",
        lifecycle: "running",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const runAttemptId = RunAttemptId.make("run-question-3");
      yield* runAttempts.create({
        id: runAttemptId,
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/question-run-3",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt: "2026-08-05T00:00:00.000Z",
        finishedAt: null,
        error: null,
      });
      // The runtime records Codex's own kind, not the policy vocabulary.
      yield* approvals.recordPending({
        id: "provider-action-1",
        workItemId,
        runAttemptId,
        requestId: "provider-action-1",
        action: "commandExecution",
        scope: "once",
        command: "npm test",
      });

      const details = yield* orchestrator.getRun("run-question-3");
      const row = details?.approvalRequests.find((request) =>
        request.id.toString().endsWith("provider-action-1"),
      );
      expect(row?.kind).toBe("approval");
      expect(row?.action).toBe("command_execution");
      expect(row?.providerAction).toBe("commandExecution");
      expect(yield* Schema.encodeUnknownEffect(RunDetailsSchema)(details)).toBeDefined();
    }),
  );

  it.effect("listAttention maps pending approval requests to attention items", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-attention-1", "/repo/attention");
      yield* orchestrator.refreshNow();
      const queue = yield* orchestrator.listQueue();
      const eligible = queue.find(
        (item) =>
          item.workflowId === WorkflowId.make("wf-attention-1") &&
          item.eligible === true &&
          item.excluded === false,
      );
      // Assert rather than return: the mapping assertions below must not be
      // able to pass without running.
      expect(eligible).toBeDefined();
      if (eligible === undefined) {
        return;
      }

      const approvals = yield* ApprovalService;
      yield* approvals.recordPending({
        id: "attn-1",
        workItemId: eligible.workItemId,
        runAttemptId: RunAttemptId.make(`run-${eligible.workItemId}-attn`),
        requestId: "attn-1",
        action: "command_execution",
        scope: "once",
        command: "npm run build",
        workingDirectory: "/ws/run",
        reason: "builds the workspace",
      });

      const attention = yield* orchestrator.listAttention();
      const item = attention.find((a) => a.id.toString().endsWith("attn-1"));
      expect(item).toBeDefined();
      expect(item?.kind).toBe("command_approval");
      expect(item?.availableActions).toEqual(["approve", "reject"]);
      const scopedAttention = yield* orchestrator.listAttention({
        projectId: SymphonyProjectId.make("wf-attention-1"),
        limit: 1,
      });
      expect(scopedAttention.map((entry) => entry.id)).toEqual([item?.id]);

      // A user-input request is a question, not a command approval: it carries
      // the persisted prompt text and is answered, not approved/rejected.
      yield* approvals.recordPending({
        id: "attn-2",
        workItemId: eligible.workItemId,
        runAttemptId: RunAttemptId.make(`run-${eligible.workItemId}-question`),
        requestId: "attn-2",
        action: "user_input",
        scope: "once",
        reason: "Which branch should I target?",
      });

      const withQuestion = yield* orchestrator.listAttention();
      const question = withQuestion.find((a) => a.id.toString().endsWith("attn-2"));
      expect(question).toBeDefined();
      expect(question?.kind).toBe("agent_question");
      expect(question?.availableActions).toEqual(["answer"]);
      expect(question?.whatHappened).toBe("Which branch should I target?");
      // The command approval is unchanged by the presence of a question.
      expect(withQuestion.find((a) => a.id.toString().endsWith("attn-1"))?.kind).toBe(
        "command_approval",
      );
    }),
  );

  it.effect("expires approval requests past the workflow timeout on tick", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-approve-1", "/repo/approve");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-approve-1"),
        repositoryPath: "/repo/approve",
        workflowPath: "/repo/approve/WORKFLOW.md",
        status: "active",
        autonomy: "observe",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/approve"),
          approvalsWaitTimeoutMs: 5_000,
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      yield* orchestrator.refreshNow();
      const queue = yield* orchestrator.listQueue();
      const eligible = queue.find((item) => item.eligible === true && item.excluded === false);
      if (eligible === undefined) {
        return;
      }

      const workItemRepository = yield* WorkItemRepository;
      yield* workItemRepository.upsert({
        id: WorkItemId.make(`sweep-${eligible.workItemId}`),
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Sweep target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: `sweep-${eligible.workItemId}`,
        workflowId: WorkflowId.make("wf-approve-1"),
        lifecycle: "running",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const runAttempts = yield* RunAttemptRepository;
      const runId = RunAttemptId.make(`run-sweep-${eligible.workItemId}`);
      yield* runAttempts.create({
        id: runId,
        workItemId: WorkItemId.make(`sweep-${eligible.workItemId}`),
        attemptNumber: 1,
        workspacePath: "/ws/sweep",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt: "1970-01-01T00:00:00.000Z",
        finishedAt: null,
        error: null,
      });

      const approvals = yield* ApprovalService;
      yield* approvals.recordPending({
        id: "ap-1",
        workItemId: WorkItemId.make(`sweep-${eligible.workItemId}`),
        runAttemptId: runId,
        requestId: "ap-1",
        action: "command_execution",
        scope: "once",
        command: "npm run build",
        workingDirectory: "/ws/sweep",
        reason: "builds the workspace",
      });

      yield* TestClock.adjust("600000 millis");
      yield* orchestrator.refreshNow();

      const repository = yield* ApprovalRepository;
      const request = yield* repository.getById("sym-ap-1");
      expect(request?.state).toBe("expired");
    }),
  );

  it.effect("re-dispatches a retry_scheduled item once its backoff elapses", () =>
    Effect.gen(function* () {
      dispatchedIds.length = 0;
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-retry-1", "/repo/retry");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-retry-1"),
        repositoryPath: "/repo/retry",
        workflowPath: "/repo/retry/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/retry"),
          autonomy: "execute",
          maxRetryBackoffMs: 30_000,
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const workItemId = WorkItemId.make("retry-1");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Retry target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        // Must match an issue the memory tracker actually holds, because the
        // retry path re-checks the tracker (plan 9.5; audit item 2).
        trackerIssueId: "1",
        workflowId: WorkflowId.make("wf-retry-1"),
        lifecycle: "retry_scheduled",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const runAttempts = yield* RunAttemptRepository;
      const recent = yield* nowIso;
      yield* runAttempts.create({
        id: RunAttemptId.make("run-retry-1"),
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/retry",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "failed",
        startedAt: recent,
        finishedAt: recent,
        error: { category: "agent", message: "turn failed" },
      });

      // Backoff window: finished now + 10s; before advancing the clock the
      // item must stay scheduled. Advance just past the window (11s) so the
      // forked poll loop (30s cadence) does not fire extra ticks.
      yield* orchestrator.refreshNow();
      const before = yield* workItems.getById(workItemId);
      expect(before?.lifecycle).toBe("retry_scheduled");
      expect(dispatchedIds).toEqual([]);

      // Let the 5-second scheduler scans carry the retry across its 10-second
      // backoff boundary. The scan at or after 10s performs the dispatch; do
      // not force an explicit tick, because this intentionally minimal mock
      // does not create the new run-attempt row that production dispatch
      // records. The scan fans out over many queued leftovers (one
      // latest-attempt read each), so allow several scans for it to land.
      let after = yield* workItems.getById(workItemId);
      for (let tick = 0; tick < 10 && after?.lifecycle !== "preparing"; tick += 1) {
        yield* TestClock.adjust("5 seconds");
        yield* settle;
        after = yield* workItems.getById(workItemId);
      }
      expect(after?.lifecycle).toBe("preparing");
      expect(dispatchedIds).toContain("retry-1");
    }),
  );

  it.effect("does not re-dispatch a retry whose issue vanished from the tracker", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-retry-2", "/repo/retry-2");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-retry-2"),
        repositoryPath: "/repo/retry-2",
        workflowPath: "/repo/retry-2/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/retry-2"),
          autonomy: "execute",
          maxRetryBackoffMs: 30_000,
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const workItemId = WorkItemId.make("retry-2");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Vanished issue",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        // No such issue exists in the memory tracker: the re-check must
        // refuse the dispatch and leave the item queued (plan 9.5).
        trackerIssueId: "ghost-issue",
        workflowId: WorkflowId.make("wf-retry-2"),
        lifecycle: "retry_scheduled",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const runAttempts = yield* RunAttemptRepository;
      const recent = yield* nowIso;
      yield* runAttempts.create({
        id: RunAttemptId.make("run-retry-2"),
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/retry-2",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "failed",
        startedAt: recent,
        finishedAt: recent,
        error: { category: "agent", message: "boom" },
      });
      // Rewind the clock so the backoff is due.
      yield* TestClock.adjust("31 seconds");

      dispatchedIds.length = 0;
      yield* orchestrator.refreshNow();
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("retry_scheduled");
      expect(dispatchedIds).not.toContain("retry-2");
    }),
  );

  it.effect("does not auto-relaunch a queued item whose latest attempt was cancelled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-cancel-guard-1", "/repo/cancel-guard-1");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-cancel-guard-1"),
        repositoryPath: "/repo/cancel-guard-1",
        workflowPath: "/repo/cancel-guard-1/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/cancel-guard-1"),
          autonomy: "execute",
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const projectId = SymphonyProjectId.make("cancel-guard-1");
      const workItemId = WorkItemId.make("cancel-guard-1");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId,
        objective: "Cancelled target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId: WorkflowId.make("wf-cancel-guard-1"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const runAttempts = yield* RunAttemptRepository;
      const recent = yield* nowIso;
      yield* runAttempts.create({
        id: RunAttemptId.make("run-cancel-guard-1"),
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/cancel-guard-1",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "user_cancelled",
        startedAt: recent,
        finishedAt: recent,
        error: { category: "user_cancelled", message: "user cancelled" },
      });

      dispatchedIds.length = 0;
      yield* orchestrator.refreshNow();
      expect(dispatchedIds).not.toContain("cancel-guard-1");
      yield* TestClock.adjust("10 seconds");
      // Let the scan this advance triggered finish before the next test: a late
      // tick would reconcile the explicit-dispatch claim seeded there.
      yield* settle;
      expect(dispatchedIds).not.toContain("cancel-guard-1");
    }),
  );

  it.effect("an explicit dispatch retries a failed item", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-failed-retry-1", "/repo/failed-retry-1");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-failed-retry-1"),
        repositoryPath: "/repo/failed-retry-1",
        workflowPath: "/repo/failed-retry-1/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/failed-retry-1"),
          autonomy: "execute",
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const projectId = SymphonyProjectId.make("failed-retry-1");
      const workItemId = WorkItemId.make("failed-retry-1");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId,
        objective: "Failed target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId: WorkflowId.make("wf-failed-retry-1"),
        lifecycle: "failed",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const runAttempts = yield* RunAttemptRepository;
      const recent = yield* nowIso;
      yield* runAttempts.create({
        id: RunAttemptId.make("run-failed-retry-1"),
        workItemId,
        attemptNumber: 5,
        workspacePath: "/ws/failed-retry-1",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "failed",
        startedAt: recent,
        finishedAt: recent,
        error: { category: "agent", message: "turn failed" },
      });

      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem(workItemId);
      // Wait for the forked dispatch WITHOUT advancing the clock (a
      // scheduler tick would reconcile the mock-held claim straight back:
      // the mock reports no active agent and the seeded attempt is
      // terminal, so any tick releases it to queued).
      for (let i = 0; i < 500 && !dispatchedIds.includes("failed-retry-1"); i++) {
        yield* Effect.yieldNow;
      }
      expect(dispatchedIds).toContain("failed-retry-1");
      // The claim runs in the forked dispatch: wait for it to land.
      let after = yield* workItems.getById(workItemId);
      for (let i = 0; i < 200 && after?.lifecycle !== "preparing"; i++) {
        yield* Effect.yieldNow;
        after = yield* workItems.getById(workItemId);
      }
      expect(after?.lifecycle).toBe("preparing");
    }),
  );

  it.effect("an explicit dispatch also overrides the guard for a queued item", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-cancel-override-1", "/repo/cancel-override-1");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-cancel-override-1"),
        repositoryPath: "/repo/cancel-override-1",
        workflowPath: "/repo/cancel-override-1/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/cancel-override-1"),
          autonomy: "execute",
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const projectId = SymphonyProjectId.make("cancel-override-1");
      const workItemId = WorkItemId.make("cancel-override-1");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId,
        objective: "Cancelled override target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId: WorkflowId.make("wf-cancel-override-1"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const runAttempts = yield* RunAttemptRepository;
      const recent = yield* nowIso;
      yield* runAttempts.create({
        id: RunAttemptId.make("run-cancel-override-1"),
        workItemId,
        attemptNumber: 1,
        workspacePath: "/ws/cancel-override-1",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "user_cancelled",
        startedAt: recent,
        finishedAt: recent,
        error: { category: "user_cancelled", message: "user cancelled" },
      });

      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem(workItemId);
      yield* awaitDispatched("cancel-override-1");
      expect(dispatchedIds).toContain("cancel-override-1");
    }),
  );

  it.effect("launches the next candidate once the head item has left the queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-head-queue-1", "/repo/head-queue-1");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-head-queue-1"),
        repositoryPath: "/repo/head-queue-1",
        workflowPath: "/repo/head-queue-1/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/head-queue-1"),
          autonomy: "execute",
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const workItems = yield* WorkItemRepository;
      const firstId = WorkItemId.make("head-queue-1");
      yield* workItems.upsert({
        id: firstId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("head-queue-first"),
        objective: "First",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId: WorkflowId.make("wf-head-queue-1"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        // Predate every other queued leftover in the shared suite database
        // so the one-launch-per-tick scan reaches these two items first.
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      });
      const secondId = WorkItemId.make("head-queue-2");
      yield* workItems.upsert({
        id: secondId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("head-queue-second"),
        objective: "Second",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId: WorkflowId.make("wf-head-queue-1"),
        lifecycle: "queued",
        priority: 2,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2020-01-01T00:00:01.000Z",
        updatedAt: "2020-01-01T00:00:01.000Z",
      });

      dispatchedIds.length = 0;
      // The shared suite database holds older queued leftovers, and the
      // one-launch-per-tick scan serves them first: tick until the head item
      // goes, then check the second follows after the head leaves the queue.
      for (let tick = 0; tick < 40 && !dispatchedIds.includes("head-queue-1"); tick++) {
        yield* TestClock.adjust("5 seconds");
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
      }
      expect(dispatchedIds).toContain("head-queue-1");
      yield* workItems.transition(firstId, "failed", { from: ["preparing"] });
      for (let tick = 0; tick < 40 && !dispatchedIds.includes("head-queue-2"); tick++) {
        yield* TestClock.adjust("5 seconds");
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
      }
      expect(dispatchedIds).toContain("head-queue-2");
      expect(dispatchedIds.indexOf("head-queue-1")).toBeLessThan(
        dispatchedIds.indexOf("head-queue-2"),
      );
    }),
  );

  const seedForkWorkflow = (id: string, repositoryPath: string) =>
    Effect.gen(function* () {
      yield* seedWorkflow(id, repositoryPath);
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make(id),
        repositoryPath,
        workflowPath: `${repositoryPath}/WORKFLOW.md`,
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig(repositoryPath),
          autonomy: "execute",
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
    });

  const seedForkItem = (
    id: string,
    projectId: string,
    workflowId: string,
    lifecycle: "queued" | "retry_scheduled",
  ) =>
    Effect.gen(function* () {
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: WorkItemId.make(id),
        mode: "symphony",
        projectId: SymphonyProjectId.make(projectId),
        objective: `Fork ${id}`,
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId: WorkflowId.make(workflowId),
        lifecycle,
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
    });

  it.effect("manual dispatch returns before the run ends and survives the caller's scope", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      yield* seedForkWorkflow("wf-fork-1", "/repo/fork-1");
      yield* seedForkItem("fork-1", "fork-project-1", "wf-fork-1", "queued");
      dispatchGate = yield* Deferred.make<void>();
      dispatchStatus.interrupted = false;
      dispatchStatus.completed = false;
      const result = yield* Effect.scoped(orchestrator.dispatchWorkItem("fork-1"));
      void result;
      yield* awaitDispatched("fork-1");
      yield* settle;
      expect(dispatchStatus.interrupted).toBe(false);
      expect(dispatchStatus.completed).toBe(false);
      expect((yield* workItems.getById(WorkItemId.make("fork-1")))?.lifecycle).toBe("preparing");
      yield* Deferred.succeed(dispatchGate, undefined);
      yield* settle;
      expect(dispatchStatus.completed).toBe(true);
      dispatchGate = null;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (dispatchGate !== null) {
            yield* Deferred.succeed(dispatchGate, undefined).pipe(Effect.catch(() => Effect.void));
            dispatchGate = null;
          }
        }),
      ),
    ),
  );

  it.effect("a due retry does not block the scheduler tick", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedForkWorkflow("wf-fork-2", "/repo/fork-2");
      yield* seedForkItem("fork-2", "fork-project-2", "wf-fork-2", "retry_scheduled");
      const runAttempts = yield* RunAttemptRepository;
      yield* runAttempts.create({
        id: RunAttemptId.make("run-fork-2"),
        workItemId: WorkItemId.make("fork-2"),
        attemptNumber: 1,
        workspacePath: "/ws/fork-2",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "failed",
        startedAt: "1969-12-31T00:00:00.000Z",
        finishedAt: "1969-12-31T00:00:00.000Z",
        error: { category: "agent", message: "turn failed" },
      });
      dispatchGate = yield* Deferred.make<void>();
      dispatchStatus.interrupted = false;
      dispatchStatus.completed = false;
      const tick = yield* orchestrator.refreshNow().pipe(Effect.forkScoped);
      yield* settle;
      expect(tick.pollUnsafe()).not.toBe(undefined);
      expect(dispatchedIds.filter((id) => id.startsWith("fork-"))).toContain("fork-2");
      yield* Deferred.succeed(dispatchGate, undefined);
      yield* settle;
      dispatchGate = null;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (dispatchGate !== null) {
            yield* Deferred.succeed(dispatchGate, undefined).pipe(Effect.catch(() => Effect.void));
            dispatchGate = null;
          }
        }),
      ),
    ),
  );

  it.effect("one retry launch per tick suppresses the queued launch", () =>
    Effect.gen(function* () {
      yield* seedForkWorkflow("wf-fork-3", "/repo/fork-3");
      yield* seedForkItem("fork-3-retry", "fork-project-3-retry", "wf-fork-3", "retry_scheduled");
      yield* seedForkItem("fork-3-queued", "fork-project-3-queued", "wf-fork-3", "queued");
      const runAttempts = yield* RunAttemptRepository;
      yield* runAttempts.create({
        id: RunAttemptId.make("run-fork-3"),
        workItemId: WorkItemId.make("fork-3-retry"),
        attemptNumber: 1,
        workspacePath: "/ws/fork-3",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "failed",
        startedAt: "1969-12-31T00:00:00.000Z",
        finishedAt: "1969-12-31T00:00:00.000Z",
        error: { category: "agent", message: "turn failed" },
      });
      dispatchGate = yield* Deferred.make<void>();
      dispatchStatus.interrupted = false;
      dispatchStatus.completed = false;
      dispatchedIds.length = 0;
      // Older due retries from earlier tests go first (one launch per
      // tick): tick until this test's retry launches.
      for (let tick = 0; tick < 40 && !dispatchedIds.includes("fork-3-retry"); tick++) {
        yield* TestClock.adjust("5 seconds");
        yield* settle;
      }
      expect(dispatchedIds.filter((id) => id.startsWith("fork-"))).toEqual(["fork-3-retry"]);
      for (let tick = 0; tick < 40 && !dispatchedIds.includes("fork-3-queued"); tick++) {
        yield* TestClock.adjust("5 seconds");
        yield* settle;
      }
      expect(dispatchedIds.filter((id) => id.startsWith("fork-"))).toEqual([
        "fork-3-retry",
        "fork-3-queued",
      ]);
      yield* Deferred.succeed(dispatchGate, undefined);
      yield* settle;
      dispatchGate = null;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (dispatchGate !== null) {
            yield* Deferred.succeed(dispatchGate, undefined).pipe(Effect.catch(() => Effect.void));
            dispatchGate = null;
          }
        }),
      ),
    ),
  );

  it.effect("refuses a queued item whose tracker issue is closed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-stale-1", "/repo/stale-1", { autonomy: "execute" });
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make("stale-closed-1");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("stale-project-1"),
        objective: "Stale closed",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "2",
        workflowId: WorkflowId.make("wf-stale-1"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem(workItemId);
      expect(dispatchedIds).not.toContain("stale-closed-1");
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("ineligible");
      expect(after?.eligibilityReasons.some((r) => r.startsWith("state_terminal:"))).toBe(true);
    }),
  );

  it.effect("refuses dispatch when active-work occupancy cannot be decoded", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const sql = yield* SqlClient.SqlClient;
      const workflowId = WorkflowId.make("wf-occupancy-corrupt");
      yield* seedWorkflow("wf-occupancy-corrupt", "/repo/occupancy-corrupt", {
        autonomy: "execute",
        concurrencyGlobal: 1,
        trackerRequiredLabels: [],
      });

      const projectId = SymphonyProjectId.make("occupancy-corrupt-project");
      const corruptId = WorkItemId.make("occupancy-corrupt-active");
      const targetId = WorkItemId.make("occupancy-corrupt-target");
      yield* workItems.upsert({
        id: corruptId,
        mode: "symphony",
        projectId,
        objective: "Corrupt active",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId,
        lifecycle: "running",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      yield* workItems.upsert({
        id: targetId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("occupancy-corrupt-target-project"),
        objective: "Occupancy target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId,
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:01.000Z",
        updatedAt: "2026-08-05T00:00:01.000Z",
      });
      yield* sql`UPDATE symphony_work_items SET acceptance_criteria_json = 'not json' WHERE id = ${corruptId}`;

      yield* Effect.gen(function* () {
        dispatchedIds.length = 0;
        const outcome = yield* Effect.result(orchestrator.dispatchWorkItem(targetId));
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") {
          expect(outcome.failure._tag).toMatch(/^SymphonyPersistence/);
        }
        yield* settle;
        expect(dispatchedIds).not.toContain("occupancy-corrupt-target");
        expect((yield* workItems.getById(targetId))?.lifecycle).toBe("queued");
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              sql`DELETE FROM symphony_work_items WHERE workflow_id = ${workflowId}`.pipe(
                Effect.ignore,
              ),
              sql`DELETE FROM symphony_workflows WHERE id = ${workflowId}`.pipe(Effect.ignore),
            ],
            { concurrency: 1 },
          ).pipe(Effect.asVoid),
        ),
      );
    }),
  );

  it.effect("refuses a queued item whose required label was removed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-stale-2", "/repo/stale-2", { autonomy: "execute" });
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make("stale-unlabelled-1");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("stale-project-2"),
        objective: "Stale unlabelled",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "3",
        workflowId: WorkflowId.make("wf-stale-2"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem(workItemId);
      expect(dispatchedIds).not.toContain("stale-unlabelled-1");
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("ineligible");
      expect(after?.eligibilityReasons.some((r) => r.includes("agent-ready"))).toBe(true);
    }),
  );

  it.effect("keeps a retry_scheduled item and records the reasons", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-stale-3", "/repo/stale-3", { autonomy: "execute" });
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make("stale-retry-1");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("stale-project-3"),
        objective: "Stale retry",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "2",
        workflowId: WorkflowId.make("wf-stale-3"),
        lifecycle: "retry_scheduled",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem(workItemId);
      expect(dispatchedIds).not.toContain("stale-retry-1");
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("retry_scheduled");
      expect((after?.eligibilityReasons.length ?? 0) > 0).toBe(true);
    }),
  );

  it.effect("does not re-check a review continuation", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-stale-4", "/repo/stale-4", { autonomy: "execute" });
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make("stale-review-1");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("stale-project-4"),
        objective: "Stale review",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "2",
        workflowId: WorkflowId.make("wf-stale-4"),
        lifecycle: "changes_requested",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem(workItemId);
      yield* awaitDispatched("stale-review-1");
      expect(dispatchedIds).toContain("stale-review-1");
    }),
  );

  it.effect("a refused dispatch leaves a changes_requested item where it was", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-run-again-1", "/repo/run-again-1", { autonomy: "execute" });
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make("run-again-1");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("run-again-project-1"),
        objective: "Run again",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "1",
        workflowId: WorkflowId.make("wf-run-again-1"),
        lifecycle: "changes_requested",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      yield* orchestrator.setWorkflowPaused("wf-run-again-1", true);

      const refused = yield* orchestrator.dispatchWorkItem("run-again-1");
      expect(refused).toEqual({ status: "refused", reason: "paused", detail: "workflow" });
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("changes_requested");

      yield* orchestrator.setWorkflowPaused("wf-run-again-1", false);
      dispatchedIds.length = 0;
      const started = yield* orchestrator.dispatchWorkItem("run-again-1");
      expect(started).toEqual({ status: "started" });
      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow;
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("preparing");
      expect(dispatchedIds).toContain("run-again-1");
    }),
  );

  it.effect("dispatch requeues and claims a validation_failed item", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-run-again-2", "/repo/run-again-2", { autonomy: "execute" });
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make("run-again-2");
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: SymphonyProjectId.make("run-again-project-2"),
        objective: "Validation failed rerun",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "1",
        workflowId: WorkflowId.make("wf-run-again-2"),
        lifecycle: "validation_failed",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      dispatchedIds.length = 0;
      const started = yield* orchestrator.dispatchWorkItem("run-again-2");
      expect(started).toEqual({ status: "started" });
      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow;
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("preparing");
      expect(dispatchedIds).toContain("run-again-2");
    }),
  );

  it.effect("per-scope pause gates dispatch for the paused workflow", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-pause-1", "/repo/pause");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-pause-1"),
        repositoryPath: "/repo/pause",
        workflowPath: "/repo/pause/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: {
          ...makeConfig("/repo/pause"),
          autonomy: "execute",
          trackerRequiredLabels: [],
        },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const workItemId = WorkItemId.make("pause-1");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Paused target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "3",
        workflowId: WorkflowId.make("wf-pause-1"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      yield* orchestrator.setWorkflowPaused("wf-pause-1", true);
      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem("pause-1");
      expect(dispatchedIds).not.toContain("pause-1");

      yield* orchestrator.setWorkflowPaused("wf-pause-1", false);
      yield* orchestrator.dispatchWorkItem("pause-1");
      yield* awaitDispatched("pause-1");
      expect(dispatchedIds).toContain("pause-1");
    }),
  );

  it.effect("does not auto-dispatch queued work from a paused workflow", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-project-paused", "/repo/project-paused");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-project-paused"),
        repositoryPath: "/repo/project-paused",
        workflowPath: "symphony-project:project-paused",
        status: "paused",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: { ...makeConfig("/repo/project-paused"), autonomy: "execute" },
        enabledAt: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: WorkItemId.make("project-paused-1"),
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Paused project target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "project-paused-3",
        workflowId: WorkflowId.make("wf-project-paused"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const retryItemId = WorkItemId.make("project-paused-retry");
      yield* workItems.upsert({
        id: retryItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Paused project retry",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "project-paused-retry",
        workflowId: WorkflowId.make("wf-project-paused"),
        lifecycle: "retry_scheduled",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const recent = yield* nowIso;
      const runAttempts = yield* RunAttemptRepository;
      yield* runAttempts.create({
        id: RunAttemptId.make("project-paused-retry-run"),
        workItemId: retryItemId,
        attemptNumber: 1,
        workspacePath: "/ws/project-paused-retry",
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "failed",
        startedAt: recent,
        finishedAt: recent,
        error: { category: "agent", message: "retry me" },
      });
      yield* TestClock.adjust("31 seconds");

      dispatchedIds.length = 0;
      yield* orchestrator.refreshNow();
      expect(dispatchedIds).not.toContain("project-paused-1");
      expect(dispatchedIds).not.toContain("project-paused-retry");
    }),
  );

  it.effect("global pause blocks dispatch and stopAllRuns reports stopped runs", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-pause-2", "/repo/pause-2");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-pause-2"),
        repositoryPath: "/repo/pause-2",
        workflowPath: "/repo/pause-2/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: { ...makeConfig("/repo/pause-2"), autonomy: "execute" },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const workItemId = WorkItemId.make("pause-2");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Global pause target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        workflowId: WorkflowId.make("wf-pause-2"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      yield* orchestrator.setGlobalPaused(true);
      const pausedNow = yield* orchestrator.isPaused();
      expect(pausedNow).toBe(true);
      dispatchedIds.length = 0;
      yield* orchestrator.dispatchWorkItem("pause-2");
      expect(dispatchedIds).not.toContain("pause-2");
      yield* orchestrator.setGlobalPaused(false);

      const stopped = yield* orchestrator.stopAllRuns();
      expect(stopped).toBe(0);
    }),
  );

  it.effect("dispatchWorkItem reports why a dispatch was refused", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const sql = yield* SqlClient.SqlClient;
      const seededItemIds: Array<WorkItemId> = [];
      const seededWorkflowIds: Array<WorkflowId> = [];
      const seedItem = (input: {
        readonly id: string;
        readonly lifecycle: WorkItem["lifecycle"];
        readonly workflowId?: string;
        readonly trackerIssueId?: string;
        readonly eligibilityReasons?: ReadonlyArray<string>;
      }) =>
        Effect.gen(function* () {
          const id = WorkItemId.make(input.id);
          seededItemIds.push(id);
          yield* workItems.upsert({
            id,
            mode: "symphony",
            projectId: SymphonyProjectId.make(`dispatch-refusal-${input.id}`),
            objective: input.id,
            acceptanceCriteria: [],
            source: { kind: "manual" },
            ...(input.trackerIssueId === undefined ? {} : { trackerIssueId: input.trackerIssueId }),
            ...(input.workflowId === undefined
              ? {}
              : { workflowId: WorkflowId.make(input.workflowId) }),
            lifecycle: input.lifecycle,
            priority: 1,
            eligibilityReasons: [...(input.eligibilityReasons ?? [])],
            evidence: null,
            createdAt: "2026-08-05T00:00:00.000Z",
            updatedAt: "2026-08-05T00:00:00.000Z",
          });
        });
      const seedExecuteWorkflow = (id: string, overrides: Partial<EffectiveWorkflowConfig> = {}) =>
        Effect.gen(function* () {
          seededWorkflowIds.push(WorkflowId.make(id));
          yield* seedWorkflow(id, `/repo/${id}`, {
            autonomy: "execute",
            trackerRequiredLabels: [],
            concurrencyGlobal: 10_000,
            ...overrides,
          });
        });

      yield* Effect.gen(function* () {
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-missing")).toEqual({
          status: "refused",
          reason: "not_found",
        });

        yield* seedItem({ id: "dispatch-refusal-running", lifecycle: "running" });
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-running")).toMatchObject({
          status: "refused",
          reason: "already_running",
        });

        yield* seedItem({ id: "dispatch-refusal-review", lifecycle: "ready_for_review" });
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-review")).toMatchObject({
          status: "refused",
          reason: "not_dispatchable",
        });

        yield* seedExecuteWorkflow("wf-refusal-paused");
        yield* seedItem({
          id: "dispatch-refusal-paused",
          lifecycle: "queued",
          workflowId: "wf-refusal-paused",
          trackerIssueId: "1",
        });
        yield* orchestrator.setWorkflowPaused("wf-refusal-paused", true);
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-paused")).toEqual({
          status: "refused",
          reason: "paused",
          detail: "workflow",
        });
        yield* orchestrator.setWorkflowPaused("wf-refusal-paused", false);

        yield* seedExecuteWorkflow("wf-refusal-global");
        yield* seedItem({
          id: "dispatch-refusal-global",
          lifecycle: "queued",
          workflowId: "wf-refusal-global",
          trackerIssueId: "1",
        });
        yield* orchestrator.setGlobalPaused(true);
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-global")).toEqual({
          status: "refused",
          reason: "paused",
          detail: "global",
        });
        yield* orchestrator.setGlobalPaused(false);

        yield* seedExecuteWorkflow("wf-refusal-excluded");
        yield* seedItem({
          id: "dispatch-refusal-excluded",
          lifecycle: "queued",
          workflowId: "wf-refusal-excluded",
          trackerIssueId: "1",
        });
        yield* orchestrator.excludeWorkItem("dispatch-refusal-excluded", true);
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-excluded")).toEqual({
          status: "refused",
          reason: "excluded",
        });

        yield* seedExecuteWorkflow("wf-refusal-ineligible");
        yield* seedItem({
          id: "dispatch-refusal-ineligible",
          lifecycle: "queued",
          workflowId: "wf-refusal-ineligible",
          trackerIssueId: "1",
          eligibilityReasons: ["missing_label:agent-ready"],
        });
        const ineligible = yield* orchestrator.dispatchWorkItem("dispatch-refusal-ineligible");
        expect(ineligible).toMatchObject({ status: "refused", reason: "ineligible" });
        if (ineligible.status === "refused") {
          expect(ineligible.detail).toContain("missing_label");
        }

        seededWorkflowIds.push(WorkflowId.make("wf-refusal-observe"));
        yield* seedWorkflow("wf-refusal-observe", "/repo/wf-refusal-observe");
        yield* seedItem({
          id: "dispatch-refusal-observe",
          lifecycle: "queued",
          workflowId: "wf-refusal-observe",
          trackerIssueId: "1",
        });
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-observe")).toEqual({
          status: "refused",
          reason: "observe_only",
        });

        yield* seedItem({
          id: "dispatch-refusal-no-workflow",
          lifecycle: "queued",
          workflowId: "no-such-refusal-workflow",
          trackerIssueId: "1",
        });
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-no-workflow")).toEqual({
          status: "refused",
          reason: "no_workflow",
        });

        yield* seedExecuteWorkflow("wf-refusal-refresh");
        yield* seedItem({
          id: "dispatch-refusal-refresh",
          lifecycle: "queued",
          workflowId: "wf-refusal-refresh",
          trackerIssueId: "999",
        });
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-refresh")).toEqual({
          status: "refused",
          reason: "tracker_refresh_failed",
        });

        yield* seedExecuteWorkflow("wf-refusal-cap", { concurrencyGlobal: 1 });
        yield* seedItem({
          id: "dispatch-refusal-cap-active",
          lifecycle: "running",
          workflowId: "wf-refusal-cap",
        });
        yield* seedItem({
          id: "dispatch-refusal-cap-target",
          lifecycle: "queued",
          workflowId: "wf-refusal-cap",
          trackerIssueId: "1",
        });
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-cap-target")).toEqual({
          status: "refused",
          reason: "concurrency_cap",
          detail: "global",
        });

        yield* seedExecuteWorkflow("wf-refusal-started");
        yield* seedItem({
          id: "dispatch-refusal-started",
          lifecycle: "queued",
          workflowId: "wf-refusal-started",
          trackerIssueId: "1",
        });
        dispatchedIds.length = 0;
        expect(yield* orchestrator.dispatchWorkItem("dispatch-refusal-started")).toEqual({
          status: "started",
        });
        yield* TestClock.adjust("100 millis");
        yield* Effect.yieldNow;
        expect(dispatchedIds).toContain("dispatch-refusal-started");
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* orchestrator.setGlobalPaused(false).pipe(Effect.ignore);
            for (const workflowId of seededWorkflowIds) {
              yield* orchestrator.setWorkflowPaused(String(workflowId), false).pipe(Effect.ignore);
              yield* sql`DELETE FROM symphony_workflows WHERE id = ${workflowId}`.pipe(
                Effect.ignore,
              );
            }
            for (const itemId of seededItemIds) {
              yield* sql`DELETE FROM symphony_work_items WHERE id = ${itemId}`.pipe(Effect.ignore);
            }
          }),
        ),
      );
    }),
  );

  it.effect(
    "dispatchWorkItem surfaces a work-item read failure instead of reporting the item missing",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        const workItems = yield* WorkItemRepository;
        const sql = yield* SqlClient.SqlClient;
        const workItemId = WorkItemId.make("dispatch-read-failure-item");
        yield* workItems.upsert({
          id: workItemId,
          mode: "symphony",
          projectId: SymphonyProjectId.make("dispatch-read-failure-item-project"),
          objective: "Read failure target",
          acceptanceCriteria: [],
          source: { kind: "manual" },
          lifecycle: "queued",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        yield* sql`UPDATE symphony_work_items SET lifecycle = 'not-a-lifecycle' WHERE id = ${workItemId}`;

        const result = yield* Effect.result(orchestrator.dispatchWorkItem(String(workItemId))).pipe(
          Effect.ensuring(
            sql`DELETE FROM symphony_work_items WHERE id = ${workItemId}`.pipe(Effect.ignore),
          ),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag).toMatch(/^SymphonyPersistence/);
        }
      }),
  );

  it.effect(
    "dispatchWorkItem surfaces a workflow read failure instead of reporting no workflow",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        const workItems = yield* WorkItemRepository;
        const sql = yield* SqlClient.SqlClient;
        const workflowId = WorkflowId.make("wf-dispatch-read-failure");
        const workItemId = WorkItemId.make("dispatch-read-failure-workflow");
        yield* seedWorkflow("wf-dispatch-read-failure", "/repo/dispatch-read-failure", {
          autonomy: "execute",
          trackerRequiredLabels: [],
          concurrencyGlobal: 10_000,
        });
        yield* workItems.upsert({
          id: workItemId,
          mode: "symphony",
          projectId: SymphonyProjectId.make("dispatch-read-failure-workflow-project"),
          objective: "Workflow read failure target",
          acceptanceCriteria: [],
          source: { kind: "manual" },
          trackerIssueId: "1",
          workflowId,
          lifecycle: "queued",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        yield* sql`ALTER TABLE symphony_workflows RENAME TO symphony_workflows_read_failure`;

        const result = yield* Effect.result(orchestrator.dispatchWorkItem(String(workItemId))).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* sql`ALTER TABLE symphony_workflows_read_failure RENAME TO symphony_workflows`.pipe(
                Effect.ignore,
              );
              yield* sql`DELETE FROM symphony_work_items WHERE id = ${workItemId}`.pipe(
                Effect.ignore,
              );
              yield* sql`DELETE FROM symphony_workflows WHERE id = ${workflowId}`.pipe(
                Effect.ignore,
              );
            }),
          ),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag).toMatch(/^SymphonyPersistence/);
        }
      }),
  );

  it.effect(
    "dispatchWorkItem surfaces an occupancy read failure instead of refusing on unreadable state",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        const workItems = yield* WorkItemRepository;
        const sql = yield* SqlClient.SqlClient;
        const workflowId = WorkflowId.make("wf-dispatch-read-failure-occupancy");
        const workItemId = WorkItemId.make("dispatch-read-failure-occupancy-target");
        const activeId = WorkItemId.make("dispatch-read-failure-occupancy-active");
        yield* seedWorkflow(
          "wf-dispatch-read-failure-occupancy",
          "/repo/dispatch-read-failure-occupancy",
          {
            autonomy: "execute",
            trackerRequiredLabels: [],
            concurrencyGlobal: 10_000,
          },
        );
        yield* workItems.upsert({
          id: activeId,
          mode: "symphony",
          projectId: SymphonyProjectId.make("dispatch-read-failure-occupancy-active-project"),
          objective: "Unreadable active item",
          acceptanceCriteria: [],
          source: { kind: "manual" },
          workflowId,
          lifecycle: "running",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        yield* workItems.upsert({
          id: workItemId,
          mode: "symphony",
          projectId: SymphonyProjectId.make("dispatch-read-failure-occupancy-target-project"),
          objective: "Occupancy read failure target",
          acceptanceCriteria: [],
          source: { kind: "manual" },
          trackerIssueId: "1",
          workflowId,
          lifecycle: "queued",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        yield* sql`UPDATE symphony_work_items SET acceptance_criteria_json = 'not json' WHERE id = ${activeId}`;

        const result = yield* Effect.result(orchestrator.dispatchWorkItem(String(workItemId))).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* sql`DELETE FROM symphony_work_items WHERE id IN (${workItemId}, ${activeId})`.pipe(
                Effect.ignore,
              );
              yield* sql`DELETE FROM symphony_workflows WHERE id = ${workflowId}`.pipe(
                Effect.ignore,
              );
            }),
          ),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag).toMatch(/^SymphonyPersistence/);
        }
      }),
  );

  it.effect("requestChanges moves a review-ready item to changes_requested", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItemId = WorkItemId.make("review-1");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Review target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "review-1",
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const changed = yield* orchestrator.requestChanges("review-1", "fix the tests");
      expect(changed).toBe(true);
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("changes_requested");
    }),
  );

  it.effect("requestChanges refuses items that are not review-ready", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItemId = WorkItemId.make("review-2");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Not ready",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "review-2",
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });

      const changed = yield* orchestrator.requestChanges("review-2");
      expect(changed).toBe(false);
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("queued");
    }),
  );

  it.effect("approveMerge requires positive host-enriched evidence (FR-095)", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItemId = WorkItemId.make("merge-1");
      const workItems = yield* WorkItemRepository;
      // The fresh host query needs the workflow's effective config.
      yield* seedWorkflow("wf-merge-1", "/repo/merge");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-merge-1"),
        repositoryPath: "/repo/merge",
        workflowPath: "/repo/merge/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: { ...makeConfig("/repo/merge"), autonomy: "execute" },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const evidence = {
        changedFiles: [],
        testsChanged: [],
        commits: [],
        validationResults: [],
        assumptions: [],
        risks: [],
        unresolved: [],
        artefacts: [],
        pullRequest: {
          number: 1,
          title: "t",
          branch: "b",
          baseBranch: "m",
          url: "https://github.com/owner/repo/pull/1",
          status: "open",
          ciStatus: "success",
          reviewState: "approved",
          mergeable: "mergeable",
          unresolvedComments: 0,
        },
        modelReview: null,
        overallAssessment: "ready_for_review",
        createdAt: "2026-08-05T00:00:00.000Z",
      } as const;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Merge target",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "merge-1",
        workflowId: WorkflowId.make("wf-merge-1"),
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        workspaceKey: "issue-merge-1",
        baseBranch: "main",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const evidenceRepo = yield* EvidenceRepository;
      yield* evidenceRepo.upsert(workItemId, evidence);

      yield* setPullRequestRefresh({
        number: 1,
        title: "t",
        branch: "b",
        baseBranch: "m",
        status: "open",
        ciStatus: "success",
        reviewState: "approved",
        mergeable: "mergeable",
      });
      const unknownComments = yield* orchestrator.approveMerge("merge-1");
      expect(unknownComments).toBe(false);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_for_review");

      yield* setPullRequestRefresh({
        number: 1,
        title: "t",
        branch: "b",
        baseBranch: "m",
        status: "open",
        ciStatus: "success",
        reviewState: "approved",
        mergeable: "mergeable",
        unresolvedComments: 0,
      });
      const merged = yield* orchestrator.approveMerge("merge-1");
      expect(merged).toBe(true);
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("ready_to_merge");
    }),
  );

  it.effect(
    "approveMerge falls back to the stored PR evidence base branch for an item with none recorded",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        const workItemId = WorkItemId.make("merge-legacy-1");
        const workItems = yield* WorkItemRepository;
        yield* seedWorkflow("wf-merge-legacy-1", "/repo/merge-legacy");
        const workflows = yield* WorkflowRepository;
        yield* workflows.upsert({
          id: WorkflowId.make("wf-merge-legacy-1"),
          repositoryPath: "/repo/merge-legacy",
          workflowPath: "/repo/merge-legacy/WORKFLOW.md",
          status: "active",
          autonomy: "execute",
          validationError: null,
          definition: { config: {}, promptTemplate: "Implement." },
          effectiveConfig: { ...makeConfig("/repo/merge-legacy"), autonomy: "execute" },
          enabledAt: "2026-08-05T00:00:00.000Z",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        const evidence = {
          changedFiles: [],
          testsChanged: [],
          commits: [],
          validationResults: [],
          assumptions: [],
          risks: [],
          unresolved: [],
          artefacts: [],
          pullRequest: {
            number: 1,
            title: "t",
            branch: "b",
            baseBranch: "m",
            url: "https://github.com/owner/repo/pull/1",
            status: "open",
            ciStatus: "success",
            reviewState: "approved",
            mergeable: "mergeable",
            unresolvedComments: 0,
          },
          modelReview: null,
          overallAssessment: "ready_for_review",
          createdAt: "2026-08-05T00:00:00.000Z",
        } as const;
        yield* workItems.upsert({
          id: workItemId,
          mode: "symphony",
          projectId: SymphonyProjectId.make("merge-legacy-project"),
          objective: "Legacy merge target",
          acceptanceCriteria: [],
          source: { kind: "manual" },
          trackerIssueId: "merge-legacy-1",
          workflowId: WorkflowId.make("wf-merge-legacy-1"),
          lifecycle: "ready_for_review",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          workspaceKey: "issue-merge-legacy-1",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        const evidenceRepo = yield* EvidenceRepository;
        yield* evidenceRepo.upsert(workItemId, evidence);

        yield* setPullRequestRefresh({
          number: 1,
          title: "t",
          branch: "b",
          baseBranch: "m",
          status: "open",
          ciStatus: "success",
          reviewState: "approved",
          mergeable: "mergeable",
          unresolvedComments: 0,
        });
        const merged = yield* orchestrator.approveMerge("merge-legacy-1");
        expect(merged).toBe(true);
        expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      }),
  );

  it.effect(
    "approveMerge refuses when neither the item nor the evidence records a base branch",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        const workItemId = WorkItemId.make("merge-legacy-2");
        const workItems = yield* WorkItemRepository;
        yield* seedWorkflow("wf-merge-legacy-2", "/repo/merge-legacy-2");
        const workflows = yield* WorkflowRepository;
        yield* workflows.upsert({
          id: WorkflowId.make("wf-merge-legacy-2"),
          repositoryPath: "/repo/merge-legacy-2",
          workflowPath: "/repo/merge-legacy-2/WORKFLOW.md",
          status: "active",
          autonomy: "execute",
          validationError: null,
          definition: { config: {}, promptTemplate: "Implement." },
          effectiveConfig: { ...makeConfig("/repo/merge-legacy-2"), autonomy: "execute" },
          enabledAt: "2026-08-05T00:00:00.000Z",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        const evidence = {
          changedFiles: [],
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
        } as const;
        yield* workItems.upsert({
          id: workItemId,
          mode: "symphony",
          projectId: SymphonyProjectId.make("merge-legacy-project"),
          objective: "Legacy merge target without base",
          acceptanceCriteria: [],
          source: { kind: "manual" },
          trackerIssueId: "merge-legacy-2",
          workflowId: WorkflowId.make("wf-merge-legacy-2"),
          lifecycle: "ready_for_review",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          workspaceKey: "issue-merge-legacy-2",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        });
        const evidenceRepo = yield* EvidenceRepository;
        yield* evidenceRepo.upsert(workItemId, evidence);

        yield* setPullRequestRefresh({
          number: 1,
          title: "t",
          branch: "b",
          baseBranch: "m",
          status: "open",
          ciStatus: "success",
          reviewState: "approved",
          mergeable: "mergeable",
          unresolvedComments: 0,
        });
        expect(yield* orchestrator.approveMerge("merge-legacy-2")).toBe(false);
      }),
  );

  it.effect("approveMerge refuses a PR without host enrichment (FR-095)", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItemId = WorkItemId.make("merge-3");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Merge target 3",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "merge-3",
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        workspaceKey: "issue-merge-3",
        baseBranch: "main",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      // No stored evidence at all: the assessment gate cannot pass, so the
      // item stays at ready_for_review even though the fresh host refresh
      // would return an enriched PR.
      const merged = yield* orchestrator.approveMerge("merge-3");
      expect(merged).toBe(false);
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("ready_for_review");
    }),
  );

  it.effect("approveMerge refuses when there is no PR at all", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItemId = WorkItemId.make("merge-4");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Merge target 4",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "merge-4",
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        workspaceKey: "issue-merge-4",
        baseBranch: "main",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      // No workspace identity: the fresh host query cannot be issued, so the
      // gate refuses (stored PR evidence is not enough).
      const merged = yield* orchestrator.approveMerge("merge-4");
      expect(merged).toBe(false);
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("ready_for_review");
    }),
  );

  it.effect("approveMerge refuses items with failed evidence", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItemId = WorkItemId.make("merge-2");
      const workItems = yield* WorkItemRepository;
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Broken",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "merge-2",
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        workspaceKey: "issue-merge-2",
        baseBranch: "main",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const evidenceRepo = yield* EvidenceRepository;
      yield* evidenceRepo.upsert(workItemId, {
        changedFiles: [],
        testsChanged: [],
        commits: [],
        validationResults: [{ command: "npm test", status: "failed" }],
        assumptions: [],
        risks: [],
        unresolved: [],
        artefacts: [],
        pullRequest: null,
        modelReview: null,
        overallAssessment: "failed",
        createdAt: "2026-08-05T00:00:00.000Z",
      });

      const merged = yield* orchestrator.approveMerge("merge-2");
      expect(merged).toBe(false);
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("ready_for_review");
    }),
  );

  it.effect("approveMerge refuses when the fresh host query comes back unenriched", () =>
    Effect.gen(function* () {
      // Stored evidence is fully enriched (a stale happy record), but the
      // fresh refresh returns a PR without reviewState: the gate must refuse
      // (fix-lane item 8 — the gate reads the FRESH query, not the stored
      // record).
      const orchestrator = yield* SymphonyOrchestrator;
      const workItemId = WorkItemId.make("merge-5");
      const workItems = yield* WorkItemRepository;
      yield* seedWorkflow("wf-merge-5", "/repo/merge-5");
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make("wf-merge-5"),
        repositoryPath: "/repo/merge-5",
        workflowPath: "/repo/merge-5/WORKFLOW.md",
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: { ...makeConfig("/repo/merge-5"), autonomy: "execute" },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Merge target 5",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "merge-5",
        workflowId: WorkflowId.make("wf-merge-5"),
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        workspaceKey: "issue-merge-5",
        baseBranch: "main",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const evidenceRepo = yield* EvidenceRepository;
      yield* evidenceRepo.upsert(workItemId, {
        changedFiles: [],
        testsChanged: [],
        commits: [],
        validationResults: [],
        assumptions: [],
        risks: [],
        unresolved: [],
        artefacts: [],
        pullRequest: {
          number: 1,
          title: "t",
          branch: "b",
          baseBranch: "m",
          url: "https://github.com/owner/repo/pull/1",
          status: "open",
          ciStatus: "success",
          reviewState: "approved",
          mergeable: "mergeable",
          unresolvedComments: 0,
        },
        modelReview: null,
        overallAssessment: "ready_for_review",
        createdAt: "2026-08-05T00:00:00.000Z",
      });

      // The fresh host query returns a PR with no reviewState: refuse.
      yield* setPullRequestRefresh({
        number: 1,
        title: "t",
        branch: "b",
        baseBranch: "m",
        status: "open",
        ciStatus: "success",
      });

      const merged = yield* orchestrator.approveMerge("merge-5");
      expect(merged).toBe(false);
      const after = yield* workItems.getById(workItemId);
      expect(after?.lifecycle).toBe("ready_for_review");
    }),
  );

  // FR-102-104: automatic review-comment ingestion into a continuation turn.
  const seedReviewItem = (input: {
    readonly workItemId: string;
    readonly workflowId: string;
    readonly repositoryPath: string;
    readonly storedPullRequest: PullRequestEvidence;
    // A distinct WorkSource kind per item (plan detail, not product logic):
    // omitting trackerIssueId stores an empty tracker_issue_id, and the
    // work-item table's uniqueness is (tracker_kind, tracker_issue_id) —
    // sharing "manual" across every item in this suite with no
    // trackerIssueId would collide on that empty-string pair with the
    // existing "global pause" test fixture.
    readonly sourceKind: "linear" | "jira" | "azure_boards";
  }) =>
    Effect.gen(function* () {
      yield* seedWorkflow(input.workflowId, input.repositoryPath);
      const workflows = yield* WorkflowRepository;
      yield* workflows.upsert({
        id: WorkflowId.make(input.workflowId),
        repositoryPath: input.repositoryPath,
        workflowPath: `${input.repositoryPath}/WORKFLOW.md`,
        status: "active",
        autonomy: "execute",
        validationError: null,
        definition: { config: {}, promptTemplate: "Implement." },
        effectiveConfig: { ...makeConfig(input.repositoryPath), autonomy: "execute" },
        enabledAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make(input.workItemId);
      // No trackerIssueId: the fallback path in refreshIssueSnapshot always
      // succeeds without a tracker round-trip (mirrors the existing
      // "global pause" test's item shape).
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Review feedback target",
        acceptanceCriteria: [],
        source: { kind: input.sourceKind, externalId: "", externalUrl: "" },
        workflowId: WorkflowId.make(input.workflowId),
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        workspaceKey: `issue-${input.workItemId}`,
        baseBranch: "main",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const evidenceRepo = yield* EvidenceRepository;
      yield* evidenceRepo.upsert(workItemId, {
        changedFiles: [],
        testsChanged: [],
        commits: [],
        validationResults: [],
        assumptions: [],
        risks: [],
        unresolved: [],
        artefacts: [],
        pullRequest: input.storedPullRequest,
        modelReview: null,
        overallAssessment: "ready_for_review",
        createdAt: "2026-08-05T00:00:00.000Z",
      });
      return workItemId;
    });

  it.effect(
    "refreshPullRequest requeues on new review feedback and the continuation prompt carries it",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        const workItems = yield* WorkItemRepository;
        const workItemId = yield* seedReviewItem({
          workItemId: "review-fr-1",
          workflowId: "wf-review-fr-1",
          repositoryPath: "/repo/review-fr-1",
          sourceKind: "linear",
          storedPullRequest: {
            number: 7,
            title: "t",
            branch: "symphony/review-fr-1",
            url: "https://github.com/owner/repo/pull/7",
            baseBranch: "main",
            status: "open",
            ciStatus: "success",
            reviewState: "approved",
            mergeable: "mergeable",
            unresolvedComments: 0,
          },
        });

        // Fresh host query: the reviewer requested changes with 2 unresolved
        // comments — new signal versus the stored snapshot above.
        yield* setPullRequestRefresh({
          number: 7,
          title: "t",
          branch: "symphony/review-fr-1",
          baseBranch: "main",
          status: "open",
          ciStatus: "failure",
          reviewState: "changes_requested",
          mergeable: "mergeable",
          unresolvedComments: 2,
          latestCommit: "deadbeef",
        });
        yield* setPullRequestComments([
          { body: "Please add a null check here.", author: "reviewer1" },
          { body: "This function needs a test." },
        ]);

        const refreshed = yield* orchestrator.refreshPullRequest("review-fr-1");
        expect(refreshed).toBe(true);

        // Transitioned out of ready_for_review (existing changes_requested
        // path) instead of staying parked.
        const afterRefresh = yield* workItems.getById(workItemId);
        expect(afterRefresh?.lifecycle).toBe("changes_requested");

        dispatchedIds.length = 0;
        dispatchedInputs.length = 0;
        yield* orchestrator.dispatchWorkItem("review-fr-1");
        yield* awaitDispatched("review-fr-1");

        // Claimable again: dispatchWorkItem's existing changes_requested ->
        // queued requeue let the mock dispatcher claim it straight through
        // to preparing.
        const afterDispatch = yield* workItems.getById(workItemId);
        expect(afterDispatch?.lifecycle).toBe("preparing");
        expect(dispatchedIds).toContain("review-fr-1");

        const captured = dispatchedInputs.find((entry) => entry.workItemId === "review-fr-1");
        const reviewFeedback = captured?.reviewFeedback;
        expect(reviewFeedback).toBeDefined();
        expect(reviewFeedback?.unresolvedCommentCount).toBe(2);
        expect(reviewFeedback?.reviewState).toBe("changes_requested");
        expect(reviewFeedback?.latestCommit).toBe("deadbeef");
        expect(reviewFeedback?.comments?.length).toBe(2);

        // The built prompt (the REAL Prompt.ts builder, not a re-implementation)
        // carries the review context and the existing-branch/workspace
        // instruction.
        const prompt = buildRunPrompt({
          issue: makeIssue("review-fr-1"),
          config: makeConfig("/repo/review-fr-1"),
          branch: "symphony/review-fr-1",
          reviewFeedback: reviewFeedback as ReviewFeedbackContext,
        });
        expect(prompt).toContain("Review state: changes_requested");
        expect(prompt).toContain("Unresolved comments: 2");
        expect(prompt).toContain("deadbeef");
        expect(prompt).toContain("Please add a null check here.");
        expect(prompt).toContain("EXISTING branch symphony/review-fr-1");
        expect(prompt).toContain("EXISTING workspace");
      }),
  );

  it.effect(
    "refreshPullRequest degrades honestly to counts-only when comment bodies are unavailable",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        yield* seedReviewItem({
          workItemId: "review-fr-2",
          workflowId: "wf-review-fr-2",
          repositoryPath: "/repo/review-fr-2",
          sourceKind: "jira",
          storedPullRequest: {
            number: 8,
            title: "t",
            branch: "symphony/review-fr-2",
            url: "https://github.com/owner/repo/pull/8",
            baseBranch: "main",
            status: "open",
            ciStatus: "success",
            reviewState: "approved",
            mergeable: "mergeable",
            unresolvedComments: 0,
          },
        });

        yield* setPullRequestRefresh({
          number: 8,
          title: "t",
          branch: "symphony/review-fr-2",
          baseBranch: "main",
          status: "open",
          ciStatus: "success",
          reviewState: "review_required",
          mergeable: "mergeable",
          unresolvedComments: 1,
        });
        // Explicit: no comment-body enrichment (non-GitHub host, or the
        // GitHub fetch failed) — counts-only is the only honest answer.
        yield* setPullRequestComments(null);

        yield* orchestrator.refreshPullRequest("review-fr-2");

        dispatchedIds.length = 0;
        dispatchedInputs.length = 0;
        yield* orchestrator.dispatchWorkItem("review-fr-2");
        yield* awaitDispatched("review-fr-2");

        const captured = dispatchedInputs.find((entry) => entry.workItemId === "review-fr-2");
        const reviewFeedback = captured?.reviewFeedback;
        expect(reviewFeedback).toBeDefined();
        expect(reviewFeedback?.unresolvedCommentCount).toBe(1);
        expect(reviewFeedback?.comments).toBeUndefined();

        const prompt = buildRunPrompt({
          issue: makeIssue("review-fr-2"),
          config: makeConfig("/repo/review-fr-2"),
          reviewFeedback: reviewFeedback as ReviewFeedbackContext,
        });
        expect(prompt).toContain("Unresolved comments: 1");
        expect(prompt).toContain(
          "Comment bodies are not available for this host; only the counts above are known.",
        );
      }),
  );

  it.effect(
    "refreshPullRequest never re-dispatches when repeated refreshes carry no new signal (idempotency)",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        const workItems = yield* WorkItemRepository;
        // Stored snapshot ALREADY shows changes_requested with 2 unresolved
        // comments — the item sits at ready_for_review anyway (set up
        // directly, as the other lifecycle tests in this file do), so this
        // exercises the delta-vs-snapshot comparison itself rather than only
        // the transition's `from` guard.
        const workItemId = yield* seedReviewItem({
          workItemId: "review-fr-3",
          workflowId: "wf-review-fr-3",
          repositoryPath: "/repo/review-fr-3",
          sourceKind: "azure_boards",
          storedPullRequest: {
            number: 9,
            title: "t",
            branch: "symphony/review-fr-3",
            url: "https://github.com/owner/repo/pull/9",
            baseBranch: "main",
            status: "open",
            ciStatus: "failure",
            reviewState: "changes_requested",
            mergeable: "mergeable",
            unresolvedComments: 2,
          },
        });

        // Fresh host query returns the EXACT SAME reviewState/count: no new
        // signal versus the stored snapshot.
        yield* setPullRequestRefresh({
          number: 9,
          title: "t",
          branch: "symphony/review-fr-3",
          baseBranch: "main",
          status: "open",
          ciStatus: "failure",
          reviewState: "changes_requested",
          mergeable: "mergeable",
          unresolvedComments: 2,
        });

        dispatchedIds.length = 0;
        yield* orchestrator.refreshPullRequest("review-fr-3");
        let after = yield* workItems.getById(workItemId);
        expect(after?.lifecycle).toBe("ready_for_review");

        // Repeat several more times: still nothing new, so still no
        // transition and no dispatch — the dangerous re-dispatch-loop case.
        yield* orchestrator.refreshPullRequest("review-fr-3");
        yield* orchestrator.refreshPullRequest("review-fr-3");
        after = yield* workItems.getById(workItemId);
        expect(after?.lifecycle).toBe("ready_for_review");
        expect(dispatchedIds).toEqual([]);
      }),
  );

  // B-9: `approveMerge` parks an item at ready_to_merge and nothing ever looks
  // at the host again, so nothing wrote `completed`. These tests drive the
  // merge detector through the same refreshPullRequest path a person and the
  // scheduler both use.
  it.effect("refreshPullRequest completes the tracked pull request's item when it merged", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runEvents = yield* RunEventRepository;
      const evidenceRepository = yield* EvidenceRepository;
      const { workItemId, runAttemptId } = yield* seedMergeDetectionItem({
        workItemId: "merge-9",
        workflowId: "wf-merge-9",
        repositoryPath: "/repo/merge-9",
        workspaceKey: "issue-merge-9",
        baseBranch: "main",
      });

      yield* setPullRequestRefresh({
        number: 42,
        title: "t",
        branch: "symphony/issue-merge-9",
        baseBranch: "main",
        status: "merged",
      });

      expect(yield* orchestrator.refreshPullRequest("merge-9")).toBe(true);
      // The host was asked about the stored PR, not merely about the head branch.
      expect(pullRequestRefreshInputs.at(-1)).toMatchObject({
        branch: "symphony/issue-merge-9",
        baseBranch: "main",
        pullRequestNumber: 42,
      });
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("completed");
      expect((yield* evidenceRepository.getByWorkItem(workItemId))?.pullRequest?.number).toBe(42);

      const mergedEvents = runEvents
        .listForAttempt(runAttemptId)
        .pipe(
          Effect.map((events) =>
            events.filter((event) => event.eventType === "pull_request_merged"),
          ),
        );
      const first = yield* mergedEvents;
      expect(first).toHaveLength(1);
      expect(first[0]?.payload).toMatchObject({ workItemId: "merge-9", number: 42 });

      // Idempotent: the transition's `from` guard makes a second merged
      // observation a no-op, so the event is written once.
      expect(yield* orchestrator.refreshPullRequest("merge-9")).toBe(true);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("completed");
      expect(yield* mergedEvents).toHaveLength(1);
    }),
  );

  it.effect("a merged PR on a distinct authority never completes the item", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const evidenceRepository = yield* EvidenceRepository;
      const branch = "symphony/issue-merge-authority-1";
      const storedUrl = "https://git.example/owner/repo/pull/42";
      const { workItemId } = yield* seedMergeDetectionItem({
        workItemId: "merge-authority-1",
        workflowId: "wf-merge-authority-1",
        repositoryPath: "/repo/merge-authority-1",
        workspaceKey: "issue-merge-authority-1",
        baseBranch: "main",
        storedPullRequest: { ...openPullRequest(42, branch), url: storedUrl },
      });

      // The checkout now resolves to a different installation (`www.` is not an
      // alias for self-hosted hosts) whose PR #42 is merged.
      yield* setPullRequestRefresh({
        number: 42,
        title: "t",
        branch,
        baseBranch: "main",
        status: "merged",
        url: "https://www.git.example/owner/repo/pull/42",
      });

      expect(yield* orchestrator.refreshPullRequest("merge-authority-1")).toBe(false);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      expect((yield* evidenceRepository.getByWorkItem(workItemId))?.pullRequest?.url).toBe(
        storedUrl,
      );
    }),
  );

  it.effect("a ready_to_merge item without a tracked repository identity is never completed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const evidenceRepository = yield* EvidenceRepository;
      const branch = "symphony/issue-merge-no-identity-1";
      // Evidence written before the URL was recorded: the number is known, the
      // repository is not. Missing identity is unresolved, never "any repo".
      const { workItemId } = yield* seedMergeDetectionItem({
        workItemId: "merge-no-identity-1",
        workflowId: "wf-merge-no-identity-1",
        repositoryPath: "/repo/merge-no-identity-1",
        workspaceKey: "issue-merge-no-identity-1",
        baseBranch: "main",
        storedPullRequest: {
          number: 42,
          title: "t",
          branch,
          baseBranch: "main",
          status: "open",
          ciStatus: "success",
          reviewState: "approved",
          mergeable: "mergeable",
          unresolvedComments: 0,
        },
      });
      yield* setPullRequestRefresh({
        number: 42,
        title: "t",
        branch,
        baseBranch: "main",
        status: "merged",
      });
      const before = pullRequestRefreshInputs.filter((entry) => entry.branch === branch).length;

      expect(yield* orchestrator.refreshPullRequest("merge-no-identity-1")).toBe(false);
      // Refused before the host was asked: the missing identity is not replaced.
      expect(pullRequestRefreshInputs.filter((entry) => entry.branch === branch)).toHaveLength(
        before,
      );
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      expect(
        (yield* evidenceRepository.getByWorkItem(workItemId))?.pullRequest?.url,
      ).toBeUndefined();
    }),
  );

  it.effect("approveMerge refuses a tracked PR with an unresolved repository identity", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const workItemId = WorkItemId.make("merge-no-identity-approval-1");
      yield* seedWorkflow("wf-merge-no-identity-2", "/repo/merge-no-identity-2", {
        autonomy: "execute",
      });
      yield* workItems.upsert({
        id: workItemId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Merge target without repository identity",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "merge-no-identity-approval-1",
        workflowId: WorkflowId.make("wf-merge-no-identity-2"),
        lifecycle: "ready_for_review",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        workspaceKey: "issue-merge-no-identity-2",
        baseBranch: "main",
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      });
      const evidenceRepository = yield* EvidenceRepository;
      yield* evidenceRepository.upsert(workItemId, {
        changedFiles: [],
        testsChanged: [],
        commits: [],
        validationResults: [],
        assumptions: [],
        risks: [],
        unresolved: [],
        artefacts: [],
        // Number known, repository unknown.
        pullRequest: {
          number: 1,
          title: "t",
          branch: "b",
          baseBranch: "m",
          status: "open",
          ciStatus: "success",
          reviewState: "approved",
          mergeable: "mergeable",
          unresolvedComments: 0,
        },
        modelReview: null,
        overallAssessment: "ready_for_review",
        createdAt: "2026-08-05T00:00:00.000Z",
      });
      yield* setPullRequestRefresh({
        number: 1,
        title: "t",
        branch: "b",
        baseBranch: "m",
        status: "open",
        ciStatus: "success",
        reviewState: "approved",
        mergeable: "mergeable",
        unresolvedComments: 0,
      });

      expect(yield* orchestrator.approveMerge("merge-no-identity-approval-1")).toBe(false);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_for_review");
    }),
  );

  it.effect("a merged PR with the same number in another repository never completes the item", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const evidenceRepository = yield* EvidenceRepository;
      const branch = "symphony/issue-merge-repo-1";
      const { workItemId } = yield* seedMergeDetectionItem({
        workItemId: "merge-repo-1",
        workflowId: "wf-merge-repo-1",
        repositoryPath: "/repo/merge-repo-1",
        workspaceKey: "issue-merge-repo-1",
        baseBranch: "main",
        storedPullRequest: {
          ...openPullRequest(42, branch),
          url: "https://github.com/owner/a/pull/42",
        },
      });

      // The checkout now resolves to repository B, which also has a PR #42 that
      // is already merged. Equal numbers are not the same PR.
      yield* setPullRequestRefresh({
        number: 42,
        title: "t",
        branch,
        baseBranch: "main",
        status: "merged",
        url: "https://github.com/owner/b/pull/42",
      });
      expect(yield* orchestrator.refreshPullRequest("merge-repo-1")).toBe(false);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      expect((yield* evidenceRepository.getByWorkItem(workItemId))?.pullRequest?.url).toBe(
        "https://github.com/owner/a/pull/42",
      );
      expect(pullRequestRefreshInputs.at(-1)).toMatchObject({
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/owner/a/pull/42",
      });

      // The tracked repository's PR merging is the evidence that closes it.
      yield* setPullRequestRefresh({
        number: 42,
        title: "t",
        branch,
        baseBranch: "main",
        status: "merged",
        url: "https://github.com/owner/a/pull/42",
      });
      expect(yield* orchestrator.refreshPullRequest("merge-repo-1")).toBe(true);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("completed");
    }),
  );

  it.effect("a merged pull request with a different number never completes the item", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runEvents = yield* RunEventRepository;
      const evidenceRepository = yield* EvidenceRepository;
      const { workItemId, runAttemptId } = yield* seedMergeDetectionItem({
        workItemId: "merge-13",
        workflowId: "wf-merge-13",
        repositoryPath: "/repo/merge-13",
        workspaceKey: "issue-merge-13",
        baseBranch: "main",
        storedPullRequest: openPullRequest(45, "symphony/issue-merge-13"),
      });

      // Another PR on the same head branch, targeting another base, was merged.
      yield* setPullRequestRefresh({
        number: 44,
        title: "t",
        branch: "symphony/issue-merge-13",
        baseBranch: "release",
        status: "merged",
      });
      expect(yield* orchestrator.refreshPullRequest("merge-13")).toBe(false);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      // The tracked evidence is not overwritten with the wrong PR.
      expect((yield* evidenceRepository.getByWorkItem(workItemId))?.pullRequest?.number).toBe(45);
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.some((event) => event.eventType === "pull_request_merged")).toBe(false);

      // The tracked PR itself merging is the evidence that closes it.
      yield* setPullRequestRefresh({
        number: 45,
        title: "t",
        branch: "symphony/issue-merge-13",
        baseBranch: "main",
        status: "merged",
      });
      expect(yield* orchestrator.refreshPullRequest("merge-13")).toBe(true);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("completed");
    }),
  );

  it.effect("a closed unmerged PR leaves the item in ready_to_merge and records one event", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runEvents = yield* RunEventRepository;
      const { workItemId, runAttemptId } = yield* seedMergeDetectionItem({
        workItemId: "merge-10",
        workflowId: "wf-merge-10",
        repositoryPath: "/repo/merge-10",
        workspaceKey: "issue-merge-10",
        baseBranch: "main",
        storedPullRequest: openPullRequest(43, "symphony/issue-merge-10"),
      });

      yield* setPullRequestRefresh({
        number: 43,
        title: "t",
        branch: "symphony/issue-merge-10",
        baseBranch: "main",
        status: "closed",
      });

      expect(yield* orchestrator.refreshPullRequest("merge-10")).toBe(true);
      // Closed without merging is not completion and not failure: Symphony
      // records what it observed and leaves the lifecycle alone.
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");

      const closedEvents = runEvents
        .listForAttempt(runAttemptId)
        .pipe(
          Effect.map((events) =>
            events.filter((event) => event.eventType === "pull_request_closed_unmerged"),
          ),
        );
      expect(yield* closedEvents).toHaveLength(1);

      // The stored snapshot now says closed, so a repeat observation does not
      // append a second event.
      yield* orchestrator.refreshPullRequest("merge-10");
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      expect(yield* closedEvents).toHaveLength(1);
    }),
  );

  it.effect("overlapping closed-PR refreshes record the observation once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runEvents = yield* RunEventRepository;
      const { workItemId, runAttemptId } = yield* seedMergeDetectionItem({
        workItemId: "merge-14",
        workflowId: "wf-merge-14",
        repositoryPath: "/repo/merge-14",
        workspaceKey: "issue-merge-14",
        baseBranch: "main",
        storedPullRequest: openPullRequest(47, "symphony/issue-merge-14"),
      });
      yield* setPullRequestRefresh({
        number: 47,
        title: "t",
        branch: "symphony/issue-merge-14",
        baseBranch: "main",
        status: "closed",
      });

      // A scheduled sweep and a manual refresh can both read the stored `open`
      // snapshot and observe the close; the event log must still show one
      // observation.
      yield* Effect.all(
        [orchestrator.refreshPullRequest("merge-14"), orchestrator.refreshPullRequest("merge-14")],
        { concurrency: "unbounded" },
      );

      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      const closedEvents = (yield* runEvents.listForAttempt(runAttemptId)).filter(
        (event) => event.eventType === "pull_request_closed_unmerged",
      );
      expect(closedEvents).toHaveLength(1);
    }),
  );

  it.effect("refreshPullRequest pins the tracked PR number and resolves the base branch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedMergeDetectionItem({
        workItemId: "merge-11",
        workflowId: "wf-merge-11",
        repositoryPath: "/repo/merge-11",
        workspaceKey: "issue-merge-11",
        storedPullRequest: openPullRequest(44, "symphony/issue-merge-11"),
      });
      yield* setPullRequestRefresh({
        number: 44,
        title: "t",
        branch: "symphony/issue-merge-11",
        baseBranch: "main",
        status: "open",
      });

      expect(yield* orchestrator.refreshPullRequest("merge-11")).toBe(true);
      // The item records neither branch field: both come from the stored PR and
      // the number is what identifies it.
      expect(pullRequestRefreshInputs.at(-1)).toMatchObject({
        branch: "symphony/issue-merge-11",
        baseBranch: "main",
        pullRequestNumber: 44,
      });
    }),
  );

  it.effect(
    "refreshPullRequest asks the host for the stored PR identity when the item records none",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* SymphonyOrchestrator;
        // Neither a workspace key nor a base branch on the item: the stored PR
        // evidence is the only record of both, and refusing to refresh would
        // strand a merge-ready item forever.
        yield* seedMergeDetectionItem({
          workItemId: "merge-12",
          workflowId: "wf-merge-12",
          repositoryPath: "/repo/merge-12",
          storedPullRequest: openPullRequest(45, "symphony/issue-merge-12", "develop"),
        });
        yield* setPullRequestRefresh({
          number: 45,
          title: "t",
          branch: "symphony/issue-merge-12",
          baseBranch: "develop",
          status: "open",
        });

        expect(yield* orchestrator.refreshPullRequest("merge-12")).toBe(true);
        expect(pullRequestRefreshInputs.at(-1)).toMatchObject({
          branch: "symphony/issue-merge-12",
          baseBranch: "develop",
          pullRequestNumber: 45,
        });
      }),
  );

  it.effect("the scheduler completes merged PRs on its own", () =>
    Effect.gen(function* () {
      const workItems = yield* WorkItemRepository;
      const { workItemId } = yield* seedMergeDetectionItem({
        workItemId: "merge-sweep-1",
        workflowId: "wf-merge-sweep-1",
        repositoryPath: "/repo/merge-sweep-1",
        workspaceKey: "issue-merge-sweep-1",
        baseBranch: "main",
        storedPullRequest: openPullRequest(46, "symphony/issue-merge-sweep-1"),
      });
      yield* setPullRequestRefresh({
        number: 46,
        title: "t",
        branch: "symphony/issue-merge-sweep-1",
        baseBranch: "main",
        status: "merged",
      });

      // The sweep follows the workflow's own poll interval instead of hitting
      // the host from the 5-second scan. The shared suite database makes each
      // tick walk every active workflow, so tick until the item settles (the
      // same pattern as the dispatch-cadence tests) instead of trusting one
      // scan.
      let lifecycle = (yield* workItems.getById(workItemId))?.lifecycle ?? "ready_to_merge";
      for (let tick = 0; tick < 40 && lifecycle !== "completed"; tick += 1) {
        yield* TestClock.adjust("5 seconds");
        yield* settle;
        lifecycle = (yield* workItems.getById(workItemId))?.lifecycle ?? "ready_to_merge";
      }
      expect(lifecycle).toBe("completed");
    }),
  );

  it.effect("the sweep backs off after observing a closed pull request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const runEvents = yield* RunEventRepository;
      const branch = "symphony/issue-merge-closed-sweep-1";
      const { workItemId, runAttemptId } = yield* seedMergeDetectionItem({
        workItemId: "merge-closed-sweep-1",
        workflowId: "wf-merge-closed-sweep-1",
        repositoryPath: "/repo/merge-closed-sweep-1",
        workspaceKey: "issue-merge-closed-sweep-1",
        baseBranch: "main",
        storedPullRequest: openPullRequest(48, branch),
      });
      yield* setPullRequestRefresh({
        number: 48,
        title: "t",
        branch,
        baseBranch: "main",
        status: "closed",
      });
      const refreshCount = () =>
        Effect.sync(
          () => pullRequestRefreshInputs.filter((entry) => entry.branch === branch).length,
        );
      const closedEvents = () =>
        runEvents
          .listForAttempt(runAttemptId)
          .pipe(
            Effect.map(
              (events) =>
                events.filter((event) => event.eventType === "pull_request_closed_unmerged").length,
            ),
          );

      // First observation: closed is recorded once and the item stays parked.
      expect(yield* orchestrator.refreshPullRequest("merge-closed-sweep-1")).toBe(true);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      expect(yield* closedEvents()).toBe(1);
      yield* settle;
      const baseline = yield* refreshCount();

      // Inside the backoff window a scheduler scan must not hit the host again.
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      expect(yield* refreshCount()).toBe(baseline);
      expect(yield* closedEvents()).toBe(1);

      // Once the backoff elapses the sweep re-checks it (still closed here, so
      // the observation is not duplicated). The shared suite's maintenance pass
      // walks every active workflow, so allow several passes.
      let rechecked = yield* refreshCount();
      for (let pass = 0; pass < 10 && rechecked <= baseline; pass += 1) {
        yield* TestClock.adjust("61 seconds");
        yield* settle;
        rechecked = yield* refreshCount();
      }
      expect(rechecked).toBeGreaterThan(baseline);
      expect(yield* closedEvents()).toBe(1);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
    }),
  );

  it.effect("a closed pull request that reopens and is then merged is detected", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const branch = "symphony/issue-merge-reopen-1";
      const { workItemId } = yield* seedMergeDetectionItem({
        workItemId: "merge-reopen-1",
        workflowId: "wf-merge-reopen-1",
        repositoryPath: "/repo/merge-reopen-1",
        workspaceKey: "issue-merge-reopen-1",
        baseBranch: "main",
        storedPullRequest: openPullRequest(49, branch),
      });
      const refreshCount = () =>
        Effect.sync(
          () => pullRequestRefreshInputs.filter((entry) => entry.branch === branch).length,
        );

      yield* setPullRequestRefresh({
        number: 49,
        title: "t",
        branch,
        baseBranch: "main",
        status: "closed",
      });
      expect(yield* orchestrator.refreshPullRequest("merge-reopen-1")).toBe(true);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");
      const baseline = yield* refreshCount();

      // The host reopens the PR. Closed was only an observation, so the backoff
      // expires and the sweep sees the reopen; normal cadence resumes.
      yield* setPullRequestRefresh({
        number: 49,
        title: "t",
        branch,
        baseBranch: "main",
        status: "open",
      });
      let reopened = yield* refreshCount();
      for (let pass = 0; pass < 10 && reopened <= baseline; pass += 1) {
        yield* TestClock.adjust("61 seconds");
        yield* settle;
        reopened = yield* refreshCount();
      }
      expect(reopened).toBeGreaterThan(baseline);
      expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("ready_to_merge");

      // The next scans (normal 5 s cadence, no closed backoff left) detect the
      // merge and close the item. Tick until it settles: the shared suite's
      // scans can land a moment after the clock advance.
      yield* setPullRequestRefresh({
        number: 49,
        title: "t",
        branch,
        baseBranch: "main",
        status: "merged",
      });
      let merged = (yield* workItems.getById(workItemId))?.lifecycle ?? "ready_to_merge";
      for (let tick = 0; tick < 20 && merged !== "completed"; tick += 1) {
        yield* TestClock.adjust("5 seconds");
        yield* settle;
        merged = (yield* workItems.getById(workItemId))?.lifecycle ?? "ready_to_merge";
      }
      expect(merged).toBe("completed");
    }),
  );

  it.effect("a slow merge lookup does not delay the scheduling path", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const workItems = yield* WorkItemRepository;
      const approvals = yield* ApprovalService;
      const approvalRepository = yield* ApprovalRepository;
      const slowBranch = "symphony/issue-merge-slow-1";
      // Workflow A: one merge-ready item whose host lookup takes 10 s.
      yield* seedMergeDetectionItem({
        workItemId: "merge-slow-1",
        workflowId: "wf-merge-slow-1",
        repositoryPath: "/repo/merge-slow-1",
        workspaceKey: "issue-merge-slow-1",
        baseBranch: "main",
        storedPullRequest: openPullRequest(70, slowBranch),
      });
      slowPullRequestBranches.add(slowBranch);
      yield* setPullRequestRefresh({
        number: 70,
        title: "t",
        branch: slowBranch,
        baseBranch: "main",
        status: "open",
      });

      // Workflow B: a pending approval whose workflow timeout has already
      // elapsed. Its expiry is the scheduling path's housekeeping marker.
      yield* seedWorkflow("wf-merge-slow-2", "/repo/merge-slow-2", {
        autonomy: "execute",
        approvalsWaitTimeoutMs: 1_000,
      });
      const queuedId = WorkItemId.make("merge-slow-queued");
      yield* workItems.upsert({
        id: queuedId,
        mode: "symphony",
        projectId: TEST_PROJECT_ID,
        objective: "Queued while the merge lookup is slow",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: "merge-slow-queued",
        workflowId: WorkflowId.make("wf-merge-slow-2"),
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      });
      const request = yield* approvals.recordPending({
        id: "slow-sweep-approval",
        workItemId: queuedId,
        runAttemptId: RunAttemptId.make("run-merge-slow-1"),
        requestId: "slow-sweep-approval",
        action: "command_execution",
        scope: "once",
      });
      yield* TestClock.adjust("2 seconds");

      // Run one scheduling tick. With merge maintenance on the tick it would be
      // stuck in the 10 s lookup; on its own loop the tick completes and its
      // housekeeping expires the stale approval.
      const tick = yield* Effect.forkChild(orchestrator.refreshNow());
      for (let turn = 0; turn < 500 && tick.pollUnsafe() === undefined; turn += 1) {
        yield* Effect.yieldNow;
      }
      expect(tick.pollUnsafe()).toBeDefined();
      expect(pullRequestRefreshInputs.filter((entry) => entry.branch === slowBranch)).toHaveLength(
        0,
      );
      expect((yield* approvalRepository.getById(request.id))?.state).toBe("expired");

      // Release any slow lookup and stop the forked tick if the old blocking
      // behaviour ever returns, so this test cannot leak into the next one.
      yield* TestClock.adjust("11 seconds");
      yield* settle;
      yield* Fiber.interrupt(tick);
      slowPullRequestBranches.delete(slowBranch);
    }),
  );

  it.effect("the sweep rotates through more closed candidates than one page", () =>
    Effect.gen(function* () {
      const workItems = yield* WorkItemRepository;
      const evidenceRepository = yield* EvidenceRepository;
      const workflowId = "wf-merge-rotation-1";
      const repositoryPath = "/repo/merge-rotation-1";
      yield* seedWorkflow(workflowId, repositoryPath, { pollIntervalMs: 5_000 });

      // More closed candidates than a single repository page (and than the
      // sweep's page) so only rotation can reach the later merged item.
      const closedCount = 501;
      for (let index = 0; index < closedCount; index += 1) {
        const key = `merge-rotation-closed-${String(index).padStart(4, "0")}`;
        const closedId = WorkItemId.make(key);
        yield* workItems.upsert({
          id: closedId,
          mode: "symphony",
          projectId: TEST_PROJECT_ID,
          objective: `Closed candidate ${index}`,
          acceptanceCriteria: [],
          source: { kind: "manual" },
          trackerIssueId: key,
          workflowId: WorkflowId.make(workflowId),
          lifecycle: "ready_to_merge",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        });
        yield* evidenceRepository.upsert(closedId, {
          changedFiles: [],
          testsChanged: [],
          commits: [],
          validationResults: [],
          assumptions: [],
          risks: [],
          unresolved: [],
          artefacts: [],
          pullRequest: {
            number: 1_000 + index,
            title: "t",
            branch: `symphony/${key}`,
            baseBranch: "main",
            url: `https://github.com/owner/repo/pull/${1_000 + index}`,
            status: "closed",
          },
          modelReview: null,
          overallAssessment: "ready_for_review",
          createdAt: "2026-08-04T00:00:00.000Z",
        });
      }

      const branch = "symphony/issue-merge-rotation-target";
      const { workItemId } = yield* seedMergeDetectionItem({
        workItemId: "merge-rotation-target",
        workflowId,
        repositoryPath,
        workspaceKey: "issue-merge-rotation-target",
        baseBranch: "main",
        storedPullRequest: openPullRequest(49, branch),
      });
      yield* setPullRequestRefresh({
        number: 49,
        title: "t",
        branch,
        baseBranch: "main",
        status: "merged",
      });

      let lifecycle = (yield* workItems.getById(workItemId))?.lifecycle ?? "ready_to_merge";
      for (let tick = 0; tick < 20 && lifecycle !== "completed"; tick += 1) {
        yield* TestClock.adjust("5 seconds");
        yield* settle;
        lifecycle = (yield* workItems.getById(workItemId))?.lifecycle ?? "ready_to_merge";
      }
      expect(lifecycle).toBe("completed");
    }),
  );

  it.effect("listRuns reports completed for a completed item", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      const { runAttemptId } = yield* seedMergeDetectionItem({
        workItemId: "merge-completed-1",
        workflowId: "wf-merge-completed-1",
        repositoryPath: "/repo/merge-completed-1",
        lifecycle: "completed",
        workspaceKey: "issue-merge-completed-1",
        baseBranch: "main",
      });

      const runs = yield* orchestrator.listRuns({ limit: 200 });
      const summary = runs.find((run) => run.runAttemptId === runAttemptId);
      expect(summary?.lifecycle).toBe("completed");
    }),
  );
});

layer("SymphonyOrchestrator leadership", (it) => {
  const seedHeldRun = (id: string) =>
    Effect.gen(function* () {
      const workItems = yield* WorkItemRepository;
      const now = yield* nowIso;
      yield* workItems.upsert({
        id: WorkItemId.make(id),
        mode: "symphony",
        projectId: SymphonyProjectId.make("leadership-project"),
        objective: `Lead ${id}`,
        description: "Seeded for leadership tests",
        acceptanceCriteria: [],
        source: { kind: "manual" },
        trackerIssueId: `manual-${id}`,
        lifecycle: "queued",
        priority: 1,
        eligibilityReasons: [],
        evidence: null,
        createdAt: now,
        updatedAt: now,
      });
      const claimed = yield* workItems.claim(WorkItemId.make(id), "leadership-owner");
      yield* workItems.transition(WorkItemId.make(id), "running", {
        ownerToken: "leadership-owner",
        generation: claimed.generation,
      });
      const runAttempts = yield* RunAttemptRepository;
      const startedAt = yield* nowIso;
      const runAttemptId = RunAttemptId.make(`run-${id}`);
      yield* runAttempts.create({
        id: runAttemptId,
        workItemId: WorkItemId.make(id),
        attemptNumber: 1,
        workspacePath: `/ws/${id}`,
        provider: {
          instanceId: ProviderInstanceId.make("codex_default"),
          driver: ProviderDriverKind.make("codex"),
        },
        status: "streaming_turn",
        startedAt,
        finishedAt: null,
        error: null,
      });
      const runEvents = yield* RunEventRepository;
      yield* runEvents.append(runAttemptId, "issue_claimed", {
        workItemId: id,
        ownerToken: "leadership-owner",
        generation: claimed.generation,
      });
      return { workItemId: WorkItemId.make(id), runAttemptId };
    });

  let second: SymphonyOrchestrator["Service"] | null = null;

  it.effect(
    "a second orchestrator on the same database is a follower and leaves the leader's runs alone",
    () =>
      Effect.gen(function* () {
        const first = yield* SymphonyOrchestrator;
        expect((yield* first.getOverview()).orchestratorRole).toBe("leader");
        // Run the leader's startup recovery inline BEFORE seeding: recovery
        // moved from layer construction to the first tick, so without this the
        // layer's background first tick races the seeds below and interrupts
        // the freshly seeded run as if it were a crash orphan.
        yield* first.refreshNow();
        const { workItemId, runAttemptId } = yield* seedHeldRun("lead-1");
        yield* seedWorkflow("wf-lead-1", "/repo/lead-1", { autonomy: "execute" });
        // Nudge the clock so the second orchestrator mints a distinct lock
        // token (token = pid + build millis): identical tokens can never lose
        // a renewal race, so takeovers and demotions would be unobservable.
        yield* TestClock.adjust("1 millis");
        second = Context.get(
          yield* Layer.build(Layer.fresh(SymphonyOrchestratorLive)),
          SymphonyOrchestrator,
        );
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        expect(
          (yield* (second as SymphonyOrchestrator["Service"]).getOverview()).orchestratorRole,
        ).toBe("follower");
        // Clear here (not earlier): the leader's own background first tick may
        // still be polling concurrently, and only ticks after this point can
        // implicate the follower.
        pollCountsByRepository.clear();
        yield* (second as SymphonyOrchestrator["Service"]).refreshNow();
        const runAttempts = yield* RunAttemptRepository;
        expect((yield* runAttempts.getById(runAttemptId))?.status).toBe("streaming_turn");
        const runEvents = yield* RunEventRepository;
        expect(
          (yield* runEvents.listForAttempt(runAttemptId)).some(
            (e) => e.eventType === "interrupted",
          ),
        ).toBe(false);
        const workItems = yield* WorkItemRepository;
        expect((yield* workItems.getById(workItemId))?.lifecycle).toBe("running");
        expect(pollCountsByRepository.get("/repo/lead-1")).toBe(undefined);
      }),
  );

  it.effect("a follower takes the lock when the lease expires and then runs recovery", () =>
    Effect.gen(function* () {
      if (second === null) throw new Error("second orchestrator missing");
      const { workItemId, runAttemptId } = yield* seedHeldRun("lead-2");
      const stagedRepository = yield* ApprovalRepository;
      const staged = yield* stagedRepository.create({
        id: "lead-2-staged-delivery",
        requestId: "lead-2-staged-request",
        workItemId: String(workItemId),
        runAttemptId,
        action: "user_input",
        scope: "current_run",
        reason: "Which branch?",
      });
      yield* stagedRepository.stageDelivery(staged.id, "answered", {
        answer: {
          answers: [{ questionId: "q1", answer: "main" }],
          delivery: "unknown",
          actor: "local_operator",
          recordedAt: yield* nowIso,
        },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE symphony_orchestrator_state SET lock_expires_at = '1969-01-01T00:00:00.000Z'`;
      yield* second.refreshNow();
      expect((yield* second.getOverview()).orchestratorRole).toBe("leader");
      const runAttempts = yield* RunAttemptRepository;
      // A bound attempt with no persisted child identity is not proof that no
      // child exists; startup recovery holds it rather than interrupting.
      expect((yield* runAttempts.getById(runAttemptId))?.status).toBe("streaming_turn");
      const runEvents = yield* RunEventRepository;
      expect(
        (yield* runEvents.listForAttempt(runAttemptId)).some(
          (event) => event.eventType === "recovery_hold",
        ),
      ).toBe(true);
      // The same authoritative startup recovery reconciles uncertain staged
      // deliveries before any worker can answer, preserving delivery-unknown.
      const reconciledRow = yield* stagedRepository.getById(staged.id);
      expect(reconciledRow?.state).toBe("interrupted");
      expect(reconciledRow?.decision).toBe("answered");
      expect(reconciledRow?.answer?.delivery).toBe("unknown");
      expect(reconciledRow?.answer?.answers).toEqual([{ questionId: "q1", answer: "main" }]);
      const first = yield* SymphonyOrchestrator;
      yield* first.refreshNow();
      expect((yield* first.getOverview()).orchestratorRole).toBe("follower");
    }),
  );

  it.effect("a demoted process regains the lock on a later tick", () =>
    Effect.gen(function* () {
      if (second === null) throw new Error("second orchestrator missing");
      const first = yield* SymphonyOrchestrator;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE symphony_orchestrator_state SET lock_expires_at = '1969-01-01T00:00:00.000Z'`;
      yield* first.refreshNow();
      expect((yield* first.getOverview()).orchestratorRole).toBe("leader");
      yield* second.refreshNow();
      expect((yield* second.getOverview()).orchestratorRole).toBe("follower");
    }),
  );
});
