import { remoteHttpClientLayer } from "@neokod/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readPrimaryEnvironmentTarget } from "./target";

export function makePrimaryEnvironmentHttpLayer() {
  return Layer.unwrap(
    Effect.sync(() => {
      const baseLayer = remoteHttpClientLayer(globalThis.fetch);
      const resolved = readPrimaryEnvironmentTarget();
      const bearerToken =
        resolved.transport._tag === "Loopback"
          ? resolved.transport.loopbackAuthToken
          : resolved.transport.token;
      if (bearerToken === undefined) return baseLayer;
      return Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, (client) =>
          client.pipe(
            HttpClient.mapRequest((request) => HttpClientRequest.bearerToken(request, bearerToken)),
          ),
        ),
      ).pipe(Layer.provide(baseLayer));
    }),
  );
}

export const primaryEnvironmentHttpLayer = makePrimaryEnvironmentHttpLayer();
