import type {
  EffectiveWorkflowConfig,
  NormalizedIssue,
  WorkItem,
  WorkItemId,
} from "@neokod/contracts";
import { RunAttemptId } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { nowIso } from "../Domain/Time.ts";
import { WORKFLOW_DEFAULTS } from "../Workflow/Config.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { WorkspaceManager, type SymphonyWorkspace } from "../Workspaces/Manager.ts";
import type { AgentRuntimeService } from "./AgentRuntime.ts";
import { ExecutionFinalizer } from "./ExecutionFinalizer.ts";
import { LiveRequests } from "./LiveRequests.ts";
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

export interface RunDispatcherService {
  /** Claim + prepare + run one work item. Returns the created run attempt id. */
  readonly dispatchWorkItem: (input: {
    readonly workItem: WorkItem;
    readonly issue: NormalizedIssue;
    readonly config: EffectiveWorkflowConfig;
  }) => Effect.Effect<RunAttemptId, RunDispatchError, Scope.Scope>;

  readonly cancelRun: (runAttemptId: RunAttemptId) => Effect.Effect<void, RunDispatchError>;

  /** True while a live agent is registered for the run (reconciliation input). */
  readonly isAgentActive: (runAttemptId: RunAttemptId) => Effect.Effect<boolean>;

  /** Cancel every live run and return how many were interrupted (FR-134). */
  readonly stopAllRuns: () => Effect.Effect<number, RunDispatchError>;
}

export class RunDispatcher extends Context.Service<RunDispatcher, RunDispatcherService>()(
  "neokod/symphony/Runner/RunDispatcher",
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
    ) => Effect.Effect<AgentRuntimeService, never, Scope.Scope>;
  }
>()("neokod/symphony/Runner/AgentRuntimeFactory") {}

export const makeRunDispatcher = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const workItems = yield* WorkItemRepository;
  const runAttempts = yield* RunAttemptRepository;
  const runEvents = yield* RunEventRepository;
  const workspaces = yield* WorkspaceManager;
  const factory = yield* AgentRuntimeFactory;
  const liveRequests = yield* LiveRequests;
  const finalizer = yield* ExecutionFinalizer;

  // Live agents per run attempt plus the dispatch fiber, so cancellation can
  // interrupt the active turn AND the fiber driving it (plan 8.3.1; REVIEW P0
  // "cancelRun never stops the dispatch fiber").
  const activeAgents = yield* Ref.make<
    Map<
      string,
      { readonly agent: AgentRuntimeService; readonly fiber: Fiber.Fiber<unknown, unknown> }
    >
  >(new Map());

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
  // remain (plan 9.5, WS-M), otherwise to `queued` so a manual re-dispatch
  // stays possible.
  const markFailed = (
    runAttemptId: RunAttemptId,
    workItemId: WorkItemId,
    ownerToken: string,
    generation: number,
    error: { readonly category: string; readonly message: string },
    maxAttempts: number,
  ) =>
    Effect.gen(function* () {
      const attempt = yield* runAttempts
        .getById(runAttemptId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
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
        yield* releaseClaim(workItemId, ownerToken, generation);
      }
    });

  const dispatchWorkItem: RunDispatcherService["dispatchWorkItem"] = (input) =>
    Effect.gen(function* () {
      const { workItem, issue, config } = input;
      const maxAttempts = config.maxAttempts ?? 5;
      const ownerToken = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => new RunDispatchError("failed to generate owner token")),
      );

      // 1. Claim transactionally (eligible -> preparing), fencing owner/generation.
      const claimed = yield* workItems
        .claim(workItem.id, ownerToken)
        .pipe(Effect.mapError((cause) => new RunDispatchError(cause.message)));
      const workItemId: WorkItemId = claimed.workItem.id;

      // 2. Workspace: deterministic worktree under the configured root. If
      //    workspace creation fails, release the claim back to queued.
      const workspace: SymphonyWorkspace = yield* workspaces
        .ensureWorkspace({ issue, config })
        .pipe(
          Effect.mapError((cause) => new RunDispatchError(cause.message)),
          Effect.tapError(() => releaseClaim(workItemId, ownerToken, claimed.generation)),
        );

      // 3. Record the run attempt. Retries continue the attempt sequence so
      //    the backoff and the max-attempts cap read the right number.
      const runAttemptId = yield* makeRunAttemptId();
      const startedAt = yield* nowIso;
      const latestAttempt = yield* runAttempts
        .latestForWorkItem(workItemId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const attemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;
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
        })
        .pipe(
          Effect.mapError((cause) => new RunDispatchError(cause.message)),
          // A failure after claiming but before the first attempt row exists
          // leaves the item in `preparing` with no attempt for recovery to
          // see (REVIEW P1 #10). Release the claim so the item can be
          // re-dispatched.
          Effect.tapError(() => releaseClaim(workItemId, ownerToken, claimed.generation)),
        );
      yield* appendEvent(runAttemptId, "issue_claimed", { workItemId: String(workItemId) });
      yield* appendEvent(runAttemptId, "workspace_created", {
        path: workspace.path,
        branch: workspace.branch,
      });

      const policy = resolveRunnerPolicy(config);
      // The agent runtime is per-config; build it in the dispatch scope.
      const agent = yield* factory.make(config);
      // Record the agent child PID on the claim so recovery can terminate a
      // surviving orphan after a crash (audit item 3; plan 8.1). Best-effort:
      // the PID may not exist yet (lazy spawn) and the fence may have moved.
      yield* agent
        .pid()
        .pipe(
          Effect.flatMap((pid) =>
            pid === null
              ? Effect.void
              : workItems
                  .setClaimOwnerPid(workItemId, ownerToken, claimed.generation, pid)
                  .pipe(Effect.catch(() => Effect.void)),
          ),
        );
      // PR body files land under the server's symphony logs dir when
      // available; otherwise the system temp dir (REVIEW P0: the body file
      // was never written and the path resolved to the filesystem root).
      const maybeConfig = yield* Effect.serviceOption(ServerConfig);
      const bodyFileDir = Option.isSome(maybeConfig)
        ? `${maybeConfig.value.symphonyLogsDir}/pr-bodies`
        : require("node:os").tmpdir();

      const runDispatch = Effect.gen(function* () {
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
              runAttemptId,
              workItemId,
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
            runAttemptId,
            workItemId,
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
              runAttemptId,
              workItemId,
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
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Ref.update(activeAgents, (map) => {
                const next = new Map(map);
                next.delete(String(runAttemptId));
                return next;
              });
              yield* liveRequests
                .settleRun(runAttemptId, "run finished")
                .pipe(Effect.catch(() => Effect.void));
              const attempt = yield* runAttempts
                .getById(runAttemptId)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              const alreadyTerminal = attempt !== null && TERMINAL_STATUSES.has(attempt.status);
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
                .releaseClaim(workItemId, "queued")
                .pipe(Effect.catch(() => Effect.void));
            }),
          ),
        ),
      );
      yield* Ref.update(activeAgents, (map) =>
        new Map(map).set(String(runAttemptId), { agent, fiber }),
      );
      // Join the fiber; interruption (cancelRun) surfaces as an Exit, which
      // we fold back to the run id so the caller sees a settled dispatch.
      return yield* Fiber.join(fiber).pipe(Effect.catch(() => Effect.succeed(runAttemptId)));
    });

  const cancelRun: RunDispatcherService["cancelRun"] = (runAttemptId) =>
    Effect.gen(function* () {
      // Interrupt the active turn AND the dispatch fiber driving it, settle
      // the run's outstanding approval/input requests (idempotent), and
      // record the durable cancellation. The claim is released by the
      // interrupted dispatch path's ensuring block, which keeps the work item
      // queued (REVIEW P0: without the fiber interrupt, a cancelled run still
      // validated, opened a PR and overwrote its own status).
      const registered = yield* Ref.get(activeAgents).pipe(
        Effect.map((map) => map.get(String(runAttemptId))),
      );
      if (registered !== undefined) {
        // Interrupt the dispatch fiber FIRST (fix-lane item 6): awaiting
        // agent.interrupt() before the fiber interrupt gave markFailed a
        // window to land retry_scheduled mid-cancel. Use the raw interrupt
        // (no await): awaiting an interrupted fiber surfaces its pure
        // interruption cause as an error.
        registered.fiber.interruptUnsafe();
        yield* registered.agent.interrupt().pipe(Effect.catch(() => Effect.void));
      }
      yield* liveRequests
        .settleRun(runAttemptId, "user cancelled")
        .pipe(Effect.catch(() => Effect.void));
      yield* runAttempts
        .updateStatus(runAttemptId, "user_cancelled", { finishedAt: yield* nowIso })
        .pipe(Effect.catch(() => Effect.void));
      yield* appendEvent(runAttemptId, "user_cancelled", {});
    });

  const isAgentActive: RunDispatcherService["isAgentActive"] = (runAttemptId) =>
    Ref.get(activeAgents).pipe(Effect.map((map) => map.has(String(runAttemptId))));

  const stopAllRuns: RunDispatcherService["stopAllRuns"] = () =>
    Effect.gen(function* () {
      const map = yield* Ref.get(activeAgents);
      let stopped = 0;
      for (const [attemptId, registered] of map) {
        registered.fiber.interruptUnsafe();
        yield* registered.agent.interrupt().pipe(Effect.catch(() => Effect.void));
        yield* liveRequests
          .settleRun(RunAttemptId.make(attemptId), "stopped by stop-all")
          .pipe(Effect.catch(() => Effect.void));
        yield* runAttempts
          .updateStatus(RunAttemptId.make(attemptId), "user_cancelled", {
            finishedAt: yield* nowIso,
          })
          .pipe(Effect.catch(() => Effect.void));
        yield* appendEvent(RunAttemptId.make(attemptId), "user_cancelled", {
          reason: "stop_all_runs",
        });
        stopped += 1;
      }
      return stopped;
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
