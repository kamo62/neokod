import type { RunAttempt, RunAttemptId, RunAttemptStatus, WorkItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * RunAttemptRepository - persistence for symphony run attempts.
 *
 * One row per (work item, attempt number). Timestamps are ISO-8601 strings.
 * `error`, `tokenUsage` and `sessionId`/`threadId` are nullable JSON columns.
 */
export interface RunAttemptRepositoryShape {
  readonly create: (attempt: RunAttempt) => Effect.Effect<RunAttempt, SymphonyPersistenceError>;
  readonly update: (attempt: RunAttempt) => Effect.Effect<RunAttempt, SymphonyPersistenceError>;
  readonly getById: (
    id: RunAttemptId,
  ) => Effect.Effect<RunAttempt | null, SymphonyPersistenceError>;
  readonly listByWorkItem: (
    workItemId: WorkItemId,
  ) => Effect.Effect<RunAttempt[], SymphonyPersistenceError>;
  /** Latest attempt for a work item, if any. */
  readonly latestForWorkItem: (
    workItemId: WorkItemId,
  ) => Effect.Effect<RunAttempt | null, SymphonyPersistenceError>;
  readonly updateStatus: (
    id: RunAttemptId,
    status: RunAttemptStatus,
    options?: {
      readonly currentStage?: string;
      readonly finishedAt?: string;
      readonly error?: RunAttempt["error"];
      readonly tokenUsage?: RunAttempt["tokenUsage"];
    },
  ) => Effect.Effect<void, SymphonyPersistenceError>;
}

export class RunAttemptRepository extends Context.Service<
  RunAttemptRepository,
  RunAttemptRepositoryShape
>()("neokod/symphony/Persistence/Services/RunAttemptRepository") {}
