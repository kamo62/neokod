import type { ApprovalAnswerInput, RunAttemptId, WorkItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type UserInputAnswerValue = string | ReadonlyArray<string>;
/** Answers keyed by the provider's exact question id. */
export type UserInputAnswers = Readonly<Record<string, UserInputAnswerValue>>;

const isAnswerValue = (value: unknown): value is UserInputAnswerValue =>
  typeof value === "string"
    ? value.trim().length > 0
    : Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.trim().length > 0);

/**
 * Validate that an answer map covers exactly the provider's question ids.
 *
 * Missing, extra, duplicate or empty answers are problems, never silently
 * defaulted: the wrong answer reaching a blocking question is worse than a
 * refused submission. Custom text is valid answer content; option membership is
 * a presentation concern.
 */
export const answerMapProblems = (
  questionIds: ReadonlyArray<string>,
  answers: UserInputAnswers,
): ReadonlyArray<string> => {
  const problems: string[] = [];
  const expected = new Set(questionIds);
  if (expected.size !== questionIds.length) {
    problems.push("the provider supplied duplicate question ids");
  }
  for (const [id, value] of Object.entries(answers)) {
    if (!expected.has(id)) problems.push(`answer for unknown question ${id}`);
    if (!isAnswerValue(value)) problems.push(`answer for question ${id} is empty`);
  }
  for (const id of expected) {
    if (!(id in answers)) problems.push(`missing answer for question ${id}`);
  }
  return problems;
};

/** Build the answer map for the provider, or `null` when ids do not match exactly. */
export const buildUserInputAnswerMap = (
  questionIds: ReadonlyArray<string>,
  answers: ReadonlyArray<ApprovalAnswerInput>,
): UserInputAnswers | null => {
  const map: Record<string, UserInputAnswerValue> = {};
  for (const entry of answers) {
    if (entry.questionId in map) return null;
    map[entry.questionId] = entry.answer;
  }
  return answerMapProblems(questionIds, map).length === 0 ? map : null;
};

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
  /** Provider question ids for a user-input request; used for exact answer checks. */
  readonly questionIds?: ReadonlyArray<string>;
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

/** The submitted answers do not match the provider question ids exactly. */
export class LiveRequestAnswerMismatchError extends Error {
  readonly requestId: string;
  readonly problems: ReadonlyArray<string>;

  constructor(requestId: string, problems: ReadonlyArray<string>) {
    super(`Answers for request ${requestId} do not match its questions: ${problems.join("; ")}`);
    this.name = "LiveRequestAnswerMismatchError";
    this.requestId = requestId;
    this.problems = problems;
  }
}

/** A provider request id is already live for this run; keep its Deferred. */
export class LiveRequestAlreadyPendingError extends Error {
  readonly requestId: string;
  readonly runAttemptId: string;

  constructor(requestId: string, runAttemptId: string) {
    super(`Request ${requestId} is already pending for run ${runAttemptId}`);
    this.name = "LiveRequestAlreadyPendingError";
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
  }) => Effect.Effect<Deferred.Deferred<ApprovalDecision>, LiveRequestAlreadyPendingError>;

  /**
   * Register a blocking user-input request. Returns the Deferred the agent
   * waits on; resolves to the operator's answers keyed by provider question id.
   */
  readonly registerUserInput: (input: {
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
    readonly prompt: string;
    readonly questionIds?: ReadonlyArray<string>;
  }) => Effect.Effect<Deferred.Deferred<UserInputAnswers>, LiveRequestAlreadyPendingError>;

  /** Answer a pending approval. Fails with LiveRequestNotFoundError if absent. */
  readonly respondToApproval: (
    runAttemptId: RunAttemptId,
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, LiveRequestNotFoundError>;

  /** Answer a pending user-input request. Fails if absent or the ids do not match. */
  readonly respondToUserInput: (
    runAttemptId: RunAttemptId,
    requestId: string,
    answers: UserInputAnswers,
  ) => Effect.Effect<void, LiveRequestNotFoundError | LiveRequestAnswerMismatchError>;

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
   * Remove the exact registration this caller created, matched by Deferred
   * identity. Returns false when it is absent or replaced. Does not fail the
   * Deferred.
   */
  readonly withdrawPending: (
    runAttemptId: RunAttemptId,
    requestId: string,
    deferred: Deferred.Deferred<unknown>,
  ) => Effect.Effect<boolean>;

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

/**
 * Test-only seam for the claim→resolve critical section. Production callers
 * never set it; it exists so a regression can interrupt a resolver at the
 * exact boundary between removing a request and completing its Deferred.
 */
export interface LiveRequestsTestHooks {
  readonly afterClaim?: Effect.Effect<void>;
}

export const makeLiveRequestsWithHooks = (hooks: LiveRequestsTestHooks) =>
  Effect.gen(function* () {
    const store = yield* Ref.make<Record<string, PendingApprovalRequest>>(EMPTY);

    const keyOf = (runAttemptId: RunAttemptId, requestId: string): string =>
      `${runAttemptId}:${requestId}`;

    const putIfAbsent = (entry: PendingApprovalRequest) =>
      Ref.modify(store, (current): readonly [boolean, Record<string, PendingApprovalRequest>] => {
        const key = keyOf(entry.runAttemptId, entry.requestId);
        if (current[key] !== undefined) return [false, current];
        return [true, { ...current, [key]: entry }];
      });

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

    /**
     * Claim and resolve must be one interruption-safe step. Removing the entry
     * without completing its Deferred would strand the agent: nobody could claim
     * the request again and the runtime would wait on a Deferred that can never
     * complete. The protected section is only in-memory work (a compare-and-set
     * plus a Deferred completion); durable writes stay outside it.
     */
    const claimAndComplete = <A>(
      runAttemptId: RunAttemptId,
      requestId: string,
      kind: PendingApprovalRequest["kind"] | undefined,
      complete: (deferred: Deferred.Deferred<A>) => Effect.Effect<boolean>,
    ): Effect.Effect<"claimed" | "missing" | "already-completed"> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const claim = yield* claimEntry(runAttemptId, requestId, kind);
          if (claim._tag !== "claimed") {
            return "missing" as const;
          }
          yield* hooks.afterClaim ?? Effect.void;
          const completed = yield* complete(claim.entry.deferred as Deferred.Deferred<A>);
          return completed ? ("claimed" as const) : ("already-completed" as const);
        }),
      );

    const registerApproval: LiveRequestsService["registerApproval"] = (input) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<ApprovalDecision>();
        const inserted = yield* putIfAbsent({
          requestId: input.requestId,
          workItemId: input.workItemId,
          runAttemptId: input.runAttemptId,
          kind: "approval",
          action: input.action,
          prompt: input.prompt,
          deferred: deferred as Deferred.Deferred<unknown>,
        });
        if (!inserted) {
          return yield* Effect.fail(
            new LiveRequestAlreadyPendingError(input.requestId, String(input.runAttemptId)),
          );
        }
        return deferred;
      });

    const registerUserInput: LiveRequestsService["registerUserInput"] = (input) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<UserInputAnswers>();
        const inserted = yield* putIfAbsent({
          requestId: input.requestId,
          workItemId: input.workItemId,
          runAttemptId: input.runAttemptId,
          kind: "user_input",
          action: "user_input",
          prompt: input.prompt,
          ...(input.questionIds !== undefined ? { questionIds: input.questionIds } : {}),
          deferred: deferred as Deferred.Deferred<unknown>,
        });
        if (!inserted) {
          return yield* Effect.fail(
            new LiveRequestAlreadyPendingError(input.requestId, String(input.runAttemptId)),
          );
        }
        return deferred;
      });

    const respondToApproval: LiveRequestsService["respondToApproval"] = (
      runAttemptId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        // Winning the claim is the only way to answer: no other path holds this
        // entry any more, so the decision the agent observes is the one recorded.
        const outcome = yield* claimAndComplete(runAttemptId, requestId, "approval", (deferred) =>
          Deferred.succeed(deferred as Deferred.Deferred<ApprovalDecision>, decision),
        );
        if (outcome !== "claimed") {
          return yield* Effect.fail(new LiveRequestNotFoundError(requestId, String(runAttemptId)));
        }
      });

    const respondToUserInput: LiveRequestsService["respondToUserInput"] = (
      runAttemptId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        // Validate against the registered question ids before claiming: an
        // answer with missing or extra ids must not reach the agent at all.
        const current = yield* Ref.get(store);
        const entry = current[keyOf(runAttemptId, requestId)];
        if (entry === undefined || entry.kind !== "user_input") {
          return yield* Effect.fail(new LiveRequestNotFoundError(requestId, String(runAttemptId)));
        }
        const problems = answerMapProblems(entry.questionIds ?? [], answers);
        if (problems.length > 0) {
          return yield* Effect.fail(new LiveRequestAnswerMismatchError(requestId, problems));
        }
        const outcome = yield* claimAndComplete(runAttemptId, requestId, "user_input", (deferred) =>
          Deferred.succeed(deferred as Deferred.Deferred<UserInputAnswers>, answers),
        );
        if (outcome !== "claimed") {
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

    const withdrawPending: LiveRequestsService["withdrawPending"] = (
      runAttemptId,
      requestId,
      deferred,
    ) =>
      Ref.modify(store, (current): readonly [boolean, Record<string, PendingApprovalRequest>] => {
        const key = keyOf(runAttemptId, requestId);
        const entry = current[key];
        if (entry === undefined || entry.deferred !== deferred) return [false, current];
        const next = { ...current };
        delete next[key];
        return [true, next];
      });

    const settleRun: LiveRequestsService["settleRun"] = (runAttemptId, reason) =>
      // Claiming the run's entries and failing each Deferred is one
      // uninterruptible step: an interrupted settlement must not remove requests
      // whose Deferreds stay unresolved.
      Effect.uninterruptible(
        Effect.gen(function* () {
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
          if (claimed.length > 0) {
            yield* hooks.afterClaim ?? Effect.void;
          }
          yield* Effect.forEach(claimed, (entry) =>
            Deferred.fail(
              entry.deferred as unknown as Deferred.Deferred<unknown, Error>,
              new Error(`Run settled: ${reason}`),
            ).pipe(Effect.ignore),
          );
        }),
      );

    const settleRequest: LiveRequestsService["settleRequest"] = (runAttemptId, requestId, reason) =>
      Effect.gen(function* () {
        const outcome = yield* claimAndComplete(runAttemptId, requestId, undefined, (deferred) =>
          Deferred.fail(
            deferred as unknown as Deferred.Deferred<unknown, Error>,
            new Error(`Request settled: ${reason}`),
          ).pipe(Effect.ignore, Effect.as(true)),
        );
        return outcome === "claimed";
      });

    return {
      registerApproval,
      registerUserInput,
      respondToApproval,
      respondToUserInput,
      listPending,
      settleRun,
      settleRequest,
      withdrawPending,
    };
  });

/** Production registry: no test hooks. */
export const makeLiveRequests = makeLiveRequestsWithHooks({});

export const LiveRequestsLive: Layer.Layer<LiveRequests> = Layer.effect(
  LiveRequests,
  makeLiveRequests,
);
