import type {
  EffectiveWorkflowConfig,
  IsoDateTime,
  NormalizedIssue,
  WorkItem,
  WorkItemId,
} from "@neokod/contracts";
import { RunAttemptId, WorkflowId } from "@neokod/contracts";
import {
  confirmOwnedProcessClosure,
  isGroupSignalingSupported,
  type ProcessClosureDeps,
  type ProcessClosureEvidence,
  type ProcessClosureResult,
  type ProcessGroupIdentity,
} from "@neokod/shared/processGroup";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import { ServerConfig } from "../../config.ts";
import { nowIso } from "../Domain/Time.ts";
import { WORKFLOW_DEFAULTS } from "../Workflow/Config.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import {
  WorkItemRepository,
  type ClaimFence,
  type ClaimOwnership,
} from "../Persistence/Services/WorkItemRepository.ts";
import {
  WorkspaceManager,
  WorkspaceOutsideRootError,
  type SymphonyWorkspace,
} from "../Workspaces/Manager.ts";
import { AgentRuntimeChildOwnershipError, type AgentRuntimeService } from "./AgentRuntime.ts";
import { freezeAcceptedGuidance } from "./AcceptedGuidance.ts";
import { ExecutionFinalizer } from "./ExecutionFinalizer.ts";
import { LiveRequests } from "./LiveRequests.ts";
import type { ReviewFeedbackContext } from "./Prompt.ts";
import { resolveRunnerPolicy, requiresApprovalBeforeEdit } from "./Policy.ts";
import { isRetryableCategory } from "../Orchestrator/Retry.ts";

/**
 * Run dispatcher (WS-J integration, plan 8.1/8.2, Phase 2 exit).
 *
 * The glue between the Observe orchestrator and the Phase 2 leaf modules. A
 * dispatched work item is claimed transactionally, gets a workspace (worktree
 * under the configured root), records a run attempt, then runs the Codex
 * agent in the workspace. In `prepare` autonomy the agent produces a plan only
 * and edits are blocked at the sandbox; in `execute`/`deliver` it may edit
 * subject to the approval policy, and the approval slice (WS-J2) answers the
 * blocking JSON-RPC requests. Run events are appended to the timeline along
 * the way so the Running view (WS-K) has a live feed.
 *
 * This is where "no code modified without approval" is enforced structurally:
 * `requiresApprovalBeforeEdit` gates the run, and the sandbox policy itself
 * blocks edits in prepare mode (SPEC 10.5, plan 8.3).
 */

export class RunDispatchError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Run dispatch failed: ${detail}`);
    this.name = "RunDispatchError";
    this.detail = detail;
  }
}

/**
 * Honest Stop acknowledgement. `held` means ownership was deliberately kept:
 * the caller must not report the run as cancelled or release its workspace.
 */
export type StopOutcome =
  | {
      readonly status: "confirmed";
      readonly runAttemptId: RunAttemptId;
      readonly evidence: string;
      readonly released: boolean;
      /** Generation produced by the exact confirmed release, when observed. */
      readonly releasedGeneration?: number;
    }
  | {
      readonly status: "held";
      readonly runAttemptId: RunAttemptId;
      readonly reason: string;
      readonly detail?: string;
    };

export interface StopAllRunsResult {
  /** Count of runs whose closure was positively confirmed and released. */
  readonly confirmed: number;
  /** Count of runs left held with unconfirmed ownership. */
  readonly held: number;
}

export interface RunDispatcherService {
  /** Claim + prepare + run one work item. Returns the created run attempt id. */
  readonly dispatchWorkItem: (input: {
    readonly workItem: WorkItem;
    readonly issue: NormalizedIssue;
    readonly config: EffectiveWorkflowConfig;
    /** Workflow record id and persisted revision read by the orchestrator for this dispatch. */
    readonly workflowId: WorkflowId;
    readonly workflowRevision: IsoDateTime;
    /** Agent-facing Markdown body from WORKFLOW.md. Raw front matter remains
     * host-only and is never included in the model prompt. */
    readonly workflowInstructions?: string;
    /** Review context for a continuation dispatch after PR review feedback
     * (plan FR-102-104): rendered into the FIRST turn's prompt only — the
     * turn-2..N continuation loop below never re-sends it, matching how the
     * original prompt itself is never re-sent (SPEC 8.2). */
    readonly reviewFeedback?: ReviewFeedbackContext;
  }) => Effect.Effect<RunAttemptId, RunDispatchError, Scope.Scope>;

  readonly cancelRun: (runAttemptId: RunAttemptId) => Effect.Effect<StopOutcome, RunDispatchError>;

  /** True while a live agent is registered for the run (reconciliation input). */
  readonly isAgentActive: (runAttemptId: RunAttemptId) => Effect.Effect<boolean>;

  /** Stop every live run, separating confirmed closures from held ownership. */
  readonly stopAllRuns: () => Effect.Effect<StopAllRunsResult, RunDispatchError>;
}

export class RunDispatcher extends Context.Service<RunDispatcher, RunDispatcherService>()(
  "neokod/symphony/Runner/Dispatcher/RunDispatcher",
) {}

/**
 * Constructs the agent runtime for a given workflow config. The agent runtime
 * is per-config (codex command / CODEX_HOME / env come from the workflow and
 * server), so the dispatcher builds one per dispatch inside a scope rather than
 * depending on a singleton. Injected by the layer; the orchestrator test
 * supplies a stub.
 */
export class AgentRuntimeFactory extends Context.Service<
  AgentRuntimeFactory,
  {
    readonly make: (
      config: EffectiveWorkflowConfig,
      options?: {
        onChildSpawned?(
          pid: number,
          identity?: ProcessGroupIdentity,
        ): Effect.Effect<void, AgentRuntimeChildOwnershipError>;
      },
    ) => Effect.Effect<AgentRuntimeService, never, Scope.Scope>;
  }
>()("neokod/symphony/Runner/Dispatcher/AgentRuntimeFactory") {}

/**
 * Process-identity readers/signallers used to resolve a confirmed Stop. The
 * production default reads the live POSIX process table and terminates a
 * validated owned group; tests inject fake readers/signallers so checks never
 * signal a real process. The seam is optional so existing layers keep working.
 */
export class RunDispatcherProcessClosure extends Context.Service<
  RunDispatcherProcessClosure,
  ProcessClosureDeps
>()("neokod/symphony/Runner/Dispatcher/RunDispatcherProcessClosure") {}

/** How long a Stop waits for the interrupted dispatch fiber to exit. */
const STOP_FIBER_EXIT_TIMEOUT = Duration.seconds(5);

/**
 * Exact attempt-to-claim binding recorded before any provider spawn. This is
 * the only positive association between an attempt and a claim generation;
 * timestamps are not identity.
 */
export interface AttemptClaimBinding {
  readonly runAttemptId: RunAttemptId;
  readonly workItemId: string;
  readonly ownerToken: string;
  readonly generation: number;
}

export const CLAIM_BINDING_EVENT = "issue_claimed";

/**
 * Read the exact durable claim binding for one attempt. The latest well-formed
 * `issue_claimed` event wins; a missing or malformed binding is unknown, never
 * inferred from attempt timing or the current row.
 */
export const readAttemptClaimBinding = (
  runEvents: RunEventRepository["Service"],
  runAttemptId: RunAttemptId,
): Effect.Effect<AttemptClaimBinding | null> =>
  runEvents.listForAttempt(runAttemptId).pipe(
    Effect.map((events) => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined || event.eventType !== CLAIM_BINDING_EVENT) continue;
        const payload = event.payload;
        if (payload === undefined) continue;
        const workItemId = payload.workItemId;
        const ownerToken = payload.ownerToken;
        const generation = payload.generation;
        if (
          typeof workItemId === "string" &&
          typeof ownerToken === "string" &&
          ownerToken.length > 0 &&
          typeof generation === "number" &&
          Number.isInteger(generation)
        ) {
          return {
            runAttemptId,
            workItemId,
            ownerToken,
            generation,
          } satisfies AttemptClaimBinding;
        }
      }
      return null;
    }),
    Effect.catch(() => Effect.succeed(null)),
  );

/** Exact binding match against the current atomic claim ownership row. */
export const claimBindingMatches = (
  binding: AttemptClaimBinding | null,
  ownership: ClaimOwnership | null,
  workItemId: WorkItemId,
): binding is AttemptClaimBinding =>
  binding !== null &&
  ownership !== null &&
  ownership.ownerToken !== null &&
  binding.runAttemptId !== undefined &&
  binding.workItemId === String(workItemId) &&
  binding.ownerToken === ownership.ownerToken &&
  binding.generation === ownership.generation;

export interface StopConfirmation {
  readonly evidence: string;
  readonly generation: number | null;
}

export const readStopConfirmation = (
  runEvents: RunEventRepository["Service"],
  runAttemptId: RunAttemptId,
): Effect.Effect<StopConfirmation | null> =>
  runEvents.listForAttempt(runAttemptId).pipe(
    Effect.map((events) => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined || event.eventType !== "stop_confirmed") continue;
        const payload = event.payload;
        const evidence =
          payload !== undefined && typeof payload.closure === "string"
            ? payload.closure
            : "confirmed";
        const generation =
          payload !== undefined &&
          typeof payload.generation === "number" &&
          Number.isInteger(payload.generation)
            ? payload.generation
            : null;
        return { evidence, generation } satisfies StopConfirmation;
      }
      return null;
    }),
    Effect.catch(() => Effect.succeed(null)),
  );

export const OWNERSHIP_FAILURE_EVENT = "ownership_record_failed";

export const hasOwnershipFailureEvent = (
  runEvents: RunEventRepository["Service"],
  runAttemptId: RunAttemptId,
): Effect.Effect<boolean> =>
  runEvents.listForAttempt(runAttemptId).pipe(
    Effect.map((events) => events.some((event) => event.eventType === OWNERSHIP_FAILURE_EVENT)),
    Effect.catch(() => Effect.succeed(false)),
  );

/** Shared platform capability gate; used by admission and startup/dispatch. */
export const symphonyAdmissionPlatformRefusal = (
  platform: NodeJS.Platform = process.platform,
): string | null =>
  isGroupSignalingSupported(platform)
    ? null
    : `Symphony execution is unavailable on ${platform}: process-group closure cannot be proven, so work is not admitted. Normal Code threads are unaffected.`;

export const makeRunDispatcher = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const workItems = yield* WorkItemRepository;
  const runAttempts = yield* RunAttemptRepository;
  const runEvents = yield* RunEventRepository;
  const workspaces = yield* WorkspaceManager;
  const factory = yield* AgentRuntimeFactory;
  const liveRequests = yield* LiveRequests;
  const finalizer = yield* ExecutionFinalizer;
  const maybeProcessClosure = yield* Effect.serviceOption(RunDispatcherProcessClosure);
  const processClosure: ProcessClosureDeps = Option.isSome(maybeProcessClosure)
    ? maybeProcessClosure.value
    : {};

  // Live agents per run attempt plus the dispatch fiber, so cancellation can
  // interrupt the active turn AND the fiber driving it (plan 8.3.1; REVIEW P0
  // "cancelRun never stops the dispatch fiber").
  const activeAgents = yield* Ref.make<
    Map<
      string,
      { readonly agent: AgentRuntimeService; readonly fiber: Fiber.Fiber<unknown, unknown> }
    >
  >(new Map());

  // Attempts with a Stop in progress. The marker is written before the turn
  // and fiber are interrupted, so a failure path that is already unwinding
  // cannot turn the Stop into a retry. It is removed when the Stop settles.
  const stoppingAttempts = yield* Ref.make<ReadonlySet<string>>(new Set());
  const startingRuns = yield* Ref.make<ReadonlySet<string>>(new Set());
  const ownershipFailures = yield* Ref.make<ReadonlySet<string>>(new Set());
  const spawnedAttempts = yield* Ref.make<ReadonlySet<string>>(new Set());
  const isStopping = (runAttemptId: RunAttemptId) =>
    Ref.get(stoppingAttempts).pipe(Effect.map((ids) => ids.has(String(runAttemptId))));

  // Source lifecycles the repository's confirmed-Stop CAS accepts. Kept
  // aligned with the historical `cancelled` transition sources.
  const STOP_SOURCE_LIFECYCLES: ReadonlySet<string> = new Set([
    "draft",
    "ineligible",
    "queued",
    "preparing",
    "blocked",
    "running",
    "testing",
    "waiting_for_approval",
    "retry_scheduled",
  ]);
  const ACTIVE_LIFECYCLES: ReadonlySet<string> = new Set(["preparing", "running", "testing"]);

  const ownershipMatches = (a: ClaimOwnership, b: ClaimOwnership): boolean =>
    a.lifecycle === b.lifecycle &&
    (a.claimedAt ?? null) === (b.claimedAt ?? null) &&
    (a.ownerToken ?? null) === (b.ownerToken ?? null) &&
    a.generation === b.generation &&
    (a.ownerPid ?? null) === (b.ownerPid ?? null) &&
    (a.ownerPgid ?? null) === (b.ownerPgid ?? null) &&
    (a.ownerBirthToken ?? null) === (b.ownerBirthToken ?? null);

  const toFence = (ownership: ClaimOwnership): ClaimFence | null =>
    ownership.ownerToken === null
      ? null
      : {
          ownerToken: ownership.ownerToken,
          generation: ownership.generation,
          ownerPid: ownership.ownerPid,
          ownerPgid: ownership.ownerPgid,
          ownerBirthToken: ownership.ownerBirthToken,
        };

  const readOwnership = (workItemId: WorkItemId) =>
    workItems.getClaimOwnership(workItemId).pipe(Effect.catch(() => Effect.succeed(null)));

  /**
   * Resolve closure from one atomic ownership row. `interrupt()` is a request
   * acknowledgement, not proof the child process or its group exited.
   */
  const resolveStopClosure = (
    ownership: ClaimOwnership | null,
    options?: { readonly knownNoSpawn?: boolean },
  ): Effect.Effect<
    | ProcessClosureResult
    | {
        readonly status: "held";
        readonly reason: "claim_unreadable" | "identity_missing_for_bound_attempt";
        readonly detail?: string;
      }
  > =>
    ownership === null
      ? Effect.succeed({ status: "held", reason: "claim_unreadable" } as const)
      : ownership.ownerPid === null
        ? options?.knownNoSpawn === true
          ? Effect.succeed({ status: "closed", evidence: "no_owner_recorded" } as const)
          : Effect.succeed({
              status: "held",
              reason: "identity_missing_for_bound_attempt",
              detail:
                "the attempt is bound to this claim but no child identity was persisted; a lost ownership write is not proof that no child spawned",
            } as const)
        : confirmOwnedProcessClosure(
            {
              ownerPid: ownership.ownerPid,
              ...(ownership.ownerPgid === null ? {} : { ownerPgid: ownership.ownerPgid }),
              ...(ownership.ownerBirthToken === null
                ? {}
                : { ownerBirthToken: ownership.ownerBirthToken }),
            },
            processClosure,
          );

  const makeRunAttemptId = () =>
    crypto.randomUUIDv4.pipe(
      Effect.map((value) => RunAttemptId.make(`run-${value}`)),
      Effect.mapError(() => new RunDispatchError("failed to generate run attempt id")),
    );

  const appendEvent = (
    runAttemptId: RunAttemptId,
    eventType: string,
    payload?: Record<string, unknown>,
  ) => runEvents.append(runAttemptId, eventType, payload).pipe(Effect.catch(() => Effect.void));

  const releaseClaim = (workItemId: WorkItemId, ownerToken: string, generation: number) =>
    workItems
      .transition(workItemId, "queued", { ownerToken, generation })
      .pipe(Effect.catch(() => Effect.void));

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

  /**
   * The retry decision must honor the recorded terminal status, not just the
   * error category (REVIEW P0: a user-cancelled run was retried because
   * markFailed used the hard-coded "agent" category). Plan 9.5: user
   * cancellation and tracker cancellation are never retryable. `maxAttempts`
   * is per-dispatch (REVIEW P2 #2: shared mutable state let one workflow's
   * cap leak into another's retries).
   */
  const retryableFromAttempt = (
    attempt: { readonly status: string; readonly attemptNumber: number } | null,
    errorCategory: string,
    maxAttempts: number,
  ): boolean => {
    if (attempt === null) {
      return isRetryableCategory(errorCategory) && 1 < maxAttempts;
    }
    if (attempt.status === "user_cancelled" || attempt.status === "tracker_cancelled") {
      return false;
    }
    return isRetryableCategory(errorCategory) && attempt.attemptNumber < maxAttempts;
  };

  // Mark the attempt failed unless cancellation already recorded a terminal
  // status (cancelRun wins over the interrupted turn path), then release the
  // claim: to `retry_scheduled` when the failure is retryable and attempts
  // remain (plan 9.5, WS-M), otherwise to `failed` so the scheduler never
  // relaunches a terminal-failed item by itself.
  const markFailed = (
    runAttemptId: RunAttemptId,
    workItemId: WorkItemId,
    ownerToken: string,
    generation: number,
    error: { readonly category: string; readonly message: string },
    maxAttempts: number,
  ) =>
    Effect.gen(function* () {
      // A Stop owns this attempt from the moment its marker is set. A failure
      // unwinding concurrently must not mark it failed or schedule a retry.
      if (yield* isStopping(runAttemptId)) {
        return;
      }
      const attempt = yield* runAttempts
        .getById(runAttemptId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (
        attempt !== null &&
        (attempt.status === "user_cancelled" || attempt.status === "tracker_cancelled")
      ) {
        return; // cancelRun owns the item lifecycle
      }
      const alreadyTerminal = attempt !== null && TERMINAL_STATUSES.has(attempt.status);
      const attemptNumber = attempt?.attemptNumber ?? 1;
      if (!alreadyTerminal) {
        yield* runAttempts
          .updateStatus(runAttemptId, "failed", {
            finishedAt: yield* nowIso,
            error,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      // Re-read the marker after the status write: the transition below is the
      // point of no return for a retry.
      if (yield* isStopping(runAttemptId)) {
        return;
      }
      // A failure is not process closure. Only the exact claim that owns this
      // attempt, with positively closed or never-recorded ownership, may retry.
      const currentOwnership = yield* readOwnership(workItemId);
      if (
        currentOwnership === null ||
        currentOwnership.ownerToken !== ownerToken ||
        currentOwnership.generation !== generation
      ) {
        return; // a replacement claim owns the item; never touch it
      }
      const ownershipUnverified =
        (yield* Ref.get(ownershipFailures)).has(String(runAttemptId)) ||
        (yield* hasOwnershipFailureEvent(runEvents, runAttemptId));
      if (ownershipUnverified) {
        yield* runEvents
          .appendOnce(runAttemptId, "failure_hold", {
            workItemId: String(workItemId),
            reason: "ownership_unverified",
            ownerPid: currentOwnership.ownerPid,
            generation,
            category: error.category,
          })
          .pipe(Effect.catch(() => Effect.succeed(false)));
        return;
      }
      const binding = yield* readAttemptClaimBinding(runEvents, runAttemptId);
      if (!claimBindingMatches(binding, currentOwnership, workItemId)) {
        yield* runEvents
          .appendOnce(runAttemptId, "failure_hold", {
            workItemId: String(workItemId),
            reason: "claim_binding_unverified",
            ownerPid: currentOwnership.ownerPid,
            generation: currentOwnership.generation,
            category: error.category,
          })
          .pipe(Effect.catch(() => Effect.succeed(false)));
        return;
      }
      const spawnObserved = (yield* Ref.get(spawnedAttempts)).has(String(runAttemptId));
      const ownership = yield* resolveStopClosure(currentOwnership, {
        knownNoSpawn: !spawnObserved,
      });
      if (ownership.status === "held") {
        yield* runEvents
          .appendOnce(runAttemptId, "failure_hold", {
            workItemId: String(workItemId),
            reason: ownership.reason,
            ...(ownership.detail === undefined ? {} : { detail: ownership.detail }),
            ownerPid: currentOwnership.ownerPid,
            generation,
            category: error.category,
          })
          .pipe(Effect.catch(() => Effect.succeed(false)));
        return;
      }
      const retryable = retryableFromAttempt(attempt, error.category, maxAttempts);
      if (retryable) {
        yield* workItems
          .transition(workItemId, "retry_scheduled", { ownerToken, generation })
          .pipe(Effect.catch(() => Effect.void));
        yield* runEvents
          .append(runAttemptId, "retry_scheduled", {
            workItemId: String(workItemId),
            attemptNumber,
            maxAttempts,
          })
          .pipe(Effect.catch(() => Effect.void));
      } else {
        yield* workItems
          .transition(workItemId, "failed", { ownerToken, generation })
          .pipe(Effect.catch(() => Effect.void));
        yield* appendEvent(
          runAttemptId,
          isRetryableCategory(error.category) ? "retries_exhausted" : "run_failed",
          { attemptNumber, maxAttempts, category: error.category },
        );
      }
    });

  const failEarly = (input: {
    readonly workItemId: WorkItemId;
    readonly ownerToken: string;
    readonly generation: number;
    readonly config: EffectiveWorkflowConfig;
    readonly maxAttempts: number;
    readonly stage: "workspace";
    readonly error: { readonly category: string; readonly message: string };
  }) =>
    Effect.gen(function* () {
      const runAttemptId = yield* makeRunAttemptId().pipe(Effect.catch(() => Effect.succeed(null)));
      const latest = yield* runAttempts
        .latestForWorkItem(input.workItemId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
      const now = yield* nowIso;
      const created =
        runAttemptId === null
          ? false
          : yield* runAttempts
              .create({
                id: runAttemptId,
                workItemId: input.workItemId,
                attemptNumber,
                workspacePath: "",
                provider: input.config.agentProvider,
                ...(input.config.agentModel !== undefined
                  ? { model: input.config.agentModel }
                  : {}),
                status: "failed",
                startedAt: now,
                finishedAt: now,
                error: { ...input.error, attemptNumber },
              })
              .pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              );
      if (runAttemptId !== null && created) {
        // Exact binding for this attempt even though no provider child exists;
        // the failure release still uses the same claim authority. If the
        // binding cannot be written no child exists, so fail closed terminal
        // rather than leaving the item in `preparing` forever.
        const earlyBindingRecorded = yield* runEvents
          .append(runAttemptId, CLAIM_BINDING_EVENT, {
            workItemId: String(input.workItemId),
            ownerToken: input.ownerToken,
            generation: input.generation,
          })
          .pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        if (!earlyBindingRecorded) {
          yield* workItems
            .transition(input.workItemId, "failed", {
              ownerToken: input.ownerToken,
              generation: input.generation,
            })
            .pipe(Effect.catch(() => Effect.void));
          return;
        }
        yield* appendEvent(runAttemptId, "dispatch_failed_early", {
          stage: input.stage,
          message: input.error.message,
        });
        yield* markFailed(
          runAttemptId,
          input.workItemId,
          input.ownerToken,
          input.generation,
          input.error,
          input.maxAttempts,
        );
      } else {
        // No attempt row means the retry sweep (which needs a finished attempt) could never pick the
        // item up, so end it `failed` instead of leaving it in `preparing` or `queued`.
        yield* workItems
          .transition(input.workItemId, "failed", {
            ownerToken: input.ownerToken,
            generation: input.generation,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
    });

  const dispatchWorkItem: RunDispatcherService["dispatchWorkItem"] = (input) =>
    Effect.gen(function* () {
      const {
        workItem,
        issue,
        config,
        reviewFeedback,
        workflowId,
        workflowRevision,
        workflowInstructions,
      } = input;
      // Honest admission gate: without supported POSIX group semantics there
      // is no way to prove closure for a spawned child. Refuse before claiming
      // so old unknown ownership is never cleared and new work is not admitted
      // into a guaranteed-unconfirmable state.
      const platformRefusal = symphonyAdmissionPlatformRefusal(
        processClosure.platform ?? process.platform,
      );
      if (platformRefusal !== null) {
        return yield* Effect.fail(new RunDispatchError(platformRefusal));
      }
      const maxAttempts = config.maxAttempts ?? 5;
      const ownerToken = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => new RunDispatchError("failed to generate owner token")),
      );

      // 1. Claim transactionally (eligible -> preparing), fencing owner/generation.
      const claimed = yield* workItems
        .claim(workItem.id, ownerToken)
        .pipe(Effect.mapError((cause) => new RunDispatchError(cause.message)));
      const workItemId: WorkItemId = claimed.workItem.id;
      yield* Ref.update(startingRuns, (ids) => new Set(ids).add(String(workItemId)));

      // 2. Workspace: deterministic worktree under the configured root.
      const workspace: SymphonyWorkspace = yield* workspaces
        .ensureWorkspace({ issue, config })
        .pipe(
          Effect.tapError((cause) =>
            failEarly({
              workItemId,
              ownerToken,
              generation: claimed.generation,
              config,
              maxAttempts,
              stage: "workspace",
              error: {
                category:
                  cause instanceof WorkspaceOutsideRootError ? "workflow_error" : "process_failed",
                message: cause instanceof Error ? cause.message : String(cause),
              },
            }),
          ),
          Effect.mapError(
            (cause) => new RunDispatchError(cause instanceof Error ? cause.message : String(cause)),
          ),
        );

      // 3. Record the run attempt. Retries continue the attempt sequence so
      //    the backoff and the max-attempts cap read the right number.
      const runAttemptId = yield* makeRunAttemptId();
      const startedAt = yield* nowIso;
      const latestAttempt = yield* runAttempts
        .latestForWorkItem(workItemId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const attemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;
      const resumeCommittedHandoff =
        !workspace.createdNow &&
        latestAttempt !== null &&
        (latestAttempt.status === "failed" || latestAttempt.status === "interrupted") &&
        (yield* workspaces.hasCommittedHandoff(workspace));
      const acceptedGuidance = freezeAcceptedGuidance({
        acceptedAt: startedAt,
        workflowId,
        workflowRevision,
        workflowInstructions: workflowInstructions ?? "",
        workItem: {
          source: workItem.source,
          ...(workItem.repositoryId !== undefined ? { repositoryId: workItem.repositoryId } : {}),
        },
        issue,
        config,
        workspacePath: workspace.path,
        baseBranch: workspace.baseBranch,
      });
      yield* runAttempts
        .create({
          id: runAttemptId,
          workItemId,
          attemptNumber,
          workspacePath: workspace.path,
          provider: config.agentProvider,
          ...(config.agentModel !== undefined ? { model: config.agentModel } : {}),
          status: "preparing_workspace",
          startedAt,
          finishedAt: null,
          error: null,
          acceptedGuidance,
        })
        .pipe(
          Effect.mapError((cause) => new RunDispatchError(cause.message)),
          // No attempt row can be written here (the write just failed), so end
          // the item `failed` (legal from `preparing`) rather than looping
          // in `queued`.
          Effect.tapError(() =>
            workItems
              .transition(workItemId, "failed", { ownerToken, generation: claimed.generation })
              .pipe(Effect.catch(() => Effect.void)),
          ),
        );
      // REQUIRED exact attempt/claim binding, written before any provider
      // spawn. If this cannot be persisted, the run must not start: a missing
      // binding is permanently unverifiable for recovery.
      yield* runEvents
        .append(runAttemptId, CLAIM_BINDING_EVENT, {
          workItemId: String(workItemId),
          ownerToken,
          generation: claimed.generation,
        })
        .pipe(
          Effect.mapError(
            (cause) => new RunDispatchError(`failed to record claim binding: ${cause.message}`),
          ),
          Effect.tapError(() =>
            Effect.gen(function* () {
              yield* runAttempts
                .updateStatus(runAttemptId, "failed", {
                  finishedAt: yield* nowIso,
                  error: {
                    category: "workflow_error",
                    message: "claim binding could not be persisted; provider was never spawned",
                  },
                })
                .pipe(Effect.catch(() => Effect.void));
              // No child exists yet: this is the one failure that may safely
              // close the claim without process closure evidence.
              yield* workItems
                .transition(workItemId, "failed", { ownerToken, generation: claimed.generation })
                .pipe(Effect.catch(() => Effect.void));
            }),
          ),
        );
      yield* Ref.update(startingRuns, (ids) => {
        const next = new Set(ids);
        next.delete(String(workItemId));
        next.add(String(runAttemptId));
        return next;
      });
      yield* appendEvent(runAttemptId, "workspace_created", {
        path: workspace.path,
        branch: workspace.branch,
      });
      // The finalizer and the merge gate need the branch the worktree was created from.
      yield* workItems
        .setBaseBranch(workItemId, ownerToken, claimed.generation, workspace.baseBranch)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to record the workspace base branch on the claim", {
              workItemId: String(workItemId),
              cause,
            }),
          ),
        );

      const policy = resolveRunnerPolicy(config);
      // The agent child is spawned lazily inside the first turn. Record its pid on the claim as soon as
      // it exists so recovery can find a surviving orphan after a crash. The claim stores no pid before that.
      const agent = yield* factory.make(config, {
        onChildSpawned: (pid, identity) =>
          Effect.gen(function* () {
            yield* Ref.update(spawnedAttempts, (ids) => new Set(ids).add(String(runAttemptId)));
            const recorded = yield* workItems
              .setClaimOwnerProcessIdentity(workItemId, ownerToken, claimed.generation, {
                pid,
                ...(identity === undefined
                  ? {}
                  : { pgid: identity.pgid, birthToken: identity.birthToken }),
              })
              .pipe(Effect.catch(() => Effect.succeed(false)));
            if (recorded) return;
            // A child positively spawned but its identity is not durable. Keep
            // that fact restart-visible and in-process so no failure path can
            // treat the null persisted pid as "no child" and retry.
            yield* Ref.update(ownershipFailures, (ids) => new Set(ids).add(String(runAttemptId)));
            yield* runEvents
              .appendOnce(runAttemptId, OWNERSHIP_FAILURE_EVENT, {
                workItemId: String(workItemId),
                pid,
                pgid: identity?.pgid ?? null,
                generation: claimed.generation,
                reason: "ownership_persist_failed",
              })
              .pipe(
                Effect.catch((cause) =>
                  Effect.logError("symphony.agent.ownership_unverified_persist_failed", {
                    runAttemptId: String(runAttemptId),
                    workItemId: String(workItemId),
                    pid,
                    cause,
                  }),
                ),
              );
            return yield* Effect.fail(
              new AgentRuntimeChildOwnershipError(
                `claim ${String(workItemId)} generation ${claimed.generation} could not persist ownership for child pid ${pid}`,
              ),
            );
          }),
      });
      // PR body files land under the server's symphony logs dir when
      // available; otherwise the system temp dir (REVIEW P0: the body file
      // was never written and the path resolved to the filesystem root).
      const maybeConfig = yield* Effect.serviceOption(ServerConfig);
      const bodyFileDir = Option.isSome(maybeConfig)
        ? `${maybeConfig.value.symphonyLogsDir}/pr-bodies`
        : require("node:os").tmpdir();

      const runDispatch = Effect.gen(function* () {
        if (yield* isStopping(runAttemptId)) {
          return runAttemptId;
        }
        // 4. Prepare mode: produce a plan only; sandbox is read-only so no code
        //    can be modified, satisfying "no code modified without approval".
        if (policy.threadSandbox === "read-only") {
          yield* runAttempts
            .updateStatus(runAttemptId, "building_prompt")
            .pipe(Effect.catch(() => Effect.void));
          const result = yield* agent
            .runTurn({
              issue,
              config,
              workspacePath: workspace.path,
              branch: workspace.branch,
              baseBranch: workspace.baseBranch,
              runAttemptId,
              workItemId,
              acceptedGuidance,
              ...(workflowInstructions !== undefined ? { workflowInstructions } : {}),
              ...(reviewFeedback !== undefined ? { reviewFeedback } : {}),
            })
            .pipe(Effect.mapError((cause) => new RunDispatchError(cause.message)));

          if (result.completed) {
            yield* runAttempts
              .updateStatus(runAttemptId, "succeeded", { finishedAt: yield* nowIso })
              .pipe(Effect.catch(() => Effect.void));
            yield* appendEvent(runAttemptId, "plan_produced", { branch: workspace.branch });
            yield* workItems
              .transition(workItemId, "ready_for_review", {
                ownerToken,
                generation: claimed.generation,
              })
              .pipe(Effect.catch(() => Effect.void));
          } else {
            yield* markFailed(
              runAttemptId,
              workItemId,
              ownerToken,
              claimed.generation,
              {
                category: "agent",
                message: "plan turn did not complete",
              },
              maxAttempts,
            );
          }
          return runAttemptId;
        }

        // 5. Execute/deliver: edits allowed subject to the approval policy.
        yield* workItems
          .transition(workItemId, "running", {
            ownerToken,
            generation: claimed.generation,
            from: ["preparing"],
          })
          .pipe(Effect.catch(() => Effect.void));
        if (resumeCommittedHandoff) {
          // The resumed attempt must still own the same claim and process
          // before validation or PR creation. A replacement/cancelled claim
          // must never be finalised under stale resumption context.
          const resumeOwnership = yield* readOwnership(workItemId);
          const resumeBinding = yield* readAttemptClaimBinding(runEvents, runAttemptId);
          if (
            resumeOwnership === null ||
            !claimBindingMatches(resumeBinding, resumeOwnership, workItemId)
          ) {
            yield* appendEvent(runAttemptId, "execution_hold", {
              workItemId: String(workItemId),
              reason: "claim_binding_unverified",
            });
            return runAttemptId;
          }
          const resumeClosure = yield* resolveStopClosure(resumeOwnership, {
            knownNoSpawn: !(yield* Ref.get(spawnedAttempts)).has(String(runAttemptId)),
          });
          if (resumeClosure.status === "held") {
            yield* runEvents
              .appendOnce(runAttemptId, "execution_hold", {
                workItemId: String(workItemId),
                reason: resumeClosure.reason,
                ...(resumeClosure.detail === undefined ? {} : { detail: resumeClosure.detail }),
                ownerPid: resumeOwnership.ownerPid,
                generation: claimed.generation,
              })
              .pipe(Effect.catch(() => Effect.succeed(false)));
            return runAttemptId;
          }
          yield* runAttempts
            .updateStatus(runAttemptId, "streaming_turn")
            .pipe(Effect.catch(() => Effect.void));
          yield* appendEvent(runAttemptId, "committed_handoff_resumed", {
            branch: workspace.branch,
            previousAttemptId: String(latestAttempt.id),
          });
          yield* finalizer
            .finalize({
              workItem,
              issue,
              runAttemptId,
              config,
              workspacePath: workspace.path,
              branch: workspace.branch,
              baseBranch: workspace.baseBranch,
              ownerToken,
              generation: claimed.generation,
              bodyFileDir,
            })
            .pipe(Effect.catch(() => Effect.void));
          return runAttemptId;
        }
        if (requiresApprovalBeforeEdit(config)) {
          yield* runAttempts
            .updateStatus(runAttemptId, "launching_agent")
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* runAttempts
          .updateStatus(runAttemptId, "streaming_turn")
          .pipe(Effect.catch(() => Effect.void));
        yield* appendEvent(runAttemptId, "agent_started", { branch: workspace.branch });

        // Continuation turns (plan 8.2; audit item 8 lane G): the first turn
        // runs with the full prompt; each continuation turn is a focused
        // follow-up (e.g. fix validation failures, implement review
        // comments), bounded by the workflow's maxTurns.
        const maxTurns = Math.max(1, config.maxTurns ?? WORKFLOW_DEFAULTS.maxTurns);
        let result = yield* agent
          .runTurn({
            issue,
            config,
            workspacePath: workspace.path,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
            runAttemptId,
            workItemId,
            acceptedGuidance,
            ...(reviewFeedback !== undefined ? { reviewFeedback } : {}),
          })
          .pipe(Effect.mapError((cause) => new RunDispatchError(cause.message)));
        for (let turn = 2; turn <= maxTurns && !result.completed; turn++) {
          yield* runAttempts
            .updateStatus(runAttemptId, "streaming_turn")
            .pipe(Effect.catch(() => Effect.void));
          yield* appendEvent(runAttemptId, "continuation_turn", { turn });
          result = yield* agent
            .runTurn({
              issue,
              config,
              workspacePath: workspace.path,
              branch: workspace.branch,
              baseBranch: workspace.baseBranch,
              runAttemptId,
              workItemId,
              acceptedGuidance,
              continuation: true,
            })
            .pipe(Effect.mapError((cause) => new RunDispatchError(cause.message)));
        }

        if (result.completed) {
          // If cancellation (or any terminal write) landed while the turn was
          // in flight, the run is over: do not validate, open a PR or record
          // success (REVIEW P0). The release below keeps the item queued.
          const terminalNow = yield* runAttempts
            .getById(runAttemptId)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (terminalNow !== null && TERMINAL_STATUSES.has(terminalNow.status)) {
            yield* releaseClaim(workItemId, ownerToken, claimed.generation);
            return runAttemptId;
          }
          // Execute/deliver exit (plan 10, WS-L): validate, assemble
          // evidence, create the PR, and land the item in a stopping state.
          yield* finalizer
            .finalize({
              workItem,
              issue,
              runAttemptId,
              config,
              workspacePath: workspace.path,
              branch: workspace.branch,
              baseBranch: workspace.baseBranch,
              ownerToken,
              generation: claimed.generation,
              bodyFileDir,
            })
            .pipe(Effect.catch(() => Effect.void));
        } else {
          yield* markFailed(
            runAttemptId,
            workItemId,
            ownerToken,
            claimed.generation,
            {
              category: "agent",
              message: "turn did not complete",
            },
            maxAttempts,
          );
        }

        return runAttemptId;
      });

      // The dispatch runs as a tracked fiber so cancelRun can interrupt it
      // (REVIEW P0: cancelRun only interrupted the turn, so a cancelled run
      // still validated, opened a PR and overwrote its own status). The
      // ensuring block unregisters the agent, settles live requests and
      // releases the claim when the fiber ends (completion or interruption).
      const fiber = yield* Effect.forkScoped(
        runDispatch.pipe(
          Effect.catch((error) =>
            Effect.logError("symphony.run.failed", {
              runAttemptId: String(runAttemptId),
              workItemId: String(workItemId),
              error: error.message,
            }).pipe(
              Effect.andThen(
                markFailed(
                  runAttemptId,
                  workItemId,
                  ownerToken,
                  claimed.generation,
                  { category: "agent", message: error.message },
                  maxAttempts,
                ),
              ),
              Effect.as(runAttemptId),
            ),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Ref.update(activeAgents, (map) => {
                const next = new Map(map);
                next.delete(String(runAttemptId));
                return next;
              });
              yield* Ref.update(startingRuns, (ids) => {
                const next = new Set(ids);
                next.delete(String(runAttemptId));
                next.delete(String(workItemId));
                return next;
              });
              yield* liveRequests
                .settleRun(runAttemptId, "run finished")
                .pipe(Effect.catch(() => Effect.void));
              // A Stop owns the attempt's terminal status and the claim's
              // release. The fallback `interrupted` write and the unconditional
              // release below are only for runs that ended on their own; running
              // them under a Stop was how an unconfirmed stop became a retry.
              if (yield* isStopping(runAttemptId)) {
                return;
              }
              const attempt = yield* runAttempts
                .getById(runAttemptId)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              const alreadyTerminal = attempt !== null && TERMINAL_STATUSES.has(attempt.status);
              const currentOwnership = yield* readOwnership(workItemId);
              const itemHeld =
                currentOwnership !== null && ACTIVE_LIFECYCLES.has(currentOwnership.lifecycle);
              // Nothing to release or retry once the attempt has settled and
              // the item has left the active lifecycles.
              if (alreadyTerminal && !itemHeld) {
                return;
              }
              const ownershipUnverified =
                (yield* Ref.get(ownershipFailures)).has(String(runAttemptId)) ||
                (yield* hasOwnershipFailureEvent(runEvents, runAttemptId));
              if (ownershipUnverified) {
                yield* runEvents
                  .appendOnce(runAttemptId, "execution_hold", {
                    workItemId: String(workItemId),
                    reason: "ownership_unverified",
                    ownerPid: currentOwnership?.ownerPid ?? null,
                    generation: claimed.generation,
                  })
                  .pipe(Effect.catch(() => Effect.succeed(false)));
                return;
              }
              const binding = yield* readAttemptClaimBinding(runEvents, runAttemptId);
              if (
                currentOwnership === null ||
                currentOwnership.ownerToken !== ownerToken ||
                currentOwnership.generation !== claimed.generation ||
                !claimBindingMatches(binding, currentOwnership, workItemId)
              ) {
                // A replacement claim owns the item, or this attempt has no
                // exact durable binding: this fiber's stale cleanup must not
                // release or retry it.
                yield* appendEvent(runAttemptId, "execution_hold", {
                  workItemId: String(workItemId),
                  reason: "claim_binding_unverified",
                });
                return;
              }
              const cleanupFence = toFence(currentOwnership);
              if (cleanupFence === null) {
                return;
              }
              // The runtime child is scoped to the outer dispatch scope, so
              // this fiber ending is not proof that the process or its group
              // exited. Preserve unknown ownership instead of queueing it.
              const spawnObserved = (yield* Ref.get(spawnedAttempts)).has(String(runAttemptId));
              const ownership = yield* resolveStopClosure(currentOwnership, {
                knownNoSpawn: !spawnObserved,
              });
              if (ownership.status === "held") {
                yield* runEvents
                  .appendOnce(runAttemptId, "execution_hold", {
                    workItemId: String(workItemId),
                    reason: ownership.reason,
                    ...(ownership.detail === undefined ? {} : { detail: ownership.detail }),
                    ownerPid: currentOwnership.ownerPid,
                    generation: claimed.generation,
                  })
                  .pipe(Effect.catch(() => Effect.succeed(false)));
                return;
              }
              if (!alreadyTerminal) {
                yield* runAttempts
                  .updateStatus(runAttemptId, "interrupted", {
                    finishedAt: yield* nowIso,
                    error: {
                      category: "interrupted",
                      message: "run ended without a terminal status",
                    },
                  })
                  .pipe(Effect.catch(() => Effect.void));
                yield* appendEvent(runAttemptId, "interrupted", {});
              }
              yield* workItems
                .releaseClaim(workItemId, "queued", cleanupFence)
                .pipe(Effect.catch(() => Effect.void));
            }),
          ),
        ),
      );
      yield* Ref.update(activeAgents, (map) =>
        new Map(map).set(String(runAttemptId), { agent, fiber }),
      );
      yield* Ref.update(startingRuns, (ids) => {
        const next = new Set(ids);
        next.delete(String(runAttemptId));
        next.delete(String(workItemId));
        return next;
      });
      // Join the fiber; interruption (cancelRun) surfaces as an Exit, which
      // we fold back to the run id so the caller sees a settled dispatch.
      return yield* Fiber.join(fiber).pipe(Effect.catch(() => Effect.succeed(runAttemptId)));
    });

  const cancelAttempt = (
    runAttemptId: RunAttemptId,
    eventPayload: Record<string, unknown>,
  ): Effect.Effect<StopOutcome> =>
    Effect.gen(function* () {
      const key = String(runAttemptId);
      const clearMarker = Ref.update(stoppingAttempts, (ids) => {
        const next = new Set(ids);
        next.delete(key);
        return next;
      });
      // The marker blocks a concurrently unwinding failure from scheduling a
      // retry. It is NOT a one-shot guard: a repeated Stop re-checks closure
      // and never silently returns while a Stop is genuinely pending.
      yield* Ref.update(stoppingAttempts, (ids) => new Set(ids).add(key));
      const held = (reason: string, detail?: string): StopOutcome => ({
        status: "held",
        runAttemptId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      });
      const settleUnconfirmed = (
        reason: string,
        detail: string | undefined,
        ownership: ClaimOwnership | null,
      ) =>
        Effect.gen(function* () {
          yield* appendEvent(runAttemptId, "stop_unconfirmed", {
            ...eventPayload,
            workItemId: attemptWorkItemId,
            reason,
            ...(detail === undefined ? {} : { detail }),
            ownerPid: ownership?.ownerPid ?? null,
            generation: ownership?.generation ?? null,
          });
          yield* liveRequests
            .settleRun(runAttemptId, "stop unconfirmed")
            .pipe(Effect.catch(() => Effect.void));
          return held(reason, detail);
        });

      const attemptProbe = yield* Effect.result(runAttempts.getById(runAttemptId));
      if (attemptProbe._tag === "Failure") {
        return held("attempt_unreadable");
      }
      const attempt = attemptProbe.success;
      if (attempt === null) {
        yield* clearMarker;
        return held("attempt_not_found");
      }
      const attemptWorkItemId = String(attempt.workItemId);
      // Exact attempt fence: a Stop for a historical attempt must never
      // target the replacement attempt's claim or process.
      const latestProbe = yield* Effect.result(runAttempts.latestForWorkItem(attempt.workItemId));
      if (latestProbe._tag === "Failure") {
        return held("attempt_unreadable");
      }
      const latest = latestProbe.success;
      if (latest === null || latest.id !== runAttemptId) {
        yield* clearMarker;
        return held("stale_attempt");
      }
      if (
        TERMINAL_STATUSES.has(attempt.status) &&
        attempt.status !== "user_cancelled" &&
        attempt.status !== "tracker_cancelled"
      ) {
        yield* clearMarker;
        return held("attempt_terminal", `attempt is already ${attempt.status}`);
      }

      // One atomic read of fence + identity. Nothing below may pair a fence
      // with a different row's identity.
      const ownershipProbe = yield* Effect.result(workItems.getClaimOwnership(attempt.workItemId));
      if (ownershipProbe._tag === "Failure" || ownershipProbe.success === null) {
        return held("claim_unreadable");
      }
      const ownershipBefore = ownershipProbe.success;

      // Durable Stop acceptance must succeed before any interruption. A failed
      // write is not accepted and must never be acknowledged as a stop.
      const intentRecorded = yield* runEvents
        .append(runAttemptId, "stop_requested", {
          ...eventPayload,
          workItemId: attemptWorkItemId,
          ownerPid: ownershipBefore.ownerPid,
          generation: ownershipBefore.generation,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      if (!intentRecorded) {
        return held("stop_intent_unpersisted");
      }

      if ((yield* Ref.get(startingRuns)).has(key)) {
        // The dispatch is still preparing/registering. Hold until it is
        // registered; the durable intent keeps a later tick from retrying.
        return held("dispatch_not_registered");
      }

      if (ownershipBefore.ownerToken === null) {
        yield* clearMarker;
        // No live claim. Only exact durable stop confirmation may back an
        // idempotent confirmed response; legacy cancellation alone is unknown.
        if (attempt.status === "user_cancelled") {
          const confirmation = yield* readStopConfirmation(runEvents, runAttemptId);
          if (confirmation !== null) {
            return {
              status: "confirmed",
              runAttemptId,
              evidence: confirmation.evidence,
              released: false,
              ...(confirmation.generation === null
                ? {}
                : { releasedGeneration: confirmation.generation }),
            };
          }
        }
        return held("stop_not_confirmed");
      }
      const fenceBefore = toFence(ownershipBefore);
      if (fenceBefore === null) {
        return held("claim_unreadable");
      }
      // Positive association is the exact durable binding for this attempt,
      // not timestamp order: a replacement claim can share the same
      // millisecond as the previous attempt.
      const binding = yield* readAttemptClaimBinding(runEvents, runAttemptId);
      if (!claimBindingMatches(binding, ownershipBefore, attempt.workItemId)) {
        return yield* settleUnconfirmed(
          "claim_binding_unverified",
          "this attempt has no exact issue_claimed binding for the current claim generation",
          ownershipBefore,
        );
      }

      // Stop the live run before deciding closure: interrupting the fiber is
      // what ends our tracking, and closure must be observed after that point.
      const registered = (yield* Ref.get(activeAgents)).get(key);
      let trackedExit = true;
      if (registered !== undefined) {
        registered.fiber.interruptUnsafe();
        yield* registered.agent.interrupt().pipe(Effect.catch(() => Effect.void));
        const exited = yield* Fiber.await(registered.fiber).pipe(
          Effect.timeoutOption(STOP_FIBER_EXIT_TIMEOUT),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
        trackedExit = Option.isSome(exited);
      }

      // Re-read the same row after tracking settles. The earlier snapshot is
      // not closure evidence: a lazy spawn can record a pid and a replacement
      // claim can take the row.
      const ownershipAfter = yield* readOwnership(attempt.workItemId);
      const claimStoppable =
        ownershipAfter !== null && STOP_SOURCE_LIFECYCLES.has(ownershipAfter.lifecycle);
      const closure: ProcessClosureResult | { status: "held"; reason: string; detail?: string } =
        !trackedExit
          ? { status: "held", reason: "dispatch_not_exited" }
          : ownershipAfter === null || !ownershipMatches(ownershipBefore, ownershipAfter)
            ? { status: "held", reason: "claim_changed" }
            : !claimStoppable
              ? { status: "held", reason: "claim_not_stoppable" }
              : yield* resolveStopClosure(ownershipAfter, {
                  knownNoSpawn: !(yield* Ref.get(spawnedAttempts)).has(key),
                });

      if (closure.status === "held") {
        // Unconfirmed closure: retain the claim, lease and lifecycle. The
        // marker stays set so no failure path can turn this into a retry.
        return yield* settleUnconfirmed(
          closure.reason,
          closure.detail,
          ownershipAfter ?? ownershipBefore,
        );
      }

      // Positive closure: release only the exact captured claim identity.
      const released = yield* workItems
        .releaseConfirmedStop(attempt.workItemId, fenceBefore)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!released) {
        return yield* settleUnconfirmed("claim_changed", undefined, ownershipAfter);
      }

      yield* runAttempts
        .updateStatus(runAttemptId, "user_cancelled", { finishedAt: yield* nowIso })
        .pipe(Effect.catch(() => Effect.void));
      const settled = yield* runAttempts
        .getById(runAttemptId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const releasedGeneration = fenceBefore.generation + 1;
      yield* appendEvent(runAttemptId, "stop_confirmed", {
        ...eventPayload,
        workItemId: attemptWorkItemId,
        closure: closure.evidence,
        released,
        generation: releasedGeneration,
      });
      if (settled?.status === "user_cancelled") {
        yield* appendEvent(runAttemptId, "user_cancelled", eventPayload);
      }
      yield* clearMarker;
      yield* liveRequests
        .settleRun(runAttemptId, "user cancelled")
        .pipe(Effect.catch(() => Effect.void));
      return {
        status: "confirmed",
        runAttemptId,
        evidence: closure.evidence,
        released,
        releasedGeneration,
      };
    });

  const cancelRun: RunDispatcherService["cancelRun"] = (runAttemptId) =>
    cancelAttempt(runAttemptId, {});

  const isAgentActive: RunDispatcherService["isAgentActive"] = (runAttemptId) =>
    Effect.gen(function* () {
      const key = String(runAttemptId);
      const active = (yield* Ref.get(activeAgents)).has(key);
      if (active) return true;
      // A Stop whose closure is still unconfirmed keeps the run alive for
      // scheduling purposes: reconciliation must not treat the interrupted
      // fiber's removal from activeAgents as process closure.
      return (yield* Ref.get(stoppingAttempts)).has(key);
    });

  const stopAllRuns: RunDispatcherService["stopAllRuns"] = () =>
    Effect.gen(function* () {
      const map = yield* Ref.get(activeAgents);
      let confirmed = 0;
      let held = 0;
      for (const [attemptId] of map) {
        const outcome = yield* cancelAttempt(RunAttemptId.make(attemptId), {
          reason: "stop_all_runs",
        });
        if (outcome.status === "confirmed") confirmed += 1;
        else held += 1;
      }
      return { confirmed, held };
    });

  return { dispatchWorkItem, cancelRun, isAgentActive, stopAllRuns };
});

export const RunDispatcherLive: Layer.Layer<
  RunDispatcher,
  never,
  | Crypto.Crypto
  | LiveRequests
  | RunEventRepository
  | RunAttemptRepository
  | WorkItemRepository
  | WorkspaceManager
  | AgentRuntimeFactory
  | ExecutionFinalizer
> = Layer.effect(RunDispatcher, makeRunDispatcher);
