import { assert, expect, it } from "@effect/vitest";
import { RunAttemptId, SymphonyProjectId, WorkItemId } from "@neokod/contracts";
import type { ApprovalRequest, WorkItem } from "@neokod/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { ApprovalRepository } from "../Persistence/Services/ApprovalRepository.ts";
import { ApprovalRepositoryLive } from "../Persistence/Layers/ApprovalRepository.ts";
import { approvalServiceRequestCallbacks } from "./AgentRequestCallbacks.ts";
import { LiveRequests, LiveRequestsLive } from "./LiveRequests.ts";
import {
  ApprovalRequestNotFoundError,
  ApprovalService,
  ApprovalServiceLive,
} from "./ApprovalService.ts";
import { makeFakeCodexPeer, makeFakeCodexRuntime } from "./testkit/FakeCodexPeer.ts";
import { makeRunnerTestConfig, makeRunnerTestIssue } from "./testkit/RunnerFixtures.ts";
import { nowIso } from "../Domain/Time.ts";

const seedWorkItem = (id: string) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const now = yield* nowIso;
    const workItem: WorkItem = {
      id: WorkItemId.make(id),
      mode: "symphony",
      projectId: SymphonyProjectId.make("approvals-project"),
      objective: `Implement issue ${id}`,
      description: "Seeded for approval tests",
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

const layer = it.layer(
  ApprovalServiceLive.pipe(
    Layer.provideMerge(ApprovalRepositoryLive),
    Layer.provideMerge(LiveRequestsLive),
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const makeRequest = (
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  requestId: string,
  action = "command_execution",
) =>
  Effect.gen(function* () {
    const live = yield* LiveRequests;
    const service = yield* ApprovalService;
    const deferred = yield* live.registerApproval({
      requestId,
      workItemId,
      runAttemptId,
      action,
      prompt: "p",
    });
    const record = yield* service.recordPending({
      id: "ignored",
      requestId,
      workItemId,
      runAttemptId,
      action,
      scope: "once",
    });
    return { deferred, record };
  });

const makeUserInputRequest = (
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  requestId: string,
) =>
  Effect.gen(function* () {
    const live = yield* LiveRequests;
    const service = yield* ApprovalService;
    const deferred = yield* live.registerUserInput({
      requestId,
      workItemId,
      runAttemptId,
      prompt: "p",
    });
    const record = yield* service.recordPending({
      id: "ignored",
      requestId,
      workItemId,
      runAttemptId,
      action: "user_input",
      scope: "once",
    });
    return { deferred, record };
  });

layer("ApprovalService durable ids", (it) => {
  it.effect("approve by durable id resolves the live request and persists the decision", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-a");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const runAttemptId = RunAttemptId.make("run-a");
      const { deferred, record } = yield* makeRequest(runAttemptId, WorkItemId.make("wi-a"), "0");
      yield* service.approve(record.id);
      expect(yield* Deferred.await(deferred)).toBe("approved");
      expect((yield* repo.getById(record.id))?.state).toBe("approved");
    }),
  );

  it.effect("two runs using JSON-RPC id 0 do not collide", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-b1");
      yield* seedWorkItem("wi-b2");
      const service = yield* ApprovalService;
      const runA = RunAttemptId.make("run-a");
      const runB = RunAttemptId.make("run-b");
      const a = yield* makeRequest(runA, WorkItemId.make("wi-b1"), "0");
      const b = yield* makeRequest(runB, WorkItemId.make("wi-b2"), "0");
      yield* service.approve(b.record.id);
      expect(yield* Deferred.await(b.deferred)).toBe("approved");
      expect(yield* Deferred.isDone(a.deferred)).toBe(false);
      const repo = yield* ApprovalRepository;
      expect((yield* repo.getById(a.record.id))?.state).toBe("pending");
      yield* service.reject(a.record.id);
      expect(yield* Deferred.await(a.deferred)).toBe("rejected");
    }),
  );

  it.effect("unknown id fails", () =>
    Effect.gen(function* () {
      const service = yield* ApprovalService;
      const error = yield* Effect.flip(service.approve("sym-missing"));
      expect(error).toBeInstanceOf(ApprovalRequestNotFoundError);
    }),
  );

  it.effect("a decided request cannot be decided twice", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-c");
      const service = yield* ApprovalService;
      const { record } = yield* makeRequest(
        RunAttemptId.make("run-c"),
        WorkItemId.make("wi-c"),
        "0",
      );
      yield* service.approve(record.id);
      const error = yield* Effect.flip(service.approve(record.id));
      expect(error).toBeInstanceOf(ApprovalRequestNotFoundError);
    }),
  );

  it.effect("user input by durable id", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-d");
      const service = yield* ApprovalService;
      const { deferred, record } = yield* makeUserInputRequest(
        RunAttemptId.make("run-d"),
        WorkItemId.make("wi-d"),
        "0",
      );
      yield* service.respondToUserInput(record.id, "main");
      expect(yield* Deferred.await(deferred)).toBe("main");
    }),
  );

  it.effect("expire settles the live request by run and id", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-e");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const { deferred, record } = yield* makeRequest(
        RunAttemptId.make("run-e"),
        WorkItemId.make("wi-e"),
        "0",
      );
      yield* service.expire(record.id);
      const error = yield* Effect.flip(Deferred.await(deferred));
      expect(String((error as Error).message)).toContain("approval wait timed out");
      expect((yield* repo.getById(record.id))?.state).toBe("expired");
    }),
  );

  it.effect("a runtime wait timeout expires the request so a late answer is refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedWorkItem("wi-timeout");
        const service = yield* ApprovalService;
        const live = yield* LiveRequests;
        const repository = yield* ApprovalRepository;
        const peer = yield* makeFakeCodexPeer();
        const runAttemptId = RunAttemptId.make("run-timeout");
        const workItemId = WorkItemId.make("wi-timeout");
        const runtime = yield* makeFakeCodexRuntime({
          peer,
          liveRequests: live,
          ...approvalServiceRequestCallbacks(service),
        });
        const fiber = yield* runtime
          .runTurn({
            issue: makeRunnerTestIssue("timeout"),
            config: makeRunnerTestConfig({ liveRequestsWaitTimeoutMs: 30_000 }),
            workspacePath: "/tmp/fake-ws",
            branch: "b",
            runAttemptId,
            workItemId,
          })
          .pipe(Effect.forkScoped);
        yield* peer.awaitClientRequest("turn/start");
        const wireId = yield* peer.sendCommandApproval();

        let recorded: ApprovalRequest | undefined;
        for (let attempt = 0; attempt < 100 && recorded === undefined; attempt += 1) {
          yield* Effect.yieldNow;
          const rows = yield* repository.listForRun(runAttemptId);
          recorded = rows[0];
        }
        if (recorded === undefined) {
          throw new Error("the runtime did not record the approval request");
        }
        // Let the handler reach its wait before time moves: the timeout sleep is
        // registered after the durable write.
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });

        // The runtime's own wait elapses: the agent gets its fallback answer and
        // the durable request must stop being answerable.
        yield* TestClock.adjust("31 seconds");
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        const reply = yield* peer.awaitClientResponse(wireId);
        assert.deepStrictEqual(reply.result, { decision: "decline" });
        expect((yield* repository.getById(recorded.id))?.state).toBe("expired");

        const late = yield* Effect.result(service.approve(recorded.id));
        expect(late._tag).toBe("Failure");
        expect((yield* repository.getById(recorded.id))?.state).toBe("expired");

        yield* peer.completeTurn("completed");
        yield* Fiber.join(fiber);
      }),
    ),
  );
});
