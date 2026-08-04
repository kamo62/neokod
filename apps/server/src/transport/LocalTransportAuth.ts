import { TransportOriginInvalidError, type TransportOriginInvalidReason } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import { isLoopbackHostname } from "../http.ts";

/**
 * Router-wide Host/Origin validation (PRD 17.1, plan 13.2 Step A).
 *
 * Applied as HTTP-server middleware in `server.ts` before route dispatch and
 * before the WebSocket upgrade, so no route (API, OTLP, ticket, asset,
 * static/dev, WebSocket, MCP) is reachable with an unexpected Host or Origin.
 *
 * Host validation: loopback bind accepts `127.0.0.1:<port>`, `localhost:<port>`,
 * and `[::1]:<port>` plus any declared public host. Malformed Hosts and
 * multiple Host headers are rejected outright.
 *
 * Origin validation: dev origin(s), `neokod://app`, `neokod-dev://app`,
 * self-origin (Origin host matches the request Host), and any declared public
 * origin. Requests with no Origin (non-browser clients) pass this check; they
 * are still subject to the WS-A2 credential policy.
 */

const DESKTOP_RENDERER_ORIGINS = new Set(["neokod://app", "neokod-dev://app"]);

export class LocalTransportAuth extends Context.Service<
  LocalTransportAuth,
  {
    /** Middleware that rejects requests with an invalid Host or Origin. */
    readonly middleware: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, TransportOriginInvalidError | E, HttpServerRequest.HttpServerRequest | R>;
    /** Standalone validation (for tests / direct WS upgrade integration). */
    readonly validate: Effect.Effect<
      void,
      TransportOriginInvalidError,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("neokod/transport/LocalTransportAuth") {}

const failInvalid = (reason: TransportOriginInvalidReason, expected: string, received: string) =>
  Effect.fail(
    new TransportOriginInvalidError({
      code: "transport_origin_invalid",
      reason,
      expected,
      received,
    }),
  );

const parseHostHeader = (
  hostHeader: string,
): { readonly hostname: string; readonly port: string | undefined } => {
  // Strip an IPv6 bracket form, keeping the port if present.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostHeader.trim());
  if (bracketed !== null) {
    return { hostname: bracketed[1] ?? "", port: bracketed[2] };
  }
  // Host:port split on the last colon; a bare hostname has no port.
  const lastColon = hostHeader.lastIndexOf(":");
  if (lastColon === -1) {
    return { hostname: hostHeader.trim().toLowerCase(), port: undefined };
  }
  const maybePort = hostHeader.slice(lastColon + 1);
  if (/^\d+$/.test(maybePort)) {
    return { hostname: hostHeader.slice(0, lastColon).trim().toLowerCase(), port: maybePort };
  }
  return { hostname: hostHeader.trim().toLowerCase(), port: undefined };
};

const normalizeOriginHostname = (origin: string): string | undefined => {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const devOrigin = config.devUrl?.origin;
  const declaredPublicOrigins: ReadonlyArray<string> = config.publicOrigins ?? [];
  const declaredPublicHosts: ReadonlyArray<string> = config.publicHosts ?? [];
  const expectedHostSummary =
    declaredPublicHosts.length > 0 ? declaredPublicHosts.join(", ") : "loopback host";

  const validate = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return yield* failInvalid("invalid_host", expectedHostSummary, "unparseable request URL");
    }

    // The WSL bearer transport binds 0.0.0.0 and is reached via the distro's
    // eth0 IP or localhost; Host/Origin pinning would break it. Its credential
    // is the bearer token (WS-A2), enforced separately. Host/Origin validation
    // applies to the loopback transport, where a rebinding page is the threat.
    if (config.transport === "wsl-bearer") {
      return;
    }

    const hostHeader = Headers.get(request.headers, "host");
    if (Option.isNone(hostHeader) || hostHeader.value.trim().length === 0) {
      return yield* failInvalid("invalid_host", expectedHostSummary, "missing Host header");
    }
    const hostHeaderValue = hostHeader.value;
    // Multiple Host headers are rejected outright (HTTP smuggling / ambiguity).
    if (hostHeaderValue.includes(",")) {
      return yield* failInvalid("invalid_host", expectedHostSummary, hostHeaderValue);
    }

    const parsed = parseHostHeader(hostHeaderValue);
    const hostAllowed =
      isLoopbackHostname(parsed.hostname) ||
      declaredPublicHosts.some((entry) => entry.toLowerCase() === parsed.hostname);
    if (!hostAllowed) {
      return yield* failInvalid("invalid_host", expectedHostSummary, hostHeaderValue);
    }

    const originHeader = Headers.get(request.headers, "origin");
    if (Option.isNone(originHeader) || originHeader.value.trim().length === 0) {
      // Non-browser clients carry no Origin; the WS-A2 credential policy gates
      // them instead of this check.
      return;
    }

    const origin = originHeader.value.trim();
    if (
      origin === "null" ||
      DESKTOP_RENDERER_ORIGINS.has(origin) ||
      (devOrigin !== undefined && origin === devOrigin) ||
      declaredPublicOrigins.includes(origin) ||
      origin === requestUrl.value.origin
    ) {
      return;
    }

    const originHostname = normalizeOriginHostname(origin);
    if (
      originHostname !== undefined &&
      (isLoopbackHostname(originHostname) ||
        declaredPublicHosts.some((entry) => entry.toLowerCase() === originHostname))
    ) {
      return;
    }

    return yield* failInvalid("invalid_origin", "a local or configured origin", origin);
  });

  const middleware = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, TransportOriginInvalidError | E, HttpServerRequest.HttpServerRequest | R> =>
    validate.pipe(Effect.andThen(effect));

  return LocalTransportAuth.of({ middleware, validate });
});

export const layer = Layer.effect(LocalTransportAuth, make);
