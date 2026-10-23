import type {
  AcceptedGuidanceSnapshot,
  RunAttempt,
  RunAttemptId,
  RunAttemptStatus,
  SymphonyProjectId,
  WorkItemId,
} from "@neokod/contracts";
import { AcceptedGuidanceSnapshotSchema } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Schema } from "effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * RunAttemptRepository - persistence for symphony run attempts.
 *
 * One row per (work item, attempt number). Timestamps are ISO-8601 strings.
 * `error`, `tokenUsage` and `sessionId`/`threadId` are nullable JSON columns.
 * `acceptedGuidance` may be written by `create` only. It is immutable after
 * that write; `update` preserves the stored value, including legacy absence.
 */
export interface RunAttemptRepositoryShape {
  /** Persist a new attempt, including its accepted guidance snapshot when present. */
  readonly create: (attempt: RunAttempt) => Effect.Effect<RunAttempt, SymphonyPersistenceError>;
  /**
   * Replace mutable attempt fields. The accepted guidance column is never
   * written here, so an existing snapshot, or legacy absence, is preserved.
   */
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
  /** Latest attempt id for every work item in a project, in one read. */
  readonly latestIdsForProject: (
    projectId: SymphonyProjectId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly workItemId: WorkItemId; readonly runAttemptId: RunAttemptId }>,
    SymphonyPersistenceError
  >;
  /** Most recent attempts across all work items, newest first. */
  readonly listRecent: (options?: {
    readonly limit?: number;
    readonly status?: RunAttemptStatus;
  }) => Effect.Effect<RunAttempt[], SymphonyPersistenceError>;
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

export type AcceptedGuidanceValidation =
  | { readonly _tag: "valid"; readonly snapshot: AcceptedGuidanceSnapshot }
  | { readonly _tag: "invalid"; readonly issue: string };

const isValidIsoDateTime = (value: string): boolean => Option.isSome(DateTime.make(value));

/**
 * Trust-boundary validation for a stored or supplied snapshot. The canonical
 * schema checks the shape. Timestamps use the existing Date/Time authority so
 * an unparseable tracker or workflow revision fails explicitly instead of
 * being guessed or silently replaced.
 */
export const validateAcceptedGuidanceSnapshot = (value: unknown): AcceptedGuidanceValidation => {
  const decoded = Schema.decodeUnknownOption(AcceptedGuidanceSnapshotSchema)(value);
  if (Option.isNone(decoded)) {
    return {
      _tag: "invalid",
      issue: "accepted guidance does not match the canonical snapshot schema",
    };
  }
  const snapshot = decoded.value;
  const timestamps: ReadonlyArray<readonly [string, string | null]> = [
    ["acceptedAt", snapshot.acceptedAt],
    ["workflow.revision", snapshot.workflow.revision],
    ["source.revision", snapshot.source.revision],
  ];
  for (const [field, timestamp] of timestamps) {
    if (timestamp !== null && !isValidIsoDateTime(timestamp)) {
      return { _tag: "invalid", issue: `${field} is not a valid ISO timestamp` };
    }
  }
  const approvalsConsistent =
    snapshot.permission.approvalPolicy === "never"
      ? !snapshot.permission.approvalsEnabled
      : snapshot.permission.approvalsEnabled;
  if (!approvalsConsistent) {
    return {
      _tag: "invalid",
      issue: "accepted permission approval policy and approvalsEnabled disagree",
    };
  }
  return { _tag: "valid", snapshot };
};

export class RunAttemptRepository extends Context.Service<
  RunAttemptRepository,
  RunAttemptRepositoryShape
>()("neokod/symphony/Persistence/Services/RunAttemptRepository") {}
