import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@neokod/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@neokod/contracts/settings";
import { createModelSelection } from "@neokod/shared/model";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  createAuxiliaryTextGenerationSelection,
  getAppModelOptionsForInstance,
  getCustomModelOptionsByInstance,
  includeSavedAuxiliaryModelOption,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
  resolveAuxiliaryTextGenerationSelection,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection", () => {
  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug against the selected custom instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("includes Grok custom models from the selected provider instance", () => {
    const providers = [provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok" })];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          config: { customModels: ["grok-test-custom-model"] },
        },
      },
    };
    const grok = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "grok",
    )!;

    expect(getAppModelOptionsForInstance(settings, grok).map((option) => option.slug)).toContain(
      "grok-test-custom-model",
    );
  });

  it("does not inject an unknown selected slug into the stock instance list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("preserves custom provider instances in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });
});

describe("auxiliary text generation selection display", () => {
  it("keeps the saved unavailable slug instead of presenting a different model", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId,
        model: "claude-retired-model",
      },
    };

    const resolution = resolveAuxiliaryTextGenerationSelection(settings, providers);
    expect(resolution.selection).toEqual({
      instanceId,
      model: "claude-retired-model",
    });
    expect(resolution.status).toBe("not-listed");
    expect(resolution.reason).toContain("claude-retired-model");
    expect(resolution.reason).toContain("Text generation model");

    // The generic resolver still falls back for chat-style callers; the
    // auxiliary row must not display that fallback as the saved choice.
    expect(resolveAppModelSelectionState(settings, providers).model).toBe("claude-sonnet-4-6");

    const optionsWithSaved = includeSavedAuxiliaryModelOption(
      getCustomModelOptionsByInstance(settings, providers, instanceId, "claude-retired-model"),
      resolution,
    );
    expect(optionsWithSaved.get(instanceId)?.map((option) => option.slug)).toContain(
      "claude-retired-model",
    );
  });

  it("preserves a custom-instance selection and its options when the catalogue lists it", () => {
    const instanceId = ProviderInstanceId.make("claude_openrouter");
    const providers = [
      provider({ instanceId: "claudeAgent", models: ["claude-sonnet-4-6"] }),
      provider({ instanceId: "claude_openrouter", models: ["claude-sonnet-4-6"] }),
    ];
    const selection = createModelSelection(instanceId, "openai/gpt-5.5", [
      { id: "reasoningEffort", value: "high" },
    ]);
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: selection,
    };

    const resolution = resolveAuxiliaryTextGenerationSelection(settings, providers);
    expect(resolution.status).toBe("listed");
    expect(resolution.reason).toBeNull();
    expect(resolution.selection).toEqual(selection);

    const options = getCustomModelOptionsByInstance(
      settings,
      providers,
      instanceId,
      selection.model,
    );
    expect(options.get(instanceId)?.map((option) => option.slug)).toContain("openai/gpt-5.5");
    expect(includeSavedAuxiliaryModelOption(options, resolution)).toBe(options);
  });

  it("reports unverified evidence without claiming the model is unsupported", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const providers = [provider({ instanceId: "claudeAgent", models: [] })];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId,
        model: "claude-haiku-4-5",
      },
    };

    const resolution = resolveAuxiliaryTextGenerationSelection(settings, providers);
    expect(resolution.status).toBe("unverified");
    expect(resolution.selection.model).toBe("claude-haiku-4-5");
    expect(resolution.reason).toContain("could not be verified");
    expect(resolution.reason).toContain("Refresh providers");
    expect(resolution.reason).not.toContain("unsupported");
  });

  it("reports a disabled saved instance explicitly", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const providers = [provider({ instanceId: "claudeAgent", models: ["claude-sonnet-4-6"] })];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          config: { customModels: [] },
        },
      },
      textGenerationModelSelection: {
        instanceId,
        model: "claude-sonnet-4-6",
      },
    };

    const resolution = resolveAuxiliaryTextGenerationSelection(settings, providers);
    expect(resolution.status).toBe("unverified");
    expect(resolution.reason).toContain("disabled");
    expect(resolution.reason).toContain("Text generation model");
  });

  it("requires exact saved-slug membership, not aliases or display names", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const providers = [provider({ instanceId: "claudeAgent", models: ["claude-sonnet-4-6"] })];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId,
        model: "sonnet-4.6",
      },
    };

    const resolution = resolveAuxiliaryTextGenerationSelection(settings, providers);
    expect(resolution.selection.model).toBe("sonnet-4.6");
    expect(resolution.status).toBe("not-listed");
    expect(resolution.reason).toContain("not in the current catalogue");

    const displayNameProviders = [
      {
        ...provider({ instanceId: "claudeAgent", models: [] }),
        models: [
          {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isCustom: false,
            capabilities: {},
          },
        ],
      },
    ];
    expect(
      resolveAuxiliaryTextGenerationSelection(
        { ...settings, textGenerationModelSelection: { instanceId, model: "Claude Sonnet 4.6" } },
        displayNameProviders,
      ).status,
    ).toBe("not-listed");
  });

  it("treats invalid provider evidence as unverified before membership", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const providers = [
      {
        ...provider({ instanceId: "claudeAgent", models: [] }),
        status: "error" as const,
        auth: { status: "unknown" as const },
      },
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["claude-custom"] },
        },
      },
      textGenerationModelSelection: {
        instanceId,
        model: "claude-custom",
      },
    };

    const resolution = resolveAuxiliaryTextGenerationSelection(settings, providers);
    expect(resolution.status).toBe("unverified");
    expect(resolution.reason).toContain("unavailable or invalid");
    expect(resolution.reason).not.toContain("not in the current catalogue");
  });

  it("accepts warning snapshots with an installed catalogue as discovery evidence", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const providers = [
      {
        ...provider({ instanceId: "claudeAgent", models: ["claude-sonnet-4-6"] }),
        status: "warning" as const,
        auth: { status: "unknown" as const },
      },
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId,
        model: "claude-sonnet-4-6",
      },
    };

    expect(resolveAuxiliaryTextGenerationSelection(settings, providers).status).toBe("listed");
  });

  it("preserves the exact instance/model for traits-only and explicit selections", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];

    const hiddenModelEdit = createAuxiliaryTextGenerationSelection(
      providers,
      instanceId,
      "claude-opus-4-6",
      [{ id: "effort", value: "low" }],
    );
    expect(hiddenModelEdit.instanceId).toBe(instanceId);
    expect(hiddenModelEdit.model).toBe("claude-opus-4-6");

    const unlistedModelEdit = createAuxiliaryTextGenerationSelection(
      providers,
      instanceId,
      "claude-retired-model",
      [{ id: "effort", value: "high" }],
    );
    expect(unlistedModelEdit.instanceId).toBe(instanceId);
    expect(unlistedModelEdit.model).toBe("claude-retired-model");

    const explicitPick = createAuxiliaryTextGenerationSelection(
      providers,
      ProviderInstanceId.make("claude_openrouter"),
      "openai/gpt-5.5",
    );
    expect(explicitPick.instanceId).toBe(ProviderInstanceId.make("claude_openrouter"));
    expect(explicitPick.model).toBe("openai/gpt-5.5");
  });
});
