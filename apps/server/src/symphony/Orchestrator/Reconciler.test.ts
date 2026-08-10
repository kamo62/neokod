import type { EffectiveWorkflowConfig, WorkItem, WorkflowRecord } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectId,
  WorkflowId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
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
import { reconcileStaleClaims } from "./Reconciler.ts";

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
  codexStallTimeoutMs: 5_000,
});

const makeWorkItem = (id: string, lifecycle: WorkItem["lifecycle"]): WorkItem => ({
  id: WorkItemId.make(id),
  mode: "symphony",
  projectId: SymphonyProjectId.make("reconciler-project"),
  objective: `Issue ${id}`,
  acceptanceCriteria: [],
  source: { kind: "manual" },
  trackerIssueId: `manual-${id}`,
  lifecycle,
  priority: 1,
  eligibilityReasons: [],
  evidence: null,
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
      autonomy: "observe",
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
  startedAt: string,
  finishedAt: string | null = null,
) =>
  Effect.gen(function* () {
    const runAttempts = yield* RunAttemptRepository;
    yield* runAttempts.create({
      id: RunAttemptId.make(`run-${workItemId}-${startedAt}`),
      workItemId,
      attemptNumber: 1,
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

const fakeDispatcherActive = Layer.succeed(RunDispatcher, {
  dispatchWorkItem: () => Effect.never,
  cancelRun: () => Effect.void,
  isAgentActive: () => Effect.succeed(true),
  stopAllRuns: () => Effect.succeed(0),
} as RunDispatcher["Service"]);

const fakeDispatcherIdle = Layer.succeed(RunDispatcher, {
  dispatchWorkItem: () => Effect.never,
  cancelRun: () => Effect.void,
  isAgentActive: () => Effect.succeed(false),
  stopAllRuns: () => Effect.succeed(0),
} as RunDispatcher["Service"]);

const layer = (dispatcher: Layer.Layer<RunDispatcher>) =>
  it.layer(
    dispatcher.pipe(
      Layer.provideMerge(WorkItemRepositoryLive),
      Layer.provideMerge(RunAttemptRepositoryLive),
      Layer.provideMerge(RunEventRepositoryLive),
      Layer.provideMerge(WorkflowRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const runReconcile = () =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const runAttempts = yield* RunAttemptRepository;
    const runEvents = yield* RunEventRepository;
    const workflows = yield* WorkflowRepository;
    const dispatcher = yield* RunDispatcher;
    yield* reconcileStaleClaims({ workItems, runAttempts, runEvents, workflows, dispatcher });
  });

layer(fakeDispatcherIdle)("Reconciler claim release", (it) => {
  it.effect("releases a claim whose run is already terminal", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2001", "preparing");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(
        workItem.id,
        "user_cancelled",
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:05:00.000Z",
      );

      yield* runReconcile();

      const after = yield* WorkItemRepository.pipe(
        Effect.flatMap((repo) => repo.getById(workItem.id)),
      );
      expect(after?.lifecycle).toBe("queued");
    }),
  );

  it.effect("marks a stale non-terminal run stalled and releases the claim", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2002", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn", "1970-01-01T00:00:00.000Z");
      yield* TestClock.adjust("600000 millis");

      yield* runReconcile();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(after.lifecycle).toBe("queued");

      const runAttempts = yield* RunAttemptRepository;
      const attempt = yield* runAttempts
        .latestForWorkItem(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(attempt.status).toBe("stalled");
      expect(attempt.finishedAt).not.toBeNull();

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(attempt.id);
      expect(events.some((event) => event.eventType === "stalled")).toBe(true);
    }),
  );

  it.effect("leaves a recent non-terminal run alone", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2003", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn", "2099-01-01T00:00:00.000Z");

      yield* runReconcile();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(after.lifecycle).toBe("running");
    }),
  );
});

layer(fakeDispatcherActive)("Reconciler live agent", (it) => {
  it.effect("never touches a run with a live agent", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2004", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn", "2026-08-01T00:00:00.000Z");

      yield* runReconcile();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(after.lifecycle).toBe("running");
    }),
  );
});
