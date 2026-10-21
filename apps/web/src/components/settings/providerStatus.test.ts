import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

const baseProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "Claude Pro Subscription" },
  checkedAt: "2026-10-04T20:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("getProviderSummary", () => {
  it("explains that an unprobed disabled provider must be enabled first", () => {
    expect(getProviderSummary(undefined, { enabled: false })).toEqual({
      headline: "Disabled",
      detail: "Disabled — enable to detect and configure",
    });
  });

  it("shows an active usage limit instead of an authenticated card", () => {
    const summary = getProviderSummary(
      baseProvider({
        limit: {
          kind: "usage_limit",
          resetsAt: "2026-10-04T20:30:00.000Z",
          observedAt: "2026-10-04T20:00:00.000Z",
        },
      }),
    );

    expect(summary.headline).toBe("Usage limit reached");
    expect(summary.detail).toMatch(/^Resets/);
    expect(summary.headline).not.toContain("Authenticated");
    expect(summary.detail ?? "").not.toContain("Authenticated");
  });

  it("keeps the authenticated headline when no limit is reported", () => {
    expect(getProviderSummary(baseProvider()).headline).toBe(
      "Authenticated · Claude Pro Subscription",
    );
  });
});
