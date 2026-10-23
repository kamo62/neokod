import type { EffectiveWorkflowConfig, WorkItem, WorkflowRecord } from "@neokod/contracts";
import {
  confirmOwnedProcessClosure,
  type ProcessClosureDeps,
  type ProcessClosureResult,
} from "@neokod/shared/processGroup";
import * as Effect from "effect/Effect";

import { nowIso } from "../Domain/Time.ts";
import {
  WorkItemRepository,
  type ClaimFence,
  type ClaimOwnership,
} from "../Persistence/Services/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import {
  RunDispatcher,
  claimBindingMatches,
  readAttemptClaimBinding,
} from "../Runner/Dispatcher.ts";
import { WORKFLOW_DEFAULTS } from "../Workflow/Config.ts";
import { hasPendingStopIntent, settleConfirmedStopIntent } from "./Recovery.ts";

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
 * by the next poll. A claim newer than the inspected attempt is a preparation
 * window and is preserved. A durable pending Stop always settles through the
 * fenced confirmed-stop path once closure is known; it is never queued or
 * retried.
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

const ownershipFence = (ownership: ClaimOwnership): ClaimFence | null =>
  ownership.ownerToken === null
    ? null
    : {
        ownerToken: ownership.ownerToken,
        generation: ownership.generation,
        ownerPid: ownership.ownerPid,
        ownerPgid: ownership.ownerPgid,
        ownerBirthToken: ownership.ownerBirthToken,
      };

/**
 * Resolve the recorded owner's closure from one atomic ownership row. The
 * fence and identity therefore always describe the same claim.
 */
const resolveOwnerClosure = (
  deps: ReconcilerDeps,
  ownership: ClaimOwnership,
): Effect.Effect<
  | ProcessClosureResult
  | { readonly status: "held"; readonly reason: "claim_unreadable"; readonly detail?: string }
> =>
  ownership.ownerPid === null
    ? Effect.succeed({ status: "closed", evidence: "no_owner_recorded" } as const)
    : confirmOwnedProcessClosure(
        {
          ownerPid: ownership.ownerPid,
          ...(ownership.ownerPgid === null ? {} : { ownerPgid: ownership.ownerPgid }),
          ...(ownership.ownerBirthToken === null
            ? {}
            : { ownerBirthToken: ownership.ownerBirthToken }),
          ...(deps.ownPid === undefined ? {} : { ownPid: deps.ownPid }),
        },
        deps.processClosure ?? {},
      );

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
    const ownership = yield* deps.workItems
      .getClaimOwnership(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));
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

    if (ownership === null || ownership.ownerToken === null) {
      return;
    }
    const releaseFence = ownershipFence(ownership);
    if (releaseFence === null) {
      return;
    }

    const recordHold = (reason: string, detail?: string) =>
      deps.runEvents
        .appendOnce(attempt.id, "reconciliation_hold", {
          workItemId: String(item.id),
          reason,
          ...(detail === undefined ? {} : { detail }),
          ownerPid: ownership.ownerPid,
          generation: ownership.generation,
          terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));

    // Positive association is the exact durable attempt/claim binding, not
    // timestamp order. Missing legacy bindings stay held and unverifiable.
    const binding = yield* readAttemptClaimBinding(deps.runEvents, attempt.id);
    if (!claimBindingMatches(binding, ownership, item.id)) {
      yield* recordHold("claim_binding_unverified");
      return;
    }

    // Closure is required before ANY release or requeue, including a terminal
    // attempt. A startup recovery hold or an unconfirmed Stop stays held here.
    const closure = yield* resolveOwnerClosure(deps, ownership);
    if (closure.status === "held") {
      yield* recordHold(closure.reason, closure.detail);
      return;
    }

    // A durable Stop settles once closure is confirmed; it never becomes a
    // queue or retry, even after a restart or late descendant exit.
    const stopPending = yield* hasPendingStopIntent(deps.runEvents, attempt.id);
    if (stopPending) {
      const settled = yield* settleConfirmedStopIntent({
        workItems: deps.workItems,
        runAttempts: deps.runAttempts,
        runEvents: deps.runEvents,
        runAttemptId: attempt.id,
        workItemId: item.id,
        ownership,
        now,
      });
      if (!settled) {
        yield* recordHold("claim_changed");
      }
      return;
    }

    if (TERMINAL_STATUSES.has(attempt.status)) {
      if (attempt.status === "succeeded") {
        // Preserve REVIEW P1 #11: a completed agent must land in review, not be
        // re-dispatched. This is only reached once closure is confirmed.
        yield* deps.workItems
          .transition(item.id, "ready_for_review", {
            from: ["preparing", "running", "testing"],
            ownerToken: releaseFence.ownerToken,
            generation: releaseFence.generation,
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
