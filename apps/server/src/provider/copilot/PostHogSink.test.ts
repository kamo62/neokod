import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import type { ManagedClientEvidenceEvent, ManagedClientIdentity } from "./ManagedClientEvidence.ts";
import {
  buildPostHogBatchBody,
  buildPostHogIdentifyEvent,
  evidenceEventToPostHogEvent,
  makePostHogSink,
} from "./PostHogSink.ts";

const decoder = new TextDecoder();

/**
 * Recursively collects every string that appears anywhere in a value (object
 * keys and string values alike) so PII-stripping assertions can check "does
 * this substring appear anywhere in the payload" without `JSON.stringify`
 * (this repo's `preferSchemaOverJson` lint steers encoding through Schema
 * instead — irrelevant for this plain substring search over test fixtures).
 */
function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, fieldValue] of Object.entries(value)) {
      into.push(key);
      collectStrings(fieldValue, into);
    }
    return into;
  }
  return into;
}

function containsSubstring(value: unknown, needle: string): boolean {
  return collectStrings(value).some((candidate) => candidate.includes(needle));
}

const identity: ManagedClientIdentity = {
  v: 1,
  os_username: "jdoe",
  hostname: "jdoes-mbp",
  os_platform: "darwin",
  github_login: "jdoe-gh",
};

const promptEvent: ManagedClientEvidenceEvent = {
  event_id: "evt-1",
  schema_version: "v0",
  client: "neokod",
  client_session_id: "thread-1",
  event_type: "prompt",
  timestamp: "2026-07-02T10:00:00.000Z",
  content_sha256: "sha256:abc",
  repo: { remote: "https://github.com/example/repo.git", branch: "main", commit: "deadbeef" },
};

const fileChangeEvent: ManagedClientEvidenceEvent = {
  event_id: "evt-2",
  schema_version: "v0",
  client: "neokod",
  client_session_id: "thread-1",
  event_type: "file_change",
  timestamp: "2026-07-02T10:00:01.000Z",
  file_change: { paths: ["src/secret-project/App.tsx"], diff_sha256: "sha256:def" },
};

const tokenUsageEvent: ManagedClientEvidenceEvent = {
  event_id: "evt-3",
  schema_version: "v0",
  client: "neokod",
  client_session_id: "thread-1",
  event_type: "token_usage",
  timestamp: "2026-07-02T10:00:02.000Z",
  token_usage: { model: "gpt-5", input_tokens: 120, output_tokens: 40, source: "client_reported" },
};

describe("evidenceEventToPostHogEvent", () => {
  it("maps event_type to the PostHog event name and flattens properties one level deep", () => {
    const mapped = evidenceEventToPostHogEvent(tokenUsageEvent, "distinct-1");
    NodeAssert.equal(mapped.event, "token_usage");
    NodeAssert.equal(mapped.distinct_id, "distinct-1");
    NodeAssert.equal(mapped.timestamp, "2026-07-02T10:00:02.000Z");
    NodeAssert.deepEqual(mapped.properties.token_usage_model, "gpt-5");
    NodeAssert.deepEqual(mapped.properties.token_usage_input_tokens, 120);
    NodeAssert.deepEqual(mapped.properties.token_usage_output_tokens, 40);
    NodeAssert.deepEqual(mapped.properties.token_usage_source, "client_reported");
  });

  it("never includes repo.remote (strips PII, keeps branch/commit)", () => {
    const mapped = evidenceEventToPostHogEvent(promptEvent, "distinct-1");
    NodeAssert.equal("repo_remote" in mapped.properties, false);
    NodeAssert.equal(containsSubstring(mapped.properties, "github.com/example/repo"), false);
    NodeAssert.equal(mapped.properties.repo_branch, "main");
    NodeAssert.equal(mapped.properties.repo_commit, "deadbeef");
  });

  it("never includes file_change.paths (strips PII, keeps the diff hash)", () => {
    const mapped = evidenceEventToPostHogEvent(fileChangeEvent, "distinct-1");
    NodeAssert.equal("file_change_paths" in mapped.properties, false);
    NodeAssert.equal(
      containsSubstring(mapped.properties, "secret-project"),
      false,
      "expected no file path anywhere in properties",
    );
    NodeAssert.equal(mapped.properties.file_change_diff_sha256, "sha256:def");
  });
});

describe("buildPostHogIdentifyEvent", () => {
  it("carries the identity fields under $set", () => {
    const identify = buildPostHogIdentifyEvent(identity, "distinct-1", "2026-07-02T10:00:00.000Z");
    NodeAssert.equal(identify.event, "$set");
    NodeAssert.equal(identify.distinct_id, "distinct-1");
    NodeAssert.deepEqual(identify.properties.$set, {
      github_login: "jdoe-gh",
      os_username: "jdoe",
      hostname: "jdoes-mbp",
      os_platform: "darwin",
    });
  });
});

describe("buildPostHogBatchBody", () => {
  it("wraps events under api_key/batch, matching PostHog's /batch/ shape", () => {
    const body = buildPostHogBatchBody({
      apiKey: "phc_test",
      events: [evidenceEventToPostHogEvent(promptEvent, "distinct-1")],
    });
    NodeAssert.deepEqual(Object.keys(body).sort(), ["api_key", "batch"]);
    NodeAssert.equal(body.api_key, "phc_test");
    NodeAssert.equal(body.batch.length, 1);
  });
});

interface CapturedPost {
  readonly url: string;
  readonly body: {
    readonly api_key: string;
    readonly batch: ReadonlyArray<Record<string, unknown>>;
  };
}

it.layer(NodeServices.layer)("PostHogSink", (it) => {
  const makeTestLayer = (prefix: string) => ServerConfig.layerTest(process.cwd(), { prefix });

  it.effect("attaches distinct_id and a one-time $set event when identity is attached", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<CapturedPost>();
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const rawBody = (request.body as { readonly body?: Uint8Array }).body;
          const body = JSON.parse(decoder.decode(rawBody)) as CapturedPost["body"];
          return Queue.offer(posts, { url: request.url, body }).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, Response.json({ status: "Ok" }))),
          );
        }),
      );

      const sink = yield* makePostHogSink({
        posthogHost: "https://us.i.posthog.com",
        posthogApiKey: "phc_test",
      });

      yield* sink.send([promptEvent], identity).pipe(Effect.provide(httpLayer));
      const first = yield* Queue.take(posts);
      NodeAssert.equal(first.url, "https://us.i.posthog.com/batch/");
      NodeAssert.equal(first.body.api_key, "phc_test");
      NodeAssert.equal(first.body.batch.length, 2);
      NodeAssert.equal(first.body.batch[0]?.event, "$set");
      NodeAssert.equal(first.body.batch[0]?.distinct_id, "jdoe-gh");
      NodeAssert.equal(first.body.batch[1]?.event, "prompt");
      NodeAssert.equal(first.body.batch[1]?.distinct_id, "jdoe-gh");

      // Second send in the same process: no repeat $set event.
      yield* sink.send([promptEvent], identity).pipe(Effect.provide(httpLayer));
      const second = yield* Queue.take(posts);
      NodeAssert.equal(second.body.batch.length, 1);
      NodeAssert.equal(second.body.batch[0]?.event, "prompt");
    }).pipe(Effect.provide(makeTestLayer("neokod-posthog-sink-identity-test-"))),
  );

  it.effect(
    "omits every machine-derived identifier when identity is not attached (persisted anonymous distinct_id)",
    () =>
      Effect.gen(function* () {
        const posts = yield* Queue.unbounded<CapturedPost>();
        const httpLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const rawBody = (request.body as { readonly body?: Uint8Array }).body;
            const body = JSON.parse(decoder.decode(rawBody)) as CapturedPost["body"];
            return Queue.offer(posts, { url: request.url, body }).pipe(
              Effect.as(HttpClientResponse.fromWeb(request, Response.json({ status: "Ok" }))),
            );
          }),
        );

        const sink = yield* makePostHogSink({
          posthogHost: "https://us.i.posthog.com",
          posthogApiKey: "phc_test",
        });

        yield* sink.send([promptEvent], undefined).pipe(Effect.provide(httpLayer));
        const post = yield* Queue.take(posts);

        for (const forbidden of [
          "jdoe",
          "jdoes-mbp",
          "jdoe-gh",
          "os_username",
          "hostname",
          "github_login",
        ]) {
          NodeAssert.equal(
            containsSubstring(post.body, forbidden),
            false,
            `expected no "${forbidden}" anywhere in the posthog payload`,
          );
        }
        NodeAssert.equal(post.body.batch.length, 1, "no $set event without identity");
        const distinctId = post.body.batch[0]?.distinct_id;
        NodeAssert.equal(typeof distinctId, "string");
        NodeAssert.ok(distinctId && (distinctId as string).length > 0);
      }).pipe(Effect.provide(makeTestLayer("neokod-posthog-sink-anon-test-"))),
  );

  it.effect("persists the same anonymous distinct_id across sink instances (same state dir)", () =>
    Effect.gen(function* () {
      const capture = (posts: Queue.Queue<CapturedPost>) =>
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const rawBody = (request.body as { readonly body?: Uint8Array }).body;
            const body = JSON.parse(decoder.decode(rawBody)) as CapturedPost["body"];
            return Queue.offer(posts, { url: request.url, body }).pipe(
              Effect.as(HttpClientResponse.fromWeb(request, Response.json({ status: "Ok" }))),
            );
          }),
        );

      const settings = { posthogHost: "https://us.i.posthog.com", posthogApiKey: "phc_test" };

      const posts1 = yield* Queue.unbounded<CapturedPost>();
      const sink1 = yield* makePostHogSink(settings);
      yield* sink1.send([promptEvent], undefined).pipe(Effect.provide(capture(posts1)));
      const firstDistinctId = (yield* Queue.take(posts1)).body.batch[0]?.distinct_id;

      const posts2 = yield* Queue.unbounded<CapturedPost>();
      const sink2 = yield* makePostHogSink(settings);
      yield* sink2.send([promptEvent], undefined).pipe(Effect.provide(capture(posts2)));
      const secondDistinctId = (yield* Queue.take(posts2)).body.batch[0]?.distinct_id;

      NodeAssert.equal(firstDistinctId, secondDistinctId);
    }).pipe(Effect.provide(makeTestLayer("neokod-posthog-sink-persistence-test-"))),
  );
});
