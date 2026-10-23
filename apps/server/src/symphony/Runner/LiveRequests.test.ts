import { describe, expect, it } from "@effect/vitest";
import { RunAttemptId, WorkItemId } from "@neokod/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  LiveRequestNotFoundError,
  makeLiveRequests,
  makeLiveRequestsWithHooks,
} from "./LiveRequests.ts";

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
      yield* service.respondToApproval(runAttemptId, "req-1", "approved");
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
        questionIds: ["q1"],
      });
      yield* service.respondToUserInput(runAttemptId, "req-2", { q1: "main" });
      const answers = yield* Deferred.await(deferred);
      expect(answers).toEqual({ q1: "main" });
    }),
  );

  it.effect("refuses an answer map that does not match the question ids exactly", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const deferred = yield* service.registerUserInput({
        requestId: "req-2-mismatch",
        workItemId,
        runAttemptId,
        prompt: "Which branch?",
        questionIds: ["q1", "q2"],
      });
      const missing = yield* Effect.result(
        service.respondToUserInput(runAttemptId, "req-2-mismatch", { q1: "main" }),
      );
      expect(missing._tag).toBe("Failure");
      const extra = yield* Effect.result(
        service.respondToUserInput(runAttemptId, "req-2-mismatch", {
          q1: "main",
          q2: "why",
          q3: "not asked",
        }),
      );
      expect(extra._tag).toBe("Failure");
      expect(yield* Deferred.isDone(deferred)).toBe(false);
      yield* service.respondToUserInput(runAttemptId, "req-2-mismatch", {
        q1: "main",
        q2: "why",
      });
      expect(yield* Deferred.await(deferred)).toEqual({ q1: "main", q2: "why" });
    }),
  );

  it.effect("fails when responding to an unknown request", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const result = yield* Effect.result(
        service.respondToApproval(runAttemptId, "missing", "approved"),
      );
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

  it.effect("refuses an answer when the request was already settled elsewhere", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const deferred = yield* service.registerApproval({
        requestId: "req-race",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      // Another path answered the Deferred without removing the registry entry
      // yet (the timeout settlement sits between Deferred completion and key
      // removal). A late click must not report success.
      yield* Deferred.succeed(deferred, "approved");
      const failure = yield* Effect.flip(
        service.respondToApproval(runAttemptId, "req-race", "rejected"),
      );
      expect(failure).toBeInstanceOf(LiveRequestNotFoundError);
      expect(yield* service.listPending(runAttemptId)).toHaveLength(0);
    }),
  );

  it.effect("an answer that wins the claim makes a later timeout a no-op", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      yield* service.registerApproval({
        requestId: "req-cas-answer",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      const answered = yield* Effect.result(
        service.respondToApproval(runAttemptId, "req-cas-answer", "approved"),
      );
      expect(answered._tag).toBe("Success");
      // The timeout arrives late: it must lose the claim, not settle the request
      // or authorise a second outcome.
      expect(yield* service.settleRequest(runAttemptId, "req-cas-answer", "timed out")).toBe(false);
      expect(yield* service.listPending(runAttemptId)).toHaveLength(0);
    }),
  );

  it.effect("a timeout that wins the claim makes a later answer a no-op", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const deferred = yield* service.registerApproval({
        requestId: "req-cas-timeout",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      expect(yield* service.settleRequest(runAttemptId, "req-cas-timeout", "timed out")).toBe(true);
      const answered = yield* Effect.result(
        service.respondToApproval(runAttemptId, "req-cas-timeout", "approved"),
      );
      expect(answered._tag).toBe("Failure");
      expect(yield* Deferred.isDone(deferred)).toBe(true);
    }),
  );

  it.effect("racing a timeout against an answer yields exactly one winner", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const deferred = yield* service.registerApproval({
        requestId: "req-race-timeout",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      const [settled, answered] = yield* Effect.all(
        [
          service.settleRequest(runAttemptId, "req-race-timeout", "request wait timed out"),
          Effect.result(service.respondToApproval(runAttemptId, "req-race-timeout", "approved")),
        ],
        { concurrency: "unbounded" },
      );

      // Exactly one of the two claimed the request.
      expect(settled).toBe(answered._tag === "Failure");
      // And the agent observed that same outcome.
      const observed = yield* Effect.result(Deferred.await(deferred));
      expect(observed._tag).toBe(answered._tag === "Success" ? "Success" : "Failure");
    }),
  );

  it.effect("an interrupt at the claim boundary still completes the request", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The hook runs between removing the entry and completing its Deferred —
      // the exact boundary an interruption used to strand.
      const service = yield* makeLiveRequestsWithHooks({
        afterClaim: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      const deferred = yield* service.registerApproval({
        requestId: "req-boundary-1",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });

      const answer = yield* Effect.forkChild(
        service.respondToApproval(runAttemptId, "req-boundary-1", "approved"),
      );
      yield* Deferred.await(started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(answer));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);

      // The claim and its Deferred completion are one uninterruptible step: the
      // resolver was interrupted, yet nothing was removed without an outcome.
      expect(yield* service.listPending(runAttemptId)).toHaveLength(0);
      expect(yield* Deferred.isDone(deferred)).toBe(true);
      expect(yield* Deferred.await(deferred)).toBe("approved");
      // Nothing is left for a later settlement to find.
      expect(yield* service.settleRequest(runAttemptId, "req-boundary-1", "late")).toBe(false);
    }),
  );

  it.effect("an interrupt at the claim boundary still fails every claimed request", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const service = yield* makeLiveRequestsWithHooks({
        afterClaim: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      const approval = yield* service.registerApproval({
        requestId: "req-boundary-2a",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      const question = yield* service.registerUserInput({
        requestId: "req-boundary-2b",
        workItemId,
        runAttemptId,
        prompt: "Which branch?",
      });

      const settling = yield* Effect.forkChild(service.settleRun(runAttemptId, "cancelled"));
      yield* Deferred.await(started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(settling));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);

      expect(yield* service.listPending(runAttemptId)).toHaveLength(0);
      expect(yield* Deferred.isDone(approval)).toBe(true);
      expect(yield* Deferred.isDone(question)).toBe(true);
      // The removed requests are settled, so a late answer is refused.
      const late = yield* Effect.result(
        service.respondToApproval(runAttemptId, "req-boundary-2a", "approved"),
      );
      expect(late._tag).toBe("Failure");
    }),
  );

  it.effect("refuses a duplicate registration without replacing the live Deferred", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const first = yield* service.registerUserInput({
        requestId: "req-duplicate",
        workItemId,
        runAttemptId,
        prompt: "Which branch?",
        questionIds: ["q1"],
      });
      const duplicate = yield* Effect.result(
        service.registerUserInput({
          requestId: "req-duplicate",
          workItemId,
          runAttemptId,
          prompt: "Which branch?",
          questionIds: ["q1"],
        }),
      );
      expect(duplicate._tag).toBe("Failure");
      // The original Deferred is still the one the answer resolves.
      yield* service.respondToUserInput(runAttemptId, "req-duplicate", { q1: "main" });
      expect(yield* Deferred.await(first)).toEqual({ q1: "main" });
    }),
  );

  it.effect("withdraws only the exact registration identity, never a replacement", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const first = yield* service.registerUserInput({
        requestId: "req-identity",
        workItemId,
        runAttemptId,
        prompt: "Which branch?",
        questionIds: ["q1"],
      });
      const other = yield* Deferred.make<{ readonly q1: string }>();
      expect(
        yield* service.withdrawPending(
          runAttemptId,
          "req-identity",
          other as Deferred.Deferred<unknown>,
        ),
      ).toBe(false);
      expect(yield* service.listPending(runAttemptId)).toHaveLength(1);
      expect(
        yield* service.withdrawPending(
          runAttemptId,
          "req-identity",
          first as Deferred.Deferred<unknown>,
        ),
      ).toBe(true);
      expect(yield* service.listPending(runAttemptId)).toHaveLength(0);
    }),
  );

  it.effect("keeps the same request id in two runs apart", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveRequests;
      const first = yield* service.registerApproval({
        requestId: "0",
        workItemId,
        runAttemptId,
        action: "command_execution",
        prompt: "A",
      });
      const second = yield* service.registerApproval({
        requestId: "0",
        workItemId,
        runAttemptId: otherRun,
        action: "command_execution",
        prompt: "B",
      });
      yield* service.respondToApproval(otherRun, "0", "approved");
      expect(yield* Deferred.await(second)).toBe("approved");
      expect(yield* Deferred.isDone(first)).toBe(false);
      yield* service.settleRequest(runAttemptId, "0", "x");
      expect(yield* service.listPending(runAttemptId)).toHaveLength(0);
    }),
  );
});
