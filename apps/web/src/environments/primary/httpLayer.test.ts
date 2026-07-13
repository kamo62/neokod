import type { DesktopBridge } from "@neokod/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { makePrimaryEnvironmentHttpLayer } from "./httpLayer";

describe.sequential("primary environment HTTP layer", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("sends no authorization for a browser loopback primary", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:3773/settings",
          origin: "http://127.0.0.1:3773",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/orchestration/shell");
      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect("attaches the desktop topology bearer for a WSL-only primary", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "neokod://app/settings", origin: "neokod://app" },
        desktopBridge: {
          getLocalEnvironmentBootstraps: () => [
            {
              id: "primary",
              label: "WSL (Ubuntu)",
              transport: "wsl-bearer",
              runningDistro: "Ubuntu",
              httpBaseUrl: "http://172.27.0.2:3773",
              wsBaseUrl: "ws://172.27.0.2:3773",
              wslBearerToken: "wsl-bearer-token",
            },
          ],
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://172.27.0.2:3773/api/orchestration/shell");
      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.headers.get("authorization")).toBe("Bearer wsl-bearer-token");
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });
});
