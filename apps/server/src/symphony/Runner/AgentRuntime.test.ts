import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { AcceptedGuidanceSnapshot } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  WorkItemId,
} from "@neokod/contracts";

import { makeLiveRequests } from "./LiveRequests.ts";
import {
  AgentRuntimeChildOwnershipError,
  classifyTurnNotification,
  parseQuestionPayload,
  toCodexApprovalDecision,
  toCodexUserInputResponse,
} from "./AgentRuntime.ts";
import { makeFakeCodexPeer, makeFakeCodexRuntime } from "./testkit/FakeCodexPeer.ts";
import { makeRunnerTestConfig, makeRunnerTestIssue } from "./testkit/RunnerFixtures.ts";

const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

const acceptedSnapshot = (overrides?: {
  readonly repositoryPath?: string;
  readonly model?: string;
  readonly workflowPath?: string;
  readonly baseBranch?: string;
}): AcceptedGuidanceSnapshot =>
  ({
    schemaVersion: 1,
    acceptedAt: "2026-10-23T00:00:00.000Z",
    digest: "sha256:accepted",
    workflow: {
      id: "workflow-1",
      path: "/repo/WORKFLOW.md",
      revision: "2026-10-22T00:00:00.000Z",
      digest: "sha256:workflow",
      instructions: "Implement the accepted issue.",
      validationRequired: [],
    },
    source: {
      trackerId: "github:owner/repo",
      kind: "github",
      identifier: "#1",
      title: "Issue 1",
      description: null,
      acceptanceCriteria: [],
      labels: ["agent-ready"],
      revision: null,
      digest: "sha256:source",
    },
    guidance: {
      batch: { state: "absent" },
      story: { state: "absent" },
      digest: "sha256:guidance",
    },
    target: {
      repositoryPath: overrides?.repositoryPath ?? "/repo",
      workflowPath: overrides?.workflowPath ?? "/repo/WORKFLOW.md",
      provider: { instanceId: "codex_default", driver: "codex" },
      ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
      ...(overrides?.baseBranch !== undefined ? { baseBranch: overrides.baseBranch } : {}),
    },
    permission: {
      autonomy: "prepare",
      approvalPolicy: "untrusted",
      threadSandbox: "read-only",
      turnSandboxPolicy: { type: "readOnly" },
      editsAllowed: false,
      approvalsEnabled: true,
      protectedPaths: [],
      delivery: {
        approvalBeforePush: null,
        approvalBeforePullRequest: null,
        approvalBeforeMerge: null,
      },
    },
  }) as unknown as AcceptedGuidanceSnapshot;

it("maps Symphony approval decisions to Codex wire values", () => {
  assert.strictEqual(toCodexApprovalDecision("approved"), "accept");
  assert.strictEqual(toCodexApprovalDecision("rejected"), "decline");
});

it("builds a Codex user-input answer map from independent question ids", () => {
  expect(
    toCodexUserInputResponse(["q1", "q2"], {
      q1: "main",
      q2: ["unit", "lint"],
    }),
  ).toEqual({
    answers: { q1: { answers: ["main"] }, q2: { answers: ["unit", "lint"] } },
  });
  expect(toCodexUserInputResponse([], {})).toEqual({ answers: {} });
});

it.effect("sends exactly one reply to a command approval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const runAttemptId = RunAttemptId.make("run-1");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendCommandApproval();
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      assert.strictEqual(pending.length, 1);
      yield* liveRequests.respondToApproval(runAttemptId, "0", "approved");
      const reply = yield* peer.awaitClientResponse(id);
      assert.strictEqual(reply.error, undefined);
      assert.notStrictEqual(reply.result, undefined);
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("maps an approved command to accept on the wire", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const runAttemptId = RunAttemptId.make("run-1");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendCommandApproval();
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      yield* liveRequests.respondToApproval(runAttemptId, "0", "approved");
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, { decision: "accept" });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("maps a rejected command to decline on the wire", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const runAttemptId = RunAttemptId.make("run-1");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendCommandApproval();
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      yield* liveRequests.respondToApproval(runAttemptId, "0", "rejected");
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, { decision: "decline" });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("maps an approved file change to accept on the wire", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const runAttemptId = RunAttemptId.make("run-1");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendRequest("item/fileChange/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-3",
        startedAtMs: 0,
      });
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      yield* liveRequests.respondToApproval(runAttemptId, "0", "approved");
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, { decision: "accept" });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("maps a settled approval to decline on the wire", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const runAttemptId = RunAttemptId.make("run-1");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendCommandApproval();
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      yield* liveRequests.settleRun(runAttemptId, "cancelled");
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, { decision: "decline" });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("answers user input with an answers map on the wire", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const runAttemptId = RunAttemptId.make("run-1");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendUserInputRequest([
        { id: "q1", question: "Which branch?" },
        { id: "q2", question: "Why?" },
      ]);
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      yield* liveRequests.respondToUserInput(runAttemptId, "0", { q1: "main", q2: "because" });
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, {
        answers: { q1: { answers: ["main"] }, q2: { answers: ["because"] } },
      });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("persists the protocol question text and its choices for a user-input request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const recorded: Array<{
        readonly requestId: string;
        readonly action: string;
        readonly reason?: string;
        readonly questionPayload?: unknown;
      }> = [];
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        recordRequest: (input) =>
          Effect.sync(() => {
            recorded.push({
              requestId: input.requestId,
              action: input.action,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              ...(input.questionPayload !== undefined
                ? { questionPayload: input.questionPayload }
                : {}),
            });
          }),
      });
      const runAttemptId = RunAttemptId.make("run-question");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-question"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      // The protocol payload: questions[] with header/question/options and no
      // `prompt` field (generated schema: ToolRequestUserInputParams).
      const id = yield* peer.sendRequest("item/tool/requestUserInput", {
        threadId: peer.threadId,
        turnId: yield* peer.currentTurnId,
        itemId: "item-9",
        questions: [
          {
            header: "Branch",
            id: "q1",
            question: "Which branch should I target?",
            options: [
              { label: "main", description: "default branch" },
              { label: "release", description: "release branch" },
            ],
          },
        ],
      });
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      assert.strictEqual(pending.length, 1);
      const prompt = pending[0]?.prompt ?? "";
      assert.isTrue(prompt.includes("Which branch should I target?"));
      assert.isTrue(prompt.includes("options: main, release"));

      yield* liveRequests.respondToUserInput(runAttemptId, pending[0]?.requestId ?? "0", {
        q1: "main",
      });
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, { answers: { q1: { answers: ["main"] } } });

      const record = recorded.find((entry) => entry.action === "user_input");
      assert.isTrue(record?.reason?.includes("Which branch should I target?") ?? false);
      assert.isTrue(record?.reason?.includes("options: main, release") ?? false);
      assert.deepStrictEqual(record?.questionPayload, {
        kind: "structured",
        version: 1,
        questions: [
          {
            id: "q1",
            header: "Branch",
            question: "Which branch should I target?",
            options: [
              { label: "main", description: "default branch" },
              { label: "release", description: "release branch" },
            ],
          },
        ],
      });

      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("a timed-out approval sends the answer that won the claim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        // The timeout loses: a human answer claims the request first.
        requestTimedOut: (input) =>
          liveRequests.respondToApproval(input.runAttemptId, input.requestId, "approved").pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true)),
          ),
      });
      const runAttemptId = RunAttemptId.make("run-timeout-answer");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig({ liveRequestsWaitTimeoutMs: 30_000 }),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-timeout-answer"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendCommandApproval();
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      assert.strictEqual(pending.length, 1);

      yield* TestClock.adjust("31 seconds");
      yield* settle;
      const reply = yield* peer.awaitClientResponse(id);
      // The provider receives the winning answer, not the timeout fallback.
      assert.deepStrictEqual(reply.result, { decision: "accept" });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("a timed-out question sends the answer that won the claim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        requestTimedOut: (input) =>
          liveRequests
            .respondToUserInput(input.runAttemptId, input.requestId, {
              q1: "main",
            })
            .pipe(
              Effect.as(false),
              Effect.catch(() => Effect.succeed(true)),
            ),
      });
      const runAttemptId = RunAttemptId.make("run-timeout-question");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig({ liveRequestsWaitTimeoutMs: 30_000 }),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-timeout-question"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendUserInputRequest([{ id: "q1", question: "Which branch?" }]);
      let pending = yield* liveRequests.listPending(runAttemptId);
      let iterations = 0;
      while (pending.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
        iterations += 1;
      }
      assert.strictEqual(pending.length, 1);

      yield* TestClock.adjust("31 seconds");
      yield* settle;
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, { answers: { q1: { answers: ["main"] } } });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("an unanswered question expires without sending an empty synthetic answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const expired: Array<string> = [];
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        requestTimedOut: (input) =>
          Effect.sync(() => {
            expired.push(input.requestId);
            return true;
          }),
      });
      const runAttemptId = RunAttemptId.make("run-question-timeout");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig({ liveRequestsWaitTimeoutMs: 30_000 }),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-question-timeout"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendUserInputRequest([{ id: "q1", question: "Which branch?" }]);
      let pending = yield* liveRequests.listPending(runAttemptId);
      for (let attempt = 0; attempt < 100 && pending.length === 0; attempt += 1) {
        yield* Effect.yieldNow;
        pending = yield* liveRequests.listPending(runAttemptId);
      }
      assert.strictEqual(pending.length, 1);

      yield* TestClock.adjust("31 seconds");
      yield* settle;
      const reply = yield* peer.awaitClientResponse(id);
      // No `{answers: {q1: {answers: [""]}}}` placeholder: the provider request
      // is deliberately terminated and no human answer is claimed.
      assert.strictEqual(reply.result, undefined);
      assert.include(
        String((reply.error as { message?: unknown }).message),
        "did not answer before the request wait expired",
      );
      assert.deepStrictEqual(expired, [String(pending[0]?.requestId)]);
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("rejects an unsupported method with method-not-found", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-1"),
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendRequest("item/permissions/requestApproval", {});
      const reply = yield* peer.awaitClientResponse(id);
      assert.strictEqual(reply.result, undefined);
      assert.strictEqual((reply.error as { code: number }).code, -32601);
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it("classifies turn notifications against the pinned turn", () => {
  const pinned = { threadId: "thread-1", turnId: "turn-1" };
  assert.deepStrictEqual(
    classifyTurnNotification(
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      },
      pinned,
    ),
    { _tag: "completed" },
  );
  assert.strictEqual(
    classifyTurnNotification(
      {
        method: "turn/completed",
        params: { threadId: "other", turn: { id: "turn-1", status: "completed" } },
      },
      pinned,
    ),
    null,
  );
  assert.strictEqual(
    classifyTurnNotification(
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "other", status: "completed" } },
      },
      pinned,
    ),
    null,
  );
  assert.strictEqual(
    classifyTurnNotification(
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      },
      pinned,
    ),
    null,
  );
  assert.deepStrictEqual(
    classifyTurnNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "failed", error: { message: "boom" } },
        },
      },
      pinned,
    ),
    { _tag: "failed", message: "boom" },
  );
  assert.deepStrictEqual(
    classifyTurnNotification(
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } },
      },
      pinned,
    ),
    { _tag: "failed", message: "Codex turn failed" },
  );
  assert.deepStrictEqual(
    classifyTurnNotification(
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
      },
      pinned,
    ),
    { _tag: "failed", message: "Codex turn was interrupted" },
  );
  assert.strictEqual(
    classifyTurnNotification(
      {
        method: "error",
        params: {
          error: { message: "x" },
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
        },
      },
      pinned,
    ),
    null,
  );
  assert.strictEqual(
    classifyTurnNotification(
      {
        method: "error",
        params: {
          error: { message: "x" },
          threadId: "thread-1",
          turnId: "other",
          willRetry: false,
        },
      },
      pinned,
    ),
    null,
  );
});

it.effect("a failed turn fails runTurn with the Codex message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-1"),
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.completeTurn("failed", { error: "out of credits" });
      const result = yield* Effect.result(Fiber.join(fiber));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(String(result.failure).includes("out of credits"));
      }
    }),
  ),
);

it.effect("an interrupted turn fails runTurn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-1"),
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.completeTurn("interrupted");
      const result = yield* Effect.result(Fiber.join(fiber));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(String(result.failure).includes("interrupted"));
      }
    }),
  ),
);

it.effect("a completion for another turn or thread is ignored", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-1"),
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.completeTurn("completed", { turnId: "turn-other" });
      yield* peer.completeTurn("completed", { threadId: "thread-other" });
      yield* settle;
      assert.strictEqual(fiber.pollUnsafe(), undefined);
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("a second turn on the same runtime completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const input = {
        issue: makeRunnerTestIssue("1"),
        config: makeRunnerTestConfig(),
        workspacePath: "/tmp/fake-ws",
        branch: "b",
        runAttemptId: RunAttemptId.make("run-1"),
        workItemId: WorkItemId.make("wi-1"),
      };
      const first = yield* runtime.runTurn(input).pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.completeTurn("completed");
      yield* Fiber.join(first);
      const second = yield* runtime
        .runTurn({ ...input, continuation: true })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.completeTurn("completed");
      const result = yield* Fiber.join(second);
      assert.strictEqual(result.turnId, "turn-2");
    }),
  ),
);

it.effect("a crash before turn/completed fails the turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-1"),
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.crash(1);
      yield* settle;
      assert.notStrictEqual(fiber.pollUnsafe(), undefined);
      const result = yield* Effect.result(Fiber.join(fiber));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(String(result.failure).includes("exited"));
      }
    }),
  ),
);

it.effect("stdout closed with a live process fails the turn after the exit wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-1"),
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.closeStdout;
      yield* TestClock.adjust("3 seconds");
      yield* settle;
      assert.notStrictEqual(fiber.pollUnsafe(), undefined);
      const result = yield* Effect.result(Fiber.join(fiber));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(String(result.failure).includes("exited"));
      }
    }),
  ),
);

it.effect("interrupt does not block on an unanswered turn/interrupt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer({ unanswered: ["turn/interrupt"] });
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-1"),
          workItemId: WorkItemId.make("wi-1"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const interruptFiber = yield* runtime.interrupt().pipe(Effect.forkScoped);
      yield* TestClock.adjust("6 seconds");
      yield* settle;
      assert.notStrictEqual(interruptFiber.pollUnsafe(), undefined);
      yield* Fiber.interrupt(fiber).pipe(Effect.catch(() => Effect.void));
    }),
  ),
);

it.effect("reports the spawned pid without inventing a group identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer({ pid: 999_999 });
      const liveRequests = yield* makeLiveRequests;
      const calls: Array<{ readonly pid: number; readonly identity: unknown }> = [];
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        onChildSpawned: (pid, identity) =>
          Effect.sync(() => {
            calls.push({ pid, identity });
          }),
      });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-ownership"),
          workItemId: WorkItemId.make("wi-ownership"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      // The fake pid has no real OS process, so no birth token can be proven:
      // the callback gets the pid but no pgid identity.
      expect(calls).toEqual([{ pid: 999_999, identity: undefined }]);
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("fails closed before provider use when child ownership cannot be recorded", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        onChildSpawned: () =>
          Effect.fail(new AgentRuntimeChildOwnershipError("ownership store unavailable")),
      });
      const result = yield* Effect.result(
        runtime.runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-ownership-failure"),
          workItemId: WorkItemId.make("wi-ownership-failure"),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.failure)).toContain("recording its ownership failed");
      }
      const requests = yield* peer.received;
      // The child is preserved as known evidence, but no initialize/turn is
      // sent after the callback failed.
      expect(requests.map((request) => request.method)).not.toContain("initialize");
      expect(requests.map((request) => request.method)).not.toContain("turn/start");
      expect(yield* runtime.pid()).toBe(4242);
      expect(yield* peer.spawnCount).toBe(1);
    }),
  ),
);

it.effect("refuses an accepted target whose repository or model changed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const repositoryResult = yield* Effect.result(
        runtime.runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-target-1"),
          workItemId: WorkItemId.make("wi-target-1"),
          acceptedGuidance: acceptedSnapshot({ repositoryPath: "/other/repo" }),
        }),
      );
      expect(repositoryResult._tag).toBe("Failure");
      const modelResult = yield* Effect.result(
        runtime.runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-target-2"),
          workItemId: WorkItemId.make("wi-target-2"),
          acceptedGuidance: acceptedSnapshot({ model: "other-model" }),
        }),
      );
      expect(modelResult._tag).toBe("Failure");
      // Refused before the app-server was spawned.
      expect(yield* peer.spawnCount).toBe(0);
    }),
  ),
);

it.effect("enforces the accepted permissions narrowed against live config", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-accepted-policy"),
          workItemId: WorkItemId.make("wi-accepted-policy"),
          acceptedGuidance: acceptedSnapshot(),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const requests = yield* peer.received;
      const threadStart = requests.find((request) => request.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      });
      const turnStart = requests.find((request) => request.method === "turn/start");
      expect(turnStart?.params).toMatchObject({
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" },
      });
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect(
  "compares the accepted base branch with the actual base branch, not the work branch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* makeFakeCodexPeer();
        const liveRequests = yield* makeLiveRequests;
        const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
        const fiber = yield* runtime
          .runTurn({
            issue: makeRunnerTestIssue("1"),
            config: makeRunnerTestConfig(),
            workspacePath: "/tmp/fake-ws",
            branch: "symphony/1",
            baseBranch: "main",
            runAttemptId: RunAttemptId.make("run-base-branch"),
            workItemId: WorkItemId.make("wi-base-branch"),
            acceptedGuidance: acceptedSnapshot({ baseBranch: "main" }),
          })
          .pipe(Effect.forkScoped);
        yield* peer.awaitClientRequest("turn/start");
        yield* peer.completeTurn("completed");
        yield* Fiber.join(fiber);

        const otherPeer = yield* makeFakeCodexPeer();
        const otherRuntime = yield* makeFakeCodexRuntime({
          peer: otherPeer,
          liveRequests,
        });
        const refused = yield* Effect.result(
          otherRuntime.runTurn({
            issue: makeRunnerTestIssue("1"),
            config: makeRunnerTestConfig(),
            workspacePath: "/tmp/fake-ws",
            branch: "symphony/1",
            runAttemptId: RunAttemptId.make("run-base-branch-missing"),
            workItemId: WorkItemId.make("wi-base-branch-missing"),
            acceptedGuidance: acceptedSnapshot({ baseBranch: "main" }),
          }),
        );
        expect(refused._tag).toBe("Failure");
        expect(yield* otherPeer.spawnCount).toBe(0);
      }),
    ),
);

it("preserves empty option descriptions and falls back to a valid description label", () => {
  const preserved = parseQuestionPayload({
    questions: [
      {
        id: "q1",
        header: "Branch",
        question: "Which branch?",
        options: [
          { label: "main", description: "" },
          { label: "", description: "release" },
        ],
      },
    ],
  });
  expect(preserved).toMatchObject({ kind: "structured" });
  if (preserved.kind !== "structured") throw new Error("expected structured");
  expect(preserved.questions[0]?.options).toEqual([
    { label: "main", description: "" },
    { label: "release", description: "release" },
  ]);
  expect(
    parseQuestionPayload({
      questions: [
        {
          id: "q1",
          header: "Branch",
          question: "Which branch?",
          options: [{ label: "", description: "" }],
        },
      ],
    }).kind,
  ).toBe("unsupported");
});

it.effect("refuses an unrepresentable accepted permission before spawn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const base = acceptedSnapshot();
      const refused = yield* Effect.result(
        runtime.runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-permission-conflict"),
          workItemId: WorkItemId.make("wi-permission-conflict"),
          acceptedGuidance: {
            ...base,
            permission: { ...base.permission, approvalPolicy: "never" },
          },
        }),
      );
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.failure)).toContain("permission cannot be enforced");
      }
      expect(yield* peer.spawnCount).toBe(0);
    }),
  ),
);

it.effect("withdraws its own registration when request publication fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        recordRequest: () => Effect.succeed({ status: "record_failed" as const }),
      });
      const runAttemptId = RunAttemptId.make("run-record-failed");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-record-failed"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendUserInputRequest([{ id: "q1", question: "Which branch?" }]);
      const reply = yield* peer.awaitClientResponse(id);
      expect(reply.result).toBeUndefined();
      expect(String((reply.error as { message?: unknown }).message)).toContain(
        "could not be recorded",
      );
      expect(yield* liveRequests.listPending(runAttemptId)).toHaveLength(0);
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("refuses an unsupported provider before spawn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const result = yield* Effect.result(
        runtime.runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig({
            agentProvider: {
              instanceId: ProviderInstanceId.make("claude_default"),
              driver: ProviderDriverKind.make("claude"),
            },
          }),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-unsupported-provider"),
          workItemId: WorkItemId.make("wi-unsupported-provider"),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.failure)).toContain("supports the default Codex provider");
      }
      expect(yield* peer.spawnCount).toBe(0);
    }),
  ),
);

it.effect("refuses an unsupported instance for the Codex driver before spawn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({ peer, liveRequests });
      const result = yield* Effect.result(
        runtime.runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig({
            agentProvider: {
              instanceId: ProviderInstanceId.make("codex_other"),
              driver: ProviderDriverKind.make("codex"),
            },
          }),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId: RunAttemptId.make("run-unsupported-instance"),
          workItemId: WorkItemId.make("wi-unsupported-instance"),
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* peer.spawnCount).toBe(0);
    }),
  ),
);

it.effect("rejects a redelivered decided request without creating an invisible waiter", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeFakeCodexPeer();
      const liveRequests = yield* makeLiveRequests;
      const runtime = yield* makeFakeCodexRuntime({
        peer,
        liveRequests,
        recordRequest: () => Effect.succeed({ status: "duplicate_decided" as const }),
      });
      const runAttemptId = RunAttemptId.make("run-duplicate-record");
      const fiber = yield* runtime
        .runTurn({
          issue: makeRunnerTestIssue("1"),
          config: makeRunnerTestConfig(),
          workspacePath: "/tmp/fake-ws",
          branch: "b",
          runAttemptId,
          workItemId: WorkItemId.make("wi-duplicate-record"),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      const id = yield* peer.sendUserInputRequest([{ id: "q1", question: "Which branch?" }]);
      const reply = yield* peer.awaitClientResponse(id);
      expect(reply.result).toBeUndefined();
      expect(String((reply.error as { message?: unknown }).message)).toContain(
        "was already used for a decided request",
      );
      expect(yield* liveRequests.listPending(runAttemptId)).toHaveLength(0);
      yield* peer.completeTurn("completed");
      yield* Fiber.join(fiber);
    }),
  ),
);
