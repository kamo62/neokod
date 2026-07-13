import { describe, expect, it } from "vite-plus/test";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
  timingSafeEqualUtf8,
} from "./serverCrypto.ts";

describe("serverCrypto", () => {
  it("round-trips UTF-8 text through base64url encoding", () => {
    const encoded = base64UrlEncode("signed asset payload ✓");

    expect(encoded).not.toContain("=");
    expect(base64UrlDecodeUtf8(encoded)).toBe("signed asset payload ✓");
  });

  it("signs payloads deterministically with HMAC-SHA256", () => {
    const secret = new TextEncoder().encode("server-secret");

    expect(signPayload("payload", secret)).toBe(signPayload("payload", secret));
    expect(signPayload("payload", secret)).not.toBe(signPayload("different", secret));
  });

  it("compares encoded signatures and bearer strings without accepting mismatches", () => {
    expect(timingSafeEqualBase64Url("YWJj", "YWJj")).toBe(true);
    expect(timingSafeEqualBase64Url("YWJj", "ZGVm")).toBe(false);
    expect(timingSafeEqualBase64Url("YWJj", "YQ")).toBe(false);
    expect(timingSafeEqualUtf8("desktop-wsl-token", "desktop-wsl-token")).toBe(true);
    expect(timingSafeEqualUtf8("desktop-wsl-token", "wrong-token")).toBe(false);
  });
});
