/**
 * OpenTelemetry (OTLP/HTTP JSON) evidence sink: a public, org-agnostic
 * destination for the managed-client evidence pipeline. POSTs a
 * `resourceLogs` payload to `{otlpEndpoint}/v1/logs` (the path is appended
 * when the configured endpoint doesn't already end with it). Hand-rolled
 * JSON — no `@opentelemetry/*` dependency — since the shape this fork needs
 * is small and fixed.
 *
 * Wire correctness matters here: attribute values use OTLP `AnyValue` shapes
 * (`{stringValue}`/`{intValue}`/`{boolValue}`), and `timeUnixNano` is a
 * STRING of nanoseconds (the proto3 JSON mapping for an int64 field — see
 * `TraceDiagnostics.ts`'s `unixNanoToDateTime`, which decodes this fork's own
 * OTLP trace ingestion the same way).
 *
 * Every evidence event becomes one `logRecord` at `severityNumber: 9`
 * ("INFO"). Resource attributes are `service.name`/`service.version` always,
 * plus `host.name`/`os.user` only when identity is attached. Same PII
 * stripping as `PostHogSink`: no `repo.remote`, no `file_change.paths`.
 *
 * @module OtlpSink
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import packageJson from "../../../package.json" with { type: "json" };
import type { ManagedClientEvidenceEvent, ManagedClientIdentity } from "./ManagedClientEvidence.ts";
import { classifyEvidenceResponse, type EvidenceSink } from "./EvidenceSink.ts";

export interface OtlpSinkSettings {
  readonly otlpEndpoint: string;
  readonly otlpHeaders: string;
}

export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly intValue: string }
  | { readonly boolValue: boolean };

export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  readonly timeUnixNano: string;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: OtlpAnyValue;
  readonly attributes: ReadonlyArray<OtlpAttribute>;
}

export interface OtlpLogsBody {
  readonly resourceLogs: ReadonlyArray<{
    readonly resource: { readonly attributes: ReadonlyArray<OtlpAttribute> };
    readonly scopeLogs: ReadonlyArray<{
      readonly scope: { readonly name: string };
      readonly logRecords: ReadonlyArray<OtlpLogRecord>;
    }>;
  }>;
}

const OTLP_SCOPE_NAME = "neokod.managed-client-evidence";
const OTLP_SEVERITY_NUMBER_INFO = 9;
const OTLP_SEVERITY_TEXT_INFO = "INFO";

export function otlpStringValue(value: string): OtlpAnyValue {
  return { stringValue: value };
}

export function otlpIntValue(value: number): OtlpAnyValue {
  return { intValue: String(Math.trunc(value)) };
}

export function otlpBoolValue(value: boolean): OtlpAnyValue {
  return { boolValue: value };
}

function attribute(key: string, value: OtlpAnyValue): OtlpAttribute {
  return { key, value };
}

/**
 * ISO-8601 timestamp -> nanoseconds-since-epoch, encoded as a decimal string
 * (the proto3 JSON mapping for an int64 field). `fallbackNowMs` is only used
 * when `timestamp` fails to parse, and comes from Effect's `Clock` at the
 * call site rather than a direct `Date.now()` read.
 */
export function isoTimestampToUnixNano(timestamp: string, fallbackNowMs: number): string {
  const millis = Date.parse(timestamp);
  const safeMillis = Number.isNaN(millis) ? fallbackNowMs : millis;
  return (BigInt(Math.trunc(safeMillis)) * 1_000_000n).toString();
}

function flattenAttributes(
  prefix: string,
  value: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<OtlpAttribute> {
  if (!value) return [];
  const attributes: OtlpAttribute[] = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) continue;
    const attributeKey = `${prefix}.${key}`;
    if (typeof fieldValue === "number") {
      attributes.push(attribute(attributeKey, otlpIntValue(fieldValue)));
    } else if (typeof fieldValue === "boolean") {
      attributes.push(attribute(attributeKey, otlpBoolValue(fieldValue)));
    } else if (typeof fieldValue === "string") {
      attributes.push(attribute(attributeKey, otlpStringValue(fieldValue)));
    }
  }
  return attributes;
}

/**
 * Pure event mapper, unit-tested directly for the wire-shape fixture: no
 * `repo.remote`, no `file_change.paths`. `fallbackNowMs` only matters on the
 * (practically unreachable) path where `event.timestamp` fails to parse.
 */
export function evidenceEventToOtlpLogRecord(
  event: ManagedClientEvidenceEvent,
  fallbackNowMs: number,
): OtlpLogRecord {
  const attributes: OtlpAttribute[] = [
    attribute("event.id", otlpStringValue(event.event_id)),
    attribute("event.type", otlpStringValue(event.event_type)),
    attribute("schema.version", otlpStringValue(event.schema_version)),
    attribute("client", otlpStringValue(event.client)),
    attribute("client.session.id", otlpStringValue(event.client_session_id)),
    ...(event.repo?.branch ? [attribute("repo.branch", otlpStringValue(event.repo.branch))] : []),
    ...(event.repo?.commit ? [attribute("repo.commit", otlpStringValue(event.repo.commit))] : []),
  ];

  switch (event.event_type) {
    case "prompt":
    case "assistant_message":
      attributes.push(attribute("content.sha256", otlpStringValue(event.content_sha256)));
      break;
    case "tool_execution":
      attributes.push(...flattenAttributes("tool", event.tool));
      break;
    case "permission_decision":
      attributes.push(...flattenAttributes("permission_decision", event.permission_decision));
      break;
    case "file_change":
      if (event.file_change.diff_sha256) {
        attributes.push(
          attribute("file_change.diff_sha256", otlpStringValue(event.file_change.diff_sha256)),
        );
      }
      break;
    case "token_usage":
      attributes.push(...flattenAttributes("token_usage", event.token_usage));
      break;
    case "session_start":
    case "session_end":
      break;
  }

  return {
    timeUnixNano: isoTimestampToUnixNano(event.timestamp, fallbackNowMs),
    severityNumber: OTLP_SEVERITY_NUMBER_INFO,
    severityText: OTLP_SEVERITY_TEXT_INFO,
    body: otlpStringValue(event.event_type),
    attributes,
  };
}

export function buildOtlpResourceAttributes(input: {
  readonly serviceVersion: string;
  readonly identity: ManagedClientIdentity | undefined;
}): ReadonlyArray<OtlpAttribute> {
  return [
    attribute("service.name", otlpStringValue("neokod")),
    attribute("service.version", otlpStringValue(input.serviceVersion)),
    ...(input.identity ? [attribute("host.name", otlpStringValue(input.identity.hostname))] : []),
    ...(input.identity?.os_username
      ? [attribute("os.user", otlpStringValue(input.identity.os_username))]
      : []),
  ];
}

export function buildOtlpLogsBody(input: {
  readonly events: ReadonlyArray<ManagedClientEvidenceEvent>;
  readonly identity: ManagedClientIdentity | undefined;
  readonly serviceVersion: string;
  readonly nowMs: number;
}): OtlpLogsBody {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: buildOtlpResourceAttributes({
            serviceVersion: input.serviceVersion,
            identity: input.identity,
          }),
        },
        scopeLogs: [
          {
            scope: { name: OTLP_SCOPE_NAME },
            logRecords: input.events.map((event) =>
              evidenceEventToOtlpLogRecord(event, input.nowMs),
            ),
          },
        ],
      },
    ],
  };
}

/** "k=v,k2=v2" -> a header record. Malformed pairs (no `=`, empty key) are skipped. */
export function parseOtlpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key.length === 0) continue;
    headers[key] = value;
  }
  return headers;
}

export function resolveOtlpLogsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/logs") ? trimmed : `${trimmed}/v1/logs`;
}

export function makeOtlpSink(settings: OtlpSinkSettings): EvidenceSink {
  const url = resolveOtlpLogsUrl(settings.otlpEndpoint);
  const headers = parseOtlpHeaders(settings.otlpHeaders);

  const send = (
    events: ReadonlyArray<ManagedClientEvidenceEvent>,
    identity: ManagedClientIdentity | undefined,
  ) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const nowMs = yield* Clock.currentTimeMillis;
      const body = buildOtlpLogsBody({
        events,
        identity,
        serviceVersion: packageJson.version,
        nowMs,
      });

      return yield* classifyEvidenceResponse({
        sink: "otlp",
        response: HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJson(body),
          Effect.flatMap(httpClient.execute),
        ),
      });
    });

  return { name: "otlp", send };
}
