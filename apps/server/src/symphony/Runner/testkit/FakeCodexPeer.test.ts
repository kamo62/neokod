import { assert, describe, it } from "@effect/vitest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RunAttemptId, WorkItemId } from "@neokod/contracts";

import * as CodexClient from "effect-codex-app-server/client";

import { makeLiveRequests } from "../LiveRequests.ts";
import { RunDispatcher } from "../Dispatcher.ts";
import { RunAttemptRepository } from "../../Persistence/Services/RunAttemptRepository.ts";
import { WorkItemRepository } from "../../Persistence/Services/WorkItemRepository.ts";
import { makeFakeCodexPeer, makeFakeCodexRuntime, type FakeCodexPeer } from "./FakeCodexPeer.ts";
import { makeRunnerTestConfig, makeRunnerTestIssue, seedQueuedWorkItem } from "./RunnerFixtures.ts";
import { runnerFlowLayer } from "./RunnerFlowLayer.ts";

describe("FakeCodexPeer", () => {
  it.effect("completes a turn through the real client", () =>
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
        yield* peer.completeTurn("completed");
        const result = yield* Fiber.join(fiber);
        assert.deepStrictEqual(result, { turnId: "turn-1", threadId: "thread-1", completed: true });
        assert.deepStrictEqual(
          (yield* peer.received).map((message) => message.method),
          ["initialize", "initialized", "thread/start", "turn/start"],
        );
        assert.strictEqual(yield* peer.spawnCount, 1);
        assert.strictEqual(yield* runtime.pid(), 4242);
      }),
    ),
  );

  it.effect("delivers a server request and records the client reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* makeFakeCodexPeer();
        const handle = yield* peer.spawner.spawn(ChildProcess.make("fake-codex", ["app-server"]));
        const clientContext = yield* CodexClient.layerChildProcess(handle).pipe(Layer.build);
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );
        yield* client.handleServerRequest("item/tool/requestUserInput", () =>
          Effect.succeed({ answers: { q1: { answers: ["yes"] } } }),
        );
        const id = yield* peer.sendUserInputRequest([{ id: "q1", question: "Go?" }]);
        const response = yield* peer.awaitClientResponse(id);
        assert.deepStrictEqual(response.result, { answers: { q1: { answers: ["yes"] } } });
      }),
    ),
  );

  it.effect("stdout EOF leaves the process alive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* makeFakeCodexPeer();
        const handle = yield* peer.spawner.spawn(ChildProcess.make("fake-codex", ["app-server"]));
        yield* peer.closeStdout;
        const bytes = yield* Stream.runCollect(handle.stdout);
        assert.deepStrictEqual(Array.from(bytes), []);
        const exitFiber = yield* handle.exitCode.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.strictEqual(exitFiber.pollUnsafe(), undefined);
        assert.strictEqual(yield* handle.isRunning, true);
      }),
    ),
  );

  it.effect("crash resolves the exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* makeFakeCodexPeer();
        const handle = yield* peer.spawner.spawn(ChildProcess.make("fake-codex", ["app-server"]));
        yield* peer.crash(7);
        assert.deepStrictEqual(yield* handle.exitCode, ChildProcessSpawner.ExitCode(7));
        assert.strictEqual(yield* handle.isRunning, false);
        const bytes = yield* Stream.runCollect(handle.stdout);
        assert.deepStrictEqual(Array.from(bytes), []);
      }),
    ),
  );
});

const holder: { peer?: FakeCodexPeer } = {};
const flowLayer = it.layer(runnerFlowLayer({ nextPeer: () => holder.peer as FakeCodexPeer }));

flowLayer("prepare dispatch through the real client", (it) => {
  it.effect("runs a prepare-mode dispatch end to end", () =>
    Effect.gen(function* () {
      holder.peer = yield* makeFakeCodexPeer();
      const peer = holder.peer;
      const workItem = yield* seedQueuedWorkItem("h0-1");
      const dispatcher = yield* RunDispatcher;
      const fiber = yield* dispatcher
        .dispatchWorkItem({
          workItem,
          issue: makeRunnerTestIssue("h0-1"),
          config: makeRunnerTestConfig({ autonomy: "prepare" }),
        })
        .pipe(Effect.forkScoped);
      yield* peer.awaitClientRequest("turn/start");
      yield* peer.completeTurn("completed");
      const runAttemptId = yield* Fiber.join(fiber);
      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts
        .getById(runAttemptId)
        .pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die(new Error("expected attempt")) : Effect.succeed(row),
          ),
        );
      assert.strictEqual(attempt.status, "succeeded");
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die(new Error("expected item")) : Effect.succeed(row),
          ),
        );
      assert.strictEqual(after.lifecycle, "ready_for_review");
    }),
  );
});
