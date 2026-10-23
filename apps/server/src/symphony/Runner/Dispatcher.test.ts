import type { EffectiveWorkflowConfig, NormalizedIssue, WorkItem } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectId,
  WorkflowId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import type { ProcessGroupIdentity } from "@neokod/shared/processGroup";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { deriveWorkspaceKey } from "../Domain/Keys.ts";
import { nowIso } from "../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Persistence/Errors.ts";
import type { SymphonyPersistenceError } from "../Persistence/Errors.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "../Persistence/Layers/RunEventRepository.ts";
import { ApprovalRepositoryLive } from "../Persistence/Layers/ApprovalRepository.ts";
import { WorkspaceManager } from "../Workspaces/Manager.ts";
import { WorkspaceOutsideRootError, WorkspacePopulationError } from "../Workspaces/Manager.ts";
import { LiveRequestsLive } from "./LiveRequests.ts";
import {
  AgentRuntimeFactory,
  RunDispatchError,
  RunDispatcher,
  RunDispatcherLive,
  RunDispatcherProcessClosure,
} from "./Dispatcher.ts";
import { ExecutionFinalizer, type FinalizeOutcome } from "./ExecutionFinalizer.ts";
import { AgentRuntimeSpawnError, type AgentRuntimeService } from "./AgentRuntime.ts";

const makeConfig = (
  repositoryPath: string,
  overrides: Partial<
    Pick<EffectiveWorkflowConfig, "autonomy" | "maxTurns" | "maxAttempts" | "agentProvider">
  > = {},
): EffectiveWorkflowConfig => ({
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
  ...overrides,
});

const dispatchAuthority = {
  workflowId: WorkflowId.make("wf-dispatch"),
  workflowRevision: "2026-10-22T09:00:00.000Z",
} as const;

const makeIssue = (id: string): NormalizedIssue => ({
  id,
  nativeRef: null,
  identifier: `#${id}`,
  title: `Issue ${id}`,
  description: null,
  priority: 1,
  state: "open",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ["agent-ready"],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
});

const seedWorkItem = (id: string) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const now = yield* nowIso;
    const workItem: WorkItem = {
      id: WorkItemId.make(id),
      mode: "symphony",
      projectId: SymphonyProjectId.make("dispatcher-project"),
      objective: `Implement issue ${id}`,
      description: "Seeded for dispatcher tests",
      acceptanceCriteria: [],
      source: { kind: "manual" },
      trackerIssueId: id,
      lifecycle: "queued",
      priority: 1,
      eligibilityReasons: [],
      evidence: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* workItems.upsert(workItem);
    return workItem;
  });

class TestAssertionError extends Error {
  readonly _tag = "TestAssertionError";

  constructor(message: string) {
    super(message);
    this.name = "TestAssertionError";
  }
}

const required = <A>(value: A | null): Effect.Effect<A, TestAssertionError> =>
  value === null
    ? Effect.fail(new TestAssertionError("expected a row, got null"))
    : Effect.succeed(value);

/** Fake agent with a scripted turn outcome. */
const scriptedAgent = (completed: boolean): AgentRuntimeService => ({
  runTurn: () => Effect.succeed({ turnId: "t1", threadId: "th1", completed }),
  interrupt: () => Effect.void,
  pid: () => Effect.succeed(null),
});

/**
 * Agent that records the `reviewFeedback` it received on every `runTurn`
 * call (plan FR-102-104), completing on the second turn so both the first
 * turn and one continuation turn are observed.
 */
const reviewFeedbackCapturingAgent = () => {
  const calls: Array<{
    readonly continuation: boolean;
    readonly hasReviewFeedback: boolean;
    readonly hasAcceptedGuidance: boolean;
    readonly baseBranch: string | undefined;
  }> = [];
  return {
    agent: {
      runTurn: (input: {
        readonly continuation?: boolean;
        readonly reviewFeedback?: unknown;
        readonly acceptedGuidance?: unknown;
        readonly baseBranch?: string;
      }) =>
        Effect.sync(() => {
          calls.push({
            continuation: input.continuation === true,
            hasReviewFeedback: input.reviewFeedback !== undefined,
            hasAcceptedGuidance: input.acceptedGuidance !== undefined,
            baseBranch: input.baseBranch,
          });
          return {
            turnId: `t${calls.length}`,
            threadId: "th1",
            completed: calls.length >= 2,
          };
        }),
      interrupt: () => Effect.void,
      pid: () => Effect.succeed(null),
    } satisfies AgentRuntimeService,
    calls,
  };
};

/**
 * Agent that never completes a turn and records how many turns ran, so the
 * maxTurns continuation loop (plan 8.2) is observable.
 */
const countingIncompleteAgent = () => {
  let turns = 0;
  return {
    agent: {
      runTurn: () =>
        Effect.sync(() => {
          turns += 1;
          return { turnId: `t${turns}`, threadId: "th1", completed: false };
        }),
      interrupt: () => Effect.void,
      pid: () => Effect.succeed(null),
    } satisfies AgentRuntimeService,
    count: () => turns,
  };
};

/**
 * Factory for an agent whose turn blocks until `interrupt()` fails it, like a
 * real agent killed mid-turn. The release handle is registered when the agent
 * is built, so `interrupt()` is never a no-op during the cancel window.
 */
const blockableFactory = Layer.effect(
  AgentRuntimeFactory,
  Effect.gen(function* () {
    const releaseRef = yield* Ref.make<(() => Effect.Effect<void>) | null>(null);
    return {
      make: (_config: EffectiveWorkflowConfig, options) =>
        Effect.gen(function* () {
          yield* (
            options?.onChildSpawned?.(4321, {
              pid: 4321,
              pgid: 4321,
              spawnedAtMs: 0,
              platform: "linux",
              birthToken: "born-4321",
            }) ?? Effect.void
          ).pipe(Effect.orDie);
          const d = yield* Deferred.make<void, AgentRuntimeSpawnError>();
          yield* Ref.set(releaseRef, () =>
            Deferred.fail(d, new AgentRuntimeSpawnError("interrupted")).pipe(Effect.asVoid),
          );
          return {
            runTurn: () =>
              Deferred.await(d).pipe(
                Effect.interruptible,
                Effect.as({ turnId: "t1", threadId: "th1", completed: false }),
              ),
            interrupt: () =>
              Ref.get(releaseRef).pipe(
                Effect.flatMap((release) =>
                  release === null
                    ? Effect.void
                    : release().pipe(Effect.orElseSucceed(() => undefined)),
                ),
              ),
            pid: () => Effect.succeed(null),
          } satisfies AgentRuntimeService;
        }),
    };
  }),
);

const fakeWorkspaceManager = Layer.succeed(WorkspaceManager, {
  ensureWorkspace: (input: { readonly issue: NormalizedIssue }) =>
    Effect.succeed({
      key: deriveWorkspaceKey(input.issue.identifier),
      path: `/ws/${input.issue.identifier}`,
      branch: `symphony/${input.issue.identifier}`,
      baseBranch: "main",
      createdNow: true,
    }),
  removeWorkspace: () => Effect.void,
  hasCommittedHandoff: () => Effect.succeed(false),
  resolvePath: () => "/ws",
});

const fakeFinalizer = Layer.succeed(ExecutionFinalizer, {
  finalize: () => Effect.succeed("review_ready"),
});

const cancelTestSignaller = {
  signalGroup: () => Effect.succeed("sent" as const),
  isGroupAlive: () => Effect.succeed(false),
};

const cancelTestClosure = Layer.succeed(RunDispatcherProcessClosure, {
  reader: {
    readBirthToken: (pid: number) =>
      Effect.succeed(
        pid === 4321 || pid === 4322
          ? ({ kind: "token", token: `born-${pid}` } as const)
          : ({ kind: "no_such_process" } as const),
      ),
  },
  signaller: cancelTestSignaller,
  platform: "linux",
  graceMs: 1,
});

const layer = (
  factory: Layer.Layer<AgentRuntimeFactory>,
  workspaceManager: Layer.Layer<WorkspaceManager> = fakeWorkspaceManager,
  finalizer: Layer.Layer<ExecutionFinalizer> = fakeFinalizer,
) =>
  it.layer(
    RunDispatcherLive.pipe(
      Layer.provideMerge(WorkItemRepositoryLive),
      Layer.provideMerge(RunAttemptRepositoryLive),
      Layer.provideMerge(RunEventRepositoryLive),
      Layer.provideMerge(ApprovalRepositoryLive),
      Layer.provideMerge(LiveRequestsLive),
      Layer.provideMerge(workspaceManager),
      Layer.provideMerge(finalizer),
      Layer.provideMerge(factory),
      Layer.provideMerge(cancelTestClosure),
      Layer.provideMerge(
        Layer.succeed(ServerConfig, {
          symphonyLogsDir: "/logs/symphony",
        } as ServerConfig["Service"]),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const scriptedFactory = (agent: AgentRuntimeService) =>
  Layer.succeed(AgentRuntimeFactory, { make: () => Effect.succeed(agent) });

const policyCapturingAgent = (completeOn: number) => {
  const configs: EffectiveWorkflowConfig[] = [];
  return {
    agent: {
      runTurn: (input: Parameters<AgentRuntimeService["runTurn"]>[0]) =>
        Effect.sync(() => {
          configs.push(input.config);
          return {
            turnId: `t${configs.length}`,
            threadId: "th1",
            completed: configs.length >= completeOn,
          };
        }),
      interrupt: () => Effect.void,
      pid: () => Effect.succeed(null),
    } satisfies AgentRuntimeService,
    configs,
  };
};

const currentPolicyCapture = policyCapturingAgent(2);
const policyPublicationConfigs: EffectiveWorkflowConfig[] = [];
const policyRecordingFinalizer = Layer.succeed(ExecutionFinalizer, {
  finalize: (input) =>
    Effect.sync(() => {
      policyPublicationConfigs.push(input.config);
      return "review_ready" as const;
    }),
});

layer(
  scriptedFactory(currentPolicyCapture.agent),
  fakeWorkspaceManager,
  policyRecordingFinalizer,
)("Dispatcher current policy", (it) => {
  it.effect(
    "reloads current policy before continuation and publication without rewriting the accepted brief",
    () =>
      Effect.gen(function* () {
        const workItem = yield* seedWorkItem("policy-current-1");
        const dispatcher = yield* RunDispatcher;
        const acceptedConfig = makeConfig("/repo", { autonomy: "execute", maxTurns: 2 });
        const tightenedConfig = makeConfig("/repo", { autonomy: "prepare" });
        let loads = 0;
        const runAttemptId = yield* dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("policy-current-1"),
          config: acceptedConfig,
          loadCurrentWorkflowPolicy: () =>
            Effect.sync(() => {
              loads += 1;
              return tightenedConfig;
            }),
        });

        expect(currentPolicyCapture.configs.map((config) => config.autonomy)).toEqual([
          "execute",
          "prepare",
        ]);
        // Continuation + publication both reread the workflow. The narrowed
        // prepare policy forbids publication entirely.
        expect(loads).toBeGreaterThanOrEqual(2);
        expect(policyPublicationConfigs).toEqual([]);
        const attempts = yield* RunAttemptRepository;
        const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
        expect(attempt.status).toBe("failed");
        expect(attempt.error?.category).toBe("workflow_error");
        const events = yield* RunEventRepository.pipe(
          Effect.flatMap((runEvents) => runEvents.listForAttempt(runAttemptId)),
        );
        expect(
          events.some(
            (event) =>
              event.eventType === "policy_refresh_failed" &&
              String(event.payload?.message).includes("Narrowed autonomy prepare"),
          ),
        ).toBe(true);
        expect(attempt.acceptedGuidance?.permission.autonomy).toBe("execute");
        expect(attempt.acceptedGuidance?.workflow.instructions).toBe("");
      }),
  );

  it.effect("refuses before a continuation when the current workflow policy is unavailable", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("policy-missing-1");
      const dispatcher = yield* RunDispatcher;
      const config = makeConfig("/repo", { autonomy: "execute", maxTurns: 2 });
      currentPolicyCapture.configs.length = 0;
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("policy-missing-1"),
        config,
        loadCurrentWorkflowPolicy: () => Effect.succeed(null),
      });

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("failed");
      expect(attempt.error?.category).toBe("workflow_error");
      const events = yield* RunEventRepository.pipe(
        Effect.flatMap((runEvents) => runEvents.listForAttempt(runAttemptId)),
      );
      expect(events.map((event) => event.eventType)).toContain("policy_refresh_failed");
      expect(currentPolicyCapture.configs).toHaveLength(1);
    }),
  );
});

layer(scriptedFactory(scriptedAgent(true)))("Dispatcher prepare mode", (it) => {
  it.effect("refuses an unsupported executor provider before claiming", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("provider-unsupported-1");
      const dispatcher = yield* RunDispatcher;
      const result = yield* Effect.result(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("provider-unsupported-1"),
          config: makeConfig("/repo", {
            agentProvider: {
              instanceId: ProviderInstanceId.make("claude_default"),
              driver: ProviderDriverKind.make("claude"),
            },
          }),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("Unsupported Symphony executor provider");
      }
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("queued");
      const attempts = yield* RunAttemptRepository;
      expect(yield* attempts.listByWorkItem(workItem.id)).toEqual([]);
    }),
  );

  it.effect("claims, prepares a workspace, runs a turn and lands ready_for_review", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1001");
      const dispatcher = yield* RunDispatcher;
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("1001"),
        config: makeConfig("/repo"),
        workflowInstructions: "Follow the repository contribution policy.",
      });

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("succeeded");
      expect(attempt.workItemId).toBe(workItem.id);
      expect(attempt.attemptNumber).toBe(1);
      expect(attempt.workspacePath).toBe("/ws/#1001");
      expect(attempt.acceptedGuidance?.workflow).toMatchObject({
        id: "wf-dispatch",
        revision: "2026-10-22T09:00:00.000Z",
        instructions: "Follow the repository contribution policy.",
      });
      expect(attempt.acceptedGuidance?.source.identifier).toBe("#1001");
      expect(attempt.acceptedGuidance?.target).toMatchObject({
        workspacePath: "/ws/#1001",
        baseBranch: "main",
      });

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("ready_for_review");

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.map((e) => e.eventType)).toEqual([
        "issue_claimed",
        "workspace_created",
        "plan_produced",
      ]);
    }),
  );
});

layer(
  Layer.succeed(AgentRuntimeFactory, {
    make: (_config, options) =>
      Effect.succeed({
        runTurn: () =>
          (options?.onChildSpawned?.(4321) ?? Effect.void).pipe(
            Effect.orDie,
            Effect.as({ turnId: "t1", threadId: "th1", completed: true }),
          ),
        interrupt: () => Effect.void,
        pid: () => Effect.succeed(null),
      } satisfies AgentRuntimeService),
  }),
)("Dispatcher child pid", (it) => {
  it.effect("records the agent child pid once it is spawned", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1030");
      const dispatcher = yield* RunDispatcher;
      yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("1030"),
        config: makeConfig("/repo"),
      });

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after?.ownerPid).toBe(4321);
    }),
  );

  it.effect("records the workspace base branch on the work item", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1031");
      const dispatcher = yield* RunDispatcher;
      yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("1031"),
        config: makeConfig("/repo"),
      });

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after?.baseBranch).toBe("main");
    }),
  );
});

layer(scriptedFactory(scriptedAgent(false)))("Dispatcher prepare mode failure", (it) => {
  it.effect(
    "marks the attempt failed and re-schedules the item when the turn does not complete",
    () =>
      Effect.gen(function* () {
        const workItem = yield* seedWorkItem("1002");
        const dispatcher = yield* RunDispatcher;
        const runAttemptId = yield* dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("1002"),
          config: makeConfig("/repo"),
        });

        const attempts = yield* RunAttemptRepository;
        const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
        expect(attempt.status).toBe("failed");
        expect(attempt.error?.category).toBe("agent");
        expect(attempt.attemptNumber).toBe(1);

        // The agent-turn failure is retryable (plan 9.5), so the item is
        // re-scheduled for the backoff window instead of released to queued.
        const workItems = yield* WorkItemRepository;
        const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
        expect(after.lifecycle).toBe("retry_scheduled");
      }),
  );
});

layer(scriptedFactory(scriptedAgent(false)))("Dispatcher exhaustion", (it) => {
  it.effect("exhaustion ends failed, not queued", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1010");
      const dispatcher = yield* RunDispatcher;
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("1010"),
        config: makeConfig("/repo", { maxAttempts: 1 }),
      });

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("failed");
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("failed");
      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.map((e) => e.eventType)).toContain("retries_exhausted");
    }),
  );
});

layer(scriptedFactory(countingIncompleteAgent().agent))("Dispatcher continuation turns", (it) => {
  it.effect("runs continuation turns up to maxTurns when the turn never completes", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1005");
      const dispatcher = yield* RunDispatcher;
      const config = makeConfig("/repo", { autonomy: "execute", maxTurns: 3 });
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("1005"),
        config,
        loadCurrentWorkflowPolicy: () => Effect.succeed(config),
      });

      const runEvents = yield* RunEventRepository;
      const list = yield* runEvents.listForAttempt(runAttemptId);
      const continuationEvents = list.filter((event) => event.eventType === "continuation_turn");
      // First turn + 2 continuation turns (maxTurns 3), then the failure path.
      expect(continuationEvents.length).toBe(2);
    }),
  );
});

const resumedAgent = countingIncompleteAgent();
const resumableWorkspaceManager = Layer.succeed(WorkspaceManager, {
  ensureWorkspace: (input: { readonly issue: NormalizedIssue }) =>
    Effect.succeed({
      key: deriveWorkspaceKey(input.issue.identifier),
      path: `/ws/${input.issue.identifier}`,
      branch: `symphony/${input.issue.identifier}`,
      baseBranch: "main",
      createdNow: false,
    }),
  removeWorkspace: () => Effect.void,
  hasCommittedHandoff: () => Effect.succeed(true),
  resolvePath: () => "/ws",
});
const completingFinalizer = Layer.succeed(ExecutionFinalizer, {
  // The stub runs inside the dispatcher fiber, whose context already holds the
  // repositories, so the narrowed service type is satisfied at runtime.
  finalize: (input) =>
    Effect.gen(function* () {
      const finishedAt = yield* nowIso;
      yield* RunAttemptRepository.pipe(
        Effect.flatMap((attempts) =>
          attempts.updateStatus(input.runAttemptId, "succeeded", {
            finishedAt,
          }),
        ),
      );
      yield* WorkItemRepository.pipe(
        Effect.flatMap((items) =>
          items.transition(input.workItem.id, "ready_for_review", {
            ownerToken: input.ownerToken,
            generation: input.generation,
          }),
        ),
      );
      return "review_ready" as const;
    }).pipe(Effect.orDie) as unknown as Effect.Effect<FinalizeOutcome>,
});

layer(
  scriptedFactory(resumedAgent.agent),
  resumableWorkspaceManager,
  completingFinalizer,
)("Dispatcher committed handoff recovery", (it) => {
  it.effect("resumes validation without another agent turn", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1007");
      const attempts = yield* RunAttemptRepository;
      const now = yield* nowIso;
      yield* attempts.create({
        id: RunAttemptId.make("run-1007-1"),
        workItemId: workItem.id,
        attemptNumber: 1,
        workspacePath: "/ws/#1007",
        provider: makeConfig("/repo").agentProvider,
        status: "failed",
        startedAt: now,
        finishedAt: now,
        error: { category: "agent", message: "runner interrupted after commit" },
      });

      const dispatcher = yield* RunDispatcher;
      const config = makeConfig("/repo", { autonomy: "execute" });
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("1007"),
        config,
        loadCurrentWorkflowPolicy: () => Effect.succeed(config),
      });

      expect(resumedAgent.count()).toBe(0);
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("succeeded");
      const events = yield* RunEventRepository.pipe(
        Effect.flatMap((runEvents) => runEvents.listForAttempt(runAttemptId)),
      );
      expect(events.map((event) => event.eventType)).toContain("committed_handoff_resumed");
    }),
  );
});

const reviewFeedbackCapture = reviewFeedbackCapturingAgent();

layer(scriptedFactory(reviewFeedbackCapture.agent))("Dispatcher review feedback", (it) => {
  it.effect(
    "carries reviewFeedback on the first turn only, never on continuation turns (SPEC 8.2)",
    () =>
      Effect.gen(function* () {
        const workItem = yield* seedWorkItem("1006");
        const dispatcher = yield* RunDispatcher;
        const config = makeConfig("/repo", { autonomy: "execute", maxTurns: 3 });
        yield* dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("1006"),
          config,
          loadCurrentWorkflowPolicy: () => Effect.succeed(config),
          reviewFeedback: {
            unresolvedCommentCount: 2,
            reviewState: "changes_requested",
          },
        });

        expect(reviewFeedbackCapture.calls).toEqual([
          {
            continuation: false,
            hasReviewFeedback: true,
            hasAcceptedGuidance: true,
            baseBranch: "main",
          },
          {
            continuation: true,
            hasReviewFeedback: false,
            hasAcceptedGuidance: true,
            baseBranch: "main",
          },
        ]);
      }),
  );
});

const waitForRecordedChild = (workItemId: WorkItemId) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    for (let i = 0; i < 100; i++) {
      const item = yield* workItems.getById(workItemId);
      if (item?.ownerPid !== undefined && item.ownerPid !== null) return;
      yield* TestClock.adjust("10 millis");
    }
    return yield* Effect.fail(new TestAssertionError("child identity was never recorded"));
  });

layer(blockableFactory)("Dispatcher cancel", (it) => {
  it.effect("cancelRun records a durable user_cancelled status and ends the dispatch", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1003");
      const dispatcher = yield* RunDispatcher;

      const runAttemptId = yield* Effect.gen(function* () {
        const attempts = yield* RunAttemptRepository;
        const fiber = yield* Effect.forkScoped(
          dispatcher.dispatchWorkItem({
            ...dispatchAuthority,
            workItem,
            issue: makeIssue("1003"),
            config: makeConfig("/repo"),
          }),
        );

        const waitForAttempt = (
          attemptsLeft: number,
        ): Effect.Effect<RunAttemptId, TestAssertionError | SymphonyPersistenceError> =>
          Effect.gen(function* () {
            const list = yield* attempts.listByWorkItem(workItem.id);
            const first = list[0];
            if (first !== undefined) return first.id;
            if (attemptsLeft <= 0)
              return yield* Effect.fail(new TestAssertionError("dispatch never started"));
            yield* TestClock.adjust("10 millis");
            return yield* waitForAttempt(attemptsLeft - 1);
          });

        const id = yield* waitForAttempt(100);
        yield* waitForRecordedChild(workItem.id);
        yield* dispatcher.cancelRun(id);
        // await (not join): the dispatch fiber is now pure-interrupted, and
        // joining an interrupted fiber propagates the interruption into this
        // test fiber. await returns the Exit without that.
        yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void));
        return id;
      });

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("user_cancelled");
      expect(attempt.finishedAt).not.toBeNull();

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.some((e) => e.eventType === "user_cancelled")).toBe(true);

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("cancelled");
      expect((yield* workItems.listByLifecycle(["queued"])).map((i) => i.id)).not.toContain(
        workItem.id,
      );
    }),
  );
});

// Agent whose turn FAILS (retryable agent error) instead of blocking forever:
// cancelRun must win the race against markFailed (fix-lane item 6).
const failingCancelFactory = Layer.effect(
  AgentRuntimeFactory,
  Effect.gen(function* () {
    const releaseRef = yield* Ref.make<(() => Effect.Effect<void>) | null>(null);
    return {
      make: (_config, options) =>
        Effect.gen(function* () {
          yield* (
            options?.onChildSpawned?.(4322, {
              pid: 4322,
              pgid: 4322,
              spawnedAtMs: 0,
              platform: "linux",
              birthToken: "born-4322",
            }) ?? Effect.void
          ).pipe(Effect.orDie);
          const d = yield* Deferred.make<void, AgentRuntimeSpawnError>();
          yield* Ref.set(releaseRef, () =>
            Deferred.fail(d, new AgentRuntimeSpawnError("interrupted")).pipe(Effect.asVoid),
          );
          return {
            runTurn: () =>
              Deferred.await(d).pipe(
                Effect.interruptible,
                Effect.flatMap(() => Effect.fail(new RunDispatchError("agent turn failed"))),
              ),
            interrupt: () =>
              Ref.get(releaseRef).pipe(
                Effect.flatMap((release) =>
                  release === null
                    ? Effect.void
                    : release().pipe(Effect.orElseSucceed(() => undefined)),
                ),
              ),
            pid: () => Effect.succeed(null),
          } satisfies AgentRuntimeService;
        }),
    };
  }),
);

layer(failingCancelFactory)("Dispatcher cancel race", (it) => {
  it.effect("a failing turn cancelled in flight never lands retry_scheduled", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1004");
      const dispatcher = yield* RunDispatcher;

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(
          dispatcher.dispatchWorkItem({
            ...dispatchAuthority,
            workItem,
            issue: makeIssue("1004"),
            config: makeConfig("/repo"),
          }),
        );
        // Wait for the turn to be in flight, then cancel: the failure path
        // would normally land retry_scheduled; cancel must win.
        const attempts = yield* RunAttemptRepository;
        let id: RunAttemptId | null = null;
        for (let i = 0; i < 100; i++) {
          const list = yield* attempts.listByWorkItem(workItem.id);
          if (list[0] !== undefined) {
            id = list[0].id;
            break;
          }
          yield* TestClock.adjust("10 millis");
        }
        if (id !== null) {
          yield* waitForRecordedChild(workItem.id);
          yield* dispatcher.cancelRun(id);
        }
        yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void));
      });

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).not.toBe("retry_scheduled");
      expect(after.lifecycle).toBe("cancelled");
    }),
  );
});

const stopSignalLog: Array<{ readonly pgid: number; readonly signal: NodeJS.Signals }> = [];
const stopSignaller = {
  signalGroup: (pgid: number, signal: NodeJS.Signals) =>
    Effect.sync(() => {
      stopSignalLog.push({ pgid, signal });
      return "sent" as const;
    }),
  isGroupAlive: () => Effect.succeed(false),
};

const provenIdentity = (pid: number): ProcessGroupIdentity => ({
  pid,
  pgid: pid,
  spawnedAtMs: 0,
  platform: "linux",
  birthToken: `born-${pid}`,
});

/**
 * Agent that records child ownership (optionally the full proven identity),
 * then blocks until interrupted.
 */
const stopBlockableFactory = (pid: number, recordIdentity: boolean) =>
  Layer.effect(
    AgentRuntimeFactory,
    Effect.gen(function* () {
      const releaseRef = yield* Ref.make<(() => Effect.Effect<void>) | null>(null);
      return {
        make: (_config: EffectiveWorkflowConfig, options) =>
          Effect.gen(function* () {
            const d = yield* Deferred.make<void, AgentRuntimeSpawnError>();
            yield* Ref.set(releaseRef, () =>
              Deferred.fail(d, new AgentRuntimeSpawnError("interrupted")).pipe(Effect.asVoid),
            );
            // The production factory narrows this surface; the runtime invokes
            // the same callback with the optional proven identity.
            const onChildSpawned = options?.onChildSpawned as unknown as
              | ((pid: number, identity?: ProcessGroupIdentity) => Effect.Effect<void>)
              | undefined;
            yield* (
              onChildSpawned?.(pid, recordIdentity ? provenIdentity(pid) : undefined) ?? Effect.void
            ).pipe(Effect.orDie);
            return {
              runTurn: () =>
                Deferred.await(d).pipe(
                  Effect.interruptible,
                  Effect.as({ turnId: "t1", threadId: "th1", completed: false }),
                ),
              interrupt: () =>
                Ref.get(releaseRef).pipe(
                  Effect.flatMap((release) =>
                    release === null
                      ? Effect.void
                      : release().pipe(Effect.orElseSucceed(() => undefined)),
                  ),
                ),
              pid: () => Effect.succeed(pid),
            } satisfies AgentRuntimeService;
          }),
      };
    }),
  );

/** Agent that records pid-only ownership and then fails its turn. */
const stopFailingFactory = (pid: number) =>
  Layer.succeed(AgentRuntimeFactory, {
    make: (_config, options) =>
      Effect.gen(function* () {
        yield* (options?.onChildSpawned?.(pid) ?? Effect.void).pipe(Effect.orDie);
        return {
          runTurn: () => Effect.fail(new AgentRuntimeSpawnError("agent turn failed")),
          interrupt: () => Effect.void,
          pid: () => Effect.succeed(pid),
        } satisfies AgentRuntimeService;
      }),
  });

const failingStopEventRepository = Layer.effect(
  RunEventRepository,
  Effect.gen(function* () {
    const base = yield* RunEventRepository;
    return {
      ...base,
      append: (runAttemptId, eventType, payload) =>
        eventType === "stop_requested"
          ? Effect.fail(
              new SymphonyPersistenceSqlError({
                operation: "test.stop_requested",
                detail: "injected stop intent persistence failure",
              }),
            )
          : base.append(runAttemptId, eventType, payload),
    };
  }),
);

const stopLayer = (recordIdentity: boolean, pid: number, failStopIntent = false) =>
  it.layer(
    RunDispatcherLive.pipe(
      Layer.provideMerge(WorkItemRepositoryLive),
      Layer.provideMerge(RunAttemptRepositoryLive),
      Layer.provideMerge(
        failStopIntent
          ? failingStopEventRepository.pipe(Layer.provideMerge(RunEventRepositoryLive))
          : RunEventRepositoryLive,
      ),
      Layer.provideMerge(ApprovalRepositoryLive),
      Layer.provideMerge(LiveRequestsLive),
      Layer.provideMerge(fakeWorkspaceManager),
      Layer.provideMerge(fakeFinalizer),
      Layer.provideMerge(stopBlockableFactory(pid, recordIdentity)),
      Layer.provideMerge(
        Layer.succeed(RunDispatcherProcessClosure, {
          reader: {
            readBirthToken: (candidate) =>
              Effect.succeed(
                candidate === pid
                  ? ({ kind: "token", token: `born-${pid}` } as const)
                  : ({ kind: "no_such_process" } as const),
              ),
          },
          signaller: stopSignaller,
          platform: "linux",
          graceMs: 1,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ServerConfig, {
          symphonyLogsDir: "/logs/symphony",
        } as ServerConfig["Service"]),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const admissionLayer = (platform: NodeJS.Platform) =>
  it.layer(
    RunDispatcherLive.pipe(
      Layer.provideMerge(WorkItemRepositoryLive),
      Layer.provideMerge(RunAttemptRepositoryLive),
      Layer.provideMerge(RunEventRepositoryLive),
      Layer.provideMerge(ApprovalRepositoryLive),
      Layer.provideMerge(LiveRequestsLive),
      Layer.provideMerge(fakeWorkspaceManager),
      Layer.provideMerge(fakeFinalizer),
      Layer.provideMerge(scriptedFactory(scriptedAgent(true))),
      Layer.provideMerge(Layer.succeed(RunDispatcherProcessClosure, { platform })),
      Layer.provideMerge(
        Layer.succeed(ServerConfig, {
          symphonyLogsDir: "/logs/symphony",
        } as ServerConfig["Service"]),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const waitForCancelableAttempt = (workItemId: WorkItemId) =>
  Effect.gen(function* () {
    const attempts = yield* RunAttemptRepository;
    const workItems = yield* WorkItemRepository;
    for (let i = 0; i < 100; i++) {
      const list = yield* attempts.listByWorkItem(workItemId);
      const id = list[0]?.id;
      const item = yield* workItems.getById(workItemId);
      if (id !== undefined && item?.ownerPid !== undefined && item.ownerPid !== null) {
        return id;
      }
      yield* TestClock.adjust("10 millis");
    }
    const item = yield* workItems.getById(workItemId);
    return yield* Effect.fail(
      new TestAssertionError(`dispatch never registered; lifecycle=${String(item?.lifecycle)}`),
    );
  });

admissionLayer("win32")("Dispatcher admission platform gate", (it) => {
  it.effect("refuses Symphony work before claiming on an unsupported platform", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("platform-win32-1");
      const dispatcher = yield* RunDispatcher;
      const result = yield* Effect.result(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("platform-win32-1"),
          config: makeConfig("/repo"),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("process-group closure cannot be proven");
      }
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("queued");
      expect(after.ownerPid ?? null).toBeNull();
      const attempts = yield* RunAttemptRepository;
      expect(yield* attempts.listByWorkItem(workItem.id)).toEqual([]);
    }),
  );
});

stopLayer(false, 22001)("Dispatcher stop with an unverifiable legacy owner", (it) => {
  it.effect("retains the claim, never retries, and re-checks on a repeated Stop", () =>
    Effect.gen(function* () {
      stopSignalLog.length = 0;
      const workItem = yield* seedWorkItem("stop-legacy-1");
      const dispatcher = yield* RunDispatcher;
      const fiber = yield* Effect.forkScoped(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("stop-legacy-1"),
          config: makeConfig("/repo"),
        }),
      );
      const runAttemptId = yield* waitForCancelableAttempt(workItem.id);
      const first = yield* dispatcher.cancelRun(runAttemptId);
      yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void));

      expect(first.status).toBe("held");
      if (first.status === "held") expect(first.reason).toBe("unproven_group_identity");
      expect(stopSignalLog).toEqual([]);
      // A pending held Stop still counts as active for the sweeper, so a tick
      // cannot release it as if the interrupted fiber's exit were closure.
      expect(yield* dispatcher.isAgentActive(runAttemptId)).toBe(true);
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      // The held lifecycle is whichever active phase the Stop interrupted:
      // never a terminal state and never a retry.
      expect(["preparing", "running"]).toContain(after.lifecycle);
      expect(after.ownerPid).toBe(22001);
      expect(after.ownerPgid ?? null).toBeNull();
      expect(after.ownerBirthToken ?? null).toBeNull();

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      // Stop is not closure: the attempt must not claim a terminal stop.
      expect([
        "preparing_workspace",
        "building_prompt",
        "launching_agent",
        "streaming_turn",
      ]).toContain(attempt.status);

      const runEvents = yield* RunEventRepository;
      const eventsBefore = yield* runEvents.listForAttempt(runAttemptId);
      expect(eventsBefore.some((event) => event.eventType === "stop_unconfirmed")).toBe(true);
      expect(eventsBefore.some((event) => event.eventType === "retry_scheduled")).toBe(false);

      // A repeated Stop must re-check closure, not silently succeed.
      const second = yield* dispatcher.cancelRun(runAttemptId);
      expect(second.status).toBe("held");
      const eventsAfter = yield* runEvents.listForAttempt(runAttemptId);
      expect(eventsAfter.filter((event) => event.eventType === "stop_unconfirmed").length).toBe(2);
      expect((yield* workItems.getById(workItem.id))?.lifecycle).not.toBe("cancelled");
    }),
  );
});

stopLayer(true, 22002)("Dispatcher stop with a confirmed owner group", (it) => {
  it.effect("terminates once and releases the exact claim once after closure", () =>
    Effect.gen(function* () {
      stopSignalLog.length = 0;
      const workItem = yield* seedWorkItem("stop-confirmed-1");
      const dispatcher = yield* RunDispatcher;
      const fiber = yield* Effect.forkScoped(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("stop-confirmed-1"),
          config: makeConfig("/repo"),
        }),
      );
      const runAttemptId = yield* waitForCancelableAttempt(workItem.id);
      const outcome = yield* dispatcher.cancelRun(runAttemptId);
      yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void));

      expect(outcome.status).toBe("confirmed");
      expect(stopSignalLog).toEqual([{ pgid: 22002, signal: "SIGTERM" }]);
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("cancelled");
      expect(after.ownerPid ?? null).toBeNull();
      expect(after.ownerPgid ?? null).toBeNull();
      expect(after.ownerBirthToken ?? null).toBeNull();

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("user_cancelled");
      expect(attempt.finishedAt).not.toBeNull();

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.some((event) => event.eventType === "stop_confirmed")).toBe(true);

      // A later Stop cannot signal or release again; it reports the settled
      // confirmation instead of a fresh cancellation.
      const repeated = yield* dispatcher.cancelRun(runAttemptId);
      expect(repeated.status).toBe("confirmed");
      if (repeated.status === "confirmed") expect(repeated.released).toBe(false);
      expect(stopSignalLog).toEqual([{ pgid: 22002, signal: "SIGTERM" }]);
      expect((yield* workItems.getById(workItem.id))?.lifecycle).toBe("cancelled");
    }),
  );

  it.effect(
    "rejects a Stop for a historical attempt instead of changing the replacement claim",
    () =>
      Effect.gen(function* () {
        stopSignalLog.length = 0;
        const workItem = yield* seedWorkItem("stop-stale-1");
        const attempts = yield* RunAttemptRepository;
        const now = yield* nowIso;
        const oldAttemptId = RunAttemptId.make("run-stale-old");
        yield* attempts.create({
          id: oldAttemptId,
          workItemId: workItem.id,
          attemptNumber: 1,
          workspacePath: "/ws/#stop-stale-1",
          provider: makeConfig("/repo").agentProvider,
          status: "streaming_turn",
          startedAt: now,
          finishedAt: null,
          error: null,
        });
        const workItems = yield* WorkItemRepository;
        const claimed = yield* workItems.claim(workItem.id, "owner-replacement");
        yield* workItems.setClaimOwnerProcessIdentity(
          workItem.id,
          "owner-replacement",
          claimed.generation,
          { pid: 33003, pgid: 33003, birthToken: "born-33003" },
        );
        yield* attempts.create({
          id: RunAttemptId.make("run-stale-new"),
          workItemId: workItem.id,
          attemptNumber: 2,
          workspacePath: "/ws/#stop-stale-1",
          provider: makeConfig("/repo").agentProvider,
          status: "preparing_workspace",
          startedAt: now,
          finishedAt: null,
          error: null,
        });

        const dispatcher = yield* RunDispatcher;
        const outcome = yield* dispatcher.cancelRun(oldAttemptId);
        expect(outcome.status).toBe("held");
        if (outcome.status === "held") expect(outcome.reason).toBe("stale_attempt");
        expect(stopSignalLog).toEqual([]);

        const replacement = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
        expect(replacement.lifecycle).toBe("preparing");
        expect(replacement.ownerPid).toBe(33003);
        expect(replacement.ownerPgid).toBe(33003);
        const replacementAttempt = yield* attempts
          .getById(RunAttemptId.make("run-stale-new"))
          .pipe(Effect.flatMap(required));
        expect(replacementAttempt.status).toBe("preparing_workspace");
      }),
  );

  it.effect("does not confirm legacy cancellation without an exact stop receipt", () =>
    Effect.gen(function* () {
      stopSignalLog.length = 0;
      const workItem = yield* seedWorkItem("stop-legacy-receipt");
      const attempts = yield* RunAttemptRepository;
      const runEvents = yield* RunEventRepository;
      const attemptId = RunAttemptId.make("run-legacy-receipt");
      yield* attempts.create({
        id: attemptId,
        workItemId: workItem.id,
        attemptNumber: 1,
        workspacePath: "/ws/#stop-legacy-receipt",
        provider: makeConfig("/repo").agentProvider,
        status: "user_cancelled",
        startedAt: yield* nowIso,
        finishedAt: yield* nowIso,
        error: null,
      });

      const dispatcher = yield* RunDispatcher;
      const withoutReceipt = yield* dispatcher.cancelRun(attemptId);
      expect(withoutReceipt.status).toBe("held");
      if (withoutReceipt.status === "held") {
        expect(withoutReceipt.reason).toBe("stop_not_confirmed");
      }

      yield* runEvents.append(attemptId, "stop_confirmed", {
        closure: "group_terminated",
        released: true,
        generation: 3,
      });
      const withReceipt = yield* dispatcher.cancelRun(attemptId);
      expect(withReceipt.status).toBe("confirmed");
      if (withReceipt.status === "confirmed") {
        expect(withReceipt.evidence).toBe("group_terminated");
        expect(withReceipt.releasedGeneration).toBe(3);
        expect(withReceipt.released).toBe(false);
      }
    }),
  );

  it.effect("rejects a same-instant replacement generation despite timestamp order", () =>
    Effect.gen(function* () {
      stopSignalLog.length = 0;
      const workItem = yield* seedWorkItem("stop-prep-window");
      const workItems = yield* WorkItemRepository;
      const attempts = yield* RunAttemptRepository;
      const runEvents = yield* RunEventRepository;
      const first = yield* workItems.claim(workItem.id, "owner-old");
      const oldAttemptId = RunAttemptId.make("run-prep-old");
      yield* attempts.create({
        id: oldAttemptId,
        workItemId: workItem.id,
        attemptNumber: 1,
        workspacePath: "/ws/#stop-prep-window",
        provider: makeConfig("/repo").agentProvider,
        status: "streaming_turn",
        startedAt: yield* nowIso,
        finishedAt: null,
        error: null,
      });
      yield* runEvents.append(oldAttemptId, "issue_claimed", {
        workItemId: String(workItem.id),
        ownerToken: "owner-old",
        generation: first.generation,
      });
      yield* workItems.releaseClaim(workItem.id, "queued", {
        ownerToken: "owner-old",
        generation: first.generation,
        ownerPid: null,
        ownerPgid: null,
        ownerBirthToken: null,
      });
      // Same clock instant as the previous attempt/claim: only the exact
      // generation binding can distinguish the replacement.
      const replacement = yield* workItems.claim(workItem.id, "owner-prep");
      yield* workItems.setClaimOwnerProcessIdentity(
        workItem.id,
        "owner-prep",
        replacement.generation,
        { pid: 33003, pgid: 33003, birthToken: "born-33003" },
      );

      const dispatcher = yield* RunDispatcher;
      const outcome = yield* dispatcher.cancelRun(oldAttemptId);
      expect(outcome.status).toBe("held");
      if (outcome.status === "held") expect(outcome.reason).toBe("claim_binding_unverified");
      expect(stopSignalLog).toEqual([]);
      expect(yield* dispatcher.isAgentActive(oldAttemptId)).toBe(true);

      const current = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(current.lifecycle).toBe("preparing");
      expect(current.ownerPid).toBe(33003);
    }),
  );
});

layer(stopFailingFactory(44004))("Dispatcher non-Stop failure ownership", (it) => {
  it.effect("keeps unknown process ownership instead of scheduling a retry", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("failure-hold-1");
      const dispatcher = yield* RunDispatcher;
      yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("failure-hold-1"),
        config: makeConfig("/repo"),
      });
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(["preparing", "running"]).toContain(after.lifecycle);
      expect(after.ownerPid).toBe(44004);

      const attempts = yield* RunAttemptRepository;
      const rows = yield* attempts.listByWorkItem(workItem.id);
      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(rows[0]!.id);
      expect(events.some((event) => event.eventType === "failure_hold")).toBe(true);
      expect(events.some((event) => event.eventType === "retry_scheduled")).toBe(false);
    }),
  );
});

const failingWorkspaceManager = (error: WorkspaceOutsideRootError | WorkspacePopulationError) =>
  Layer.succeed(WorkspaceManager, {
    ensureWorkspace: () => Effect.fail(error),
    removeWorkspace: () => Effect.void,
    hasCommittedHandoff: () => Effect.succeed(false),
    resolvePath: () => "/ws",
  });

layer(
  scriptedFactory(scriptedAgent(true)),
  failingWorkspaceManager(new WorkspacePopulationError("key", "git worktree add failed")),
)("Dispatcher early failure", (it) => {
  it.effect("a workspace failure writes a failed attempt and schedules a retry", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1020");
      const dispatcher = yield* RunDispatcher;
      const result = yield* Effect.result(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("1020"),
          config: makeConfig("/repo", { autonomy: "execute" }),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.failure)).toContain("git worktree add failed");
      }
      const attempts = yield* RunAttemptRepository;
      const rows = yield* attempts.listByWorkItem(workItem.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.attemptNumber).toBe(1);
      expect(rows[0]?.workspacePath).toBe("");
      expect(rows[0]?.error?.category).toBe("process_failed");
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("retry_scheduled");
      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(rows[0]!.id);
      expect(events.map((e) => e.eventType)).toContain("dispatch_failed_early");
      expect(events.map((e) => e.eventType)).toContain("retry_scheduled");
    }),
  );

  it.effect("a workspace failure at the attempt cap ends failed", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1021");
      const dispatcher = yield* RunDispatcher;
      yield* Effect.result(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("1021"),
          config: makeConfig("/repo", { autonomy: "execute", maxAttempts: 1 }),
        }),
      );
      const attempts = yield* RunAttemptRepository;
      const rows = yield* attempts.listByWorkItem(workItem.id);
      expect(rows).toHaveLength(1);
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("failed");
    }),
  );

  it.effect("the queue is not blocked by a failing head item", () =>
    Effect.gen(function* () {
      const first = yield* seedWorkItem("1022");
      const second = yield* seedWorkItem("1023");
      const dispatcher = yield* RunDispatcher;
      yield* Effect.result(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem: first,
          issue: makeIssue("1022"),
          config: makeConfig("/repo", { autonomy: "execute" }),
        }),
      );
      const workItems = yield* WorkItemRepository;
      const queued = yield* workItems.listByLifecycle(["queued"]);
      expect(queued.map((i) => String(i.id))).toEqual([String(second.id)]);
    }),
  );
});

layer(
  scriptedFactory(scriptedAgent(true)),
  failingWorkspaceManager(new WorkspaceOutsideRootError("/x", "/root")),
)("Dispatcher early failure outside root", (it) => {
  it.effect("an outside-root workspace is not retried", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1024");
      const dispatcher = yield* RunDispatcher;
      yield* Effect.result(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("1024"),
          config: makeConfig("/repo", { autonomy: "execute" }),
        }),
      );
      const attempts = yield* RunAttemptRepository;
      const rows = yield* attempts.listByWorkItem(workItem.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.error?.category).toBe("workflow_error");
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("failed");
    }),
  );
});

stopLayer(
  true,
  22009,
  true,
)("Dispatcher stop intent persistence", (it) => {
  it.effect("retains the claim and never interrupts when stop intent cannot be persisted", () =>
    Effect.gen(function* () {
      stopSignalLog.length = 0;
      const workItem = yield* seedWorkItem("stop-intent-failure-1");
      const dispatcher = yield* RunDispatcher;
      const fiber = yield* Effect.forkScoped(
        dispatcher.dispatchWorkItem({
          ...dispatchAuthority,
          workItem,
          issue: makeIssue("stop-intent-failure-1"),
          config: makeConfig("/repo"),
        }),
      );
      const runAttemptId = yield* waitForCancelableAttempt(workItem.id);
      const outcome = yield* dispatcher.cancelRun(runAttemptId);

      expect(outcome.status).toBe("held");
      if (outcome.status === "held") {
        expect(outcome.reason).toBe("stop_intent_unpersisted");
      }
      expect(stopSignalLog).toEqual([]);
      expect(yield* dispatcher.isAgentActive(runAttemptId)).toBe(true);

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(["preparing", "running"]).toContain(after.lifecycle);
      expect(after.ownerPid).toBe(22009);

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect([
        "preparing_workspace",
        "building_prompt",
        "launching_agent",
        "streaming_turn",
      ]).toContain(attempt.status);
      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(runAttemptId);
      expect(events.some((event) => event.eventType === "stop_requested")).toBe(false);

      yield* Fiber.interrupt(fiber);
    }),
  );
});

layer(scriptedFactory(scriptedAgent(true)))("Dispatcher recovered null identity", (it) => {
  it.effect("holds a bound recovered attempt with null pid and no local admission evidence", () =>
    Effect.gen(function* () {
      const dispatcher = yield* RunDispatcher;
      const attempts = yield* RunAttemptRepository;
      const workItems = yield* WorkItemRepository;
      const runEvents = yield* RunEventRepository;

      for (const withOwnershipFailureEvent of [false, true]) {
        const suffix = withOwnershipFailureEvent ? "failure-event" : "plain";
        const workItem = yield* seedWorkItem(`recovered-null-${suffix}`);
        const ownerToken = `owner-recovered-${suffix}`;
        const claimed = yield* workItems.claim(workItem.id, ownerToken);
        const attemptId = RunAttemptId.make(`run-recovered-null-${suffix}`);
        const startedAt = yield* nowIso;
        yield* attempts.create({
          id: attemptId,
          workItemId: workItem.id,
          attemptNumber: 1,
          workspacePath: `/ws/recovered-null-${suffix}`,
          provider: makeConfig("/repo").agentProvider,
          status: "streaming_turn",
          startedAt,
          finishedAt: null,
          error: null,
        });
        yield* runEvents.append(attemptId, "issue_claimed", {
          workItemId: String(workItem.id),
          ownerToken,
          generation: claimed.generation,
        });
        if (withOwnershipFailureEvent) {
          yield* runEvents.append(attemptId, "ownership_record_failed", {
            workItemId: String(workItem.id),
          });
        }

        stopSignalLog.length = 0;
        const outcome = yield* dispatcher.cancelRun(attemptId);

        expect(outcome.status).toBe("held");
        if (outcome.status === "held") {
          expect(outcome.reason).toBe("identity_missing_for_bound_attempt");
        }
        expect(stopSignalLog).toEqual([]);
        const ownership = yield* workItems.getClaimOwnership(workItem.id);
        expect(ownership?.ownerToken).toBe(ownerToken);
        expect(ownership?.generation).toBe(claimed.generation);
        expect(ownership?.ownerPid ?? null).toBeNull();
        expect(["preparing", "running"]).toContain(ownership?.lifecycle);
        const attempt = yield* attempts.getById(attemptId).pipe(Effect.flatMap(required));
        expect(attempt.status).toBe("streaming_turn");
        const events = yield* runEvents.listForAttempt(attemptId);
        expect(events.some((event) => event.eventType === "stop_confirmed")).toBe(false);
      }
    }),
  );
});

const targetChangeAgent = policyCapturingAgent(1);
layer(
  scriptedFactory(targetChangeAgent.agent),
  fakeWorkspaceManager,
  policyRecordingFinalizer,
)("Dispatcher publication target", (it) => {
  it.effect("refuses a repository retarget before publication without calling the finalizer", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("policy-retarget-1");
      const dispatcher = yield* RunDispatcher;
      const acceptedConfig = makeConfig("/repo", { autonomy: "execute" });
      const changedConfig = makeConfig("/other-repo", { autonomy: "execute" });
      policyPublicationConfigs.length = 0;

      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        ...dispatchAuthority,
        workItem,
        issue: makeIssue("policy-retarget-1"),
        config: acceptedConfig,
        loadCurrentWorkflowPolicy: () => Effect.succeed(changedConfig),
      });

      expect(policyPublicationConfigs).toEqual([]);
      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("failed");
      expect(attempt.error?.category).toBe("workflow_error");
      const events = yield* RunEventRepository.pipe(
        Effect.flatMap((runEvents) => runEvents.listForAttempt(runAttemptId)),
      );
      const refusal = events.find((event) => event.eventType === "policy_refresh_failed");
      expect(String(refusal?.payload?.message)).toContain("target_changed");
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("failed");
    }),
  );
});
