import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import * as ConnectionResolver from "./resolver.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { PrimaryConnectionTarget, WslConnectionTarget } from "./model.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const makeResolver = ConnectionResolver.make.pipe(
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die(new Error("Unexpected HTTP request."))),
  ),
);

describe("ConnectionResolver", () => {
  it.effect("prepares the loopback primary without authorization", () =>
    Effect.gen(function* () {
      const resolver = yield* makeResolver;
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });
      const entry: ConnectionCatalogEntry = { target, wslBearerToken: Option.none() };

      expect(yield* resolver.prepare(entry)).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl: "ws://127.0.0.1:3777/ws",
        wslBearerAuthorization: null,
        target,
      });
    }),
  );

  it.effect("fails closed when a WSL bootstrap has no in-memory bearer", () =>
    Effect.gen(function* () {
      const resolver = yield* makeResolver;
      const target = new WslConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WSL",
        connectionId: "wsl:ubuntu",
        httpBaseUrl: "http://172.27.0.2:3778",
        wsBaseUrl: "ws://172.27.0.2:3778",
      });
      const entry: ConnectionCatalogEntry = { target, wslBearerToken: Option.none() };
      const error = yield* resolver.prepare(entry).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication" });
    }),
  );
});
