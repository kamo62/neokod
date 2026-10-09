import { describe, expect, it } from "@effect/vitest";
import { TransportOriginInvalidError } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
    withPeerAuth(overrides)(url, headers, Option.none());

const withPeerAuth =
  (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  (
    url: string,
    headers: Readonly<Record<string, string>> = {},
    remoteAddress: Option.Option<string> = Option.none(),
  ) =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request(url, { headers: { host: new URL(url).host, ...headers } }),
      ).modify({ remoteAddress });
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

  it.effect(
    "with strict-transport off and a token configured, a foreign Host still passes validation (the bearer is the credential)",
    () =>
      withAuth({ strictTransport: false, loopbackAuthToken: "t".repeat(40) })(
        "http://evil.example.com/",
        {},
      ),
  );

  it.effect("a non-loopback bind validates even when strict-transport is off", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withAuth({ host: "100.81.180.76", strictTransport: false })("http://evil.example.com/", {}),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("invalid_host");
      }
    }),
  );

  it.effect("a non-loopback bind accepts IP literal Hosts", () =>
    Effect.gen(function* () {
      yield* withAuth({ host: "100.81.180.76", strictTransport: false })(
        "http://100.81.180.76:3773/",
      );
      yield* withAuth({ host: "100.81.180.76", strictTransport: false })(
        "http://[fd7a:115c:a1e0::1]:3773/",
      );
    }),
  );

  it.effect("a non-loopback bind needs declared public hosts for names", () =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        withAuth({ host: "100.81.180.76", strictTransport: false })("http://wv-htpc.tail1.ts.net/"),
      );
      expect(denied._tag).toBe("Failure");
      yield* withAuth({
        host: "100.81.180.76",
        strictTransport: false,
        publicHosts: ["wv-htpc.tail1.ts.net"],
      })("http://wv-htpc.tail1.ts.net/");
    }),
  );

  it.effect("a non-loopback bind rejects Origin null and accepts a localhost origin", () =>
    Effect.gen(function* () {
      const nulled = yield* Effect.result(
        withAuth({ host: "100.81.180.76", strictTransport: false })("http://100.81.180.76:3773/", {
          origin: "null",
        }),
      );
      expect(nulled._tag).toBe("Failure");
      if (nulled._tag === "Failure") {
        expect(nulled.failure.reason).toBe("invalid_origin");
      }
      yield* withAuth({ host: "100.81.180.76", strictTransport: false })(
        "http://100.81.180.76:3773/",
        { origin: "http://localhost:3773" },
      );
    }),
  );

  it.effect("a loopback bind still accepts Origin null", () =>
    withAuth({})("http://127.0.0.1:8080/", { origin: "null" }),
  );

  it.effect("allows a listed Tailscale login case-insensitively", () =>
    withPeerAuth({
      tailscaleAllowLogins: ["kamo@example.com"],
      strictTransport: false,
    })(
      "http://127.0.0.1:8080/",
      { origin: "http://127.0.0.1:8080", "tailscale-user-login": "Kamo@Example.com" },
      Option.some("127.0.0.1"),
    ),
  );

  it.effect("rejects a missing Tailscale login header with tailscale_login_not_allowed", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withPeerAuth({
          tailscaleAllowLogins: ["kamo@example.com"],
          strictTransport: false,
        })("http://127.0.0.1:8080/", { origin: "http://127.0.0.1:8080" }, Option.some("127.0.0.1")),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("tailscale_login_not_allowed");
      }
    }),
  );

  it.effect("rejects another Tailscale login", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withPeerAuth({
          tailscaleAllowLogins: ["kamo@example.com"],
          strictTransport: false,
        })(
          "http://127.0.0.1:8080/",
          { origin: "http://127.0.0.1:8080", "tailscale-user-login": "other@example.com" },
          Option.some("127.0.0.1"),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("tailscale_login_not_allowed");
      }
    }),
  );

  it.effect("rejects when the peer is not loopback even with a listed login", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withPeerAuth({
          tailscaleAllowLogins: ["kamo@example.com"],
          strictTransport: false,
        })(
          "http://127.0.0.1:8080/",
          { origin: "http://127.0.0.1:8080", "tailscale-user-login": "kamo@example.com" },
          Option.some("10.0.0.5"),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("tailscale_login_not_allowed");
      }
    }),
  );

  it.effect("rejects when the peer address is unknown", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withPeerAuth({
          tailscaleAllowLogins: ["kamo@example.com"],
          strictTransport: false,
        })(
          "http://127.0.0.1:8080/",
          { origin: "http://127.0.0.1:8080", "tailscale-user-login": "kamo@example.com" },
          Option.none(),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("tailscale_login_not_allowed");
      }
    }),
  );

  it.effect("ignores the Tailscale header entirely when no allowlist is set", () =>
    withPeerAuth({ strictTransport: false })(
      "http://127.0.0.1:8080/",
      { origin: "http://127.0.0.1:8080", "tailscale-user-login": "attacker@example.com" },
      Option.some("10.0.0.5"),
    ),
  );
});
