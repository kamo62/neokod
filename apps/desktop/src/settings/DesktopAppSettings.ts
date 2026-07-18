import type { DesktopUpdateChannel } from "@neokod/contracts";
import { fromLenientJson } from "@neokod/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDefaultDesktopUpdateChannel } from "../updates/updateChannels.ts";
import { isValidDistroName } from "../wsl/wslPathParsing.ts";

export interface DesktopSettings {
  readonly updateChannel: DesktopUpdateChannel;
  // Was a "local" | "wsl" swap mode in an earlier iteration of the WSL
  // integration. We now run Windows and WSL backends side by side, so the
  // setting is just whether the WSL backend should be running alongside the
  // primary. Persisted documents that still carry the legacy `wslMode: "wsl"`
  // value are migrated to `wslBackendEnabled: true` on load.
  readonly wslBackendEnabled: boolean;
  readonly wslDistro: string | null;
  // When true (and wslBackendEnabled is also true) the desktop runs only
  // the WSL backend as the primary, and the Windows-side Node backend is
  // not started. Designed for users who develop entirely inside WSL and
  // don't want a second backend process running. Defaults to false so
  // existing setups stay on the parallel-backends behavior. Changing
  // this requires a desktop restart because the pool's primary spec is
  // chosen once at layer init.
  readonly wslOnly: boolean;
}

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  updateChannel: "latest",
  wslBackendEnabled: false,
  wslDistro: null,
  wslOnly: false,
};

const DesktopSettingsDocument = Schema.Struct({
  // Accept the retired value so loading an existing document can normalize it.
  updateChannel: Schema.optionalKey(Schema.Literals(["latest", "nightly"])),
  // Newer form of the WSL toggle. `wslMode` is still accepted on load so
  // existing on-disk settings keep working; on the next persist we write the
  // new boolean and the legacy key drops out.
  wslBackendEnabled: Schema.optionalKey(Schema.Boolean),
  wslMode: Schema.optionalKey(Schema.Literals(["local", "wsl"])),
  wslDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  wslOnly: Schema.optionalKey(Schema.Boolean),
});

type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DesktopSettingsJson = fromLenientJson(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeEffect(DesktopSettingsJson);

const settingsChange = (settings: DesktopSettings, changed: boolean): DesktopSettingsChange => ({
  settings,
  changed,
});

const DesktopSettingsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);
type DesktopSettingsWriteOperation = typeof DesktopSettingsWriteOperation.Type;

export class DesktopSettingsWriteError extends Schema.TaggedErrorClass<DesktopSettingsWriteError>()(
  "DesktopSettingsWriteError",
  {
    operation: DesktopSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopAppSettings extends Context.Service<
  DesktopAppSettings,
  {
    readonly load: Effect.Effect<DesktopSettings>;
    readonly get: Effect.Effect<DesktopSettings>;
    readonly setWslBackendEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setWslDistro: (
      distro: string | null,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setWslOnly: (
      enabled: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly applyWslWindowsFallback: Effect.Effect<
      DesktopSettingsChange,
      DesktopSettingsWriteError
    >;
    readonly applyWslWindowsFallbackInMemory: Effect.Effect<DesktopSettingsChange>;
  }
>()("@neokod/desktop/settings/DesktopAppSettings") {}

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}

function normalizeWslDistro(value: unknown): string | null {
  return typeof value === "string" && isValidDistroName(value) ? value : null;
}

function normalizeDesktopSettingsDocument(
  parsed: DesktopSettingsDocument,
  appVersion: string,
): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  // Newer form wins when both are present; otherwise fall back to the legacy
  // `wslMode === "wsl"` signal so users coming off the swap-mode build keep
  // their WSL backend enabled.
  const wslBackendEnabled =
    parsed.wslBackendEnabled === true ||
    (parsed.wslBackendEnabled === undefined && parsed.wslMode === "wsl");

  return {
    updateChannel: defaultSettings.updateChannel,
    wslBackendEnabled,
    wslDistro: normalizeWslDistro(parsed.wslDistro),
    wslOnly: parsed.wslOnly === true,
  };
}

function toDesktopSettingsDocument(
  settings: DesktopSettings,
  defaults: DesktopSettings,
): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};

  if (settings.wslBackendEnabled !== defaults.wslBackendEnabled) {
    document.wslBackendEnabled = settings.wslBackendEnabled;
  }
  if (settings.wslDistro !== defaults.wslDistro) {
    document.wslDistro = settings.wslDistro;
  }
  if (settings.wslOnly !== defaults.wslOnly) {
    document.wslOnly = settings.wslOnly;
  }

  return document;
}

function setWslBackendEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslBackendEnabled === enabled
    ? settings
    : {
        ...settings,
        wslBackendEnabled: enabled,
      };
}

function setWslDistro(settings: DesktopSettings, distro: string | null): DesktopSettings {
  const normalized = normalizeWslDistro(distro);
  return settings.wslDistro === normalized
    ? settings
    : {
        ...settings,
        wslDistro: normalized,
      };
}

function setWslOnly(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslOnly === enabled
    ? settings
    : {
        ...settings,
        wslOnly: enabled,
      };
}

function applyWslWindowsFallback(settings: DesktopSettings): DesktopSettings {
  return setWslOnly(setWslBackendEnabled(settings, false), false);
}

function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
  appVersion: string,
): Effect.Effect<DesktopSettings> {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  return fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(defaultSettings),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map((parsed) => normalizeDesktopSettingsDocument(parsed, appVersion)),
            Effect.orElseSucceed(() => defaultSettings),
          ),
      }),
    ),
  );
}

const writeSettings = Effect.fn("desktop.settings.writeSettings")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: DesktopSettings;
  readonly defaultSettings: DesktopSettings;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopSettingsWriteError> {
  const directory = input.path.dirname(input.settingsPath);
  const tempPath = `${input.settingsPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeDesktopSettingsJson(
    toDesktopSettingsDocument(input.settings, input.defaultSettings),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "encode-document",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, input.settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "replace-settings-file",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settingsRef = yield* SynchronizedRef.make(environment.defaultDesktopSettings);

  const updateInMemory = (update: (settings: DesktopSettings) => DesktopSettings) =>
    SynchronizedRef.modify(settingsRef, (settings) => {
      const nextSettings = update(settings);
      return [settingsChange(nextSettings, nextSettings !== settings), nextSettings] as const;
    });

  const persist = (
    update: (settings: DesktopSettings) => DesktopSettings,
  ): Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError> =>
    SynchronizedRef.modifyEffect(settingsRef, (settings) => {
      const nextSettings = update(settings);
      if (nextSettings === settings) {
        return Effect.succeed([settingsChange(settings, false), settings] as const);
      }

      return crypto.randomUUIDv4.pipe(
        Effect.map((uuid) => uuid.replace(/-/g, "")),
        Effect.mapError(
          (cause) =>
            new DesktopSettingsWriteError({
              operation: "create-temporary-file-name",
              path: environment.desktopSettingsPath,
              cause,
            }),
        ),
        Effect.flatMap((suffix) =>
          writeSettings({
            fileSystem,
            path,
            settingsPath: environment.desktopSettingsPath,
            settings: nextSettings,
            defaultSettings: environment.defaultDesktopSettings,
            suffix,
          }),
        ),
        Effect.as([settingsChange(nextSettings, true), nextSettings] as const),
      );
    });

  return DesktopAppSettings.of({
    get: SynchronizedRef.get(settingsRef),
    load: Effect.gen(function* () {
      const raw = yield* fileSystem
        .readFileString(environment.desktopSettingsPath)
        .pipe(Effect.option);
      const settings = yield* readSettings(
        fileSystem,
        environment.desktopSettingsPath,
        environment.appVersion,
      );
      // Rewrite retired channel preferences immediately so nightly cannot be
      // reintroduced by a later settings write.
      if (Option.isSome(raw) && /"updateChannel"\s*:\s*"nightly"/.test(raw.value)) {
        const suffix = yield* crypto.randomUUIDv4.pipe(
          Effect.map((uuid) => uuid.replace(/-/g, "")),
          Effect.option,
        );
        if (Option.isSome(suffix)) {
          yield* writeSettings({
            fileSystem,
            path,
            settingsPath: environment.desktopSettingsPath,
            settings,
            defaultSettings: environment.defaultDesktopSettings,
            suffix: suffix.value,
          }).pipe(Effect.ignore);
        }
      }
      return yield* SynchronizedRef.setAndGet(settingsRef, settings);
    }).pipe(Effect.withSpan("desktop.settings.load")),
    setWslBackendEnabled: (enabled) =>
      persist((settings) => setWslBackendEnabled(settings, enabled)).pipe(
        Effect.withSpan("desktop.settings.setWslBackendEnabled", { attributes: { enabled } }),
      ),
    setWslDistro: (distro) =>
      persist((settings) => setWslDistro(settings, distro)).pipe(
        Effect.withSpan("desktop.settings.setWslDistro", {
          attributes: { distro: distro ?? null },
        }),
      ),
    setWslOnly: (enabled) =>
      persist((settings) => setWslOnly(settings, enabled)).pipe(
        Effect.withSpan("desktop.settings.setWslOnly", { attributes: { enabled } }),
      ),
    applyWslWindowsFallback: persist(applyWslWindowsFallback).pipe(
      Effect.withSpan("desktop.settings.applyWslWindowsFallback"),
    ),
    applyWslWindowsFallbackInMemory: updateInMemory(applyWslWindowsFallback).pipe(
      Effect.withSpan("desktop.settings.applyWslWindowsFallbackInMemory"),
    ),
  });
});

export const layer = Layer.effect(DesktopAppSettings, make);

export const layerTest = (initialSettings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) =>
  Layer.effect(
    DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* SynchronizedRef.make(initialSettings);
      const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
        SynchronizedRef.modify(settingsRef, (settings) => {
          const nextSettings = f(settings);
          return [
            {
              settings: nextSettings,
              changed: nextSettings !== settings,
            },
            nextSettings,
          ] as const;
        });

      return DesktopAppSettings.of({
        get: SynchronizedRef.get(settingsRef),
        load: SynchronizedRef.get(settingsRef),
        setWslBackendEnabled: (enabled) =>
          update((settings) => setWslBackendEnabled(settings, enabled)),
        setWslDistro: (distro) => update((settings) => setWslDistro(settings, distro)),
        setWslOnly: (enabled) => update((settings) => setWslOnly(settings, enabled)),
        applyWslWindowsFallback: update(applyWslWindowsFallback),
        applyWslWindowsFallbackInMemory: update(applyWslWindowsFallback),
      });
    }),
  );
