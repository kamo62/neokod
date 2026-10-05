import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { RunAttemptId, WorkItemId } from "@neokod/contracts";

import { makeLiveRequests } from "./LiveRequests.ts";
import { makeFakeCodexPeer, makeFakeCodexRuntime } from "./testkit/FakeCodexPeer.ts";
import { makeRunnerTestConfig, makeRunnerTestIssue } from "./testkit/RunnerFixtures.ts";

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
