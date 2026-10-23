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
const resolveOwnerClosure = (
  deps: RecoveryDeps,
  item: WorkItem,
  fence: { readonly ownerToken: string | null; readonly generation: number },
): Effect.Effect<
  | ProcessClosureResult
  | {
      readonly status: "held";
      readonly reason: RecoveryHoldReason;
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
      // No child ownership was ever recorded on this exact claim. There is
      // nothing to signal or wait for; the release below stays fenced.
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
        ownerPid: item.ownerPid,
        ...(item.ownerPgid === undefined ? {} : { ownerPgid: item.ownerPgid }),
        ...(item.ownerBirthToken === undefined ? {} : { ownerBirthToken: item.ownerBirthToken }),
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
    const fence = yield* deps.workItems
      .getClaimFence(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const releaseFence =
      fence === null || fence.ownerToken === null
        ? undefined
        : { ownerToken: fence.ownerToken, generation: fence.generation };
    const attempt = yield* deps.runAttempts
      .latestForWorkItem(item.id)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (attempt === null) {
      // A claim without any attempt is normally an in-flight dispatch
      // window; leave it alone to avoid racing the dispatcher. But a claim
      // that predates this server start by more than the stall window is a
      // crash between claim and attempt-create: release it so the item is not
      // stuck in `preparing` forever (REVIEW P1 #10).
      const claimedAtValue = item.claimedAt;
      const claimedAt =
        claimedAtValue === undefined || claimedAtValue === null ? null : Date.parse(claimedAtValue);
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
    if (item.claimedAt === undefined || item.claimedAt === null) {
      return;
    }

    // Identity and closure come before ANY release, interruption or terminal
    // transition, including the terminal-attempt shortcut below. An
    // unverifiable owner keeps the claim, lease and lifecycle exactly as they
    // are and records why, so reconciliation can handle it explicitly.
    if (fence === null) {
      return; // claim row disappeared; nothing authoritative to act on
    }
    const closure = yield* resolveOwnerClosure(deps, item, fence);
    if (closure.status === "held") {
      yield* deps.runEvents
        .appendOnce(attempt.id, "recovery_hold", {
          workItemId: String(item.id),
          reason: closure.reason,
          ...(closure.detail === undefined ? {} : { detail: closure.detail }),
          ownerPid: item.ownerPid ?? null,
          generation: fence.generation,
          terminalAttempt: TERMINAL_STATUSES.has(attempt.status),
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
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
            ...(releaseFence === undefined
              ? {}
              : { ownerToken: releaseFence.ownerToken, generation: releaseFence.generation }),
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
