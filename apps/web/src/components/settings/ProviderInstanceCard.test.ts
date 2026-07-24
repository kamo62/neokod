import { describe, expect, it } from "vite-plus/test";
import type { CopilotManagedClientEvidenceSettings, ServerProviderModel } from "@neokod/contracts";

import {
  deriveProviderModelsForDisplay,
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
