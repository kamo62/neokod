import type { EffectiveWorkflowConfig, WorkItem, WorkflowRecord } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  WorkflowId,
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
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "../Persistence/Layers/WorkflowRepository.ts";
import { RunDispatcher } from "../Runner/Dispatcher.ts";
import { runStartupRecovery } from "./Recovery.ts";

const makeConfig = (repositoryPath: string): EffectiveWorkflowConfig => ({
  repositoryPath,
  workflowPath: `${repositoryPath}/WORKFLOW.md`,
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
  validationRequired: [],
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
  maxAttempts: 5,
});

const makeWorkItem = (id: string, lifecycle: WorkItem["lifecycle"]): WorkItem => ({
  id: WorkItemId.make(id),
  mode: "symphony",
  objective: `Issue ${id}`,
  acceptanceCriteria: [],
  source: { kind: "manual" },
  trackerIssueId: `manual-${id}`,
  lifecycle,
  priority: 1,
  eligibilityReasons: [],
  evidence: null,
  // A crash orphan has a live claim (audit item 3): recovery only adopts
  // runs a dispatcher actually owned.
  claimedAt: "2026-08-05T00:00:00.000Z",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
});

const seedWorkflow = (repositoryPath: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    const now = yield* nowIso;
    const record: WorkflowRecord = {
      id: WorkflowId.make("wf-1"),
      repositoryPath,
      workflowPath: `${repositoryPath}/WORKFLOW.md`,
      status: "active",
      autonomy: "execute",
      validationError: null,
      definition: { config: {}, promptTemplate: "Implement." },
      effectiveConfig: makeConfig(repositoryPath),
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    };
    yield* workflows.upsert(record);
  });

const seedAttempt = (
  workItemId: WorkItemId,
  status: string,
  attemptNumber = 1,
  startedAt = "2026-08-05T00:00:00.000Z",
  finishedAt: string | null = null,
) =>
  Effect.gen(function* () {
    const runAttempts = yield* RunAttemptRepository;
    yield* runAttempts.create({
      id: RunAttemptId.make(`run-${workItemId}-${startedAt}`),
      workItemId,
      attemptNumber,
      workspacePath: "/ws/1",
      provider: {
        instanceId: ProviderInstanceId.make("codex_default"),
        driver: ProviderDriverKind.make("codex"),
      },
      status: status as never,
      startedAt,
      finishedAt,
      error: null,
    });
  });

const fakeDispatcherIdle = Layer.succeed(RunDispatcher, {
  dispatchWorkItem: () => Effect.never,
  cancelRun: () => Effect.void,
  isAgentActive: () => Effect.succeed(false),
} as RunDispatcher["Service"]);

const layer = it.layer(
  fakeDispatcherIdle.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const runRecovery = () =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const runAttempts = yield* RunAttemptRepository;
    const runEvents = yield* RunEventRepository;
    const workflows = yield* WorkflowRepository;
    const dispatcher = yield* RunDispatcher;
    yield* runStartupRecovery({ workItems, runAttempts, runEvents, workflows, dispatcher });
  });

layer("Recovery startup", (it) => {
  it.effect("lands a succeeded-but-untransited run in ready_for_review, not a re-dispatch", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3001", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(
        workItem.id,
        "succeeded",
        1,
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:05:00.000Z",
      );

      yield* runRecovery();

      const after = yield* WorkItemRepository.pipe(
        Effect.flatMap((repo) => repo.getById(workItem.id)),
      );
      // REVIEW P1 #11: a completed agent must not be re-run; the item lands
      // in its review state instead of being re-dispatched.
      expect(after?.lifecycle).toBe("ready_for_review");
    }),
  );

  it.effect("marks a non-terminal run interrupted and re-schedules it for retry", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3002", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn");

      yield* runRecovery();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("retry_scheduled");

      const runAttempts = yield* RunAttemptRepository;
      const attempt = yield* runAttempts.latestForWorkItem(workItem.id);
      expect(attempt?.status).toBe("interrupted");
      expect(attempt?.finishedAt).not.toBeNull();

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(attempt?.id ?? RunAttemptId.make("none"));
      expect(events.some((event) => event.eventType === "interrupted")).toBe(true);
    }),
  );

  it.effect("releases to queued when the attempt cap is reached", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3003", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn", 5);

      yield* runRecovery();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("queued");
    }),
  );

  it.effect("is idempotent on a second run", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3004", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn");

      yield* runRecovery();
      yield* runRecovery();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("retry_scheduled");
    }),
  );
});
