import type { EffectiveWorkflowConfig, NormalizedIssue, WorkspaceKey } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { deriveWorkspaceKey, deriveWorkingBranch } from "../Domain/Keys.ts";
import type { HookName } from "./Hooks.ts";

/**
 * Workspace manager (SPEC 9, PRD FR-030 to 035).
 *
 * Creates deterministic, isolated per-issue workspaces as git worktrees under a
 * configured workspace root, derives a deterministic working branch, and runs
 * lifecycle hooks. Enforces the containment invariants (SPEC 9.5): the agent
 * runs only in the workspace, the workspace stays under the workspace root
 * (with symlinks resolved), and the workspace key is sanitized.
 */

export interface SymphonyWorkspace {
  readonly key: WorkspaceKey;
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly createdNow: boolean;
}

export class WorkspaceOutsideRootError extends Error {
  readonly path: string;
  readonly root: string;

  constructor(path: string, root: string) {
    super(`Workspace path ${path} is outside workspace root ${root}`);
    this.name = "WorkspaceOutsideRootError";
    this.path = path;
    this.root = root;
  }
}

export class WorkspacePopulationError extends Error {
  readonly key: string;
  readonly detail: string;

  constructor(key: string, detail: string) {
    super(`Workspace population failed for ${key}: ${detail}`);
    this.name = "WorkspacePopulationError";
    this.key = key;
    this.detail = detail;
  }
}

/**
 * Pure containment check (SPEC 9.5 invariant 2). Requires the workspace path to
 * be a strict descendant of the root after normalizing trailing slashes. The
 * `realpath` symlink resolution happens in the live layer before this runs.
 */
export const isPathInsideRoot = (workspacePath: string, root: string): boolean => {
  const normalizedWorkspace = workspacePath.replace(/\/+$/, "");
  const normalizedRoot = root.replace(/\/+$/, "");
  if (normalizedWorkspace === normalizedRoot) {
    return false;
  }
  return (
    normalizedWorkspace.startsWith(`${normalizedRoot}/`) ||
    normalizedWorkspace.startsWith(`${normalizedRoot}\\`)
  );
};

export class WorkspaceManager extends Context.Service<
  WorkspaceManager,
  {
    /**
     * Ensure the per-issue workspace exists as a git worktree. Returns the
     * workspace with `createdNow` true when it was created by this call (which
     * gates the `after_create` hook).
     */
    readonly ensureWorkspace: (input: {
      readonly issue: NormalizedIssue;
      readonly config: EffectiveWorkflowConfig;
      readonly trackerBranch?: string;
    }) => Effect.Effect<SymphonyWorkspace, WorkspaceOutsideRootError | WorkspacePopulationError>;

    /** Remove the workspace and its worktree when terminal (SPEC 8.6, 8.5). */
    readonly removeWorkspace: (input: {
      readonly workspace: SymphonyWorkspace;
      readonly config: EffectiveWorkflowConfig;
      readonly force?: boolean;
    }) => Effect.Effect<void>;

    /** Resolve the absolute workspace path for a key under the configured root. */
    readonly resolvePath: (key: WorkspaceKey, config: EffectiveWorkflowConfig) => string;
  }
>()("neokod/symphony/Workspaces/WorkspaceManager") {}

export interface WorkspaceManagerDeps {
  readonly git: GitVcsDriver["Service"];
  /** Resolve the repository's default base branch. */
  readonly defaultBranch: (cwd: string) => Effect.Effect<string, Error>;
  readonly runHook: (input: {
    readonly cwd: string;
    readonly config: EffectiveWorkflowConfig;
    readonly hook: HookName;
  }) => Effect.Effect<void, Error>;
  readonly ensureDir: (path: string) => Effect.Effect<void, Error>;
  readonly pathExists: (path: string) => Effect.Effect<boolean>;
  /** Resolve symlinks so a symlinked workspace cannot escape the root. */
  readonly realpath: (path: string) => Effect.Effect<string, Error>;
}

export const makeWorkspaceManager = (deps: WorkspaceManagerDeps): WorkspaceManager["Service"] => {
  const resolvePath = (key: WorkspaceKey, config: EffectiveWorkflowConfig): string => {
    const root = config.workspaceRoot.replace(/\/+$/, "");
    return `${root}/${key}`;
  };

  const ensureWorkspace: WorkspaceManager["Service"]["ensureWorkspace"] = (input) =>
    Effect.gen(function* () {
      const config = input.config;
      const root = config.workspaceRoot.replace(/\/+$/, "");
      if (root.length === 0) {
        return yield* Effect.fail(
          new WorkspacePopulationError(input.issue.identifier, "workspace.root is not configured"),
        );
      }
      const key = deriveWorkspaceKey(input.issue.identifier);
      const rawPath = resolvePath(key, config);

      // Containment invariant: resolve symlinks then require the path under root.
      const resolvedPath = yield* deps
        .realpath(rawPath)
        .pipe(Effect.catch(() => Effect.succeed(rawPath)));
      if (!isPathInsideRoot(resolvedPath, root)) {
        return yield* Effect.fail(new WorkspaceOutsideRootError(resolvedPath, root));
      }

      const baseBranch = yield* deps
        .defaultBranch(config.repositoryPath)
        .pipe(Effect.catch(() => Effect.succeed("main")));
      const branch = input.trackerBranch ?? deriveWorkingBranch(key);

      const exists = yield* deps
        .pathExists(resolvedPath)
        .pipe(Effect.catch(() => Effect.succeed(false)));

      if (exists) {
        // Reuse the workspace across retries (PRD FR-032).
        return { key, path: resolvedPath, branch, baseBranch, createdNow: false };
      }

      yield* deps
        .ensureDir(resolvedPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspacePopulationError(key, `Failed to create directory: ${cause.message}`),
          ),
        );

      yield* deps.git
        .createWorktree({
          cwd: config.repositoryPath,
          refName: branch,
          baseRefName: baseBranch,
          path: resolvedPath,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspacePopulationError(key, `git worktree add failed: ${cause.message}`),
          ),
        );

      // after_create is fatal to workspace creation (SPEC 9.4).
      yield* deps
        .runHook({ cwd: resolvedPath, config, hook: "after_create" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspacePopulationError(key, `after_create hook failed: ${cause.message}`),
          ),
        );

      return { key, path: resolvedPath, branch, baseBranch, createdNow: true };
    });

  const removeWorkspace: WorkspaceManager["Service"]["removeWorkspace"] = (input) =>
    Effect.gen(function* () {
      // before_remove is non-fatal: cleanup still proceeds on failure (SPEC 9.4).
      yield* deps
        .runHook({ cwd: input.workspace.path, config: input.config, hook: "before_remove" })
        .pipe(Effect.catch(() => Effect.void));
      yield* deps.git
        .removeWorktree({
          cwd: input.config.repositoryPath,
          path: input.workspace.path,
          force: input.force,
        })
        .pipe(Effect.catch(() => Effect.void));
    });

  return {
    ensureWorkspace,
    removeWorkspace,
    resolvePath,
  };
};
