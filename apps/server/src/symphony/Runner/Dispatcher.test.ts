import type {
  EffectiveWorkflowConfig,
  NormalizedIssue,
  RunAttemptId,
  WorkItem,
} from "@neokod/contracts";
import { ProviderDriverKind, ProviderInstanceId, WorkItemId } from "@neokod/contracts";
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
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "../Persistence/Layers/RunEventRepository.ts";
import { ApprovalRepositoryLive } from "../Persistence/Layers/ApprovalRepository.ts";
import { WorkspaceManager } from "../Workspaces/Manager.ts";
import { LiveRequestsLive } from "./LiveRequests.ts";
import { AgentRuntimeFactory, RunDispatcher, RunDispatcherLive } from "./Dispatcher.ts";
import { AgentRuntimeSpawnError, type AgentRuntimeService } from "./AgentRuntime.ts";

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
      objective: `Implement issue ${id}`,
      description: "Seeded for dispatcher tests",
      acceptanceCriteria: [],
      source: { kind: "manual" },
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
});

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
  resolvePath: () => "/ws",
});

const layer = (factory: Layer.Layer<AgentRuntimeFactory>) =>
  it.layer(
    RunDispatcherLive.pipe(
      Layer.provideMerge(WorkItemRepositoryLive),
      Layer.provideMerge(RunAttemptRepositoryLive),
      Layer.provideMerge(RunEventRepositoryLive),
      Layer.provideMerge(ApprovalRepositoryLive),
      Layer.provideMerge(LiveRequestsLive),
      Layer.provideMerge(fakeWorkspaceManager),
      Layer.provideMerge(factory),
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

layer(scriptedFactory(scriptedAgent(false)))("Dispatcher prepare mode failure", (it) => {
  it.effect("marks the attempt failed and releases the claim when the turn does not complete", () =>
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

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id).pipe(Effect.flatMap(required));
      expect(after.lifecycle).toBe("queued");
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
        yield* Fiber.join(fiber).pipe(Effect.catch(() => Effect.void));
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
      expect(after.lifecycle).toBe("preparing");
    }),
  );
});
