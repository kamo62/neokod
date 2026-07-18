import { describe, expect, it } from "vite-plus/test";
import { resolveSourceControlDiscoveryView } from "./SourceControlSettings.logic";

describe("resolveSourceControlDiscoveryView", () => {
  it("waits for an environment when none is connected, regardless of query state", () => {
    expect(
      resolveSourceControlDiscoveryView({
        hasEnvironment: false,
        isPending: false,
        hasData: false,
        hasDiscoveryItems: false,
      }),
    ).toBe("waiting-for-environment");

    expect(
      resolveSourceControlDiscoveryView({
        hasEnvironment: false,
        isPending: true,
        hasData: false,
        hasDiscoveryItems: false,
      }),
    ).toBe("waiting-for-environment");
  });

  it("shows loading while the discovery query is in flight for a connected environment", () => {
    expect(
      resolveSourceControlDiscoveryView({
        hasEnvironment: true,
        isPending: true,
        hasData: false,
        hasDiscoveryItems: false,
      }),
    ).toBe("loading");
  });

  it("shows the empty state only once a connected environment's scan returns zero items", () => {
    expect(
      resolveSourceControlDiscoveryView({
        hasEnvironment: true,
        isPending: false,
        hasData: true,
        hasDiscoveryItems: false,
      }),
    ).toBe("empty");
  });

  it("shows results once discovery items are present", () => {
    expect(
      resolveSourceControlDiscoveryView({
        hasEnvironment: true,
        isPending: false,
        hasData: true,
        hasDiscoveryItems: true,
      }),
    ).toBe("results");
  });

  it("keeps showing results during a rescan of an environment that already has items", () => {
    expect(
      resolveSourceControlDiscoveryView({
        hasEnvironment: true,
        isPending: true,
        hasData: true,
        hasDiscoveryItems: true,
      }),
    ).toBe("results");
  });
});
