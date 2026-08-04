import type { EffectiveWorkflowConfig } from "@neokod/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { ProcessRunner } from "../../processRunner.ts";
import { makeWorkspaceManager, WorkspaceManager, type WorkspaceManagerDeps } from "./Manager.ts";
import type { HookRunner } from "./Hooks.ts";

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

    const defaultBranch = (cwd: string) =>
      git.listRefs({ cwd, refKind: "local", limit: 100 }).pipe(
        Effect.map((result) => {
          const def = result.refs.find((ref) => ref.isDefault);
          return def?.name ?? result.refs[0]?.name ?? "main";
        }),
        Effect.mapError((cause) => new Error(cause.message)),
      );

    const runHookEffect: HookRunner["run"] = (input) =>
      processRunner
        .run({
          command: "sh",
          args: ["-lc", hookScriptFor(input.config, input.hook)],
          cwd: input.cwd,
          timeout: Duration.millis(input.config.hooksTimeoutMs ?? 60_000),
          timeoutBehavior: "error",
        })
        .pipe(
          Effect.flatMap((result) => {
            if (result.code !== 0) {
              return Effect.fail(
                new Error(
                  `Hook ${input.hook} exited ${String(result.code)}: ${result.stderr.trim()}`,
                ),
              );
            }
            return Effect.void;
          }),
          Effect.mapError((cause) => new Error(cause.message)),
        );

    const deps: WorkspaceManagerDeps = {
      git,
      defaultBranch,
      runHook: runHookEffect,
      ensureDir: (dirPath) => fileSystem.makeDirectory(dirPath, { recursive: true }),
      pathExists: (p) => fileSystem.exists(p).pipe(Effect.catch(() => Effect.succeed(false))),
      realpath: (p) =>
        Effect.try({
          try: () => require("node:fs").realpathSync(p),
          catch: (cause) => new Error(cause instanceof Error ? cause.message : "realpath failed"),
        }),
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
