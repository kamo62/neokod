import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { readPrimaryEnvironmentTarget, resolveDesktopEnvironmentBootstrapTarget } from "./target";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser-origin primary target boundary", () => {
  it("accepts the same public origin used by a self-hosted web client", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://neokod.example.com",
      },
    });

    expect(readPrimaryEnvironmentTarget()).toEqual({
      source: "window-origin",
      target: {
        httpBaseUrl: "https://neokod.example.com/",
        wsBaseUrl: "wss://neokod.example.com/",
      },
      transport: { _tag: "Loopback" },
    });
  });
});

describe("desktop primary target boundary", () => {
  it("accepts a credential-free loopback bootstrap", () => {
    expect(
      resolveDesktopEnvironmentBootstrapTarget({
        id: "primary",
        label: "Local environment",
        transport: "loopback",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      }),
    ).toMatchObject({ transport: { _tag: "Loopback" } });
  });

  it("accepts a desktop-proven WSL target with its bearer", () => {
    expect(
      resolveDesktopEnvironmentBootstrapTarget({
        id: "wsl:ubuntu",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://172.27.0.2:3774",
        wsBaseUrl: "ws://172.27.0.2:3774",
        wslBearerToken: "wsl-bearer-token",
      }),
    ).toMatchObject({ transport: { _tag: "WslBearer", token: "wsl-bearer-token" } });
  });

  it("rejects a forged non-WSL desktop environment id", () => {
    expect(() =>
      resolveDesktopEnvironmentBootstrapTarget({
        id: "remote:forged",
        label: "Forged remote",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://172.27.0.2:3774",
        wsBaseUrl: "ws://172.27.0.2:3774",
        wslBearerToken: "wsl-bearer-token",
      }),
    ).toThrow(/wsl-authentication/);
  });

  it("rejects a WSL desktop entry without its bearer", () => {
    expect(() =>
      resolveDesktopEnvironmentBootstrapTarget({
        id: "wsl:ubuntu",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://172.27.0.2:3774",
        wsBaseUrl: "ws://172.27.0.2:3774",
      } as Parameters<typeof resolveDesktopEnvironmentBootstrapTarget>[0]),
    ).toThrow(/wsl-authentication/);
  });

  it("rejects mismatched WSL HTTP and WebSocket origins", () => {
    expect(() =>
      resolveDesktopEnvironmentBootstrapTarget({
        id: "wsl:ubuntu",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://172.27.0.2:3774",
        wsBaseUrl: "ws://172.27.0.3:3774",
        wslBearerToken: "wsl-bearer-token",
      }),
    ).toThrow(/endpoint-mismatch/);
  });
});
