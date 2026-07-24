/**
 * AI-Orch evidence sink. Exactly today's wire behavior (pre-dating the
 * backend-pluggable sink split): POST `{events, client_identity}` (identity
 * omitted when the forwarder didn't attach one) to
 * `{governanceUrl}/v1/managed-client/evidence` with a bearer credential.
 * Zero contract change for existing AI-Orch deployments.
 *
 * @module AiOrchSink
 */
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  makeManagedClientEvidenceBatch,
  withClientIdentity,
  type ManagedClientEvidenceEvent,
  type ManagedClientIdentity,
} from "./ManagedClientEvidence.ts";
import { classifyEvidenceResponse, type EvidenceSink } from "./EvidenceSink.ts";

export interface AiOrchSinkSettings {
  readonly governanceUrl: string;
  readonly credential: string;
}

export function makeAiOrchSink(settings: AiOrchSinkSettings): EvidenceSink {
  const endpoint = `${settings.governanceUrl.replace(/\/+$/, "")}/v1/managed-client/evidence`;

  const send = (
    events: ReadonlyArray<ManagedClientEvidenceEvent>,
    identity: ManagedClientIdentity | undefined,
  ) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const batch = makeManagedClientEvidenceBatch(events);
      const body = identity ? withClientIdentity(batch, identity) : batch;

      return yield* classifyEvidenceResponse({
        sink: "ai-orch",
        response: HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.bearerToken(settings.credential),
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.bodyJson(body),
          Effect.flatMap(httpClient.execute),
        ),
      });
    });

  return { name: "ai-orch", send };
}
