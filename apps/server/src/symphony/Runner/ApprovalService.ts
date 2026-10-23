import type {
  ApprovalAnswerEntry,
  ApprovalAnswerInput,
  ApprovalAnswerRecord,
  ApprovalQuestion,
  ApprovalQuestionPayload,
  ApprovalRequest,
  ApprovalDecisionNote,
  RunAttemptId,
  WorkItemId,
} from "@neokod/contracts";
import { ApprovalQuestionPayloadSchema } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as Semaphore from "effect/Semaphore";

import { ApprovalRepository } from "../Persistence/Services/ApprovalRepository.ts";
import {
  type SymphonyPersistenceError,
  SymphonyPersistenceSqlError,
} from "../Persistence/Errors.ts";
import { nowIso } from "../Domain/Time.ts";
import { questionIsSensitive } from "../Domain/Approvals.ts";
import { LiveRequests, type ApprovalDecision, type UserInputAnswers } from "./LiveRequests.ts";

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

/**
 * The submitted answer cannot be matched to the preserved question payload.
 * A surfaced validation failure is better than answering the wrong question,
 * inventing an id, or storing text that will never reach the provider.
 */
export class ApprovalAnswerValidationError extends Error {
  readonly requestId: string;
  readonly detail: string;

  constructor(requestId: string, detail: string) {
    super(`The answer for request ${requestId} was not accepted: ${detail}`);
    this.name = "ApprovalAnswerValidationError";
    this.requestId = requestId;
    this.detail = detail;
  }
}

/**
 * The accepted content could not be finalised in durable history. `delivered`
 * distinguishes a write that failed before local acceptance (nothing sent, safe
 * to retry normally) from one that failed after the live Deferred was consumed
 * locally (provider receipt is unknown; retrying only finalises history).
 */
export class ApprovalHistoryPendingError extends Error {
  readonly requestId: string;
  readonly delivered: boolean;
  readonly retryable: boolean;

  constructor(requestId: string, delivered: boolean, detail: string, retryable = true) {
    super(
      !retryable
        ? `The answer for request ${requestId} was accepted locally; provider receipt is unknown. Its history remains delivery-unknown and cannot be finalised by retry because the secret answer cannot be compared. It will be reconciled at startup (${detail}).`
        : delivered
          ? `The answer for request ${requestId} was accepted locally, but its history could not be saved (${detail}). Provider receipt is unknown. Retry to finish recording it; do not resend the provider response.`
          : `The answer for request ${requestId} could not be saved (${detail}); nothing was sent. Retry the request.`,
    );
    this.name = "ApprovalHistoryPendingError";
    this.requestId = requestId;
    this.delivered = delivered;
    this.retryable = retryable;
  }
}

/** Explicit reconciliation evidence; unavailable is not "zero staged rows". */
export interface ApprovalReconciliationResult {
  readonly reconciled: number;
  readonly failedIds: ReadonlyArray<string>;
  readonly unavailable?: string;
}

export interface ApprovalDecisionSubmission {
  /** Saved to durable history only; Codex approval responses carry no note. */
  readonly note?: string;
  readonly runAttemptId?: RunAttemptId;
}

export interface UserInputAnswerSubmission {
  readonly answers?: ReadonlyArray<ApprovalAnswerInput>;
  readonly text?: string;
  readonly runAttemptId?: RunAttemptId;
}

const REDACTED_ANSWER = "[redacted]";

const decodeQuestionPayload = Schema.decodeUnknownOption(ApprovalQuestionPayloadSchema);

/**
 * Validate the whole payload before persistence. Anything that cannot be
 * represented becomes explicitly `unsupported`; no partial question list is
 * written where a later list decode could hide every other request.
 *
 * Pattern-detected sensitivity is normalised into the stored payload so the UI
 * reads the same authoritative flag that durable redaction uses.
 */
const normaliseQuestionPayload = (
  payload: ApprovalQuestionPayload | undefined,
): ApprovalQuestionPayload | undefined => {
  if (payload === undefined) return undefined;
  const decoded = decodeQuestionPayload(payload);
  if (Option.isNone(decoded)) {
    return {
      kind: "unsupported",
      providerMethod:
        payload.kind === "unsupported" ? payload.providerMethod : "item/tool/requestUserInput",
      detail: "the question payload could not be validated",
    };
  }
  const value = decoded.value;
  if (value.kind !== "structured") return value;
  return {
    ...value,
    questions: value.questions.map((question) =>
      questionIsSensitive(question) ? { ...question, sensitive: true } : question,
    ),
  };
};

const hasRedactedAnswer = (record: ApprovalAnswerRecord | undefined): boolean =>
  record?.answers.some((entry) => entry.redacted === true) ?? false;

const normaliseNote = (note: string | undefined): string | undefined => {
  const trimmed = note?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const sameAnswers = (
  left: ApprovalAnswerRecord | undefined,
  right: ApprovalAnswerRecord,
): boolean => {
  if (left === undefined) return false;
  const sameEntry = (a: ApprovalAnswerEntry, b: ApprovalAnswerEntry) =>
    a.questionId === b.questionId &&
    a.redacted === b.redacted &&
    JSON.stringify(a.answer) === JSON.stringify(b.answer);
  return (
    left.legacyText === right.legacyText &&
    left.answers.length === right.answers.length &&
    left.answers.every((entry, index) => sameEntry(entry, right.answers[index]!))
  );
};

const sameNote = (left: ApprovalDecisionNote | undefined, text: string | undefined): boolean =>
  (left?.text ?? undefined) === text;

interface PreparedAnswer {
  readonly answerMap: UserInputAnswers;
  readonly record: ApprovalAnswerRecord;
}

const answerValue = (entry: ApprovalAnswerInput): string | ReadonlyArray<string> =>
  typeof entry.answer === "string"
    ? entry.answer.trim()
    : entry.answer.map((value) => value.trim());

const validateStructuredAnswers = (
  questions: ReadonlyArray<ApprovalQuestion>,
  answers: ReadonlyArray<ApprovalAnswerInput>,
): {
  readonly answerMap: UserInputAnswers;
  readonly entries: ReadonlyArray<ApprovalAnswerEntry>;
} => {
  const questionIds = questions.map((question) => question.id);
  if (new Set(questionIds).size !== questionIds.length) {
    throw new ApprovalAnswerValidationError(
      "request",
      "the stored questions contain duplicate ids; the request cannot be answered safely",
    );
  }
  if (new Set(answers.map((answer) => answer.questionId)).size !== answers.length) {
    throw new ApprovalAnswerValidationError(
      "request",
      "an answer was supplied twice for one question",
    );
  }
  const expected = new Set(questionIds);
  const supplied = new Set(answers.map((answer) => answer.questionId));
  const missing = questionIds.filter((id) => !supplied.has(id));
  const extra = [...supplied].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0 || answers.length !== questions.length) {
    throw new ApprovalAnswerValidationError(
      "request",
      [
        missing.length > 0 ? `missing answer for ${missing.join(", ")}` : "",
        extra.length > 0 ? `unknown question id ${extra.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }

  const answerMap: Record<string, string | ReadonlyArray<string>> = {};
  const entries: ApprovalAnswerEntry[] = [];
  for (const question of questions) {
    const entry = answers.find((candidate) => candidate.questionId === question.id);
    if (entry === undefined) continue; // unreachable after the exact-id check
    const value = answerValue(entry);
    const isArray = Array.isArray(value);
    if (question.multiSelect === true && !isArray) {
      throw new ApprovalAnswerValidationError(
        question.id,
        "this question requires at least one choice",
      );
    }
    if (question.multiSelect !== true && isArray) {
      throw new ApprovalAnswerValidationError(question.id, "this question accepts one answer");
    }
    if (isArray && value.length === 0) {
      throw new ApprovalAnswerValidationError(
        question.id,
        "this question requires at least one choice",
      );
    }
    if (!isArray && value.length === 0) {
      throw new ApprovalAnswerValidationError(question.id, "the answer is empty");
    }
    answerMap[question.id] = value;
    entries.push({ questionId: question.id, answer: value });
  }
  return { answerMap, entries };
};

const prepareAnswer = (
  request: ApprovalRequest,
  submission: UserInputAnswerSubmission,
): Effect.Effect<PreparedAnswer, ApprovalAnswerValidationError> =>
  Effect.gen(function* () {
    const recordedAt = yield* nowIso;
    const payload = request.questionPayload;
    if (payload === undefined || payload.kind === "unsupported") {
      return yield* Effect.fail(
        new ApprovalAnswerValidationError(
          request.id,
          "the stored request did not preserve its questions, so it cannot be answered here",
        ),
      );
    }

    if (payload.kind === "legacy_text") {
      if (submission.answers !== undefined && submission.answers.length > 0) {
        return yield* Effect.fail(
          new ApprovalAnswerValidationError(
            request.id,
            "this request stores free text only; structured answers are not valid for it",
          ),
        );
      }
      const text = submission.text?.trim();
      if (text === undefined || text.length === 0) {
        return yield* Effect.fail(
          new ApprovalAnswerValidationError(request.id, "the answer is empty"),
        );
      }
      return {
        answerMap: {},
        record: {
          answers: [],
          legacyText: text,
          delivery: "unknown",
          actor: "local_operator",
          recordedAt,
        },
      };
    }

    // Structured questions require one structured answer per id. Legacy text is
    // never flattened across ids, because that reaches the wrong question.
    if (submission.answers === undefined) {
      return yield* Effect.fail(
        new ApprovalAnswerValidationError(
          request.id,
          "structured questions need one answer per question id",
        ),
      );
    }
    let validated: ReturnType<typeof validateStructuredAnswers>;
    try {
      validated = validateStructuredAnswers(payload.questions, submission.answers);
    } catch (cause) {
      if (cause instanceof ApprovalAnswerValidationError) {
        return yield* Effect.fail(new ApprovalAnswerValidationError(request.id, cause.detail));
      }
      throw cause;
    }

    const sensitiveIds = new Set(
      payload.questions.filter(questionIsSensitive).map((question) => question.id),
    );
    const redacted = validated.entries.map((entry) =>
      sensitiveIds.has(entry.questionId)
        ? { questionId: entry.questionId, answer: REDACTED_ANSWER as string, redacted: true }
        : entry,
    );
    return {
      answerMap: validated.answerMap,
      record: {
        answers: redacted,
        delivery: "unknown",
        actor: "local_operator",
        recordedAt,
      },
    };
  });

const decisionNote = (text: string | undefined): Effect.Effect<ApprovalDecisionNote | undefined> =>
  Effect.gen(function* () {
    const note = normaliseNote(text);
    if (note === undefined) return undefined;
    return {
      text: note,
      delivery: "history_only",
      actor: "local_operator",
      recordedAt: yield* nowIso,
    };
  });

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
    readonly questionPayload?: ApprovalQuestionPayload;
  }) => Effect.Effect<ApprovalRequest, SymphonyPersistenceError>;

  /**
   * Approve a pending live request: answer the Deferred (so the agent
   * proceeds) and persist the durable decision. A note is history only.
   */
  readonly approve: (
    requestId: string,
    submission?: ApprovalDecisionSubmission,
  ) => Effect.Effect<void, ApprovalRequestNotFoundError | ApprovalHistoryPendingError>;

  /**
   * Reject a pending live request: answer the Deferred with rejection and
   * persist the durable decision. A note is history only.
   */
  readonly reject: (
    requestId: string,
    submission?: ApprovalDecisionSubmission,
  ) => Effect.Effect<void, ApprovalRequestNotFoundError | ApprovalHistoryPendingError>;

  /** Answer a user-input request with structured answers (or legacy text). */
  readonly respondToUserInput: (
    requestId: string,
    submission: UserInputAnswerSubmission,
  ) => Effect.Effect<
    void,
    ApprovalRequestNotFoundError | ApprovalAnswerValidationError | ApprovalHistoryPendingError
  >;

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

  /**
   * Expire the durable record behind a live request id once the runtime's own
   * wait has timed out (the agent already received its fallback answer).
   *
   * Returns true only when this call won the atomic live claim and therefore
   * expired the request. A request an answer already resolved returns false and
   * is left untouched, so the row keeps exactly one terminal outcome.
   */
  readonly expireRequest: (runAttemptId: RunAttemptId, requestId: string) => Effect.Effect<boolean>;

  /**
   * Startup reconciliation for staged rows with no positive local receipt in
   * this process. Rows known to this process (claim succeeded, final write
   * failed) are left for an operator retry. Others become `interrupted` while
   * preserving their stored answer/note as delivery-unknown.
   */
  readonly reconcileUncertainDeliveries?: () => Effect.Effect<ApprovalReconciliationResult>;
}

export class ApprovalService extends Context.Service<ApprovalService, ApprovalServiceShape>()(
  "neokod/symphony/Runner/ApprovalService",
) {}

export const makeApprovalService = Effect.gen(function* () {
  const liveRequests = yield* LiveRequests;
  const repository = yield* ApprovalRepository;
  const crypto = yield* Crypto.Crypto;

  // One resolution at a time across the whole service: the live-registry claim
  // and the durable decision it authorises must not interleave with another
  // resolve for the same request (an answer next to a timeout, or two clicks).
  const resolutionMutex = yield* Semaphore.make(1);
  const withResolution = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    resolutionMutex.withPermits(1)(effect);

  /**
   * Positive local claim receipts for this process. A `delivering` row may be
   * finalised only when this set proves the live Deferred was consumed here;
   * a staged row surviving a restart has no receipt and must not be treated as
   * sent.
   */
  const consumedDeliveries = yield* Ref.make<ReadonlySet<string>>(new Set());
  const markConsumed = (id: string) =>
    Ref.update(consumedDeliveries, (current) => new Set(current).add(id));
  const clearConsumed = (id: string) =>
    Ref.update(consumedDeliveries, (current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const wasConsumed = (id: string) => Effect.map(Ref.get(consumedDeliveries), (set) => set.has(id));

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
    withResolution(
      Effect.gen(function* () {
        const existing = yield* repository
          .findByRequest(input.runAttemptId, input.requestId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        // One logical provider request per (run attempt, request id). A
        // redelivery returns the existing history instead of creating a second
        // row or replacing the live Deferred.
        if (existing !== null) return existing;
        const id = yield* makeId();
        const questionPayload = normaliseQuestionPayload(input.questionPayload);
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
          ...(questionPayload !== undefined ? { questionPayload } : {}),
        });
      }),
    );

  const logHistoryFailure = (operation: string, id: string) =>
    Effect.logWarning(`Symphony could not persist ${operation} history for request ${id}`);

  const decide = (
    id: string,
    decision: ApprovalDecision,
    submission: ApprovalDecisionSubmission | undefined,
  ): Effect.Effect<void, ApprovalRequestNotFoundError | ApprovalHistoryPendingError> =>
    withResolution(
      Effect.gen(function* () {
        const record = yield* repository.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
        if (record === null) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        if (
          submission?.runAttemptId !== undefined &&
          record.runAttemptId !== submission.runAttemptId
        ) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        const note = yield* decisionNote(submission?.note);
        const details = note === undefined ? {} : { decisionNote: note };
        // A retried submission after a lost response is idempotent when it
        // carries the same outcome. A different outcome for the same record is
        // stale, never a second decision.
        if (record.state === "delivering") {
          if (
            record.decision !== decision ||
            !sameNote(record.decisionNote, note?.text) ||
            !(yield* wasConsumed(record.id))
          ) {
            return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
          }
          yield* repository
            .completeDelivery(record.id, decision)
            .pipe(
              Effect.mapError((cause) => new ApprovalHistoryPendingError(id, true, String(cause))),
            );
          yield* clearConsumed(record.id);
          return;
        }
        if (record.state !== "pending") {
          if (record.state === decision && sameNote(record.decisionNote, note?.text)) {
            return;
          }
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        if (record.runAttemptId === undefined) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        const claimedLocally = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* repository
              .stageDelivery(record.id, decision, details)
              .pipe(
                Effect.mapError(
                  (cause) => new ApprovalHistoryPendingError(id, false, String(cause)),
                ),
              );
            const live = yield* Effect.result(
              liveRequests.respondToApproval(record.runAttemptId!, record.requestId, decision),
            );
            if (live._tag === "Failure") {
              // The live claim lost (timeout, run settlement or another
              // resolver). The staged content was never delivered, so close it
              // explicitly rather than leaving an invisible delivering row.
              yield* repository
                .abortDelivery(record.id, "interrupted")
                .pipe(Effect.catch(() => logHistoryFailure("aborted delivery", id)));
              return false;
            }
            yield* markConsumed(record.id);
            return true;
          }),
        );
        if (!claimedLocally) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        yield* repository
          .completeDelivery(record.id, decision)
          .pipe(
            Effect.mapError((cause) => new ApprovalHistoryPendingError(id, true, String(cause))),
          );
        yield* clearConsumed(record.id);
      }),
    );

  const approve: ApprovalServiceShape["approve"] = (requestId, submission) =>
    decide(requestId, "approved", submission);

  const reject: ApprovalServiceShape["reject"] = (requestId, submission) =>
    decide(requestId, "rejected", submission);

  const respondToUserInput: ApprovalServiceShape["respondToUserInput"] = (id, submission) =>
    withResolution(
      Effect.gen(function* () {
        const record = yield* repository.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
        if (record === null) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        if (
          submission.runAttemptId !== undefined &&
          record.runAttemptId !== submission.runAttemptId
        ) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        const prepared = yield* prepareAnswer(record, submission);
        if (record.state === "delivering") {
          // A secret answer cannot be compared from its redacted history.
          // With a local receipt the delivery is known locally but history
          // cannot safely be finalised by retry; without one it is stale.
          if (hasRedactedAnswer(record.answer)) {
            if (yield* wasConsumed(record.id)) {
              return yield* Effect.fail(
                new ApprovalHistoryPendingError(
                  id,
                  true,
                  "the secret answer cannot be compared for a retry",
                  false,
                ),
              );
            }
            return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
          }
          if (!sameAnswers(record.answer, prepared.record) || !(yield* wasConsumed(record.id))) {
            return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
          }
          yield* repository
            .completeDelivery(record.id, "answered")
            .pipe(
              Effect.mapError((cause) => new ApprovalHistoryPendingError(id, true, String(cause))),
            );
          yield* clearConsumed(record.id);
          return;
        }
        if (record.state !== "pending") {
          if (
            record.state === "answered" &&
            !hasRedactedAnswer(record.answer) &&
            sameAnswers(record.answer, prepared.record)
          ) {
            return;
          }
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        if (record.runAttemptId === undefined) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        const claimedLocally = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* repository
              .stageDelivery(record.id, "answered", { answer: prepared.record })
              .pipe(
                Effect.mapError(
                  (cause) => new ApprovalHistoryPendingError(id, false, String(cause)),
                ),
              );
            const result = yield* Effect.result(
              liveRequests.respondToUserInput(
                record.runAttemptId!,
                record.requestId,
                prepared.answerMap,
              ),
            );
            if (result._tag === "Failure") {
              yield* repository
                .abortDelivery(record.id, "interrupted")
                .pipe(Effect.catch(() => logHistoryFailure("aborted answer", id)));
              return false;
            }
            yield* markConsumed(record.id);
            return true;
          }),
        );
        if (!claimedLocally) {
          return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
        }
        yield* repository
          .completeDelivery(record.id, "answered")
          .pipe(
            Effect.mapError(
              (cause) =>
                new ApprovalHistoryPendingError(
                  id,
                  true,
                  String(cause),
                  !hasRedactedAnswer(prepared.record),
                ),
            ),
          );
        yield* clearConsumed(record.id);
      }),
    );

  const listPending: ApprovalServiceShape["listPending"] = (options) =>
    repository.listPending(options).pipe(Effect.catch(() => Effect.succeed([])));

  const listForRun: ApprovalServiceShape["listForRun"] = (runAttemptId) =>
    repository.listForRun(runAttemptId).pipe(Effect.catch(() => Effect.succeed([])));

  const expire: ApprovalServiceShape["expire"] = (id) =>
    withResolution(
      Effect.gen(function* () {
        const record = yield* repository.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
        if (record === null) {
          return;
        }
        // Claim the live entry when the agent is still waiting. A lost claim
        // means an answer already resolved the request; leave its row alone.
        const claimed =
          record.runAttemptId === undefined
            ? false
            : yield* liveRequests.settleRequest(
                record.runAttemptId,
                record.requestId,
                "approval wait timed out",
              );
        if (record.state === "delivering") {
          // Only a positively won live claim proves the staged content was not
          // delivered. A restarted/uncertain row keeps its content and staged
          // decision for reconciliation.
          if (claimed && !(yield* wasConsumed(record.id))) {
            yield* repository
              .abortDelivery(record.id, "expired")
              .pipe(Effect.catch(() => logHistoryFailure("expired staged delivery", id)));
          }
          return;
        }
        if (!claimed && record.state !== "pending") {
          return;
        }
        yield* repository.decide(id, "expired").pipe(Effect.catch(() => Effect.void));
      }),
    );

  const interrupt: ApprovalServiceShape["interrupt"] = (id) =>
    withResolution(
      Effect.gen(function* () {
        const record = yield* repository.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
        if (record === null) {
          return;
        }
        const claimed =
          record.runAttemptId === undefined
            ? false
            : yield* liveRequests.settleRequest(
                record.runAttemptId,
                record.requestId,
                "run interrupted; approval unanswered",
              );
        if (record.state === "delivering") {
          if (claimed && !(yield* wasConsumed(record.id))) {
            yield* repository
              .abortDelivery(record.id, "interrupted")
              .pipe(Effect.catch(() => logHistoryFailure("interrupted staged delivery", id)));
          }
          return;
        }
        if (!claimed && record.state !== "pending") {
          return;
        }
        yield* repository.decide(id, "interrupted").pipe(Effect.catch(() => Effect.void));
      }),
    );

  const expireRequest: ApprovalServiceShape["expireRequest"] = (runAttemptId, requestId) =>
    withResolution(
      Effect.gen(function* () {
        // The runtime's own wait elapsed. Winning the claim is what authorises
        // persisting `expired`; losing it means an answer (or another settle)
        // already owns this request, so nothing is written.
        const claimed = yield* liveRequests.settleRequest(
          runAttemptId,
          requestId,
          "request wait timed out",
        );
        if (!claimed) {
          return false;
        }
        const records = yield* repository
          .listForRun(runAttemptId)
          .pipe(Effect.catch(() => Effect.succeed([] as ApprovalRequest[])));
        const record = records.find(
          (candidate) =>
            candidate.requestId === requestId &&
            (candidate.state === "pending" || candidate.state === "delivering"),
        );
        if (record !== undefined) {
          if (record.state === "delivering") {
            if (!(yield* wasConsumed(record.id))) {
              yield* repository
                .abortDelivery(record.id, "expired")
                .pipe(Effect.catch(() => logHistoryFailure("expired staged delivery", record.id)));
            }
          } else {
            yield* repository.decide(record.id, "expired").pipe(Effect.catch(() => Effect.void));
          }
        }
        return true;
      }),
    );

  const reconcileUncertainDeliveries: ApprovalServiceShape["reconcileUncertainDeliveries"] = () =>
    withResolution(
      Effect.gen(function* () {
        const listed = yield* Effect.result(repository.listDelivering());
        if (listed._tag === "Failure") {
          return {
            reconciled: 0,
            failedIds: [],
            unavailable: String(listed.failure),
          } satisfies ApprovalReconciliationResult;
        }
        let reconciled = 0;
        const failedIds: string[] = [];
        for (const row of listed.success) {
          // A positive receipt in this process means the live Deferred was
          // consumed here; leave it for an operator retry to finalise history.
          if (yield* wasConsumed(row.id)) continue;
          const result = yield* Effect.result(repository.reconcileDelivery(row.id, "interrupted"));
          if (result._tag === "Success") {
            reconciled += 1;
          } else {
            failedIds.push(String(row.id));
            yield* logHistoryFailure("reconciled delivery", row.id);
          }
        }
        return { reconciled, failedIds } satisfies ApprovalReconciliationResult;
      }),
    );

  return {
    recordPending,
    approve,
    reject,
    respondToUserInput,
    listPending,
    listForRun,
    expire,
    interrupt,
    expireRequest,
    reconcileUncertainDeliveries,
  };
});

export const ApprovalServiceLive: Layer.Layer<
  ApprovalService,
  never,
  LiveRequests | ApprovalRepository | Crypto.Crypto
> = Layer.effect(ApprovalService, makeApprovalService);
