import type {
  EffectiveWorkflowConfig,
  RunAttempt,
  WorkItem,
  WorkflowRecord,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";

import { nowIso } from "../Domain/Time.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import { RunDispatcher } from "../Runner/Dispatcher.ts";
import type { WorkspaceOwnershipRepositoryShape } from "../Persistence/Services/WorkspaceOwnershipRepository.ts";
import { isRetryableCategory } from "./Retry.ts";

/**
 * Restart recovery (plan 9.7, SPEC 8.6, PRD 18.1/18.2/18.4).
 *
 * Runs once on orchestrator startup, before the poll loop. Everything is
 * best-effort and idempotent (PRD 18.4); repeated runs are safe.
 *
 * For each work item still held in `preparing`/`running`:
 * - The run attempt is terminal (the worker died between the run and the
 *   transition): release the claim to `queued` immediately.
 * - The run attempt is non-terminal with no live agent (the agent process
 *   died or the server restarted): mark the attempt `interrupted`, append an
 *   event, and release the claim. If the error category is retryable, release
 *   to `retry_scheduled` so the retry sweep re-dispatches it (plan 9.5);
 *   otherwise release to `queued`.
 *
 * Orphan-process termination and workspace inspection (PRD 18.2) are not part
 * of this slice: the workspace is preserved (PRD 18.1) and reused on retry by
 * the workspace manager.
 */

export interface RecoveryDeps {
  readonly workItems: WorkItemRepository["Service"];
  readonly runAttempts: RunAttemptRepository["Service"];
  readonly runEvents: RunEventRepository["Service"];
  readonly workflows: WorkflowRepository["Service"];
  readonly dispatcher: RunDispatcher["Service"];
  readonly ownership?: WorkspaceOwnershipRepositoryShape;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
  "user_cancelled",
  "tracker_cancelled",
  "process_failed",
  "validation_failed",
  "workflow_error",
  "provider_error",
  "interrupted",
  "retries_exhausted",
]);

export const runStartupRecovery = (deps: RecoveryDeps) =>
  Effect.fn("symphonyRecovery.runStartupRecovery")(function* (input: RecoveryDeps) {
    const held = yield* input.workItems
      .listByLifecycle(["preparing", "running"])
      .pipe(Effect.catch(() => Effect.succeed([] as WorkItem[])));
    if (held.length === 0) {
      return;
    }
    const now = yield* nowIso;
    const workflows = yield* input.workflows
      .list()
      .pipe(Effect.catch(() => Effect.succeed([] as WorkflowRecord[])));

    for (const item of held) {
      yield* recoverItem(input, item, workflows, now).pipe(Effect.catch(() => Effect.void));
    }
  })(deps);

const maxAttemptsFor = (workflows: ReadonlyArray<WorkflowRecord>, item: WorkItem): number => {
  const workflow =
    item.workflowId === undefined ? undefined : workflows.find((w) => w.id === item.workflowId);
  const config = workflow?.effectiveConfig as EffectiveWorkflowConfig | null | undefined;
  return config?.maxAttempts ?? 5;
};

const recoverItem = (
  deps: RecoveryDeps,
  item: WorkItem,
  workflows: ReadonlyArray<WorkflowRecord>,
  now: string,
) =>
  Effect.gen(function* () {
    const attempt = yield* deps.runAttempts
      .latestForWorkItem(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (attempt === null) {
      // Claim without an attempt is an in-flight dispatch window; leave it.
      return;
    }

    const active = yield* deps.dispatcher.isAgentActive(attempt.id);
    if (active) {
      return;
    }

    if (TERMINAL_STATUSES.has(attempt.status)) {
      yield* deps.workItems.releaseClaim(item.id, "queued").pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Non-terminal attempt with no live agent: the worker is gone (restart or
    // crash). Mark interrupted and release per the retry policy.
    yield* deps.runAttempts
      .updateStatus(attempt.id, "interrupted", {
        finishedAt: now,
        error: {
          category: "interrupted",
          message: "run interrupted by server restart; agent no longer live",
        },
      })
      .pipe(Effect.catch(() => Effect.void));
    yield* deps.runEvents
      .append(attempt.id, "interrupted", { workItemId: String(item.id) })
      .pipe(Effect.catch(() => Effect.void));

    // Release any Symphony lease on the workspace so a crash during
    // takeOver cannot leave the workspace permanently blocked
    // (plan 9.7: "workspace leases whose owner is gone are released").
    if (deps.ownership !== undefined) {
      const held = yield* deps.ownership
        .getByWorkspacePath(attempt.workspacePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (held !== null && held.owner === "symphony") {
        yield* deps.ownership
          .release({
            workspacePath: attempt.workspacePath,
            owner: "symphony",
            generation: held.generation,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
    }

    const retryable =
      isRetryableCategory("interrupted") && attempt.attemptNumber < maxAttemptsFor(workflows, item);
    yield* deps.workItems
      .releaseClaim(item.id, retryable ? "retry_scheduled" : "queued")
      .pipe(Effect.catch(() => Effect.void));
    if (retryable) {
      yield* deps.runEvents
        .append(attempt.id, "retry_scheduled", {
          workItemId: String(item.id),
          attemptNumber: attempt.attemptNumber,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
  });

export type RecoveryRunAttempt = RunAttempt;
