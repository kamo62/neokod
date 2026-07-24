import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeAiOrchSink } from "./AiOrchSink.ts";
import type { ManagedClientEvidenceEvent, ManagedClientIdentity } from "./ManagedClientEvidence.ts";
import { EvidenceSinkPermanentError, EvidenceSinkRetryableError } from "./EvidenceSink.ts";

const decoder = new TextDecoder();

const identity: ManagedClientIdentity = {
  v: 1,
  os_username: "jdoe",
  hostname: "jdoes-mbp",
  os_platform: "darwin",
  github_login: "jdoe-gh",
};

const sessionStartEvent: ManagedClientEvidenceEvent = {
  event_id: "evt-1",
  schema_version: "v0",
  client: "neokod",
  client_session_id: "thread-1",
  event_type: "session_start",
  timestamp: "2026-07-02T10:00:00.000Z",
};

interface CapturedPost {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly bodyKeys: ReadonlyArray<string>;
  readonly clientIdentity: unknown;
}

const makePostCaptureHttpLayer = (
  posts: Queue.Queue<CapturedPost>,
  response: Response = Response.json({ ok: true }),
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const rawBody = (request.body as { readonly body?: Uint8Array }).body;
      const body = JSON.parse(decoder.decode(rawBody)) as { readonly client_identity?: unknown };
      const post: CapturedPost = {
        url: request.url,
        authorization: request.headers.authorization,
        bodyKeys: Object.keys(body),
        clientIdentity: body.client_identity,
      };
      return Queue.offer(posts, post).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, response)),
      );
    }),
  );

describe("AiOrchSink (zero contract change)", () => {
  it("posts {events, client_identity} with a bearer credential when identity is attached", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<CapturedPost>();
      const sink = makeAiOrchSink({
        governanceUrl: "https://orch.example/",
        credential: "air_test",
      });

      yield* sink
        .send([sessionStartEvent], identity)
        .pipe(Effect.provide(makePostCaptureHttpLayer(posts)));
      const post = yield* Queue.take(posts);

      NodeAssert.equal(post.url, "https://orch.example/v1/managed-client/evidence");
      NodeAssert.equal(post.authorization, "Bearer air_test");
      NodeAssert.deepEqual([...post.bodyKeys].sort(), ["client_identity", "events"]);
      NodeAssert.deepEqual(post.clientIdentity, identity);
    }).pipe(Effect.runPromise));

  it("omits client_identity entirely when identity is not attached (includeMachineIdentity off)", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<CapturedPost>();
      const sink = makeAiOrchSink({
        governanceUrl: "https://orch.example",
        credential: "air_test",
      });

      yield* sink
        .send([sessionStartEvent], undefined)
        .pipe(Effect.provide(makePostCaptureHttpLayer(posts)));
      const post = yield* Queue.take(posts);

      NodeAssert.deepEqual([...post.bodyKeys], ["events"]);
    }).pipe(Effect.runPromise));

  it("surfaces a 400 as EvidenceSinkPermanentError", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<CapturedPost>();
      const sink = makeAiOrchSink({
        governanceUrl: "https://orch.example",
        credential: "air_test",
      });

      const exit = yield* Effect.exit(
        sink
          .send([sessionStartEvent], identity)
          .pipe(
            Effect.provide(makePostCaptureHttpLayer(posts, new Response(null, { status: 400 }))),
          ),
      );
      NodeAssert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        NodeAssert.ok(error instanceof EvidenceSinkPermanentError);
      }
    }).pipe(Effect.runPromise));

  it("surfaces a 500 as EvidenceSinkRetryableError", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<CapturedPost>();
      const sink = makeAiOrchSink({
        governanceUrl: "https://orch.example",
        credential: "air_test",
      });

      const exit = yield* Effect.exit(
        sink
          .send([sessionStartEvent], identity)
          .pipe(
            Effect.provide(makePostCaptureHttpLayer(posts, new Response(null, { status: 500 }))),
          ),
      );
      NodeAssert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        NodeAssert.ok(error instanceof EvidenceSinkRetryableError);
      }
    }).pipe(Effect.runPromise));
});
