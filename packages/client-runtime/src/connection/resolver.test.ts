import { EnvironmentId } from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ConnectionResolver from "./resolver.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { PrimaryConnectionTarget, WslConnectionTarget } from "./model.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const makeResolver = ConnectionResolver.make.pipe(
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die(new Error("Unexpected HTTP request."))),
  ),
);

describe("ConnectionResolver", () => {
  it.effect("prepares the loopback primary without authorization", () =>
    Effect.gen(function* () {
      const resolver = yield* makeResolver;
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });
      const entry: ConnectionCatalogEntry = { target, wslBearerToken: Option.none() };

      const prepared = yield* resolver.prepare(entry);
      expect(prepared.socketUrl).toBe("ws://127.0.0.1:3777/ws");
      expect(prepared.wslBearerAuthorization).toBeNull();
      expect(prepared.loopbackAuthorization ?? null).toBeNull();
    }),
  );

  it.effect("authenticates the loopback primary with a per-launch token", () =>
    Effect.gen(function* () {
      const resolver = yield* ConnectionResolver.make.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request, url) => {
            if (
              request.method === "POST" &&
              url.pathname === "/api/wsl-auth/websocket-ticket" &&
              request.headers.authorization === "Bearer launch-token"
            ) {
              const response = new Response(
                JSON.stringify({ ticket: "ticket-1", expiresAt: "2026-01-01T00:00:00Z" }),
                { status: 200 },
              );
              return Effect.succeed(HttpClientResponse.fromWeb(request, response));
            }
            return Effect.die(new Error(`Unexpected request: ${request.method} ${url.pathname}`));
          }),
        ),
      );
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });
      const entry: ConnectionCatalogEntry = {
        target,
        wslBearerToken: Option.none(),
        loopbackAuthToken: "launch-token",
      };

      const prepared = yield* resolver.prepare(entry);
      expect(prepared.loopbackAuthorization).toMatchObject({
        _tag: "LoopbackBearer",
        token: "launch-token",
      });
      expect(prepared.socketUrl).toContain("wsTicket=ticket-1");
    }),
  );

  it.effect("fails closed when a WSL bootstrap has no in-memory bearer", () =>
    Effect.gen(function* () {
      const resolver = yield* makeResolver;
      const target = new WslConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WSL",
        connectionId: "wsl:ubuntu",
        httpBaseUrl: "http://172.27.0.2:3778",
        wsBaseUrl: "ws://172.27.0.2:3778",
      });
      const entry: ConnectionCatalogEntry = { target, wslBearerToken: Option.none() };
      const error = yield* resolver.prepare(entry).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication" });
    }),
  );
});
