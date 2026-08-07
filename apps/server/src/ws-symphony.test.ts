import type { AttentionItem, RunAttemptId, RunDetails, SymphonyOverview } from "@neokod/contracts";
import {
  SYMPHONY_WS_METHODS,
  RunAttemptId as RunAttemptIdValue,
  WorkItemId as WorkItemIdValue,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SymphonyOrchestratorModule from "./symphony/Orchestrator/SymphonyOrchestrator.ts";
const SymphonyOrchestrator = SymphonyOrchestratorModule.SymphonyOrchestrator;
import * as ApprovalServiceModule from "./symphony/Runner/ApprovalService.ts";
const ApprovalService = ApprovalServiceModule.ApprovalService;
import { makeSymphonyRpcHandlers } from "./ws.ts";

const overview = (): SymphonyOverview => ({
  running: 0,
  queued: 0,
  needsAttention: 0,
  readyForReview: 0,
  retrying: 0,
  failedToday: 0,
  orchestratorPaused: false,
  activeWorkflowCount: 0,
  providerHealth: {},
  trackerHealth: {},
  lastTrackerPollAt: null,
  activeAgentCount: 0,
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
    Effect.logInfo(`dispatched ${workItemId}`).pipe(Effect.asVoid),
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
} as (typeof ApprovalService)["Service"]);

it.layer(fakeOrchestratorLayer.pipe(Layer.provideMerge(fakeApprovalsLayer)))(
  "Symphony WS RPC handlers",
  (it) => {
    it.effect("dispatchWorkItem calls through to the orchestrator", () =>
      Effect.gen(function* () {
        const handlers = makeSymphonyRpcHandlers();
        const handler = handlers[SYMPHONY_WS_METHODS.dispatchWorkItem];
        expect(handler).toBeDefined();
        const result = yield* Effect.scoped(handler({ workItemId: WorkItemIdValue.make("wi-1") }));
        expect(result).toEqual({ ok: true });
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
