import {
  KiroSettings,
  type ProviderInstanceEnvironment,
  ProviderDriverKind,
  type ServerProvider,
} from "@neokod/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceOwnershipRepository } from "../../symphony/Persistence/Services/WorkspaceOwnershipRepository.ts";
import { makeKiroTextGeneration } from "../../textGeneration/KiroTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeKiroAdapter, type KiroManagedTurnEvidence } from "../Layers/KiroAdapter.ts";
import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
} from "../Layers/KiroProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
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
import { KIRO_API_KEY_ENV } from "../acp/KiroAcpSupport.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const DRIVER_KIND = ProviderDriverKind.make("kiro");
const REFRESH_INTERVAL = Duration.minutes(5);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export function makeKiroProcessEnvironment(
  agentEngine: KiroSettings["agentEngine"],
  environment: ProviderInstanceEnvironment,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = mergeProviderInstanceEnvironment(environment, baseEnv);
  if (agentEngine !== "v3") return merged;

  const isolated = { ...merged };
  delete isolated[KIRO_API_KEY_ENV];
  const apiKey = environment.find(
    (variable) => variable.name === KIRO_API_KEY_ENV && variable.sensitive,
  )?.value;
  if (apiKey?.trim()) isolated[KIRO_API_KEY_ENV] = apiKey.trim();
  return isolated;
}

export function applyKiroManagedTurnEvidence(
  snapshot: ServerProvider,
  evidence: (KiroManagedTurnEvidence & { readonly version: string }) | undefined,
): ServerProvider {
  if (!evidence || snapshot.status !== "warning" || snapshot.version !== evidence.version) {
    return snapshot;
  }
  return {
    ...snapshot,
    status: evidence.ready ? "ready" : "warning",
    message: evidence.ready
      ? "Kiro completed a managed turn with assistant output in supervised Work mode."
      : `Kiro managed-turn readiness failed: ${evidence.reason}`,
  };
}

export type KiroDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService
  | WorkspaceOwnershipRepository;

const stampInstance =
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

export const KiroDriver: ProviderDriver<KiroSettings, KiroDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kiro",
    supportsMultipleInstances: true,
  },
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => decodeKiroSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const ownershipRepository = yield* WorkspaceOwnershipRepository;
      const processEnv = makeKiroProcessEnvironment(config.agentEngine, environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = stampInstance({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies KiroSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const managedTurnEvidence = yield* SubscriptionRef.make<
        (KiroManagedTurnEvidence & { readonly version: string }) | undefined
      >(undefined);
      const probedVersion = yield* Ref.make<string | null>(null);
      const adapter = yield* makeKiroAdapter(effectiveConfig, {
        ownershipRepository,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onManagedTurnEvidence: (evidence) =>
          Ref.get(probedVersion).pipe(
            Effect.flatMap((version) =>
              version
                ? SubscriptionRef.set(managedTurnEvidence, { ...evidence, version })
                : Effect.void,
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to prepare Kiro runtime: ${cause.message}`,
              cause,
            }),
        ),
      );
      const textGeneration = makeKiroTextGeneration();
      const checkProvider = checkKiroProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.tap((snapshot) => Ref.set(probedVersion, snapshot.version)),
        Effect.map(stamp),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KiroSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialKiroProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          SubscriptionRef.changes(managedTurnEvidence).pipe(
            Stream.runForEach((evidence) =>
              publishSnapshot(applyKiroManagedTurnEvidence(snapshot, evidence)),
            ),
          ),
        refreshInterval: REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Kiro snapshot: ${cause.message ?? String(cause)}`,
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
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
