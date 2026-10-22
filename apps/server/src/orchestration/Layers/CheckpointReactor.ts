import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type VcsStatusLocalResult,
} from "@neokod/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@neokod/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@neokod/shared/git";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  findActiveSessionsSharingCwd,
  recoveryRefForThreadRevert,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendRevertRecoveryActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly recoveryRef: CheckpointRef;
    readonly cwd: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-recovery"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "info",
            kind: "checkpoint.revert.recovery-saved",
            summary: "Files saved before revert",
            payload: {
              turnCount: input.turnCount,
              recoveryRef: input.recoveryRef,
              cwd: input.cwd,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const sessionRuntimeFromSessions = (
    threadId: ThreadId,
    sessions: ReadonlyArray<ProviderSession>,
  ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  };

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    return sessionRuntimeFromSessions(threadId, sessions);
  });

  // A failed session listing is unknown, not an empty list. Revert must refuse
  // rather than assume no other thread is active in the folder.
  const readSessionsForRevert = Effect.fn("readSessionsForRevert")(function* (): Effect.fn.Return<
    Option.Option<ReadonlyArray<ProviderSession>>
  > {
    return yield* providerService.listSessions().pipe(
      Effect.map((sessions) => Option.some(sessions)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(Option.none()),
      ),
    );
  });

  // Recovery refs are created by the serial reactor worker. Keep them distinct
  // even if two reverts land in the same millisecond, so the earlier snapshot
  // is not overwritten.
  const lastRecoveryRefMillis = yield* Ref.make(0);
  const nextRecoveryRefMillis = Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(lastRecoveryRefMillis, (last) => {
      const millis = Math.max(nowMillis, last + 1);
      return [millis, millis];
    });
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  const runGit = Effect.fn("CheckpointReactor.runGit")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly allowNonZeroExit?: boolean;
  }) {
    return yield* vcsProcess.run({
      operation: input.operation,
      command: "git",
      cwd: input.cwd,
      args: input.args,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
    });
  });

  const resolveRestoreCommit = Effect.fn("CheckpointReactor.resolveRestoreCommit")(
    function* (input: {
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
      readonly fallbackToHead: boolean;
    }) {
      const target = yield* runGit({
        operation: "CheckpointReactor.resolveRestoreCommit",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", "--quiet", `${input.checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      });
      if (target.exitCode === 0) {
        const commit = target.stdout.trim();
        if (commit.length > 0) {
          return commit;
        }
      }
      if (!input.fallbackToHead) {
        return null;
      }
      const head = yield* runGit({
        operation: "CheckpointReactor.resolveRestoreCommit",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      });
      if (head.exitCode !== 0) {
        return null;
      }
      const commit = head.stdout.trim();
      return commit.length > 0 ? commit : null;
    },
  );

  const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

  // Restore reinstates the target tree's .gitignore rules before `git clean -fd`
  // runs. An untracked file that is ignored now but not by the target tree would
  // be deleted, and the recovery snapshot never captured it because it was
  // ignored at capture time. Refuse when that would happen.
  const findIgnoredPathsLostByRestore = Effect.fn(
    "CheckpointReactor.findIgnoredPathsLostByRestore",
  )(function* (input: {
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
    readonly fallbackToHead: boolean;
  }) {
    const repoRootResult = yield* runGit({
      operation: "CheckpointReactor.findIgnoredPathsLostByRestore",
      cwd: input.cwd,
      args: ["rev-parse", "--show-toplevel"],
      allowNonZeroExit: true,
    });
    if (repoRootResult.exitCode !== 0) {
      return [];
    }
    const repoRoot = repoRootResult.stdout.trim();
    if (repoRoot.length === 0) {
      return [];
    }

    const prefixResult = yield* runGit({
      operation: "CheckpointReactor.findIgnoredPathsLostByRestore",
      cwd: input.cwd,
      args: ["rev-parse", "--show-prefix"],
      allowNonZeroExit: true,
    });
    const cwdPrefix = prefixResult.exitCode === 0 ? prefixResult.stdout.trim() : "";

    const ignored = yield* runGit({
      operation: "CheckpointReactor.findIgnoredPathsLostByRestore",
      cwd: repoRoot,
      args: [
        // An ignored directory is enough to assess: Git cannot re-include a
        // descendant of an excluded directory, so either the target still
        // ignores it or clean would remove the whole directory.
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--full-name",
        "-z",
        ...(cwdPrefix.length > 0 ? ["--", cwdPrefix] : []),
      ],
    });
    const currentIgnored = ignored.stdout.split("\0").filter((entry) => entry.length > 0);
    if (currentIgnored.length === 0) {
      return [];
    }

    const commit = yield* resolveRestoreCommit(input);
    if (commit === null) {
      return [];
    }

    const tree = yield* runGit({
      operation: "CheckpointReactor.findIgnoredPathsLostByRestore",
      cwd: repoRoot,
      args: ["ls-tree", "-r", "-z", "--name-only", commit],
    });
    const targetIgnorePaths = tree.stdout
      .split("\0")
      .filter((entry) => entry === ".gitignore" || entry.endsWith("/.gitignore"));

    return yield* Effect.scoped(
      Effect.acquireRelease(
        fileSystem.makeTempDirectory({ prefix: "neokod-revert-ignore-check-" }),
        (directory) =>
          fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((tempDirectory) =>
          Effect.gen(function* () {
            for (const ignorePath of targetIgnorePaths) {
              const contents = yield* runGit({
                operation: "CheckpointReactor.findIgnoredPathsLostByRestore",
                cwd: repoRoot,
                args: ["show", `${commit}:${ignorePath}`],
              });
              const destination = path.join(tempDirectory, ignorePath);
              yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
              yield* fileSystem.writeFileString(destination, contents.stdout);
            }

            const checked = yield* runGit({
              operation: "CheckpointReactor.findIgnoredPathsLostByRestore",
              cwd: repoRoot,
              args: ["--work-tree", tempDirectory, "check-ignore", "--no-index", "-z", "--stdin"],
              stdin: `${currentIgnored.join("\0")}\0`,
              allowNonZeroExit: true,
            });
            if (checked.exitCode !== 0 && checked.exitCode !== 1) {
              // Unknown target rules: refuse rather than claim the files survive.
              return currentIgnored;
            }

            const targetIgnored = new Set(
              checked.stdout
                .split("\0")
                .filter((entry) => entry.length > 0)
                .map(trimTrailingSlash),
            );
            return currentIgnored
              .filter((entry) => !targetIgnored.has(trimTrailingSlash(entry)))
              .map((entry) =>
                cwdPrefix.length > 0 && entry.startsWith(cwdPrefix)
                  ? entry.slice(cwdPrefix.length)
                  : entry,
              );
          }),
        ),
      ),
    );
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      });
    },
  );

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        isTemporaryWorktreeBranch(thread.branch)
      ) {
        return;
      }

      // Canonicalize both sides of the worktree identity so a symlinked
      // workspace matches its thread (RECONCILE binding constraint: raw
      // path equality collides with the canonical-path fix).
      const canonicalCwd = yield* fileSystem
        .realPath(input.cwd)
        .pipe(Effect.catch(() => Effect.succeed(input.cwd)));
      const canonicalWorktree = yield* fileSystem
        .realPath(thread.worktreePath)
        .pipe(Effect.catch(() => Effect.succeed(thread.worktreePath)));
      if (canonicalWorktree !== canonicalCwd) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = yield* Effect.all(
        shell.threads
          .flatMap((other): { readonly worktreePath: string }[] => {
            const path = other.worktreePath;
            return other.id !== thread.id && path !== null && path !== undefined
              ? [{ worktreePath: path }]
              : [];
          })
          .map((other) =>
            fileSystem
              .realPath(other.worktreePath)
              .pipe(Effect.catch(() => Effect.succeed(other.worktreePath))),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((paths) => paths.some((path) => path === canonicalWorktree)));
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessions = yield* readSessionsForRevert();
    if (Option.isNone(sessions)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail:
          "Revert refused: the active provider session list could not be read, so Neokod cannot confirm that no other thread is running in this folder. Nothing was changed.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = sessionRuntimeFromSessions(event.payload.threadId, sessions.value);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!isGitWorkspace(sessionRuntime.value.cwd)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const cwd = sessionRuntime.value.cwd;

    // Refuse while this thread or another thread has an active turn in the same
    // folder or an overlapping parent/child folder. Restore rewrites every
    // tracked file and deletes every untracked, non-ignored file under cwd,
    // including another thread's work.
    const busyThreads = [
      ...findActiveSessionsSharingCwd({
        cwd,
        sessions: sessions.value,
      }),
    ];
    // The provider session list is not the only evidence of an active turn.
    // The read model also records the thread's own active turn; treat either
    // as busy. This covers adapters that keep the session at "ready".
    const readModelActiveTurnId = thread.session?.activeTurnId ?? null;
    if (
      readModelActiveTurnId !== null &&
      !busyThreads.some((threadId) => threadId === event.payload.threadId)
    ) {
      busyThreads.push(event.payload.threadId);
    }
    if (busyThreads.length > 0) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Revert refused: ${busyThreads.join(", ")} ${busyThreads.length === 1 ? "has" : "have"} an active turn in the same folder (${cwd}). Wait for it to finish or interrupt it, then try again. Nothing was changed.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // The recovery snapshot never captures ignored files. If restoring the
    // target tree's ignore rules would make a currently ignored path
    // non-ignored, git clean would delete it. Refuse before any mutation.
    const ignoredPathsLostByRestore = yield* findIgnoredPathsLostByRestore({
      cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (ignoredPathsLostByRestore.length > 0) {
      const shown = ignoredPathsLostByRestore.slice(0, 5).join(", ");
      const more =
        ignoredPathsLostByRestore.length > 5
          ? ` and ${ignoredPathsLostByRestore.length - 5} more`
          : "";
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Revert refused: ${ignoredPathsLostByRestore.length} ignored path${ignoredPathsLostByRestore.length === 1 ? "" : "s"} would be deleted because the recovery snapshot does not include ignored files and checkpoint ${event.payload.turnCount}'s ignore rules do not cover: ${shown}${more}. Move the path out of this folder or keep it ignored in the checkpoint, then try again. Nothing was changed.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Save the current files to a hidden ref first. If that fails, change
    // nothing: no restore, no conversation rollback and no checkpoint cleanup.
    const recoveryRef = recoveryRefForThreadRevert(
      event.payload.threadId,
      yield* nextRecoveryRefMillis,
    );
    const saved = yield* checkpointStore
      .captureCheckpoint({ cwd, checkpointRef: recoveryRef })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: `Revert refused: the current files could not be saved to a recovery ref, so nothing was changed. ${error.message}`,
            createdAt: now,
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.as(false),
          ),
        ),
      );
    if (!saved) {
      return;
    }
    yield* appendRevertRecoveryActivity({
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
      recoveryRef,
      cwd,
      createdAt: now,
    }).pipe(Effect.catch(() => Effect.void));

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Refresh the workspace entry index so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.refresh(cwd);

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. The providerService.streamEvents PubSub does not reliably deliver
    // turn.completed runtime events to this reactor (shared subscription), so
    // reacting to the domain event is the reliable path.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* refreshLocalGitStatusFromTurnCompletion(event);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
