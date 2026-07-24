/**
 * PostHog evidence sink: a public, org-agnostic destination for the
 * managed-client evidence pipeline. POSTs `{api_key, batch}` to
 * `{posthogHost}/batch/` (the same shape `AnalyticsService` already uses for
 * this fork's own product telemetry, kept intentionally separate — the
 * anonymous id below is a dedicated per-install identifier for this pipeline,
 * not shared with `telemetry/Identify.ts`).
 *
 * Every evidence event becomes one PostHog event named after its
 * `event_type`, with its structured payload flattened one level deep into
 * `properties`. `repo.remote` and `file_change.paths` are never included
 * (hashes stay) — this backend is public, so nothing repo-identifying or
 * path-shaped leaves the machine. When identity is attached, `distinct_id`
 * is the best available machine identifier and a one-time `$set` event
 * records the rest as person properties; when identity is not attached, no
 * machine-derived value appears anywhere in the payload — `distinct_id`
 * falls back to a random per-install id persisted next to the rest of this
 * server's state (or the literal string "anonymous" if that read/write ever
 * fails).
 *
 * @module PostHogSink
 */
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import type { ManagedClientEvidenceEvent, ManagedClientIdentity } from "./ManagedClientEvidence.ts";
import { classifyEvidenceResponse, type EvidenceSink } from "./EvidenceSink.ts";

export interface PostHogSinkSettings {
  readonly posthogHost: string;
  readonly posthogApiKey: string;
}

export interface PostHogEventPayload {
  readonly event: string;
  readonly distinct_id: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

function flattenShallow(
  prefix: string,
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!value) return {};
  const flattened: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) continue;
    flattened[`${prefix}_${key}`] = fieldValue;
  }
  return flattened;
}

/**
 * Pure event mapper, unit-tested directly for the wire-shape fixture: no
 * `repo.remote`, no `file_change.paths` — every other event field flattens
 * one level into `properties`.
 */
export function evidenceEventToPostHogEvent(
  event: ManagedClientEvidenceEvent,
  distinctId: string,
): PostHogEventPayload {
  const properties: Record<string, unknown> = {
    schema_version: event.schema_version,
    client: event.client,
    client_session_id: event.client_session_id,
    event_id: event.event_id,
    ...(event.repo?.branch ? { repo_branch: event.repo.branch } : {}),
    ...(event.repo?.commit ? { repo_commit: event.repo.commit } : {}),
  };

  switch (event.event_type) {
    case "prompt":
    case "assistant_message":
      properties.content_sha256 = event.content_sha256;
      break;
    case "tool_execution":
      Object.assign(properties, flattenShallow("tool", event.tool));
      break;
    case "permission_decision":
      Object.assign(properties, flattenShallow("permission_decision", event.permission_decision));
      break;
    case "file_change":
      if (event.file_change.diff_sha256) {
        properties.file_change_diff_sha256 = event.file_change.diff_sha256;
      }
      break;
    case "token_usage":
      Object.assign(properties, flattenShallow("token_usage", event.token_usage));
      break;
    case "session_start":
    case "session_end":
      break;
  }

  return {
    event: event.event_type,
    distinct_id: distinctId,
    properties,
    timestamp: event.timestamp,
  };
}

/**
 * One-time (per process, per sink instance) person-properties event. Only
 * ever built when identity is attached, so this is the one place a machine
 * identifier is allowed to appear in the PostHog payload.
 */
export function buildPostHogIdentifyEvent(
  identity: ManagedClientIdentity,
  distinctId: string,
  timestamp: string,
): PostHogEventPayload {
  return {
    event: "$set",
    distinct_id: distinctId,
    properties: {
      $set: {
        ...(identity.github_login ? { github_login: identity.github_login } : {}),
        ...(identity.os_username ? { os_username: identity.os_username } : {}),
        hostname: identity.hostname,
        ...(identity.os_platform ? { os_platform: identity.os_platform } : {}),
      },
    },
    timestamp,
  };
}

export function buildPostHogBatchBody(input: {
  readonly apiKey: string;
  readonly events: ReadonlyArray<PostHogEventPayload>;
}): { readonly api_key: string; readonly batch: ReadonlyArray<PostHogEventPayload> } {
  return { api_key: input.apiKey, batch: input.events };
}

export function resolvePostHogBatchUrl(posthogHost: string): string {
  return `${posthogHost.replace(/\/+$/, "")}/batch/`;
}

/** Clearly-marked one-shot event for the "Test connection" button. */
export function buildPostHogTestConnectionEvent(
  distinctId: string,
  timestamp: string,
): PostHogEventPayload {
  return {
    event: "neokod_test_connection",
    distinct_id: distinctId,
    properties: {},
    timestamp,
  };
}

const POSTHOG_ANONYMOUS_ID_FILE_NAME = "posthog-anon-id";
const POSTHOG_ANONYMOUS_ID_FALLBACK = "anonymous";

/**
 * Read-or-create the per-install anonymous id this sink falls back to when
 * `includeMachineIdentity` is off. Lives next to the rest of this server's
 * state (`ServerConfig.stateDir`) rather than adding a new config field —
 * deliberately a separate file from `telemetry/Identify.ts`'s anonymous id,
 * since that one backs this fork's own product telemetry and mixing the two
 * would let an operator correlate governance evidence with product
 * telemetry. Any read/write failure falls back to the literal "anonymous"
 * rather than blocking evidence delivery. Exported so the test-connection
 * probe (`ManagedClientEvidenceTestConnection.ts`) can show the exact same
 * distinct_id the live pipeline would use.
 */
export const readOrCreatePostHogAnonymousId: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Crypto.Crypto
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const anonIdPath = path.join(serverConfig.stateDir, POSTHOG_ANONYMOUS_ID_FILE_NAME);

  const existing = yield* fs.readFileString(anonIdPath).pipe(Effect.option);
  const trimmedExisting = existing.pipe(
    Option.map((value) => value.trim()),
    Option.filter((value) => value.length > 0),
  );
  if (Option.isSome(trimmedExisting)) {
    return trimmedExisting.value;
  }

  const crypto = yield* Crypto.Crypto;
  const generated = yield* crypto.randomUUIDv4;
  yield* fs.writeFileString(anonIdPath, generated).pipe(Effect.ignore);
  return generated;
}).pipe(Effect.orElseSucceed(() => POSTHOG_ANONYMOUS_ID_FALLBACK));

/**
 * Effect-returning constructor (rather than a plain function like
 * `makeAiOrchSink`/`makeOtlpSink`) so the anonymous id is resolved exactly
 * once, at sink construction (i.e. once per settings change, not once per
 * `send`), and `send` itself only needs `HttpClient.HttpClient` — matching
 * `EvidenceSink`.
 */
export const makePostHogSink = (
  settings: PostHogSinkSettings,
): Effect.Effect<
  EvidenceSink,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const endpoint = resolvePostHogBatchUrl(settings.posthogHost);
    const anonymousId = yield* readOrCreatePostHogAnonymousId;
    let identifiedOnce = false;

    const resolveDistinctId = (identity: ManagedClientIdentity | undefined): string =>
      identity ? identity.github_login || identity.os_username || identity.hostname : anonymousId;

    const send = (
      events: ReadonlyArray<ManagedClientEvidenceEvent>,
      identity: ManagedClientIdentity | undefined,
    ) =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const distinctId = resolveDistinctId(identity);
        const shouldIdentify = identity !== undefined && !identifiedOnce;
        const timestamp = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

        const mappedEvents = events.map((event) => evidenceEventToPostHogEvent(event, distinctId));
        const batchEvents = shouldIdentify
          ? [buildPostHogIdentifyEvent(identity, distinctId, timestamp), ...mappedEvents]
          : mappedEvents;

        const body = buildPostHogBatchBody({ apiKey: settings.posthogApiKey, events: batchEvents });

        yield* classifyEvidenceResponse({
          sink: "posthog",
          response: HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.setHeader("content-type", "application/json"),
            HttpClientRequest.bodyJson(body),
            Effect.flatMap(httpClient.execute),
          ),
        });

        if (shouldIdentify) {
          identifiedOnce = true;
        }
      });

    return { name: "posthog", send };
  });
