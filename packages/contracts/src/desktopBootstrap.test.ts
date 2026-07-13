import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopBackendBootstrap } from "./desktopBootstrap.ts";

const decode = Schema.decodeUnknownSync(DesktopBackendBootstrap);

const baseBootstrap = {
  mode: "desktop",
  noBrowser: true,
  port: 3773,
} as const;

describe("DesktopBackendBootstrap", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["wsl-bearer", "0.0.0.0"],
  ] as const)("accepts the %s transport with its matching host", (transport, host) => {
    const bootstrap =
      transport === "wsl-bearer"
        ? { ...baseBootstrap, transport, host, wslBearerToken: "wsl-bearer-token" }
        : { ...baseBootstrap, transport, host };
    expect(decode(bootstrap)).toMatchObject({ transport, host });
  });

  it.each([
    ["loopback", "0.0.0.0"],
    ["wsl-bearer", "127.0.0.1"],
  ] as const)("rejects the %s transport with host %s", (transport, host) => {
    expect(() =>
      decode({ ...baseBootstrap, transport, host, wslBearerToken: "wsl-bearer-token" }),
    ).toThrow();
  });

  it("rejects a wildcard WSL envelope without its bearer credential", () => {
    expect(() =>
      decode({
        mode: "desktop",
        noBrowser: true,
        port: 3773,
        transport: "wsl-bearer",
        host: "0.0.0.0",
      }),
    ).toThrow();
  });
});
