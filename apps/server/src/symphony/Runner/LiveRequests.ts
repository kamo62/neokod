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
 * This registry holds those Deferreds keyed by `(runAttemptId, requestId)`
 * so the RPC layer can answer them. It is in-memory only; the
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
  readonly runAttemptId: string | undefined;

  constructor(requestId: string, runAttemptId?: string) {
    super(
      runAttemptId === undefined
        ? `No pending live request with id ${requestId}`
        : `No pending live request with id ${requestId} for run ${runAttemptId}`,
    );
    this.name = "LiveRequestNotFoundError";
    this.requestId = requestId;
    this.runAttemptId = runAttemptId;
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
    runAttemptId: RunAttemptId,
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, LiveRequestNotFoundError>;

  /** Answer a pending user-input request. Fails if absent. */
  readonly respondToUserInput: (
    runAttemptId: RunAttemptId,
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
   * Fail one outstanding request (approval timeout sweep). Returns true only
   * for the caller that won the atomic claim; a request that an answer already
   * resolved is left untouched, so only one terminal outcome applies.
   */
  readonly settleRequest: (
    runAttemptId: RunAttemptId,
    requestId: string,
    reason: string,
  ) => Effect.Effect<boolean>;
}

export class LiveRequests extends Context.Service<LiveRequests, LiveRequestsService>()(
  "neokod/symphony/Runner/LiveRequests",
) {}

/**
 * Result of the single compare-and-set that resolves a pending request. Only
 * the caller that receives `claimed` may answer the agent or persist an
 * outcome; everyone else is a no-op.
 */
type RequestClaim =
  | { readonly _tag: "claimed"; readonly entry: PendingApprovalRequest }
  | { readonly _tag: "missing" };

const EMPTY: Record<string, PendingApprovalRequest> = {};

export const makeLiveRequests = Effect.gen(function* () {
  const store = yield* Ref.make<Record<string, PendingApprovalRequest>>(EMPTY);

  const keyOf = (runAttemptId: RunAttemptId, requestId: string): string =>
    `${runAttemptId}:${requestId}`;

  const put = (entry: PendingApprovalRequest) =>
    Ref.update(store, (current) => ({
      ...current,
      [keyOf(entry.runAttemptId, entry.requestId)]: entry,
    }));

  /**
   * Atomic compare-and-set: the caller that removes the entry owns the
   * outcome. An answer and a timeout can therefore never both apply, and a
   * request whose kind does not match is not claimed.
   */
  const claimEntry = (
    runAttemptId: RunAttemptId,
    requestId: string,
    kind?: PendingApprovalRequest["kind"],
  ): Effect.Effect<RequestClaim> =>
    Ref.modify(
      store,
      (current): readonly [RequestClaim, Record<string, PendingApprovalRequest>] => {
        const key = keyOf(runAttemptId, requestId);
        const entry = current[key];
        if (entry === undefined || (kind !== undefined && entry.kind !== kind)) {
          return [{ _tag: "missing" }, current];
        }
        const next = { ...current };
        delete next[key];
        return [{ _tag: "claimed", entry }, next];
      },
    );

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

  const respondToApproval: LiveRequestsService["respondToApproval"] = (
    runAttemptId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const claim = yield* claimEntry(runAttemptId, requestId, "approval");
      if (claim._tag !== "claimed") {
        return yield* Effect.fail(new LiveRequestNotFoundError(requestId, String(runAttemptId)));
      }
      // Winning the claim is the only way to answer: no other path holds this
      // entry any more, so the decision the agent observes is the one recorded.
      const answered = yield* Deferred.succeed(
        claim.entry.deferred as Deferred.Deferred<ApprovalDecision>,
        decision,
      );
      if (!answered) {
        return yield* Effect.fail(new LiveRequestNotFoundError(requestId, String(runAttemptId)));
      }
    });

  const respondToUserInput: LiveRequestsService["respondToUserInput"] = (
    runAttemptId,
    requestId,
    text,
  ) =>
    Effect.gen(function* () {
      const claim = yield* claimEntry(runAttemptId, requestId, "user_input");
      if (claim._tag !== "claimed") {
        return yield* Effect.fail(new LiveRequestNotFoundError(requestId, String(runAttemptId)));
      }
      const answered = yield* Deferred.succeed(
        claim.entry.deferred as Deferred.Deferred<string>,
        text,
      );
      if (!answered) {
        return yield* Effect.fail(new LiveRequestNotFoundError(requestId, String(runAttemptId)));
      }
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
      // Remove every entry for the run in one atomic step; a concurrent answer
      // either claims its entry first or finds it gone.
      const claimed = yield* Ref.modify(store, (current) => {
        const entries = Object.entries(current).filter(
          ([, entry]) => entry.runAttemptId === runAttemptId,
        );
        if (entries.length === 0) {
          return [[] as ReadonlyArray<PendingApprovalRequest>, current] as const;
        }
        const next = { ...current };
        for (const [key] of entries) {
          delete next[key];
        }
        return [
          entries.map(([, entry]) => entry) as ReadonlyArray<PendingApprovalRequest>,
          next,
        ] as const;
      });
      yield* Effect.forEach(claimed, (entry) =>
        Deferred.fail(
          entry.deferred as unknown as Deferred.Deferred<unknown, Error>,
          new Error(`Run settled: ${reason}`),
        ).pipe(Effect.ignore),
      );
    });

  const settleRequest: LiveRequestsService["settleRequest"] = (runAttemptId, requestId, reason) =>
    Effect.gen(function* () {
      const claim = yield* claimEntry(runAttemptId, requestId);
      if (claim._tag !== "claimed") {
        return false;
      }
      yield* Deferred.fail(
        claim.entry.deferred as unknown as Deferred.Deferred<unknown, Error>,
        new Error(`Request settled: ${reason}`),
      ).pipe(Effect.ignore);
      return true;
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
