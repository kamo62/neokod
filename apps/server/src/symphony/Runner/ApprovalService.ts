import type { ApprovalRequest, RunAttemptId, WorkItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";

import { ApprovalRepository } from "../Persistence/Services/ApprovalRepository.ts";
import {
  type SymphonyPersistenceError,
  SymphonyPersistenceSqlError,
} from "../Persistence/Errors.ts";
import { LiveRequests, type ApprovalDecision } from "./LiveRequests.ts";

/**
 * ApprovalService (WS-J2).
 *
 * Bridges the two halves the plan's 8.3.1 requires: the in-memory LiveRequests
 * registry (which holds the Deferred the agent waits on) and the durable
 * ApprovalRepository (history/audit/UI). Decide operations answer the live
 * request first (so the agent proceeds) and persist the decision second; the
 * write is best-effort so a persistence failure never leaves the agent stuck.
 */

export class ApprovalRequestNotFoundError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`No pending approval or input request with id ${requestId}`);
    this.name = "ApprovalRequestNotFoundError";
    this.requestId = requestId;
  }
}

export interface ApprovalServiceShape {
  /** Persist a pending approval record (no live Deferred yet). */
  readonly recordPending: (input: {
    readonly id: string;
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
    readonly action: string;
    readonly scope: string;
    readonly command?: string;
    readonly workingDirectory?: string;
    readonly reason?: string;
    readonly affectedFiles?: ReadonlyArray<string>;
    readonly policySource?: string;
  }) => Effect.Effect<ApprovalRequest, SymphonyPersistenceError>;

  /**
   * Approve a pending live request: answer the Deferred (so the agent
   * proceeds) and persist the durable decision.
   */
  readonly approve: (requestId: string) => Effect.Effect<void, ApprovalRequestNotFoundError>;

  /**
   * Reject a pending live request: answer the Deferred with rejection and
   * persist the durable decision.
   */
  readonly reject: (
    requestId: string,
    reason?: string,
  ) => Effect.Effect<void, ApprovalRequestNotFoundError>;

  /** Answer a user-input request with free text. */
  readonly respondToUserInput: (
    requestId: string,
    text: string,
  ) => Effect.Effect<void, ApprovalRequestNotFoundError>;

  /** List pending durable requests (for the attention UI). */
  readonly listPending: (options?: { readonly limit?: number }) => Effect.Effect<ApprovalRequest[]>;

  /** List durable requests for a run. */
  readonly listForRun: (runAttemptId: RunAttemptId) => Effect.Effect<ApprovalRequest[]>;

  /**
   * Expire a request whose wait window elapsed (plan 8.3.1 timeout): settle
   * the live Deferred so the agent stops waiting, and persist the durable
   * `expired` decision. Keyed by the durable record id; the live request id
   * is read off the record so both id spaces are covered. Idempotent; a
   * request already decided is untouched.
   */
  readonly expire: (id: string) => Effect.Effect<void>;

  /**
   * Interrupt a request whose run died (recovery, plan 8.3.1; audit item 3):
   * same settle-and-persist as expire, with the durable `interrupted`
   * decision so the UI distinguishes a dead run from a timed-out wait.
   */
  readonly interrupt: (id: string) => Effect.Effect<void>;
}

export class ApprovalService extends Context.Service<ApprovalService, ApprovalServiceShape>()(
  "neokod/symphony/Runner/ApprovalService",
) {}

export const makeApprovalService = Effect.gen(function* () {
  const liveRequests = yield* LiveRequests;
  const repository = yield* ApprovalRepository;
  const crypto = yield* Crypto.Crypto;

  const makeId = () =>
    crypto.randomUUIDv4.pipe(
      Effect.map((value) => `sym-${value}`),
      Effect.mapError(
        (cause) =>
          new SymphonyPersistenceSqlError({
            operation: "ApprovalService.makeId",
            detail: String(cause),
          }),
      ),
    );

  const recordPending: ApprovalServiceShape["recordPending"] = (input) =>
    Effect.gen(function* () {
      const id = yield* makeId();
      return yield* repository.create({
        id,
        requestId: input.requestId,
        workItemId: String(input.workItemId),
        runAttemptId: input.runAttemptId,
        action: input.action,
        scope: input.scope,
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.workingDirectory !== undefined
          ? { workingDirectory: input.workingDirectory }
          : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.affectedFiles !== undefined ? { affectedFiles: input.affectedFiles } : {}),
        ...(input.policySource !== undefined ? { policySource: input.policySource } : {}),
      });
    });

  const decide = (
    requestId: string,
    decision: ApprovalDecision,
    reason: string | undefined,
  ): Effect.Effect<void, ApprovalRequestNotFoundError> =>
    Effect.gen(function* () {
      // 1. Answer the live Deferred so the agent proceeds.
      const liveResult = yield* Effect.result(liveRequests.respondToApproval(requestId, decision));
      if (liveResult._tag === "Failure") {
        return yield* Effect.fail(new ApprovalRequestNotFoundError(requestId));
      }
      // 2. Persist the durable decision (best-effort; never blocks the agent).
      yield* repository.decide(requestId, decision).pipe(Effect.catch(() => Effect.void));
    });

  const approve: ApprovalServiceShape["approve"] = (requestId) =>
    decide(requestId, "approved", undefined);

  const reject: ApprovalServiceShape["reject"] = (requestId, reason) =>
    decide(requestId, "rejected", reason);

  const respondToUserInput: ApprovalServiceShape["respondToUserInput"] = (requestId, text) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(liveRequests.respondToUserInput(requestId, text));
      if (result._tag === "Failure") {
        return yield* Effect.fail(new ApprovalRequestNotFoundError(requestId));
      }
      yield* repository.decide(requestId, "approved").pipe(Effect.catch(() => Effect.void));
    });

  const listPending: ApprovalServiceShape["listPending"] = (options) =>
    repository.listPending(options).pipe(Effect.catch(() => Effect.succeed([])));

  const listForRun: ApprovalServiceShape["listForRun"] = (runAttemptId) =>
    repository.listForRun(runAttemptId).pipe(Effect.catch(() => Effect.succeed([])));

  const expire: ApprovalServiceShape["expire"] = (id) =>
    Effect.gen(function* () {
      const record = yield* repository.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
      const liveId = record === null ? id : record.requestId;
      yield* liveRequests.settleRequest(liveId, "approval wait timed out");
      yield* repository.decide(id, "expired").pipe(Effect.catch(() => Effect.void));
    });

  const interrupt: ApprovalServiceShape["interrupt"] = (id) =>
    Effect.gen(function* () {
      const record = yield* repository.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
      const liveId = record === null ? id : record.requestId;
      yield* liveRequests.settleRequest(liveId, "run interrupted; approval unanswered");
      yield* repository.decide(id, "interrupted").pipe(Effect.catch(() => Effect.void));
    });

  return {
    recordPending,
    approve,
    reject,
    respondToUserInput,
    listPending,
    listForRun,
    expire,
    interrupt,
  };
});

export const ApprovalServiceLive: Layer.Layer<
  ApprovalService,
  never,
  LiveRequests | ApprovalRepository | Crypto.Crypto
> = Layer.effect(ApprovalService, makeApprovalService);
