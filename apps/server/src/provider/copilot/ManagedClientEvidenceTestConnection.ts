// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { CopilotManagedClientEvidenceSettings } from "@neokod/contracts";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import {
  collectClientIdentity,
  MANAGED_CLIENT_EVIDENCE_CLIENT,
  MANAGED_CLIENT_EVIDENCE_SCHEMA_VERSION,
  makeManagedClientEvidenceBatch,
  withClientIdentity,
  type ManagedClientEvidenceEvent,
  type ManagedClientIdentity,
} from "./ManagedClientEvidence.ts";
import { getKnownGithubLogin } from "./ManagedClientIdentityRegistry.ts";
import {
  buildOtlpTestConnectionLogsBody,
  parseOtlpHeaders,
  resolveOtlpLogsUrl,
} from "./OtlpSink.ts";
import {
  buildPostHogBatchBody,
  buildPostHogTestConnectionEvent,
  readOrCreatePostHogAnonymousId,
  resolvePostHogBatchUrl,
} from "./PostHogSink.ts";

export interface ManagedClientEvidenceRecordedIdentity {
  readonly osUsername?: string | undefined;
  readonly githubLogin?: string | undefined;
}

export interface ManagedClientEvidenceTestConnectionResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly message: string;
  /**
   * AI-Orch's echo of what it actually recorded for this credential
   * (`recorded_identity` in the response body), when the server returns
   * one. AI-Orch is the source of truth here and may report a different
   * identity than what was sent. `undefined` for the posthog/otlp backends —
   * neither returns an equivalent ack.
   */
  readonly recordedIdentity?: ManagedClientEvidenceRecordedIdentity | undefined;
}

function maybeTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Defensive, duck-typed read of an untrusted JSON response body — a schema
 * decode failure (or a body that doesn't include `recorded_identity` at
 * all) should never turn a successful connectivity check into a failure.
 */
function extractRecordedIdentity(json: unknown): ManagedClientEvidenceRecordedIdentity | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const recorded = (json as Record<string, unknown>).recorded_identity;
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) return undefined;
  const record = recorded as Record<string, unknown>;
  const osUsername = maybeTrimmedString(record.os_username);
  const githubLogin = maybeTrimmedString(record.github_login);
  if (!osUsername && !githubLogin) return undefined;
  return {
    ...(osUsername ? { osUsername } : {}),
    ...(githubLogin ? { githubLogin } : {}),
  };
}

/**
 * One synthetic `session_start` + `session_end` pair sharing a
 * `test-connection-`-prefixed session id, so they read unambiguously as a
 * connectivity check rather than a real Copilot session on the AI-Orch
 * side. Fresh event ids per call are intentional: the endpoint dedupes per
 * event_id, so re-running the test always produces a new, verifiable
 * delivery instead of silently no-op'ing against a cached one.
 */
function makeTestConnectionEvents(timestamp: string): ReadonlyArray<ManagedClientEvidenceEvent> {
  const sessionId = `test-connection-${NodeCrypto.randomUUID()}`;
  const base = {
    schema_version: MANAGED_CLIENT_EVIDENCE_SCHEMA_VERSION,
    client: MANAGED_CLIENT_EVIDENCE_CLIENT,
    client_session_id: sessionId,
    timestamp,
  } as const;
  return [
    { ...base, event_id: NodeCrypto.randomUUID(), event_type: "session_start" },
    { ...base, event_id: NodeCrypto.randomUUID(), event_type: "session_end" },
  ];
}

const resolveTestConnectionIdentity = (
  settings: CopilotManagedClientEvidenceSettings,
): Effect.Effect<ManagedClientIdentity | undefined> =>
  Effect.gen(function* () {
    if (!settings.includeMachineIdentity) return undefined;
    const platform = yield* HostProcessPlatform;
    return collectClientIdentity(platform, getKnownGithubLogin());
  });

/**
 * One-shot connectivity check for the AI-Orch governance settings: builds a
 * synthetic evidence batch with the same mapper the live forwarder uses
 * (`makeManagedClientEvidenceBatch`) and POSTs it to the configured AI-Orch
 * endpoint with the same request shape `AiOrchSink` uses. Never retries -
 * this is a manual, on-demand check, not the background forwarder - and
 * never surfaces the credential in its result, only an HTTP status and a
 * short message safe to render directly in the settings UI.
 */
const testAiOrchConnection = (
  settings: CopilotManagedClientEvidenceSettings,
): Effect.Effect<ManagedClientEvidenceTestConnectionResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const governanceUrl = settings.governanceUrl.trim();
    const credential = settings.credential.trim();
    if (governanceUrl.length === 0 || credential.length === 0) {
      return {
        ok: false,
        status: null,
        message: "Set a governance URL and credential before testing.",
      };
    }

    const httpClient = yield* HttpClient.HttpClient;
    const timestamp = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const identity = yield* resolveTestConnectionIdentity(settings);
    const batch = makeManagedClientEvidenceBatch(makeTestConnectionEvents(timestamp));
    const body = identity ? withClientIdentity(batch, identity) : batch;

    const exit = yield* Effect.exit(
      HttpClientRequest.post(
        `${governanceUrl.replace(/\/+$/, "")}/v1/managed-client/evidence`,
      ).pipe(
        HttpClientRequest.bearerToken(credential),
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap(httpClient.execute),
      ),
    );

    if (exit._tag === "Failure") {
      return {
        ok: false,
        status: null,
        message: "Could not reach the governance endpoint.",
      };
    }

    const status = exit.value.status;
    if (status < 200 || status >= 300) {
      return { ok: false, status, message: `Governance endpoint returned HTTP ${status}.` };
    }

    const recordedIdentity = yield* exit.value.json.pipe(
      Effect.map(extractRecordedIdentity),
      Effect.orElseSucceed(() => undefined),
    );

    return {
      ok: true,
      status,
      message: "Connection verified.",
      ...(recordedIdentity ? { recordedIdentity } : {}),
    };
  });

/**
 * One-shot connectivity check for the PostHog backend: sends one clearly
 * named `neokod_test_connection` event through the same `/batch/` shape
 * `PostHogSink` uses, with the same identity/distinct_id rules (best
 * available identity when attached, the persisted per-install anonymous id
 * otherwise).
 */
const testPostHogConnection = (
  settings: CopilotManagedClientEvidenceSettings,
): Effect.Effect<
  ManagedClientEvidenceTestConnectionResult,
  never,
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const posthogHost = settings.posthogHost.trim();
    const posthogApiKey = settings.posthogApiKey.trim();
    if (posthogHost.length === 0 || posthogApiKey.length === 0) {
      return {
        ok: false,
        status: null,
        message: "Set a PostHog host and API key before testing.",
      };
    }

    const httpClient = yield* HttpClient.HttpClient;
    const identity = yield* resolveTestConnectionIdentity(settings);
    const distinctId = identity
      ? identity.github_login || identity.os_username || identity.hostname
      : yield* readOrCreatePostHogAnonymousId;
    const timestamp = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const body = buildPostHogBatchBody({
      apiKey: posthogApiKey,
      events: [buildPostHogTestConnectionEvent(distinctId, timestamp)],
    });

    const exit = yield* Effect.exit(
      HttpClientRequest.post(resolvePostHogBatchUrl(posthogHost)).pipe(
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap(httpClient.execute),
      ),
    );

    if (exit._tag === "Failure") {
      return { ok: false, status: null, message: "Could not reach the PostHog endpoint." };
    }

    const status = exit.value.status;
    if (status < 200 || status >= 300) {
      return { ok: false, status, message: `PostHog endpoint returned HTTP ${status}.` };
    }

    return { ok: true, status, message: "Connection verified." };
  });

/**
 * One-shot connectivity check for the OTLP backend: sends one clearly named
 * `neokod_test_connection` logRecord through the same `/v1/logs` shape
 * `OtlpSink` uses.
 */
const testOtlpConnection = (
  settings: CopilotManagedClientEvidenceSettings,
): Effect.Effect<ManagedClientEvidenceTestConnectionResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const otlpEndpoint = settings.otlpEndpoint.trim();
    if (otlpEndpoint.length === 0) {
      return { ok: false, status: null, message: "Set an OTLP endpoint before testing." };
    }

    const httpClient = yield* HttpClient.HttpClient;
    const identity = yield* resolveTestConnectionIdentity(settings);
    const nowMs = yield* Clock.currentTimeMillis;
    const body = buildOtlpTestConnectionLogsBody({
      identity,
      serviceVersion: packageJson.version,
      nowMs,
    });
    const headers = parseOtlpHeaders(settings.otlpHeaders);

    const exit = yield* Effect.exit(
      HttpClientRequest.post(resolveOtlpLogsUrl(otlpEndpoint)).pipe(
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap(httpClient.execute),
      ),
    );

    if (exit._tag === "Failure") {
      return { ok: false, status: null, message: "Could not reach the OTLP endpoint." };
    }

    const status = exit.value.status;
    if (status < 200 || status >= 300) {
      return { ok: false, status, message: `OTLP endpoint returned HTTP ${status}.` };
    }

    return { ok: true, status, message: "Connection verified." };
  });

/**
 * Backend-aware one-shot connectivity check served by
 * `server.testManagedClientEvidenceConnection`, dispatching to the
 * per-backend probe above for whichever `backend` is currently configured.
 */
export const testManagedClientEvidenceConnection = (
  settings: CopilotManagedClientEvidenceSettings,
): Effect.Effect<
  ManagedClientEvidenceTestConnectionResult,
  never,
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | Crypto.Crypto
> => {
  switch (settings.backend) {
    case "posthog":
      return testPostHogConnection(settings);
    case "otlp":
      return testOtlpConnection(settings);
    case "ai-orch":
      return testAiOrchConnection(settings);
  }
};
