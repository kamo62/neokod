import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { ManagedClientEvidenceEvent, ManagedClientIdentity } from "./ManagedClientEvidence.ts";
import {
  buildOtlpLogsBody,
  buildOtlpResourceAttributes,
  evidenceEventToOtlpLogRecord,
  isoTimestampToUnixNano,
  makeOtlpSink,
  parseOtlpHeaders,
  resolveOtlpLogsUrl,
} from "./OtlpSink.ts";

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

describe("isoTimestampToUnixNano", () => {
  it("converts an ISO timestamp to a nanosecond STRING (proto3 int64 JSON mapping)", () => {
    const nano = isoTimestampToUnixNano("2026-07-02T10:00:00.000Z", 0);
    NodeAssert.equal(typeof nano, "string");
    NodeAssert.equal(
      nano,
      (BigInt(Date.parse("2026-07-02T10:00:00.000Z")) * 1_000_000n).toString(),
    );
  });

  it("falls back to the supplied now when the timestamp fails to parse", () => {
    NodeAssert.equal(isoTimestampToUnixNano("not-a-date", 5_000), (5_000n * 1_000_000n).toString());
  });
});

describe("evidenceEventToOtlpLogRecord", () => {
  it("uses AnyValue shapes for every attribute value and INFO severity", () => {
    const record = evidenceEventToOtlpLogRecord(tokenUsageEvent, 0);
    NodeAssert.equal(record.severityNumber, 9);
    NodeAssert.equal(record.severityText, "INFO");
    NodeAssert.equal(typeof record.timeUnixNano, "string");

    for (const attr of record.attributes) {
      const keys = Object.keys(attr.value);
      NodeAssert.equal(keys.length, 1);
      NodeAssert.ok(["stringValue", "intValue", "boolValue"].includes(keys[0]!));
    }

    const inputTokens = record.attributes.find((attr) => attr.key === "token_usage.input_tokens");
    NodeAssert.deepEqual(inputTokens?.value, { intValue: "120" });
  });

  it("never includes repo.remote (strips PII, keeps branch/commit)", () => {
    const record = evidenceEventToOtlpLogRecord(promptEvent, 0);
    const keys = record.attributes.map((attr) => attr.key);
    NodeAssert.equal(keys.includes("repo.remote"), false);
    NodeAssert.equal(containsSubstring(record, "github.com/example/repo"), false);
    NodeAssert.ok(keys.includes("repo.branch"));
    NodeAssert.ok(keys.includes("repo.commit"));
  });

  it("never includes file_change.paths (strips PII, keeps the diff hash)", () => {
    const record = evidenceEventToOtlpLogRecord(fileChangeEvent, 0);
    const keys = record.attributes.map((attr) => attr.key);
    NodeAssert.equal(keys.includes("file_change.paths"), false);
    NodeAssert.equal(
      containsSubstring(record, "secret-project"),
      false,
      "expected no file path anywhere in the log record",
    );
    NodeAssert.ok(keys.includes("file_change.diff_sha256"));
  });
});

describe("buildOtlpResourceAttributes", () => {
  it("always includes service.name/service.version", () => {
    const attrs = buildOtlpResourceAttributes({ serviceVersion: "3.0.3", identity: undefined });
    NodeAssert.deepEqual(attrs.find((attr) => attr.key === "service.name")?.value, {
      stringValue: "neokod",
    });
    NodeAssert.deepEqual(attrs.find((attr) => attr.key === "service.version")?.value, {
      stringValue: "3.0.3",
    });
  });

  it("includes host.name/os.user only when identity is attached", () => {
    const withIdentity = buildOtlpResourceAttributes({ serviceVersion: "3.0.3", identity });
    NodeAssert.deepEqual(withIdentity.find((attr) => attr.key === "host.name")?.value, {
      stringValue: "jdoes-mbp",
    });
    NodeAssert.deepEqual(withIdentity.find((attr) => attr.key === "os.user")?.value, {
      stringValue: "jdoe",
    });

    const withoutIdentity = buildOtlpResourceAttributes({
      serviceVersion: "3.0.3",
      identity: undefined,
    });
    NodeAssert.equal(
      withoutIdentity.some((attr) => attr.key === "host.name"),
      false,
    );
    NodeAssert.equal(
      withoutIdentity.some((attr) => attr.key === "os.user"),
      false,
    );
  });
});

describe("buildOtlpLogsBody wire shape", () => {
  it("matches the exact resourceLogs/scopeLogs/logRecords fixture shape", () => {
    const body = buildOtlpLogsBody({
      events: [promptEvent],
      identity: undefined,
      serviceVersion: "3.0.3",
      nowMs: 0,
    });
    NodeAssert.equal(body.resourceLogs.length, 1);
    NodeAssert.equal(body.resourceLogs[0]?.scopeLogs.length, 1);
    NodeAssert.equal(
      body.resourceLogs[0]?.scopeLogs[0]?.scope.name,
      "neokod.managed-client-evidence",
    );
    NodeAssert.equal(body.resourceLogs[0]?.scopeLogs[0]?.logRecords.length, 1);
  });
});

describe("parseOtlpHeaders", () => {
  it("parses a comma-separated k=v list", () => {
    NodeAssert.deepEqual(parseOtlpHeaders("Authorization=Bearer test,X-Custom=1"), {
      Authorization: "Bearer test",
      "X-Custom": "1",
    });
  });

  it("skips malformed pairs and tolerates surrounding whitespace", () => {
    NodeAssert.deepEqual(parseOtlpHeaders("  k1 = v1 , malformed , k2=v2  "), {
      k1: "v1",
      k2: "v2",
    });
  });

  it("returns an empty record for an empty string", () => {
    NodeAssert.deepEqual(parseOtlpHeaders(""), {});
  });
});

describe("resolveOtlpLogsUrl", () => {
  it("appends /v1/logs when the endpoint lacks it", () => {
    NodeAssert.equal(
      resolveOtlpLogsUrl("https://otel.example.com"),
      "https://otel.example.com/v1/logs",
    );
    NodeAssert.equal(
      resolveOtlpLogsUrl("https://otel.example.com/"),
      "https://otel.example.com/v1/logs",
    );
  });

  it("leaves an endpoint that already ends with /v1/logs unchanged", () => {
    NodeAssert.equal(
      resolveOtlpLogsUrl("https://otel.example.com/v1/logs"),
      "https://otel.example.com/v1/logs",
    );
  });
});

interface CapturedPost {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

const makePostCaptureHttpLayer = (posts: Queue.Queue<CapturedPost>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const rawBody = (request.body as { readonly body?: Uint8Array }).body;
      const body = JSON.parse(decoder.decode(rawBody)) as unknown;
      return Queue.offer(posts, { url: request.url, headers: request.headers, body }).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, Response.json({ status: "Ok" }))),
      );
    }),
  );

describe("OtlpSink", () => {
  it("posts to {endpoint}/v1/logs with parsed otlpHeaders and omits host.name/os.user without identity", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<CapturedPost>();
      const sink = makeOtlpSink({
        otlpEndpoint: "https://otel.example.com",
        otlpHeaders: "Authorization=Bearer test",
      });

      yield* sink
        .send([promptEvent], undefined)
        .pipe(Effect.provide(makePostCaptureHttpLayer(posts)));
      const post = yield* Queue.take(posts);

      NodeAssert.equal(post.url, "https://otel.example.com/v1/logs");
      NodeAssert.equal(post.headers.authorization, "Bearer test");
      NodeAssert.equal(containsSubstring(post.body, "host.name"), false);
      NodeAssert.equal(containsSubstring(post.body, "os.user"), false);
    }).pipe(Effect.runPromise));

  it("includes host.name/os.user when identity is attached", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<CapturedPost>();
      const sink = makeOtlpSink({ otlpEndpoint: "https://otel.example.com", otlpHeaders: "" });

      yield* sink
        .send([promptEvent], identity)
        .pipe(Effect.provide(makePostCaptureHttpLayer(posts)));
      const post = yield* Queue.take(posts);

      NodeAssert.ok(containsSubstring(post.body, "host.name"));
      NodeAssert.ok(containsSubstring(post.body, "jdoes-mbp"));
    }).pipe(Effect.runPromise));
});
