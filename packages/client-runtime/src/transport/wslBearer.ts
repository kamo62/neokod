import { WslWebSocketTicketResult } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest } from "../rpc/http.ts";

const DEFAULT_WSL_REQUEST_TIMEOUT_MS = 10_000;

export const issueWslWebSocketTicket = Effect.fn("clientRuntime.transport.issueWslWebSocketTicket")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly wslBearerToken: string;
    readonly timeoutMs?: number;
  }) {
    const requestUrl = environmentEndpointUrl(input.httpBaseUrl, "/api/wsl-auth/websocket-ticket");
    const httpClient = yield* HttpClient.HttpClient;
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs ?? DEFAULT_WSL_REQUEST_TIMEOUT_MS,
      HttpClientRequest.post(requestUrl).pipe(
        HttpClientRequest.bearerToken(input.wslBearerToken),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(WslWebSocketTicketResult)),
      ),
    );
  },
);

export const resolveWslWebSocketUrl = Effect.fn("clientRuntime.transport.resolveWslWebSocketUrl")(
  function* (input: {
    readonly wsBaseUrl: string;
    readonly httpBaseUrl: string;
    readonly wslBearerToken: string;
  }) {
    const issued = yield* issueWslWebSocketTicket(input);
    const url = new URL(input.wsBaseUrl);
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
    url.searchParams.set("wsTicket", issued.ticket);
    return url.toString();
  },
);
