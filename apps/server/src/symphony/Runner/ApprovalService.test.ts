import { assert, expect, it } from "@effect/vitest";
import { RunAttemptId, SymphonyProjectId, WorkItemId } from "@neokod/contracts";
import type { ApprovalRequest, ApprovalQuestionPayload, WorkItem } from "@neokod/contracts";
import * as Context from "effect/Context";
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

/**
 * A repository whose lookups outlive the runtime deadline: an answer can start
 * before the wait elapses, hold the resolution lock while it reads, and only
 * land afterwards. Everything else delegates to the real repository.
 */
const slowLookupApprovalRepositoryLayer = Layer.effect(
  ApprovalRepository,
  Effect.gen(function* () {
    const repository = yield* ApprovalRepository;
    return ApprovalRepository.of({
      ...repository,
      getById: (id) => Effect.sleep("40 seconds").pipe(Effect.andThen(repository.getById(id))),
    });
  }),
).pipe(Layer.provide(ApprovalRepositoryLive));

const slowLookupStack = ApprovalServiceLive.pipe(
  Layer.provideMerge(slowLookupApprovalRepositoryLayer),
  Layer.provideMerge(LiveRequestsLive),
  Layer.provideMerge(WorkItemRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
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

const userInputPayload = {
  kind: "structured",
  version: 1,
  questions: [
    {
      id: "q1",
      header: "Branch",
      question: "Which branch?",
      options: [
        { label: "main", description: "default branch" },
        { label: "release", description: "release branch" },
      ],
    },
  ],
} as const;

const makeUserInputRequest = (
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  requestId: string,
  questionPayload: ApprovalQuestionPayload = userInputPayload,
) =>
  Effect.gen(function* () {
    const live = yield* LiveRequests;
    const service = yield* ApprovalService;
    const deferred = yield* live.registerUserInput({
      requestId,
      workItemId,
      runAttemptId,
      prompt: "p",
      ...(questionPayload.kind === "structured"
        ? { questionIds: questionPayload.questions.map((question) => question.id) }
        : {}),
    });
    const record = yield* service.recordPending({
      id: "ignored",
      requestId,
      workItemId,
      runAttemptId,
      action: "user_input",
      scope: "once",
      reason: "Which branch?",
      questionPayload,
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

  it.effect("a retried identical decision is idempotent and a different one is stale", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-c");
      const service = yield* ApprovalService;
      const { record } = yield* makeRequest(
        RunAttemptId.make("run-c"),
        WorkItemId.make("wi-c"),
        "0",
      );
      yield* service.approve(record.id);
      // A lost response makes the client retry the same decision.
      yield* service.approve(record.id);
      const error = yield* Effect.flip(service.reject(record.id));
      expect(error).toBeInstanceOf(ApprovalRequestNotFoundError);
    }),
  );

  it.effect("user input by durable id", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-d");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const { deferred, record } = yield* makeUserInputRequest(
        RunAttemptId.make("run-d"),
        WorkItemId.make("wi-d"),
        "0",
      );
      yield* service.respondToUserInput(record.id, {
        answers: [{ questionId: "q1", answer: "main" }],
      });
      expect(yield* Deferred.await(deferred)).toEqual({ q1: "main" });
      expect((yield* repo.getById(record.id))?.state).toBe("answered");
      expect((yield* repo.getById(record.id))?.answer?.answers).toEqual([
        { questionId: "q1", answer: "main" },
      ]);
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

  it.effect("a timeout after an answer must not overwrite the answer", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-late-timeout");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const runAttemptId = RunAttemptId.make("run-late-timeout");
      const { deferred, record } = yield* makeRequest(
        runAttemptId,
        WorkItemId.make("wi-late-timeout"),
        "0",
      );

      yield* service.approve(record.id);
      expect(yield* Deferred.await(deferred)).toBe("approved");

      // The runtime's wait elapsed after the answer already won. Arriving late
      // must not claim the request or replace the recorded outcome.
      expect(yield* service.expireRequest(runAttemptId, "0")).toBe(false);
      expect((yield* repo.getById(record.id))?.state).toBe("approved");
    }),
  );

  it.effect("an answer after a timeout is refused and changes nothing", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-late-answer");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const runAttemptId = RunAttemptId.make("run-late-answer");
      const { deferred, record } = yield* makeRequest(
        runAttemptId,
        WorkItemId.make("wi-late-answer"),
        "0",
      );

      expect(yield* service.expireRequest(runAttemptId, "0")).toBe(true);
      expect((yield* repo.getById(record.id))?.state).toBe("expired");

      const late = yield* Effect.result(service.approve(record.id));
      expect(late._tag).toBe("Failure");
      expect((yield* repo.getById(record.id))?.state).toBe("expired");
      expect(yield* Deferred.isDone(deferred)).toBe(true);
    }),
  );

  it.effect("a timeout racing an answer records exactly one terminal outcome", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-race");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const runAttemptId = RunAttemptId.make("run-race");
      const { deferred, record } = yield* makeRequest(
        runAttemptId,
        WorkItemId.make("wi-race"),
        "0",
      );

      // The runtime's wait elapses while the operator answers.
      const [expired, approved] = yield* Effect.all(
        [service.expireRequest(runAttemptId, "0"), Effect.result(service.approve(record.id))],
        { concurrency: "unbounded" },
      );

      const row = yield* repo.getById(record.id);
      const observed = yield* Effect.result(Deferred.await(deferred));
      const answerWon = approved._tag === "Success";

      // Exactly one resolver won; the durable row agrees with the answer the
      // agent actually observed, and nothing is left pending.
      expect(row?.state).not.toBe("pending");
      expect(expired).toBe(!answerWon);
      if (answerWon) {
        expect(row?.state).toBe("approved");
        expect(observed._tag).toBe("Success");
        if (observed._tag === "Success") {
          expect(observed.success).toBe("approved");
        }
      } else {
        expect(row?.state).toBe("expired");
        expect(observed._tag).toBe("Failure");
      }
    }),
  );

  it.effect("an answer that finishes after the deadline still reaches the provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Fresh: the file's shared layer already memoises ApprovalService for the
        // real repository, and this stack must build the slow one.
        const context = yield* Layer.build(Layer.fresh(slowLookupStack));
        const service = Context.get(context, ApprovalService);
        const live = Context.get(context, LiveRequests);
        const workItems = Context.get(context, WorkItemRepository);
        const repository = Context.get(context, ApprovalRepository);
        const seededAt = yield* nowIso;
        const workItemId = WorkItemId.make("wi-slow-lookup");
        yield* workItems.upsert({
          id: workItemId,
          mode: "symphony",
          projectId: SymphonyProjectId.make("approvals-slow-lookup"),
          objective: "Slow lookup target",
          description: "Seeded for the slow-lookup approval regression",
          acceptanceCriteria: [],
          source: { kind: "manual" },
          trackerIssueId: "wi-slow-lookup",
          lifecycle: "queued",
          priority: 1,
          eligibilityReasons: [],
          evidence: null,
          createdAt: seededAt,
          updatedAt: seededAt,
        });

        const peer = yield* makeFakeCodexPeer();
        const runtime = yield* makeFakeCodexRuntime({
          peer,
          liveRequests: live,
          ...approvalServiceRequestCallbacks(service),
        });
        const runAttemptId = RunAttemptId.make("run-slow-lookup");
        const fiber = yield* runtime
          .runTurn({
            issue: makeRunnerTestIssue("slow-lookup"),
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

        // The answer starts before the deadline but its lookup takes 40 s; it
        // holds the resolution lock the whole time.
        const answer = yield* service.approve(recorded.id).pipe(Effect.forkScoped);
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });

        // The runtime's 30 s wait elapses while the lookup is still running.
        yield* TestClock.adjust("31 seconds");
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        // Proof the answer really outlived the deadline: it is still blocked in
        // the slow lookup (and therefore still holds the resolution lock).
        expect(answer.pollUnsafe()).toBeUndefined();
        // The lookup finishes after the deadline and wins.
        yield* TestClock.adjust("10 seconds");
        yield* Effect.repeat(Effect.yieldNow, { times: 100 });

        const reply = yield* peer.awaitClientResponse(wireId);
        assert.deepStrictEqual(reply.result, { decision: "accept" });
        const rows = yield* repository.listForRun(runAttemptId);
        expect(rows.find((row) => row.id === recorded.id)?.state).toBe("approved");

        yield* Fiber.join(answer);
        yield* peer.completeTurn("completed");
        yield* Fiber.join(fiber);
      }),
    ),
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

  it.effect("answers two questions independently, including multi-select and custom text", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-distinct");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const payload: ApprovalQuestionPayload = {
        kind: "structured",
        version: 1,
        questions: [
          {
            id: "branch",
            header: "Branch",
            question: "Which branch?",
            options: [
              { label: "main", description: "default" },
              { label: "release", description: "release" },
            ],
          },
          {
            id: "checks",
            header: "Checks",
            question: "Which checks?",
            options: [
              { label: "unit", description: "unit tests" },
              { label: "lint", description: "lint" },
            ],
            multiSelect: true,
          },
          {
            id: "note",
            header: "Note",
            question: "Anything else?",
            options: [],
          },
        ],
      };
      const { deferred, record } = yield* makeUserInputRequest(
        RunAttemptId.make("run-distinct"),
        WorkItemId.make("wi-distinct"),
        "0",
        payload,
      );
      yield* service.respondToUserInput(record.id, {
        answers: [
          { questionId: "branch", answer: "release" },
          { questionId: "checks", answer: ["unit", "lint"] },
          { questionId: "note", answer: "custom free text" },
        ],
      });
      expect(yield* Deferred.await(deferred)).toEqual({
        branch: "release",
        checks: ["unit", "lint"],
        note: "custom free text",
      });
      const stored = yield* repo.getById(record.id);
      expect(stored?.state).toBe("answered");
      expect(stored?.decision).toBe("answered");
      expect(stored?.answer?.answers).toEqual([
        { questionId: "branch", answer: "release" },
        { questionId: "checks", answer: ["unit", "lint"] },
        { questionId: "note", answer: "custom free text" },
      ]);
      expect(stored?.questionPayload).toMatchObject(payload);
    }),
  );

  it.effect("refuses missing, extra and malformed answers instead of defaulting them", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-invalid");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const { deferred, record } = yield* makeUserInputRequest(
        RunAttemptId.make("run-invalid"),
        WorkItemId.make("wi-invalid"),
        "0",
      );

      const missing = yield* Effect.result(service.respondToUserInput(record.id, { answers: [] }));
      expect(missing._tag).toBe("Failure");
      const extra = yield* Effect.result(
        service.respondToUserInput(record.id, {
          answers: [
            { questionId: "q1", answer: "main" },
            { questionId: "q2", answer: "other" },
          ],
        }),
      );
      expect(extra._tag).toBe("Failure");
      // A single-select answer supplied as an array is not silently unwrapped.
      const shape = yield* Effect.result(
        service.respondToUserInput(record.id, {
          answers: [{ questionId: "q1", answer: ["main"] }],
        }),
      );
      expect(shape._tag).toBe("Failure");
      expect(yield* Deferred.isDone(deferred)).toBe(false);
      expect((yield* repo.getById(record.id))?.state).toBe("pending");
    }),
  );

  it.effect(
    "stores a redacted answer for a provider-secret question, delivering the real value",
    () =>
      Effect.gen(function* () {
        yield* seedWorkItem("wi-secret");
        const service = yield* ApprovalService;
        const repo = yield* ApprovalRepository;
        const payload: ApprovalQuestionPayload = {
          kind: "structured",
          version: 1,
          questions: [
            {
              id: "token",
              header: "Token",
              question: "Paste the token",
              options: [],
              sensitive: true,
            },
          ],
        };
        const { deferred, record } = yield* makeUserInputRequest(
          RunAttemptId.make("run-secret"),
          WorkItemId.make("wi-secret"),
          "0",
          payload,
        );
        yield* service.respondToUserInput(record.id, {
          answers: [{ questionId: "token", answer: "super-secret" }],
        });
        // The agent receives the real answer.
        expect(yield* Deferred.await(deferred)).toEqual({ token: "super-secret" });
        // History keeps only an explicit redaction marker.
        const stored = yield* repo.getById(record.id);
        expect(stored?.answer?.answers).toEqual([
          { questionId: "token", answer: "[redacted]", redacted: true },
        ]);
      }),
  );

  it.effect(
    "treats a repeated identical answer as an idempotent retry and a different one as stale",
    () =>
      Effect.gen(function* () {
        yield* seedWorkItem("wi-retry");
        const service = yield* ApprovalService;
        const repo = yield* ApprovalRepository;
        const { record } = yield* makeUserInputRequest(
          RunAttemptId.make("run-retry"),
          WorkItemId.make("wi-retry"),
          "0",
        );
        const submission = { answers: [{ questionId: "q1", answer: "main" }] } as const;
        yield* service.respondToUserInput(record.id, submission);
        // The client lost the success response and retries identical content.
        yield* service.respondToUserInput(record.id, submission);
        expect((yield* repo.getById(record.id))?.state).toBe("answered");

        const changed = yield* Effect.result(
          service.respondToUserInput(record.id, {
            answers: [{ questionId: "q1", answer: "release" }],
          }),
        );
        expect(changed._tag).toBe("Failure");
        expect((yield* repo.getById(record.id))?.answer?.answers).toEqual([
          { questionId: "q1", answer: "main" },
        ]);
      }),
  );

  it.effect("persists approve and reject notes as history-only", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-approve-note");
      const service = yield* ApprovalService;
      const repo = yield* ApprovalRepository;
      const approved = yield* makeRequest(
        RunAttemptId.make("run-approve-note"),
        WorkItemId.make("wi-approve-note"),
        "0",
      );
      yield* service.approve(approved.record.id, { note: "approved for this run" });
      const approvedRow = yield* repo.getById(approved.record.id);
      expect(approvedRow?.decisionNote).toMatchObject({
        text: "approved for this run",
        delivery: "history_only",
        actor: "local_operator",
      });

      const rejected = yield* makeRequest(
        RunAttemptId.make("run-approve-note"),
        WorkItemId.make("wi-approve-note"),
        "1",
      );
      yield* service.reject(rejected.record.id, { note: "touches a protected path" });
      const rejectedRow = yield* repo.getById(rejected.record.id);
      expect(rejectedRow?.state).toBe("rejected");
      expect(rejectedRow?.decisionNote).toMatchObject({
        text: "touches a protected path",
        delivery: "history_only",
      });
    }),
  );

  it.effect("a runtime wait timeout expires a question and sends no synthetic answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedWorkItem("wi-question-timeout");
        const service = yield* ApprovalService;
        const live = yield* LiveRequests;
        const repository = yield* ApprovalRepository;
        const peer = yield* makeFakeCodexPeer();
        const runAttemptId = RunAttemptId.make("run-question-timeout");
        const workItemId = WorkItemId.make("wi-question-timeout");
        const runtime = yield* makeFakeCodexRuntime({
          peer,
          liveRequests: live,
          ...approvalServiceRequestCallbacks(service),
        });
        const fiber = yield* runtime
          .runTurn({
            issue: makeRunnerTestIssue("question-timeout"),
            config: makeRunnerTestConfig({ liveRequestsWaitTimeoutMs: 30_000 }),
            workspacePath: "/tmp/fake-ws",
            branch: "b",
            runAttemptId,
            workItemId,
          })
          .pipe(Effect.forkScoped);
        yield* peer.awaitClientRequest("turn/start");
        const wireId = yield* peer.sendUserInputRequest([{ id: "q1", question: "Which branch?" }]);

        let recorded: ApprovalRequest | undefined;
        for (let attempt = 0; attempt < 100 && recorded === undefined; attempt += 1) {
          yield* Effect.yieldNow;
          const rows = yield* repository.listForRun(runAttemptId);
          recorded = rows[0];
        }
        if (recorded === undefined) {
          throw new Error("the runtime did not record the question");
        }
        expect(recorded.questionPayload).toMatchObject({ kind: "structured" });
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });

        yield* TestClock.adjust("31 seconds");
        yield* Effect.repeat(Effect.yieldNow, { times: 50 });
        const reply = yield* peer.awaitClientResponse(wireId);
        // No `{answers: {q1: {answers: [""]}}}` placeholder. The provider
        // request is deliberately failed and the row stays expired.
        expect(reply.result).toBeUndefined();
        expect(String((reply.error as { message?: unknown }).message)).toContain(
          "did not answer before the request wait expired",
        );
        expect((yield* repository.getById(recorded.id))?.state).toBe("expired");
        expect((yield* repository.getById(recorded.id))?.answer).toBeUndefined();

        yield* peer.completeTurn("completed");
        yield* Fiber.join(fiber);
      }),
    ),
  );
});
