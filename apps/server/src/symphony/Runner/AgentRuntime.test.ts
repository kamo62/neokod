import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { RunAttemptId, WorkItemId } from "@neokod/contracts";

import { makeLiveRequests } from "./LiveRequests.ts";
import {
  classifyTurnNotification,
  toCodexApprovalDecision,
  toCodexUserInputResponse,
} from "./AgentRuntime.ts";
import { makeFakeCodexPeer, makeFakeCodexRuntime } from "./testkit/FakeCodexPeer.ts";
import { makeRunnerTestConfig, makeRunnerTestIssue } from "./testkit/RunnerFixtures.ts";

const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

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
      yield* liveRequests.respondToUserInput(runAttemptId, "0", "main");
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
