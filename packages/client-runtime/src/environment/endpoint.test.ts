import { describe, expect, it } from "vite-plus/test";

import { deriveWsBaseUrl, environmentEndpointUrl, normalizeHttpBaseUrl } from "./endpoint.ts";

describe("endpoint URL helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("normalizes endpoint paths without retaining query or fragment state", () => {
    expect(
      environmentEndpointUrl("http://127.0.0.1:3773/old?token=secret#fragment", "/api/status"),
    ).toBe("http://127.0.0.1:3773/api/status");
    expect(() => normalizeHttpBaseUrl("ssh://example.com")).toThrow(
      "Endpoint must use HTTP or HTTPS",
    );
  });
});
