// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { CopilotManagedClientEvidenceSettings } from "@neokod/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  MANAGED_CLIENT_EVIDENCE_CLIENT,
  MANAGED_CLIENT_EVIDENCE_SCHEMA_VERSION,
  makeManagedClientEvidenceBatch,
  type ManagedClientEvidenceEvent,
} from "./ManagedClientEvidence.ts";

export interface ManagedClientEvidenceTestConnectionResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly message: string;
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

/**
 * One-shot connectivity check for the Copilot governance settings: builds a
 * synthetic evidence batch with the same mapper the live forwarder uses
 * (`makeManagedClientEvidenceBatch`) and POSTs it to the configured AI-Orch
 * endpoint with the same request shape `ManagedClientEvidenceForwarder`
 * uses. Never retries - this is a manual, on-demand check, not the
 * background forwarder - and never surfaces the credential in its result,
 * only an HTTP status and a short message safe to render directly in the
 * settings UI.
 */
export const testManagedClientEvidenceConnection = (
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
    const body = makeManagedClientEvidenceBatch(makeTestConnectionEvents(timestamp));

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
    return status >= 200 && status < 300
      ? { ok: true, status, message: "Connection verified." }
      : { ok: false, status, message: `Governance endpoint returned HTTP ${status}.` };
  });
