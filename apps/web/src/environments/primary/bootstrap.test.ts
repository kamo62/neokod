import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getPrimaryKnownEnvironment,
  isDesktopEnvironmentBootstrapIncompleteError,
  isPrimaryEnvironmentProtocolUnsupportedError,
  isPrimaryEnvironmentTargetRejectedError,
  isPrimaryEnvironmentUrlInvalidError,
  readPrimaryEnvironmentTarget,
  resolveDesktopEnvironmentBootstrapTarget,
  resolvePrimaryEnvironmentHttpUrl,
  resolveInitialPrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from ".";
import { installEnvironmentHttpTest } from "../../../test/environmentHttpTest";

const BASE_ENVIRONMENT = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
} satisfies ExecutionEnvironmentDescriptor;

let disposeHttpTest: (() => Promise<void>) | undefined;

async function installDescriptorApi() {
  const testApi = await installEnvironmentHttpTest({
    descriptor: () => Effect.succeed(BASE_ENVIRONMENT),
  });
  disposeHttpTest = testApi.dispose;
  return testApi;
}

function installTestBrowser(url: string) {
  vi.stubGlobal("window", {
    location: new URL(url),
    history: {
      replaceState: vi.fn(),
    },
  });
}

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to throw.");
}

describe("environmentBootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
    resetPrimaryEnvironmentDescriptorForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("attaches the bootstrapped environment descriptor to the primary environment", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:3773",
      },
      desktopBridge: undefined,
    });
    writePrimaryEnvironmentDescriptor({
      environmentId: EnvironmentId.make("environment-local"),
      label: "Bootstrapped environment",
      platform: {
        os: "darwin",
        arch: "arm64",
      },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
      },
    });

    expect(getPrimaryKnownEnvironment()).toEqual({
      id: "environment-local",
      label: "Bootstrapped environment",
      source: "window-origin",
      environmentId: "environment-local",
      target: {
        httpBaseUrl: "http://localhost:3773/",
        wsBaseUrl: "ws://localhost:3773/",
      },
    });
  });

  it("reuses an in-flight descriptor bootstrap request", async () => {
    const testApi = await installDescriptorApi();

    await Promise.all([
      resolveInitialPrimaryEnvironmentDescriptor(),
      resolveInitialPrimaryEnvironmentDescriptor(),
    ]);

    expect(testApi.calls.descriptor).toBe(1);
  });

  it("uses https descriptor urls when the primary environment uses wss", async () => {
    vi.stubEnv("VITE_HTTP_URL", "https://127.0.0.1:3773");
    vi.stubEnv("VITE_WS_URL", "wss://127.0.0.1:3773");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://127.0.0.1:3773/.well-known/t3/environment",
    );
  });

  it("derives the websocket url when only VITE_HTTP_URL is configured", async () => {
    vi.stubEnv("VITE_HTTP_URL", "https://127.0.0.1:3773");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://127.0.0.1:3773/.well-known/t3/environment",
    );
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://127.0.0.1:3773/",
      wsBaseUrl: "wss://127.0.0.1:3773/",
    });
  });

  it("derives the http url when only VITE_WS_URL is configured", async () => {
    vi.stubEnv("VITE_WS_URL", "wss://127.0.0.1:3773");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://127.0.0.1:3773/.well-known/t3/environment",
    );
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://127.0.0.1:3773/",
      wsBaseUrl: "wss://127.0.0.1:3773/",
    });
  });

  it("uses the current origin as the descriptor base for local dev environments", async () => {
    installTestBrowser("http://localhost:5735/");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://localhost:5735/.well-known/t3/environment",
    );
  });

  it("uses the vite proxy for desktop-managed loopback descriptor requests during local dev", async () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: {
        replaceState: vi.fn(),
      },
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "Windows",
            transport: "loopback",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          },
        ],
      },
    });
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:5733/.well-known/t3/environment",
    );
  });

  it("retains the URL parser cause without exposing the configured URL in its message", () => {
    vi.stubEnv("VITE_HTTP_URL", "http://[");

    const error = captureThrown(readPrimaryEnvironmentTarget);

    expect(isPrimaryEnvironmentUrlInvalidError(error)).toBe(true);
    if (!isPrimaryEnvironmentUrlInvalidError(error)) {
      throw new Error("Expected a structured primary environment URL error.");
    }
    expect(error).toMatchObject({
      source: "configured",
      urlKind: "http-base-url",
      message: "Could not parse http-base-url for the configured primary environment target.",
    });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain("http://[");
  });

  it.each([
    [
      "remote configured target",
      "https://remote.example.com",
      "wss://remote.example.com",
      "non-loopback",
    ],
    ["LAN configured target", "http://192.168.1.20:3773", "ws://192.168.1.20:3773", "non-loopback"],
    ["wildcard configured target", "http://0.0.0.0:3773", "ws://0.0.0.0:3773", "non-loopback"],
    [
      "mismatched configured hosts",
      "http://127.0.0.1:3773",
      "ws://localhost:3773",
      "endpoint-mismatch",
    ],
    [
      "embedded credentials",
      "http://user:secret@127.0.0.1:3773",
      "ws://127.0.0.1:3773",
      "credentials",
    ],
  ])("rejects %s", (_label, httpBaseUrl, wsBaseUrl, reason) => {
    vi.stubEnv("VITE_HTTP_URL", httpBaseUrl);
    vi.stubEnv("VITE_WS_URL", wsBaseUrl);

    const error = captureThrown(readPrimaryEnvironmentTarget);
    expect(isPrimaryEnvironmentTargetRejectedError(error)).toBe(true);
    expect(error).toMatchObject({ source: "configured", reason });
  });

  it("accepts an authenticated desktop WSL primary target", () => {
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: { replaceState: vi.fn() },
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "WSL",
            transport: "wsl-bearer",
            runningDistro: "Ubuntu",
            httpBaseUrl: "http://172.28.64.10:3773",
            wsBaseUrl: "ws://172.28.64.10:3773",
            bootstrapToken: "desktop-bootstrap-token",
          },
        ],
      },
    });

    expect(readPrimaryEnvironmentTarget()).toEqual({
      source: "desktop-managed",
      target: {
        httpBaseUrl: "http://172.28.64.10:3773/",
        wsBaseUrl: "ws://172.28.64.10:3773/",
      },
    });
  });

  it("accepts an authenticated parallel WSL bootstrap", () => {
    expect(
      resolveDesktopEnvironmentBootstrapTarget({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://172.28.64.10:3774",
        wsBaseUrl: "ws://172.28.64.10:3774",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    ).toEqual({
      source: "desktop-managed",
      target: {
        httpBaseUrl: "http://172.28.64.10:3774/",
        wsBaseUrl: "ws://172.28.64.10:3774/",
      },
    });
  });

  it.each([
    ["localhost", "http://localhost:3773", "ws://localhost:3773"],
    ["IPv4 loopback", "http://127.0.0.1:3773", "ws://127.0.0.1:3773"],
    ["IPv6 loopback", "http://[::1]:3773", "ws://[::1]:3773"],
  ])("accepts %s configured targets", (_label, httpBaseUrl, wsBaseUrl) => {
    vi.stubEnv("VITE_HTTP_URL", httpBaseUrl);
    vi.stubEnv("VITE_WS_URL", wsBaseUrl);

    expect(readPrimaryEnvironmentTarget()).toMatchObject({
      source: "configured",
      target: { httpBaseUrl: `${httpBaseUrl}/`, wsBaseUrl: `${wsBaseUrl}/` },
    });
  });

  it("rejects a non-loopback desktop target with the loopback discriminator", () => {
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: { replaceState: vi.fn() },
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "Local environment",
            transport: "loopback",
            httpBaseUrl: "http://192.168.1.20:3773",
            wsBaseUrl: "ws://192.168.1.20:3773",
          },
        ],
      },
    });

    const error = captureThrown(readPrimaryEnvironmentTarget);
    expect(isPrimaryEnvironmentTargetRejectedError(error)).toBe(true);
    expect(error).toMatchObject({ source: "desktop-managed", reason: "wsl-authentication" });
  });

  it("rejects a forged WSL discriminator without its credential", () => {
    const error = captureThrown(() =>
      resolveDesktopEnvironmentBootstrapTarget({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://172.28.64.10:3774",
        wsBaseUrl: "ws://172.28.64.10:3774",
      }),
    );

    expect(error).toMatchObject({ source: "desktop-managed", reason: "wsl-authentication" });
  });

  it("rejects mismatched authenticated WSL origins", () => {
    const error = captureThrown(() =>
      resolveDesktopEnvironmentBootstrapTarget({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://172.28.64.10:3774",
        wsBaseUrl: "ws://172.28.64.11:3774",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    );

    expect(error).toMatchObject({ source: "desktop-managed", reason: "endpoint-mismatch" });
  });

  it("rejects a non-loopback window origin", () => {
    installTestBrowser("https://app.example.com/");

    const error = captureThrown(readPrimaryEnvironmentTarget);
    expect(isPrimaryEnvironmentTargetRejectedError(error)).toBe(true);
    expect(error).toMatchObject({ source: "window-origin", reason: "non-loopback" });
  });

  it("describes which desktop bootstrap endpoint is missing", () => {
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: { replaceState: vi.fn() },
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "Local environment",
            transport: "loopback",
            httpBaseUrl: "http://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          },
        ],
      },
    });

    const error = captureThrown(readPrimaryEnvironmentTarget);

    expect(isDesktopEnvironmentBootstrapIncompleteError(error)).toBe(true);
    if (!isDesktopEnvironmentBootstrapIncompleteError(error)) {
      throw new Error("Expected a structured desktop bootstrap error.");
    }
    expect(error).toMatchObject({
      hasHttpBaseUrl: true,
      hasWsBaseUrl: false,
      message: "Desktop bootstrap is missing wsBaseUrl for the local environment.",
    });
  });

  it("preserves an unsupported window-origin protocol", () => {
    vi.stubGlobal("window", {
      location: { origin: "file:///tmp/t3code/" },
      history: { replaceState: vi.fn() },
    });

    const error = captureThrown(readPrimaryEnvironmentTarget);

    expect(isPrimaryEnvironmentProtocolUnsupportedError(error)).toBe(true);
    if (!isPrimaryEnvironmentProtocolUnsupportedError(error)) {
      throw new Error("Expected a structured primary environment protocol error.");
    }
    expect(error).toMatchObject({
      source: "window-origin",
      protocol: "file:",
      message: "The window-origin primary environment target uses unsupported protocol file:.",
    });
  });
});
