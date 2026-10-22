import type {
  AttentionItem,
  OrchestrationProject,
  RunAttemptId,
  RunDetails,
  SymphonyOverview,
} from "@neokod/contracts";
import {
  SYMPHONY_WS_METHODS,
  RunAttemptId as RunAttemptIdValue,
  SymphonyProjectId,
  WorkItemId as WorkItemIdValue,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { SymphonyPersistenceSqlError } from "./symphony/Persistence/Errors.ts";

import * as SymphonyOrchestratorModule from "./symphony/Orchestrator/SymphonyOrchestrator.ts";
const SymphonyOrchestrator = SymphonyOrchestratorModule.SymphonyOrchestrator;
import * as ApprovalServiceModule from "./symphony/Runner/ApprovalService.ts";
const ApprovalService = ApprovalServiceModule.ApprovalService;
import * as ProjectionSnapshotQueryModule from "./orchestration/Services/ProjectionSnapshotQuery.ts";
const ProjectionSnapshotQuery = ProjectionSnapshotQueryModule.ProjectionSnapshotQuery;
import * as WorkflowLoaderModule from "./symphony/Workflow/Loader.ts";
const WorkflowLoaderService = WorkflowLoaderModule.WorkflowLoaderService;
import { makeSymphonyRpcHandlers } from "./ws.ts";

const dispatchCalls: Array<{ readonly workItemId: string; readonly explicit: boolean }> = [];

const knownMetric = (value: number): SymphonyOverview["running"] => ({ state: "known", value });

const overview = (): SymphonyOverview => ({
  running: knownMetric(0),
  queued: knownMetric(0),
  needsAttention: knownMetric(0),
  readyForReview: knownMetric(0),
  retrying: knownMetric(0),
  failedToday: knownMetric(0),
  orchestratorPaused: false,
  activeWorkflowCount: knownMetric(0),
  providerHealth: {},
  trackerHealth: {},
  lastTrackerPollAt: null,
  activeAgentCount: knownMetric(0),
  generatedAt: "2026-08-05T00:00:00.000Z",
});

const runDetails = (id: RunAttemptId): RunDetails => ({
  runAttempt: {
    id,
    workItemId: "wi-1" as never,
    attemptNumber: 1,
    workspacePath: "/ws/1",
    provider: { instanceId: "codex_default" as never, driver: "codex" as never },
    status: "streaming_turn",
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: null,
    error: null,
  },
  timeline: [],
  attentionItems: [],
  approvalRequests: [],
  workItem: {
    id: "wi-1" as never,
    mode: "symphony",
    objective: "Issue 1",
    acceptanceCriteria: [],
    source: { kind: "manual" },
    lifecycle: "running",
    priority: 1,
    eligibilityReasons: [],
    evidence: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  },
});

const attentionItem = (id: string): AttentionItem => ({
  id: id as AttentionItem["id"],
  workItemId: "wi-1" as never,
  runAttemptId: RunAttemptIdValue.make("run-1"),
  kind: "command_approval",
  severity: "high",
  state: "open",
  whatHappened: "The agent requests command_execution.",
  whyHuman: "This action is gated by the workflow approval policy.",
  availableActions: ["approve", "reject"],
  createdAt: "2026-08-05T00:00:00.000Z",
  resolvedAt: null,
});

const fakeOrchestratorLayer = Layer.succeed(SymphonyOrchestrator, {
  refreshNow: () => Effect.void,
  getOverview: () => Effect.succeed(overview()),
  listQueue: () => Effect.succeed([]),
  listRuns: () => Effect.succeed([]),
  getRun: (runAttemptId: string) =>
    runAttemptId === "run-1"
      ? Effect.succeed(runDetails(RunAttemptIdValue.make("run-1")))
      : Effect.succeed(null),
  listAttention: () => Effect.succeed([attentionItem("attn-1"), attentionItem("attn-2")]),
  listWorkflows: () => Effect.succeed([]),
  listTrackerHealth: () => Effect.succeed([]),
  listApprovals: () => Effect.succeed([]),
  isPaused: () => Effect.succeed(false),
  excludeWorkItem: () => Effect.void,
  includeWorkItem: () => Effect.void,
  setLocalPriority: () => Effect.void,
  dispatchWorkItem: (workItemId: string) =>
    Effect.sync(() => {
      dispatchCalls.push({ workItemId, explicit: true });
    }).pipe(Effect.as({ status: "started" } as const)),
  cancelRun: (runAttemptId: string) =>
    Effect.logInfo(`cancelled ${runAttemptId}`).pipe(Effect.asVoid),
  listQueuesForRepository: () => Effect.succeed([]),
} as unknown as (typeof SymphonyOrchestrator)["Service"]);

const fakeApprovalsLayer = Layer.succeed(ApprovalService, {
  recordPending: () => Effect.never,
  approve: (requestId: string) => Effect.logInfo(`approved ${requestId}`).pipe(Effect.asVoid),
  reject: (requestId: string) => Effect.logInfo(`rejected ${requestId}`).pipe(Effect.asVoid),
  respondToUserInput: () => Effect.void,
  listPending: () => Effect.succeed([]),
  listForRun: () => Effect.succeed([]),
  expire: () => Effect.void,
  interrupt: () => Effect.void,
  expireRequest: () => Effect.succeed(false),
} as (typeof ApprovalService)["Service"]);

const failingBoardOrchestratorLayer = Layer.succeed(SymphonyOrchestrator, {
  getProjectBoard: () =>
    Effect.fail(new SymphonyPersistenceSqlError({ operation: "test", detail: "disk I/O error" })),
} as unknown as (typeof SymphonyOrchestrator)["Service"]);

it.layer(failingBoardOrchestratorLayer)("Symphony WS RPC handlers - board read failure", (it) => {
  const expectBoardUnavailable = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      expect(failure).toMatchObject({
        _tag: "SymphonyError",
        code: "symphony_board_unavailable",
      });
    }
  };

  it.effect("getProjectBoard maps a read failure to symphony_board_unavailable", () =>
    Effect.gen(function* () {
      const handlers = makeSymphonyRpcHandlers();
      const exit = yield* Effect.exit(
        Effect.scoped(
          handlers[SYMPHONY_WS_METHODS.getProjectBoard]({
            projectId: SymphonyProjectId.make("p1"),
          }),
        ),
      );
      expectBoardUnavailable(exit);
    }),
  );

  it.effect("subscribeProjectBoard maps a read failure to symphony_board_unavailable", () =>
    Effect.gen(function* () {
      const handlers = makeSymphonyRpcHandlers();
      const exit = yield* Effect.exit(
        Stream.runCollect(
          handlers[SYMPHONY_WS_METHODS.subscribeProjectBoard]({
            projectId: SymphonyProjectId.make("p1"),
          }),
        ),
      );
      expectBoardUnavailable(exit);
    }),
  );
});

const refusedDispatchOrchestratorLayer = Layer.succeed(SymphonyOrchestrator, {
  dispatchWorkItem: () =>
    Effect.succeed({ status: "refused", reason: "paused", detail: "global" } as const),
} as unknown as (typeof SymphonyOrchestrator)["Service"]);

it.layer(refusedDispatchOrchestratorLayer)("Symphony WS RPC handlers - refused dispatch", (it) => {
  it.effect("dispatchWorkItem passes a refusal through unchanged", () =>
    Effect.gen(function* () {
      const handlers = makeSymphonyRpcHandlers();
      const handler = handlers[SYMPHONY_WS_METHODS.dispatchWorkItem];
      const result = yield* Effect.scoped(handler({ workItemId: WorkItemIdValue.make("wi-1") }));
      expect(result).toEqual({ status: "refused", reason: "paused", detail: "global" });
    }),
  );
});

it.layer(Layer.empty)("Symphony WS RPC handlers - approval layer absent", (it) => {
  const expectApprovalUnavailable = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      expect(failure).toMatchObject({
        _tag: "SymphonyError",
        code: "symphony_unavailable",
      });
      if (failure instanceof Error) {
        expect(failure.message).toContain("approval");
      }
    }
  };

  it.effect("approve fails with a typed error instead of reporting success", () =>
    Effect.gen(function* () {
      const handlers = makeSymphonyRpcHandlers();
      const exit = yield* Effect.exit(
        Effect.scoped(
          handlers[SYMPHONY_WS_METHODS.approve]({
            requestId: "approval-1",
            scope: "once",
          }),
        ),
      );
      expectApprovalUnavailable(exit);
    }),
  );

  it.effect("reject fails with a typed error instead of reporting success", () =>
    Effect.gen(function* () {
      const handlers = makeSymphonyRpcHandlers();
      const exit = yield* Effect.exit(
        Effect.scoped(handlers[SYMPHONY_WS_METHODS.reject]({ requestId: "approval-1" })),
      );
      expectApprovalUnavailable(exit);
    }),
  );

  it.effect("respondToUserInput fails with a typed error instead of reporting success", () =>
    Effect.gen(function* () {
      const handlers = makeSymphonyRpcHandlers();
      const exit = yield* Effect.exit(
        Effect.scoped(
          handlers[SYMPHONY_WS_METHODS.respondToUserInput]({
            requestId: "approval-1",
            text: "answer",
          }),
        ),
      );
      expectApprovalUnavailable(exit);
    }),
  );
});

it.layer(fakeOrchestratorLayer.pipe(Layer.provideMerge(fakeApprovalsLayer)))(
  "Symphony WS RPC handlers",
  (it) => {
    it.effect("dispatchWorkItem calls through to the orchestrator", () =>
      Effect.gen(function* () {
        dispatchCalls.length = 0;
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.dispatchWorkItem];
        expect(handler).toBeDefined();
        const result = yield* Effect.scoped(handler({ workItemId: WorkItemIdValue.make("wi-1") }));
        expect(result).toEqual({ status: "started" });
        expect(dispatchCalls).toEqual([{ workItemId: "wi-1", explicit: true }]);
      }),
    );

    it.effect("cancelRun calls through to the orchestrator", () =>
      Effect.gen(function* () {
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.cancelRun];
        expect(handler).toBeDefined();
        const result = yield* Effect.scoped(
          handler({ runAttemptId: RunAttemptIdValue.make("run-1") }),
        );
        expect(result).toEqual({ ok: true });
      }),
    );

    it.effect("getRun returns details for a known run and null otherwise", () =>
      Effect.gen(function* () {
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.getRun];
        expect(handler).toBeDefined();
        const known = yield* Effect.scoped(
          handler({ runAttemptId: RunAttemptIdValue.make("run-1") }),
        );
        expect(known?.runAttempt.status).toBe("streaming_turn");
        const unknown = yield* Effect.scoped(
          handler({ runAttemptId: RunAttemptIdValue.make("run-missing") }),
        );
        expect(unknown).toBeNull();
      }),
    );

    it.effect("listAttention returns attention items", () =>
      Effect.gen(function* () {
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.listAttention];
        expect(handler).toBeDefined();
        const attention = yield* Effect.scoped(handler({}));
        expect(attention.map((item) => item.id)).toEqual(["attn-1", "attn-2"]);
      }),
    );
  },
);

// createWorkflow: repositoryPath is client-supplied (unlike every other
// workflow RPC, which resolves paths from a persisted WorkflowRecord), so
// it needs a fake ProjectionSnapshotQuery standing in for "the projects the
// server knows about" to prove untracked paths are refused before the
// WorkflowLoaderService is ever reached.
const TRACKED_REPOSITORY_PATH = "/tracked/repo";

const fakeProjectionSnapshotQueryLayer = Layer.succeed(ProjectionSnapshotQuery, {
  getActiveProjectByWorkspaceRoot: (workspaceRoot: string) =>
    Effect.succeed(
      workspaceRoot === TRACKED_REPOSITORY_PATH
        ? Option.some({ workspaceRoot } as unknown as OrchestrationProject)
        : Option.none(),
    ),
} as unknown as (typeof ProjectionSnapshotQuery)["Service"]);

const fakeWorkflowLoaderLayer = Layer.succeed(WorkflowLoaderService, {
  createWorkflow: (input: { repositoryPath: string; content: string }) =>
    Effect.succeed(
      input.content === "invalid"
        ? { workflowId: "wf-created", validationError: "tracker.kind: unsupported tracker" }
        : { workflowId: "wf-created" },
    ),
} as unknown as (typeof WorkflowLoaderService)["Service"]);

it.layer(fakeProjectionSnapshotQueryLayer.pipe(Layer.provideMerge(fakeWorkflowLoaderLayer)))(
  "Symphony WS RPC handlers - createWorkflow",
  (it) => {
    it.effect("refuses a repositoryPath that is not a tracked project", () =>
      Effect.gen(function* () {
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.createWorkflow];
        const outcome = yield* Effect.result(
          Effect.scoped(handler({ repositoryPath: "/untracked/repo", content: "content" })),
        );
        expect(outcome._tag).toBe("Failure");
      }),
    );

    it.effect("creates the workflow when repositoryPath is a tracked project", () =>
      Effect.gen(function* () {
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.createWorkflow];
        const result = yield* Effect.scoped(
          handler({ repositoryPath: TRACKED_REPOSITORY_PATH, content: "ok" }),
        );
        expect(result).toEqual({ ok: true, workflowId: "wf-created" });
      }),
    );

    it.effect("surfaces validationError inline instead of failing the RPC", () =>
      Effect.gen(function* () {
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.createWorkflow];
        const result = yield* Effect.scoped(
          handler({ repositoryPath: TRACKED_REPOSITORY_PATH, content: "invalid" }),
        );
        expect(result).toEqual({
          ok: true,
          workflowId: "wf-created",
          validationError: "tracker.kind: unsupported tracker",
        });
      }),
    );
  },
);
