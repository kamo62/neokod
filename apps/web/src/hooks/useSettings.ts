/**
 * Environment-scoped settings hooks.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Live server settings always require an environment id. Primary-environment
 * access is intentionally named as such so environment-sensitive consumers
 * cannot silently read the wrong server's settings.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  ServerSettings,
  ServerSettingsMutationId,
  type ServerSettingsPatch,
} from "@neokod/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type UnifiedSettings,
} from "@neokod/contracts/settings";
import { safeErrorLogAttributes } from "@neokod/client-runtime/errors";
import { squashAtomCommandFailure } from "@neokod/client-runtime/state/runtime";
import { ensureLocalApi } from "~/localApi";
import * as Struct from "effect/Struct";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { usePrimaryEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  projectServerSettingsAcknowledgement,
  selectAuthoritativeServerSettings,
  type ServerSettingsAcknowledgementProjection,
} from "./settingsMutation.logic";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;
let clientSettingsHydrationGeneration = 0;

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function setClientSettingsHydrated(nextHydrated: boolean): void {
  if (clientSettingsHydrated === nextHydrated) {
    return;
  }
  clientSettingsHydrated = nextHydrated;
  emitClientSettingsHydrationChange();
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrated) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const hydrationGeneration = clientSettingsHydrationGeneration;
  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (hydrationGeneration !== clientSettingsHydrationGeneration) {
        return;
      }
      if (persistedSettings) {
        replaceClientSettingsSnapshot({ ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings });
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, {
        operation: "hydrate",
        ...safeErrorLogAttributes(error),
      });
    } finally {
      if (hydrationGeneration === clientSettingsHydrationGeneration) {
        setClientSettingsHydrated(true);
      }
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

function persistClientSettings(settings: ClientSettings): void {
  replaceClientSettingsSnapshot(settings);
  void ensureLocalApi()
    .persistence.setClientSettings(settings)
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, {
        operation: "persist",
        ...safeErrorLogAttributes(error),
      });
    });
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "revision") continue;
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

export interface SettingsMutationState {
  readonly status: "idle" | "saving" | "failed";
  readonly pendingCount: number;
  readonly failure: string | null;
  readonly lastAcknowledgedRevision: number | null;
}

interface SettingsMutationSnapshot {
  readonly state: SettingsMutationState;
  readonly acknowledgement: ServerSettingsAcknowledgementProjection | null;
}

interface SettingsMutationEntry {
  readonly listeners: Set<() => void>;
  snapshot: SettingsMutationSnapshot;
  streamedSettings: ServerSettings | null;
  pendingCount: number;
  failure: string | null;
  failureRevision: number | null;
  lastAcknowledgedRevision: number | null;
  acknowledgement: ServerSettingsAcknowledgementProjection | null;
  requestSequence: number;
  queue: Promise<void>;
}

const EMPTY_SETTINGS_MUTATION_SNAPSHOT: SettingsMutationSnapshot = {
  state: {
    status: "idle",
    pendingCount: 0,
    failure: null,
    lastAcknowledgedRevision: null,
  },
  acknowledgement: null,
};

const settingsMutationEntries = new Map<EnvironmentId, SettingsMutationEntry>();

function getSettingsMutationEntry(environmentId: EnvironmentId): SettingsMutationEntry {
  const existing = settingsMutationEntries.get(environmentId);
  if (existing) return existing;
  const entry: SettingsMutationEntry = {
    listeners: new Set(),
    snapshot: EMPTY_SETTINGS_MUTATION_SNAPSHOT,
    streamedSettings: null,
    pendingCount: 0,
    failure: null,
    failureRevision: null,
    lastAcknowledgedRevision: null,
    acknowledgement: null,
    requestSequence: 0,
    queue: Promise.resolve(),
  };
  settingsMutationEntries.set(environmentId, entry);
  return entry;
}

function emitSettingsMutationChange(entry: SettingsMutationEntry): void {
  entry.snapshot = {
    state: {
      status: entry.pendingCount > 0 ? "saving" : entry.failure === null ? "idle" : "failed",
      pendingCount: entry.pendingCount,
      failure: entry.failure,
      lastAcknowledgedRevision: entry.lastAcknowledgedRevision,
    },
    acknowledgement: entry.acknowledgement,
  };
  for (const listener of entry.listeners) listener();
}

function observeStreamedServerSettings(
  environmentId: EnvironmentId,
  settings: ServerSettings,
): void {
  const entry = getSettingsMutationEntry(environmentId);
  if (entry.streamedSettings !== null && settings.revision < entry.streamedSettings.revision)
    return;
  entry.streamedSettings = settings;
  let changed = false;
  if (
    entry.acknowledgement !== null &&
    settings.revision >= entry.acknowledgement.acknowledgement.revision
  ) {
    entry.acknowledgement = null;
    changed = true;
  }
  if (
    entry.failure !== null &&
    entry.failureRevision !== null &&
    settings.revision > entry.failureRevision
  ) {
    entry.failure = null;
    entry.failureRevision = null;
    changed = true;
  }
  if (changed) emitSettingsMutationChange(entry);
}

function useSettingsMutationSnapshot(
  environmentId: EnvironmentId | null,
): SettingsMutationSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (environmentId === null) return () => undefined;
      const entry = getSettingsMutationEntry(environmentId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [environmentId],
  );
  const getSnapshot = useCallback(
    () =>
      environmentId === null
        ? EMPTY_SETTINGS_MUTATION_SNAPSHOT
        : getSettingsMutationEntry(environmentId).snapshot,
    [environmentId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SETTINGS_MUTATION_SNAPSHOT);
}

function useAuthoritativeServerSettings(
  environmentId: EnvironmentId | null,
  streamedSettings: ServerSettings,
): ServerSettings {
  const mutationSnapshot = useSettingsMutationSnapshot(environmentId);
  useEffect(() => {
    if (environmentId !== null) observeStreamedServerSettings(environmentId, streamedSettings);
  }, [environmentId, streamedSettings]);
  return selectAuthoritativeServerSettings(streamedSettings, mutationSnapshot.acknowledgement);
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

function useClientSettingsValue(): ClientSettings {
  return useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );
}

export function mergeEnvironmentSettings(
  serverSettings: ServerSettings,
  clientSettings: ClientSettings,
): UnifiedSettings {
  return { ...serverSettings, ...clientSettings };
}

function useMergedSettings<T>(
  serverSettings: ServerSettings,
  selector: ((settings: UnifiedSettings) => T) | undefined,
): T {
  const clientSettings = useClientSettingsValue();

  const merged = useMemo<UnifiedSettings>(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function useClientSettings<T = ClientSettings>(
  selector?: (settings: ClientSettings) => T,
): T {
  const settings = useClientSettingsValue();
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

/** Read current settings for one environment, merged with client-local preferences. */
export function useEnvironmentSettings<T = UnifiedSettings>(
  environmentId: EnvironmentId,
  selector?: (settings: UnifiedSettings) => T,
): T {
  const streamedSettings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS;
  return useMergedSettings(
    useAuthoritativeServerSettings(environmentId, streamedSettings),
    selector,
  );
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimarySettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  return useMergedSettings(
    useAuthoritativeServerSettings(environmentId, useAtomValue(primaryServerSettingsAtom)),
    selector,
  );
}

export function useEnvironmentSettingsMutationState(
  environmentId: EnvironmentId,
): SettingsMutationState {
  return useSettingsMutationSnapshot(environmentId).state;
}

export function usePrimarySettingsMutationState(): SettingsMutationState {
  return useSettingsMutationSnapshot(usePrimaryEnvironment()?.environmentId ?? null).state;
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are serialized, awaited, and replaced with the authoritative
 * acknowledgement. Client keys go through client persistence.
 */
function useUpdateSettingsTarget(
  environmentId: EnvironmentId | null,
  streamedSettings: ServerSettings,
) {
  const persistServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: false,
  });
  const updateSettings = useCallback(
    async (patch: Partial<UnifiedSettings>): Promise<void> => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      if (Object.keys(clientPatch).length > 0) {
        persistClientSettings({
          ...getClientSettingsSnapshot(),
          ...clientPatch,
        });
      }

      if (Object.keys(serverPatch).length === 0 || environmentId === null) return;

      const entry = getSettingsMutationEntry(environmentId);
      if (
        entry.streamedSettings === null ||
        streamedSettings.revision >= entry.streamedSettings.revision
      ) {
        entry.streamedSettings = streamedSettings;
      }
      entry.pendingCount += 1;
      const requestSequence = ++entry.requestSequence;
      emitSettingsMutationChange(entry);

      const operation = entry.queue.then(async () => {
        const baseSettings = selectAuthoritativeServerSettings(
          entry.streamedSettings ?? streamedSettings,
          entry.acknowledgement,
        );
        const mutationId = ServerSettingsMutationId.make(
          `settings:${environmentId}:${baseSettings.revision}:${requestSequence}`,
        );

        try {
          const result = await persistServerSettings({
            environmentId,
            input: {
              mutationId,
              expectedRevision: baseSettings.revision,
              patch: serverPatch,
            },
          });
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            entry.failure =
              failure instanceof Error ? failure.message : "Server settings could not be saved.";
            entry.failureRevision = baseSettings.revision;
            return;
          }
          if (result.value.mutationId !== mutationId) {
            entry.failure = "Server returned a mismatched settings acknowledgement.";
            entry.failureRevision = baseSettings.revision;
            return;
          }
          if (result.value.revision !== result.value.settings.revision) {
            entry.failure = "Server returned an inconsistent settings revision.";
            entry.failureRevision = baseSettings.revision;
            return;
          }
          entry.acknowledgement = projectServerSettingsAcknowledgement(
            entry.acknowledgement,
            requestSequence,
            result.value,
          );
          entry.lastAcknowledgedRevision = Math.max(
            entry.lastAcknowledgedRevision ?? 0,
            result.value.revision,
          );
          entry.failure = null;
          entry.failureRevision = null;
        } catch (failure) {
          entry.failure =
            failure instanceof Error ? failure.message : "Server settings could not be saved.";
          entry.failureRevision = baseSettings.revision;
        } finally {
          entry.pendingCount = Math.max(0, entry.pendingCount - 1);
          emitSettingsMutationChange(entry);
        }
      });
      entry.queue = operation.catch(() => undefined);
      await operation;
    },
    [environmentId, persistServerSettings, streamedSettings],
  );

  return updateSettings;
}

export function useUpdateEnvironmentSettings(environmentId: EnvironmentId) {
  const streamedSettings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS;
  return useUpdateSettingsTarget(
    environmentId,
    useAuthoritativeServerSettings(environmentId, streamedSettings),
  );
}

export function useUpdatePrimarySettings() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  return useUpdateSettingsTarget(
    environmentId,
    useAuthoritativeServerSettings(environmentId, useAtomValue(primaryServerSettingsAtom)),
  );
}

export function useUpdateClientSettings() {
  return useCallback((patch: ClientSettingsPatch) => {
    persistClientSettings({
      ...getClientSettingsSnapshot(),
      ...patch,
    });
  }, []);
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
  settingsMutationEntries.clear();
}

export function __setClientSettingsForTests(settings: ClientSettings): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = settings;
  clientSettingsHydrated = true;
  clientSettingsHydrationPromise = null;
}
