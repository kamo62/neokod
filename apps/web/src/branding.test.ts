import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Neokod",
            stageLabel: "Nightly",
            displayName: "Neokod (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("Neokod");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Neokod (Nightly)");
  });
});

describe("branding logic", () => {
  it("returns Nightly for nightly primary server versions even with no stable stage label", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: null,
      }),
    ).toBe("Nightly");
  });

  it("returns null for stable primary server versions when there is no stage label", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: null,
      }),
    ).toBeNull();
  });

  it("passes through an arbitrary fallback stage label for stable primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: "Dev",
      }),
    ).toBe("Dev");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Neokod",
        fallbackDisplayName: "Neokod",
        fallbackStageLabel: null,
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("Neokod (Nightly)");
  });

  it("keeps the bare fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Neokod",
        fallbackDisplayName: "Neokod",
        fallbackStageLabel: null,
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("Neokod");
  });

  it("keeps the bare fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Neokod",
        fallbackDisplayName: "Neokod",
        fallbackStageLabel: null,
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("Neokod");
  });
});
