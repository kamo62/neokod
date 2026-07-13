import { describe, expect, it } from "vite-plus/test";

import {
  getPairingTokenFromUrl,
  setPairingTokenOnUrl,
  stripPairingTokenFromUrl,
} from "./remote.ts";

describe("pairing URL tokens", () => {
  it("reads current query tokens and legacy hash tokens", () => {
    expect(getPairingTokenFromUrl(new URL("https://example.test/?token=query"))).toBe("query");
    expect(getPairingTokenFromUrl(new URL("https://example.test/#token=hash"))).toBe("hash");
  });

  it("sets query tokens and strips either representation", () => {
    expect(setPairingTokenOnUrl(new URL("https://example.test/"), "token").toString()).toBe(
      "https://example.test/?token=token",
    );
    expect(
      stripPairingTokenFromUrl(
        new URL("https://example.test/?token=query#token=hash&keep=value"),
      ).toString(),
    ).toBe("https://example.test/#keep=value");
  });
});
