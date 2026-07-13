import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import type { CopilotManagedClientEvidenceSettings } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { testManagedClientEvidenceConnection } from "./ManagedClientEvidenceTestConnection.ts";

const decoder = new TextDecoder();

interface CapturedPost {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly events: ReadonlyArray<{
    readonly event_id: string;
    readonly schema_version: string;
    readonly client: string;
    readonly event_type: string;
    readonly client_session_id: string;
  }>;
}

const makeSettings = (
  overrides: Partial<CopilotManagedClientEvidenceSettings> = {},
): CopilotManagedClientEvidenceSettings => ({
  enabled: true,
  gatewayEnabled: false,
  governanceUrl: "https://orch.example",
  credential: "air_test",
  ...overrides,
});

const makeHttpLayer = (response: Response | ((post: CapturedPost) => Response)) => {
  const posts: Array<CapturedPost> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const rawBody = (request.body as { readonly body?: Uint8Array }).body;
      const body = JSON.parse(decoder.decode(rawBody)) as Pick<CapturedPost, "events">;
      const post: CapturedPost = {
        url: request.url,
        authorization: request.headers.Authorization,
        events: body.events,
      };
      posts.push(post);
      const webResponse = typeof response === "function" ? response(post) : response;
      return Effect.succeed(HttpClientResponse.fromWeb(request, webResponse));
    }),
  );
  return { layer, posts };
};

describe("testManagedClientEvidenceConnection", () => {
  it("reports a typed failure without making a request when settings are incomplete", () =>
    Effect.gen(function* () {
      const { layer, posts } = makeHttpLayer(Response.json({ ok: true }));
      const result = yield* testManagedClientEvidenceConnection(
        makeSettings({ governanceUrl: "", credential: "" }),
      ).pipe(Effect.provide(layer));

      NodeAssert.deepEqual(result, {
        ok: false,
        status: null,
        message: "Set a governance URL and credential before testing.",
      });
      NodeAssert.equal(posts.length, 0);
    }));

  it("posts a synthetic session_start/session_end pair and reports success", () =>
    Effect.gen(function* () {
      const { layer, posts } = makeHttpLayer(Response.json({ ok: true }));
      const result = yield* testManagedClientEvidenceConnection(makeSettings()).pipe(
        Effect.provide(layer),
      );

      NodeAssert.equal(result.ok, true);
      NodeAssert.equal(result.status, 200);
      NodeAssert.equal(result.message, "Connection verified.");
      NodeAssert.equal(posts.length, 1);

      const post = posts[0]!;
      NodeAssert.equal(post.url, "https://orch.example/v1/managed-client/evidence");
      NodeAssert.equal(post.authorization, "Bearer air_test");
      NodeAssert.equal(post.events.length, 2);
      NodeAssert.deepEqual(
        post.events.map((event) => event.event_type),
        ["session_start", "session_end"],
      );
      for (const event of post.events) {
        NodeAssert.equal(event.schema_version, "v0");
        NodeAssert.equal(event.client, "t3code");
        NodeAssert.ok(event.client_session_id.startsWith("test-connection-"));
      }
      NodeAssert.equal(post.events[0]!.client_session_id, post.events[1]!.client_session_id);
      NodeAssert.notEqual(post.events[0]!.event_id, post.events[1]!.event_id);
    }));

  it("generates a fresh session id and event ids on every call", () =>
    Effect.gen(function* () {
      const { layer, posts } = makeHttpLayer(Response.json({ ok: true }));
      const effect = testManagedClientEvidenceConnection(makeSettings()).pipe(
        Effect.provide(layer),
      );
      yield* effect;
      yield* effect;

      NodeAssert.equal(posts.length, 2);
      const firstIds = posts[0]!.events.map((event) => event.event_id);
      const secondIds = posts[1]!.events.map((event) => event.event_id);
      NodeAssert.notDeepEqual(firstIds, secondIds);
      NodeAssert.notEqual(
        posts[0]!.events[0]!.client_session_id,
        posts[1]!.events[0]!.client_session_id,
      );
    }));

  it("reports a typed failure with the HTTP status on a non-2xx response", () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(new Response(null, { status: 401 }));
      const result = yield* testManagedClientEvidenceConnection(makeSettings()).pipe(
        Effect.provide(layer),
      );

      NodeAssert.deepEqual(result, {
        ok: false,
        status: 401,
        message: "Governance endpoint returned HTTP 401.",
      });
    }));

  it("never includes the credential in the result", () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(Response.json({ ok: true }));
      const result = yield* testManagedClientEvidenceConnection(makeSettings()).pipe(
        Effect.provide(layer),
      );

      NodeAssert.equal(result.message.includes("air_test"), false);
    }));
});
