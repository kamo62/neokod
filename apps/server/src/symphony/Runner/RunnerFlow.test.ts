import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

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
});
