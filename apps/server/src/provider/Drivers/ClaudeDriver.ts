/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@neokod/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  applyClaudeLimit,
  providerLimitFromRejected,
  pruneExpiredRejectedRateLimits,
  updateRejectedRateLimits,
  type RejectedRateLimits,
} from "../Layers/ClaudeUsageLimit.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
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
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeClaudeCapabilitiesCacheKey, makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

/**
 * TTL policy for the capabilities probe cache. `probeClaudeCapabilities`
 * resolves to `undefined` when it errored or timed out; retaining that miss
 * for the full TTL pins the "could not verify" snapshot for five minutes, so
 * the panel's Refresh button replays the stale miss instead of re-probing. A
 * successful probe keeps the full TTL; a miss expires immediately.
 */
export const claudeCapabilitiesProbeCacheTimeToLive = <A, E>(
  exit: Exit.Exit<A, E>,
): Duration.Duration =>
  Exit.isSuccess(exit) && exit.value !== undefined ? CAPABILITIES_PROBE_TTL : Duration.zero;

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "claude-native",
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
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

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });
      // Rejected windows reported by any session of this provider instance.
      // The adapter reports per-window changes (not each session's whole map)
      // so one session's empty or partial view cannot erase another session's
      // still-valid rejection. Evidence survives until its window is reported
      // allowed or its known reset passes; polling re-projects this map so an
      // unknown-reset window is never expired by a sibling window's timestamp.
      const rejectedRateLimits = yield* SubscriptionRef.make<RejectedRateLimits>(new Map());

      const adapterOptions = {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        onRateLimitChange: (change: {
          readonly status: string;
          readonly rateLimitType: string;
          readonly resetsAtEpochSeconds: number | undefined;
        }) =>
          Effect.gen(function* () {
            const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
            yield* SubscriptionRef.update(rejectedRateLimits, (previous) =>
              pruneExpiredRejectedRateLimits(
                updateRejectedRateLimits(previous, {
                  status: change.status,
                  rateLimitType: change.rateLimitType,
                  resetsAt: change.resetsAtEpochSeconds,
                }),
                nowSeconds,
              ),
            );
          }),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv);

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.makeWith(
        (_key: string) =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
        {
          capacity: 1,
          timeToLive: claudeCapabilitiesProbeCacheTimeToLive,
        },
      );
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig, cwd);

      const checkProvider = checkClaudeProviderStatus(
        effectiveConfig,
        () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
        processEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingClaudeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const evidence = pruneExpiredRejectedRateLimits(
              yield* SubscriptionRef.get(rejectedRateLimits),
              nowMs / 1000,
            );
            yield* publishSnapshot(
              applyClaudeLimit(snapshot, providerLimitFromRejected(evidence, nowMs), nowMs),
            );
            const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
              snapshot,
              maintenanceCapabilities,
              { enableProviderUpdateChecks: settings.enableProviderUpdateChecks },
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
            yield* SubscriptionRef.changes(rejectedRateLimits).pipe(
              Stream.runForEach((current) =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((refreshNowMs) => {
                    const live = pruneExpiredRejectedRateLimits(current, refreshNowMs / 1000);
                    return publishSnapshot(
                      applyClaudeLimit(
                        enriched,
                        providerLimitFromRejected(live, refreshNowMs),
                        refreshNowMs,
                      ),
                    );
                  }),
                ),
              ),
            );
          }),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
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
        symphonyCodeReview: true,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
