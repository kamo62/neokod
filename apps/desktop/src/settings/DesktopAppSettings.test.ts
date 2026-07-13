import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

const DesktopSettingsPatch = Schema.Struct({
  updateChannel: Schema.optionalKey(Schema.Literals(["latest", "nightly"])),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  wslBackendEnabled: Schema.optionalKey(Schema.Boolean),
  wslMode: Schema.optionalKey(Schema.Literals(["local", "wsl"])),
  wslDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  wslOnly: Schema.optionalKey(Schema.Boolean),
});

const encodeDesktopSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(DesktopSettingsPatch));

function makeEnvironmentLayer(baseDir: string, appVersion = "0.0.17") {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
}

const withSettings = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopAppSettings.DesktopAppSettings | DesktopEnvironment.DesktopEnvironment
  >,
  options?: { readonly appVersion?: string },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-settings-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(makeEnvironmentLayer(baseDir, options?.appVersion)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

function writeSettingsPatch(patch: typeof DesktopSettingsPatch.Type) {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* encodeDesktopSettingsPatch(patch);
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(environment.desktopSettingsPath, `${encoded}\n`);
  });
}

describe("DesktopSettings", () => {
  it.effect("loads local defaults when no settings file exists", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it("defaults packaged nightly builds to the nightly update channel", () => {
    assert.deepEqual(
      DesktopAppSettings.resolveDefaultDesktopSettings("0.0.17-nightly.20260415.1"),
      {
        updateChannel: "nightly",
        updateChannelConfiguredByUser: false,
        wslBackendEnabled: false,
        wslOnly: false,
        wslDistro: null,
      } satisfies DesktopAppSettings.DesktopSettings,
    );
  });

  it.effect("persists update and WSL settings", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const channel = yield* settings.setUpdateChannel("nightly");
        const enabled = yield* settings.setWslBackendEnabled(true);
        const distro = yield* settings.setWslDistro("Ubuntu-22.04");

        assert.isTrue(channel.changed);
        assert.isTrue(enabled.changed);
        assert.equal(distro.settings.wslDistro, "Ubuntu-22.04");
        assert.equal((yield* settings.load).wslBackendEnabled, true);
      }),
    ),
  );

  it.effect("ignores removed keys in lenient settings documents", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.desktopSettingsPath,
          `{ "retiredNetworkMode": "public", "updateChannel": "nightly" }\n`,
        );

        assert.equal((yield* settings.load).updateChannel, "nightly");
        yield* settings.setWslBackendEnabled(true);
        assert.notInclude(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
          "retiredNetworkMode",
        );
      }),
    ),
  );

  it.effect("reports failed settings writes", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.desktopSettingsPath, { recursive: true });

        const error = yield* settings.setUpdateChannel("nightly").pipe(Effect.flip);
        assert.instanceOf(error, DesktopAppSettings.DesktopSettingsWriteError);
        assert.equal(error.operation, "replace-settings-file");
        assert.equal(error.path, environment.desktopSettingsPath);
      }),
    ),
  );

  it.effect("migrates the legacy WSL mode", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({ wslMode: "wsl", wslDistro: "Ubuntu-22.04" });

        const loaded = yield* settings.load;
        assert.equal(loaded.wslBackendEnabled, true);
        assert.equal(loaded.wslDistro, "Ubuntu-22.04");
      }),
    ),
  );

  it.effect("applies persisted and in-memory WSL fallbacks", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);

        const persisted = yield* settings.applyWslWindowsFallback;
        assert.equal(persisted.settings.wslBackendEnabled, false);
        assert.equal(persisted.settings.wslOnly, false);

        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);
        const volatile = yield* settings.applyWslWindowsFallbackInMemory;
        assert.equal(volatile.settings.wslBackendEnabled, false);
        assert.equal((yield* settings.load).wslOnly, true);
      }),
    ),
  );
});
