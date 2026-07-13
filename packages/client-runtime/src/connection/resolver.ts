import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { resolveWslWebSocketUrl } from "../transport/wslBearer.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { credentialMissingError, mapRemoteEnvironmentError } from "./errors.ts";
import type { ConnectionAttemptError, PreparedConnection } from "./model.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

function directSocketUrl(wsBaseUrl: string): string {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  return url.toString();
}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const prepare = Effect.fn("clientRuntime.connection.resolver.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    if (target._tag === "PrimaryConnectionTarget") {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: directSocketUrl(target.wsBaseUrl),
        wslBearerAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const wslBearerToken = yield* Option.match(entry.wslBearerToken, {
      onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    const socketUrl = yield* resolveWslWebSocketUrl({
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      wslBearerToken,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(mapRemoteEnvironmentError),
    );
    return {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl,
      wslBearerAuthorization: { _tag: "WslBearer", token: wslBearerToken },
      target,
    } satisfies PreparedConnection;
  });

  return ConnectionResolver.of({ prepare });
});

export const layer = Layer.effect(ConnectionResolver, make);
