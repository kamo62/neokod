import type { WorkItem, WorkItemId, WorkflowRecord } from "@neokod/contracts";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  ProjectId,
  RunAttemptId,
  ThreadId,
  WorkItemId as WorkItemIdBrand,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nowIso } from "./Domain/Time.ts";
import { WorkItemRepository } from "./Persistence/Services/WorkItemRepository.ts";
import { RunAttemptRepository } from "./Persistence/Services/RunAttemptRepository.ts";
import { RunEventRepository } from "./Persistence/Services/RunEventRepository.ts";
import { WorkflowRepository } from "./Persistence/Services/WorkflowRepository.ts";
import { WorkspaceOwnershipRepository } from "./Persistence/Services/WorkspaceOwnershipRepository.ts";
import { RunDispatcher } from "./Runner/Dispatcher.ts";
import { LiveRequests } from "./Runner/LiveRequests.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Cross-mode handoff service (plan 16, Phase 4; PRD FR-110 to FR-115).
 *
 * Maps Symphony work items to Work-mode threads and back, guarded by the
 * persisted workspace-ownership record (plan 16.0):
 *
 * - `takeOver`: stop the Symphony worker (cancel the run, settle every
 *   outstanding protocol request), transfer workspace ownership to `work`,
 *   and park the work item so the orchestrator does not re-dispatch while
 *   Work mode owns the workspace. The workspace path is carried across, so a
 *   Work thread bound to it points at the same filesystem (FR-112/113,
 *   FR-115).
 * - `resumeAutonomous`: transfer ownership back to `symphony` and re-queue
 *   the work item so the orchestrator re-dispatches it (FR-114).
 * - `delegateFromThread`: create a Symphony work item from a Work thread
 *   (FR-110/111).
 *
 * All ownership transitions are fenced by generation: a stale holder cannot
 * reclaim a workspace that moved on.
 */

export class HandoffError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Symphony handoff failed: ${detail}`);
    this.name = "HandoffError";
    this.detail = detail;
  }
}

export interface TakeOverResult {
  readonly threadId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly workItemId: WorkItemId;
}

export class HandoffService extends Context.Service<
  HandoffService,
  {
    readonly takeOver: (input: {
      readonly runAttemptId: string;
      readonly threadId?: string;
    }) => Effect.Effect<TakeOverResult, HandoffError>;

    readonly resumeAutonomous: (input: {
      readonly workItemId: string;
    }) => Effect.Effect<void, HandoffError>;

    readonly delegateFromThread: (input: {
      readonly threadId: string;
      readonly objective: string;
      readonly repositoryPath?: string;
      readonly branch?: string;
      readonly relevantFiles?: ReadonlyArray<string>;
      readonly summary?: string;
      readonly acceptanceCriteria?: ReadonlyArray<string>;
    }) => Effect.Effect<WorkItemId, HandoffError>;
  }
>()("neokod/symphony/HandoffService") {}

export const makeHandoffService = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const workItems = yield* WorkItemRepository;
  const runAttempts = yield* RunAttemptRepository;
  const runEvents = yield* RunEventRepository;
  const workflows = yield* WorkflowRepository;
  const ownership = yield* WorkspaceOwnershipRepository;
  const dispatcher = yield* RunDispatcher;
  const liveRequests = yield* LiveRequests;
  // Optional orchestration services (serviceOption): when the Work-mode
  // orchestration stack is mounted, takeOver binds a real Work thread to the
  // workspace. Without it, takeOver degrades to ownership transfer only.
  const maybeEngine = yield* Effect.serviceOption(OrchestrationEngine.OrchestrationEngineService);
  const maybeProjection = yield* Effect.serviceOption(
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  );

  const appendEvent = (
    runAttemptId: RunAttemptId,
    eventType: string,
    payload?: Record<string, unknown>,
  ) => runEvents.append(runAttemptId, eventType, payload).pipe(Effect.catch(() => Effect.void));

  /** Create (or reuse) a Work-mode thread bound to the workspace (FR-112/113,
   *  FR-115). The thread's worktreePath is the Symphony workspace, so the
   *  environment panel, terminal, files and diff all point at the same
   *  filesystem. */
  const bindWorkThread = (input: {
    readonly runAttemptId: RunAttemptId;
    readonly workspacePath: string;
    readonly branch: string;
    readonly title: string;
    readonly callerThreadId?: string;
  }): Effect.Effect<string, HandoffError> =>
    Effect.gen(function* () {
      const engine = Option.getOrNull(maybeEngine);
      const projection = Option.getOrNull(maybeProjection);
      // Reuse an existing thread when the caller bound one — but only when we
      // can verify it (REVIEW P1: an unvalidated caller threadId produced a
      // phantom `work` owner that held the workspace forever). When the
      // projection is unavailable the caller thread cannot be verified, so it
      // is ignored rather than trusted.
      if (input.callerThreadId !== undefined && input.callerThreadId.length > 0) {
        if (projection === null) {
          return yield* Effect.fail(
            new HandoffError(
              "caller-supplied threadId cannot be verified without the projection layer",
            ),
          );
        }
        const shell = yield* projection
          .getThreadShellById(ThreadId.make(input.callerThreadId))
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        if (Option.isSome(shell) && shell.value.worktreePath === input.workspacePath) {
          return input.callerThreadId;
        }
        return yield* Effect.fail(
          new HandoffError(
            `caller-supplied thread ${input.callerThreadId} does not exist or is not bound to ${input.workspacePath}`,
          ),
        );
      }
      if (engine === null || projection === null) {
        // No orchestration stack: generate a placeholder thread id; the
        // ownership record still carries it for resume.
        return yield* crypto.randomUUIDv4.pipe(
          Effect.map((value) => `work-thread-${value}`),
          Effect.mapError((cause) => new HandoffError(cause.message)),
        );
      }

      // Resolve (or lazily create) the project for the workspace root.
      const existing = yield* projection
        .getActiveProjectByWorkspaceRoot(input.workspacePath)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      let projectId: ProjectId;
      if (Option.isSome(existing)) {
        projectId = existing.value.id;
      } else {
        projectId = yield* crypto.randomUUIDv4.pipe(
          Effect.map((value) => ProjectId.make(value)),
          Effect.mapError((cause) => new HandoffError(cause.message)),
        );
        yield* engine
          .dispatch({
            type: "project.create",
            commandId: yield* crypto.randomUUIDv4.pipe(
              Effect.map((value) => CommandId.make(value)),
              Effect.mapError((cause) => new HandoffError(cause.message)),
            ),
            projectId,
            title: input.title,
            workspaceRoot: input.workspacePath,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            createdAt: yield* nowIso,
          })
          .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
      }

      const threadId = yield* crypto.randomUUIDv4.pipe(
        Effect.map((value) => ThreadId.make(value)),
        Effect.mapError((cause) => new HandoffError(cause.message)),
      );
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* crypto.randomUUIDv4.pipe(
            Effect.map((value) => CommandId.make(value)),
            Effect.mapError((cause) => new HandoffError(cause.message)),
          ),
          threadId,
          projectId,
          title: input.title,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: input.branch,
          worktreePath: input.workspacePath,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
      return String(threadId);
    });

  const takeOver: HandoffService["Service"]["takeOver"] = (input) =>
    Effect.gen(function* () {
      const runAttemptId = RunAttemptId.make(input.runAttemptId);
      const attempt = yield* runAttempts
        .getById(runAttemptId)
        .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
      if (attempt === null) {
        return yield* Effect.fail(new HandoffError("run attempt not found"));
      }

      // Only the CURRENT attempt may be taken over: cancelling an older
      // attempt while a newer one is active would stop the wrong run
      // (REVIEW P1 #2).
      const latest = yield* runAttempts
        .latestForWorkItem(attempt.workItemId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (latest === null || latest.id !== attempt.id) {
        return yield* Effect.fail(
          new HandoffError(
            "run attempt is not the current attempt for its work item; takeover aborted",
          ),
        );
      }

      // 1. Stop the worker: cancel the run (interrupts the turn, settles the
      //    run's live requests, records the durable status).
      yield* dispatcher
        .cancelRun(runAttemptId)
        .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
      yield* liveRequests
        .settleRun(runAttemptId, "handed over to work mode")
        .pipe(Effect.catch(() => Effect.void));

      // 2. Bind (or reuse) the Work thread for this workspace. The thread's
      //    worktreePath is the Symphony workspace, so the same filesystem is
      //    visible in Work mode (FR-112/113, FR-115).
      const workItem = yield* workItems
        .getById(attempt.workItemId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const branch = deriveThreadBranch(attempt.workspacePath, workItem?.workspaceKey);
      const threadId = yield* bindWorkThread({
        runAttemptId,
        workspacePath: attempt.workspacePath,
        branch,
        title: workItem?.objective ?? `Symphony run ${String(runAttemptId)}`,
        ...(input.threadId !== undefined && input.threadId.length > 0
          ? { callerThreadId: input.threadId }
          : {}),
      });

      // 3. Park the work item BEFORE ownership moves (REVIEW P0: the park was
      //    last, unfenced and swallowed, so the still-running dispatch fiber
      //    could overwrite `blocked` and re-dispatch into a Work-owned
      //    workspace). Source-restricted to non-terminal lifecycles (cancelRun
      //    releases the claim to queued first), and the boolean result is
      //    checked — a terminal item can never be parked back into the pool.
      const parked = yield* workItems
        .transition(attempt.workItemId, "blocked", {
          from: [
            "draft",
            "eligible",
            "queued",
            "preparing",
            "running",
            "waiting_for_approval",
            "retry_scheduled",
          ],
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!parked) {
        return yield* Effect.fail(
          new HandoffError(
            "work item is in a terminal lifecycle; takeover aborted before ownership transfer",
          ),
        );
      }

      // 4. Transfer workspace ownership to work. Fenced by generation when a
      //    record exists; otherwise acquire (only when no live other owner).
      const held = yield* ownership
        .getByWorkspacePath(attempt.workspacePath)
        .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));

      if (held === null) {
        yield* ownership
          .acquire({
            workspacePath: attempt.workspacePath,
            owner: "work",
            threadId,
            workItemId: attempt.workItemId,
          })
          .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
      } else if (held.owner === "symphony") {
        const transferred = yield* ownership
          .transfer({
            workspacePath: attempt.workspacePath,
            owner: "work",
            threadId,
            workItemId: attempt.workItemId,
            generation: held.generation,
          })
          .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
        if (transferred === null) {
          return yield* Effect.fail(
            new HandoffError("workspace ownership fence miss during takeover"),
          );
        }
      } else {
        return yield* Effect.fail(new HandoffError("workspace is held by another owner"));
      }

      yield* appendEvent(runAttemptId, "handed_over_to_work", {
        threadId,
        workspacePath: attempt.workspacePath,
      });

      return {
        threadId,
        workspacePath: attempt.workspacePath,
        branch,
        workItemId: attempt.workItemId,
      } satisfies TakeOverResult;
    });

  const resumeAutonomous: HandoffService["Service"]["resumeAutonomous"] = (input) =>
    Effect.gen(function* () {
      const workItem = yield* workItems
        .getById(WorkItemIdBrand.make(input.workItemId))
        .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
      if (workItem === null) {
        return yield* Effect.fail(new HandoffError("work item not found"));
      }

      // Resolve the workspace from the ownership record (source of truth);
      // a work item without any recorded workspace cannot resume a run.
      // Prefer the record matching the item's stored workspacePath so a
      // workspace key change across attempts does not transfer the wrong
      // workspace (REVIEW P2: records[0] depended on row order).
      const records = yield* ownershipListByWorkItem(workItem.id).pipe(
        Effect.catch(() => Effect.succeed([])),
      );
      const held =
        records.find((record) => record.workspacePath === workItem.workspacePath) ??
        records[0] ??
        null;
      if (held === null) {
        return yield* Effect.fail(
          new HandoffError("no workspace ownership record for the work item"),
        );
      }

      // Transfer ownership back to symphony, preserving the Work thread
      // binding so a later takeOver reuses it instead of creating a duplicate
      // (REVIEW P2: the transfer omitted threadId and wiped the binding).
      if (held.owner === "work") {
        const transferred = yield* ownership
          .transfer({
            workspacePath: held.workspacePath,
            owner: "symphony",
            workItemId: workItem.id,
            generation: held.generation,
            ...(held.threadId !== null ? { threadId: held.threadId } : {}),
          })
          .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
        if (transferred === null) {
          return yield* Effect.fail(
            new HandoffError("workspace ownership fence miss during resume"),
          );
        }
      }

      const requeued = yield* workItems
        .transition(workItem.id, "queued", {
          from: [
            "blocked",
            "ready_for_review",
            "retry_scheduled",
            "waiting_for_approval",
            "running",
          ],
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!requeued) {
        return yield* Effect.fail(
          new HandoffError(
            "work item is not in a resumable lifecycle; ownership stayed with symphony but the item was not re-queued",
          ),
        );
      }
      const latest = yield* runAttempts
        .latestForWorkItem(workItem.id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (latest !== null) {
        yield* appendEvent(latest.id, "resumed_from_work", {
          workItemId: String(workItem.id),
        });
      }
    });

  const delegateFromThread: HandoffService["Service"]["delegateFromThread"] = (input) =>
    Effect.gen(function* () {
      // Validate the source thread exists when the projection is available;
      // an unverifiable thread is rejected rather than trusted (REVIEW P2:
      // threadId was accepted and then ignored).
      const projection = Option.getOrNull(maybeProjection);
      if (projection !== null) {
        const shell = yield* projection
          .getThreadShellById(ThreadId.make(input.threadId))
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        if (Option.isNone(shell)) {
          return yield* Effect.fail(new HandoffError(`thread ${input.threadId} does not exist`));
        }
      }

      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.map((value) => WorkItemIdBrand.make(`wi-${value}`)),
        Effect.mapError((cause) => new HandoffError(cause.message)),
      );
      const now = yield* nowIso;
      const workflow = yield* resolveWorkflowForDelegate(input.repositoryPath).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const workItem: WorkItem = {
        id,
        mode: "symphony",
        ...(input.repositoryPath !== undefined ? { repositoryPath: input.repositoryPath } : {}),
        ...(workflow !== null ? { workflowId: workflow.id } : {}),
        objective: input.objective,
        ...(input.summary !== undefined ? { description: input.summary } : {}),
        ...(input.relevantFiles !== undefined && input.relevantFiles.length > 0
          ? {
              description:
                `${input.summary ?? ""}\n\nRelevant files:\n${input.relevantFiles.map((file) => `- ${file}`).join("\n")}`.trim(),
            }
          : {}),
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        source: { kind: "manual" },
        trackerIssueId: `delegated-${id}`,
        lifecycle: "eligible",
        ...(input.branch !== undefined ? { baseBranch: input.branch } : {}),
        eligibilityReasons: [],
        evidence: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* workItems
        .upsert(workItem)
        .pipe(Effect.mapError((cause) => new HandoffError(cause.message)));
      return id;
    });

  const ownershipListByWorkItem = (
    workItemId: WorkItemId,
  ): Effect.Effect<
    ReadonlyArray<{
      workspacePath: string;
      owner: "symphony" | "work";
      generation: number;
      threadId: string | null;
    }>,
    never
  > =>
    // The ownership table is keyed by workspace path; resolve through the
    // work item's stored workspace path first, then fall back to scanning via
    // the run attempts.
    Effect.gen(function* () {
      const runAttemptsForItem = yield* runAttempts
        .listByWorkItem(workItemId)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const paths = new Set<string>();
      for (const attempt of runAttemptsForItem) {
        paths.add(attempt.workspacePath);
      }
      const records: Array<{
        workspacePath: string;
        owner: "symphony" | "work";
        generation: number;
        threadId: string | null;
      }> = [];
      for (const workspacePath of paths) {
        const record = yield* ownership
          .getByWorkspacePath(workspacePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (record !== null) {
          records.push({
            workspacePath: record.workspacePath,
            owner: record.owner,
            generation: record.generation,
            threadId: record.threadId,
          });
        }
      }
      return records;
    });

  const resolveWorkflowForDelegate = (
    repositoryPath: string | undefined,
  ): Effect.Effect<WorkflowRecord | null, never> =>
    Effect.gen(function* () {
      if (repositoryPath === undefined) {
        return null;
      }
      const all = yield* workflows.list().pipe(Effect.catch(() => Effect.succeed([])));
      const match = all.find(
        (workflow) => workflow.status === "active" && workflow.repositoryPath === repositoryPath,
      );
      return match ?? null;
    });

  return { takeOver, resumeAutonomous, delegateFromThread };
});

/**
 * The Work thread branch for a Symphony workspace. Reuses the stored
 * workspace key when present (the workspace manager derives the branch from
 * it); falls back to the directory name of the workspace path.
 */
const deriveThreadBranch = (workspacePath: string, workspaceKey: string | undefined): string => {
  if (workspaceKey !== undefined && workspaceKey.length > 0) {
    return `symphony/${workspaceKey}`;
  }
  const segments = workspacePath.split("/").filter((segment) => segment.length > 0);
  const leaf = segments[segments.length - 1] ?? "workspace";
  return `symphony/${leaf}`;
};

export const HandoffServiceLive: Layer.Layer<
  HandoffService,
  never,
  | Crypto.Crypto
  | WorkItemRepository
  | RunAttemptRepository
  | RunEventRepository
  | WorkflowRepository
  | WorkspaceOwnershipRepository
  | RunDispatcher
  | LiveRequests
> = Layer.effect(HandoffService, makeHandoffService);
