import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { DesktopBackendBootstrap } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { CliServerFlags } from "./config.ts";
import { resolveServerConfig } from "./config.ts";
import { isServerBindAuthorized } from "../config.ts";

const encodeDesktopBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const emptyFlags: CliServerFlags = {
  mode: Option.none(),
  port: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
};

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const openBootstrapFd = Effect.fn(function* (transport: "loopback" | "wsl-bearer") {
    const fileSystem = yield* FileSystem.FileSystem;
    const filePath = yield* fileSystem.makeTempFileScoped({
      prefix: "t3-bootstrap-",
      suffix: ".ndjson",
    });
    const bootstrap: DesktopBackendBootstrap =
      transport === "loopback"
        ? {
            mode: "desktop",
            noBrowser: true,
            port: 4888,
            transport: "loopback",
            host: "127.0.0.1",
            desktopBootstrapToken: "desktop-bootstrap-token",
          }
        : {
            mode: "desktop",
            noBrowser: true,
            port: 4888,
            transport: "wsl-bearer",
            host: "0.0.0.0",
            desktopBootstrapToken: "desktop-bootstrap-token",
          };
    const encoded = yield* encodeDesktopBootstrap(bootstrap);
    yield* fileSystem.writeFileString(filePath, `${encoded}\n`);
    return (yield* fileSystem.open(filePath, { flag: "r" })).fd;
  });

  it.effect("binds public startup to loopback", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.join(NodeOS.tmpdir(), "t3-cli-loopback-env");
      const resolved = yield* resolveServerConfig(emptyFlags, Option.none()).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_HOME: baseDir,
                  T3CODE_PORT: "4001",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.host).toBe("127.0.0.1");
      expect(resolved.transport).toBe("loopback");
      expect(resolved.port).toBe(4001);
    }),
  );

  it.effect("honors ordinary CLI flags without exposing a host override", () =>
    Effect.gen(function* () {
      const baseDir = `${NodeOS.tmpdir()}/t3-cli-flags`;
      const resolved = yield* resolveServerConfig(
        {
          ...emptyFlags,
          mode: Option.some("desktop"),
          port: Option.some(4555),
          baseDir: Option.some(baseDir),
          noBrowser: Option.some(false),
          logWebSocketEvents: Option.some(true),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv()), NetService.layer),
        ),
      );

      expect(resolved).toMatchObject({
        mode: "desktop",
        port: 4555,
        host: "127.0.0.1",
        noBrowser: false,
        logLevel: "Debug",
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("accepts the authenticated desktop WSL bootstrap wildcard", () =>
    Effect.gen(function* () {
      const fd = yield* openBootstrapFd("wsl-bearer");
      const resolved = yield* resolveServerConfig(
        { ...emptyFlags, bootstrapFd: Option.some(fd) },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv()), NetService.layer),
        ),
      );

      expect(resolved).toMatchObject({
        mode: "desktop",
        port: 4888,
        transport: "wsl-bearer",
        host: "0.0.0.0",
        desktopBootstrapToken: "desktop-bootstrap-token",
      });
    }),
  );

  it.effect("accepts the desktop primary loopback bootstrap", () =>
    Effect.gen(function* () {
      const fd = yield* openBootstrapFd("loopback");
      const resolved = yield* resolveServerConfig(
        { ...emptyFlags, bootstrapFd: Option.some(fd) },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv()), NetService.layer),
        ),
      );

      expect(resolved.host).toBe("127.0.0.1");
      expect(resolved.transport).toBe("loopback");
      expect(resolved.desktopBootstrapToken).toBe("desktop-bootstrap-token");
    }),
  );

  it("fails closed for wildcard binds without the WSL transport and credential", () => {
    expect(
      isServerBindAuthorized({
        host: "0.0.0.0",
        transport: "loopback",
        desktopBootstrapToken: "desktop-bootstrap-token",
      }),
    ).toBe(false);
    expect(
      isServerBindAuthorized({
        host: "0.0.0.0",
        transport: "wsl-bearer",
        desktopBootstrapToken: undefined,
      }),
    ).toBe(false);
  });

  it.effect("creates derived runtime directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cli-paths-" });
      const resolved = yield* resolveServerConfig(
        { ...emptyFlags, baseDir: Option.some(baseDir), port: Option.some(4777) },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv()), NetService.layer),
        ),
      );

      assert.isTrue(yield* fileSystem.exists(resolved.logsDir));
      assert.isTrue(yield* fileSystem.exists(resolved.attachmentsDir));
      assert.isTrue(yield* fileSystem.exists(resolved.worktreesDir));
    }),
  );

  it.effect("forces noninteractive settings for headless serve", () =>
    Effect.gen(function* () {
      const baseDir = `${NodeOS.tmpdir()}/t3-cli-headless`;
      const resolved = yield* resolveServerConfig(
        { ...emptyFlags, baseDir: Option.some(baseDir) },
        Option.none(),
        { startupPresentation: "headless" },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_NO_BROWSER: "false",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.host).toBe("127.0.0.1");
      expect(resolved.noBrowser).toBe(true);
      expect(resolved.autoBootstrapProjectFromCwd).toBe(false);
    }),
  );
});
