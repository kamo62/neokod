import { remoteHttpClientLayer } from "@neokod/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readPrimaryEnvironmentTarget } from "./target";

const currentBearer = (): string | undefined => {
  const resolved = readPrimaryEnvironmentTarget();
  return resolved.transport._tag === "Loopback"
    ? resolved.transport.loopbackAuthToken
    : resolved.transport.token;
};

export function makePrimaryEnvironmentHttpLayer() {
  return Layer.unwrap(
    Effect.sync(() => {
      const baseLayer = remoteHttpClientLayer(globalThis.fetch);
      return Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, (client) =>
          client.pipe(
            HttpClient.mapRequest((request) => {
              const bearer = currentBearer();
              return bearer === undefined
                ? request
                : HttpClientRequest.bearerToken(request, bearer);
            }),
          ),
        ),
      ).pipe(Layer.provide(baseLayer));
    }),
  );
}

export const primaryEnvironmentHttpLayer = makePrimaryEnvironmentHttpLayer();
