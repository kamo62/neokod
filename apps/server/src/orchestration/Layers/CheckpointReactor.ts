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
import { isTemporaryWorktreeBranch, validateGitArgumentValue } from "@neokod/shared/git";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  providerSessionHasActiveTurn,
  recoveryRefForThreadRevert,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import {
  WorktreeRemovalLease,
  WorktreeRemovalLeaseConflictError,
} from "../../git/WorktreeRemovalLease.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import {
  isWorkspaceSameOrInside,
  readWorkspaceIdentityEvidence,
  type WorkspaceIdentityEvidence,
} from "../../vcs/WorkspaceIdentity.ts";
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

type RestoredTreeEntry = {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly path: string;
};

type IgnoredRevertCheck =
  | { readonly state: "safe" }
  | {
      readonly state: "refused";
      readonly reason: "rules" | "collision" | "both" | "evidence";
      readonly paths: ReadonlyArray<string>;
      readonly detail?: string;
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
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const worktreeRemovalLease = yield* WorktreeRemovalLease;
  const hostPlatform = yield* HostProcessPlatform;
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

  // Recovery refs are created by the serial reactor worker. The monotonic
  // timestamp keeps same-process allocations distinct; the random suffix and
  // persisted-ref check keep them distinct across reactor restarts and refuse
  // to overwrite a retained snapshot.
  const lastRecoveryRefMillis = yield* Ref.make(0);
  const nextRecoveryRefMillis = Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(lastRecoveryRefMillis, (last) => {
      const millis = Math.max(nowMillis, last + 1);
      return [millis, millis];
    });
  });

  const allocateRecoveryRef = Effect.fn("CheckpointReactor.allocateRecoveryRef")(function* (
    cwd: string,
    threadId: ThreadId,
  ) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const epochMillis = yield* nextRecoveryRefMillis;
      const uniqueSuffix = yield* randomUUID;
      const checkpointRef = recoveryRefForThreadRevert(threadId, epochMillis, uniqueSuffix);
      const exists = yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef });
      if (!exists) {
        return checkpointRef;
      }
    }
    return null;
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

  const isGitWorkspace = (cwd: string) => checkpointStore.isGitRepository(cwd);

  const readWorkspaceIdentity = (workspacePath: string) =>
    readWorkspaceIdentityEvidence(workspacePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const isWorkspaceSameOrInsideWithServices = (
    target: WorkspaceIdentityEvidence,
    candidatePath: string,
  ) =>
    isWorkspaceSameOrInside({ target, candidatePath }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, hostPlatform),
    );

  // Physical overlap in either direction. A revert in a subfolder also has to
  // block turns admitted in its parent, not only paths inside the subfolder.
  const workspacePathsOverlap = Effect.fn("CheckpointReactor.workspacePathsOverlap")(function* (
    left: WorkspaceIdentityEvidence,
    rightPath: string,
  ) {
    const right = yield* readWorkspaceIdentity(rightPath);
    if (yield* isWorkspaceSameOrInsideWithServices(left, right.physicalPath)) {
      return true;
    }
    return yield* isWorkspaceSameOrInsideWithServices(right, left.physicalPath);
  });

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

  const runGitEvidence = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }): Effect.Effect<
    | { readonly ok: true; readonly result: VcsProcess.VcsProcessOutput }
    | { readonly ok: false; readonly detail: string }
  > =>
    runGit({ ...input, allowNonZeroExit: true }).pipe(
      Effect.map((result) =>
        result.stdoutTruncated
          ? { ok: false as const, detail: `${input.operation}: output was truncated` }
          : { ok: true as const, result },
      ),
      Effect.catch((error) => Effect.succeed({ ok: false as const, detail: error.message })),
    );

  const resolveRestoreCommit = Effect.fn("CheckpointReactor.resolveRestoreCommit")(
    function* (input: {
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
      readonly fallbackToHead: boolean;
    }): Effect.fn.Return<
      | { readonly state: "ok"; readonly commit: string }
      | { readonly state: "refused"; readonly detail: string }
    > {
      const target = yield* runGitEvidence({
        operation: "CheckpointReactor.resolveRestoreCommit",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", "--quiet", `${input.checkpointRef}^{commit}`],
      });
      if (!target.ok) {
        return { state: "refused", detail: target.detail };
      }
      if (target.result.exitCode === 0) {
        const commit = target.result.stdout.trim();
        if (commit.length > 0) {
          return { state: "ok", commit };
        }
      } else if (target.result.exitCode !== 1) {
        return {
          state: "refused",
          detail: `git rev-parse exited with ${target.result.exitCode}`,
        };
      }
      if (!input.fallbackToHead) {
        return { state: "refused", detail: "the checkpoint commit is not available" };
      }
      const head = yield* runGitEvidence({
        operation: "CheckpointReactor.resolveRestoreCommit",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      });
      if (!head.ok) {
        return { state: "refused", detail: head.detail };
      }
      if (head.result.exitCode !== 0) {
        return {
          state: "refused",
          detail: `git rev-parse HEAD exited with ${head.result.exitCode}`,
        };
      }
      const commit = head.result.stdout.trim();
      return commit.length > 0
        ? { state: "ok", commit }
        : { state: "refused", detail: "HEAD has no commit" };
    },
  );

  const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

  // Git path output is newline-terminated. Strip only that terminator so
  // leading or trailing whitespace in a real path is preserved.
  const stripTrailingNewline = (value: string): string =>
    value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;

  const conservativePathKey = (value: string): string => value.normalize("NFC").toLowerCase();

  const isGitIgnorePath = (entry: string): boolean => {
    const key = conservativePathKey(entry);
    return key === ".gitignore" || key.endsWith("/.gitignore");
  };

  const parseRestoredTreeEntries = (stdout: string): ReadonlyArray<RestoredTreeEntry> | null => {
    const entries: Array<RestoredTreeEntry> = [];
    for (const record of stdout.split("\0")) {
      if (record.length === 0) {
        continue;
      }
      const tabIndex = record.indexOf("\t");
      if (tabIndex < 0) {
        return null;
      }
      const header = record.slice(0, tabIndex).split(" ");
      if (header.length < 3) {
        return null;
      }
      const [mode, type, oid] = header;
      if (!mode || !type || !oid) {
        return null;
      }
      entries.push({ mode, type, oid, path: record.slice(tabIndex + 1) });
    }
    return entries;
  };

  // Restore only rewrites the subtree under cwd. Ancestor ignore rules outside
  // cwd are not restored, so they are not part of this comparison. Refuse
  // conservatively when ignored content exists and either a .gitignore under
  // cwd differs from the checkpoint, or a tracked checkpoint entry overlaps an
  // ignored path. Any incomplete evidence also refuses.
  const inspectIgnoredRevertRisk = Effect.fn("CheckpointReactor.inspectIgnoredRevertRisk")(
    function* (input: {
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
      readonly fallbackToHead: boolean;
    }): Effect.fn.Return<IgnoredRevertCheck> {
      const refusedEvidence = (detail: string): IgnoredRevertCheck => ({
        state: "refused",
        reason: "evidence",
        paths: [],
        detail,
      });

      const toplevel = yield* runGitEvidence({
        operation: "CheckpointReactor.inspectIgnoredRevertRisk.toplevel",
        cwd: input.cwd,
        args: ["rev-parse", "--show-toplevel"],
      });
      if (!toplevel.ok) {
        return refusedEvidence(toplevel.detail);
      }
      if (toplevel.result.exitCode !== 0) {
        return refusedEvidence(
          `git rev-parse --show-toplevel exited with ${toplevel.result.exitCode}`,
        );
      }
      const repoRoot = stripTrailingNewline(toplevel.result.stdout);
      if (repoRoot.length === 0) {
        return refusedEvidence("the repository root is empty");
      }

      const prefix = yield* runGitEvidence({
        operation: "CheckpointReactor.inspectIgnoredRevertRisk.prefix",
        cwd: input.cwd,
        args: ["rev-parse", "--show-prefix"],
      });
      if (!prefix.ok) {
        return refusedEvidence(prefix.detail);
      }
      if (prefix.result.exitCode !== 0) {
        return refusedEvidence(`git rev-parse --show-prefix exited with ${prefix.result.exitCode}`);
      }
      const cwdPrefix = stripTrailingNewline(prefix.result.stdout);
      if (cwdPrefix.length > 0) {
        const pathProblem = validateGitArgumentValue(cwdPrefix, "Subfolder path");
        if (pathProblem !== null) {
          return refusedEvidence(pathProblem);
        }
      }
      const pathArgs = cwdPrefix.length > 0 ? ["--", cwdPrefix] : [];

      const cwdIdentity = yield* readWorkspaceIdentity(input.cwd).pipe(Effect.option);
      if (Option.isNone(cwdIdentity)) {
        return refusedEvidence("the workspace identity could not be read");
      }
      const excludesConfig = yield* runGitEvidence({
        operation: "CheckpointReactor.inspectIgnoredRevertRisk.excludesFile",
        cwd: repoRoot,
        args: ["config", "--path", "--get", "core.excludesFile"],
      });
      if (!excludesConfig.ok) {
        return refusedEvidence(excludesConfig.detail);
      }
      if (excludesConfig.result.exitCode !== 0 && excludesConfig.result.exitCode !== 1) {
        return refusedEvidence(
          `git config core.excludesFile exited with ${excludesConfig.result.exitCode}`,
        );
      }
      const configuredExcludesValue =
        excludesConfig.result.exitCode === 0
          ? stripTrailingNewline(excludesConfig.result.stdout)
          : "";
      const configuredExcludesPath =
        configuredExcludesValue.length === 0
          ? null
          : path.isAbsolute(configuredExcludesValue)
            ? configuredExcludesValue
            : path.resolve(repoRoot, configuredExcludesValue);

      const ignored = yield* runGitEvidence({
        operation: "CheckpointReactor.inspectIgnoredRevertRisk.ignored",
        cwd: repoRoot,
        args: [
          // Filesystem-derived paths are always literal pathspecs; `--` only
          // ends option parsing, it does not disable pathspec magic.
          "--literal-pathspecs",
          // Directory-level enumeration is enough: Git cannot re-include a
          // descendant of an excluded directory.
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--full-name",
          "-z",
          ...pathArgs,
        ],
      });
      if (!ignored.ok) {
        return refusedEvidence(ignored.detail);
      }
      if (ignored.result.exitCode !== 0) {
        return refusedEvidence(`git ls-files --ignored exited with ${ignored.result.exitCode}`);
      }
      const currentIgnored = ignored.result.stdout.split("\0").filter((entry) => entry.length > 0);
      if (currentIgnored.length === 0) {
        return { state: "safe" };
      }

      const commitResult = yield* resolveRestoreCommit(input);
      if (commitResult.state === "refused") {
        return refusedEvidence(commitResult.detail);
      }

      const tree = yield* runGitEvidence({
        operation: "CheckpointReactor.inspectIgnoredRevertRisk.tree",
        cwd: repoRoot,
        args: ["--literal-pathspecs", "ls-tree", "-r", "-z", commitResult.commit, ...pathArgs],
      });
      if (!tree.ok) {
        return refusedEvidence(tree.detail);
      }
      if (tree.result.exitCode !== 0) {
        return refusedEvidence(`git ls-tree exited with ${tree.result.exitCode}`);
      }
      const targetEntries = parseRestoredTreeEntries(tree.result.stdout);
      if (targetEntries === null) {
        return refusedEvidence("the checkpoint tree listing could not be parsed");
      }

      const currentFiles = yield* runGitEvidence({
        operation: "CheckpointReactor.inspectIgnoredRevertRisk.currentFiles",
        cwd: repoRoot,
        args: [
          "--literal-pathspecs",
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          ...pathArgs,
        ],
      });
      if (!currentFiles.ok) {
        return refusedEvidence(currentFiles.detail);
      }
      if (currentFiles.result.exitCode !== 0) {
        return refusedEvidence(`git ls-files exited with ${currentFiles.result.exitCode}`);
      }

      const specialIgnorePaths = new Set<string>();
      if (configuredExcludesPath !== null) {
        const physicallyInside = yield* isWorkspaceSameOrInsideWithServices(
          cwdIdentity.value,
          configuredExcludesPath,
        ).pipe(Effect.option);
        if (Option.isNone(physicallyInside)) {
          return refusedEvidence("the configured core.excludesFile identity could not be read");
        }
        const relativeToCwd = path.relative(input.cwd, configuredExcludesPath);
        const lexicallyInside =
          relativeToCwd === "" ||
          (!relativeToCwd.startsWith("..") && !path.isAbsolute(relativeToCwd));
        if (physicallyInside.value || lexicallyInside) {
          const relativeToRepo = path.relative(repoRoot, configuredExcludesPath);
          if (
            relativeToRepo.length === 0 ||
            relativeToRepo === ".." ||
            relativeToRepo.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeToRepo)
          ) {
            return refusedEvidence(
              "the configured core.excludesFile could not be mapped into the restored workspace",
            );
          }
          const excludesRelativePath = relativeToRepo.split(path.sep).join("/");
          const currentListed = [...currentFiles.result.stdout.split("\0"), ...currentIgnored]
            .map(trimTrailingSlash)
            .includes(trimTrailingSlash(excludesRelativePath));
          const absoluteExcludesPath = path.join(repoRoot, excludesRelativePath);
          const currentInfo = yield* fileSystem.stat(absoluteExcludesPath).pipe(Effect.option);
          const currentLink = yield* fileSystem.readLink(absoluteExcludesPath).pipe(Effect.option);
          const targetListed = targetEntries.some((entry) => entry.path === excludesRelativePath);
          if (
            currentListed ||
            Option.isSome(currentInfo) ||
            Option.isSome(currentLink) ||
            targetListed
          ) {
            specialIgnorePaths.add(excludesRelativePath);
          }
        }
      }
      const isRelevantIgnorePath = (entry: string): boolean =>
        isGitIgnorePath(entry) || specialIgnorePaths.has(trimTrailingSlash(entry));

      const currentIgnorePaths = new Set(
        [...currentFiles.result.stdout.split("\0"), ...currentIgnored]
          .filter((entry) => entry.length > 0 && isRelevantIgnorePath(entry))
          .map(trimTrailingSlash),
      );
      for (const specialIgnorePath of specialIgnorePaths) {
        currentIgnorePaths.add(specialIgnorePath);
      }

      const targetIgnoreByPath = new Map(
        targetEntries
          .filter((entry) => isRelevantIgnorePath(entry.path))
          .map((entry) => [entry.path, entry] as const),
      );

      let rulesChanged = false;
      const allIgnorePaths = new Set([...currentIgnorePaths, ...targetIgnoreByPath.keys()]);
      for (const ignorePath of allIgnorePaths) {
        const target = targetIgnoreByPath.get(ignorePath);
        if (target === undefined) {
          rulesChanged = true;
          break;
        }
        if (target.type !== "blob" || (target.mode !== "100644" && target.mode !== "100755")) {
          // A symlink, submodule, or other non-regular .gitignore is a change.
          rulesChanged = true;
          break;
        }
        if (!currentIgnorePaths.has(ignorePath)) {
          rulesChanged = true;
          break;
        }
        const absolute = path.join(repoRoot, ignorePath);
        const link = yield* fileSystem.readLink(absolute).pipe(Effect.option);
        if (Option.isSome(link)) {
          rulesChanged = true;
          break;
        }
        const info = yield* fileSystem.stat(absolute).pipe(Effect.option);
        if (Option.isNone(info)) {
          rulesChanged = true;
          break;
        }
        const currentExecutable = (info.value.mode & 0o111) !== 0;
        if (currentExecutable !== (target.mode === "100755")) {
          rulesChanged = true;
          break;
        }
        const ignorePathProblem = validateGitArgumentValue(ignorePath, "Ignore file path");
        if (ignorePathProblem !== null) {
          rulesChanged = true;
          break;
        }
        const hashed = yield* runGitEvidence({
          operation: "CheckpointReactor.inspectIgnoredRevertRisk.hashObject",
          cwd: repoRoot,
          args: ["--literal-pathspecs", "hash-object", "--no-filters", "--", ignorePath],
        });
        if (!hashed.ok || hashed.result.exitCode !== 0) {
          rulesChanged = true;
          break;
        }
        if (hashed.result.stdout.trim() !== target.oid) {
          rulesChanged = true;
          break;
        }
      }

      const targetPathKeys = new Set(targetEntries.map((entry) => conservativePathKey(entry.path)));
      const targetDirectoryPrefixKeys = new Set<string>();
      for (const entry of targetEntries) {
        const segments = entry.path.split("/");
        for (let index = 1; index < segments.length; index += 1) {
          targetDirectoryPrefixKeys.add(conservativePathKey(segments.slice(0, index).join("/")));
        }
      }

      const collidingIgnored = [
        ...new Set(
          currentIgnored.map(trimTrailingSlash).filter((ignoredPath) => {
            const ignoredKey = conservativePathKey(ignoredPath);
            if (targetPathKeys.has(ignoredKey) || targetDirectoryPrefixKeys.has(ignoredKey)) {
              return true;
            }
            const segments = ignoredPath.split("/");
            for (let index = 1; index < segments.length; index += 1) {
              if (targetPathKeys.has(conservativePathKey(segments.slice(0, index).join("/")))) {
                return true;
              }
            }
            return false;
          }),
        ),
      ];

      if (!rulesChanged && collidingIgnored.length === 0) {
        return { state: "safe" };
      }

      const display = (entry: string): string =>
        cwdPrefix.length > 0 && entry.startsWith(cwdPrefix) ? entry.slice(cwdPrefix.length) : entry;
      const atRiskPaths = [
        ...new Set([
          ...(rulesChanged ? currentIgnored.map(trimTrailingSlash).map(display) : []),
          ...collidingIgnored.map(display),
        ]),
      ];
      return {
        state: "refused",
        reason:
          rulesChanged && collidingIgnored.length > 0
            ? "both"
            : rulesChanged
              ? "rules"
              : "collision",
        paths: atRiskPaths,
      };
    },
  );

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
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
    if (!(yield* isGitWorkspace(cwd))) {
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
    const threadId = event.payload.threadId;
    const turnCount = event.payload.turnCount;

    const initialSessions = yield* readSessionsForRevert();
    if (Option.isNone(initialSessions)) {
      yield* appendRevertFailureActivity({
        threadId,
        turnCount,
        detail:
          "Revert refused: the active provider session list could not be read, so Neokod cannot confirm that no other thread is running in this folder. Nothing was changed.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const initialSessionRuntime = sessionRuntimeFromSessions(threadId, initialSessions.value);
    if (Option.isNone(initialSessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId,
        turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const cwd = initialSessionRuntime.value.cwd;
    if (!(yield* isGitWorkspace(cwd))) {
      yield* appendRevertFailureActivity({
        threadId,
        turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const failRevert = (detail: string) =>
      appendRevertFailureActivity({ threadId, turnCount, detail, createdAt: now }).pipe(
        Effect.catch(() => Effect.void),
      );

    // Hold the worktree removal reservation across fresh busy-evidence reads,
    // capture, restore, rollback and completion. New turn admissions that
    // overlap cwd are blocked while it is held. The lease takes its admission
    // semaphore only to add and remove the reservation, not while this effect,
    // including reactor dispatches, runs.
    yield* worktreeRemovalLease
      .withRemovalReservationForPath(
        cwd,
        Effect.gen(function* () {
          const sessions = yield* readSessionsForRevert();
          if (Option.isNone(sessions)) {
            yield* failRevert(
              "Revert refused: the active provider session list could not be read, so Neokod cannot confirm that no other thread is running in this folder. Nothing was changed.",
            );
            return;
          }

          const freshSessionRuntime = sessionRuntimeFromSessions(threadId, sessions.value);
          if (Option.isNone(freshSessionRuntime)) {
            yield* failRevert(
              "No active provider session with workspace cwd is bound to this thread.",
            );
            return;
          }
          if (freshSessionRuntime.value.cwd !== cwd) {
            yield* failRevert(
              "Revert refused: the provider session workspace changed while the revert was starting. Nothing was changed.",
            );
            return;
          }

          const thread = yield* resolveThreadDetail(threadId);
          if (!thread) {
            yield* failRevert("Thread was not found in read model.");
            return;
          }

          const currentTurnCount = thread.checkpoints.reduce(
            (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
            0,
          );
          if (turnCount > currentTurnCount) {
            yield* failRevert(
              `Checkpoint turn count ${turnCount} exceeds current turn count ${currentTurnCount}.`,
            );
            return;
          }

          const targetCheckpointRef =
            turnCount === 0
              ? checkpointRefForThreadTurn(threadId, 0)
              : thread.checkpoints.find(
                  (checkpoint) => checkpoint.checkpointTurnCount === turnCount,
                )?.checkpointRef;
          if (!targetCheckpointRef) {
            yield* failRevert(`Checkpoint ref for turn ${turnCount} is unavailable in read model.`);
            return;
          }

          // Fresh evidence after the reservation. A turn admitted before the
          // reservation is already projected as pending/running, so it is
          // refused here before capture.
          // Read unresolved admissions independently of the active-sidebar
          // shell filter. Archived or deleted threads can still own an
          // admitted turn whose provider session is not visible yet, so the
          // full command read model is the authoritative thread list here.
          const commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
          const cwdIdentity = yield* readWorkspaceIdentity(cwd);
          const busyThreads = new Set<ThreadId>();

          for (const session of sessions.value) {
            if (!providerSessionHasActiveTurn(session) || session.cwd === undefined) {
              continue;
            }
            if (yield* workspacePathsOverlap(cwdIdentity, session.cwd)) {
              busyThreads.add(session.threadId);
            }
          }

          const ownActiveTurnId = thread.session?.activeTurnId ?? null;
          if (ownActiveTurnId !== null) {
            busyThreads.add(thread.id);
          }

          for (const shellThread of commandReadModel.threads) {
            const currentWorkspacePath = resolveThreadWorkspaceCwd({
              thread: shellThread,
              projects: commandReadModel.projects,
            });
            const currentOverlaps =
              currentWorkspacePath === undefined
                ? true
                : yield* workspacePathsOverlap(cwdIdentity, currentWorkspacePath);

            const turns = yield* projectionTurnRepository.listByThreadId({
              threadId: shellThread.id,
            });
            const unsettledTurns = turns.filter(
              (projectedTurn) =>
                projectedTurn.turnId === null ||
                projectedTurn.state === "pending" ||
                projectedTurn.state === "running",
            );
            if (unsettledTurns.length > 0) {
              // The admitted workspace is independent of the thread's current
              // or inherited folder. A legacy unsettled row has no recorded
              // workspace, so it fails closed rather than guessing.
              const admittedOverlaps = yield* Effect.forEach(unsettledTurns, (projectedTurn) => {
                if (projectedTurn.admittedWorkspacePath === null) {
                  return Effect.succeed(true);
                }
                return workspacePathsOverlap(cwdIdentity, projectedTurn.admittedWorkspacePath);
              }).pipe(Effect.map((results) => results.some(Boolean)));
              if (admittedOverlaps) {
                busyThreads.add(shellThread.id);
              }
            }

            if (currentOverlaps) {
              const activeTurnId = shellThread.session?.activeTurnId ?? null;
              if (activeTurnId !== null || shellThread.latestTurn?.state === "running") {
                busyThreads.add(shellThread.id);
              }
              if (turns.some((projectedTurn) => projectedTurn.state === "running")) {
                busyThreads.add(shellThread.id);
              }
            }
          }

          if (busyThreads.size > 0) {
            const busyList = [...busyThreads].join(", ");
            yield* failRevert(
              `Revert refused: ${busyList} ${busyThreads.size === 1 ? "has" : "have"} an active or admitted turn in the same or an overlapping folder (${cwd}). Wait for it to finish or interrupt it, then try again. Nothing was changed.`,
            );
            return;
          }

          const ignoredCheck = yield* inspectIgnoredRevertRisk({
            cwd,
            checkpointRef: targetCheckpointRef,
            fallbackToHead: turnCount === 0,
          });
          if (ignoredCheck.state === "refused") {
            let detail: string;
            if (ignoredCheck.reason === "evidence") {
              detail = `Revert refused: Neokod could not verify the ignored files in this folder before reverting (${ignoredCheck.detail ?? "unknown error"}). Nothing was changed.`;
            } else {
              const count = ignoredCheck.paths.length;
              const shown = ignoredCheck.paths.slice(0, 5).join(", ");
              const more = count > 5 ? ` and ${count - 5} more` : "";
              const cause =
                ignoredCheck.reason === "rules"
                  ? `the ignore rules under this folder changed since checkpoint ${turnCount}`
                  : ignoredCheck.reason === "collision"
                    ? `tracked paths under this folder changed since checkpoint ${turnCount} and overlap ignored paths`
                    : `the ignore rules and tracked paths under this folder changed since checkpoint ${turnCount}`;
              detail = `Revert refused: ${count} ignored path${count === 1 ? "" : "s"} would be lost because ${cause}. At risk: ${shown}${more}. Nothing was changed.`;
            }
            yield* failRevert(detail);
            return;
          }

          const recoveryRef = yield* allocateRecoveryRef(cwd, threadId);
          if (recoveryRef === null) {
            yield* failRevert(
              "Revert refused: a unique recovery ref could not be allocated, so nothing was changed.",
            );
            return;
          }
          const saved = yield* checkpointStore
            .captureCheckpoint({ cwd, checkpointRef: recoveryRef })
            .pipe(
              Effect.as(true),
              Effect.catch((error) =>
                failRevert(
                  `Revert refused: the current files could not be saved to a recovery ref, so nothing was changed. ${error.message}`,
                ).pipe(Effect.as(false)),
              ),
            );
          if (!saved) {
            return;
          }

          yield* appendRevertRecoveryActivity({
            threadId,
            turnCount,
            recoveryRef,
            cwd,
            createdAt: now,
          }).pipe(Effect.catch(() => Effect.void));

          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd,
            checkpointRef: targetCheckpointRef,
            fallbackToHead: turnCount === 0,
          });
          if (!restored) {
            yield* failRevert(`Filesystem checkpoint is unavailable for turn ${turnCount}.`);
            return;
          }

          yield* workspaceEntries.refresh(cwd);

          const rolledBackTurns = Math.max(0, currentTurnCount - turnCount);
          if (rolledBackTurns > 0) {
            yield* providerService.rollbackConversation({
              threadId: freshSessionRuntime.value.threadId,
              numTurns: rolledBackTurns,
            });
          }

          const staleCheckpointRefs: Array<CheckpointRef> = [];
          for (const checkpoint of thread.checkpoints) {
            if (checkpoint.checkpointTurnCount > turnCount) {
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
              threadId,
              turnCount,
              createdAt: now,
            })
            .pipe(
              Effect.catch((error) =>
                appendRevertFailureActivity({
                  threadId,
                  turnCount,
                  detail: error.message,
                  createdAt: now,
                }),
              ),
              Effect.asVoid,
            );
        }),
      )
      .pipe(
        Effect.catchIf(
          (error): error is WorktreeRemovalLeaseConflictError =>
            error instanceof WorktreeRemovalLeaseConflictError,
          (error) => failRevert(`Revert refused: ${error.message} Nothing was changed.`),
        ),
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
