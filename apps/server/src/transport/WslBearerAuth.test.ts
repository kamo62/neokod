import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import { parseAllowedOrigins } from "./allowedOrigin.ts";
import * as WslBearerAuth from "./WslBearerAuth.ts";

const makeAuth = (
  transport: "loopback" | "wsl-bearer" = "wsl-bearer",
  publicOrigins: ReadonlySet<string> = new Set(),
) =>
  WslBearerAuth.make.pipe(
    Effect.provideService(
      ServerConfig.ServerConfig,
      ServerConfig.make({
        transport,
        host: transport === "loopback" ? "127.0.0.1" : "0.0.0.0",
        publicOrigins,
        wslBearerToken: transport === "wsl-bearer" ? "desktop-wsl-bearer" : undefined,
      } as ServerConfig.ServerConfig["Service"]),
    ),
  );

/** A request as the upgrade/HTTP gates see it, with explicit Host and Origin. */
const makeRequest = (input: {
  readonly url: string;
  readonly origin?: string;
  readonly host?: string;
}) => {
  const url = new URL(input.url);
  return HttpServerRequest.fromClientRequest(
    HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeaders({
        host: input.host ?? url.host,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      }),
    ),
  );
};

describe("WslBearerAuth", () => {
  it.effect("leaves loopback HTTP and WebSocket upgrades direct", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth("loopback");
      yield* auth.authorizeBearerHeader(undefined);
      yield* auth.consumeWebSocketTicket(null);
    }),
  );

  it.effect("rejects missing and incorrect WSL bearer headers", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth();
      expect(yield* auth.authorizeBearerHeader(undefined).pipe(Effect.flip)).toMatchObject({
        reason: "missing_credential",
      });
      expect(yield* auth.authorizeBearerHeader("Bearer wrong").pipe(Effect.flip)).toMatchObject({
        reason: "invalid_credential",
      });
      yield* auth.authorizeBearerHeader("Bearer desktop-wsl-bearer");
    }),
  );

  it.effect("consumes WSL WebSocket tickets exactly once", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth();
      const issued = yield* auth.issueWebSocketTicket;
      yield* auth.consumeWebSocketTicket(issued.ticket);
      expect(yield* auth.consumeWebSocketTicket(issued.ticket).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_websocket_ticket",
      });
    }),
  );

  it.effect("rejects missing and unknown WSL WebSocket tickets", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth();
      expect(yield* auth.consumeWebSocketTicket(null).pipe(Effect.flip)).toMatchObject({
        reason: "missing_websocket_ticket",
      });
      expect(yield* auth.consumeWebSocketTicket("unknown").pipe(Effect.flip)).toMatchObject({
        reason: "invalid_websocket_ticket",
      });
    }),
  );

  it.effect("rejects expired WSL WebSocket tickets", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth();
      const issued = yield* auth.issueWebSocketTicket;
      yield* TestClock.adjust("31 seconds");
      expect(yield* auth.consumeWebSocketTicket(issued.ticket).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_websocket_ticket",
      });
    }),
  );
});

describe("WslBearerAuth origin validation", () => {
  it.effect("allows a loopback upgrade with nothing configured, the default install", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth("loopback");
      yield* auth.authorizeWebSocketUpgrade.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({ url: "http://127.0.0.1:4096/ws", origin: "http://127.0.0.1:4096" }),
        ),
      );
    }),
  );

  it.effect("allows the desktop renderer's custom-scheme origin on loopback", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth("loopback");
      yield* auth.authorizeWebSocketUpgrade.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({ url: "http://127.0.0.1:4096/ws", origin: "neokod://app" }),
        ),
      );
    }),
  );

  it.effect("rejects a rebinding upgrade, where Host and Origin agree on the attacker's name", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth("loopback");
      const failure = yield* auth.authorizeWebSocketUpgrade.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({ url: "http://evil.example/ws", origin: "http://evil.example" }),
        ),
        Effect.flip,
      );
      expect(failure).toMatchObject({ reason: "origin_not_allowed" });
      expect(failure.message).toContain("evil.example");
      expect(failure.message).toContain("NEOKOD_PUBLIC_ORIGIN");
    }),
  );

  it.effect("allows the configured public origin through the upgrade gate", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth("loopback", parseAllowedOrigins("https://neokod.example.com"));
      yield* auth.authorizeWebSocketUpgrade.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({
            url: "http://neokod.example.com/ws",
            origin: "https://neokod.example.com",
          }),
        ),
      );
    }),
  );

  it.effect("applies the same rule to the HTTP gate", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth("loopback");
      const allowed = auth.authorizeHttpRequest.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({ url: "http://127.0.0.1:4096/api/orchestration/shell" }),
        ),
      );
      yield* allowed;
      const rejected = auth.authorizeHttpRequest.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({
            url: "http://evil.example/api/orchestration/shell",
            origin: "http://evil.example",
          }),
        ),
        Effect.flip,
      );
      expect(yield* rejected).toMatchObject({ reason: "origin_not_allowed" });
    }),
  );

  it.effect("leaves the wsl-bearer transport's own gates in charge", () =>
    Effect.gen(function* () {
      // The desktop reaches the WSL listener through a non-loopback address
      // that no allowlist could name in advance; the ticket authenticates it.
      const auth = yield* makeAuth();
      const issued = yield* auth.issueWebSocketTicket;
      yield* auth.authorizeWebSocketUpgrade.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({
            url: `http://172.20.240.1:3773/ws?wsTicket=${issued.ticket}`,
          }),
        ),
      );
    }),
  );

  it.effect("rejects a malformed Host that URL parsing would have waved through", () =>
    Effect.gen(function* () {
      // `new URL("http://evil.example@localhost:3773")` reports hostname
      // `localhost`; the strict Host grammar refuses the userinfo outright.
      const auth = yield* makeAuth("loopback");
      const failure = yield* auth.authorizeWebSocketUpgrade.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({ url: "http://127.0.0.1:3773/ws", host: "evil.example@localhost:3773" }),
        ),
        Effect.flip,
      );
      expect(failure).toMatchObject({ reason: "origin_not_allowed" });
    }),
  );

  it.effect("rejects the allowed hostname when it arrives from another port", () =>
    Effect.gen(function* () {
      // Cookies are not port-scoped: content on another port of the operator's
      // host must not reach the RPC surface just by sharing the hostname.
      const auth = yield* makeAuth("loopback", parseAllowedOrigins("https://neokod.example.com"));
      const failure = yield* auth.authorizeHttpRequest.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          makeRequest({
            url: "http://neokod.example.com/api/orchestration/shell",
            origin: "https://neokod.example.com:8443",
          }),
        ),
        Effect.flip,
      );
      expect(failure).toMatchObject({ reason: "origin_not_allowed" });
      expect(failure.message).toContain("https://neokod.example.com:8443");
    }),
  );
});
