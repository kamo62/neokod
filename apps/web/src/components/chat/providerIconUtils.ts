import { ProviderDriverKind } from "@neokod/contracts";
import { ClaudeAI, CursorIcon, GrokIcon, Icon, KiroIcon, OpenAI, OpenCodeIcon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("kiro")]: KiroIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}

export function resolveModelDisplayLabel(
  models: ReadonlyArray<ModelEsque>,
  modelSlug: string,
): string {
  const model = models.find((candidate) => candidate.slug === modelSlug);
  return model ? getTriggerDisplayModelLabel(model) : modelSlug;
}

/**
 * Resolves which model option a picker trigger should display. If the
 * current slug belongs to a different instance (for example after a
 * provider switch or disable), falls back to the instance's first option so
 * the trigger stays in sync instead of showing a stale foreign slug.
 */
export function resolveTriggerModel(
  modelOptions: ReadonlyArray<ModelEsque>,
  model: string,
): ModelEsque | undefined {
  return modelOptions.find((option) => option.slug === model) ?? modelOptions[0];
}

function normalizeForVersionComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A model's slug (`claude-sonnet-5`) can carry a version the shown name does
 * not — the live Claude Code SDK probe reports the bare family name
 * ("Sonnet") for what the static catalog calls "Claude Sonnet 5", so the
 * picker has no way to tell the user which Claude they're about to run.
 * Returns the slug to display as a secondary tag when it adds information
 * beyond `displayedName`, or `undefined` when the slug is just a
 * punctuation/casing variant of the name already on screen (e.g. slug
 * "gpt-5" next to name "GPT-5") — showing it there would only repeat the
 * name.
 */
export function getModelVersionTag(model: ModelEsque, displayedName: string): string | undefined {
  const normalizedSlug = normalizeForVersionComparison(model.slug);
  const normalizedName = normalizeForVersionComparison(displayedName);
  if (!normalizedSlug || normalizedSlug === normalizedName) {
    return undefined;
  }
  return model.slug;
}
