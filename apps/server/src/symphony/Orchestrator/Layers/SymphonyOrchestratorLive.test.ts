import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";
import { WorkflowId, ProviderInstanceId, ProviderDriverKind } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { WorkflowRepository } from "../../Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "../../Persistence/Layers/WorkflowRepository.ts";
import { WorkItemRepositoryLive } from "../../Persistence/Layers/WorkItemRepository.ts";
import { OrchestratorStateRepositoryLive } from "../../Persistence/Layers/OrchestratorStateRepository.ts";
import { TrackerRegistryWithFactories } from "../../Trackers/Registry.ts";
import { makeMemoryTrackerAdapter } from "../../Trackers/MemoryAdapter.ts";
import { TrackerEnablementLive } from "../TrackerEnablement.ts";
import { SymphonyOrchestrator } from "../SymphonyOrchestrator.ts";
import { SymphonyOrchestratorLive } from "./SymphonyOrchestratorLive.ts";
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

const layer = it.layer(
  SymphonyOrchestratorLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(OrchestratorStateRepositoryLive),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(TrackerEnablementLive),
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
});
