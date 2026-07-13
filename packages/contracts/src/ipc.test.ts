import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        wslBearerToken: "wsl-bearer-token",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      transport: "wsl-bearer",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      wslBearerToken: "wsl-bearer-token",
    });
  });

  it("keeps the loopback primary credential-free", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        transport: "loopback",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    ).toEqual({
      id: "primary",
      label: "Windows",
      transport: "loopback",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
  });

  it("rejects WSL topology without its bearer", () => {
    expect(() =>
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        transport: "wsl-bearer",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toThrow();
  });
});
