import type { EffectiveWorkflowConfig, WorkItem, WorkflowRecord } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import { nowIso } from "../Domain/Time.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import { RunDispatcher } from "../Runner/Dispatcher.ts";
import { WORKFLOW_DEFAULTS } from "../Workflow/Config.ts";

/**
 * Claim reconciliation (plan 9.4, 9.7.3 to 9.7.5).
 *
 * Every orchestrator tick scans work items still held in `preparing` or
 * `running` and releases claims whose owner is gone:
 *
 * - Run already terminal (`user_cancelled`, `succeeded` but the item was
 *   never transitioned, `stalled`, ...): the worker is gone, so release the
 *   claim back to `queued` immediately.
 * - Run non-terminal but no live agent is registered for it (the agent
 *   process died, or the server restarted) and the attempt has exceeded the
 *   workflow's stall threshold: mark the attempt `stalled`, append a run
 *   event, and release the claim.
 *
 * A live agent (registered in the dispatcher's `activeAgents`) is never
 * touched, and `releaseClaim` is lifecycle-guarded so a finished item can
 * never be downgraded. Everything here is best-effort and idempotent.
 */

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

export interface ReconcilerDeps {
  readonly workItems: WorkItemRepository["Service"];
  readonly runAttempts: RunAttemptRepository["Service"];
  readonly runEvents: RunEventRepository["Service"];
  readonly workflows: WorkflowRepository["Service"];
  readonly dispatcher: RunDispatcher["Service"];
}

/** Stall threshold for an attempt, or null when stall detection is disabled. */
const stallTimeoutFor = (workflow: WorkflowRecord | undefined): number | null => {
  const config = workflow?.effectiveConfig as EffectiveWorkflowConfig | null | undefined;
  const timeoutMs = config?.codexStallTimeoutMs ?? WORKFLOW_DEFAULTS.codexStallTimeoutMs;
  return timeoutMs <= 0 ? null : timeoutMs;
};

const workflowById = (
  workflows: ReadonlyArray<WorkflowRecord>,
  id: WorkItem["workflowId"],
): WorkflowRecord | undefined =>
  id === undefined ? undefined : workflows.find((workflow) => workflow.id === id);

export const reconcileStaleClaims = (deps: ReconcilerDeps) =>
  Effect.fn("symphonyReconciler.reconcileStaleClaims")(function* (input: ReconcilerDeps) {
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
      yield* reconcileItem(input, item, workflows, now).pipe(Effect.catch(() => Effect.void));
    }
  })(deps);

const reconcileItem = (
  deps: ReconcilerDeps,
  item: WorkItem,
  workflows: ReadonlyArray<WorkflowRecord>,
  now: string,
) =>
  Effect.gen(function* () {
    const attempt = yield* deps.runAttempts
      .latestForWorkItem(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));

    // Claim without an attempt is an in-flight dispatch window; leave it alone
    // rather than racing the dispatcher.
    if (attempt === null) {
      return;
    }

    const active = yield* deps.dispatcher.isAgentActive(attempt.id);
    if (active) {
      return;
    }

    if (TERMINAL_STATUSES.has(attempt.status)) {
      // The run is over but the claim was never released (e.g. the dispatch
      // process died between the run and the transition, or a cancel raced a
      // process kill). Release it; a re-dispatch is safe because the attempt
      // is terminal.
      yield* deps.workItems.releaseClaim(item.id, "queued").pipe(Effect.catch(() => Effect.void));
      return;
    }

    const stallTimeoutMs = stallTimeoutFor(workflowById(workflows, item.workflowId));
    if (stallTimeoutMs === null) {
      return;
    }
    const startedAt = Date.parse(attempt.startedAt);
    if (Number.isNaN(startedAt) || nowMs(now) - startedAt < stallTimeoutMs) {
      return;
    }
    yield* deps.runAttempts
      .updateStatus(attempt.id, "stalled", {
        finishedAt: now,
        error: { category: "stalled", message: "no agent progress past the stall timeout" },
      })
      .pipe(Effect.catch(() => Effect.void));
    yield* deps.runEvents
      .append(attempt.id, "stalled", { workItemId: String(item.id) })
      .pipe(Effect.catch(() => Effect.void));
    yield* deps.workItems.releaseClaim(item.id, "queued").pipe(Effect.catch(() => Effect.void));
  });

export const nowMs = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Date.now() : parsed;
};
