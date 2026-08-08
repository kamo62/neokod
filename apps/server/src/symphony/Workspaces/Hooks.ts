import type { EffectiveWorkflowConfig } from "@neokod/contracts";
import * as Effect from "effect/Effect";

/**
 * Workspace lifecycle hooks (SPEC 9.4).
 *
 * Hooks are shell scripts from `WORKFLOW.md` run with the workspace as `cwd`,
 * bounded by `hooks.timeout_ms` (default 60s). Failure semantics:
 *
 * - `after_create`: runs only when the workspace was newly created; failure is
 *   fatal to workspace creation.
 * - `before_run`: runs before each agent attempt; failure is fatal to that
 *   attempt.
 * - `after_run`: runs after each attempt; failure is logged and ignored.
 * - `before_remove`: runs before workspace deletion; failure is logged and
 *   ignored and cleanup still proceeds.
 */

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export const HOOK_NAMES: ReadonlyArray<HookName> = [
  "after_create",
  "before_run",
  "after_run",
  "before_remove",
];

export const hookScript = (config: EffectiveWorkflowConfig, hook: HookName): string | undefined => {
  switch (hook) {
    case "after_create":
      return config.hooksAfterCreate;
    case "before_run":
      return config.hooksBeforeRun;
    case "after_run":
      return config.hooksAfterRun;
    case "before_remove":
      return config.hooksBeforeRemove;
  }
};

export interface HookRunner {
  readonly run: (input: {
    readonly cwd: string;
    readonly config: EffectiveWorkflowConfig;
    readonly hook: HookName;
  }) => Effect.Effect<void, Error>;
}

/**
 * Run a hook script if configured. `fatal` controls whether a failure is
 * surfaced to the caller (`after_create`, `before_run`) or swallowed and logged
 * (`after_run`, `before_remove`).
 */
export const runHook =
  (
    runner: HookRunner,
  ): ((input: {
    readonly cwd: string;
    readonly config: EffectiveWorkflowConfig;
    readonly hook: HookName;
    readonly fatal: boolean;
  }) => Effect.Effect<void, Error>) =>
  (input) => {
    const script = hookScript(input.config, input.hook);
    if (script === undefined || script.trim().length === 0) {
      return Effect.void;
    }
    const effect = runner.run({
      cwd: input.cwd,
      config: input.config,
      hook: input.hook,
    });
    return input.fatal ? effect : effect.pipe(Effect.catch(() => Effect.void));
  };
