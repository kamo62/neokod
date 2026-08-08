import { WslWebSocketTicketResult } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest } from "../rpc/http.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Exchange a bearer credential for a short-lived WebSocket ticket against the
 * server's ticket endpoint. Used by both the WSL bearer transport and the
 * authenticated loopback transport (plan WS-A2): the server mounts the ticket
 * route whenever a credential is configured, regardless of transport.
 */
export const issueWebSocketTicket = Effect.fn("clientRuntime.transport.issueWebSocketTicket")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly ticketPath: string;
    readonly bearerToken: string;
    readonly timeoutMs?: number;
  }) {
    const requestUrl = environmentEndpointUrl(input.httpBaseUrl, input.ticketPath);
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(requestUrl).pipe(
      HttpClientRequest.bearerToken(input.bearerToken),
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      httpClient
        .execute(request)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(WslWebSocketTicketResult)),
        ),
    );
  },
);

export const issueWslWebSocketTicket = Effect.fn("clientRuntime.transport.issueWslWebSocketTicket")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly wslBearerToken: string;
    readonly timeoutMs?: number;
  }) {
    return yield* issueWebSocketTicket({
      httpBaseUrl: input.httpBaseUrl,
      ticketPath: "/api/wsl-auth/websocket-ticket",
      bearerToken: input.wslBearerToken,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  },
);

const resolveAuthenticatedWebSocketUrl = Effect.fn(
  "clientRuntime.transport.resolveAuthenticatedWebSocketUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly ticketPath: string;
  readonly bearerToken: string;
}) {
  const issued = yield* issueWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    ticketPath: input.ticketPath,
    bearerToken: input.bearerToken,
  });
  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  url.searchParams.set("wsTicket", issued.ticket);
  return url.toString();
});

export const resolveWslWebSocketUrl = Effect.fn("clientRuntime.transport.resolveWslWebSocketUrl")(
  function* (input: {
    readonly wsBaseUrl: string;
    readonly httpBaseUrl: string;
    readonly wslBearerToken: string;
  }) {
    return yield* resolveAuthenticatedWebSocketUrl({
      wsBaseUrl: input.wsBaseUrl,
      httpBaseUrl: input.httpBaseUrl,
      ticketPath: "/api/wsl-auth/websocket-ticket",
      bearerToken: input.wslBearerToken,
    });
  },
);

export const resolveLoopbackWebSocketUrl = Effect.fn(
  "clientRuntime.transport.resolveLoopbackWebSocketUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly loopbackAuthToken: string;
}) {
  return yield* resolveAuthenticatedWebSocketUrl({
    wsBaseUrl: input.wsBaseUrl,
    httpBaseUrl: input.httpBaseUrl,
    ticketPath: "/api/wsl-auth/websocket-ticket",
    bearerToken: input.loopbackAuthToken,
  });
});
