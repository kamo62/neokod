import type { EffectiveWorkflowConfig, WorkItem, WorkflowRecord } from "@neokod/contracts";
import {
  confirmOwnedProcessClosure,
  type ProcessClosureDeps,
  type ProcessClosureResult,
} from "@neokod/shared/processGroup";
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
 *
 * Terminal status and the stall clock are NOT process closure. Before any
 * release (and before requeueing a succeeded-but-untransited run) the recorded
 * owner must resolve closed through the same shared identity policy startup
 * recovery and Stop use. An unverifiable owner keeps its claim and records a
 * durable `reconciliation_hold` instead, so a startup/Stop hold is never undone
 * by the next poll.
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

export const nowMs = (iso: string): number => Date.parse(iso);

export interface ReconcilerDeps {
  readonly workItems: WorkItemRepository["Service"];
  readonly runAttempts: RunAttemptRepository["Service"];
  readonly runEvents: RunEventRepository["Service"];
  readonly workflows: WorkflowRepository["Service"];
  readonly dispatcher: RunDispatcher["Service"];
  /** Process-identity readers/signallers; tests inject fakes. */
  readonly processClosure?: ProcessClosureDeps;
  /** The calling server's own pid; never target it. */
  readonly ownPid?: number;
}

type ReconcilerHoldReason =
  | Extract<ProcessClosureResult, { readonly status: "held" }>["reason"]
  | "claim_changed"
  | "claim_unreadable";

/**
 * Resolve the recorded owner's closure with the same policy as recovery and
 * Stop. The claim is re-read first so a replacement owner is never signalled.
 */
const resolveOwnerClosure = (
  deps: ReconcilerDeps,
  item: WorkItem,
  fence: { readonly ownerToken: string | null; readonly generation: number },
): Effect.Effect<
  | ProcessClosureResult
  | {
      readonly status: "held";
      readonly reason: ReconcilerHoldReason;
      readonly detail?: string;
    }
> =>
  Effect.gen(function* () {
    const currentFence = yield* deps.workItems
      .getClaimFence(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (
      currentFence === null ||
      currentFence.ownerToken !== fence.ownerToken ||
      currentFence.generation !== fence.generation
    ) {
      return { status: "held", reason: "claim_changed" } as const;
    }
    if (item.ownerPid === null || item.ownerPid === undefined) {
      return { status: "closed", evidence: "no_owner_recorded" } as const;
    }
    const current = yield* deps.workItems
      .getById(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (current === null) {
      return { status: "held", reason: "claim_unreadable" } as const;
    }
    const unchanged =
      current.lifecycle === item.lifecycle &&
      (current.claimedAt ?? null) === (item.claimedAt ?? null) &&
      (current.ownerPid ?? null) === (item.ownerPid ?? null) &&
      (current.ownerPgid ?? null) === (item.ownerPgid ?? null) &&
      (current.ownerBirthToken ?? null) === (item.ownerBirthToken ?? null);
    if (!unchanged) {
      return { status: "held", reason: "claim_changed" } as const;
    }
    return yield* confirmOwnedProcessClosure(
      {
        ...(item.ownerPid === undefined ? {} : { ownerPid: item.ownerPid }),
        ...(item.ownerPgid === undefined ? {} : { ownerPgid: item.ownerPgid }),
        ...(item.ownerBirthToken === undefined ? {} : { ownerBirthToken: item.ownerBirthToken }),
        ...(deps.ownPid === undefined ? {} : { ownPid: deps.ownPid }),
      },
      deps.processClosure ?? {},
    );
  });

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
  Effect.gen(function* () {
    const held = yield* deps.workItems
      .listByLifecycle(["preparing", "running", "testing"])
      .pipe(Effect.catch(() => Effect.succeed([] as WorkItem[])));
    if (held.length === 0) {
      return;
    }
    const now = yield* nowIso;
    const workflows = yield* deps.workflows
      .list()
      .pipe(Effect.catch(() => Effect.succeed([] as WorkflowRecord[])));

    for (const item of held) {
      yield* reconcileItem(deps, item, workflows, now).pipe(Effect.catch(() => Effect.void));
    }
  }).pipe(Effect.withSpan("symphonyReconciler.reconcileStaleClaims"));

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

    const fence = yield* deps.workItems
      .getClaimFence(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (fence === null) {
      return;
    }
    const releaseFence =
      fence.ownerToken === null
        ? undefined
        : { ownerToken: fence.ownerToken, generation: fence.generation };
    const recordHold = (reason: string, detail?: string) =>
      deps.runEvents
        .appendOnce(attempt.id, "reconciliation_hold", {
          workItemId: String(item.id),
          reason,
          ...(detail === undefined ? {} : { detail }),
          ownerPid: item.ownerPid ?? null,
          terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));

    // Closure is required before ANY release or requeue, including a terminal
    // attempt. A startup recovery hold or an unconfirmed Stop stays held here.
    const closure = yield* resolveOwnerClosure(deps, item, fence);
    if (closure.status === "held") {
      yield* recordHold(closure.reason, closure.detail);
      return;
    }

    if (TERMINAL_STATUSES.has(attempt.status)) {
      if (attempt.status === "succeeded") {
        // Preserve REVIEW P1 #11: a completed agent must land in review, not be
        // re-dispatched. This is only reached once closure is confirmed.
        yield* deps.workItems
          .transition(item.id, "ready_for_review", {
            from: ["preparing", "running", "testing"],
            ...(releaseFence === undefined
              ? {}
              : { ownerToken: releaseFence.ownerToken, generation: releaseFence.generation }),
          })
          .pipe(Effect.catch(() => Effect.void));
        return;
      }
      // The run is over and closure is confirmed: the exact claim can be
      // released.
      yield* deps.workItems
        .releaseClaim(item.id, "queued", releaseFence)
        .pipe(Effect.catch(() => Effect.void));
      return;
    }

    const stallTimeoutMs = stallTimeoutFor(workflowById(workflows, item.workflowId));
    if (stallTimeoutMs === null) {
      return;
    }
    const startedAt = Date.parse(attempt.startedAt);
    const observedAt = Date.parse(now);
    if (
      Number.isNaN(startedAt) ||
      Number.isNaN(observedAt) ||
      observedAt - startedAt < stallTimeoutMs
    ) {
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
    yield* deps.workItems
      .releaseClaim(item.id, "queued", releaseFence)
      .pipe(Effect.catch(() => Effect.void));
  });
