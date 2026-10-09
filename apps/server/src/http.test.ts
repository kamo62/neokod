// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  appShellContentSecurityPolicy,
  assetResponseHeaders,
  inlineScriptHashes,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/?token=test-token",
    );
  });
});

describe("security headers", () => {
  it("assetResponseHeaders sandboxes html without scripts and forces download", () => {
    for (const filePath of ["/w/report.html", "/w/REPORT.HTM"]) {
      const headers = assetResponseHeaders(filePath);
      expect(headers["Content-Security-Policy"]).toBe("sandbox");
      expect(headers["Content-Disposition"]).toBe("attachment");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["Content-Security-Policy"]).not.toContain("allow-");
    }
  });

  it("assetResponseHeaders locks down svg, leaves pdf viewable", () => {
    const svg = assetResponseHeaders("/w/mark.svg");
    expect(svg["Content-Security-Policy"]).toBe("default-src 'none'; sandbox");
    expect(svg["Content-Disposition"]).toBe("attachment");
    const pdf = assetResponseHeaders("/w/doc.pdf");
    expect(pdf["Content-Security-Policy"]).toBeUndefined();
    expect(pdf["Content-Disposition"]).toBeUndefined();
    for (const filePath of ["/w/photo.png", "/w/app.js"]) {
      const headers = assetResponseHeaders(filePath);
      expect(headers["Content-Security-Policy"]).toBe("default-src 'none'; sandbox");
      expect(headers["Content-Disposition"]).toBeUndefined();
    }
  });

  it("inlineScriptHashes hashes only inline scripts", () => {
    expect(
      inlineScriptHashes(
        '<script>window.a=1</script><script type="module" crossorigin src="/assets/x.js"></script><script src = "/b.js"></script><script> </script>',
      ),
    ).toEqual([
      `'sha256-${NodeCrypto.createHash("sha256").update("window.a=1").digest("base64")}'`,
    ]);
  });

  it("appShellContentSecurityPolicy has no unsafe script sources", () => {
    const csp = appShellContentSecurityPolicy(["'sha256-abc'"]);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp.replace("'wasm-unsafe-eval'", "")).not.toContain("unsafe-eval");
    expect(csp.split("; ").find((directive) => directive.startsWith("script-src"))).not.toContain(
      "unsafe-inline",
    );
  });

  it("shipped index.html is CSP compatible", () => {
    const html = NodeFS.readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    expect(inlineScriptHashes(html)).toHaveLength(1);
    const withoutScripts = html.replace(/<script(?![^>]*\ssrc\s*=)[^>]*>[\s\S]*?<\/script>/gi, "");
    expect(withoutScripts).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toContain("javascript:");
  });
});
