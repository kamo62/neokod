import {
  EnvironmentWslBearerInvalidError,
  type EnvironmentWslBearerInvalidReason,
  WslWebSocketTicketResult,
  type WslWebSocketTicketResult as WslWebSocketTicket,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { randomBytes } from "node:crypto";

import * as ServerConfig from "../config.ts";
import { timingSafeEqualUtf8 } from "../crypto/serverCrypto.ts";

const WEBSOCKET_TICKET_TTL_MS = 30_000;
export const WSL_WEBSOCKET_TICKET_PATH = "/api/wsl-auth/websocket-ticket";
export const WSL_WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

interface WslWebSocketTicketRecord {
  readonly expiresAt: DateTime.Utc;
}

const failInvalid = (reason: EnvironmentWslBearerInvalidReason) =>
  Effect.fail(
    new EnvironmentWslBearerInvalidError({
      code: "wsl_bearer_invalid",
      reason,
      traceId: "unavailable",
    }),
  );

export class WslBearerAuth extends Context.Service<
  WslBearerAuth,
  {
    readonly authorizeBearerHeader: (
      authorization: string | undefined,
    ) => Effect.Effect<void, EnvironmentWslBearerInvalidError>;
    readonly authorizeHttpRequest: Effect.Effect<void, EnvironmentWslBearerInvalidError>;
    readonly issueWebSocketTicket: Effect.Effect<WslWebSocketTicket>;
    readonly consumeWebSocketTicket: (
      ticket: string | null,
    ) => Effect.Effect<void, EnvironmentWslBearerInvalidError>;
    readonly authorizeWebSocketUpgrade: Effect.Effect<void, EnvironmentWslBearerInvalidError>;
  }
>()("t3/transport/WslBearerAuth") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const tickets = new Map<string, WslWebSocketTicketRecord>();

  const requireConfiguredWslToken = () => {
    const token = config.wslBearerToken?.trim();
    if (config.transport !== "wsl-bearer" || token === undefined || token.length === 0) {
      throw new Error("The wsl-bearer transport requires a desktop-generated bearer token.");
    }
    return token;
  };

  const authorizeBearerHeader = Effect.fn("WslBearerAuth.authorizeBearerHeader")(function* (
    authorization: string | undefined,
  ) {
    if (config.transport === "loopback") return;
    const expected = requireConfiguredWslToken();
    if (authorization === undefined) {
      return yield* failInvalid("missing_credential");
    }
    const prefix = "Bearer ";
    if (!authorization.startsWith(prefix)) {
      return yield* failInvalid("invalid_credential");
    }
    if (!timingSafeEqualUtf8(authorization.slice(prefix.length), expected)) {
      return yield* failInvalid("invalid_credential");
    }
  });

  const authorizeHttpRequest = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* authorizeBearerHeader(request.headers.authorization);
  }).pipe(Effect.withSpan("WslBearerAuth.authorizeHttpRequest"));

  const issueWebSocketTicket = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { milliseconds: WEBSOCKET_TICKET_TTL_MS });
    for (const [ticket, record] of tickets) {
      if (record.expiresAt.epochMilliseconds <= now.epochMilliseconds) tickets.delete(ticket);
    }
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, { expiresAt });
    return { ticket, expiresAt: DateTime.toUtc(expiresAt) } satisfies WslWebSocketTicket;
  }).pipe(Effect.withSpan("WslBearerAuth.issueWebSocketTicket"));

  const consumeWebSocketTicket = Effect.fn("WslBearerAuth.consumeWebSocketTicket")(function* (
    ticket: string | null,
  ) {
    if (config.transport === "loopback") return;
    requireConfiguredWslToken();
    if (ticket === null || ticket.length === 0) {
      return yield* failInvalid("missing_websocket_ticket");
    }
    const record = tickets.get(ticket);
    tickets.delete(ticket);
    const now = yield* DateTime.now;
    if (record === undefined || record.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      return yield* failInvalid("invalid_websocket_ticket");
    }
  });

  const authorizeWebSocketUpgrade = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    const ticket = Option.isSome(requestUrl)
      ? requestUrl.value.searchParams.get(WSL_WEBSOCKET_TICKET_QUERY_PARAM)
      : null;
    yield* consumeWebSocketTicket(ticket);
  }).pipe(Effect.withSpan("WslBearerAuth.authorizeWebSocketUpgrade"));

  return WslBearerAuth.of({
    authorizeBearerHeader,
    authorizeHttpRequest,
    issueWebSocketTicket,
    consumeWebSocketTicket,
    authorizeWebSocketUpgrade,
  });
});

export const layer = Layer.effect(WslBearerAuth, make);

export const wslWebSocketTicketRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.transport === "loopback") return Layer.empty;
    return HttpRouter.add(
      "POST",
      WSL_WEBSOCKET_TICKET_PATH,
      Effect.gen(function* () {
        const auth = yield* WslBearerAuth;
        yield* auth.authorizeHttpRequest;
        const issued = yield* auth.issueWebSocketTicket;
        return yield* HttpServerResponse.schemaJson(WslWebSocketTicketResult)(issued, {
          headers: { "cache-control": "no-store" },
        });
      }).pipe(
        Effect.catchTag("EnvironmentWslBearerInvalidError", HttpServerRespondable.toResponse),
      ),
    );
  }),
);
