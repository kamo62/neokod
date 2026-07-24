import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import type { CopilotManagedClientEvidenceSettings } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { testManagedClientEvidenceConnection } from "./ManagedClientEvidenceTestConnection.ts";
import { setKnownGithubLogin } from "./ManagedClientIdentityRegistry.ts";

const decoder = new TextDecoder();

interface CapturedPost {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly clientIdentity:
    | {
        readonly v: number;
        readonly os_username?: string;
        readonly hostname: string;
        readonly os_platform?: string;
        readonly github_login?: string;
      }
    | undefined;
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
      const body = JSON.parse(decoder.decode(rawBody)) as Pick<CapturedPost, "events"> & {
        readonly client_identity?: CapturedPost["clientIdentity"];
      };
      const post: CapturedPost = {
        url: request.url,
        authorization: request.headers.Authorization,
        clientIdentity: body.client_identity,
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
        NodeAssert.equal(event.client, "neokod");
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

  it("attaches client_identity to the test-connection batch, present even without a github login", () =>
    Effect.gen(function* () {
      setKnownGithubLogin(undefined);
      const { layer, posts } = makeHttpLayer(Response.json({ ok: true }));
      yield* testManagedClientEvidenceConnection(makeSettings()).pipe(Effect.provide(layer));

      NodeAssert.equal(posts.length, 1);
      const identity = posts[0]!.clientIdentity;
      NodeAssert.ok(identity, "expected client_identity on the test-connection batch");
      NodeAssert.equal(identity?.v, 1);
      NodeAssert.equal(typeof identity?.hostname, "string");
      NodeAssert.ok(identity && identity.hostname.length > 0);
      NodeAssert.equal(identity?.github_login, undefined);
    }));

  it("includes github_login in client_identity once the Copilot auth probe has resolved one", () =>
    Effect.gen(function* () {
      setKnownGithubLogin("octocat");
      const { layer, posts } = makeHttpLayer(Response.json({ ok: true }));
      yield* testManagedClientEvidenceConnection(makeSettings()).pipe(Effect.provide(layer));
      setKnownGithubLogin(undefined);

      NodeAssert.equal(posts[0]!.clientIdentity?.github_login, "octocat");
    }));

  it("plumbs the server's recorded_identity ack through the result", () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(
        Response.json({
          ok: true,
          recorded_identity: { os_username: "jdoe", github_login: "jdoe-gh" },
        }),
      );
      const result = yield* testManagedClientEvidenceConnection(makeSettings()).pipe(
        Effect.provide(layer),
      );

      NodeAssert.deepEqual(result.recordedIdentity, {
        osUsername: "jdoe",
        githubLogin: "jdoe-gh",
      });
    }));

  it("omits recordedIdentity when the response body has no recorded_identity", () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(Response.json({ ok: true }));
      const result = yield* testManagedClientEvidenceConnection(makeSettings()).pipe(
        Effect.provide(layer),
      );

      NodeAssert.equal("recordedIdentity" in result, false);
    }));

  it("still reports success when the response body cannot be parsed as JSON", () =>
    Effect.gen(function* () {
      const layer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("not json", { status: 200 })),
          ),
        ),
      );
      const result = yield* testManagedClientEvidenceConnection(makeSettings()).pipe(
        Effect.provide(layer),
      );

      NodeAssert.equal(result.ok, true);
      NodeAssert.equal(result.recordedIdentity, undefined);
    }));
});
