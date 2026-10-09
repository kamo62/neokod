import { expect, it } from "@effect/vitest";
import { RunAttemptId, SymphonyProjectId, WorkItemId } from "@neokod/contracts";
import type { WorkItem } from "@neokod/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { ApprovalRepository } from "../Persistence/Services/ApprovalRepository.ts";
import { ApprovalRepositoryLive } from "../Persistence/Layers/ApprovalRepository.ts";
import { LiveRequests, LiveRequestsLive } from "./LiveRequests.ts";
import {
  ApprovalRequestNotFoundError,
  ApprovalService,
  ApprovalServiceLive,
} from "./ApprovalService.ts";
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
});
