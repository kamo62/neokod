/**
 * CopilotDriver — `ProviderDriver` for the GitHub Copilot CLI, driven via
 * the official `@github/copilot-sdk`.
 *
 * Mirrors `Drivers/ClaudeDriver.ts`'s shape (a plain value whose `create()`
 * returns one `ProviderInstance` bundling `snapshot` / `adapter` /
 * `textGeneration` closures), but the resource being managed differs:
 * Claude's SDK spawns one disposable process per `query()` call, while
 * Copilot's SDK spawns a single long-lived JSON-RPC server process per
 * `CopilotClient`. This driver owns that one client for the lifetime of the
 * provider instance — constructed and started here, handed (already
 * connected) to both the adapter (per-thread `CopilotSession`s) and text
 * generation (short-lived sessions), and stopped when the instance's scope
 * closes.
 *
 * Finalizer ordering matters: `client.stop()` is registered as a finalizer
 * immediately after `client.start()` succeeds, and `makeCopilotAdapter`
 * registers its own finalizer (disconnecting every open session) when it
 * runs afterwards. Effect finalizers run in reverse registration order, so
 * on teardown every session disconnects before the client process stops.
 *
 * @module provider/Drivers/CopilotDriver
 */
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { CopilotSettings, ProviderDriverKind, type ServerProvider } from "@neokod/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";
import {
  makeCopilotContinuationGroupKey,
  resolveCopilotBaseDirectory,
} from "./CopilotEnvironment.ts";
import { checkCopilotProviderStatus, makePendingCopilotProvider } from "./CopilotProvider.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";
import { getStoredGithubToken } from "./GithubDeviceLogin.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const DRIVER_KIND = ProviderDriverKind.make("githubCopilot");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

function copilotRuntimeStartErrorDetail(binaryPath: string, cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : "Failed to start the GitHub Copilot runtime.";
  if (!binaryPath || !detail.includes("too many arguments")) return detail;
  return `The configured runtime at ${binaryPath} is not compatible with the Copilot SDK. Use a current GitHub Copilot CLI that supports --headless and --stdio, or clear Runtime path to use Neokod's bundled runtime.`;
}

// GitHub Copilot's CLI runtime ships bundled inside `@github/copilot-sdk` —
// there is no separate binary for the user to update out-of-band the way
// `claude update` or `npm i -g @openai/codex` works for the other drivers.
// Updating the runtime means updating the npm dependency, which is a fork
// maintenance action, not something the running server can trigger.
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type CopilotDriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
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

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const gitHubToken = yield* getStoredGithubToken();
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;

      const resolvedBaseDirectory = yield* resolveCopilotBaseDirectory(effectiveConfig);
      const continuationGroupKey = yield* makeCopilotContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const binaryPath = effectiveConfig.binaryPath.trim();
      const client = new CopilotClient({
        ...(binaryPath ? { connection: RuntimeConnection.forStdio({ path: binaryPath }) } : {}),
        ...(resolvedBaseDirectory ? { baseDirectory: resolvedBaseDirectory } : {}),
        ...(gitHubToken ? { gitHubToken } : {}),
        env: processEnv,
      });

      // A disabled instance must not spawn the bundled CLI runtime — the
      // snapshot path below already short-circuits on `enabled === false`
      // (see `makePendingCopilotProvider` / `checkCopilotProviderStatus`),
      // so starting the client here would boot a process nobody asked for.
      // The registry rebuilds the instance from scratch on every settings
      // change, so flipping this back to enabled runs `create()` again and
      // starts the client normally.
      if (effectiveConfig.enabled) {
        yield* Effect.tryPromise({
          try: () => client.start(),
          catch: (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: copilotRuntimeStartErrorDetail(binaryPath, cause),
              cause,
            }),
        });
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise(() => client.stop()).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to stop the GitHub Copilot runtime cleanly.", { cause }),
            ),
          ),
        );
      }

      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE);

      const adapterOptions = {
        instanceId,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeCopilotAdapter(client, effectiveConfig, adapterOptions);
      const textGeneration = yield* makeCopilotTextGeneration(client);

      const checkProvider = checkCopilotProviderStatus(effectiveConfig, client).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingCopilotProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build GitHub Copilot snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
