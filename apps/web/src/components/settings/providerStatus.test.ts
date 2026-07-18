import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

describe("getProviderSummary", () => {
  it("explains that an unprobed disabled provider must be enabled first", () => {
    expect(getProviderSummary(undefined, { enabled: false })).toEqual({
      headline: "Disabled",
      detail: "Disabled — enable to detect and configure",
    });
  });
});
