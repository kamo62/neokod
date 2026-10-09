import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { RunDispatcher } from "./Dispatcher.ts";
import { ExecutionFinalizer } from "./ExecutionFinalizer.ts";
import type { FakeCodexPeer } from "./testkit/FakeCodexPeer.ts";
import { makeFakeCodexPeer } from "./testkit/FakeCodexPeer.ts";
import { runnerFlowLayer } from "./testkit/RunnerFlowLayer.ts";
import {
  makeRunnerTestConfig,
  makeRunnerTestIssue,
  seedQueuedWorkItem,
} from "./testkit/RunnerFixtures.ts";

const holder: { peer?: FakeCodexPeer } = {};
let finalizeCalls = 0;
const countingFinalizer = Layer.succeed(ExecutionFinalizer, {
  finalize: () =>
    Effect.sync(() => {
      finalizeCalls += 1;
      return "review_ready" as const;
    }),
});

const layer = it.layer(
  runnerFlowLayer({ nextPeer: () => holder.peer as FakeCodexPeer, finalizer: countingFinalizer }),
);

layer("RunnerFlow failed turns", (it) => {
  it.effect("a failed turn ends the attempt failed and never finalizes", () =>
    Effect.gen(function* () {
      finalizeCalls = 0;
      holder.peer = yield* makeFakeCodexPeer();
      const peer = holder.peer;
      const workItem = yield* seedQueuedWorkItem("flow-1");
      const dispatcher = yield* RunDispatcher;
      const fiber = yield* dispatcher
        .dispatchWorkItem({
          workItem,
          issue: makeRunnerTestIssue("flow-1"),
          config: makeRunnerTestConfig({ autonomy: "execute" }),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.completeTurn("failed", { error: "out of credits" });
      const runAttemptId = yield* Fiber.join(fiber);
      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts
        .getById(runAttemptId)
        .pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die(new Error("expected attempt")) : Effect.succeed(row),
          ),
        );
      assert.strictEqual(attempt.status, "failed");
      assert.isTrue(String(attempt.error?.message).includes("out of credits"));
      assert.strictEqual(finalizeCalls, 0);
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die(new Error("expected item")) : Effect.succeed(row),
          ),
        );
      assert.strictEqual(after.lifecycle, "retry_scheduled");
    }),
  );

  it.effect("cancel interrupts the real turn and ends cancelled", () =>
    Effect.gen(function* () {
      finalizeCalls = 0;
      holder.peer = yield* makeFakeCodexPeer();
      const peer = holder.peer;
      const workItem = yield* seedQueuedWorkItem("flow-cancel-1");
      const dispatcher = yield* RunDispatcher;
      const fiber = yield* dispatcher
        .dispatchWorkItem({
          workItem,
          issue: makeRunnerTestIssue("flow-cancel-1"),
          config: makeRunnerTestConfig({ autonomy: "execute" }),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      // Let the turn/start response get processed (it assigns the turn id
      // the interrupt below needs): advancing the test clock pumps the
      // client reader and run fibers, which bare yieldNow spins starve.
      yield* TestClock.adjust("1 second");
      const attempts = yield* RunAttemptRepository;
      let listed = yield* attempts.listByWorkItem(workItem.id);
      let iterations = 0;
      while (listed.length === 0 && iterations < 100) {
        yield* Effect.yieldNow;
        listed = yield* attempts.listByWorkItem(workItem.id);
        iterations += 1;
      }
      assert.strictEqual(listed.length, 1);
      const runAttemptId = listed[0]!.id;
      // The dispatcher registers the live agent after forking the run fiber,
      // which races the turn/start request: wait for registration so cancel
      // actually interrupts the live turn instead of missing it.
      let active = yield* dispatcher.isAgentActive(runAttemptId);
      let activeIterations = 0;
      while (!active && activeIterations < 100) {
        yield* Effect.yieldNow;
        active = yield* dispatcher.isAgentActive(runAttemptId);
        activeIterations += 1;
      }
      assert.strictEqual(active, true);
      yield* dispatcher.cancelRun(runAttemptId);
      yield* peer.awaitClientRequest("turn/interrupt");
      const attempt = yield* attempts
        .getById(runAttemptId)
        .pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die(new Error("expected attempt")) : Effect.succeed(row),
          ),
        );
      assert.strictEqual(attempt.status, "user_cancelled");
      assert.notStrictEqual(attempt.finishedAt, null);
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die(new Error("expected item")) : Effect.succeed(row),
          ),
        );
      assert.strictEqual(after.lifecycle, "cancelled");
      yield* TestClock.adjust("30 seconds");
      const still = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die(new Error("expected item")) : Effect.succeed(row),
          ),
        );
      assert.strictEqual(still.lifecycle, "cancelled");
      expect((yield* attempts.listByWorkItem(workItem.id)).length).toBe(1);
      yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void));
    }),
  );
});
