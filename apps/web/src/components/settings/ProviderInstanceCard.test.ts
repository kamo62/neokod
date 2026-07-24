import { describe, expect, it } from "vite-plus/test";
import type { CopilotManagedClientEvidenceSettings, ServerProviderModel } from "@neokod/contracts";

import {
  deriveProviderModelsForDisplay,
  describeMachineIdentityTransparency,
  describeManagedClientEvidenceReadiness,
  describeRecordedIdentity,
  formatCopilotMcpServersForEditor,
  parseCopilotMcpServersDraft,
} from "./ProviderInstanceCard";

describe("parseCopilotMcpServersDraft", () => {
  it("treats blank input as clearing all servers", () => {
    expect(parseCopilotMcpServersDraft("   \n  ")).toEqual({ ok: true, value: {} });
  });

  it("accepts a valid remote server config", () => {
    const result = parseCopilotMcpServersDraft(
      JSON.stringify({ gateway: { type: "http", url: "https://mcp.example.com" } }),
    );
    expect(result).toEqual({
      ok: true,
      value: { gateway: { type: "http", url: "https://mcp.example.com" } },
    });
  });

  it("accepts a valid stdio server config", () => {
    const result = parseCopilotMcpServersDraft(
      JSON.stringify({ local: { command: "my-mcp", args: ["--stdio"] } }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects malformed JSON with a clear message", () => {
    const result = parseCopilotMcpServersDraft("{ not json ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid JSON");
    }
  });

  it("rejects JSON that does not match the MCP schema", () => {
    // Remote server missing the required `url`.
    const result = parseCopilotMcpServersDraft(JSON.stringify({ bad: { type: "http" } }));
    expect(result.ok).toBe(false);
  });
});

describe("formatCopilotMcpServersForEditor", () => {
  it("renders an empty object as an empty string", () => {
    expect(formatCopilotMcpServersForEditor({})).toBe("");
  });

  it("pretty-prints configured servers", () => {
    const text = formatCopilotMcpServersForEditor({
      gateway: { type: "http", url: "https://mcp.example.com" },
    });
    expect(text).toContain("gateway");
    expect(text).toContain("\n");
  });
});

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
    gatewayEnabled: false,
    backend: "ai-orch",
    governanceUrl: "",
    credential: "",
    posthogHost: "",
    posthogApiKey: "",
    otlpEndpoint: "",
    otlpHeaders: "",
    includeMachineIdentity: true,
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

  it("treats a redacted stored credential as set, even though the wire value is blank", () => {
    expect(
      describeManagedClientEvidenceReadiness(
        settings({
          governanceUrl: "https://orch.example",
          credential: "",
          credentialRedacted: true,
        }),
      ),
    ).toEqual("Fields are set. Turn on evidence forwarding above when you're ready.");
  });

  it("says forwarding stays off for the posthog backend until host and API key are set", () => {
    expect(
      describeManagedClientEvidenceReadiness(
        settings({ backend: "posthog", posthogHost: "https://us.i.posthog.com" }),
      ),
    ).toEqual("Evidence forwarding stays off until a PostHog host and API key are set.");
  });

  it("confirms forwarding is on for the posthog backend once both fields are set", () => {
    expect(
      describeManagedClientEvidenceReadiness(
        settings({
          backend: "posthog",
          posthogHost: "https://us.i.posthog.com",
          posthogApiKey: "phc_test",
          enabled: true,
        }),
      ),
    ).toEqual("Evidence forwarding is on.");
  });

  it("treats a redacted stored posthog API key as set", () => {
    expect(
      describeManagedClientEvidenceReadiness(
        settings({
          backend: "posthog",
          posthogHost: "https://us.i.posthog.com",
          posthogApiKey: "",
          posthogApiKeyRedacted: true,
        }),
      ),
    ).toEqual("Fields are set. Turn on evidence forwarding above when you're ready.");
  });

  it("says forwarding stays off for the otlp backend until an endpoint is set", () => {
    expect(describeManagedClientEvidenceReadiness(settings({ backend: "otlp" }))).toEqual(
      "Evidence forwarding stays off until an OTLP endpoint is set.",
    );
  });

  it("confirms forwarding is on for the otlp backend once an endpoint is set", () => {
    expect(
      describeManagedClientEvidenceReadiness(
        settings({ backend: "otlp", otlpEndpoint: "https://otel.example.com", enabled: true }),
      ),
    ).toEqual("Evidence forwarding is on.");
  });
});

describe("describeMachineIdentityTransparency", () => {
  it("discloses what is recorded when identity is included", () => {
    expect(describeMachineIdentityTransparency(true)).toContain(
      "recorded alongside evidence sent to the configured backend",
    );
  });

  it("confirms nothing machine-identifying is recorded when identity is excluded", () => {
    expect(describeMachineIdentityTransparency(false)).toContain(
      "No OS username, hostname, or GitHub login is recorded",
    );
  });
});

describe("describeRecordedIdentity", () => {
  it("returns undefined when there is nothing to show yet", () => {
    expect(describeRecordedIdentity(undefined)).toBeUndefined();
    expect(describeRecordedIdentity({})).toBeUndefined();
    expect(describeRecordedIdentity({ osUsername: "  ", githubLogin: "  " })).toBeUndefined();
  });

  it("shows both fields when present", () => {
    expect(describeRecordedIdentity({ osUsername: "jdoe", githubLogin: "jdoe-gh" })).toEqual(
      "Recording as jdoe / GitHub: jdoe-gh",
    );
  });

  it("falls back to just the OS username when there is no github login", () => {
    expect(describeRecordedIdentity({ osUsername: "jdoe" })).toEqual("Recording as jdoe");
  });

  it("falls back to just the github login when there is no OS username", () => {
    expect(describeRecordedIdentity({ githubLogin: "jdoe-gh" })).toEqual(
      "Recording as GitHub: jdoe-gh",
    );
  });
});
