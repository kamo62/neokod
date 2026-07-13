import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as WslBearerAuth from "./WslBearerAuth.ts";

const makeAuth = (transport: "loopback" | "wsl-bearer" = "wsl-bearer") =>
  WslBearerAuth.make.pipe(
    Effect.provideService(
      ServerConfig.ServerConfig,
      ServerConfig.make({
        transport,
        host: transport === "loopback" ? "127.0.0.1" : "0.0.0.0",
        wslBearerToken: transport === "wsl-bearer" ? "desktop-wsl-bearer" : undefined,
      } as ServerConfig.ServerConfig["Service"]),
    ),
  );

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
