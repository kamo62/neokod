/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  type CopilotManagedClientEvidenceSettings,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  isProviderDriverKind,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@neokod/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@neokod/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@neokod/shared/schemaJson";
import { applyServerSettingsPatch } from "@neokod/shared/serverSettings";
import * as ServerSecretStore from "./secrets/ServerSecretStore.ts";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

// Single fixed slot (not per-instance, unlike provider environment
// variables): `providers.githubCopilot.managedClientEvidence` is a hidden,
// singleton settings block, so one constant secret name is enough.
const MANAGED_CLIENT_EVIDENCE_CREDENTIAL_SECRET_NAME = "copilot-managed-client-evidence-credential";

function redactManagedClientEvidenceCredential(
  managedClientEvidence: CopilotManagedClientEvidenceSettings,
): CopilotManagedClientEvidenceSettings {
  if (managedClientEvidence.credential.length === 0) {
    return managedClientEvidence;
  }
  return { ...managedClientEvidence, credential: "", credentialRedacted: true };
}

// Same single-fixed-slot secret convention as `credential` above, for the two
// backend-pluggable secrets added alongside `backend`/`posthogHost`/etc.
// (see `packages/contracts/src/settings.ts`). Both go through the same
// generic get-or-remove/set trio below rather than duplicating the
// credential functions field-by-field.
const MANAGED_CLIENT_EVIDENCE_POSTHOG_API_KEY_SECRET_NAME =
  "copilot-managed-client-evidence-posthog-api-key";
const MANAGED_CLIENT_EVIDENCE_OTLP_HEADERS_SECRET_NAME =
  "copilot-managed-client-evidence-otlp-headers";

interface ManagedClientEvidenceSecretField {
  readonly secretName: string;
  readonly valueKey: "posthogApiKey" | "otlpHeaders";
  readonly redactedKey: "posthogApiKeyRedacted" | "otlpHeadersRedacted";
}

const MANAGED_CLIENT_EVIDENCE_SECRET_FIELDS: ReadonlyArray<ManagedClientEvidenceSecretField> = [
  {
    secretName: MANAGED_CLIENT_EVIDENCE_POSTHOG_API_KEY_SECRET_NAME,
    valueKey: "posthogApiKey",
    redactedKey: "posthogApiKeyRedacted",
  },
  {
    secretName: MANAGED_CLIENT_EVIDENCE_OTLP_HEADERS_SECRET_NAME,
    valueKey: "otlpHeaders",
    redactedKey: "otlpHeadersRedacted",
  },
];

function redactManagedClientEvidenceSecretFields(
  managedClientEvidence: CopilotManagedClientEvidenceSettings,
): CopilotManagedClientEvidenceSettings {
  let next = managedClientEvidence;
  for (const field of MANAGED_CLIENT_EVIDENCE_SECRET_FIELDS) {
    if (next[field.valueKey].length === 0) continue;
    next = { ...next, [field.valueKey]: "", [field.redactedKey]: true };
  }
  return next;
}

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.environment
        ? {
            ...instance,
            environment: instance.environment.map(redactProviderEnvironmentVariable),
          }
        : instance,
    ]),
  );
  return {
    ...settings,
    providerInstances,
    providers: {
      ...settings.providers,
      githubCopilot: {
        ...settings.providers.githubCopilot,
        managedClientEvidence: redactManagedClientEvidenceSecretFields(
          redactManagedClientEvidenceCredential(
            settings.providers.githubCopilot.managedClientEvidence,
          ),
        ),
      },
    },
  };
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    /** Start the settings runtime and attach file watching. */
    readonly start: Effect.Effect<void, ServerSettingsError>;

    /** Await settings runtime readiness. */
    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** Read the current settings. */
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Patch settings and persist. Returns the new full settings object. */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Stream of settings change events. */
    readonly streamChanges: Stream.Stream<ServerSettings>;
  }
>()("neokod/serverSettings/ServerSettingsService") {
  /** @deprecated Import and use `layerTest` from this module. */
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Effect.gen(function* () {
    const { automaticGitFetchInterval, ...overridesForMerge } = overrides;
    const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
    const initialSettings = yield* normalizeServerSettings({
      ...merged,
      ...(automaticGitFetchInterval !== undefined
        ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
        : {}),
    });
    const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(currentSettingsRef),
      updateSettings: (patch) =>
        Ref.get(currentSettingsRef).pipe(
          Effect.map((currentSettings) => applyServerSettingsPatch(currentSettings, patch)),
          Effect.flatMap(normalizeServerSettings),
          Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
        ),
      streamChanges: Stream.empty,
    } satisfies ServerSettingsService["Service"];
  });

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

/**
 * Ensure the `textGenerationModelSelection` points to an enabled provider.
 * If the selected provider is disabled, fall back to the first enabled
 * provider with its default model.  This is applied at read-time so the
 * persisted preference is preserved for when a provider is re-enabled.
 */
function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return (instanceConfig.enabled ?? true) ? settings : fallbackTextGenerationProvider(settings);
  }

  if (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled
  ) {
    return settings;
  }

  return fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallbackEntry = Object.entries(settings.providers).find(([, provider]) => provider.enabled);
  const fallback = fallbackEntry ? ProviderDriverKind.make(fallbackEntry[0]) : undefined;
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback),
      model:
        DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_GIT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "automaticGitFetchInterval",
  "textGenerationModelSelection",
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const raw = yield* readRawConfig;
    const decoded = decodeServerSettingsJsonExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
        cause: decoded.cause,
      });
      return DEFAULT_SERVER_SETTINGS;
    }
    // Eager one-time migration: a legacy settings.json may still carry a
    // plaintext `managedClientEvidence.credential`. `migrateManagedClientEvidenceCredential`
    // (defined below, alongside `writeSettingsAtomically`) moves it into
    // ServerSecretStore before this value is ever handed back to a caller.
    return yield* migrateManagedClientEvidenceCredential(decoded.value);
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          environment.push({
            ...variable,
            value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
          });
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  /**
   * Server-internal read path for `managedClientEvidence.credential`, mirroring
   * `materializeProviderEnvironmentSecrets`. Prefers the secret store whenever
   * there's anything to look up (a plaintext value staged for migration, or a
   * value already marked redacted) and falls back to whatever plaintext is
   * still sitting in `settings.json` if the store has nothing for the key, so
   * a credential from a not-yet-migrated legacy settings.json, or one caught
   * mid-migration, is never lost to the forwarder.
   */
  const materializeManagedClientEvidenceCredential = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const managedClientEvidence = settings.providers.githubCopilot.managedClientEvidence;
      if (
        managedClientEvidence.credential.length === 0 &&
        !managedClientEvidence.credentialRedacted
      ) {
        return settings;
      }
      const secret = yield* secretStore.get(MANAGED_CLIENT_EVIDENCE_CREDENTIAL_SECRET_NAME).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "read-secret",
              cause,
            }),
        ),
      );
      const credential = Option.isSome(secret)
        ? textDecoder.decode(secret.value)
        : managedClientEvidence.credential;
      return {
        ...settings,
        providers: {
          ...settings.providers,
          githubCopilot: {
            ...settings.providers.githubCopilot,
            managedClientEvidence: { ...managedClientEvidence, credential },
          },
        },
      };
    });

  /**
   * Server-internal read path for `posthogApiKey`/`otlpHeaders`, mirroring
   * `materializeManagedClientEvidenceCredential` above but driven by
   * `MANAGED_CLIENT_EVIDENCE_SECRET_FIELDS` since both new secrets follow the
   * exact same single-fixed-slot shape. No eager migration companion — unlike
   * `credential`, these fields are brand new, so there is no legacy plaintext
   * settings.json to move out of.
   */
  const materializeManagedClientEvidenceSecretFields = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const managedClientEvidence = settings.providers.githubCopilot.managedClientEvidence;
      let next = managedClientEvidence;
      for (const field of MANAGED_CLIENT_EVIDENCE_SECRET_FIELDS) {
        if (next[field.valueKey].length === 0 && !next[field.redactedKey]) continue;
        const secret = yield* secretStore.get(field.secretName).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                cause,
              }),
          ),
        );
        const value = Option.isSome(secret)
          ? textDecoder.decode(secret.value)
          : next[field.valueKey];
        next = { ...next, [field.valueKey]: value };
      }
      if (next === managedClientEvidence) return settings;
      return {
        ...settings,
        providers: {
          ...settings.providers,
          githubCopilot: {
            ...settings.providers.githubCopilot,
            managedClientEvidence: next,
          },
        },
      };
    });

  const persistProviderEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (!variable.sensitive) {
            yield* secretStore.remove(secretName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "remove-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          if (!variable.valueRedacted) {
            if (variable.value.length > 0) {
              yield* secretStore.set(secretName, textEncoder.encode(variable.value)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "write-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          yield* secretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-stale-secret",
                  providerInstanceId: instanceId,
                  environmentVariable: variable.name,
                  cause,
                }),
            ),
          );
        }
      }

      return {
        ...next,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  /**
   * Write path for `managedClientEvidence.credential`, mirroring
   * `persistProviderEnvironmentSecrets`. A single fixed slot rather than a
   * per-instance map, so there's no stale-secret sweep, just set-or-remove
   * against the one constant secret name.
   */
  const persistManagedClientEvidenceCredential = (
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const managedClientEvidence = next.providers.githubCopilot.managedClientEvidence;
      if (managedClientEvidence.credentialRedacted) {
        // Client left the redacted marker in place (unchanged secret) or a
        // prior save already persisted it; nothing new to write.
        return next;
      }
      if (managedClientEvidence.credential.length === 0) {
        yield* secretStore.remove(MANAGED_CLIENT_EVIDENCE_CREDENTIAL_SECRET_NAME).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "remove-secret",
                cause,
              }),
          ),
        );
        return next;
      }
      yield* secretStore
        .set(
          MANAGED_CLIENT_EVIDENCE_CREDENTIAL_SECRET_NAME,
          textEncoder.encode(managedClientEvidence.credential),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "write-secret",
                cause,
              }),
          ),
        );
      return {
        ...next,
        providers: {
          ...next.providers,
          githubCopilot: {
            ...next.providers.githubCopilot,
            managedClientEvidence: {
              ...managedClientEvidence,
              credential: "",
              credentialRedacted: true,
            },
          },
        },
      };
    });

  /**
   * Write path for `posthogApiKey`/`otlpHeaders`, mirroring
   * `persistManagedClientEvidenceCredential` above but driven by
   * `MANAGED_CLIENT_EVIDENCE_SECRET_FIELDS`: set-or-remove per field against
   * its own constant secret name, same single-fixed-slot shape as `credential`.
   */
  const persistManagedClientEvidenceSecretFields = (
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const managedClientEvidence = next.providers.githubCopilot.managedClientEvidence;
      let updated = managedClientEvidence;
      for (const field of MANAGED_CLIENT_EVIDENCE_SECRET_FIELDS) {
        if (updated[field.redactedKey]) {
          // Client left the redacted marker in place (unchanged secret) or a
          // prior save already persisted it; nothing new to write.
          continue;
        }
        const value = updated[field.valueKey];
        if (value.length === 0) {
          yield* secretStore.remove(field.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-secret",
                  cause,
                }),
            ),
          );
          continue;
        }
        yield* secretStore.set(field.secretName, textEncoder.encode(value)).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "write-secret",
                cause,
              }),
          ),
        );
        updated = { ...updated, [field.valueKey]: "", [field.redactedKey]: true };
      }
      if (updated === managedClientEvidence) return next;
      return {
        ...next,
        providers: {
          ...next.providers,
          githubCopilot: {
            ...next.providers.githubCopilot,
            managedClientEvidence: updated,
          },
        },
      };
    });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {},
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  /**
   * Eager one-time migration, run inline while loading settings.json:
   * a legacy file may still carry a plaintext `managedClientEvidence.credential`
   * (pre-dating ServerSecretStore support for this field). The secret is
   * written to the store before settings.json is rewritten to the redacted
   * form, so there is no window where `materializeManagedClientEvidenceCredential`
   * (store-first, plaintext-field fallback) would see neither. Skips the
   * store write if a secret is already there (idempotent across restarts and
   * re-runs), and is a no-op once `credentialRedacted` is set.
   */
  const migrateManagedClientEvidenceCredential = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const managedClientEvidence = settings.providers.githubCopilot.managedClientEvidence;
      if (
        managedClientEvidence.credential.length === 0 ||
        managedClientEvidence.credentialRedacted
      ) {
        return settings;
      }

      const existingSecret = yield* secretStore
        .get(MANAGED_CLIENT_EVIDENCE_CREDENTIAL_SECRET_NAME)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                cause,
              }),
          ),
        );
      if (Option.isNone(existingSecret)) {
        yield* secretStore
          .set(
            MANAGED_CLIENT_EVIDENCE_CREDENTIAL_SECRET_NAME,
            textEncoder.encode(managedClientEvidence.credential),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "write-secret",
                  cause,
                }),
            ),
          );
      }

      const migrated: ServerSettings = {
        ...settings,
        providers: {
          ...settings.providers,
          githubCopilot: {
            ...settings.providers.githubCopilot,
            managedClientEvidence: {
              ...managedClientEvidence,
              credential: "",
              credentialRedacted: true,
            },
          },
        },
      };
      yield* writeSettingsAtomically(migrated);
      return migrated;
    });

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeProviderEnvironmentSecrets),
      Effect.flatMap(materializeManagedClientEvidenceCredential),
      Effect.flatMap(materializeManagedClientEvidenceSecretFields),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const nextPersistedEnvironment = yield* persistProviderEnvironmentSecrets(
            current,
            applyServerSettingsPatch(current, patch),
          );
          const nextPersistedCredential =
            yield* persistManagedClientEvidenceCredential(nextPersistedEnvironment);
          const nextPersisted =
            yield* persistManagedClientEvidenceSecretFields(nextPersistedCredential);
          const next = yield* normalizeServerSettings(nextPersisted);
          yield* writeSettingsAtomically(next);
          yield* Cache.set(settingsCache, cacheKey, next);
          yield* emitChange(next);
          const materialized = yield* materializeProviderEnvironmentSecrets(next).pipe(
            Effect.flatMap(materializeManagedClientEvidenceCredential),
            Effect.flatMap(materializeManagedClientEvidenceSecretFields),
          );
          return resolveTextGenerationProvider(materialized);
        }),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(
        Stream.mapEffect((settings) =>
          materializeProviderEnvironmentSecrets(settings).pipe(
            Effect.flatMap(materializeManagedClientEvidenceCredential),
            Effect.flatMap(materializeManagedClientEvidenceSecretFields),
            Effect.catch((error: ServerSettingsError) =>
              Effect.logWarning("failed to materialize provider environment secrets", {
                operation: error.operation,
                providerInstanceId: error.providerInstanceId,
                environmentVariable: error.environmentVariable,
                cause: error.cause,
              }).pipe(Effect.as(settings)),
            ),
          ),
        ),
        Stream.map(resolveTextGenerationProvider),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
