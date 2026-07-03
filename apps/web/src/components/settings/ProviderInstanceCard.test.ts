import { describe, expect, it } from "vite-plus/test";
import type { CopilotManagedClientEvidenceSettings, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  describeManagedClientEvidenceReadiness,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("describeManagedClientEvidenceReadiness", () => {
  const settings = (
    overrides: Partial<CopilotManagedClientEvidenceSettings> = {},
  ): CopilotManagedClientEvidenceSettings => ({
    enabled: false,
    governanceUrl: "",
    credential: "",
    ...overrides,
  });

  it("says forwarding stays off when the governance URL is missing", () => {
    expect(describeManagedClientEvidenceReadiness(settings({ credential: "air_test" }))).toEqual(
      "Evidence forwarding stays off until a governance URL and credential are set.",
    );
  });

  it("says forwarding stays off when the credential is missing", () => {
    expect(
      describeManagedClientEvidenceReadiness(settings({ governanceUrl: "https://orch.example" })),
    ).toEqual("Evidence forwarding stays off until a governance URL and credential are set.");
  });

  it("prompts to turn forwarding on once both fields are set but disabled", () => {
    expect(
      describeManagedClientEvidenceReadiness(
        settings({ governanceUrl: "https://orch.example", credential: "air_test" }),
      ),
    ).toEqual("Fields are set. Turn on evidence forwarding above when you're ready.");
  });

  it("confirms forwarding is on once enabled with both fields set", () => {
    expect(
      describeManagedClientEvidenceReadiness(
        settings({ governanceUrl: "https://orch.example", credential: "air_test", enabled: true }),
      ),
    ).toEqual("Evidence forwarding is on.");
  });
});
