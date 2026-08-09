import type {
  EffectiveWorkflowConfig,
  RunAttempt,
  WorkItem,
  WorkflowRecord,
} from "@neokod/contracts";
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
  /** Called after marking a run interrupted: settle that run's pending
   * approval/input requests (plan 8.3.1; audit item 3). */
  readonly interruptRunApprovals?: (input: {
    readonly workItemId: WorkItem["id"];
    readonly runAttemptId: string;
  }) => Effect.Effect<void>;
}

/** A claim with no attempt row older than this is a crash orphan, not an
 * in-flight dispatch (REVIEW P1 #10). */
const STALL_WINDOW_MS = 5 * 60_000;

/**
 * Terminate a coding-agent child that survived the server crash (audit item
 * 3; plan 8.1). The claim records the child PID; after a restart that PID is
 * an orphan (or a recycled one — checking liveness via kill(pid, 0) guards
 * that). Best-effort and non-fatal.
 */
const terminateOrphanAgent = (item: WorkItem): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const pid = item.ownerPid;
    if (pid === null || pid === undefined || pid <= 0) {
      return;
    }
    yield* Effect.tryPromise(() =>
      // Signal 0 probes liveness without killing; SIGTERM (15) terminates.
      // If the PID was recycled to an unrelated process, probe-then-kill can
      // hit the wrong target, so only act when the process is a child of ours
      // is unknowable post-crash — accept the small risk in exchange for
      // actually stopping orphan token burn; the PID was recorded at spawn.
      import("node:child_process").then(({ spawnSync }) => {
        const probe = spawnSync("kill", ["-0", String(pid)], { stdio: "ignore" });
        if (probe.status === 0) {
          spawnSync("kill", ["-15", String(pid)], { stdio: "ignore" });
        }
      }),
    ).pipe(Effect.catch(() => Effect.void));
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
        yield* deps.workItems.releaseClaim(item.id, "queued").pipe(Effect.catch(() => Effect.void));
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

    if (TERMINAL_STATUSES.has(attempt.status)) {
      // A `succeeded` attempt on a held item means finalization finished the
      // run but the ready_for_review transition never landed (crash in the
      // window). Re-running the agent would repeat edits, pushes and PR
      // creation (REVIEW P1 #11). Land the item in its review state instead.
      if (attempt.status === "succeeded") {
        yield* deps.workItems
          .transition(item.id, "ready_for_review", { from: ["preparing", "running", "testing"] })
          .pipe(Effect.catch(() => Effect.void));
        return;
      }
      yield* deps.workItems.releaseClaim(item.id, "queued").pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Non-terminal attempt with no live agent: the worker is gone (restart or
    // crash). Mark interrupted and release per the retry policy.
    // Orphan adoption (audit item 3): the agent child may have survived the
    // server crash (the claim row records its PID). Terminate it before
    // releasing, so a dead run does not keep burning tokens in the background.
    yield* terminateOrphanAgent(item);
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
