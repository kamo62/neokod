import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  isCloudEnabled,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

function stubCloudConfigPresent() {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });
});

describe("isCloudEnabled (OMApp fork gate)", () => {
  it("stays off by default even when cloud config is present", () => {
    stubCloudConfigPresent();
    expect(hasCloudPublicConfig()).toBe(true);
    expect(isCloudEnabled()).toBe(false);
  });

  it('turns on only when the flag is exactly "true" and config is present', () => {
    stubCloudConfigPresent();
    vi.stubEnv("VITE_OMAPP_CLOUD", "true");
    expect(isCloudEnabled()).toBe(true);
  });

  it("stays off when the flag is set but cloud config is missing", () => {
    vi.stubEnv("VITE_OMAPP_CLOUD", "true");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(isCloudEnabled()).toBe(false);
  });

  it('ignores non-"true" flag values', () => {
    stubCloudConfigPresent();
    vi.stubEnv("VITE_OMAPP_CLOUD", "1");
    expect(isCloudEnabled()).toBe(false);
  });
});
