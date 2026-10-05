import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { RunAttemptId, WorkItemId } from "@neokod/contracts";

import { makeLiveRequests } from "./LiveRequests.ts";
import { toCodexApprovalDecision, toCodexUserInputResponse } from "./AgentRuntime.ts";
import { makeFakeCodexPeer, makeFakeCodexRuntime } from "./testkit/FakeCodexPeer.ts";
import { makeRunnerTestConfig, makeRunnerTestIssue } from "./testkit/RunnerFixtures.ts";

it("maps Symphony approval decisions to Codex wire values", () => {
  assert.strictEqual(toCodexApprovalDecision("approved"), "accept");
  assert.strictEqual(toCodexApprovalDecision("rejected"), "decline");
});

it("builds a Codex user-input answer map from question ids", () => {
  assert.deepStrictEqual(toCodexUserInputResponse([{ id: "q1" }, { id: "q2" }], "main"), {
    answers: { q1: { answers: ["main"] }, q2: { answers: ["main"] } },
  });
  assert.deepStrictEqual(toCodexUserInputResponse(undefined, "main"), { answers: {} });
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
      yield* liveRequests.respondToApproval("0", "approved");
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
      yield* liveRequests.respondToApproval("0", "approved");
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
      yield* liveRequests.respondToApproval("0", "rejected");
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
      yield* liveRequests.respondToApproval("0", "approved");
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
      yield* liveRequests.respondToUserInput("0", "main");
      const reply = yield* peer.awaitClientResponse(id);
      assert.deepStrictEqual(reply.result, {
        answers: { q1: { answers: ["main"] }, q2: { answers: ["main"] } },
      });
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
