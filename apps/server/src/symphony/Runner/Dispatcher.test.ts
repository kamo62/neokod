import type { EffectiveWorkflowConfig, NormalizedIssue, WorkItem } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { deriveWorkspaceKey } from "../Domain/Keys.ts";
import { nowIso } from "../Domain/Time.ts";
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
} from "./Dispatcher.ts";
import { ExecutionFinalizer, type FinalizeOutcome } from "./ExecutionFinalizer.ts";
import { AgentRuntimeSpawnError, type AgentRuntimeService } from "./AgentRuntime.ts";

const makeConfig = (
  repositoryPath: string,
  overrides: Partial<Pick<EffectiveWorkflowConfig, "autonomy" | "maxTurns" | "maxAttempts">> = {},
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
  const calls: Array<{ readonly continuation: boolean; readonly hasReviewFeedback: boolean }> = [];
  return {
    agent: {
      runTurn: (input: { readonly continuation?: boolean; readonly reviewFeedback?: unknown }) =>
        Effect.sync(() => {
          calls.push({
            continuation: input.continuation === true,
            hasReviewFeedback: input.reviewFeedback !== undefined,
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
      make: (_config: EffectiveWorkflowConfig) =>
        Effect.gen(function* () {
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

layer(scriptedFactory(scriptedAgent(true)))("Dispatcher prepare mode", (it) => {
  it.effect("claims, prepares a workspace, runs a turn and lands ready_for_review", () =>
    Effect.gen(function* () {
      const workItem = yield* seedWorkItem("1001");
      const dispatcher = yield* RunDispatcher;
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        workItem,
        issue: makeIssue("1001"),
        config: makeConfig("/repo"),
      });

      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.getById(runAttemptId).pipe(Effect.flatMap(required));
      expect(attempt.status).toBe("succeeded");
      expect(attempt.workItemId).toBe(workItem.id);
      expect(attempt.attemptNumber).toBe(1);
      expect(attempt.workspacePath).toBe("/ws/#1001");

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
          ((options?.onChildSpawned?.(4321) ?? Effect.void) as Effect.Effect<void>).pipe(
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
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        workItem,
        issue: makeIssue("1005"),
        config: makeConfig("/repo", { autonomy: "execute", maxTurns: 3 }),
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
      const runAttemptId = yield* dispatcher.dispatchWorkItem({
        workItem,
        issue: makeIssue("1007"),
        config: makeConfig("/repo", { autonomy: "execute" }),
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
        yield* dispatcher.dispatchWorkItem({
          workItem,
          issue: makeIssue("1006"),
          config: makeConfig("/repo", { autonomy: "execute", maxTurns: 3 }),
          reviewFeedback: {
            unresolvedCommentCount: 2,
            reviewState: "changes_requested",
          },
        });

        expect(reviewFeedbackCapture.calls).toEqual([
          { continuation: false, hasReviewFeedback: true },
          { continuation: true, hasReviewFeedback: false },
        ]);
      }),
  );
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
      make: () =>
        Effect.gen(function* () {
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
