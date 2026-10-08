import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { DesktopBackendBootstrap } from "@neokod/contracts";
import * as NetService from "@neokod/shared/Net";
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
  publicHost: Option.none(),
  publicOrigin: Option.none(),
  strictTransport: Option.none(),
  accessTokenFile: Option.none(),
};

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const openBootstrapFd = Effect.fn(function* (transport: "loopback" | "wsl-bearer") {
    const fileSystem = yield* FileSystem.FileSystem;
    const filePath = yield* fileSystem.makeTempFileScoped({
      prefix: "neokod-bootstrap-",
      suffix: ".ndjson",
    });
    const bootstrap: DesktopBackendBootstrap =
      transport === "loopback"
        ? {
            mode: "desktop",
            noBrowser: true,
            otlpTracesUrl: "http://bootstrap.test/v1/traces",
            otlpMetricsUrl: "http://bootstrap.test/v1/metrics",
            port: 4888,
            transport: "loopback",
            host: "127.0.0.1",
          }
        : {
            mode: "desktop",
            noBrowser: true,
            port: 4888,
            transport: "wsl-bearer",
            host: "0.0.0.0",
            wslBearerToken: "wsl-bearer-token",
          };
    const encoded = yield* encodeDesktopBootstrap(bootstrap);
    yield* fileSystem.writeFileString(filePath, `${encoded}\n`);
    return (yield* fileSystem.open(filePath, { flag: "r" })).fd;
  });

  it.effect("binds public startup to loopback", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.join(NodeOS.tmpdir(), "neokod-cli-loopback-env");
      const resolved = yield* resolveServerConfig(emptyFlags, Option.none()).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NEOKOD_HOME: baseDir,
                  NEOKOD_PORT: "4001",
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

  it.effect(
    "web mode has a stable access token; strict-transport only toggles Host/Origin validation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-cli-access-token-" });
          const env = Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEOKOD_HOME: baseDir } })),
            NetService.layer,
          );

          const first = yield* resolveServerConfig(
            { ...emptyFlags, mode: Option.some("web") },
            Option.none(),
          ).pipe(Effect.provide(env));
          expect(typeof first.loopbackAuthToken).toBe("string");
          expect((first.loopbackAuthToken as string).length).toBeGreaterThanOrEqual(32);
          expect(first.accessTokenSource).toBe("generated");
          expect(first.strictTransport).toBe(false);
          const tokenPath = path.join(baseDir, "access-token");
          expect((yield* fs.stat(tokenPath)).mode & 0o777).toBe(0o600);

          const second = yield* resolveServerConfig(
            { ...emptyFlags, mode: Option.some("web") },
            Option.none(),
          ).pipe(Effect.provide(env));
          expect(second.loopbackAuthToken).toBe(first.loopbackAuthToken);
          expect(second.accessTokenSource).toBe("default-file");

          const strict = yield* resolveServerConfig(
            { ...emptyFlags, mode: Option.some("web"), strictTransport: Option.some(true) },
            Option.none(),
          ).pipe(Effect.provide(env));
          expect(strict.loopbackAuthToken).toBe(first.loopbackAuthToken);
          expect(strict.strictTransport).toBe(true);
        }),
      ),
  );

  it.effect("NEOKOD_ACCESS_TOKEN wins over the default file and creates no file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-cli-access-token-" });
        const env = Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { NEOKOD_HOME: baseDir, NEOKOD_ACCESS_TOKEN: "e".repeat(32) },
            }),
          ),
          NetService.layer,
        );
        const resolved = yield* resolveServerConfig(
          { ...emptyFlags, mode: Option.some("web") },
          Option.none(),
        ).pipe(Effect.provide(env));
        expect(resolved.loopbackAuthToken).toBe("e".repeat(32));
        expect(resolved.accessTokenSource).toBe("env");
        expect(yield* fs.exists(path.join(baseDir, "access-token"))).toBe(false);
      }),
    ),
  );

  it.effect("--access-token-file wins over env", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-cli-access-token-" });
        const flagPath = path.join(dir, "flag-token");
        yield* fs.writeFileString(flagPath, "f".repeat(40));
        const env = Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { NEOKOD_HOME: dir, NEOKOD_ACCESS_TOKEN: "e".repeat(32) },
            }),
          ),
          NetService.layer,
        );
        const resolved = yield* resolveServerConfig(
          { ...emptyFlags, mode: Option.some("web"), accessTokenFile: Option.some(flagPath) },
          Option.none(),
        ).pipe(Effect.provide(env));
        expect(resolved.loopbackAuthToken).toBe("f".repeat(40));
        expect(resolved.accessTokenSource).toBe("flag-file");
      }),
    ),
  );

  it.effect("a too-short NEOKOD_ACCESS_TOKEN fails startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-cli-access-token-" });
        const env = Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { NEOKOD_HOME: baseDir, NEOKOD_ACCESS_TOKEN: "short" } }),
          ),
          NetService.layer,
        );
        const error = yield* Effect.flip(
          resolveServerConfig({ ...emptyFlags, mode: Option.some("web") }, Option.none()).pipe(
            Effect.provide(env),
          ),
        );
        expect(error._tag).toBe("AccessTokenError");
      }),
    ),
  );

  it.effect("desktop mode without a bootstrap token generates no token and no file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-cli-access-token-" });
        const env = Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEOKOD_HOME: baseDir } })),
          NetService.layer,
        );
        const resolved = yield* resolveServerConfig(
          { ...emptyFlags, mode: Option.some("desktop") },
          Option.none(),
        ).pipe(Effect.provide(env));
        expect(resolved.loopbackAuthToken).toBeUndefined();
        expect(yield* fs.exists(path.join(baseDir, "access-token"))).toBe(false);
      }),
    ),
  );

  it.effect("read-only policy never creates the file and reuses an existing one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-cli-access-token-" });
        const env = Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEOKOD_HOME: baseDir } })),
          NetService.layer,
        );
        const missing = yield* resolveServerConfig(
          { ...emptyFlags, mode: Option.some("web") },
          Option.none(),
          { accessTokenPolicy: "read-only" },
        ).pipe(Effect.provide(env));
        expect(missing.loopbackAuthToken).toBeUndefined();
        expect(yield* fs.exists(path.join(baseDir, "access-token"))).toBe(false);
        yield* fs.writeFileString(path.join(baseDir, "access-token"), "d".repeat(40));
        const reused = yield* resolveServerConfig(
          { ...emptyFlags, mode: Option.some("web") },
          Option.none(),
          { accessTokenPolicy: "read-only" },
        ).pipe(Effect.provide(env));
        expect(reused.loopbackAuthToken).toBe("d".repeat(40));
        expect(reused.accessTokenSource).toBe("default-file");
      }),
    ),
  );

  it.effect("honors ordinary CLI flags without exposing a host override", () =>
    Effect.gen(function* () {
      const baseDir = `${NodeOS.tmpdir()}/neokod-cli-flags`;
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
        wslBearerToken: "wsl-bearer-token",
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
      expect(resolved.wslBearerToken).toBeUndefined();
    }),
  );

  it.effect("uses bootstrap values before new and legacy environment values", () =>
    Effect.gen(function* () {
      const fd = yield* openBootstrapFd("loopback");
      const resolved = yield* resolveServerConfig(
        { ...emptyFlags, bootstrapFd: Option.some(fd) },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NEOKOD_MODE: "web",
                  T3CODE_MODE: "desktop",
                  NEOKOD_PORT: "4999",
                  T3CODE_PORT: "4998",
                  NEOKOD_HOME: `${NodeOS.tmpdir()}/neokod-precedence`,
                  T3CODE_HOME: `${NodeOS.tmpdir()}/legacy-precedence`,
                  NEOKOD_NO_BROWSER: "false",
                  T3CODE_NO_BROWSER: "true",
                  NEOKOD_OTLP_TRACES_URL: "http://neokod.test/v1/traces",
                  T3CODE_OTLP_TRACES_URL: "http://legacy.test/v1/traces",
                  NEOKOD_OTLP_METRICS_URL: "http://neokod.test/v1/metrics",
                  T3CODE_OTLP_METRICS_URL: "http://legacy.test/v1/metrics",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toMatchObject({ mode: "desktop", port: 4888, noBrowser: true });
      expect(resolved.baseDir).toBe(`${NodeOS.tmpdir()}/neokod-precedence`);
      expect(resolved.otlpTracesUrl).toBe("http://bootstrap.test/v1/traces");
      expect(resolved.otlpMetricsUrl).toBe("http://bootstrap.test/v1/metrics");
    }),
  );

  it.effect("uses legacy environment values when Neokod values are absent", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveServerConfig(emptyFlags, Option.none()).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_MODE: "desktop",
                  T3CODE_PORT: "4998",
                  T3CODE_HOME: `${NodeOS.tmpdir()}/legacy-fallback`,
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_OTLP_TRACES_URL: "http://legacy.test/v1/traces",
                  T3CODE_OTLP_METRICS_URL: "http://legacy.test/v1/metrics",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toMatchObject({ mode: "desktop", port: 4998, noBrowser: true });
      expect(resolved.baseDir).toBe(`${NodeOS.tmpdir()}/legacy-fallback`);
      expect(resolved.otlpTracesUrl).toBe("http://legacy.test/v1/traces");
      expect(resolved.otlpMetricsUrl).toBe("http://legacy.test/v1/metrics");
    }),
  );

  it.effect("prefers Neokod OTLP environment values and reads legacy fallbacks", () =>
    Effect.forEach(
      [
        {
          env: {
            T3CODE_OTLP_TRACES_URL: "http://legacy.test/v1/traces",
            T3CODE_OTLP_METRICS_URL: "http://legacy.test/v1/metrics",
          },
          traces: "http://legacy.test/v1/traces",
          metrics: "http://legacy.test/v1/metrics",
        },
        {
          env: {
            NEOKOD_OTLP_TRACES_URL: "http://neokod.test/v1/traces",
            T3CODE_OTLP_TRACES_URL: "http://legacy.test/v1/traces",
            NEOKOD_OTLP_METRICS_URL: "http://neokod.test/v1/metrics",
            T3CODE_OTLP_METRICS_URL: "http://legacy.test/v1/metrics",
          },
          traces: "http://neokod.test/v1/traces",
          metrics: "http://neokod.test/v1/metrics",
        },
      ],
      ({ env, traces, metrics }) =>
        Effect.map(
          resolveServerConfig(emptyFlags, Option.none()).pipe(
            Effect.provide(
              Layer.mergeAll(
                ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
                NetService.layer,
              ),
            ),
          ),
          (resolved) => {
            expect(resolved.otlpTracesUrl).toBe(traces);
            expect(resolved.otlpMetricsUrl).toBe(metrics);
          },
        ),
    ),
  );

  it("fails closed for wildcard binds without the WSL transport and credential", () => {
    expect(
      isServerBindAuthorized({
        host: "0.0.0.0",
        transport: "loopback",
        wslBearerToken: undefined,
      }),
    ).toBe(false);
    expect(
      isServerBindAuthorized({
        host: "0.0.0.0",
        transport: "wsl-bearer",
        wslBearerToken: undefined,
      }),
    ).toBe(false);
  });

  it.effect("creates derived runtime directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "neokod-cli-paths-" });
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
      const baseDir = `${NodeOS.tmpdir()}/neokod-cli-headless`;
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
                  NEOKOD_NO_BROWSER: "false",
                  NEOKOD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
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
