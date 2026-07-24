// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type { OrchestrationEvent, ProviderRuntimeEvent } from "@neokod/contracts";

export const MANAGED_CLIENT_EVIDENCE_SCHEMA_VERSION = "v0";
export const MANAGED_CLIENT_EVIDENCE_CLIENT = "neokod";
export const MANAGED_CLIENT_IDENTITY_VERSION = 1;

export type ManagedClientEvidenceEventType =
  | "session_start"
  | "session_end"
  | "prompt"
  | "assistant_message"
  | "tool_execution"
  | "permission_decision"
  | "file_change"
  | "token_usage";

export interface ManagedClientEvidenceRepoContext {
  readonly remote?: string | undefined;
  readonly branch?: string | undefined;
  readonly commit?: string | undefined;
}

interface ManagedClientEvidenceBase {
  readonly event_id: string;
  readonly schema_version: typeof MANAGED_CLIENT_EVIDENCE_SCHEMA_VERSION;
  readonly client: typeof MANAGED_CLIENT_EVIDENCE_CLIENT;
  readonly client_session_id: string;
  readonly event_type: ManagedClientEvidenceEventType;
  readonly timestamp: string;
  readonly repo?: ManagedClientEvidenceRepoContext | undefined;
}

export type ManagedClientEvidenceEvent = ManagedClientEvidenceBase &
  (
    | { readonly event_type: "session_start" }
    | { readonly event_type: "session_end" }
    | { readonly event_type: "prompt"; readonly content_sha256: string }
    | {
        readonly event_type: "assistant_message";
        readonly content_sha256: string;
      }
    | {
        readonly event_type: "tool_execution";
        readonly tool: {
          readonly name: string;
          readonly started_at?: string | undefined;
          readonly ended_at?: string | undefined;
          readonly status?: string | undefined;
        };
      }
    | {
        readonly event_type: "permission_decision";
        readonly permission_decision: {
          readonly tool?: string | undefined;
          readonly command?: string | undefined;
          readonly decision: "approved" | "denied";
          readonly decider: "user" | "auto_policy";
          readonly reason?: string | undefined;
        };
      }
    | {
        readonly event_type: "file_change";
        readonly file_change: {
          readonly paths: ReadonlyArray<string>;
          readonly diff_sha256?: string | undefined;
        };
      }
    | {
        readonly event_type: "token_usage";
        readonly token_usage: {
          readonly model?: string | undefined;
          readonly input_tokens?: number | undefined;
          readonly output_tokens?: number | undefined;
          readonly source: "client_reported";
        };
      }
  );

export interface ManagedClientEvidenceBatch {
  readonly events: ReadonlyArray<ManagedClientEvidenceEvent>;
}

/**
 * Client-reported machine identity attached at the batch level (not per
 * event — the per-event `v0` schema above is untouched). Structured only:
 * this never flows into an event's `content` field. `os_username`/
 * `hostname`/`os_platform` describe the machine Neokod is running on;
 * `github_login` is the developer's signed-in GitHub identity when Copilot
 * has one. AI-Orch is the source of truth for what gets recorded and may
 * echo a different value back (see `recorded_identity` on the test
 * connection result).
 */
export interface ManagedClientIdentity {
  readonly v: typeof MANAGED_CLIENT_IDENTITY_VERSION;
  readonly os_username?: string;
  readonly hostname: string;
  readonly os_platform?: string;
  readonly github_login?: string;
}

/**
 * Batch body with `client_identity` attached alongside `events`. Both the
 * live forwarder and the test-connection probe build this the same way so
 * the wire shape never drifts between them.
 */
export interface ManagedClientEvidencePostBody extends ManagedClientEvidenceBatch {
  readonly client_identity: ManagedClientIdentity;
}

/**
 * `os.userInfo()` can throw when the process has no resolvable passwd entry
 * (rare, but seen in some minimal containers) — that failure only drops
 * `os_username`, it never blocks evidence from being sent.
 */
function collectOsUsername(): string | undefined {
  try {
    const username = NodeOS.userInfo().username.trim();
    return username.length > 0 ? username : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the machine-identity block sent with every evidence batch.
 * `githubLogin` is supplied by the caller (see `ManagedClientIdentityRegistry`)
 * rather than resolved here, and `platform` comes from `HostProcessPlatform`
 * (injected by the Effect call sites, see `@neokod/shared/hostProcess`)
 * rather than reading the global `process` directly — this stays a plain,
 * synchronous, zero-I/O helper either way, so collecting identity never
 * delays or blocks posting evidence.
 */
export function collectClientIdentity(
  platform: string,
  githubLogin?: string,
): ManagedClientIdentity {
  const osUsername = collectOsUsername();
  const trimmedLogin = githubLogin?.trim();
  return {
    v: MANAGED_CLIENT_IDENTITY_VERSION,
    ...(osUsername ? { os_username: osUsername } : {}),
    hostname: NodeOS.hostname(),
    os_platform: platform,
    ...(trimmedLogin ? { github_login: trimmedLogin } : {}),
  };
}

export function withClientIdentity(
  batch: ManagedClientEvidenceBatch,
  identity: ManagedClientIdentity,
): ManagedClientEvidencePostBody {
  return { ...batch, client_identity: identity };
}

export function sha256EvidenceContent(value: string): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function sanitizeRepoRemote(remote: string): string {
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote.replace(/\/\/([^/@\s]+)@/, "//");
  }
}

function sanitizeRepoContext(
  repo: ManagedClientEvidenceRepoContext | undefined,
): ManagedClientEvidenceRepoContext | undefined {
  if (!repo) return undefined;
  return {
    ...(repo.remote ? { remote: sanitizeRepoRemote(repo.remote) } : {}),
    ...(repo.branch ? { branch: repo.branch } : {}),
    ...(repo.commit ? { commit: repo.commit } : {}),
  };
}

function baseEvidenceEvent(input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly timestamp: string;
  readonly eventType: ManagedClientEvidenceEventType;
  readonly repo?: ManagedClientEvidenceRepoContext | undefined;
}): ManagedClientEvidenceBase {
  return {
    event_id: input.eventId,
    schema_version: MANAGED_CLIENT_EVIDENCE_SCHEMA_VERSION,
    client: MANAGED_CLIENT_EVIDENCE_CLIENT,
    client_session_id: input.threadId,
    event_type: input.eventType,
    timestamp: input.timestamp,
    ...(input.repo ? { repo: sanitizeRepoContext(input.repo) } : {}),
  };
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromItemData(data: unknown): string | undefined {
  const record = maybeRecord(data);
  return (
    maybeString(record?.text) ??
    maybeString(record?.content) ??
    maybeString(record?.message) ??
    maybeString(record?.delta)
  );
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function evidenceDecisionFromRequestResolution(
  decision: string | undefined,
  resolution: Record<string, unknown> | undefined,
): "approved" | "denied" {
  const normalizedDecision = decision?.toLowerCase();
  if (normalizedDecision === "approved" || normalizedDecision === "allow") {
    return "approved";
  }
  const normalizedResult = maybeString(resolution?.kind)?.toLowerCase();
  return normalizedResult?.startsWith("approved") ? "approved" : "denied";
}

function toolStatusFromRuntimeStatus(status: string | undefined): string | undefined {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "declined":
      return "denied";
    case "inProgress":
      return "running";
    default:
      return status;
  }
}

function evidenceToolName(event: ProviderRuntimeEvent): string | undefined {
  if (event.type === "tool.progress") {
    return event.payload.toolName;
  }
  if (event.type === "tool.denied") {
    return event.payload.toolName;
  }
  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.payload.itemType !== "assistant_message" &&
    event.payload.itemType !== "user_message"
  ) {
    return event.payload.title ?? event.payload.itemType;
  }
  return undefined;
}

export function evidenceFromProviderRuntimeEvent(
  event: ProviderRuntimeEvent,
  repo?: ManagedClientEvidenceRepoContext,
): ManagedClientEvidenceEvent | undefined {
  switch (event.type) {
    case "session.started":
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "session_start",
          repo,
        }),
        event_type: "session_start",
      };
    case "session.exited":
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "session_end",
          repo,
        }),
        event_type: "session_end",
      };
    case "item.completed": {
      if (event.payload.itemType === "assistant_message") {
        const text = event.payload.detail ?? textFromItemData(event.payload.data);
        if (!text) return undefined;
        return {
          ...baseEvidenceEvent({
            eventId: event.eventId,
            threadId: event.threadId,
            timestamp: event.createdAt,
            eventType: "assistant_message",
            repo,
          }),
          event_type: "assistant_message",
          content_sha256: sha256EvidenceContent(text),
        };
      }
      if (!event.payload.status) return undefined;
      const toolName = evidenceToolName(event);
      if (!toolName) return undefined;
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "tool_execution",
          repo,
        }),
        event_type: "tool_execution",
        tool: {
          name: toolName,
          ended_at: event.createdAt,
          status: toolStatusFromRuntimeStatus(event.payload.status),
        },
      };
    }
    case "item.started": {
      const toolName = evidenceToolName(event);
      if (!toolName) return undefined;
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "tool_execution",
          repo,
        }),
        event_type: "tool_execution",
        tool: {
          name: toolName,
          started_at: event.createdAt,
          status: "running",
        },
      };
    }
    case "request.resolved": {
      if (
        event.payload.requestType !== "command_execution_approval" &&
        event.payload.requestType !== "file_read_approval" &&
        event.payload.requestType !== "file_change_approval" &&
        event.payload.requestType !== "apply_patch_approval" &&
        event.payload.requestType !== "exec_command_approval" &&
        event.payload.requestType !== "dynamic_tool_call"
      ) {
        return undefined;
      }
      const resolution = maybeRecord(event.payload.resolution);
      const decision = evidenceDecisionFromRequestResolution(event.payload.decision, resolution);
      const tool = maybeString(resolution?.tool) ?? maybeString(resolution?.toolName);
      const command = maybeString(resolution?.command);
      const fallbackTool = tool ?? (command ? undefined : event.payload.requestType);
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "permission_decision",
          repo,
        }),
        event_type: "permission_decision",
        permission_decision: {
          ...(fallbackTool ? { tool: fallbackTool } : {}),
          ...(command ? { command } : {}),
          decision,
          decider: "user",
          ...(event.payload.decision ? { reason: event.payload.decision } : {}),
        },
      };
    }
    case "tool.denied":
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "permission_decision",
          repo,
        }),
        event_type: "permission_decision",
        permission_decision: {
          tool: event.payload.toolName,
          decision: "denied",
          decider: "auto_policy",
          ...(event.payload.reason ? { reason: event.payload.reason } : {}),
        },
      };
    case "turn.diff.updated":
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "file_change",
          repo,
        }),
        event_type: "file_change",
        file_change: {
          paths: [],
          diff_sha256: sha256EvidenceContent(event.payload.unifiedDiff),
        },
      };
    case "thread.token-usage.updated": {
      const inputTokens = event.payload.usage.lastInputTokens ?? event.payload.usage.inputTokens;
      const outputTokens = event.payload.usage.lastOutputTokens ?? event.payload.usage.outputTokens;
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "token_usage",
          repo,
        }),
        event_type: "token_usage",
        token_usage: {
          ...(inputTokens !== undefined
            ? {
                input_tokens: inputTokens,
              }
            : {}),
          ...(outputTokens !== undefined
            ? {
                output_tokens: outputTokens,
              }
            : {}),
          source: "client_reported",
        },
      };
    }
    case "turn.completed": {
      const modelUsage = maybeRecord(event.payload.modelUsage);
      const usage = maybeRecord(event.payload.usage);
      const inputTokens =
        numberFromUnknown(modelUsage?.inputTokens) ??
        numberFromUnknown(modelUsage?.input_tokens) ??
        numberFromUnknown(usage?.inputTokens) ??
        numberFromUnknown(usage?.input_tokens);
      const outputTokens =
        numberFromUnknown(modelUsage?.outputTokens) ??
        numberFromUnknown(modelUsage?.output_tokens) ??
        numberFromUnknown(usage?.outputTokens) ??
        numberFromUnknown(usage?.output_tokens);
      const model = maybeString(modelUsage?.model) ?? maybeString(usage?.model);
      if (inputTokens === undefined && outputTokens === undefined) return undefined;
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.threadId,
          timestamp: event.createdAt,
          eventType: "token_usage",
          repo,
        }),
        event_type: "token_usage",
        token_usage: {
          ...(model ? { model } : {}),
          ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
          ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
          source: "client_reported",
        },
      };
    }
    default:
      return undefined;
  }
}

export function evidenceFromOrchestrationEvent(
  event: OrchestrationEvent,
  repo?: ManagedClientEvidenceRepoContext,
): ManagedClientEvidenceEvent | undefined {
  switch (event.type) {
    case "thread.message-sent":
      if (event.payload.role !== "user") return undefined;
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.payload.threadId,
          timestamp: event.occurredAt,
          eventType: "prompt",
          repo,
        }),
        event_type: "prompt",
        content_sha256: sha256EvidenceContent(event.payload.text),
      };
    case "thread.turn-diff-completed":
      return {
        ...baseEvidenceEvent({
          eventId: event.eventId,
          threadId: event.payload.threadId,
          timestamp: event.occurredAt,
          eventType: "file_change",
          repo,
        }),
        event_type: "file_change",
        file_change: {
          paths: event.payload.files.map((file) => file.path),
        },
      };
    default:
      return undefined;
  }
}

export function makeManagedClientEvidenceBatch(
  events: ReadonlyArray<ManagedClientEvidenceEvent>,
): ManagedClientEvidenceBatch {
  return { events: events.slice(0, 50) };
}
