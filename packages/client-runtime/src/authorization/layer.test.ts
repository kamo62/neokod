import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("authorizes a bearer connection and mints its websocket ticket", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const responses = [
        Response.json({
          environmentId: ENVIRONMENT_ID,
          label: "Remote environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
        Response.json({ ticket: "ws-ticket", expiresAt: "2026-06-06T01:00:00.000Z" }),
      ];
      const fetchFn = ((input) => {
        calls.push(String(input));
        const response = responses.shift();
        return response === undefined
          ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
          : Promise.resolve(response);
      }) satisfies typeof fetch;

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeBearer({
          expectedEnvironmentId: ENVIRONMENT_ID,
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
          bearerToken: "bearer-token",
        });
      }).pipe(
        Effect.provide(RemoteEnvironmentAuthorization.layer),
        Effect.provide(remoteHttpClientLayer(fetchFn)),
      );

      expect(authorized).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        socketUrl: "wss://environment.example.test/ws?wsTicket=ws-ticket",
        httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
      });
      expect(calls).toEqual([
        "https://environment.example.test/.well-known/t3/environment",
        "https://environment.example.test/api/auth/websocket-ticket",
      ]);
    }),
  );
});
