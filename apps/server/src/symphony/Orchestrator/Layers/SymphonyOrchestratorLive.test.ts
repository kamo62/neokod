import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";
import {
  WorkflowId,
  WorkItemId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunAttemptId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { nowIso } from "../../Domain/Time.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { WorkflowRepository } from "../../Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "../../Persistence/Layers/WorkflowRepository.ts";
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
import { TrackerRegistryWithFactories } from "../../Trackers/Registry.ts";
import { makeMemoryTrackerAdapter } from "../../Trackers/MemoryAdapter.ts";
import { TrackerEnablementLive } from "../TrackerEnablement.ts";
import { SymphonyOrchestrator } from "../SymphonyOrchestrator.ts";
import { SymphonyOrchestratorLive } from "./SymphonyOrchestratorLive.ts";
import { RunDispatcher } from "../../Runner/Dispatcher.ts";
import { layerTest as serverSettingsTestLayer } from "../../../serverSettings.ts";

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

const memoryFactory = (_provider: Readonly<Record<string, unknown>>) =>
  makeMemoryTrackerAdapter({
    issues: [makeIssue("1"), makeIssue("2", "closed"), makeIssue("3", "open", [])],
    activeStates: ["open"],
    terminalStates: ["closed"],
  });

const registryLayer = TrackerRegistryWithFactories(new Map([["github", memoryFactory]]));

const mockDispatcherLayer = Layer.succeed(RunDispatcher, {
  dispatchWorkItem: () => Effect.succeed("run-mock" as RunAttemptId),
  cancelRun: () => Effect.void,
  isAgentActive: () => Effect.succeed(false),
} as RunDispatcher["Service"]);

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
    } satisfies ApprovalService["Service"];
  }),
);

const layer = it.layer(
  SymphonyOrchestratorLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(OrchestratorStateRepositoryLive),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(TrackerEnablementLive),
    Layer.provideMerge(mockDispatcherLayer),
    Layer.provideMerge(mockApprovalsLayer),
    Layer.provideMerge(ApprovalRepositoryLive),
    Layer.provideMerge(serverSettingsTestLayer({ trackers: { github: { enabled: true } } })),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedWorkflow = (id: string, repositoryPath: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    const now = yield* nowIso;
    yield* workflows.upsert({
      id: WorkflowId.make(id),
      repositoryPath,
      workflowPath: `${repositoryPath}/WORKFLOW.md`,
      status: "active",
      autonomy: "observe",
      validationError: null,
      definition: { config: {}, promptTemplate: "Implement." },
      effectiveConfig: makeConfig(repositoryPath),
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

layer("SymphonyOrchestrator Observe", (it) => {
  it.effect("polls an active workflow and projects an eligible queue without dispatching", () =>
    Effect.gen(function* () {
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
      expect(byTitle.get("Issue 3")?.lifecycle).toBe("eligible");
      expect(byTitle.get("Issue 3")?.eligible).toBe(false);
      expect(
        byTitle.get("Issue 3")?.ineligibilityReasons.some((r) => r.startsWith("missing_label")),
      ).toBe(true);
      expect(byTitle.get("Issue 2")).toBeUndefined();
    }),
  );

  it.effect("tracks a disabled tracker as unhealthy without erroring", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-observe-2", "/repo/disabled");
      yield* orchestrator.refreshNow();

      const health = yield* orchestrator.listTrackerHealth();
      const github = health.find((h) => h.kind === "github");
      expect(github).toBeDefined();
    }),
  );

  it.effect("overview reports queued count from active workflows", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-observe-3", "/repo/overview");
      yield* orchestrator.refreshNow();
      const overview = yield* orchestrator.getOverview();
      expect(overview.activeWorkflowCount).toBeGreaterThanOrEqual(1);
    }),
  );

  it.effect("listRuns returns seeded attempts newest first with latest event", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-runs-1", "/repo/runs");
      yield* orchestrator.refreshNow();
      const queue = yield* orchestrator.listQueue();
      const eligible = queue.find((item) => item.eligible === true && item.excluded === false);
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

  it.effect("listAttention maps pending approval requests to attention items", () =>
    Effect.gen(function* () {
      const orchestrator = yield* SymphonyOrchestrator;
      yield* seedWorkflow("wf-attention-1", "/repo/attention");
      yield* orchestrator.refreshNow();
      const queue = yield* orchestrator.listQueue();
      const eligible = queue.find((item) => item.eligible === true && item.excluded === false);
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
});
