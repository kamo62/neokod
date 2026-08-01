import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { hydratePosixPath } from "./os-jank.ts";

const HOME_DIR = "/home/tester";
const USER_CLI_DIRS = `${HOME_DIR}/.local/bin:${HOME_DIR}/bin:${HOME_DIR}/.opencode/bin`;

describe("hydratePosixPath", () => {
  it.effect("fills a missing HOME from the resolved home directory", () =>
    Effect.sync(() => {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

      hydratePosixPath(env, "linux", {
        readShellPath: () => undefined,
        resolveHomeDirectory: () => HOME_DIR,
      });

      expect(env.HOME).toBe(HOME_DIR);
    }),
  );

  it.effect("keeps an existing HOME untouched", () =>
    Effect.sync(() => {
      const env: NodeJS.ProcessEnv = { HOME: "/home/existing", PATH: "/usr/bin" };

      hydratePosixPath(env, "linux", {
        readShellPath: () => undefined,
        resolveHomeDirectory: () => HOME_DIR,
      });

      expect(env.HOME).toBe("/home/existing");
    }),
  );

  it.effect(
    "appends the user CLI directories after the inherited PATH under a minimal systemd environment",
    () =>
      Effect.sync(() => {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

        hydratePosixPath(env, "linux", {
          readShellPath: () => undefined,
          resolveHomeDirectory: () => HOME_DIR,
        });

        expect(env.PATH).toBe(`/usr/bin:/bin:${USER_CLI_DIRS}`);
      }),
  );

  it.effect("keeps login shell PATH first, then inherited PATH, then user CLI directories", () =>
    Effect.sync(() => {
      const env: NodeJS.ProcessEnv = { HOME: HOME_DIR, PATH: "/usr/bin:/bin" };

      hydratePosixPath(env, "linux", {
        readShellPath: () => "/opt/tools/bin:/usr/bin",
        resolveHomeDirectory: () => HOME_DIR,
      });

      expect(env.PATH).toBe(`/opt/tools/bin:/usr/bin:/bin:${USER_CLI_DIRS}`);
    }),
  );

  it.effect("does not duplicate user CLI directories the login shell already provides", () =>
    Effect.sync(() => {
      const env: NodeJS.ProcessEnv = { HOME: HOME_DIR, PATH: "/usr/bin" };

      hydratePosixPath(env, "linux", {
        readShellPath: () => `${HOME_DIR}/.local/bin:/usr/bin`,
        resolveHomeDirectory: () => HOME_DIR,
      });

      expect(env.PATH).toBe(
        `${HOME_DIR}/.local/bin:/usr/bin:${HOME_DIR}/bin:${HOME_DIR}/.opencode/bin`,
      );
    }),
  );

  it.effect("leaves a fully hydrated desktop PATH unchanged", () =>
    Effect.sync(() => {
      const desktopPath = `/opt/homebrew/bin:/usr/bin:/bin:${USER_CLI_DIRS}`;
      const env: NodeJS.ProcessEnv = { HOME: HOME_DIR, PATH: desktopPath };

      hydratePosixPath(env, "darwin", {
        readShellPath: () => desktopPath,
        readLaunchctlPath: () => undefined,
        resolveHomeDirectory: () => HOME_DIR,
      });

      expect(env.PATH).toBe(desktopPath);
    }),
  );

  it.effect("leaves PATH and HOME unchanged when the home directory cannot be resolved", () =>
    Effect.sync(() => {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

      hydratePosixPath(env, "linux", {
        readShellPath: () => undefined,
        resolveHomeDirectory: () => {
          throw new Error("no passwd entry");
        },
      });

      expect(env.HOME).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");
    }),
  );
});
