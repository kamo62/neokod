import { describe, expect, it } from "@effect/vitest";
import { TransportOriginInvalidError } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as LocalTransportAuth from "./LocalTransportAuth.ts";

const makeAuth = (overrides: Partial<ServerConfig.ServerConfig["Service"]> = {}) =>
  LocalTransportAuth.make.pipe(
    Effect.provideService(
      ServerConfig.ServerConfig,
      ServerConfig.make({
        transport: "loopback",
        host: "127.0.0.1",
        wslBearerToken: undefined,
        loopbackAuthToken: undefined,
        publicHosts: [],
        publicOrigins: [],
        strictTransport: true,
        devUrl: undefined,
        ...overrides,
      } as ServerConfig.ServerConfig["Service"]),
    ),
  );

const withAuth =
  (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  (url: string, headers: Readonly<Record<string, string>> = {}) =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request(url, { headers: { host: new URL(url).host, ...headers } }),
      );
      const auth = yield* makeAuth(overrides);
      return yield* auth.validate.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );
    });

describe("LocalTransportAuth", () => {
  it.effect("accepts a loopback Host on the loopback transport", () =>
    withAuth({})("http://127.0.0.1:8080/", { origin: "http://127.0.0.1:8080" }),
  );

  it.effect("accepts localhost and [::1] Hosts", () =>
    Effect.gen(function* () {
      yield* withAuth({})("http://localhost:8080/", { origin: "http://localhost:8080" });
      yield* withAuth({})("http://[::1]:8080/", { origin: "http://[::1]:8080" });
    }),
  );

  it.effect("rejects a non-loopback Host that is not declared public", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withAuth({})("http://evil.example.com/", { origin: "http://evil.example.com" }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(TransportOriginInvalidError);
        expect(result.failure.reason).toBe("invalid_host");
      }
    }),
  );

  // With strict-transport off (the default), a foreign Host + Origin that
  // validation would otherwise reject passes straight through.
  it.effect("with strict-transport off, accepts any Host and Origin", () =>
    withAuth({ strictTransport: false })("http://evil.example.com/", {
      origin: "https://evil.example.com",
    }),
  );

  it.effect("accepts a declared public Host and Origin", () =>
    withAuth({
      publicHosts: ["neokod.example.com"],
      publicOrigins: ["https://neokod.example.com"],
    })("http://neokod.example.com/", { origin: "https://neokod.example.com" }),
  );

  it.effect("rejects a declared public Host with a foreign Origin", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withAuth({ publicHosts: ["neokod.example.com"] })("http://neokod.example.com/", {
          origin: "https://evil.example.com",
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("invalid_origin");
      }
    }),
  );

  it.effect("rejects multiple Host headers", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withAuth({})("http://127.0.0.1:8080/", {
          host: "127.0.0.1:8080, evil.example.com",
          origin: "http://127.0.0.1:8080",
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("accepts desktop renderer origins", () =>
    withAuth({})("http://127.0.0.1:8080/", { origin: "neokod://app" }),
  );

  it.effect("accepts requests with no Origin (non-browser clients)", () =>
    withAuth({})("http://127.0.0.1:8080/"),
  );

  it.effect("accepts a self-origin (origin equals request origin)", () =>
    withAuth({})("http://127.0.0.1:8080/", { origin: "http://127.0.0.1:8080" }),
  );

  it.effect("rejects a missing Host header", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1:8080/", { headers: { origin: "http://127.0.0.1:8080" } }),
      );
      const auth = yield* makeAuth({});
      const result = yield* Effect.result(
        auth.validate.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
