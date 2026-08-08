import type { EffectiveWorkflowConfig } from "@neokod/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProcessRunner } from "../../processRunner.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import {
  WorkspaceOwnershipRepository,
  WorkspaceRemovalGuard,
  WorkspaceRemovalBlockedError,
} from "../Persistence/Services/WorkspaceOwnershipRepository.ts";
import {
  makeWorkspaceManager,
  WorkspaceLeaseError,
  WorkspaceManager,
  type WorkspaceManagerDeps,
  WorkspacePopulationError,
  WorkspaceRemovalBlocked,
} from "./Manager.ts";

/**
 * Live workspace manager wiring.
 *
 * `ensureWorkspace` creates the per-issue worktree via the git VCS driver and
 * runs the `after_create` hook when the workspace is newly created. The
 * `before_run`/`after_run`/`before_remove` hooks are available via the
 * `HookRunner` shape for the runner/cleanup lanes.
 */
export const WorkspaceManagerLive = Layer.effect(
  WorkspaceManager,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const processRunner = yield* ProcessRunner;
    const fileSystem = yield* FileSystem.FileSystem;

    const assertRemovable: WorkspaceManagerDeps["assertRemovable"] = (input) =>
      // Resolved per call (not at construction): the guard lives in the merged
      // server runtime, so reading it inside the layer constructor would
      // return None for the Symphony sub-graph and silently disarm the guard
      // (REVIEW P0 "Symphony arm of the removal gateway is never installed").
      Effect.serviceOption(WorkspaceRemovalGuard).pipe(
        Effect.flatMap((maybeGuard) =>
          Option.isSome(maybeGuard)
            ? maybeGuard.value
                .assertRemovable({
                  workspacePath: input.workspacePath,
                  ...(input.force !== undefined ? { force: input.force } : {}),
                  removingOwner: "symphony",
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new WorkspaceRemovalBlocked(
                        input.workspacePath,
                        cause instanceof WorkspaceRemovalBlockedError ? cause.owner : "unknown",
                      ),
                  ),
                )
            : Effect.void,
        ),
      );

    const ownershipRepository = yield* WorkspaceOwnershipRepository;

    const acquireOwnership: WorkspaceManagerDeps["acquireOwnership"] = (workspacePath) =>
      // Bound at construction, not via serviceOption: a Symphony workspace
      // must always record a lease before an agent runs in it, and a wiring
      // gap must fail layer construction loudly. serviceOption resolved None
      // on scheduler-forked fibers, so retry-sweep dispatches ran leaseless
      // (completion audit, send-back 2).
      ownershipRepository.acquire({ workspacePath, owner: "symphony" }).pipe(
        Effect.mapError((cause) => new WorkspaceLeaseError(workspacePath, cause.message)),
        Effect.asVoid,
      );

    const defaultBranch = (cwd: string) =>
      git.listRefs({ cwd, refKind: "local", limit: 100 }).pipe(
        Effect.map((result) => {
          const def = result.refs.find((ref) => ref.isDefault);
          return def?.name ?? result.refs[0]?.name ?? "main";
        }),
        Effect.mapError((cause) => new WorkspacePopulationError(cwd, cause.message)),
      );

    const runHookEffect = (input: {
      readonly cwd: string;
      readonly config: EffectiveWorkflowConfig;
      readonly hook: "after_create" | "before_run" | "after_run" | "before_remove";
    }) =>
      processRunner
        .run({
          command: "sh",
          args: ["-lc", hookScriptFor(input.config, input.hook)],
          cwd: input.cwd,
          timeout: Duration.millis(input.config.hooksTimeoutMs ?? 60_000),
          timeoutBehavior: "error",
        })
        .pipe(
          Effect.mapError((cause) => new WorkspacePopulationError(input.cwd, cause.message)),
          Effect.flatMap((result) => {
            if (result.code !== 0) {
              return Effect.fail(
                new WorkspacePopulationError(
                  input.cwd,
                  `Hook ${input.hook} exited ${String(result.code)}: ${result.stderr.trim()}`,
                ),
              );
            }
            return Effect.void;
          }),
        );

    const deps: WorkspaceManagerDeps = {
      git,
      defaultBranch,
      runHook: runHookEffect,
      ensureDir: (dirPath) =>
        fileSystem
          .makeDirectory(dirPath, { recursive: true })
          .pipe(Effect.mapError((cause) => new WorkspacePopulationError(dirPath, cause.message))),
      pathExists: (p) => fileSystem.exists(p).pipe(Effect.catch(() => Effect.succeed(false))),
      realpath: (p) =>
        fileSystem
          .realPath(p)
          .pipe(Effect.mapError((cause) => new WorkspacePopulationError(p, cause.message))),
      assertRemovable,
      acquireOwnership,
    };

    return makeWorkspaceManager(deps);
  }),
);

function hookScriptFor(
  config: EffectiveWorkflowConfig,
  hook: "after_create" | "before_run" | "after_run" | "before_remove",
): string {
  switch (hook) {
    case "after_create":
      return config.hooksAfterCreate ?? "";
    case "before_run":
      return config.hooksBeforeRun ?? "";
    case "after_run":
      return config.hooksAfterRun ?? "";
    case "before_remove":
      return config.hooksBeforeRemove ?? "";
  }
}
