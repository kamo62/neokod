import type { RunAttemptId, WorkItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Live request registry (plan 8.3.1, SPEC 8.3.1).
 *
 * Approvals and user-input requests are blocking server-to-client requests:
 * the agent process waits on a Deferred that lives in the orchestrator process.
 * This registry holds those Deferreds keyed by `(workItemId, runAttemptId,
 * requestId)` so the RPC layer can answer them. It is in-memory only; the
 * durable row (SymphonyApprovals) is a separate concern for history/audit.
 *
 * Settlement is one idempotent operation invoked on every exit path:
 * cancellation, timeout, stall, turn/interrupt, unexpected exit, normal close.
 * `settleRun` fails every outstanding request for a run so no row is left
 * `pending` with no Deferred behind it.
 */

export type ApprovalDecision = "approved" | "rejected";

export interface PendingApprovalRequest {
  readonly requestId: string;
  readonly workItemId: WorkItemId;
  readonly runAttemptId: RunAttemptId;
  readonly kind: "approval" | "user_input";
  readonly action: string;
  readonly prompt: string;
  readonly deferred: Deferred.Deferred<unknown>;
}

export class LiveRequestNotFoundError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`No pending live request with id ${requestId}`);
    this.name = "LiveRequestNotFoundError";
    this.requestId = requestId;
  }
}

export interface LiveRequestsService {
  /**
   * Register a blocking approval request. Returns the Deferred the agent waits
   * on; resolves to `"approved" | "rejected"`.
   */
  readonly registerApproval: (input: {
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
    readonly action: string;
    readonly prompt: string;
  }) => Effect.Effect<Deferred.Deferred<ApprovalDecision>>;

  /**
   * Register a blocking user-input request. Returns the Deferred the agent
   * waits on; resolves to the operator's free-text answer.
   */
  readonly registerUserInput: (input: {
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
    readonly prompt: string;
  }) => Effect.Effect<Deferred.Deferred<string>>;

  /** Answer a pending approval. Fails with LiveRequestNotFoundError if absent. */
  readonly respondToApproval: (
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, LiveRequestNotFoundError>;

  /** Answer a pending user-input request. Fails if absent. */
  readonly respondToUserInput: (
    requestId: string,
    text: string,
  ) => Effect.Effect<void, LiveRequestNotFoundError>;

  /** List the currently pending requests for a run (for the attention UI). */
  readonly listPending: (runAttemptId: RunAttemptId) => Effect.Effect<
    ReadonlyArray<{
      readonly requestId: string;
      readonly kind: "approval" | "user_input";
      readonly action: string;
      readonly prompt: string;
    }>
  >;

  /**
   * Idempotently fail every outstanding request for a run. Called on every
   * exit path; safe to call multiple times.
   */
  readonly settleRun: (runAttemptId: RunAttemptId, reason: string) => Effect.Effect<void>;

  /**
   * Fail one outstanding request (approval timeout sweep). No-op when the
   * request is already settled.
   */
  readonly settleRequest: (requestId: string, reason: string) => Effect.Effect<void>;
}

export class LiveRequests extends Context.Service<LiveRequests, LiveRequestsService>()(
  "neokod/symphony/Runner/LiveRequests",
) {}

const EMPTY: Record<string, PendingApprovalRequest> = {};

export const makeLiveRequests = Effect.gen(function* () {
  const store = yield* Ref.make<Record<string, PendingApprovalRequest>>(EMPTY);

  const keyOf = (workItemId: WorkItemId, runAttemptId: RunAttemptId, requestId: string): string =>
    `${workItemId}:${runAttemptId}:${requestId}`;

  const put = (entry: PendingApprovalRequest) =>
    Ref.update(store, (current) => ({
      ...current,
      [keyOf(entry.workItemId, entry.runAttemptId, entry.requestId)]: entry,
    }));

  const removeByRequestId = (requestId: string) =>
    Ref.update(store, (current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (next[key]?.requestId === requestId) {
          delete next[key];
        }
      }
      return next;
    });

  const registerApproval: LiveRequestsService["registerApproval"] = (input) =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<ApprovalDecision>();
      yield* put({
        requestId: input.requestId,
        workItemId: input.workItemId,
        runAttemptId: input.runAttemptId,
        kind: "approval",
        action: input.action,
        prompt: input.prompt,
        deferred: deferred as Deferred.Deferred<unknown>,
      });
      return deferred;
    });

  const registerUserInput: LiveRequestsService["registerUserInput"] = (input) =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<string>();
      yield* put({
        requestId: input.requestId,
        workItemId: input.workItemId,
        runAttemptId: input.runAttemptId,
        kind: "user_input",
        action: "user_input",
        prompt: input.prompt,
        deferred: deferred as Deferred.Deferred<unknown>,
      });
      return deferred;
    });

  const findEntry = (requestId: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(store);
      const entry = Object.values(current).find((value) => value.requestId === requestId);
      if (entry === undefined) {
        return yield* Effect.fail(new LiveRequestNotFoundError(requestId));
      }
      return entry;
    });

  const respondToApproval: LiveRequestsService["respondToApproval"] = (requestId, decision) =>
    Effect.gen(function* () {
      const entry = yield* findEntry(requestId);
      if (entry.kind !== "approval") {
        return yield* Effect.fail(new LiveRequestNotFoundError(requestId));
      }
      yield* Deferred.succeed(entry.deferred as Deferred.Deferred<ApprovalDecision>, decision);
      yield* removeByRequestId(requestId);
    });

  const respondToUserInput: LiveRequestsService["respondToUserInput"] = (requestId, text) =>
    Effect.gen(function* () {
      const entry = yield* findEntry(requestId);
      if (entry.kind !== "user_input") {
        return yield* Effect.fail(new LiveRequestNotFoundError(requestId));
      }
      yield* Deferred.succeed(entry.deferred as Deferred.Deferred<string>, text);
      yield* removeByRequestId(requestId);
    });

  const listPending: LiveRequestsService["listPending"] = (runAttemptId) =>
    Effect.map(Ref.get(store), (current) =>
      Object.values(current)
        .filter((value) => value.runAttemptId === runAttemptId)
        .map((value) => ({
          requestId: value.requestId,
          kind: value.kind,
          action: value.action,
          prompt: value.prompt,
        })),
    );

  const settleRun: LiveRequestsService["settleRun"] = (runAttemptId, reason) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(store);
      const entries = Object.values(current).filter((value) => value.runAttemptId === runAttemptId);
      yield* Effect.forEach(entries, (entry) =>
        Deferred.fail(
          entry.deferred as unknown as Deferred.Deferred<unknown, Error>,
          new Error(`Run settled: ${reason}`),
        ).pipe(Effect.catch(() => Effect.void)),
      );
      yield* Ref.update(store, (currentStore) => {
        const next = { ...currentStore };
        for (const key of Object.keys(next)) {
          if (next[key]?.runAttemptId === runAttemptId) {
            delete next[key];
          }
        }
        return next;
      });
    });

  const settleRequest: LiveRequestsService["settleRequest"] = (requestId, reason) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(store);
      const entry = Object.values(current).find((value) => value.requestId === requestId);
      if (entry !== undefined) {
        yield* Deferred.fail(
          entry.deferred as unknown as Deferred.Deferred<unknown, Error>,
          new Error(`Request settled: ${reason}`),
        ).pipe(Effect.catch(() => Effect.void));
        yield* removeByRequestId(requestId);
      }
    });

  return {
    registerApproval,
    registerUserInput,
    respondToApproval,
    respondToUserInput,
    listPending,
    settleRun,
    settleRequest,
  };
});

export const LiveRequestsLive: Layer.Layer<LiveRequests> = Layer.effect(
  LiveRequests,
  makeLiveRequests,
);
