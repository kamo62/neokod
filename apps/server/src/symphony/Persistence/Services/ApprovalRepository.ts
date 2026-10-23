import type {
  ApprovalAnswerRecord,
  ApprovalDecisionNote,
  ApprovalQuestionPayload,
  ApprovalRequest,
  RunAttemptId,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * ApprovalRepository - durable approval request records (plan 8.3.1, PRD 14.9).
 *
 * Durable rows exist for history, audit, and UI; they never resolve the live
 * Deferred. Settlement and answering happen through the LiveRequests registry.
 */
export interface ApprovalRepositoryShape {
  /** Persist a new pending approval or user-input request. Idempotent per id. */
  readonly create: (input: {
    readonly id: string;
    readonly requestId: string;
    readonly workItemId: string;
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
   * Record a decision. `answered` is used for a user-input answer, so an
   * answered question is never labelled as a permission approval.
   */
  readonly decide: (
    id: string,
    decision: "answered" | "approved" | "rejected" | "expired" | "interrupted",
    details?: {
      readonly answer?: ApprovalAnswerRecord;
      readonly decisionNote?: ApprovalDecisionNote;
    },
  ) => Effect.Effect<void, SymphonyPersistenceError>;

  /**
   * Persist accepted content before the live Deferred is consumed. The row
   * moves to `delivering` so a retry can finish history without resolving the
   * provider a second time.
   */
  readonly stageDelivery: (
    id: string,
    decision: "answered" | "approved" | "rejected",
    details?: {
      readonly answer?: ApprovalAnswerRecord;
      readonly decisionNote?: ApprovalDecisionNote;
    },
  ) => Effect.Effect<void, SymphonyPersistenceError>;

  /** Finalise a staged delivery after the live request was consumed. */
  readonly completeDelivery: (
    id: string,
    decision: "answered" | "approved" | "rejected",
  ) => Effect.Effect<void, SymphonyPersistenceError>;

  /** Close a staged delivery whose live claim lost; its content was not sent. */
  readonly abortDelivery: (
    id: string,
    decision: "expired" | "interrupted",
  ) => Effect.Effect<void, SymphonyPersistenceError>;

  /** List pending (undecided) requests, newest first. */
  readonly listPending: (options?: {
    readonly limit?: number;
  }) => Effect.Effect<ApprovalRequest[], SymphonyPersistenceError>;

  /** List all requests for a run, newest first. */
  readonly listForRun: (
    runAttemptId: RunAttemptId,
  ) => Effect.Effect<ApprovalRequest[], SymphonyPersistenceError>;

  readonly getById: (id: string) => Effect.Effect<ApprovalRequest | null, SymphonyPersistenceError>;

  /** The durable row for a provider request within one run/attempt, newest first. */
  readonly findByRequest: (
    runAttemptId: RunAttemptId,
    requestId: string,
  ) => Effect.Effect<ApprovalRequest | null, SymphonyPersistenceError>;
}

export class ApprovalRepository extends Context.Service<
  ApprovalRepository,
  ApprovalRepositoryShape
>()("neokod/symphony/Persistence/Services/ApprovalRepository") {}
