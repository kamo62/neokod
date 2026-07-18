import { describe, expect, it } from "vite-plus/test";
import {
  resolveSourceControlAuthSummary,
  resolveSourceControlDiscoveryView,
} from "./SourceControlSettings.logic";

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

describe("resolveSourceControlAuthSummary", () => {
  it("surfaces the server's remediation detail for an unauthenticated provider instead of the generic sign-in copy", () => {
    expect(
      resolveSourceControlAuthSummary({
        authStatus: "unauthenticated",
        authDetail: "Run `gh auth login` to authenticate GitHub CLI.",
        label: "GitHub",
        installHint: "Install the GitHub CLI (`gh`).",
      }),
    ).toEqual({
      kind: "text",
      text: "GitHub is not ready on this server. Run `gh auth login` to authenticate GitHub CLI.",
    });
  });

  it("falls back to the generic sign-in guidance when an unauthenticated provider has no detail", () => {
    expect(
      resolveSourceControlAuthSummary({
        authStatus: "unauthenticated",
        authDetail: null,
        label: "GitHub",
        installHint: "Install the GitHub CLI (`gh`).",
      }),
    ).toEqual({ kind: "unauthenticated-guidance" });
  });

  it("surfaces the remediation detail for an unknown-status provider without duplicating installHint", () => {
    const result = resolveSourceControlAuthSummary({
      authStatus: "unknown",
      authDetail: "Install the Azure DevOps CLI extension: az extension add --name azure-devops",
      label: "Azure DevOps",
      installHint:
        "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
    });

    expect(result).toEqual({
      kind: "text",
      text: "Could not verify Azure DevOps. Install the Azure DevOps CLI extension: az extension add --name azure-devops",
    });
    // installHint's own "az extension add" phrase must not additionally appear: the detail
    // fully replaces installHint rather than being appended alongside it.
    expect(result.kind === "text" ? result.text.match(/az extension add/g)?.length : 0).toBe(1);
  });

  it("falls back to installHint for an unknown-status provider with no detail", () => {
    expect(
      resolveSourceControlAuthSummary({
        authStatus: "unknown",
        authDetail: null,
        label: "Azure DevOps",
        installHint: "Install the Azure command-line tools (`az`).",
      }),
    ).toEqual({
      kind: "text",
      text: "Could not verify Azure DevOps. Install the Azure command-line tools (`az`).",
    });
  });
});
