import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { DEFAULT_APP_ICON_VARIANT, type AppIconVariant } from "@t3tools/contracts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;

const AppPackageMetadata = Schema.Struct({
  t3codeCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

export class DesktopUserDataPathResolutionError extends Schema.TaggedErrorClass<DesktopUserDataPathResolutionError>()(
  "DesktopUserDataPathResolutionError",
  {
    legacyPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to inspect legacy desktop user-data path at "${this.legacyPath}".`;
  }
}

export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  {
    readonly resolveUserDataPath: Effect.Effect<string, DesktopUserDataPathResolutionError>;
    readonly configure: Effect.Effect<void>;
    readonly setIconVariant: (variant: AppIconVariant) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppIdentity") {}

const normalizeCommitHash = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return COMMIT_HASH_PATTERN.test(trimmed)
    ? Option.some(trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase())
    : Option.none();
};

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const commitHashCache = yield* Ref.make<Option.Option<Option.Option<string>>>(Option.none());

  const resolveConfiguredIconVariant = Effect.gen(function* () {
    const settingsService = yield* Effect.serviceOption(
      DesktopClientSettings.DesktopClientSettings,
    );
    if (Option.isNone(settingsService)) {
      return DEFAULT_APP_ICON_VARIANT;
    }
    const settings = yield* settingsService.value.get;
    return Option.match(settings, {
      onNone: () => DEFAULT_APP_ICON_VARIANT,
      onSome: (value) => value.appIconVariant,
    });
  });

  const resolveIconPaths = Effect.fn("desktop.appIdentity.resolveIconPaths")(function* (
    variant: AppIconVariant,
  ) {
    const fallback = yield* assets.iconPaths;
    const selected = yield* DesktopAssets.resolveIconVariantPaths(assets, variant).pipe(
      Effect.orElseSucceed(() => fallback),
    );
    return {
      ico: Option.isSome(selected.ico) ? selected.ico : fallback.ico,
      icns: Option.isSome(selected.icns) ? selected.icns : fallback.icns,
      png: Option.isSome(selected.png) ? selected.png : fallback.png,
    } satisfies DesktopAssets.DesktopIconPaths;
  });

  const resolveEmbeddedCommitHash = Effect.gen(function* () {
    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (value) =>
        decodeAppPackageMetadata(value).pipe(
          Effect.map((parsed) =>
            Option.fromNullishOr(parsed.t3codeCommitHash).pipe(Option.flatMap(normalizeCommitHash)),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });
  });

  const resolveAboutCommitHash = Effect.gen(function* () {
    const cached = yield* Ref.get(commitHashCache);
    if (Option.isSome(cached)) {
      return cached.value;
    }

    const override = Option.flatMap(environment.commitHashOverride, normalizeCommitHash);
    if (Option.isSome(override)) {
      yield* Ref.set(commitHashCache, Option.some(override));
      return override;
    }

    if (!environment.isPackaged) {
      const empty = Option.none<string>();
      yield* Ref.set(commitHashCache, Option.some(empty));
      return empty;
    }

    const commitHash = yield* resolveEmbeddedCommitHash;
    yield* Ref.set(commitHashCache, Option.some(commitHash));
    return commitHash;
  });

  const resolveUserDataPath = Effect.gen(function* () {
    const legacyPath = environment.path.join(
      environment.appDataDirectory,
      environment.legacyUserDataDirName,
    );
    const legacyPathExists = yield* fileSystem.exists(legacyPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopUserDataPathResolutionError({
            legacyPath,
            cause,
          }),
      ),
    );
    return legacyPathExists
      ? legacyPath
      : environment.path.join(environment.appDataDirectory, environment.userDataDirName);
  }).pipe(Effect.withSpan("desktop.appIdentity.resolveUserDataPath"));

  const setIconVariant = Effect.fn("desktop.appIdentity.setIconVariant")(function* (
    variant: AppIconVariant,
  ) {
    if (environment.platform !== "darwin") {
      return;
    }

    const iconPaths = yield* resolveIconPaths(variant);
    yield* Option.match(iconPaths.png, {
      onNone: () => Effect.void,
      onSome: electronApp.setDockIcon,
    });
  });

  const configure = Effect.gen(function* () {
    const commitHash = yield* resolveAboutCommitHash;
    yield* electronApp.setName(environment.displayName);
    yield* electronApp.setAboutPanelOptions({
      applicationName: environment.displayName,
      applicationVersion: environment.appVersion,
      version: Option.getOrElse(commitHash, () => "unknown"),
    });

    if (environment.platform === "win32") {
      yield* electronApp.setAppUserModelId(environment.appUserModelId);
    }

    if (environment.platform === "linux") {
      yield* electronApp.setDesktopName(environment.linuxDesktopEntryName);
    }

    const iconVariant = yield* resolveConfiguredIconVariant;
    yield* setIconVariant(iconVariant);
  }).pipe(Effect.withSpan("desktop.appIdentity.configure"));

  return DesktopAppIdentity.of({
    resolveUserDataPath,
    configure,
    setIconVariant,
  });
});

export const layer = Layer.effect(DesktopAppIdentity, make);
