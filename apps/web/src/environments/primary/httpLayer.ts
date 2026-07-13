import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readPrimaryEnvironmentTarget } from "./target";

export function makePrimaryEnvironmentHttpLayer() {
  return Layer.unwrap(
    Effect.sync(() => {
      const baseLayer = remoteHttpClientLayer(globalThis.fetch);
      const resolved = readPrimaryEnvironmentTarget();
      if (resolved.transport._tag === "Loopback") return baseLayer;
      return Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, (client) =>
          client.pipe(
            HttpClient.mapRequest((request) =>
              HttpClientRequest.bearerToken(request, resolved.transport.token),
            ),
          ),
        ),
      ).pipe(Layer.provide(baseLayer));
    }),
  );
}

export const primaryEnvironmentHttpLayer = makePrimaryEnvironmentHttpLayer();
