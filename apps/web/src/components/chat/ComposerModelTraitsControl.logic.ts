import {
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@neokod/contracts";
import { getTraitsSectionVisibility, formatProviderOptionTraitLabel } from "./TraitsPicker";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

/** Shown when there is no model to display and no trait to fall back to. */
export const COMPOSER_MODEL_TRAITS_NO_MODEL_LABEL = "Select model";

export interface ComposerModelTraitsSummaryInput {
  /** The resolved model option backing the picker trigger, if any. */
  model: ModelEsque | null | undefined;
  /**
   * Raw slug to show when `model` could not be resolved (e.g. the model
   * catalog is transiently empty/loading). Mirrors ProviderModelPicker's own
   * `props.model` fallback so a stale/loading catalog still shows something
   * meaningful instead of a generic placeholder.
   */
  modelDisplayFallback?: string | null | undefined;
  provider: ProviderDriverKind;
  /** Full capability list for the provider, used to derive trait descriptors. */
  models: ReadonlyArray<ServerProviderModel>;
  /** Model slug used to look up trait capabilities (may differ from `model.slug`
   * while a custom/unlisted model is active). */
  modelSlug: string | null | undefined;
  prompt: string;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  allowPromptInjectedEffort?: boolean;
  /**
   * Whether the composer has a thread/draft target to persist provider-option
   * changes to. Mirrors `renderProviderTraitsPicker`'s own gating
   * (`hasComposerTraitsTarget`) so the collapsed summary never advertises a
   * trait the popover's footer can't actually expose (it renders null
   * without a target).
   */
  hasTraitsTarget: boolean;
}

/**
 * Picks the single most significant trait for the collapsed composer
 * summary, using the same ordering TraitsPicker already establishes for its
 * own trigger: the first select-type descriptor (e.g. reasoning effort) is
 * primary, falling back to the first boolean descriptor when no select
 * descriptor exists. Returns null when the provider exposes no traits for
 * the current model, or when there is no thread/draft target to expose them
 * through (see `hasTraitsTarget` on ComposerModelTraitsSummaryInput).
 */
export function getComposerPrimaryTraitLabel(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  modelSlug: string | null | undefined;
  prompt: string;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  allowPromptInjectedEffort?: boolean;
  hasTraitsTarget: boolean;
}): string | null {
  if (!input.hasTraitsTarget) {
    return null;
  }

  const {
    primarySelectDescriptor,
    booleanDescriptors,
    ultrathinkPromptControlled,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider: input.provider,
    models: input.models,
    model: input.modelSlug,
    prompt: input.prompt,
    modelOptions: input.modelOptions,
    allowPromptInjectedEffort: input.allowPromptInjectedEffort ?? true,
  });

  if (!hasAnyControls) {
    return null;
  }

  const primaryDescriptor = primarySelectDescriptor ?? booleanDescriptors[0] ?? null;
  if (!primaryDescriptor) {
    return null;
  }

  const isUltrathinkOverride =
    ultrathinkPromptControlled && primaryDescriptor.id === primarySelectDescriptor?.id;
  return formatProviderOptionTraitLabel(primaryDescriptor, { isUltrathinkOverride });
}

/**
 * Formats the combined model + trait summary shown on the collapsed
 * composer control, e.g. "GPT-5.4 · High". Falls back gracefully when the
 * model is missing (using the raw slug when one was selected but the
 * catalog can't resolve it yet), when the provider has no traits, or when
 * neither is available.
 */
export function formatComposerModelTraitsSummary(input: ComposerModelTraitsSummaryInput): string {
  const modelName = input.model
    ? getTriggerDisplayModelName(input.model)
    : input.modelDisplayFallback?.trim() || null;
  const primaryTraitLabel = getComposerPrimaryTraitLabel(input);

  if (modelName && primaryTraitLabel) {
    return `${modelName} · ${primaryTraitLabel}`;
  }
  if (modelName) {
    return modelName;
  }
  if (primaryTraitLabel) {
    return primaryTraitLabel;
  }
  return COMPOSER_MODEL_TRAITS_NO_MODEL_LABEL;
}
