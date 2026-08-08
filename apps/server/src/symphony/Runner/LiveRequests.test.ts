import { describe, expect, it } from "@effect/vitest";
import { RunAttemptId, WorkItemId } from "@neokod/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { LiveRequestNotFoundError, makeLiveRequests } from "./LiveRequests.ts";

const workItemId = WorkItemId.make("wi-1");
const runAttemptId = RunAttemptId.make("run-1");
const otherRun = RunAttemptId.make("run-2");

describe("LiveRequests", () => {
  it.effect("registers and answers an approval request", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const deferred = yield* service.registerApproval({
        requestId: "req-1",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "Run npm install?",
      });
      const pending = yield* service.listPending(runAttemptId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.action).toBe("command_execution");
      yield* service.respondToApproval("req-1", "approved");
      const decision = yield* Deferred.await(deferred);
      expect(decision).toBe("approved");
      const after = yield* service.listPending(runAttemptId);
      expect(after).toHaveLength(0);
    }),
  );

  it.effect("registers and answers a user input request", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const deferred = yield* service.registerUserInput({
        requestId: "req-2",
        workItemId,
        runAttemptId,
        prompt: "Which branch?",
      });
      yield* service.respondToUserInput("req-2", "main");
      const text = yield* Deferred.await(deferred);
      expect(text).toBe("main");
    }),
  );

  it.effect("fails when responding to an unknown request", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const result = yield* Effect.result(service.respondToApproval("missing", "approved"));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(LiveRequestNotFoundError);
      }
    }),
  );

  it.effect("scopes pending lists per run", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      yield* service.registerApproval({
        requestId: "req-1",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      yield* service.registerApproval({
        requestId: "req-2",
        workItemId,
        runAttemptId: otherRun,
        action: "command_execution",
        prompt: "B",
      });
      const first = yield* service.listPending(runAttemptId);
      const second = yield* service.listPending(otherRun);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
    }),
  );

  it.effect("settles all outstanding requests for a run on exit", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      yield* service.registerApproval({
        requestId: "req-1",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      yield* service.registerApproval({
        requestId: "req-2",
        workItemId,
        runAttemptId: otherRun,
        action: "command_execution",
        prompt: "B",
      });
      yield* service.settleRun(runAttemptId, "cancelled");
      const first = yield* service.listPending(runAttemptId);
      const second = yield* service.listPending(otherRun);
      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    }),
  );

  it.effect("settleRun is idempotent", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      yield* service.registerApproval({
        requestId: "req-1",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      yield* service.settleRun(runAttemptId, "cancelled");
      yield* service.settleRun(runAttemptId, "cancelled");
      const pending = yield* service.listPending(runAttemptId);
      expect(pending).toHaveLength(0);
    }),
  );
});
