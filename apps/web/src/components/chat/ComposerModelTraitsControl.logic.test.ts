import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@neokod/contracts";
import {
  COMPOSER_MODEL_TRAITS_NO_MODEL_LABEL,
  formatComposerModelTraitsSummary,
  getComposerPrimaryTraitLabel,
} from "./ComposerModelTraitsControl.logic";
import type { ModelEsque } from "./providerIconUtils";

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("codex");
const MODEL = "test-model";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}

function booleanDescriptor(
  id: string,
  label: string,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id, label, type: "boolean" };
}

function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

const GPT_MODEL: ModelEsque = { slug: MODEL, name: "GPT-5.4" };

describe("getComposerPrimaryTraitLabel", () => {
  it("returns null when the provider exposes no traits", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(label).toBeNull();
  });

  it("returns null when there is no thread/draft target, even though the provider has traits", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      ]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: false,
    });
    expect(label).toBeNull();
  });

  it("picks the first select descriptor as primary among multiple traits", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
        booleanDescriptor("thinking", "Thinking"),
      ]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(label).toBe("High");
  });

  it("picks the first of several select descriptors as primary", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
        selectDescriptor("contextWindow", [
          { id: "200k", label: "200k", isDefault: true },
          { id: "1m", label: "1M" },
        ]),
      ]),
      modelSlug: MODEL,
      prompt: "",
      // Override both selects away from their defaults; the first
      // descriptor (effort) should still win regardless of value.
      modelOptions: selections(["effort", "low"], ["contextWindow", "1m"]),
      hasTraitsTarget: true,
    });
    expect(label).toBe("Low");
  });

  it("prefers an explicit selection over the descriptor's default", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: selections(["effort", "low"]),
      hasTraitsTarget: true,
    });
    expect(label).toBe("Low");
  });

  it("falls back to the first boolean descriptor when there is no select descriptor", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([booleanDescriptor("thinking", "Thinking")]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: selections(["thinking", true]),
      hasTraitsTarget: true,
    });
    expect(label).toBe("Thinking On");
  });

  it("uses the fastMode-specific Fast/Normal formatting when fastMode is primary and on", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([booleanDescriptor("fastMode", "Fast mode")]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: selections(["fastMode", true]),
      hasTraitsTarget: true,
    });
    expect(label).toBe("Fast");
  });

  it("uses the fastMode-specific Fast/Normal formatting when fastMode is primary and off", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([booleanDescriptor("fastMode", "Fast mode")]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: selections(["fastMode", false]),
      hasTraitsTarget: true,
    });
    expect(label).toBe("Normal");
  });

  it("overrides the primary select descriptor label with Ultrathink when prompt-injected", () => {
    const label = getComposerPrimaryTraitLabel({
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor(
          "effort",
          [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          ["ultrathink"],
        ),
      ]),
      modelSlug: MODEL,
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(label).toBe("Ultrathink");
  });
});

describe("formatComposerModelTraitsSummary", () => {
  it("joins model name and primary trait with a middle dot", () => {
    const summary = formatComposerModelTraitsSummary({
      model: GPT_MODEL,
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe("GPT-5.4 · High");
  });

  it("shows the model name alone when the provider has no traits", () => {
    const summary = formatComposerModelTraitsSummary({
      model: GPT_MODEL,
      provider: PROVIDER,
      models: modelWith([]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe("GPT-5.4");
  });

  it("shows the model name alone when there is no thread/draft target, even with traits available", () => {
    const summary = formatComposerModelTraitsSummary({
      model: GPT_MODEL,
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      ]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: false,
    });
    expect(summary).toBe("GPT-5.4");
  });

  it("shows the primary trait alone when the model is missing and there is no slug fallback", () => {
    const summary = formatComposerModelTraitsSummary({
      model: null,
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      ]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe("High");
  });

  it("falls back to a placeholder when the model, slug fallback, and traits are all missing", () => {
    const summary = formatComposerModelTraitsSummary({
      model: undefined,
      provider: PROVIDER,
      models: modelWith([]),
      modelSlug: null,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe(COMPOSER_MODEL_TRAITS_NO_MODEL_LABEL);
  });

  it("prefers the model's short name, matching the existing trigger label rule", () => {
    const summary = formatComposerModelTraitsSummary({
      model: { slug: MODEL, name: "GPT-5.4 Codex", shortName: "GPT-5.4" },
      provider: PROVIDER,
      models: modelWith([]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe("GPT-5.4");
  });

  it("shows the raw selected slug when the model catalog can't resolve it (empty/loading catalog)", () => {
    const summary = formatComposerModelTraitsSummary({
      model: undefined,
      modelDisplayFallback: "gpt-5.4-preview",
      provider: PROVIDER,
      models: modelWith([]),
      modelSlug: "gpt-5.4-preview",
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe("gpt-5.4-preview");
  });

  it("joins the raw slug fallback with the primary trait, same as a resolved model name", () => {
    const summary = formatComposerModelTraitsSummary({
      model: undefined,
      modelDisplayFallback: "gpt-5.4-preview",
      provider: PROVIDER,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      ]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe("gpt-5.4-preview · High");
  });

  it("prefers the resolved model over the raw slug fallback when both are available", () => {
    const summary = formatComposerModelTraitsSummary({
      model: GPT_MODEL,
      modelDisplayFallback: MODEL,
      provider: PROVIDER,
      models: modelWith([]),
      modelSlug: MODEL,
      prompt: "",
      modelOptions: undefined,
      hasTraitsTarget: true,
    });
    expect(summary).toBe("GPT-5.4");
  });
});
