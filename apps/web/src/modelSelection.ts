import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@neokod/contracts";
import {
  createModelSelection,
  normalizeModelSlug,
  resolveSelectableModel,
} from "@neokod/shared/model";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { UnifiedSettings } from "@neokod/contracts/settings";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./providerModels";
import { ModelEsque } from "./components/chat/providerIconUtils";
import {
  type ProviderInstanceEntry,
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "./providerInstances";
import { sortModelsForProviderInstance } from "./modelOrdering";

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
const DEFAULT_TEXT_GENERATION_INSTANCE_ID = ProviderInstanceId.make("codex");

/**
 * Resolve the custom-model list for a given instance, preferring the
 * instance's own `providerInstances[id].config.customModels` blob when
 * present and falling back to the legacy per-kind
 * `settings.providers[kind].customModels` bucket for default instances only.
 *
 * The Settings UI promotes the legacy bucket into an explicit
 * `providerInstances[defaultId]` entry on every edit (the "migrate on
 * first write" scheme documented in
 * `ProviderInstanceRegistryHydration`), so this helper exists primarily
 * so readers pick up that promotion immediately — and so first-time
 * viewers on pre-migration settings still see their legacy list on
 * default slots. Custom instances intentionally do not read the legacy
 * per-driver bucket; otherwise one custom model added to `claude_openrouter`
 * can appear on the stock `claudeAgent` instance.
 */
function readInstanceCustomModels(
  settings: UnifiedSettings,
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
): ReadonlyArray<string> {
  const instance = settings.providerInstances?.[instanceId];
  const config = instance?.config;
  if (config !== null && typeof config === "object") {
    const value = (config as Record<string, unknown>).customModels;
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
  if (instanceId !== defaultInstanceId) {
    return [];
  }
  const legacyProviders = settings.providers as Record<
    string,
    { readonly customModels?: ReadonlyArray<string> } | undefined
  >;
  return legacyProviders[driverKind]?.customModels ?? [];
}

export interface AppModelOption {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isCustom: boolean;
}

function toAppModelOption(model: ServerProvider["models"][number]): AppModelOption {
  const option: AppModelOption = {
    slug: model.slug,
    name: model.name,
    isCustom: model.isCustom,
  };
  if (model.shortName) option.shortName = model.shortName;
  if (model.subProvider) option.subProvider = model.subProvider;
  return option;
}

function readInstanceModelPreferences(
  settings: UnifiedSettings,
  instanceId: ProviderInstanceId,
): { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> } {
  return (
    settings.providerModelPreferences?.[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    }
  );
}

function applyInstanceModelPreferences(
  options: ReadonlyArray<AppModelOption>,
  preferences: {
    readonly hiddenModels: ReadonlyArray<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): AppModelOption[] {
  const hiddenModels = new Set(preferences.hiddenModels);
  return sortModelsForProviderInstance(
    options.filter((option) => option.isCustom || !hiddenModels.has(option.slug)),
    { modelOrder: preferences.modelOrder },
  );
}

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  builtInModelSlugs: ReadonlySet<string>,
  provider: ProviderDriverKind = ProviderDriverKind.make("codex"),
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
  _selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getProviderModels(providers, provider).map(toAppModelOption);
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(getProviderModels(providers, provider), (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  // Read from the default instance's config first (that's where edits
  // now land), falling back to the legacy per-kind bucket so unmigrated
  // settings and the initial render before the first write both still
  // see the user's authored custom models.
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  const customModels = readInstanceCustomModels(settings, defaultInstanceId, provider);
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  return applyInstanceModelPreferences(
    options,
    readInstanceModelPreferences(settings, defaultInstanceId),
  );
}

/**
 * Instance-scoped variant of {@link getAppModelOptions}. Built-in models
 * come from the instance's own `entry.models` snapshot (rather than the
 * first-matching-kind fallback in `getProviderModels`), so each custom
 * instance gets the precise model list its driver reported. Custom model
 * slugs come from the instance's own `providerInstances[id].config.customModels`
 * when present, falling back to the legacy per-kind
 * `settings.providers[driverKind].customModels` bucket for default
 * instances only. This keeps two instances of the same kind from leaking
 * custom slugs into each other.
 *
 * Picker preferences are not applied here, so callers that need catalogue
 * evidence (admission/availability) can distinguish "hidden in the picker"
 * from "not advertised by the provider".
 */
function getAdvertisedModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
): AppModelOption[] {
  const options: AppModelOption[] = entry.models.map(toAppModelOption);
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(entry.models, (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  const customModels = readInstanceCustomModels(settings, entry.instanceId, entry.driverKind);
  const normalizer = entry.driverKind;
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs, normalizer)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({ slug, name: slug, isCustom: true });
  }

  return options;
}

export function getAppModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
): AppModelOption[] {
  return applyInstanceModelPreferences(
    getAdvertisedModelOptionsForInstance(settings, entry),
    readInstanceModelPreferences(settings, entry.instanceId),
  );
}

export function resolveAppModelSelection(
  provider: ProviderDriverKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function resolveAppModelSelectionForInstance(
  instanceId: ProviderInstanceId,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string | null {
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!entry) return null;
  const options = getAppModelOptionsForInstance(settings, entry);
  return (
    resolveSelectableModel(entry.driverKind, selectedModel, options) ??
    options[0]?.slug ??
    entry.models[0]?.slug ??
    null
  );
}

/**
 * Instance-keyed model options map. Each configured instance gets its own
 * option list so the model picker can show the same driver's built-in and
 * custom instances side by side without collapsing them.
 */
export function getCustomModelOptionsByInstance(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  _selectedInstanceId?: ProviderInstanceId | null,
  _selectedModel?: string | null,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  const out = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>();
  for (const entry of deriveProviderInstanceEntries(providers)) {
    out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
  }
  return out;
}

export type AuxiliaryTextGenerationSelectionStatus = "listed" | "not-listed" | "unverified";

export interface AuxiliaryTextGenerationSelection {
  /**
   * The persisted auxiliary selection, verbatim. It is never replaced by a
   * fallback model or instance; replacing it is an explicit settings mutation.
   */
  readonly selection: ModelSelection;
  /**
   * `listed` — the selected model is in this instance's advertised or
   * configured custom catalogue. This is discovery evidence only, not a claim
   * that structured generation succeeds.
   * `not-listed` — the instance reported a catalogue that omits the slug.
   * `unverified` — the instance is missing/disabled/unavailable or has not
   * reported a catalogue, so the slug cannot be checked.
   */
  readonly status: AuxiliaryTextGenerationSelectionStatus;
  /** Actionable reason for `not-listed` / `unverified`; null when listed. */
  readonly reason: string | null;
}

const TEXT_GENERATION_SETTINGS_ROW = "Settings → Text generation model";

/**
 * Resolve the auxiliary text-generation choice for display. Unlike
 * {@link resolveAppModelSelectionState} this preserves the saved instance and
 * model even when they cannot be verified, so Settings never presents a
 * different model as if it were the saved choice.
 */
export function resolveAuxiliaryTextGenerationSelection(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): AuxiliaryTextGenerationSelection {
  const selection = settings.textGenerationModelSelection ?? {
    instanceId: DEFAULT_TEXT_GENERATION_INSTANCE_ID,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
  };
  const entry = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
  ).find((candidate) => candidate.instanceId === selection.instanceId);

  if (!entry) {
    return {
      selection,
      status: "unverified",
      reason: `The saved provider instance '${selection.instanceId}' is not configured, so auxiliary text generation cannot be verified. Replace the selection in ${TEXT_GENERATION_SETTINGS_ROW}.`,
    };
  }
  if (!entry.enabled) {
    return {
      selection,
      status: "unverified",
      reason: `The saved provider instance '${selection.instanceId}' is disabled, so auxiliary text generation cannot run. Enable the instance or replace the selection in ${TEXT_GENERATION_SETTINGS_ROW}.`,
    };
  }
  if (!entry.isAvailable) {
    return {
      selection,
      status: "unverified",
      reason: `The saved provider instance '${selection.instanceId}' is unavailable, so auxiliary text generation cannot run. Choose another instance in ${TEXT_GENERATION_SETTINGS_ROW}.`,
    };
  }

  const options = getAdvertisedModelOptionsForInstance(settings, entry);
  const resolved = resolveSelectableModel(entry.driverKind, selection.model, options);
  if (resolved !== null) {
    return { selection, status: "listed", reason: null };
  }
  if (entry.models.length === 0) {
    return {
      selection,
      status: "unverified",
      reason: `Provider instance '${selection.instanceId}' has not reported a model catalogue, so the saved model '${selection.model}' could not be verified. Refresh providers or choose a model in ${TEXT_GENERATION_SETTINGS_ROW}.`,
    };
  }
  return {
    selection,
    status: "not-listed",
    reason: `The saved model '${selection.model}' is not in the current catalogue for provider instance '${selection.instanceId}'. Refresh providers or choose a model in ${TEXT_GENERATION_SETTINGS_ROW}; auxiliary text generation is refused until the selection is listed or replaced.`,
  };
}

/**
 * Keep the saved auxiliary slug in its instance's option list so the picker
 * trigger shows the real selection instead of falling back to the first
 * available model. The injected entry is display-only: the setting is written
 * only by the picker's explicit selection handler.
 */
export function includeSavedAuxiliaryModelOption(
  optionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
  resolution: AuxiliaryTextGenerationSelection,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  const { selection } = resolution;
  const options = optionsByInstance.get(selection.instanceId);
  if (options === undefined || options.some((option) => option.slug === selection.model)) {
    return optionsByInstance;
  }
  const next = new Map(optionsByInstance);
  next.set(selection.instanceId, [{ slug: selection.model, name: selection.model }, ...options]);
  return next;
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.textGenerationModelSelection ?? {
    instanceId: DEFAULT_TEXT_GENERATION_INSTANCE_ID,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
  };
  const entries = deriveProviderInstanceEntries(providers);
  const selectedEntry = entries.find(
    (entry) => entry.instanceId === selection.instanceId && entry.enabled && entry.isAvailable,
  );
  const entry =
    selectedEntry ?? entries.find((candidate) => candidate.enabled && candidate.isAvailable);
  if (entry) {
    // When the instance changed due to fallback (e.g. selected instance was disabled),
    // don't carry over the old instance's model — use the fallback instance's default.
    const selectedModel = selectedEntry ? selection.model : null;
    const model =
      resolveAppModelSelectionForInstance(entry.instanceId, settings, providers, selectedModel) ??
      entry.models[0]?.slug ??
      DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[entry.driverKind];
    if (!model) {
      return createModelSelection(entry.instanceId, "", []);
    }
    const provider = entry.driverKind;
    const { modelOptionsForDispatch } = getComposerProviderState({
      provider,
      model,
      models: entry.models,
      modelOptions: selectedEntry ? selection.options : undefined,
    });

    return createModelSelection(entry.instanceId, model, modelOptionsForDispatch);
  }

  const provider = resolveSelectableProvider(providers, null);
  const keptSelectedProvider = false;

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = keptSelectedProvider ? selection.model : null;
  const model = resolveAppModelSelection(provider, settings, providers, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(providers, provider),
    modelOptions: keptSelectedProvider ? selection.options : undefined,
  });

  return createModelSelection(defaultInstanceIdForDriver(provider), model, modelOptionsForDispatch);
}
