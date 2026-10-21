/**
 * OpenCodeDriver — `ProviderDriver` for the OpenCode runtime.
 *
 * Mirrors the Codex / Claude drivers: a plain value whose `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the
 * per-instance `OpenCodeSettings`.
 *
 * Two instances with different `serverUrl`s therefore talk to independent
 * OpenCode servers; when no `serverUrl` is set, the adapter + text-generation
 * shares spin up their own scoped child processes, and those child
 * processes are released when the registry scope closes.
 *
 * @module provider/Drivers/OpenCodeDriver
 */
import { OpenCodeSettings, ProviderDriverKind, type ServerProvider } from "@neokod/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  classifyOpenCodeVersion,
  formatOpenCodeUnsupportedVersionMessage,
  OPENCODE_VERSION_PROBE_TIMEOUT,
  parseOpenCodeVersionOutput,
  type OpenCodeVersion,
} from "../openCodeVersion.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "opencode-ai",
  homebrewFormula: "anomalyco/tap/opencode",
  nativeUpdate: {
    executable: "opencode",
    args: ["upgrade"],
    lockKey: "opencode-native",
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

/**
 * A known OpenCode 2 install must not be offered the 1.x package or native
 * updater: both would replace the user's v2 CLI with a downgrade. There is no
 * v2 updater in this change, so manual maintenance is the honest capability.
 * An unverified install keeps the existing resolver behaviour.
 */
export function resolveOpenCodeMaintenanceCapabilities(input: {
  readonly knownVersion: OpenCodeVersion | null;
  readonly fallback: ProviderMaintenanceCapabilities;
}): ProviderMaintenanceCapabilities {
  if (input.knownVersion === null || input.knownVersion.supported) {
    return input.fallback;
  }
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: input.fallback.provider,
    packageName: null,
  });
}

export function supportsOpenCodeSymphonyCodeReview(knownVersion: OpenCodeVersion | null): boolean {
  return knownVersion === null || knownVersion.supported;
}

/**
 * Probe the local CLI for its banner version.
 *
 * The probe is bounded because it runs while the provider registry hydrates and
 * again immediately before maintenance: an executable that never answers
 * `--version` must not hold server start or an update. A timed-out, failed or
 * unparseable probe resolves `null` and never changes behaviour on its own:
 * only an affirmatively classified unsupported major is blocked.
 */
function probeOpenCodeVersion(input: {
  readonly runtime: OpenCodeRuntimeShape;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<OpenCodeVersion | null> {
  return input.runtime
    .runOpenCodeCommand({
      binaryPath: input.binaryPath,
      args: ["--version"],
      environment: input.environment,
    })
    .pipe(
      Effect.timeoutOption(OPENCODE_VERSION_PROBE_TIMEOUT),
      Effect.map((result) =>
        Option.match(result, {
          onNone: () => null,
          onSome: (value) => {
            const parsed = parseOpenCodeVersionOutput(value.stdout);
            return parsed ? classifyOpenCodeVersion(parsed) : null;
          },
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("Could not verify the OpenCode CLI version", {
          binaryPath: input.binaryPath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
}

/**
 * The updater chosen at driver creation describes the CLI that was installed
 * then. A user can upgrade to OpenCode 2 while Neokod is running, and the
 * captured 1.x package or native updater would then replace that install with
 * 1.x on the next maintenance invocation. Re-probe at command time and block
 * the captured command when the CLI is now an unsupported major.
 */
function guardOpenCodeMaintenanceCapabilities(input: {
  readonly capabilities: ProviderMaintenanceCapabilities;
  readonly verify: Effect.Effect<string | null>;
}): ProviderMaintenanceCapabilities {
  if (input.capabilities.update === null) {
    return input.capabilities;
  }
  return {
    ...input.capabilities,
    update: { ...input.capabilities.update, verifyStillApplicable: input.verify },
  };
}

export type OpenCodeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings;
      const isExternalServer = effectiveConfig.serverUrl.trim().length > 0;
      // Only enabled local instances are probed. Disabled instances must not
      // spawn the CLI merely because the registry materialized them, and a
      // configured external server's protocol is never inferred from the
      // local binary.
      const knownVersion =
        enabled && !isExternalServer
          ? yield* probeOpenCodeVersion({
              runtime: openCodeRuntime,
              binaryPath: effectiveConfig.binaryPath,
              environment: processEnv,
            })
          : null;
      const resolvedMaintenanceCapabilities = resolveOpenCodeMaintenanceCapabilities({
        knownVersion,
        fallback: yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }),
      });
      // A configured external server's protocol is never inferred from the
      // local binary, and maintenance must not read or replace a local CLI on
      // its behalf. Local instances re-verify the CLI when an update is
      // actually requested, so a v1 install upgraded to v2 while Neokod was
      // running cannot be replaced by the captured 1.x updater.
      const maintenanceCapabilities = isExternalServer
        ? resolvedMaintenanceCapabilities
        : guardOpenCodeMaintenanceCapabilities({
            capabilities: resolvedMaintenanceCapabilities,
            verify: probeOpenCodeVersion({
              runtime: openCodeRuntime,
              binaryPath: effectiveConfig.binaryPath,
              environment: processEnv,
            }).pipe(
              Effect.map((currentVersion) =>
                currentVersion !== null && !currentVersion.supported
                  ? `Update blocked. ${formatOpenCodeUnsupportedVersionMessage(currentVersion)}`
                  : null,
              ),
            ),
          });

      const adapter = yield* makeOpenCodeAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOpenCodeProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCodeRuntime, openCodeRuntime));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>(
        {
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        symphonyCodeReview: supportsOpenCodeSymphonyCodeReview(knownVersion),
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
