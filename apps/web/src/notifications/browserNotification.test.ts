import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readBrowserNotificationCapability,
  requestBrowserNotificationPermission,
  showBrowserActivityNotification,
} from "./browserNotification";

const globalScope = globalThis as typeof globalThis & { window?: Window };
const originalWindow = globalScope.window;
const testWindow = originalWindow ?? ({} as Window);
const originalNotification = globalThis.Notification;
const originalWindowNotification = testWindow.Notification;
const originalSecureContext = testWindow.isSecureContext;

if (originalWindow === undefined) {
  Object.defineProperty(globalScope, "window", { configurable: true, value: testWindow });
}

afterEach(() => {
  Object.defineProperty(testWindow, "Notification", {
    configurable: true,
    value: originalWindowNotification,
  });
  Object.defineProperty(testWindow, "isSecureContext", {
    configurable: true,
    value: originalSecureContext,
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: originalNotification,
  });
});

afterAll(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalScope, "window");
});

function installNotification(permission: NotificationPermission, construct = vi.fn()) {
  class TestNotification {
    static permission = permission;
    static requestPermission = vi.fn().mockResolvedValue(permission);
    onclick: ((event: Event) => void) | null = null;
    close = vi.fn();
    constructor(...args: unknown[]) {
      construct(...args);
    }
  }
  Object.defineProperty(testWindow, "Notification", {
    configurable: true,
    value: TestNotification,
  });
  Object.defineProperty(testWindow, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: TestNotification,
  });
  return TestNotification;
}

describe("browser activity notifications", () => {
  it("reports unsupported and insecure contexts", () => {
    Object.defineProperty(testWindow, "Notification", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: undefined });
    expect(readBrowserNotificationCapability()).toBe("unsupported");
    installNotification("default");
    Object.defineProperty(testWindow, "isSecureContext", { configurable: true, value: false });
    expect(readBrowserNotificationCapability()).toBe("insecure");
  });

  it("requests only from the explicit caller and returns the post-request permission", async () => {
    const notification = installNotification("default");
    expect(await requestBrowserNotificationPermission()).toBe("default");
    expect(notification.requestPermission).toHaveBeenCalledOnce();
  });

  it("handles permission races and constructor failures without claiming delivery", () => {
    installNotification("default");
    expect(showBrowserActivityNotification({ title: "x", tag: "x", onClick: () => {} })).toBe(
      "not-granted",
    );
    installNotification(
      "granted",
      vi.fn(() => {
        throw new Error("blocked");
      }),
    );
    expect(showBrowserActivityNotification({ title: "x", tag: "x", onClick: () => {} })).toBe(
      "construction-failed",
    );
  });

  it("creates silent granted notifications", () => {
    const construct = vi.fn();
    installNotification("granted", construct);
    expect(
      showBrowserActivityNotification({ title: "Finished", tag: "scope", onClick: () => {} }),
    ).toBe("shown");
    expect(construct).toHaveBeenCalledWith("Finished", { tag: "scope", silent: true });
  });
});
