import type {
  EffectiveWorkflowConfig,
  RunAttempt,
  WorkItem,
  WorkflowRecord,
} from "@neokod/contracts";
import {
  confirmOwnedProcessClosure,
  type ProcessClosureDeps,
  type ProcessClosureResult,
} from "@neokod/shared/processGroup";
import * as Clock from "effect/Clock";
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
  hasOwnershipFailureEvent,
  readAttemptClaimBinding,
} from "../Runner/Dispatcher.ts";
import type { WorkspaceOwnershipRepositoryShape } from "../Persistence/Services/WorkspaceOwnershipRepository.ts";
import { isRetryableCategory } from "./Retry.ts";

/**
 * Restart recovery (plan 9.7, SPEC 8.6, PRD 18.1/18.2/18.4).
 *
 * Runs once on orchestrator startup, before the poll loop. Everything is
 * best-effort and idempotent (PRD 18.4); repeated runs are safe.
 *
 * For each work item still held in `preparing`/`running`/`testing`:
 * - First resolve closure of any recorded owner process through the shared
 *   {@link confirmOwnedProcessClosure} policy. The persisted pid must still
 *   lead the recorded group and match its birth token before any signal, and
 *   the claim must be unchanged since the snapshot.
 * - Closure confirmed (or no owner process was ever recorded) and the run
 *   attempt terminal: release the claim to `queued` (or land a succeeded run
 *   in `ready_for_review`).
 * - Closure confirmed and the attempt non-terminal: mark the attempt
 *   `interrupted`, append an event, and release the claim. If the error
 *   category is retryable, release to `retry_scheduled` so the retry sweep
 *   re-dispatches it (plan 9.5); otherwise release to `queued`.
 * - Closure held (bare legacy pid, recycled pid, missing/unreadable birth
 *   token, unsupported platform, surviving descendants, failed termination,
 *   or a claim that changed mid-check): do not signal, do not settle the
 *   attempt or its approvals, and retain the claim, lease and lifecycle. A
 *   durable `recovery_hold` run event records the reason for reconciliation.
 *   This is the only honest outcome when identity or closure cannot be proven.
 *
 * Workspace inspection (PRD 18.2) is not part of this slice: the workspace is
 * preserved (PRD 18.1) and reused on retry by the workspace manager.
 */

export interface RecoveryDeps {
  readonly workItems: WorkItemRepository["Service"];
  readonly runAttempts: RunAttemptRepository["Service"];
  readonly runEvents: RunEventRepository["Service"];
  readonly workflows: WorkflowRepository["Service"];
  readonly dispatcher: RunDispatcher["Service"];
  readonly ownership?: WorkspaceOwnershipRepositoryShape;
  /** Called after marking a run interrupted: settle that run's pending
   * approval/input requests (plan 8.3.1; audit item 3). */
  readonly interruptRunApprovals?: (input: {
    readonly workItemId: WorkItem["id"];
    readonly runAttemptId: string;
  }) => Effect.Effect<void>;
  /**
   * Process-identity readers/signallers for the shared closure policy. The
   * default reads the live POSIX process table and signals a validated group;
   * tests must inject fake readers/signallers and never signal real processes.
   */
  readonly processClosure?: ProcessClosureDeps;
  /** The calling server's own pid; a recovered row must never target it. */
  readonly ownPid?: number;
}

/** A claim with no attempt row older than this is a crash orphan, not an
 * in-flight dispatch (REVIEW P1 #10). */
const STALL_WINDOW_MS = 5 * 60_000;

/** A hold reason owned by recovery itself (the rest come from the shared policy). */
type RecoveryHoldReason =
  | Extract<ProcessClosureResult, { readonly status: "held" }>["reason"]
  | "claim_changed"
  | "claim_unreadable";

/**
 * Resolve closure for the owner process recorded on a held claim.
 *
 * The item snapshot is re-read immediately before the check. A numeric pid
 * alone is never enough to signal: the shared policy additionally requires a
 * leader-matching group id that is proven and a live birth token that matches.
 * If the claim changed between the list read and this check, another authority
 * (a re-claim, a stop, a manual edit) owns the row now, so this recovery pass
 * must not touch it.
 */
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
 * Durable Stop intent. A Stop that ended held leaves `stop_unconfirmed` (and an
 * earlier `stop_requested`) on the attempt; only a later `stop_confirmed`
 * clears it. Restart/reconciliation consult this so an explicit Stop is never
 * converted back into a queue or retry.
 */
export type StopIntentState = "pending" | "none" | "unknown";

/**
 * Durable Stop intent. A read failure is `unknown`, never "no Stop": callers
 * must hold rather than treat unreadable history as ordinary work.
 */
export const readStopIntent = (
  runEvents: RunEventRepository["Service"],
  runAttemptId: RunAttempt["id"],
): Effect.Effect<StopIntentState> =>
  runEvents.listForAttempt(runAttemptId).pipe(
    Effect.map((events): StopIntentState => {
      let pending = false;
      for (const event of events) {
        if (event.eventType === "stop_requested" || event.eventType === "stop_unconfirmed") {
          pending = true;
        } else if (event.eventType === "stop_confirmed") {
          pending = false;
        }
      }
      return pending ? "pending" : "none";
    }),
    Effect.catch(() => Effect.succeed("unknown" as const)),
  );

/**
 * Settle a previously requested Stop once closure is confirmed: update the
 * exact attempt to `user_cancelled` and release the exact claim snapshot to
 * `cancelled`. Never queue or retry. Returns false when the claim changed and
 * the CAS refused, leaving the replacement untouched.
 */
export const settleConfirmedStopIntent = (input: {
  readonly workItems: WorkItemRepository["Service"];
  readonly runAttempts: RunAttemptRepository["Service"];
  readonly runEvents: RunEventRepository["Service"];
  readonly runAttemptId: RunAttempt["id"];
  readonly workItemId: WorkItem["id"];
  readonly ownership: ClaimOwnership;
  readonly now: string;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const fence = ownershipFence(input.ownership);
    if (fence === null) return false;
    const released = yield* input.workItems
      .releaseConfirmedStop(input.workItemId, fence)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (!released) return false;
    yield* input.runAttempts
      .updateStatus(input.runAttemptId, "user_cancelled", { finishedAt: input.now })
      .pipe(Effect.catch(() => Effect.void));
    yield* input.runEvents
      .appendOnce(input.runAttemptId, "stop_confirmed", {
        workItemId: String(input.workItemId),
        closure: "recovered_stop",
        released: true,
      })
      .pipe(Effect.catch(() => Effect.succeed(false)));
    yield* input.runEvents
      .appendOnce(input.runAttemptId, "user_cancelled", {
        workItemId: String(input.workItemId),
        recovered: true,
      })
      .pipe(Effect.catch(() => Effect.succeed(false)));
    return true;
  });

const resolveOwnerClosure = (
  deps: RecoveryDeps,
  ownership: ClaimOwnership,
): Effect.Effect<
  | ProcessClosureResult
  | {
      readonly status: "held";
      readonly reason: RecoveryHoldReason;
      readonly detail?: string;
    }
> =>
  Effect.gen(function* () {
    if (ownership.ownerPid === null) {
      // No child ownership was recorded on this exact claim. The release
      // remains fenced by the same snapshot (including a null pid).
      return { status: "closed", evidence: "no_owner_recorded" } as const;
    }
    return yield* confirmOwnedProcessClosure(
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
  });

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
      yield* recoverItem(deps, item, workflows, now).pipe(Effect.catch(() => Effect.void));
    }
  }).pipe(Effect.withSpan("symphonyRecovery.runStartupRecovery"));

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
    const ownershipProbe = yield* Effect.result(deps.workItems.getClaimOwnership(item.id));
    if (ownershipProbe._tag === "Failure") {
      // Unknown ownership is not absence. Keep the claim for reconciliation.
      yield* Effect.logWarning("symphony.recovery.ownership_unreadable", {
        workItemId: String(item.id),
      });
      return;
    }
    const ownership = ownershipProbe.success;
    const releaseFence = ownership === null ? null : ownershipFence(ownership);
    const attemptProbe = yield* Effect.result(deps.runAttempts.latestForWorkItem(item.id));
    if (attemptProbe._tag === "Failure") {
      // An undecodable/unreadable attempt is evidence failure, not "no attempt".
      yield* Effect.logWarning("symphony.recovery.attempt_unreadable", {
        workItemId: String(item.id),
      });
      return;
    }
    const attempt = attemptProbe.success;
    if (attempt === null) {
      // A positively missing attempt row is normally an in-flight dispatch
      // window. The age-based crash-window release applies only when the
      // exact claim records no child process at all; any recorded or unknown
      // ownership stays held rather than being released without evidence.
      if (ownership === null || releaseFence === null || ownership.ownerPid !== null) {
        return;
      }
      const claimedAtValue = ownership.claimedAt;
      const claimedAt = claimedAtValue === null ? null : Date.parse(claimedAtValue);
      if (
        claimedAt !== null &&
        !Number.isNaN(claimedAt) &&
        (yield* Clock.currentTimeMillis) - claimedAt > STALL_WINDOW_MS
      ) {
        yield* deps.workItems
          .releaseClaim(item.id, "queued", releaseFence)
          .pipe(Effect.catch(() => Effect.void));
      }
      return;
    }

    const active = yield* deps.dispatcher.isAgentActive(attempt.id);
    if (active) {
      return;
    }

    // Only a run with a live claim can be adopted as a crash orphan: no claim
    // means the item was seeded/written directly (tests, manual edits) and no
    // dispatch fiber ever owned it — interrupting it would mark a live run
    // dead (audit item 3; the claim is the proof a dispatcher was here).
    if (ownership === null || ownership.ownerToken === null || releaseFence === null) {
      return;
    }

    // Positive association is the exact durable attempt/claim binding, not
    // timestamp order. Missing legacy bindings stay held and unverifiable.
    const binding = yield* readAttemptClaimBinding(deps.runEvents, attempt.id);
    if (!claimBindingMatches(binding, ownership, item.id)) {
      yield* deps.runEvents
        .appendOnce(attempt.id, "recovery_hold", {
          workItemId: String(item.id),
          reason: "claim_binding_unverified",
          ownerPid: ownership.ownerPid,
          generation: ownership.generation,
          terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      return;
    }

    if (yield* hasOwnershipFailureEvent(deps.runEvents, attempt.id)) {
      yield* deps.runEvents
        .appendOnce(attempt.id, "recovery_hold", {
          workItemId: String(item.id),
          reason: "ownership_unverified",
          ownerPid: ownership.ownerPid,
          generation: ownership.generation,
          terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      return;
    }

    // Identity and closure come before ANY release, interruption or terminal
    // transition, including the terminal-attempt shortcut below. An
    // unverifiable owner keeps the claim, lease and lifecycle exactly as they
    // are and records why, so reconciliation can handle it explicitly.
    const closure = yield* resolveOwnerClosure(deps, ownership);
    if (closure.status === "held") {
      yield* deps.runEvents
        .appendOnce(attempt.id, "recovery_hold", {
          workItemId: String(item.id),
          reason: closure.reason,
          ...(closure.detail === undefined ? {} : { detail: closure.detail }),
          ownerPid: ownership.ownerPid,
          generation: ownership.generation,
          terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      return;
    }

    // A durable Stop always wins over retry/requeue once closure is confirmed.
    const stopIntent = yield* readStopIntent(deps.runEvents, attempt.id);
    if (stopIntent === "unknown") {
      yield* deps.runEvents
        .appendOnce(attempt.id, "recovery_hold", {
          workItemId: String(item.id),
          reason: "stop_intent_unreadable",
          ownerPid: ownership.ownerPid,
          generation: ownership.generation,
          terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      return;
    }
    if (stopIntent === "pending") {
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
        yield* deps.runEvents
          .appendOnce(attempt.id, "recovery_hold", {
            workItemId: String(item.id),
            reason: "claim_changed",
            ownerPid: ownership.ownerPid,
            generation: ownership.generation,
            terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
          })
          .pipe(Effect.catch(() => Effect.succeed(false)));
      }
      return;
    }

    if (TERMINAL_STATUSES.has(attempt.status)) {
      // A `succeeded` attempt on a held item means finalization finished the
      // run but the ready_for_review transition never landed (crash in the
      // window). Re-running the agent would repeat edits, pushes and PR
      // creation (REVIEW P1 #11). Land the item in its review state instead.
      if (attempt.status === "succeeded") {
        yield* deps.workItems
          .transition(item.id, "ready_for_review", {
            from: ["preparing", "running", "testing"],
            ownerToken: releaseFence.ownerToken,
            generation: releaseFence.generation,
          })
          .pipe(Effect.catch(() => Effect.void));
        return;
      }
      yield* deps.workItems
        .releaseClaim(item.id, "queued", releaseFence)
        .pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Non-terminal attempt with no live agent and positively confirmed closure
    // of any recorded owner process: the worker is gone (restart or crash).
    // Mark interrupted and release per the retry policy. The shared closure
    // check above already terminated a validated owned group; nothing
    // unverified was signalled.
    // Pending approval/input requests for a dead run are unanswerable: mark
    // them interrupted (plan 8.3.1; audit item 3). The orchestrator supplies
    // the closure so Recovery stays free of ApprovalService's type.
    if (deps.interruptRunApprovals !== undefined) {
      yield* deps
        .interruptRunApprovals({ workItemId: item.id, runAttemptId: String(attempt.id) })
        .pipe(Effect.catch(() => Effect.void));
    }
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
      .releaseClaim(item.id, retryable ? "retry_scheduled" : "queued", releaseFence)
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
