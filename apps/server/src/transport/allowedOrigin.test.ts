import { describe, expect, it } from "vite-plus/test";

import { decideOrigin, parseAllowedOrigins } from "./allowedOrigin.ts";

const none = parseAllowedOrigins(undefined);

describe("parseAllowedOrigins", () => {
  it("accepts full origins and bare hostnames, comparing only the hostname", () => {
    const allowed = parseAllowedOrigins("https://a.example.com, b.example.com");
    expect(allowed.has("a.example.com")).toBe(true);
    expect(allowed.has("b.example.com")).toBe(true);
  });

  it("is empty for unset, blank, and separator-only values", () => {
    for (const raw of [undefined, "", "   ", ",", " , , "]) {
      expect(parseAllowedOrigins(raw).size).toBe(0);
    }
  });

  it("lowercases, since Host comparison must not be case sensitive", () => {
    expect(parseAllowedOrigins("HTTPS://Neokod.Example.COM").has("neokod.example.com")).toBe(true);
  });
});

describe("decideOrigin", () => {
  it("allows loopback with no allowlist configured, which is the default install", () => {
    for (const host of ["127.0.0.1:4096", "localhost:4096", "[::1]:4096"]) {
      expect(decideOrigin({ host, origin: undefined, allowedOrigins: none })._tag).toBe("Allowed");
    }
  });

  it("allows a browser on loopback", () => {
    expect(
      decideOrigin({
        host: "127.0.0.1:4096",
        origin: "http://127.0.0.1:4096",
        allowedOrigins: none,
      })._tag,
    ).toBe("Allowed");
  });

  it("blocks DNS rebinding, where Origin and Host agree and both are the attacker's", () => {
    // The exact shape the naive Origin===Host check lets through: the page is
    // genuinely served from evil.example, which now resolves to 127.0.0.1.
    const decision = decideOrigin({
      host: "evil.example",
      origin: "http://evil.example",
      allowedOrigins: none,
    });
    expect(decision).toEqual({ _tag: "Rejected", hostname: "evil.example", header: "Host" });
  });

  it("allows the operator's proxy hostname once it is listed", () => {
    const allowed = parseAllowedOrigins("https://neokod.example.com");
    expect(
      decideOrigin({
        host: "neokod.example.com",
        origin: "https://neokod.example.com",
        allowedOrigins: allowed,
      })._tag,
    ).toBe("Allowed");
  });

  it("still blocks a different hostname when an allowlist exists", () => {
    const allowed = parseAllowedOrigins("https://neokod.example.com");
    expect(
      decideOrigin({ host: "evil.example", origin: "http://evil.example", allowedOrigins: allowed })
        ._tag,
    ).toBe("Rejected");
  });

  it("rejects an allowed Host carrying a foreign Origin", () => {
    // Cross-origin request from a page the operator does not control.
    const allowed = parseAllowedOrigins("neokod.example.com");
    const decision = decideOrigin({
      host: "neokod.example.com",
      origin: "https://evil.example",
      allowedOrigins: allowed,
    });
    expect(decision).toEqual({ _tag: "Rejected", hostname: "evil.example", header: "Origin" });
  });

  it("allows an absent Origin, which is how non-browser clients connect", () => {
    expect(
      decideOrigin({ host: "127.0.0.1:4096", origin: undefined, allowedOrigins: none })._tag,
    ).toBe("Allowed");
  });

  it("rejects an opaque Origin rather than treating it as absent", () => {
    expect(
      decideOrigin({ host: "127.0.0.1:4096", origin: "null", allowedOrigins: none })._tag,
    ).toBe("Rejected");
  });

  it("rejects a missing or unparseable Host", () => {
    for (const host of [undefined, "", "   "]) {
      expect(decideOrigin({ host, origin: undefined, allowedOrigins: none })._tag).toBe("Rejected");
    }
  });
});
