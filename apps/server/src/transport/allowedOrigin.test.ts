import { describe, expect, it } from "vite-plus/test";

import { decideOrigin, decideRequestOrigin, parseAllowedOrigins } from "./allowedOrigin.ts";

const none = parseAllowedOrigins(undefined);
const proxy = parseAllowedOrigins("https://neokod.example.com");

describe("parseAllowedOrigins", () => {
  it("normalizes full origins to scheme, hostname, and effective port", () => {
    const allowed = parseAllowedOrigins("https://a.example.com, http://b.example.com:8080");
    expect(allowed.has("https://a.example.com:443")).toBe(true);
    expect(allowed.has("http://b.example.com:8080")).toBe(true);
  });

  it("defaults a bare hostname to https, the scheme a TLS-terminating proxy presents", () => {
    expect(parseAllowedOrigins("neokod.example.com").has("https://neokod.example.com:443")).toBe(
      true,
    );
    expect(
      parseAllowedOrigins("neokod.example.com:8443").has("https://neokod.example.com:8443"),
    ).toBe(true);
  });

  it("tolerates a single trailing slash on a pasted origin", () => {
    expect(
      parseAllowedOrigins("https://neokod.example.com/").has("https://neokod.example.com:443"),
    ).toBe(true);
  });

  it("is empty for unset, blank, and separator-only values", () => {
    for (const raw of [undefined, "", "   ", ",", " , , "]) {
      expect(parseAllowedOrigins(raw).size).toBe(0);
    }
  });

  it("lowercases, since Host comparison must not be case sensitive", () => {
    expect(
      parseAllowedOrigins("HTTPS://Neokod.Example.COM").has("https://neokod.example.com:443"),
    ).toBe(true);
  });

  it("drops entries that fail strict origin grammar instead of guessing", () => {
    for (const raw of [
      "https://user@neokod.example.com",
      "https://neokod.example.com/path",
      "https://neokod.example.com?q=1",
      "https://ⅼocalhost",
      "%%%",
    ]) {
      expect(parseAllowedOrigins(raw).size).toBe(0);
    }
  });
});

describe("decideOrigin", () => {
  it("allows loopback with no allowlist configured, which is the default install", () => {
    for (const host of [
      "127.0.0.1:4096",
      "localhost:4096",
      "[::1]:4096",
      "0.0.0.0:4096",
      "localhost",
    ]) {
      expect(decideOrigin({ host, origin: undefined, allowedOrigins: none })._tag).toBe("Allowed");
    }
  });

  it("allows a browser on loopback, whatever loopback port serves the page", () => {
    expect(
      decideOrigin({
        host: "127.0.0.1:4096",
        origin: "http://127.0.0.1:4096",
        allowedOrigins: none,
      })._tag,
    ).toBe("Allowed");
    expect(
      decideOrigin({
        host: "127.0.0.1:4096",
        origin: "http://localhost:5733",
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
    expect(decision).toEqual({ _tag: "Rejected", value: "evil.example", header: "Host" });
  });

  it("allows the operator's public origin once it is listed", () => {
    expect(
      decideOrigin({
        host: "neokod.example.com",
        origin: "https://neokod.example.com",
        allowedOrigins: proxy,
      })._tag,
    ).toBe("Allowed");
    expect(
      decideOrigin({
        host: "neokod.example.com:443",
        origin: "https://neokod.example.com",
        allowedOrigins: proxy,
      })._tag,
    ).toBe("Allowed");
  });

  it("compares the complete origin: another scheme or port of the same host stays blocked", () => {
    // Cookies are not port-scoped, so each of these was a review bypass probe.
    for (const origin of [
      "https://neokod.example.com:8443",
      "http://neokod.example.com",
      "http://neokod.example.com:8080",
    ]) {
      expect(decideOrigin({ host: "neokod.example.com", origin, allowedOrigins: proxy })._tag).toBe(
        "Rejected",
      );
    }
  });

  it("applies the port rule to Host as well", () => {
    expect(
      decideOrigin({ host: "neokod.example.com:8443", origin: undefined, allowedOrigins: proxy })
        ._tag,
    ).toBe("Rejected");
    const proxyOnPort = parseAllowedOrigins("https://neokod.example.com:8443");
    expect(
      decideOrigin({
        host: "neokod.example.com:8443",
        origin: undefined,
        allowedOrigins: proxyOnPort,
      })._tag,
    ).toBe("Allowed");
    // A portless Host means the scheme default, which :8443 is not.
    expect(
      decideOrigin({ host: "neokod.example.com", origin: undefined, allowedOrigins: proxyOnPort })
        ._tag,
    ).toBe("Rejected");
  });

  it("still blocks a different hostname when an allowlist exists", () => {
    expect(
      decideOrigin({ host: "evil.example", origin: "http://evil.example", allowedOrigins: proxy })
        ._tag,
    ).toBe("Rejected");
  });

  it("rejects an allowed Host carrying a foreign Origin", () => {
    // Cross-origin request from a page the operator does not control.
    const decision = decideOrigin({
      host: "neokod.example.com",
      origin: "https://evil.example",
      allowedOrigins: proxy,
    });
    expect(decision).toEqual({
      _tag: "Rejected",
      value: "https://evil.example:443",
      header: "Origin",
    });
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

describe("strict header grammar", () => {
  // `new URL()` accepted every probe below and reported hostname `localhost`
  // for the userinfo ones; the grammar rejects them before normalization can
  // fail open.
  it("rejects userinfo, paths, and other syntax the Host grammar forbids", () => {
    for (const host of [
      "evil.example@localhost:3773",
      "localhost:3773/path",
      "localhost:3773?q=1",
      "localhost:3773#f",
      "localhost:3773:4096",
      "localhost:",
      "localhost:0",
      "localhost:999999",
    ]) {
      expect(decideOrigin({ host, origin: undefined, allowedOrigins: none })._tag).toBe("Rejected");
    }
  });

  it("rejects userinfo smuggled through Origin", () => {
    const decision = decideOrigin({
      host: "localhost:3773",
      origin: "https://evil.example@localhost:3773",
      allowedOrigins: none,
    });
    expect(decision).toEqual({
      _tag: "Rejected",
      value: "https://evil.example@localhost:3773",
      header: "Origin",
    });
  });

  it("rejects trailing dots instead of resolving them to the bare name", () => {
    for (const host of ["localhost.", "localhost.:3773", ".localhost"]) {
      expect(decideOrigin({ host, origin: undefined, allowedOrigins: none })._tag).toBe("Rejected");
    }
  });

  it("rejects unicode homographs instead of IDNA-mapping them to loopback", () => {
    // U+217C SMALL ROMAN NUMERAL FIFTY: `new URL()` IDNA-maps it to "l",
    // which would turn this Host into `localhost`.
    expect(
      decideOrigin({ host: "ⅼocalhost:3773", origin: undefined, allowedOrigins: none })._tag,
    ).toBe("Rejected");
    expect(
      decideOrigin({
        host: "localhost:3773",
        origin: "http://ⅼocalhost:3773",
        allowedOrigins: none,
      })._tag,
    ).toBe("Rejected");
  });

  it("treats punycode as the distinct ASCII name it is, not as its homograph", () => {
    expect(
      decideOrigin({ host: "xn--lclhost-1ya.example", origin: undefined, allowedOrigins: none })
        ._tag,
    ).toBe("Rejected");
  });

  it("rejects duplicate and comma-separated header values", () => {
    expect(
      decideOrigin({ host: "localhost, evil.example", origin: undefined, allowedOrigins: none })
        ._tag,
    ).toBe("Rejected");
    expect(
      decideOrigin({ host: "localhost,localhost", origin: undefined, allowedOrigins: none })._tag,
    ).toBe("Rejected");
    expect(
      decideOrigin({
        host: "localhost:3773",
        origin: "http://localhost:3773, http://evil.example",
        allowedOrigins: none,
      })._tag,
    ).toBe("Rejected");
    expect(
      decideOrigin({
        host: "localhost:3773",
        origin: "http://localhost:3773 http://evil.example",
        allowedOrigins: none,
      })._tag,
    ).toBe("Rejected");
  });

  it("rejects unbracketed IPv6 in Host, which the grammar reserves for brackets", () => {
    expect(decideOrigin({ host: "::1", origin: undefined, allowedOrigins: none })._tag).toBe(
      "Rejected",
    );
  });
});

describe("decideRequestOrigin", () => {
  it("grants the desktop renderer's custom scheme with no configuration", () => {
    for (const origin of ["neokod://app", "neokod-dev://app"]) {
      expect(
        decideRequestOrigin({ host: "127.0.0.1:4096", origin, allowedOrigins: none })._tag,
      ).toBe("Allowed");
    }
  });

  it("still validates Host for desktop-scheme requests", () => {
    expect(
      decideRequestOrigin({ host: "evil.example", origin: "neokod://app", allowedOrigins: none })
        ._tag,
    ).toBe("Rejected");
  });

  it("rejects other custom schemes rather than parsing them leniently", () => {
    expect(
      decideRequestOrigin({ host: "127.0.0.1:4096", origin: "t3://app", allowedOrigins: none })
        ._tag,
    ).toBe("Rejected");
  });
});
