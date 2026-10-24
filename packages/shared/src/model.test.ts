import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@neokod/contracts";

import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  evaluateModelCatalogueEvidence,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeModelSlug,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("expands the bare Claude opus alias to Opus 5", () => {
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-5");
    expect(normalizeModelSlug("opus-5", claude)).toBe("claude-opus-5");
    expect(normalizeModelSlug("opus-4.8", claude)).toBe("claude-opus-4-8");
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("model catalogue evidence", () => {
  const evidence = (
    overrides: Partial<Parameters<typeof evaluateModelCatalogueEvidence>[0]> = {},
  ): Parameters<typeof evaluateModelCatalogueEvidence>[0] => ({
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      { slug: "gpt-5.4", isCustom: false },
      { slug: "team-proxy", isCustom: true },
    ],
    ...overrides,
  });

  it("admits an exact slug, including a custom-only catalogue", () => {
    expect(evaluateModelCatalogueEvidence(evidence(), "gpt-5.4")).toEqual({ status: "listed" });
    expect(
      evaluateModelCatalogueEvidence(
        evidence({ models: [{ slug: "team-proxy", isCustom: true }] }),
        "team-proxy",
      ),
    ).toEqual({ status: "listed" });
  });

  it("requires exact case-sensitive slug membership, not aliases or display names", () => {
    expect(
      evaluateModelCatalogueEvidence(
        evidence({ models: [{ slug: "gpt-5.4", isCustom: false }] }),
        "gpt-5-codex",
      ),
    ).toEqual({ status: "not-listed" });
    expect(evaluateModelCatalogueEvidence(evidence(), "GPT-5.4")).toEqual({
      status: "not-listed",
    });
    expect(evaluateModelCatalogueEvidence(evidence(), "GPT 5.4")).toEqual({
      status: "not-listed",
    });
  });

  it("treats invalid snapshots as unverified before considering membership", () => {
    const invalid: ReadonlyArray<
      readonly [string, Parameters<typeof evaluateModelCatalogueEvidence>[0]]
    > = [
      ["enabled false", evidence({ enabled: false })],
      ["unavailable", evidence({ availability: "unavailable" })],
      ["not installed", evidence({ installed: false })],
      ["status error", evidence({ status: "error" })],
      ["status disabled", evidence({ status: "disabled" })],
      ["explicitly unauthenticated", evidence({ auth: { status: "unauthenticated" } })],
    ];

    for (const [name, input] of invalid) {
      expect(evaluateModelCatalogueEvidence(input, "gpt-5.4"), name).toEqual({
        status: "unverified",
        reason: "invalid-evidence",
      });
      expect(evaluateModelCatalogueEvidence(input, "absent-model"), name).toEqual({
        status: "unverified",
        reason: "invalid-evidence",
      });
    }
  });

  it("keeps warning snapshots with an installed catalogue as valid evidence", () => {
    expect(evaluateModelCatalogueEvidence(evidence({ status: "warning" }), "gpt-5.4")).toEqual({
      status: "listed",
    });
    expect(evaluateModelCatalogueEvidence(evidence({ status: "warning" }), "absent")).toEqual({
      status: "not-listed",
    });
  });

  it("does not treat unknown auth as unauthenticated", () => {
    expect(
      evaluateModelCatalogueEvidence(evidence({ auth: { status: "unknown" } }), "gpt-5.4"),
    ).toEqual({ status: "listed" });
  });

  it("reports empty or custom-only catalogues as insufficient for a negative result", () => {
    expect(
      evaluateModelCatalogueEvidence(
        evidence({ models: [{ slug: "team-proxy", isCustom: true }] }),
        "absent-model",
      ),
    ).toEqual({ status: "unverified", reason: "insufficient-catalogue" });
    expect(evaluateModelCatalogueEvidence(evidence({ models: [] }), "absent-model")).toEqual({
      status: "unverified",
      reason: "insufficient-catalogue",
    });
    expect(evaluateModelCatalogueEvidence(evidence(), "absent-model")).toEqual({
      status: "not-listed",
    });
  });
});
