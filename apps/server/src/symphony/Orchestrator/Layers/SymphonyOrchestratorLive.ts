import type {
  AttentionItem,
  EffectiveWorkflowConfig,
  EvidenceBundle,
  NormalizedIssue,
  PullRequestEvidence,
  QueueItem,
  RunAttempt,
  RunDetails,
  RunSummary,
  SymphonyProject,
  SymphonyProjectConfiguration,
  SymphonyProjectSourceControl,
  SymphonyOverview,
  SymphonyOverviewMetric,
  TrackerHealth,
  WorkflowRecord,
  WorkItem,
  WorkLifecycle,
} from "@neokod/contracts";
import {
  AttentionItemId,
  RunAttemptId,
  SymphonyProjectId,
  WorkflowId,
  WorkItemId,
} from "@neokod/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../../Persistence/Errors.ts";
import { SymphonyProjectRepository } from "../../Persistence/Services/SymphonyProjectRepository.ts";
import { WorkflowRepository } from "../../Persistence/Services/WorkflowRepository.ts";
import { WorkItemRepository } from "../../Persistence/Services/WorkItemRepository.ts";
import { OrchestratorStateRepository } from "../../Persistence/Services/OrchestratorStateRepository.ts";
import { RunAttemptRepository } from "../../Persistence/Services/RunAttemptRepository.ts";
import { RunEventRepository } from "../../Persistence/Services/RunEventRepository.ts";
import { ApprovalService } from "../../Runner/ApprovalService.ts";
import { RunDispatcher } from "../../Runner/Dispatcher.ts";
import { EvidenceRepository } from "../../Persistence/Services/EvidenceRepository.ts";
import { PullRequestService } from "../../Evidence/PullRequest.ts";
import { WORKFLOW_DEFAULTS } from "../../Workflow/Config.ts";
import { TrackerAdapterRegistry } from "../../Trackers/Adapter.ts";
import { resolveTrackerAdapter, TrackerEnablement } from "../TrackerEnablement.ts";
import { evaluateEligibility } from "../Eligibility.ts";
import { projectWorkItem } from "../Projection.ts";
import { nowMs, reconcileStaleClaims } from "../Reconciler.ts";
import { retryDueAtMs } from "../Retry.ts";
import { runStartupRecovery } from "../Recovery.ts";
import { WorkflowLoaderService } from "../../Workflow/Loader.ts";
import { AttentionRepository } from "../../Persistence/Services/AttentionRepository.ts";
import { TrackerCheckpointRepository } from "../../Persistence/Services/TrackerCheckpointRepository.ts";
import { AuditRepository } from "../../Persistence/Services/AuditRepository.ts";
import { NotificationCoordinator } from "../../NotificationCoordinator.ts";
import { deriveWorkingBranch } from "../../Domain/Keys.ts";
import { WorkspaceOwnershipRepository } from "../../Persistence/Services/WorkspaceOwnershipRepository.ts";
import type { ReviewFeedbackContext } from "../../Runner/Prompt.ts";
import { SymphonyOrchestrator, type SymphonyOrchestratorShape } from "../SymphonyOrchestrator.ts";
import { projectBoardFromWorkItems } from "../ProjectBoard.ts";
import { VcsDriverRegistry } from "../../../vcs/VcsDriverRegistry.ts";
import { ServerConfig } from "../../../config.ts";

/**
 * Live orchestrator. Active workflows are reloaded and polled independently,
 * eligible work is projected into the durable queue, and one queued item is
 * admitted per scheduler scan through the same pause/concurrency/eligibility
 * gate used by manual dispatch.
 *
 * The scheduler scans at the minimum supported workflow interval. Per-workflow
 * due times prevent a fast workflow from over-polling slower workflows, while
 * still detecting WORKFLOW.md changes promptly.
 */

const SCHEDULER_SCAN_INTERVAL = "5 seconds";

const ALL_WORK_LIFECYCLES = [
  "draft",
  "eligible",
  "queued",
  "preparing",
  "running",
  "testing",
  "blocked",
  "waiting_for_approval",
  "retry_scheduled",
  "validation_failed",
  "ready_for_review",
  "changes_requested",
  "ready_to_merge",
  "completed",
  "cancelled",
  "failed",
] as const;

type MissingWorkLifecycle = Exclude<WorkLifecycle, (typeof ALL_WORK_LIFECYCLES)[number]>;
const _allWorkLifecyclesCovered: MissingWorkLifecycle extends never ? true : never = true;
void _allWorkLifecyclesCovered;

const trackerProviderForProject = (
  tracker: SymphonyProjectConfiguration["tracker"],
): Readonly<Record<string, unknown>> => {
  switch (tracker.kind) {
    case "github":
      return { repo: tracker.repository };
    case "jira":
      return { project_key: tracker.projectKey };
    case "linear":
      return { project_slug: tracker.projectSlug };
    case "gitlab":
      return { project_path: tracker.projectPath };
    case "asana":
      return { project_gid: tracker.projectGid };
    case "azure_boards":
      return {
        ...(tracker.organization === undefined ? {} : { organization: tracker.organization }),
        project: tracker.project,
      };
    case "github_projects":
      return { owner: tracker.owner, number: tracker.number };
  }
};

const effectiveConfigForProject = (
  project: SymphonyProject,
  worktreesDir: string,
): EffectiveWorkflowConfig | null => {
  const configuration = project.configuration;
  if (configuration === null) return null;
  return {
    repositoryPath: project.repositoryPath,
    workflowPath: `symphony-project:${project.id}`,
    trackerKind: configuration.tracker.kind,
    trackerRequiredLabels: [...configuration.trackerRequiredLabels],
    trackerActiveStates: [...configuration.trackerActiveStates],
    trackerTerminalStates: [...configuration.trackerTerminalStates],
    trackerProvider: trackerProviderForProject(configuration.tracker),
    pollIntervalMs: WORKFLOW_DEFAULTS.pollIntervalMs,
    workspaceRoot: `${worktreesDir}/symphony-${project.id}`,
    autonomy: configuration.autonomy,
    agentProvider: configuration.agentProvider,
    ...(configuration.agentModel === undefined ? {} : { agentModel: configuration.agentModel }),
    maxTurns: configuration.maxTurns,
    maxAttempts: configuration.maxAttempts,
    validationRequired: [...configuration.validationRequired],
    validationTestPathPatterns: [],
    approvalsBeforePush: configuration.approvalsBeforePush,
    approvalsBeforePullRequest: configuration.approvalsBeforePullRequest,
    approvalsBeforeMerge: configuration.approvalsBeforeMerge,
    approvalsProtectedPaths: [],
    approvalsPolicies: [],
    concurrencyGlobal: configuration.maxConcurrentAgents,
  };
};

const remoteHostname = (remoteUrl: string): string | null => {
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(remoteUrl.trim());
  const scpHostname = scpLike?.[1]?.toLowerCase() ?? null;
  try {
    return new URL(remoteUrl).hostname.toLowerCase() || scpHostname;
  } catch {
    return scpHostname;
  }
};

const matchesHost = (hostname: string, expected: string): boolean =>
  hostname === expected || hostname.endsWith(`.${expected}`);

const providerForRemoteUrl = (remoteUrl: string): string | null => {
  const hostname = remoteHostname(remoteUrl);
  if (hostname === null) return null;
  if (matchesHost(hostname, "github.com")) return "github";
  if (matchesHost(hostname, "gitlab.com")) return "gitlab";
  if (matchesHost(hostname, "bitbucket.org")) return "bitbucket";
  if (matchesHost(hostname, "dev.azure.com") || matchesHost(hostname, "visualstudio.com")) {
    return "azure-devops";
  }
  return null;
};

const knownOverviewMetric = (value: number): SymphonyOverviewMetric => ({
  state: "known",
  value,
});

const unavailableOverviewMetric = (reason: string): SymphonyOverviewMetric => ({
  state: "unavailable",
  reason,
});

const readOverviewMetric = <E, R>(
  read: Effect.Effect<number, E, R>,
  unavailableReason: string,
): Effect.Effect<SymphonyOverviewMetric, never, R> =>
  read.pipe(
    Effect.map(knownOverviewMetric),
    Effect.catch(() => Effect.succeed(unavailableOverviewMetric(unavailableReason))),
  );

/**
 * Plan 9.5 re-check (audit item 2): a retry must re-read the issue from the
 * tracker instead of re-dispatching a fabricated snapshot from the stored
 * row — the tracker state may have moved (closed, renamed, re-assigned)
 * since the item was queued. Returns null when the issue is gone, so the
 * item is left queued for a manual decision rather than dispatched as a
 * phantom.
 */
const refreshIssueSnapshot = (
  item: WorkItem,
  config: EffectiveWorkflowConfig,
  registry: TrackerAdapterRegistry["Service"],
  enablement: TrackerEnablement["Service"],
): Effect.Effect<NormalizedIssue | null, never> =>
  Effect.gen(function* () {
    if (item.trackerIssueId !== undefined && item.trackerIssueId.length > 0) {
      const trackerIssueId: string = item.trackerIssueId;
      const refreshed = yield* resolveTrackerAdapter(registry, enablement, config).pipe(
        Effect.flatMap((adapter) => adapter.refreshIssues([trackerIssueId])),
        Effect.catch(() => Effect.succeed([])),
      );
      const fresh = refreshed.find((candidate) => candidate.id === trackerIssueId);
      if (fresh !== undefined) {
        return fresh;
      }
      return null;
    }
    return {
      id: item.trackerIssueId ?? item.id,
      nativeRef: null,
      identifier: item.trackerIdentifier ?? item.objective,
      title: item.objective,
      description: item.description ?? null,
      priority: item.priority ?? null,
      state: "queued",
      branchName: item.baseBranch ?? null,
      url: null,
      assigneeId: null,
      labels: [],
      blockedBy: [],
      dispatchable: true,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

interface OrchestratorRuntimeState {
  readonly lastPollAt: string | null;
  readonly trackerHealth: ReadonlyArray<TrackerHealth>;
}

interface PreparedDispatch {
  readonly item: WorkItem;
  readonly issue: NormalizedIssue;
  readonly config: EffectiveWorkflowConfig;
  readonly reviewFeedback?: ReviewFeedbackContext;
  readonly workflowInstructions?: string;
}

const EMPTY_STATE: OrchestratorRuntimeState = {
  lastPollAt: null,
  trackerHealth: [],
};

const buildQueueItem = (workItem: WorkItem): QueueItem => ({
  workItemId: workItem.id,
  trackerIdentifier: workItem.trackerIdentifier ?? undefined,
  title: workItem.objective,
  repositoryPath: workItem.repositoryPath ?? undefined,
  workflowId: workItem.workflowId ?? undefined,
  state: workItem.lifecycle,
  lifecycle: workItem.lifecycle,
  priority: workItem.priority ?? undefined,
  blocked: workItem.blocked ?? false,
  blockers: [],
  eligible: workItem.eligibilityReasons.length === 0,
  ineligibilityReasons: workItem.eligibilityReasons,
  excluded: workItem.excluded ?? false,
  estimatedReadiness: null,
  createdAt: workItem.createdAt,
});

const modelReviewAllowsMerge = (
  config: EffectiveWorkflowConfig,
  evidence: EvidenceBundle,
  pullRequest: PullRequestEvidence,
): boolean => {
  const configuredModels = [...(config.reviewAgents ?? [])].sort();
  const requirement = config.reviewRequirement ?? "advisory";
  if (configuredModels.length === 0 || requirement === "advisory") {
    return true;
  }
  const review = evidence.modelReview;
  if (review === null || review.require !== requirement || !review.passed) {
    return false;
  }
  const reviewedModels = review.reviewers.map((reviewer) => reviewer.model).sort();
  if (
    reviewedModels.length !== configuredModels.length ||
    reviewedModels.some((model, index) => model !== configuredModels[index])
  ) {
    return false;
  }
  return (
    review.headSha !== undefined &&
    pullRequest.latestCommit !== undefined &&
    review.headSha === pullRequest.latestCommit
  );
};

const RUN_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
  "user_cancelled",
  "tracker_cancelled",
  "process_failed",
  "validation_failed",
  "workflow_error",
  "provider_error",
  "interrupted",
  "retries_exhausted",
]);

const lifecycleForRun = (
  attemptStatus: string,
  workItem: WorkItem | null,
): WorkItem["lifecycle"] => {
  // The work item's lifecycle is authoritative for review states: after
  // requestChanges/approveMerge/takeOver, the item has moved past
  // `ready_for_review` while the attempt stays `succeeded`. Check it first so
  // the Phase 5 review lifecycle is visible in the runs/reviews lists
  // (REVIEW P1: the succeeded short-circuit made every review-ready run
  // report ready_for_review forever).
  if (workItem !== null) {
    const reviewLifecycles: ReadonlySet<WorkItem["lifecycle"]> = new Set([
      "waiting_for_approval",
      "blocked",
      "testing",
      "cancelled",
      "changes_requested",
      "ready_for_review",
      "ready_to_merge",
      "validation_failed",
      "retry_scheduled",
      "failed",
    ]);
    if (reviewLifecycles.has(workItem.lifecycle)) {
      return workItem.lifecycle;
    }
  }
  if (attemptStatus === "succeeded") {
    return "ready_for_review";
  }
  if (RUN_TERMINAL_STATUSES.has(attemptStatus)) {
    return "failed";
  }
  return "running";
};

/** Project the compact PR reference carried on `RunSummary` (reviews-list
 * and history-view badges) from the full evidence bundle's `pullRequest`. */
const projectRunSummaryPullRequest = (
  pullRequest: PullRequestEvidence | null | undefined,
): RunSummary["pullRequest"] => {
  if (pullRequest === null || pullRequest === undefined) {
    return undefined;
  }
  return {
    number: pullRequest.number,
    ...(pullRequest.url !== undefined ? { url: pullRequest.url } : {}),
    ...(pullRequest.status !== undefined ? { status: pullRequest.status } : {}),
  };
};

const buildRunSummary = (input: {
  readonly attempt: RunAttempt;
  readonly workItem: WorkItem | null;
  readonly latestEvent: string | null;
  readonly nowMs: number;
  readonly overallAssessment?: RunSummary["overallAssessment"];
  readonly pullRequest?: RunSummary["pullRequest"];
}): RunSummary => {
  const { attempt, workItem, latestEvent } = input;
  const started = Date.parse(attempt.startedAt);
  const finished = attempt.finishedAt === null ? null : Date.parse(attempt.finishedAt);
  const elapsedMs =
    finished === null ? Math.max(0, input.nowMs - started) : Math.max(0, finished - started);
  return {
    runAttemptId: RunAttemptId.make(attempt.id),
    workItemId: WorkItemId.make(attempt.workItemId),
    ...(workItem?.trackerIdentifier !== undefined
      ? { trackerIdentifier: workItem.trackerIdentifier }
      : {}),
    ...(workItem !== null ? { issueTitle: workItem.objective } : {}),
    ...(workItem?.repositoryPath !== undefined ? { repositoryPath: workItem.repositoryPath } : {}),
    ...(workItem?.projectId !== undefined ? { projectId: workItem.projectId } : {}),
    ...(workItem?.workflowId !== undefined ? { workflowId: workItem.workflowId } : {}),
    provider: attempt.provider as RunSummary["provider"],
    ...(attempt.model !== undefined ? { model: attempt.model } : {}),
    status: attempt.status as RunSummary["status"],
    ...(attempt.currentStage !== undefined ? { currentStage: attempt.currentStage } : {}),
    attemptNumber: attempt.attemptNumber,
    retryCount: Math.max(0, attempt.attemptNumber - 1),
    startedAt: attempt.startedAt,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(attempt.tokenUsage !== undefined && attempt.tokenUsage.totalTokens !== undefined
      ? { tokenUsage: attempt.tokenUsage as RunSummary["tokenUsage"] }
      : {}),
    ...(latestEvent !== null ? { latestEvent } : {}),
    ...(attempt.workspacePath !== undefined ? { workspacePath: attempt.workspacePath } : {}),
    lifecycle: lifecycleForRun(attempt.status, workItem),
    ...(input.overallAssessment !== undefined
      ? { overallAssessment: input.overallAssessment }
      : {}),
    ...(input.pullRequest !== undefined ? { pullRequest: input.pullRequest } : {}),
  };
};

const approvalToAttentionItem = (request: {
  readonly id: string;
  readonly workItemId: string;
  readonly runAttemptId?: string | undefined;
  readonly action: string;
  readonly command?: string | undefined;
  readonly createdAt: string;
}): AttentionItem => ({
  id: request.id as AttentionItem["id"],
  workItemId: WorkItemId.make(request.workItemId),
  ...(request.runAttemptId !== undefined
    ? { runAttemptId: RunAttemptId.make(request.runAttemptId) }
    : {}),
  kind: "command_approval",
  severity: "high",
  state: "open",
  whatHappened: request.command ?? `The agent requests ${request.action}.`,
  whyHuman: "This action is gated by the workflow approval policy.",
  ...(request.command !== undefined ? { recommendedResponse: "Approve or reject." } : {}),
  availableActions: ["approve", "reject"],
  createdAt: request.createdAt,
  resolvedAt: null,
});

const recordTrackerHealth = (
  stateRef: Ref.Ref<OrchestratorRuntimeState>,
  config: EffectiveWorkflowConfig,
  profile: Readonly<Record<string, unknown>>,
  ok: boolean,
  error: string | null,
) =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    yield* Ref.update(stateRef, (state) => {
      const health: TrackerHealth = {
        kind: config.trackerKind,
        ok,
        error,
        lastPollAt: now,
        profile,
      };
      const next = state.trackerHealth.filter((h) => h.kind !== config.trackerKind);
      return { ...state, lastPollAt: now, trackerHealth: [...next, health] };
    });
  });

const pollWorkflow = (deps: {
  readonly workItems: WorkItemRepository["Service"];
  readonly registry: TrackerAdapterRegistry["Service"];
  readonly enablement: TrackerEnablement["Service"];
  readonly stateRef: Ref.Ref<OrchestratorRuntimeState>;
  readonly checkpoints?: TrackerCheckpointRepository["Service"];
}) =>
  Effect.fn("pollWorkflow")(function* (workflow: WorkflowRecord, now: string) {
    const config = workflow.effectiveConfig;
    if (config === null || workflow.status !== "active") {
      return;
    }

    const enabled = yield* deps.enablement.validateTrackerEnabled(config).pipe(Effect.isSuccess);
    if (!enabled) {
      yield* recordTrackerHealth(
        deps.stateRef,
        config,
        {},
        false,
        "tracker disabled in Tracking settings",
      );
      return;
    }

    const adapter = yield* resolveTrackerAdapter(deps.registry, deps.enablement, config).pipe(
      Effect.catch((error) =>
        recordTrackerHealth(deps.stateRef, config, {}, false, error.message).pipe(
          Effect.as(null as never),
        ),
      ),
    );
    if (adapter === null) {
      return;
    }
    const profile = { ...adapter.profile() };

    const result = yield* Effect.result(adapter.listCandidateIssues());
    if (result._tag === "Failure") {
      yield* recordTrackerHealth(deps.stateRef, config, profile, false, result.failure.message);
      return;
    }
    const issues = result.success;
    yield* recordTrackerHealth(deps.stateRef, config, profile, true, null);

    // Tracker checkpoint (audit item 8 lane H): record when the poll last
    // succeeded so resume/recovery can tell a healthy poll from a silent one,
    // and future cursor-based adapters have a place to persist page cursors.
    if (deps.checkpoints !== undefined) {
      yield* deps.checkpoints
        .upsertCheckpoint({
          trackerKind: config.trackerKind,
          scopeKey: config.repositoryPath,
        })
        .pipe(Effect.catch(() => Effect.void));
    }

    for (const issue of issues) {
      const eligibility = evaluateEligibility({
        config,
        issue,
        claimedIssueIds: new Set<string>(),
        dispatchPaused: false,
      });
      const projected = yield* projectWorkItem(
        issue,
        config,
        eligibility,
        now,
        SymphonyProjectId.make(workflow.id),
      );
      const workItem = { ...projected, workflowId: workflow.id };
      yield* deps.workItems.upsert(workItem).pipe(Effect.catch(() => Effect.void));
    }
  });

const makeOrchestrator = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  const projects = yield* SymphonyProjectRepository;
  const workItems = yield* WorkItemRepository;
  const attentionRepository = yield* AttentionRepository;
  const registry = yield* TrackerAdapterRegistry;
  const enablement = yield* TrackerEnablement;
  const orchestratorState = yield* OrchestratorStateRepository;
  const dispatcher = yield* RunDispatcher;
  const runAttempts = yield* RunAttemptRepository;
  const runEvents = yield* RunEventRepository;
  const approvals = yield* ApprovalService;
  const evidenceRepository = yield* EvidenceRepository;
  const pullRequestService = yield* PullRequestService;
  const checkpointRepository = yield* TrackerCheckpointRepository;
  const auditRepository = yield* AuditRepository;
  const notifications = yield* NotificationCoordinator;
  const serverConfig = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const vcsRegistry = yield* Effect.serviceOption(VcsDriverRegistry);

  const stateRef = yield* Ref.make<OrchestratorRuntimeState>(EMPTY_STATE);
  const lastPollByWorkflowRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const dispatchScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(dispatchScope, Exit.void));
  const workflowLoader = yield* Effect.serviceOption(WorkflowLoaderService);

  const reloadWorkflowFiles = Effect.fn("symphonyOrchestrator.reloadWorkflowFiles")(function* () {
    if (Option.isNone(workflowLoader)) {
      return;
    }
    const records = yield* workflows.list().pipe(Effect.catch(() => Effect.succeed([])));
    for (const workflow of records) {
      if (workflow.workflowPath.startsWith("symphony-project:")) continue;
      yield* workflowLoader.value
        .reloadChanged({ repositoryPath: workflow.repositoryPath })
        .pipe(Effect.catch(() => Effect.void));
    }
  });

  const syncProjectWorkflow = Effect.fn("symphonyOrchestrator.syncProjectWorkflow")(function* (
    project: SymphonyProject,
  ) {
    const effectiveConfig = effectiveConfigForProject(project, serverConfig.worktreesDir);
    const id = WorkflowId.make(project.id);
    const existing = yield* workflows.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
    yield* workflows.upsert({
      id,
      repositoryPath: project.repositoryPath,
      workflowPath: `symphony-project:${project.id}`,
      status: effectiveConfig === null ? "paused" : project.status,
      autonomy: effectiveConfig?.autonomy ?? "observe",
      validationError: effectiveConfig === null ? "Project setup is incomplete" : null,
      definition: existing?.definition ?? { config: {}, promptTemplate: "" },
      effectiveConfig,
      enabledAt:
        project.status === "active" && effectiveConfig !== null
          ? (existing?.enabledAt ?? project.updatedAt)
          : null,
      createdAt: existing?.createdAt ?? project.createdAt,
      updatedAt: project.updatedAt,
    });
  });

  const persistedProjects = yield* projects.list().pipe(Effect.catch(() => Effect.succeed([])));
  for (const project of persistedProjects) {
    yield* syncProjectWorkflow(project).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("symphony.project.workflow_sync_failed", {
          projectId: project.id,
          error: cause.message,
        }),
      ),
    );
  }

  const sourceControlCache = new Map<
    string,
    { readonly expiresAt: number; readonly value: SymphonyProjectSourceControl }
  >();
  const sourceControlCacheTtlMs = 5_000;

  const readProjectSourceControl = Effect.fn("symphonyOrchestrator.readProjectSourceControl")(
    function* (repositoryPath: string): Effect.fn.Return<SymphonyProjectSourceControl> {
      if (Option.isNone(vcsRegistry)) {
        return { state: "unavailable", reason: "VCS discovery is unavailable" };
      }
      const detected = yield* Effect.result(
        vcsRegistry.value.detect({ cwd: repositoryPath }).pipe(Effect.timeout("5 seconds")),
      );
      if (detected._tag === "Failure") {
        return { state: "unavailable", reason: detected.failure.message };
      }
      if (detected.success === null) {
        return { state: "none" };
      }
      const remotes = yield* Effect.result(
        detected.success.driver.listRemotes(repositoryPath).pipe(Effect.timeout("5 seconds")),
      );
      if (remotes._tag === "Failure") {
        return { state: "unavailable", reason: remotes.failure.message };
      }
      const remote =
        remotes.success.remotes.find((candidate) => candidate.isPrimary) ??
        remotes.success.remotes[0] ??
        null;
      return {
        state: "known",
        vcsKind: detected.success.kind,
        provider: remote === null ? null : providerForRemoteUrl(remote.url),
        remoteUrl: remote?.url ?? null,
        authenticated: null,
      };
    },
  );

  const resolveProjectSourceControl = Effect.fn("symphonyOrchestrator.resolveProjectSourceControl")(
    function* (repositoryPath: string): Effect.fn.Return<SymphonyProjectSourceControl> {
      const now = yield* Clock.currentTimeMillis;
      const cached = sourceControlCache.get(repositoryPath);
      if (cached !== undefined && cached.expiresAt > now) return cached.value;
      const value = yield* readProjectSourceControl(repositoryPath);
      const refreshedAt = yield* Clock.currentTimeMillis;
      sourceControlCache.set(repositoryPath, {
        expiresAt: refreshedAt + sourceControlCacheTtlMs,
        value,
      });
      return value;
    },
  );

  const runTick = Effect.fn("symphonyOrchestrator.tick")(function* (
    forcePoll = false,
    allowDispatch = true,
  ) {
    yield* reloadWorkflowFiles();
    const now = yield* nowIso;
    const active = yield* workflows
      .list()
      .pipe(Effect.map((all) => all.filter((w) => w.status === "active")))
      .pipe(Effect.catch(() => Effect.succeed([] as WorkflowRecord[])));
    const nowEpochMs = nowMs(now);
    for (const workflow of active) {
      const config = workflow.effectiveConfig;
      if (config === null) {
        continue;
      }
      const lastPollByWorkflow = yield* Ref.get(lastPollByWorkflowRef);
      const lastPollAt = lastPollByWorkflow.get(String(workflow.id));
      const pollIntervalMs = config.pollIntervalMs ?? WORKFLOW_DEFAULTS.pollIntervalMs;
      if (!forcePoll && lastPollAt !== undefined && nowEpochMs - lastPollAt < pollIntervalMs) {
        continue;
      }
      yield* pollWorkflow({
        workItems,
        registry,
        enablement,
        stateRef,
        checkpoints: checkpointRepository,
      })(workflow, now).pipe(Effect.catch(() => Effect.void));
      yield* Ref.update(lastPollByWorkflowRef, (current) => {
        const next = new Map(current);
        next.set(String(workflow.id), nowEpochMs);
        return next;
      });
    }
    // Best-effort housekeeping: release orphaned claims, fire due retries and
    // expire approval requests whose wait window elapsed. Runs on the same
    // cadence as polling.
    yield* reconcileStaleClaims({ workItems, runAttempts, runEvents, workflows, dispatcher });
    yield* retrySweep();
    if (allowDispatch) {
      yield* launchNextQueuedWork();
    }
    yield* sweepExpiredApprovals(now);
    yield* Ref.update(stateRef, (state) => ({ ...state, lastPollAt: now }));
  });

  // Retry sweep (plan 9.5, WS-M): for each item in `retry_scheduled` whose
  // backoff window elapsed, re-dispatch if it is still eligible. Poll-based
  // so the state survives restarts in the DB row; the retry timer is the
  // poll cadence, which is acceptable because the sweep is idempotent.
  const retrySweep = Effect.fn("symphonyOrchestrator.retrySweep")(function* () {
    const now = yield* nowIso;
    const scheduled = yield* workItems
      .listByLifecycle(["retry_scheduled"])
      .pipe(Effect.catch(() => Effect.succeed([] as WorkItem[])));
    for (const item of scheduled) {
      const attempt = yield* runAttempts
        .latestForWorkItem(item.id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (attempt === null || attempt.finishedAt === null) {
        continue;
      }
      const workflow =
        item.workflowId === undefined
          ? undefined
          : yield* workflows.list().pipe(
              Effect.map((all) => all.find((w) => w.id === item.workflowId)),
              Effect.catch(() => Effect.succeed(undefined)),
            );
      const maxBackoffMs =
        workflow?.effectiveConfig?.maxRetryBackoffMs ?? WORKFLOW_DEFAULTS.maxRetryBackoffMs;
      const dueAt = retryDueAtMs({
        finishedAt: attempt.finishedAt,
        attemptNumber: attempt.attemptNumber,
        maxRetryBackoffMs: maxBackoffMs,
      });
      if (dueAt === null || nowMs(now) < dueAt) {
        continue;
      }
      const itemNow = yield* workItems
        .getById(item.id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (itemNow === null || itemNow.lifecycle !== "retry_scheduled") {
        continue;
      }
      // Re-dispatch claims the item (claim accepts retry_scheduled) and the
      // dispatcher creates the next attempt; failure releases it back here.
      yield* dispatchWorkItem(String(item.id)).pipe(Effect.catch(() => Effect.void));
    }
  });

  const sweepExpiredApprovals = (now: string) =>
    Effect.gen(function* () {
      const pending = yield* approvals.listPending().pipe(Effect.catch(() => Effect.succeed([])));
      if (pending.length === 0) {
        return;
      }
      const workflowTimeoutMs = new Map<string, number>();
      for (const request of pending) {
        const workItem = yield* workItems
          .getById(request.workItemId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (workItem === null) {
          continue;
        }
        const workflowId = workItem.workflowId === undefined ? null : String(workItem.workflowId);
        let timeoutMs = 0;
        if (workflowId !== null) {
          const cached = workflowTimeoutMs.get(workflowId);
          if (cached !== undefined) {
            timeoutMs = cached;
          } else {
            const workflow = yield* workflows.list().pipe(
              Effect.map((all) => all.find((w) => w.id === workItem.workflowId)),
              Effect.catch(() => Effect.succeed(undefined)),
            );
            timeoutMs =
              workflow?.effectiveConfig?.approvalsWaitTimeoutMs ??
              WORKFLOW_DEFAULTS.approvalsWaitTimeoutMs;
            workflowTimeoutMs.set(workflowId, timeoutMs);
          }
        }
        if (timeoutMs <= 0) {
          continue;
        }
        const createdAt = Date.parse(request.createdAt);
        if (!Number.isNaN(createdAt) && nowMs(now) - createdAt > timeoutMs) {
          yield* approvals.expire(request.id).pipe(Effect.catch(() => Effect.void));
        }
      }
    });

  const scheduler = Effect.gen(function* () {
    // Startup recovery (plan 9.7, WS-M): mark interrupted runs from a prior
    // crash/restart, release stale claims, and re-queue retryable work.
    const maybeOwnership = yield* Effect.serviceOption(WorkspaceOwnershipRepository);
    yield* runStartupRecovery({
      workItems,
      runAttempts,
      runEvents,
      workflows,
      dispatcher,
      interruptRunApprovals: (input) =>
        approvals.listPending().pipe(
          Effect.flatMap((pending) =>
            Effect.all(
              pending
                .filter(
                  (request) =>
                    request.workItemId === input.workItemId &&
                    (request.runAttemptId === undefined ||
                      request.runAttemptId === input.runAttemptId),
                )
                .map((request) => approvals.interrupt(request.id)),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        ),
      ...(Option.isSome(maybeOwnership) ? { ownership: maybeOwnership.value } : {}),
    }).pipe(Effect.catch(() => Effect.void));
    // Each tick runs in its own scope so retry-sweep dispatches release
    // their agent-runtime resources when the run ends instead of holding
    // them on the layer scope until server shutdown. The first tick polls all
    // workflows immediately; later scans honor each workflow's interval.
    yield* runTick(true).pipe(Effect.scoped);
    yield* Effect.repeat(
      runTick(false).pipe(Effect.scoped),
      Schedule.fixed(SCHEDULER_SCAN_INTERVAL),
    );
  });

  // Startup advisory lock (audit item 8 lane I; plan section 4): one server
  // process orchestrates at a time. Acquired with a per-launch token and a
  // lease, renewed on every tick, released on teardown. A second server that
  // fails to acquire degrades to read-only observe (no dispatch) rather than
  // refusing to boot.
  const lockAcquiredAtMs = yield* Clock.currentTimeMillis;
  const lockToken = `symphony-${process.pid}-${lockAcquiredAtMs}`;
  const lockLeaseMs = 90_000;
  const acquiredLock = yield* orchestratorState
    .acquireLock({ ownerToken: lockToken, leaseMs: lockLeaseMs })
    .pipe(Effect.catch(() => Effect.succeed(false)));

  const refreshNow: SymphonyOrchestratorShape["refreshNow"] = () =>
    runTick(true, false).pipe(Effect.scoped);

  const getOverview = (): Effect.Effect<SymphonyOverview, never> =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const nowInCurrentZone = DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal());
      const startOfTodayMs = DateTime.toEpochMillis(DateTime.startOf(nowInCurrentZone, "day"));
      const state = yield* Ref.get(stateRef);
      const paused = yield* orchestratorState
        .isGlobalPaused()
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const activeWorkflows = yield* readOverviewMetric(
        workflows.list().pipe(Effect.map((all) => all.filter((w) => w.status === "active").length)),
        "Active workflow count could not be read.",
      );
      const queued = yield* readOverviewMetric(
        workItems
          .listByLifecycle(["eligible", "queued"])
          .pipe(Effect.map((items) => items.filter((item) => item.lifecycle === "queued").length)),
        "Queue count could not be read.",
      );
      const running = yield* readOverviewMetric(
        workItems
          .listByLifecycle(["preparing", "running", "waiting_for_approval"])
          .pipe(Effect.map((items) => items.length)),
        "Running count could not be read.",
      );
      const readyForReview = yield* readOverviewMetric(
        workItems
          .listByLifecycle(["ready_for_review", "ready_to_merge"])
          .pipe(Effect.map((items) => items.length)),
        "Ready-for-review count could not be read.",
      );
      const retrying = yield* readOverviewMetric(
        workItems.listByLifecycle(["retry_scheduled"]).pipe(Effect.map((items) => items.length)),
        "Retry count could not be read.",
      );
      const failedToday = yield* readOverviewMetric(
        runAttempts.listRecent({ limit: 500 }).pipe(
          Effect.map(
            (attempts) =>
              attempts.filter((attempt) => {
                const started = Date.parse(attempt.startedAt);
                return (
                  !Number.isNaN(started) &&
                  started >= startOfTodayMs &&
                  (attempt.status === "failed" || attempt.status === "validation_failed")
                );
              }).length,
          ),
        ),
        "Failed-today count could not be read.",
      );
      const needsAttention = yield* readOverviewMetric(
        approvals.listPending().pipe(Effect.map((requests) => requests.length)),
        "Needs-attention count could not be read.",
      );
      return {
        running,
        queued,
        needsAttention,
        readyForReview,
        retrying,
        failedToday,
        orchestratorPaused: paused,
        activeWorkflowCount: activeWorkflows,
        providerHealth: {},
        trackerHealth: Object.fromEntries(
          state.trackerHealth.map((health) => [
            health.kind,
            { ok: health.ok, lastPollAt: health.lastPollAt },
          ]),
        ),
        lastTrackerPollAt: state.lastPollAt,
        // The dispatcher's live agent count is not exposed to the orchestrator,
        // so it must remain unavailable rather than being fabricated as zero.
        activeAgentCount: unavailableOverviewMetric("Active agent count is not exposed."),
        generatedAt: now,
      };
    });

  const listQueue: SymphonyOrchestratorShape["listQueue"] = (filter) =>
    Effect.gen(function* () {
      const items = yield* workItems
        .listByLifecycle(
          filter?.lifecycle === undefined ? ["eligible", "queued"] : [filter.lifecycle],
          {
            ...(filter?.projectId === undefined ? {} : { projectId: filter.projectId }),
            limit: 1_000,
          },
        )
        .pipe(Effect.catch(() => Effect.succeed([] as WorkItem[])));
      return items
        .filter(
          (item) =>
            (filter?.workflowId === undefined || item.workflowId === filter.workflowId) &&
            (filter?.repositoryPath === undefined || item.repositoryPath === filter.repositoryPath),
        )
        .slice(0, filter?.limit ?? items.length)
        .map(buildQueueItem);
    });

  const listRuns: SymphonyOrchestratorShape["listRuns"] = (filter) =>
    Effect.gen(function* () {
      const currentTimeMs = yield* Clock.currentTimeMillis;
      const hasFilterCriteria =
        filter?.projectId !== undefined ||
        filter?.workflowId !== undefined ||
        filter?.repositoryPath !== undefined ||
        filter?.status !== undefined ||
        filter?.lifecycle !== undefined;
      const attempts = yield* runAttempts
        .listRecent({ limit: hasFilterCriteria ? 1_000 : (filter?.limit ?? 50) })
        .pipe(Effect.catch(() => Effect.succeed([])));
      const workItemIds = Array.from(
        new Set(attempts.map((attempt) => String(attempt.workItemId))),
      );
      const workItemsById = new Map<string, WorkItem | null>();
      const assessmentsById = new Map<string, RunSummary["overallAssessment"]>();
      // Compact PR reference for the reviews-list/history badges (plan 12,
      // reviews-list PR badges): projected from the same per-item evidence
      // read as the assessment above, so no extra N+1 query is added — the
      // repository has no batch read, and the run list is small.
      const pullRequestById = new Map<string, RunSummary["pullRequest"]>();
      for (const id of workItemIds) {
        const item = yield* workItems
          .getById(WorkItemId.make(id))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        workItemsById.set(id, item);
        if (item !== null) {
          const evidence = yield* evidenceRepository
            .getByWorkItem(item.id)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (evidence !== null) {
            assessmentsById.set(id, evidence.overallAssessment);
            const pullRequest = projectRunSummaryPullRequest(evidence.pullRequest);
            if (pullRequest !== undefined) {
              pullRequestById.set(id, pullRequest);
            }
          }
        }
      }
      const summaries: RunSummary[] = [];
      for (const attempt of attempts) {
        const latest = yield* runEvents.listForAttempt(attempt.id).pipe(
          Effect.catch(() => Effect.succeed([])),
          Effect.map((events) => events.at(-1)?.eventType ?? null),
        );
        const assessment = assessmentsById.get(String(attempt.workItemId));
        const pullRequest = pullRequestById.get(String(attempt.workItemId));
        summaries.push(
          buildRunSummary({
            attempt,
            workItem: workItemsById.get(String(attempt.workItemId)) ?? null,
            latestEvent: latest,
            nowMs: currentTimeMs,
            ...(assessment !== undefined ? { overallAssessment: assessment } : {}),
            ...(pullRequest !== undefined ? { pullRequest } : {}),
          }),
        );
      }
      return summaries
        .filter(
          (summary) =>
            (filter?.projectId === undefined || summary.projectId === filter.projectId) &&
            (filter?.workflowId === undefined || summary.workflowId === filter.workflowId) &&
            (filter?.repositoryPath === undefined ||
              summary.repositoryPath === filter.repositoryPath) &&
            (filter?.status === undefined || summary.status === filter.status) &&
            (filter?.lifecycle === undefined || summary.lifecycle === filter.lifecycle),
        )
        .slice(0, filter?.limit ?? summaries.length);
    });

  const getRun: SymphonyOrchestratorShape["getRun"] = (runAttemptId) =>
    Effect.gen(function* () {
      const attempt = yield* runAttempts
        .getById(RunAttemptId.make(runAttemptId))
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (attempt === null) {
        return null;
      }
      const workItem = yield* workItems
        .getById(attempt.workItemId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (workItem === null) {
        return null;
      }
      // Surface the assembled evidence bundle (plan 10) on the run detail so
      // the review UI can render changed files, validation and the PR.
      const evidence = yield* evidenceRepository
        .getByWorkItem(workItem.id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const evidenceWorkItem = evidence === null ? workItem : { ...workItem, evidence };
      const timeline = yield* runEvents
        .listForAttempt(attempt.id)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const approvalRequests = yield* approvals
        .listForRun(attempt.id)
        .pipe(Effect.catch(() => Effect.succeed([])));
      return {
        workItem: evidenceWorkItem,
        runAttempt: attempt,
        timeline,
        attentionItems: [],
        approvalRequests,
      } satisfies RunDetails;
    });

  const listRunEvents: SymphonyOrchestratorShape["listRunEvents"] = (runAttemptId) =>
    runEvents
      .listForAttempt(RunAttemptId.make(runAttemptId))
      .pipe(Effect.catch(() => Effect.succeed([])));

  const listAttention: SymphonyOrchestratorShape["listAttention"] = (filter) =>
    Effect.gen(function* () {
      const durable = yield* approvals
        .listPending({ limit: filter?.projectId === undefined ? (filter?.limit ?? 100) : 1_000 })
        .pipe(Effect.catch(() => Effect.succeed([])));
      const attention: AttentionItem[] = [];
      for (const request of durable) {
        attention.push(approvalToAttentionItem(request));
      }
      // Direct attention items (audit item 7: pr_creation_failed raises a
      // durable record; attention is no longer approval-derived only).
      const raised = yield* attentionRepository
        .listOpen({ limit: filter?.projectId === undefined ? (filter?.limit ?? 100) : 1_000 })
        .pipe(Effect.catch(() => Effect.succeed([])));
      for (const item of raised) {
        attention.push(item);
      }
      if (filter?.projectId === undefined)
        return attention.slice(0, filter?.limit ?? attention.length);
      const matching: AttentionItem[] = [];
      const wanted = filter.limit ?? Number.POSITIVE_INFINITY;
      for (const item of attention) {
        if (matching.length >= wanted) break;
        const workItem = yield* workItems
          .getById(item.workItemId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (workItem?.projectId === filter.projectId) matching.push(item);
      }
      return matching;
    });

  const listProjects: SymphonyOrchestratorShape["listProjects"] = () =>
    projects.list().pipe(Effect.catch(() => Effect.succeed([])));

  const getProject: SymphonyOrchestratorShape["getProject"] = (projectId) =>
    projects.getById(projectId).pipe(Effect.catch(() => Effect.succeed(null)));

  const createProject: SymphonyOrchestratorShape["createProject"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const project = yield* projects.create({
            id: input.id,
            codeProjectId: input.codeProjectId,
            title: input.title,
            repositoryPath: input.repositoryPath,
            status: "paused",
            setupState: "ready",
            configuration: input.configuration,
            revision: 0,
            legacyWorkflowId: null,
            createdAt: input.now,
            updatedAt: input.now,
          });
          yield* syncProjectWorkflow(project);
          return project;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new SymphonyPersistenceSqlError({
              operation: "SymphonyOrchestrator.createProject",
              detail: "Project transaction failed",
              cause,
            }),
          ),
        ),
      );

  const updateProject: SymphonyOrchestratorShape["updateProject"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* projects.getById(input.projectId);
          if (current === null) return { _tag: "not_found" } as const;
          const configuration = input.configuration ?? current.configuration;
          const updated = yield* projects.update(
            {
              ...current,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
              ...(input.status === undefined ? {} : { status: input.status }),
              setupState:
                configuration === null || current.codeProjectId === null ? "needs_setup" : "ready",
              updatedAt: input.now,
            },
            input.expectedRevision,
          );
          if (updated === null) return { _tag: "revision_conflict" } as const;
          yield* syncProjectWorkflow(updated);
          return { _tag: "updated", project: updated } as const;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new SymphonyPersistenceSqlError({
              operation: "SymphonyOrchestrator.updateProject",
              detail: "Project transaction failed",
              cause,
            }),
          ),
        ),
      );

  const getProjectSourceControl: SymphonyOrchestratorShape["getProjectSourceControl"] = (
    projectId,
  ) =>
    Effect.gen(function* () {
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return project === null ? null : yield* resolveProjectSourceControl(project.repositoryPath);
    });

  const getProjectBoard: SymphonyOrchestratorShape["getProjectBoard"] = (projectId) =>
    Effect.gen(function* () {
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (project === null) return null;
      const workItemsForProject = yield* workItems
        .listByLifecycle(ALL_WORK_LIFECYCLES, { projectId, limit: 1_000 })
        .pipe(Effect.catch(() => Effect.succeed([])));
      const sourceControl = yield* resolveProjectSourceControl(project.repositoryPath);
      return projectBoardFromWorkItems({
        project,
        sourceControl,
        workItems: workItemsForProject,
        generatedAt: yield* nowIso,
      });
    });

  const listWorkflows: SymphonyOrchestratorShape["listWorkflows"] = () =>
    workflows.list().pipe(Effect.catch(() => Effect.succeed([])));

  const listTrackerHealth: SymphonyOrchestratorShape["listTrackerHealth"] = () =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      return [...state.trackerHealth];
    });

  const isPaused: SymphonyOrchestratorShape["isPaused"] = () =>
    orchestratorState.isGlobalPaused().pipe(Effect.catch(() => Effect.succeed(false)));

  const getWorkflow: SymphonyOrchestratorShape["getWorkflow"] = (workflowId) =>
    workflows.getById(WorkflowId.make(workflowId)).pipe(Effect.catch(() => Effect.succeed(null)));

  const listTrackers: SymphonyOrchestratorShape["listTrackers"] = () =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      return [...state.trackerHealth];
    });

  const listHistory: SymphonyOrchestratorShape["listHistory"] = (filter) =>
    listRuns({
      ...(filter?.projectId === undefined ? {} : { projectId: filter.projectId }),
      limit: 1_000,
    }).pipe(
      Effect.map((runs) =>
        runs
          .filter((run) => RUN_TERMINAL_STATUSES.has(run.status))
          .slice(0, filter?.limit ?? runs.length),
      ),
      Effect.catch(() => Effect.succeed([])),
    );

  const resolveAttention: SymphonyOrchestratorShape["resolveAttention"] = (
    attentionItemId,
    resolution,
  ) =>
    attentionRepository
      .resolve(AttentionItemId.make(attentionItemId), resolution)
      .pipe(Effect.catch(() => Effect.succeed(false)));

  const isWorkflowPaused: SymphonyOrchestratorShape["isWorkflowPaused"] = (workflowId) =>
    orchestratorState.isWorkflowPaused(workflowId).pipe(Effect.catch(() => Effect.succeed(false)));

  const setWorkflowPaused: SymphonyOrchestratorShape["setWorkflowPaused"] = (workflowId, paused) =>
    orchestratorState.setWorkflowPaused(workflowId, paused).pipe(Effect.catch(() => Effect.void));

  const isRepositoryPaused: SymphonyOrchestratorShape["isRepositoryPaused"] = (repositoryPath) =>
    orchestratorState
      .isRepositoryPaused(repositoryPath)
      .pipe(Effect.catch(() => Effect.succeed(false)));

  const setRepositoryPaused: SymphonyOrchestratorShape["setRepositoryPaused"] = (
    repositoryPath,
    paused,
  ) =>
    orchestratorState
      .setRepositoryPaused(repositoryPath, paused)
      .pipe(Effect.catch(() => Effect.void));

  const setGlobalPaused: SymphonyOrchestratorShape["setGlobalPaused"] = (paused) =>
    orchestratorState.setGlobalPaused(paused).pipe(Effect.catch(() => Effect.void));

  const stopAllRuns: SymphonyOrchestratorShape["stopAllRuns"] = () =>
    dispatcher.stopAllRuns().pipe(Effect.catch(() => Effect.succeed(0)));

  const excludeWorkItem: SymphonyOrchestratorShape["excludeWorkItem"] = (workItemId, exclude) =>
    workItems
      .writeOverrides(WorkItemId.make(workItemId), { excluded: exclude })
      .pipe(Effect.catch(() => Effect.void));

  const includeWorkItem: SymphonyOrchestratorShape["includeWorkItem"] = (workItemId) =>
    workItems
      .writeOverrides(WorkItemId.make(workItemId), { excluded: false })
      .pipe(Effect.catch(() => Effect.void));

  const setLocalPriority: SymphonyOrchestratorShape["setLocalPriority"] = (workItemId, priority) =>
    workItems
      .writeOverrides(WorkItemId.make(workItemId), { localPriority: priority })
      .pipe(Effect.catch(() => Effect.void));

  /**
   * Review context for a continuation dispatch (plan FR-102-104, section 14).
   * The item's stored PR evidence is the source of truth here — it was just
   * refreshed by `refreshPullRequest`, which is what pulled the item out of
   * ready_for_review in the first place when it detected feedback. Returns
   * `undefined` when there is no outstanding feedback to report (the common
   * case for a normal first dispatch), so callers can spread it in without an
   * explicit `| undefined` on the wire.
   */
  const buildReviewFeedback = (
    item: WorkItem,
    config: EffectiveWorkflowConfig,
  ): Effect.Effect<ReviewFeedbackContext | undefined> =>
    Effect.gen(function* () {
      const bundle = yield* evidenceRepository
        .getByWorkItem(item.id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const pullRequest = bundle?.pullRequest ?? null;
      if (pullRequest === null) {
        return undefined;
      }
      const unresolvedCommentCount = pullRequest.unresolvedComments ?? 0;
      if (pullRequest.reviewState !== "changes_requested" && unresolvedCommentCount === 0) {
        return undefined;
      }
      // Comment bodies are GitHub-only (plan 10.1); other hosts (and a
      // failed fetch) degrade to counts-only rather than fabricating an
      // empty list that would read as "no comments".
      const comments = yield* pullRequestService
        .listUnresolvedComments({ config, pullRequestNumber: pullRequest.number })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return {
        unresolvedCommentCount,
        reviewState: pullRequest.reviewState ?? "none",
        ...(pullRequest.latestCommit !== undefined
          ? { latestCommit: pullRequest.latestCommit }
          : {}),
        ...(comments !== null ? { comments } : {}),
      } satisfies ReviewFeedbackContext;
    });

  const prepareDispatch = Effect.fn("symphonyOrchestrator.prepareDispatch")(function* (
    workItemId: string,
  ): Effect.fn.Return<PreparedDispatch | null> {
    // Advisory-lock gate: followers observe but never claim or run work.
    if (!acquiredLock) {
      return null;
    }
    const item = yield* workItems
      .getById(WorkItemId.make(workItemId))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (
      item === null ||
      item.lifecycle === "preparing" ||
      item.lifecycle === "running" ||
      item.lifecycle === "testing"
    ) {
      return null;
    }
    if (item.lifecycle === "changes_requested") {
      const requeued = yield* workItems
        .transition(item.id, "queued", { from: ["changes_requested"] })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!requeued) {
        return null;
      }
    }

    const paused = yield* orchestratorState
      .isGlobalPaused()
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (paused) {
      return null;
    }
    if (item.workflowId !== undefined) {
      const workflowPaused = yield* orchestratorState
        .isWorkflowPaused(String(item.workflowId))
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (workflowPaused) {
        return null;
      }
    }
    if (item.repositoryPath !== undefined) {
      const repositoryPaused = yield* orchestratorState
        .isRepositoryPaused(item.repositoryPath)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (repositoryPaused) {
        return null;
      }
    }
    if (item.excluded === true || item.eligibilityReasons.length > 0) {
      return null;
    }

    const workflow = yield* workflows
      .list()
      .pipe(Effect.map((all) => all.find((record) => record.id === item.workflowId)))
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const config = workflow?.effectiveConfig;
    if (
      workflow === undefined ||
      config === null ||
      config === undefined ||
      config.autonomy === "observe"
    ) {
      return null;
    }

    const inFlightItems = yield* workItems
      .listByLifecycle(["preparing", "running", "waiting_for_approval"])
      .pipe(Effect.catch(() => Effect.succeed([] as WorkItem[])));
    const globalCap = config.concurrencyGlobal ?? WORKFLOW_DEFAULTS.concurrencyGlobal;
    if (globalCap > 0 && inFlightItems.length >= globalCap) {
      return null;
    }
    const repoCap = config.concurrencyRepository ?? 0;
    if (
      repoCap > 0 &&
      inFlightItems.filter((other) => other.repositoryPath === item.repositoryPath).length >=
        repoCap
    ) {
      return null;
    }
    const workflowCap = config.concurrencyWorkflow ?? 0;
    if (
      workflowCap > 0 &&
      item.workflowId !== undefined &&
      inFlightItems.filter((other) => other.workflowId === item.workflowId).length >= workflowCap
    ) {
      return null;
    }

    const issue = yield* refreshIssueSnapshot(item, config, registry, enablement);
    if (issue === null) {
      return null;
    }
    const reviewFeedback = yield* buildReviewFeedback(item, config);
    const workflowInstructions = workflow.definition.promptTemplate.trim();
    return {
      item,
      issue,
      config,
      ...(workflowInstructions.length > 0 ? { workflowInstructions } : {}),
      ...(reviewFeedback !== undefined ? { reviewFeedback } : {}),
    };
  });

  const executePreparedDispatch = Effect.fn("symphonyOrchestrator.executePreparedDispatch")(
    function* (prepared: PreparedDispatch) {
      yield* dispatcher
        .dispatchWorkItem({
          workItem: prepared.item,
          issue: prepared.issue,
          config: prepared.config,
          ...(prepared.workflowInstructions !== undefined
            ? { workflowInstructions: prepared.workflowInstructions }
            : {}),
          ...(prepared.reviewFeedback !== undefined
            ? { reviewFeedback: prepared.reviewFeedback }
            : {}),
        })
        .pipe(Effect.catch(() => Effect.void));
      yield* auditRepository
        .record({
          actor: "symphony",
          eventType: "work_item_dispatched",
          workItemId: String(prepared.item.id),
          payload: { objective: prepared.item.objective },
        })
        .pipe(Effect.catch(() => Effect.void));
    },
  );

  const launchNextQueuedWork = Effect.fn("symphonyOrchestrator.launchNextQueuedWork")(function* () {
    const candidates = yield* workItems
      .listByLifecycle(["queued"], { limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed([] as WorkItem[])));
    for (const candidate of candidates) {
      const prepared = yield* prepareDispatch(String(candidate.id));
      if (prepared === null) {
        continue;
      }
      yield* executePreparedDispatch(prepared).pipe(
        Effect.scoped,
        Effect.forkIn(dispatchScope),
        Effect.asVoid,
      );
      return;
    }
  });

  const dispatchWorkItem: SymphonyOrchestratorShape["dispatchWorkItem"] = (workItemId) =>
    prepareDispatch(workItemId).pipe(
      Effect.flatMap((prepared) =>
        prepared === null ? Effect.void : executePreparedDispatch(prepared),
      ),
    );

  const cancelRun: SymphonyOrchestratorShape["cancelRun"] = (runAttemptId) =>
    Effect.gen(function* () {
      yield* dispatcher
        .cancelRun(RunAttemptId.make(runAttemptId))
        .pipe(Effect.catch(() => Effect.void));
      yield* auditRepository
        .record({
          actor: "symphony",
          eventType: "run_cancelled",
          runAttemptId,
        })
        .pipe(Effect.catch(() => Effect.void));
      yield* notifications
        .publish({
          kind: "run_failed",
          title: "Run cancelled",
          message: `Run ${runAttemptId} was cancelled.`,
          runAttemptId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.catch(() => Effect.void));
    });

  /**
   * FR-102-104: pull a review-ready item back out of ready_for_review when a
   * fresh PR refresh shows a reviewer requested changes, or unresolved
   * comments that were NOT present in the last stored snapshot. Reuses the
   * exact requestChanges transition (ready_for_review -> changes_requested),
   * so the item becomes claimable again the same way a human-initiated
   * request does — `dispatchWorkItem` already requeues changes_requested
   * items on the next claim (REVIEW P1 #5).
   *
   * The comparison is always against the STORED snapshot passed in as
   * `previous`, never merely "is the fresh count > 0": otherwise every
   * refresh on an already-flagged PR would re-trigger the same transition on
   * every poll. Once the item leaves ready_for_review the `from` guard on
   * the transition makes every later call here a no-op regardless of what
   * the host reports, which is the idempotency this exists to guarantee.
   */
  const ingestReviewFeedback = (
    id: WorkItemId,
    previous: PullRequestEvidence | null,
    fresh: PullRequestEvidence,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const previousUnresolved = previous?.unresolvedComments ?? 0;
      const freshUnresolved = fresh.unresolvedComments ?? 0;
      const newChangesRequested =
        fresh.reviewState === "changes_requested" && previous?.reviewState !== "changes_requested";
      const newUnresolvedComments = freshUnresolved > previousUnresolved;
      if (!newChangesRequested && !newUnresolvedComments) {
        return;
      }
      const changed = yield* workItems
        .transition(id, "changes_requested", { from: ["ready_for_review"] })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!changed) {
        return;
      }
      const attempt = yield* runAttempts
        .latestForWorkItem(id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (attempt !== null) {
        yield* runEvents
          .append(attempt.id, "changes_requested", {
            workItemId: String(id),
            reason: "review feedback detected",
            reviewState: fresh.reviewState,
            unresolvedComments: freshUnresolved,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      yield* auditRepository
        .record({
          actor: "symphony",
          eventType: "review_feedback_detected",
          workItemId: String(id),
          payload: {
            reviewState: fresh.reviewState ?? "none",
            unresolvedComments: freshUnresolved,
          },
        })
        .pipe(Effect.catch(() => Effect.void));
    });

  const refreshPullRequest: SymphonyOrchestratorShape["refreshPullRequest"] = (workItemId) =>
    Effect.gen(function* () {
      const id = WorkItemId.make(workItemId);
      const item = yield* workItems.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
      if (item === null) {
        return false;
      }
      const workflow =
        item.workflowId === undefined
          ? undefined
          : yield* workflows.list().pipe(
              Effect.map((all) => all.find((w) => w.id === item.workflowId)),
              Effect.catch(() => Effect.succeed(undefined)),
            );
      const config = workflow?.effectiveConfig;
      const workspaceKey = item.workspaceKey;
      const baseBranch = item.baseBranch;
      if (
        config === null ||
        config === undefined ||
        workspaceKey === undefined ||
        baseBranch === undefined
      ) {
        return false;
      }
      const branch = deriveWorkingBranch(workspaceKey);
      const refreshed = yield* pullRequestService
        .refresh({
          config,
          branch,
          baseBranch,
          title: item.objective,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (refreshed === null) {
        return false;
      }
      const bundle = yield* evidenceRepository
        .getByWorkItem(id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (bundle === null) {
        return false;
      }
      // Snapshot the PR evidence as it stood BEFORE this refresh (plan
      // FR-102-104): the ingestion decision compares against this snapshot,
      // not just the freshly-fetched status, which is what keeps repeated
      // refreshes with no new signal from re-dispatching in a loop.
      const previousPullRequest = bundle.pullRequest;
      yield* evidenceRepository
        .upsert(id, { ...bundle, pullRequest: refreshed })
        .pipe(Effect.catch(() => Effect.succeed(false)));

      yield* ingestReviewFeedback(id, previousPullRequest, refreshed);

      return true;
    });

  const requestChanges: SymphonyOrchestratorShape["requestChanges"] = (workItemId, reason) =>
    Effect.gen(function* () {
      const id = WorkItemId.make(workItemId);
      // The transition carries the expected lifecycle so a concurrent
      // approveMerge cannot double-write (REVIEW P1 #4: read-then-update was
      // non-atomic and one could overwrite the other).
      const changed = yield* workItems
        .transition(id, "changes_requested", { from: ["ready_for_review"] })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (changed) {
        const attempt = yield* runAttempts
          .latestForWorkItem(id)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (attempt !== null) {
          yield* runEvents
            .append(attempt.id, "changes_requested", {
              workItemId: String(id),
              ...(reason !== undefined ? { reason } : {}),
            })
            .pipe(Effect.catch(() => Effect.void));
        }
      }
      return changed;
    });

  const approveMerge: SymphonyOrchestratorShape["approveMerge"] = (workItemId) =>
    Effect.gen(function* () {
      const id = WorkItemId.make(workItemId);
      const item = yield* workItems.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
      if (item === null) {
        return false;
      }
      // The transition carries the expected lifecycle so a concurrent
      // requestChanges cannot double-write (REVIEW P1 #4). The merge-gate
      // evidence must be current: re-read it after the item check, and
      // transition only from ready_for_review.
      if (item.lifecycle !== "ready_for_review") {
        return false;
      }
      // Merge gate evidence must be FRESH: a stored or cached PR status is
      // display data, not proof of readiness (RECONCILE binding constraint;
      // plan 10.1/FR-095). Re-query the host before gating.
      const workflow =
        item.workflowId === undefined
          ? undefined
          : yield* workflows.list().pipe(
              Effect.map((all) => all.find((w) => w.id === item.workflowId)),
              Effect.catch(() => Effect.succeed(undefined)),
            );
      const config = workflow?.effectiveConfig;
      const workspaceKey = item.workspaceKey;
      const baseBranch = item.baseBranch;
      if (
        config === null ||
        config === undefined ||
        workspaceKey === undefined ||
        baseBranch === undefined
      ) {
        return false;
      }
      const branch = deriveWorkingBranch(workspaceKey);
      const freshPullRequest = yield* pullRequestService
        .refresh({
          config,
          branch,
          baseBranch,
          title: item.objective,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (freshPullRequest === null) {
        return false;
      }
      // Persist the refreshed evidence so the review panel shows what the
      // gate decided on.
      const storedEvidence = yield* evidenceRepository
        .getByWorkItem(id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (storedEvidence !== null) {
        yield* evidenceRepository
          .upsert(id, { ...storedEvidence, pullRequest: freshPullRequest })
          .pipe(Effect.catch(() => Effect.void));
      }
      // Merge policy (plan 14): required checks must pass; unresolved review
      // comments block merge; automatic merge is never performed here. A run
      // is only merge-ready when its evidence assessment is at least
      // ready_for_review and no failed validation stands. The bundle lives in
      // the EvidenceRepository (the work item row does not carry it).
      const evidence = storedEvidence;
      if (evidence === null) {
        return false;
      }
      if (
        evidence.overallAssessment === "failed" ||
        evidence.overallAssessment === "insufficient"
      ) {
        return false;
      }
      if (!modelReviewAllowsMerge(config, evidence, freshPullRequest)) {
        return false;
      }
      // Host-enriched merge gates (plan 14, FR-095; REVIEW P0 "approveMerge
      // inverts FR-095"). Merge readiness requires POSITIVE host evidence:
      // a real PR, a success CI status, a review decision that is present and
      // not changes-requested, and a mergeable PR. Absent enrichment (hosts
      // without Phase 5 enrichment) or a missing PR caps at ready_for_review
      // — a run is never promoted on the absence of a signal.
      const pullRequest = freshPullRequest;
      if (pullRequest === null) {
        return false;
      }
      if (pullRequest.ciStatus !== "success") {
        return false;
      }
      if (
        pullRequest.reviewState === undefined ||
        pullRequest.reviewState === "changes_requested"
      ) {
        return false;
      }
      // Tri-state mergeability (audit item 5): only a confirmed mergeable
      // PR passes; conflicting and unknown both refuse.
      if (pullRequest.mergeable !== "mergeable") {
        return false;
      }
      if (pullRequest.unresolvedComments === undefined || pullRequest.unresolvedComments > 0) {
        return false;
      }
      const changed = yield* workItems
        .transition(id, "ready_to_merge", { from: ["ready_for_review"] })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (changed) {
        const attempt = yield* runAttempts
          .latestForWorkItem(id)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (attempt !== null) {
          yield* runEvents
            .append(attempt.id, "merge_approved", { workItemId: String(id) })
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* auditRepository
          .record({
            actor: "symphony",
            eventType: "merge_approved",
            workItemId: String(id),
          })
          .pipe(Effect.catch(() => Effect.void));
        yield* notifications
          .publish({
            kind: "merge_approved",
            title: "Merge approved",
            message: `Work item ${String(id)} approved for merge.`,
            workItemId: String(id),
            createdAt: yield* nowIso,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      return changed;
    });

  // Start background work only after every scheduler callback has been
  // initialized. This avoids a construction-time race with the first tick.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      if (acquiredLock) {
        yield* Effect.acquireRelease(Effect.void, () =>
          orchestratorState.releaseLock(lockToken).pipe(Effect.catch(() => Effect.void)),
        );
      }
      yield* Effect.forkScoped(
        Effect.repeat(
          orchestratorState
            .renewLock({ ownerToken: lockToken, leaseMs: lockLeaseMs })
            .pipe(Effect.catch(() => Effect.void)),
          Schedule.spaced("30 seconds"),
        ),
      );
      yield* scheduler;
    }),
  );

  return {
    refreshNow,
    getOverview,
    listQueue,
    listRuns,
    getRun,
    listProjects,
    getProject,
    createProject,
    updateProject,
    getProjectSourceControl,
    getProjectBoard,
    listRunEvents,
    listAttention,
    listWorkflows,
    listTrackerHealth,
    isPaused,
    getWorkflow,
    listTrackers,
    listHistory,
    resolveAttention,
    isWorkflowPaused,
    setWorkflowPaused,
    isRepositoryPaused,
    setRepositoryPaused,
    setGlobalPaused,
    stopAllRuns,
    excludeWorkItem,
    includeWorkItem,
    setLocalPriority,
    dispatchWorkItem,
    cancelRun,
    requestChanges,
    approveMerge,
    refreshPullRequest,
  } satisfies SymphonyOrchestratorShape;
});

export const SymphonyOrchestratorLive = Layer.effect(SymphonyOrchestrator, makeOrchestrator);

export { pollWorkflow, buildQueueItem, modelReviewAllowsMerge, providerForRemoteUrl };
