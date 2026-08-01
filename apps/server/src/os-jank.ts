import { HostProcessEnvironment, HostProcessPlatform } from "@neokod/shared/hostProcess";
import { resolveNeokodHome } from "@neokod/shared/neokodHome";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveKnownPosixCliDirs,
  resolveWindowsEnvironment,
} from "@neokod/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

export interface PosixPathHydrationHooks {
  readonly readShellPath?: (shell: string) => string | undefined;
  readonly readLaunchctlPath?: () => string | undefined;
  readonly resolveHomeDirectory?: () => string;
}

function resolveHomeDirectory(env: NodeJS.ProcessEnv, fallback: () => string): string | undefined {
  const configured = env.HOME?.trim();
  if (configured) return configured;
  try {
    return fallback();
  } catch (error) {
    logPathHydrationWarning("Failed to resolve the home directory.", error);
    return undefined;
  }
}

export function hydratePosixPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  hooks: PosixPathHydrationHooks = {},
): void {
  const readShellPath = hooks.readShellPath ?? readPathFromLoginShell;
  const readLaunchctl = hooks.readLaunchctlPath ?? readPathFromLaunchctl;

  // systemd units get a minimal environment without HOME. Fill it from the
  // passwd database before probing the login shell: distro profiles guard the
  // user bin directories with checks like `[ -d "$HOME/.local/bin" ]`, and
  // provider CLIs read auth state from paths under the home directory.
  const homeDirectory = resolveHomeDirectory(env, hooks.resolveHomeDirectory ?? NodeOS.homedir);
  if (homeDirectory && !env.HOME?.trim()) {
    env.HOME = homeDirectory;
  }

  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = readShellPath(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readLaunchctl() : undefined;
  const hydratedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  // User-level CLI directories go last so they are only consulted when nothing
  // earlier on PATH provides the binary; a user-writable directory can never
  // shadow an executable that already resolves.
  const userCliPath = homeDirectory ? resolveKnownPosixCliDirs(homeDirectory).join(":") : undefined;
  const mergedPath = mergePathEntries(hydratedPath ?? env.PATH, userCliPath, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (): Effect.fn.Return<
  void,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { resolve } = yield* Path.Path;
  if (raw?.trim()) {
    return resolve(yield* expandHomePath(raw.trim()));
  }
  return yield* resolveNeokodHome({
    configuredHome: undefined,
    homeDirectory: NodeOS.homedir(),
    onWarning: (message) => process.stderr.write(`[server] ${message}\n`),
  });
});
