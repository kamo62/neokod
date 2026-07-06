/**
 * CopilotAdapter — `ProviderAdapterShape` implementation wrapping the
 * `@github/copilot-sdk` `CopilotSession` behind the generic provider
 * adapter contract, emitting canonical `ProviderRuntimeEvent`s.
 *
 * Structurally mirrors `Layers/ClaudeAdapter.ts` (event-stamping helpers,
 * `Queue`-backed `streamEvents`, per-thread session map, `Deferred`-backed
 * approval flow) but the underlying SDK shape is closer to Cursor/OpenCode:
 * Copilot is a persistent JSON-RPC client with one session per thread,
 * rather than Claude's one-`query()`-per-turn generator. One `CopilotClient`
 * is shared across every session this adapter manages — it is created and
 * started by `CopilotDriver` and handed in here already connected; the
 * adapter only owns per-session (`CopilotSession`) lifecycle.
 *
 * @module provider/copilot/CopilotAdapter
 */
import type {
  CopilotSession,
  CustomAgentConfig,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfigBase,
} from "@github/copilot-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type CopilotSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeErrorClass,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { copyCopilotMcpServerConfigs, resolveCopilotMcpServers } from "./CopilotMcpServers.ts";

const PROVIDER = ProviderDriverKind.make("githubCopilot");
const COPILOT_RESUME_VERSION = 1 as const;
type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";
// `UserInputRequest`/`UserInputResponse` are defined in the SDK's
// `types.ts` but not re-exported from the package root in 1.0.5 — derive
// them structurally from the handler's own signature instead of hardcoding
// a shape that could silently drift from the real one.
type CopilotUserInputHandler = NonNullable<SessionConfigBase["onUserInputRequest"]>;
type CopilotUserInputRequest = Parameters<CopilotUserInputHandler>[0];
type CopilotUserInputResponse = Awaited<ReturnType<CopilotUserInputHandler>>;
type CopilotRpcFleetStart = (params: { prompt?: string }) => Promise<{ started: boolean }>;
const COPILOT_REASONING_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh"]);

/** Adapter contract for this driver — naming anchor only, see `ClaudeAdapterShape`. */
export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

export interface CopilotAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CopilotToolCallRecord {
  readonly toolName: string;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;
  readonly arguments?: Record<string, unknown>;
  readonly itemType: CanonicalItemType;
}

interface CopilotUsageAccumulator {
  usedTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  durationMs: number;
}

interface CopilotPermissionRequestRecord {
  readonly data: {
    readonly requestId: string;
    readonly permissionRequest: PermissionRequest;
    readonly resolvedByHook?: boolean;
  };
}

interface CopilotSessionContext {
  session: ProviderSession;
  readonly copilotSession: CopilotSession;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly toolCalls: Map<string, CopilotToolCallRecord>;
  readonly permissionRequests: Map<string, CopilotPermissionRequestRecord>;
  // A2: sub-agent worker attribution. Maps a worker's `agentId` (which tags
  // in-flight assistant/tool events) to the task id keyed on the spawning
  // `toolCallId`. Populated at subagent.started, cleared at completed/failed.
  readonly subagentTaskByAgentId: Map<string, RuntimeTaskId>;
  // Copilot plan/tasklist refresh coalescing: `session.todos_changed` is a
  // signal-only event, so we re-read the SQL todo table on each signal but
  // guard against overlapping reads (dirty flag re-runs once more).
  todosRefreshing: boolean;
  todosDirty: boolean;
  readonly usage: CopilotUsageAccumulator;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  sdkTurnId: string | undefined;
  pendingCallbackCount: number;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCopilotResume(raw: unknown): { copilotSessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== COPILOT_RESUME_VERSION) return undefined;
  const id = raw.copilotSessionId;
  return typeof id === "string" && id.trim().length > 0
    ? { copilotSessionId: id.trim() }
    : undefined;
}

function asCopilotReasoningEffort(
  value: string | null | undefined,
): CopilotReasoningEffort | undefined {
  return value && COPILOT_REASONING_EFFORTS.has(value)
    ? (value as CopilotReasoningEffort)
    : undefined;
}

/**
 * Classify a Copilot permission request into the canonical request taxonomy.
 * `shell`/`write`/`read` map onto precise canonical kinds; every other kind
 * (`mcp`, `custom-tool`, `url`, `memory`, `hook`, and any kind added by a
 * future runtime) falls back to `"unknown"` rather than guessing, matching
 * how `OpenCodeAdapter.mapPermissionToRequestType` handles unmapped kinds.
 */
function classifyPermissionRequestType(kind: PermissionRequest["kind"]): CanonicalRequestType {
  switch (kind) {
    case "shell":
      return "command_execution_approval";
    case "write":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    case "mcp":
    case "custom-tool":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

function describeCopilotPermissionRequest(request: PermissionRequest): string {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText;
    case "write":
      return `${request.intention} (${request.fileName})`;
    default:
      return `${request.kind} permission request`;
  }
}

/**
 * Classify a Copilot tool name into the canonical tool-lifecycle item
 * taxonomy. Reimplemented per-driver deliberately — every existing adapter
 * (Claude's `classifyToolItemType`, OpenCode's `toToolLifecycleItemType`)
 * owns its own copy rather than sharing one, since each SDK's tool-naming
 * conventions differ.
 */
function classifyCopilotToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent") || normalized.includes("task")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("create") ||
    normalized.includes("delete") ||
    normalized.includes("patch") ||
    normalized.includes("str_replace")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web_search")) {
    return "web_search";
  }
  if (normalized.includes("view") && normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function classifyCopilotToolCall(data: {
  toolName: string;
  mcpServerName?: string;
}): CanonicalItemType {
  return data.mcpServerName ? "mcp_tool_call" : classifyCopilotToolItemType(data.toolName);
}

/**
 * Map the SDK's `ErrorData.errorType` vocabulary ("authentication",
 * "authorization", "quota", "rate_limit", "context_limit", "query", …) onto
 * the canonical `RuntimeErrorClass`. Unrecognized types omit the class
 * rather than guessing; the full SDK payload rides along in `detail`/`raw`.
 */
function classifyCopilotRuntimeError(errorType: string | undefined): RuntimeErrorClass | undefined {
  switch (errorType) {
    case "authentication":
    case "authorization":
      return "permission_error";
    case "quota":
    case "rate_limit":
    case "context_limit":
      return "provider_error";
    case "query":
      return "validation_error";
    default:
      return undefined;
  }
}

function copyCopilotCustomAgent(agent: CopilotSettings["customAgents"][number]): CustomAgentConfig {
  return {
    name: agent.name,
    prompt: agent.prompt,
    ...(agent.displayName ? { displayName: agent.displayName } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.tools !== undefined ? { tools: agent.tools === null ? null : [...agent.tools] } : {}),
    ...(agent.mcpServers ? { mcpServers: copyCopilotMcpServerConfigs(agent.mcpServers) } : {}),
    ...(agent.infer !== undefined ? { infer: agent.infer } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  };
}

function getCopilotFleetStart(session: CopilotSession): CopilotRpcFleetStart | undefined {
  const rpc = (session as { rpc?: { fleet?: { start?: CopilotRpcFleetStart } } }).rpc;
  return rpc?.fleet?.start;
}

interface CopilotTodoRow {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly status?: string;
}
type CopilotReadSqlTodos = () => Promise<{ readonly rows?: ReadonlyArray<CopilotTodoRow> }>;

/**
 * The SDK's structured-plan reader, when the running CLI build exposes it.
 * Accessed defensively (like `fleet.start`) so an older SDK simply yields no
 * plan instead of throwing.
 */
function getCopilotPlanTodosReader(session: CopilotSession): CopilotReadSqlTodos | undefined {
  const rpc = (
    session as {
      rpc?: { plan?: { readSqlTodosWithDependencies?: CopilotReadSqlTodos } };
    }
  ).rpc;
  return rpc?.plan?.readSqlTodosWithDependencies;
}

type RuntimePlanStepStatus = "pending" | "inProgress" | "completed";

/** Normalize the SDK's free-string todo status into the canonical plan status. */
export function normalizeCopilotTodoStatus(status: string | undefined): RuntimePlanStepStatus {
  const normalized = (status ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "completed" || normalized === "complete" || normalized === "done") {
    return "completed";
  }
  if (
    normalized === "in_progress" ||
    normalized === "inprogress" ||
    normalized === "running" ||
    normalized === "active" ||
    normalized === "started"
  ) {
    return "inProgress";
  }
  return "pending";
}

/**
 * Map the SDK's SQL todo rows into canonical plan steps for `turn.plan.updated`
 * (the same surface Codex/Claude/Cursor/Grok feed). Rows with no text are
 * dropped; the dependency graph is not represented in the flat plan model.
 * Pure.
 *
 * ponytail: the flat plan drops the `todo_deps` DAG. Rendering dependencies
 * would need an optional edge list on RuntimePlanStep and PlanSidebar support;
 * the ceiling is a flat ordered list until that UI exists.
 */
export function mapCopilotTodosToPlanSteps(
  rows: ReadonlyArray<CopilotTodoRow>,
): Array<{ step: string; status: RuntimePlanStepStatus }> {
  const steps: Array<{ step: string; status: RuntimePlanStepStatus }> = [];
  for (const row of rows) {
    const step = (row.title ?? row.description ?? "").trim();
    if (step.length === 0) continue;
    steps.push({ step, status: normalizeCopilotTodoStatus(row.status) });
  }
  return steps;
}

/**
 * Build a crisp progress line for a sub-agent's tool call. Commands and file
 * paths are wrapped in inline code so the Subagents pane renders them in
 * monospace (the same visual weight the main thread gives tool rows) via
 * ChatMarkdown, instead of dumping raw JSON args as prose. Anything without a
 * recognizable command/path degrades to the tool name — never a JSON blob.
 */
function describeWorkerToolProgress(data: {
  toolName: string;
  arguments?: Record<string, unknown> | undefined;
}): string {
  const args = data.arguments;
  const pick = (key: string): string | undefined => {
    const value = args?.[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const command = pick("command");
  if (command) return `\`${command.slice(0, 400)}\``;
  const path = pick("path") ?? pick("filePath") ?? pick("file_path");
  if (path) return `\`${path}\``;
  const query = pick("query") ?? pick("pattern");
  if (query) return `\`${query.slice(0, 400)}\``;
  return data.toolName;
}

function titleForCopilotTool(itemType: CanonicalItemType, toolName: string): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    default:
      return toolName;
  }
}

function summarizeCopilotToolArguments(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return toolName;
  const command = args.command;
  if (typeof command === "string" && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }
  try {
    const serialized = JSON.stringify(args);
    return serialized.length <= 400
      ? `${toolName}: ${serialized}`
      : `${toolName}: ${serialized.slice(0, 397)}...`;
  } catch {
    return toolName;
  }
}

/**
 * Collapse worker output into a single short progress line. Every
 * `task.progress` becomes a durable projection row, so worker content is
 * truncated to the first non-empty line (capped) rather than streamed.
 */
function summarizeWorkerProgressLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length <= 200 ? line : `${line.slice(0, 197)}...`;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (message.includes("unknown session") || message.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId, cause });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `${method} failed`,
    cause,
  });
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

export const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  client: {
    readonly createSession: (config: SessionConfigBase) => Promise<CopilotSession>;
    readonly resumeSession: (
      sessionId: string,
      config: SessionConfigBase,
    ) => Promise<CopilotSession>;
  },
  copilotSettings: CopilotSettings,
  options?: CopilotAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("githubCopilot");
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);

  const sessions = new Map<ThreadId, CopilotSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Copilot runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
    Effect.gen(function* () {
      if (!nativeEventLogger) return;
      const observedAt = yield* nowIso;
      yield* nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* randomUUIDv4,
            kind: "notification",
            provider: PROVIDER,
            createdAt: observedAt,
            method,
            threadId,
            payload,
          },
        },
        threadId,
      );
    });

  const rawSessionEvent = (method: string, payload: unknown) => ({
    raw: {
      source: "copilot.sdk.session-event" as const,
      method,
      payload,
    },
  });

  const providerRefs = (ctx: CopilotSessionContext) =>
    ctx.sdkTurnId ? { providerRefs: { providerTurnId: ctx.sdkTurnId } } : {};

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<CopilotSessionContext, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(ctx);
  };

  const stopSessionInternal = (ctx: CopilotSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      ctx.toolCalls.clear();
      ctx.subagentTaskByAgentId.clear();
      ctx.permissionRequests.clear();
      yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
      yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
      yield* Effect.tryPromise(() => ctx.copilotSession.disconnect()).pipe(Effect.ignore);
      sessions.delete(ctx.session.threadId);
      yield* offerRuntimeEvent({
        type: "session.exited",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        payload: { exitKind: "graceful" },
      });
    });

  const startSession: CopilotAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      if (!input.cwd?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required and must be non-empty.",
        });
      }

      const cwd = input.cwd.trim();
      const copilotModelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const model = copilotModelSelection?.model;
      const reasoningEffort = asCopilotReasoningEffort(
        getModelSelectionStringOptionValue(copilotModelSelection, "reasoningEffort"),
      );

      // The Copilot SDK calls `onPermissionRequest`/`onUserInputRequest` and
      // `session.on(...)` handlers as plain callbacks, outside any Effect
      // fiber. Capture the ambient runtime context once so those bridges run
      // with the surrounding services instead of a bare default runtime.
      const runtimeContext = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(runtimeContext);
      const runPromise = Effect.runPromiseWith(runtimeContext);

      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        yield* stopSessionInternal(existing);
      }

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const toolCalls = new Map<string, CopilotToolCallRecord>();
      const permissionRequests = new Map<string, CopilotPermissionRequestRecord>();
      const subagentTaskByAgentId = new Map<string, RuntimeTaskId>();
      // Populated once the session record below is assigned; the SDK never
      // invokes onPermissionRequest/onUserInputRequest before createSession
      // resolves, but the closures are handed to the SDK before `ctx`
      // exists, hence the defensive `ctx?.` reads.
      let ctx: CopilotSessionContext | undefined;

      const onPermissionRequest = async (
        request: PermissionRequest,
      ): Promise<PermissionRequestResult> => {
        if (input.runtimeMode === "full-access") {
          return { kind: "approve-once" };
        }

        if (ctx) ctx.pendingCallbackCount++;
        const program = Effect.gen(function* () {
          yield* logNative(input.threadId, "permission.requested", request);
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const decision = yield* Deferred.make<ProviderApprovalDecision>();
          pendingApprovals.set(requestId, { decision });
          const requestType = classifyPermissionRequestType(request.kind);
          yield* offerRuntimeEvent({
            type: "request.opened",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: ctx?.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType,
              detail: describeCopilotPermissionRequest(request),
              args: request,
            },
          });
          const resolved = yield* Deferred.await(decision);
          pendingApprovals.delete(requestId);
          yield* offerRuntimeEvent({
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: ctx?.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType, decision: resolved },
          });

          switch (resolved) {
            case "accept":
              return { kind: "approve-once" } as const;
            case "acceptForSession":
              return { kind: "approve-for-session" } as const;
            case "decline":
              return { kind: "reject" } as const;
            case "cancel":
              return { kind: "reject", feedback: "Request cancelled by user." } as const;
          }
        });
        try {
          return await runPromise(program);
        } finally {
          if (ctx) ctx.pendingCallbackCount = Math.max(0, ctx.pendingCallbackCount - 1);
        }
      };

      const onUserInputRequest = async (
        request: CopilotUserInputRequest,
      ): Promise<CopilotUserInputResponse> => {
        const program = Effect.gen(function* () {
          yield* logNative(input.threadId, "user_input.requested", request);
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const answers = yield* Deferred.make<ProviderUserInputAnswers>();
          pendingUserInputs.set(requestId, { answers });
          const question: UserInputQuestion = {
            id: requestId,
            header: "GitHub Copilot",
            question: request.question,
            multiSelect: false,
            options:
              request.choices && request.choices.length > 0
                ? request.choices.map((choice: string) => ({ label: choice, description: choice }))
                : [{ label: "OK", description: "Continue" }],
          };
          yield* offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: ctx?.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { questions: [question] },
          });
          const resolved = yield* Deferred.await(answers);
          pendingUserInputs.delete(requestId);
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: ctx?.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: resolved },
          });
          const answer = resolved[requestId];
          return {
            answer: typeof answer === "string" ? answer : "",
            wasFreeform: true,
          } satisfies CopilotUserInputResponse;
        });
        return runPromise(program);
      };

      const resumeCopilotSessionId = parseCopilotResume(input.resumeCursor)?.copilotSessionId;
      const mcpServers = resolveCopilotMcpServers(copilotSettings);
      const customAgents = copilotSettings.customAgents.map(copyCopilotCustomAgent);
      const activeAgent = copilotSettings.activeAgent.trim();
      const sessionConfig: SessionConfigBase = {
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(customAgents.length > 0 ? { customAgents, includeSubAgentStreamingEvents: true } : {}),
        ...(copilotSettings.defaultAgent
          ? {
              defaultAgent: copilotSettings.defaultAgent.excludedTools
                ? { excludedTools: [...copilotSettings.defaultAgent.excludedTools] }
                : {},
            }
          : {}),
        ...(activeAgent ? { agent: activeAgent } : {}),
        workingDirectory: cwd,
        streaming: true,
        onPermissionRequest,
        onUserInputRequest,
      };

      const copilotSession = yield* Effect.tryPromise(() =>
        resumeCopilotSessionId
          ? client.resumeSession(resumeCopilotSessionId, sessionConfig)
          : client.createSession(sessionConfig),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause instanceof Error ? cause.message : "Failed to start Copilot session.",
              cause,
            }),
        ),
      );

      const now = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(model ? { model } : {}),
        threadId: input.threadId,
        resumeCursor: {
          schemaVersion: COPILOT_RESUME_VERSION,
          copilotSessionId: copilotSession.sessionId,
        },
        createdAt: now,
        updatedAt: now,
      };

      ctx = {
        session,
        copilotSession,
        pendingApprovals,
        pendingUserInputs,
        toolCalls,
        permissionRequests,
        subagentTaskByAgentId,
        usage: {
          usedTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          durationMs: 0,
        },
        turns: [],
        activeTurnId: undefined,
        sdkTurnId: undefined,
        pendingCallbackCount: 0,
        stopped: false,
        todosRefreshing: false,
        todosDirty: false,
      };
      const sessionCtx = ctx;
      sessions.set(input.threadId, sessionCtx);

      // Copilot plan/tasklist: re-read the SQL todo table on each
      // `session.todos_changed` signal and map it into the canonical
      // `turn.plan.updated` event (the same plan surface Codex/Claude/Cursor/
      // Grok feed). Reads are coalesced so a burst of signals never fans out.
      const planTodosReader = getCopilotPlanTodosReader(copilotSession);
      const runTodoRefresh = Effect.gen(function* () {
        let again = true;
        while (again) {
          sessionCtx.todosDirty = false;
          const result = yield* Effect.tryPromise(() => planTodosReader!()).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (result) {
            const plan = mapCopilotTodosToPlanSteps(result.rows ?? []);
            if (plan.length > 0) {
              yield* offerRuntimeEvent({
                type: "turn.plan.updated",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: sessionCtx.activeTurnId,
                payload: { plan },
              });
            }
          }
          again = sessionCtx.todosDirty;
        }
        sessionCtx.todosRefreshing = false;
      });
      const requestTodoRefresh = () => {
        if (!planTodosReader || sessionCtx.stopped) return;
        if (sessionCtx.todosRefreshing) {
          sessionCtx.todosDirty = true;
          return;
        }
        sessionCtx.todosRefreshing = true;
        runFork(runTodoRefresh);
      };

      const emitPermissionResolved = (
        completedData: { requestId: string; result: unknown },
        requestData: CopilotPermissionRequestRecord["data"] | undefined,
      ) =>
        Effect.gen(function* () {
          const requestType = requestData
            ? classifyPermissionRequestType(requestData.permissionRequest.kind)
            : "unknown";
          yield* offerRuntimeEvent({
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: sessionCtx.activeTurnId,
            requestId: RuntimeRequestId.make(completedData.requestId),
            payload: {
              requestType,
              resolution: completedData.result,
            },
            ...rawSessionEvent("permission.completed", completedData),
          });
        });

      copilotSession.on("assistant.turn_start", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "assistant.turn_start", event);
            sessionCtx.sdkTurnId = event.data.turnId;
          }),
        );
      });

      copilotSession.on("assistant.turn_end", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "assistant.turn_end", event);
            if (sessionCtx.sdkTurnId === event.data.turnId) {
              sessionCtx.sdkTurnId = undefined;
            }
          }),
        );
      });

      copilotSession.on("assistant.usage", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "assistant.usage", event);
            const inputTokens = event.data.inputTokens ?? 0;
            const outputTokens = event.data.outputTokens ?? 0;
            const cachedInputTokens = event.data.cacheReadTokens ?? 0;
            const reasoningOutputTokens = event.data.reasoningTokens ?? 0;
            const usedTokens = inputTokens + outputTokens;
            sessionCtx.usage.usedTokens += usedTokens;
            sessionCtx.usage.inputTokens += inputTokens;
            sessionCtx.usage.cachedInputTokens += cachedInputTokens;
            sessionCtx.usage.outputTokens += outputTokens;
            sessionCtx.usage.reasoningOutputTokens += reasoningOutputTokens;
            sessionCtx.usage.durationMs += event.data.duration ?? 0;
            yield* offerRuntimeEvent({
              type: "thread.token-usage.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              ...providerRefs(sessionCtx),
              payload: {
                usage: {
                  usedTokens: sessionCtx.usage.usedTokens,
                  inputTokens: sessionCtx.usage.inputTokens,
                  cachedInputTokens: sessionCtx.usage.cachedInputTokens,
                  outputTokens: sessionCtx.usage.outputTokens,
                  reasoningOutputTokens: sessionCtx.usage.reasoningOutputTokens,
                  lastUsedTokens: usedTokens,
                  lastInputTokens: inputTokens,
                  lastCachedInputTokens: cachedInputTokens,
                  lastOutputTokens: outputTokens,
                  lastReasoningOutputTokens: reasoningOutputTokens,
                  durationMs: sessionCtx.usage.durationMs,
                },
              },
              ...rawSessionEvent("assistant.usage", event.data),
            });
          }),
        );
      });

      copilotSession.on("session.usage_checkpoint", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "session.usage_checkpoint", event);
            yield* offerRuntimeEvent({
              type: "thread.metadata.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { metadata: { copilotUsageCheckpoint: event.data } },
              ...rawSessionEvent("session.usage_checkpoint", event.data),
            });
          }),
        );
      });

      copilotSession.on("session.shutdown", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "session.shutdown", event);
            yield* offerRuntimeEvent({
              type: "thread.metadata.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                metadata: {
                  copilotShutdown: {
                    shutdownType: event.data.shutdownType,
                    codeChanges: event.data.codeChanges,
                    modelMetrics: event.data.modelMetrics,
                    ...(event.data.currentModel ? { currentModel: event.data.currentModel } : {}),
                    ...(event.data.errorReason ? { errorReason: event.data.errorReason } : {}),
                  },
                },
              },
              ...rawSessionEvent("session.shutdown", event.data),
            });
          }),
        );
      });

      copilotSession.on("session.context_changed", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "session.context_changed", event);
            yield* offerRuntimeEvent({
              type: "thread.metadata.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { metadata: { copilotContext: event.data } },
              ...rawSessionEvent("session.context_changed", event.data),
            });
          }),
        );
      });

      copilotSession.on("session.error", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "session.error", event);
            yield* offerRuntimeEvent({
              type: "runtime.error",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                message: event.data.message,
                ...(classifyCopilotRuntimeError(event.data.errorType)
                  ? { class: classifyCopilotRuntimeError(event.data.errorType) }
                  : {}),
                detail: event.data,
              },
              ...rawSessionEvent("session.error", event.data),
            });
          }),
        );
      });

      copilotSession.on("subagent.started", (event) => {
        // Populate the correlation map synchronously in the SDK callback (which
        // fires in event order) so a worker event handler that reads it can
        // never race ahead of the fork that would otherwise set it.
        if (event.agentId) {
          sessionCtx.subagentTaskByAgentId.set(
            event.agentId,
            RuntimeTaskId.make(event.data.toolCallId),
          );
        }
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "subagent.started", event);
            yield* offerRuntimeEvent({
              type: "task.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              payload: {
                taskId: RuntimeTaskId.make(event.data.toolCallId),
                description: event.data.agentDisplayName,
                taskType: event.data.agentName,
                parentToolCallId: event.data.toolCallId,
                ...(event.agentId ? { agentId: event.agentId } : {}),
                ...(event.data.model ? { model: event.data.model } : {}),
              },
              ...rawSessionEvent("subagent.started", event.data),
            });
          }),
        );
      });

      copilotSession.on("subagent.completed", (event) => {
        if (event.agentId) sessionCtx.subagentTaskByAgentId.delete(event.agentId);
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "subagent.completed", event);
            yield* offerRuntimeEvent({
              type: "task.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              payload: {
                taskId: RuntimeTaskId.make(event.data.toolCallId),
                status: "completed",
                summary: event.data.agentDisplayName,
                usage: event.data,
                ...(event.agentId ? { agentId: event.agentId } : {}),
              },
              ...rawSessionEvent("subagent.completed", event.data),
            });
          }),
        );
      });

      copilotSession.on("subagent.failed", (event) => {
        if (event.agentId) sessionCtx.subagentTaskByAgentId.delete(event.agentId);
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "subagent.failed", event);
            yield* offerRuntimeEvent({
              type: "task.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              payload: {
                taskId: RuntimeTaskId.make(event.data.toolCallId),
                status: "failed",
                summary: event.data.error,
                usage: event.data,
                ...(event.agentId ? { agentId: event.agentId } : {}),
              },
              ...rawSessionEvent("subagent.failed", event.data),
            });
          }),
        );
      });

      copilotSession.on("subagent.selected", (event) => {
        runFork(logNative(input.threadId, "subagent.selected", event));
      });

      copilotSession.on("subagent.deselected", (event) => {
        runFork(logNative(input.threadId, "subagent.deselected", event));
      });

      // Copilot tasklist signal: refresh the plan from the SQL todo table.
      copilotSession.on("session.todos_changed", (event) => {
        runFork(logNative(input.threadId, "session.todos_changed", event));
        requestTodoRefresh();
      });

      copilotSession.on("permission.requested", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "permission.requested", event);
            const requestData = {
              requestId: event.data.requestId,
              permissionRequest: event.data.permissionRequest,
              ...(event.data.resolvedByHook ? { resolvedByHook: event.data.resolvedByHook } : {}),
            };
            sessionCtx.permissionRequests.set(event.data.requestId, { data: requestData });
          }),
        );
      });

      copilotSession.on("permission.completed", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "permission.completed", event);
            const requestRecord = sessionCtx.permissionRequests.get(event.data.requestId);
            // The SDK re-fires permission.completed 2-3x per request. The stored
            // record is the dedup token: it's set on permission.requested and
            // consumed here, so a repeat completion finds nothing and is ignored.
            // Without this guard each repeat emitted another request.resolved
            // (with a degraded "unknown" type), flooding the evidence trail.
            if (!requestRecord) return;
            sessionCtx.permissionRequests.delete(event.data.requestId);
            // Auto-resolved permissions (full-access, or hook-/rule-resolved in
            // restricted mode) never waited on the interactive onPermissionRequest
            // callback, so a request.opened for them would flash a pending
            // approval that instantly clears — especially noisy for sub-agent
            // read/shell tools, which fire hundreds of these. Emit only the
            // resolution so the evidence/audit trail is preserved without the
            // phantom prompt. Genuine interactive approvals emit their own
            // request.opened from onPermissionRequest and are untouched here.
            if (
              input.runtimeMode === "full-access" ||
              requestRecord.data.resolvedByHook ||
              sessionCtx.pendingCallbackCount === 0
            ) {
              yield* emitPermissionResolved(event.data, requestRecord.data);
            }
          }),
        );
      });

      copilotSession.on("assistant.message_delta", (event) => {
        // A2: resolve worker attribution synchronously in the SDK callback to
        // avoid racing the correlation map against subagent.started's fork.
        const isWorker =
          event.agentId !== undefined && sessionCtx.subagentTaskByAgentId.has(event.agentId);
        runFork(
          Effect.gen(function* () {
            // A mapped worker's streaming deltas produce no main-thread content
            // and no task.progress (progress coalesces at message/tool
            // boundaries only).
            if (isWorker) return;
            if (event.data.deltaContent.length === 0) return;
            yield* offerRuntimeEvent({
              type: "content.delta",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              ...providerRefs(sessionCtx),
              itemId: RuntimeItemId.make(event.data.messageId),
              payload: { streamKind: "assistant_text", delta: event.data.deltaContent },
            });
          }),
        );
      });

      copilotSession.on("assistant.reasoning_delta", (event) => {
        const isWorker =
          event.agentId !== undefined && sessionCtx.subagentTaskByAgentId.has(event.agentId);
        runFork(
          Effect.gen(function* () {
            if (isWorker) return;
            if (event.data.deltaContent.length === 0) return;
            yield* offerRuntimeEvent({
              type: "content.delta",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              ...providerRefs(sessionCtx),
              itemId: RuntimeItemId.make(event.data.reasoningId),
              payload: { streamKind: "reasoning_text", delta: event.data.deltaContent },
            });
          }),
        );
      });

      copilotSession.on("assistant.message", (event) => {
        // A2: resolve the worker task synchronously (see message_delta note).
        const workerTaskId = event.agentId
          ? sessionCtx.subagentTaskByAgentId.get(event.agentId)
          : undefined;
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "assistant.message", event);
            // Attribute a mapped worker's completed message to its task as one
            // coalesced progress row, and keep it off the main thread.
            if (workerTaskId) {
              const detail = summarizeWorkerProgressLine(event.data.content);
              if (detail) {
                yield* offerRuntimeEvent({
                  type: "task.progress",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: sessionCtx.activeTurnId,
                  payload: {
                    taskId: workerTaskId,
                    description: detail,
                    ...(event.agentId ? { agentId: event.agentId } : {}),
                  },
                });
              }
              return;
            }
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              ...providerRefs(sessionCtx),
              itemId: RuntimeItemId.make(event.data.messageId),
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(event.data.content.length > 0 ? { detail: event.data.content } : {}),
              },
            });
          }),
        );
      });

      copilotSession.on("assistant.reasoning", (event) => {
        const isWorker =
          event.agentId !== undefined && sessionCtx.subagentTaskByAgentId.has(event.agentId);
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "assistant.reasoning", event);
            // A2: a mapped worker's reasoning stays off the main thread; the
            // progress stream focuses on messages and tool boundaries.
            if (isWorker) return;
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              ...providerRefs(sessionCtx),
              itemId: RuntimeItemId.make(event.data.reasoningId),
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                ...(event.data.content.length > 0 ? { detail: event.data.content } : {}),
              },
            });
          }),
        );
      });

      copilotSession.on("tool.execution_start", (event) => {
        // A2: resolve worker attribution synchronously (see message_delta note).
        const workerTaskId = event.agentId
          ? sessionCtx.subagentTaskByAgentId.get(event.agentId)
          : undefined;
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "tool.execution_start", event);
            // A mapped worker's tool call becomes one progress row keyed on the
            // tool name, and is kept off the main thread (start and complete
            // both diverted, so no toolCalls bookkeeping is needed).
            if (workerTaskId) {
              const workerItemType = classifyCopilotToolCall(event.data);
              yield* offerRuntimeEvent({
                type: "task.progress",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: sessionCtx.activeTurnId,
                payload: {
                  taskId: workerTaskId,
                  // Mirror the main thread's tool row: render the command/path
                  // as inline code (monospace in the pane), with the human
                  // action label beneath — never a raw JSON args blob.
                  description: describeWorkerToolProgress(event.data),
                  lastToolName: titleForCopilotTool(workerItemType, event.data.toolName),
                  ...(event.agentId ? { agentId: event.agentId } : {}),
                },
              });
              return;
            }
            const itemType = classifyCopilotToolCall(event.data);
            sessionCtx.toolCalls.set(event.data.toolCallId, {
              toolName: event.data.toolName,
              ...(event.data.mcpServerName ? { mcpServerName: event.data.mcpServerName } : {}),
              ...(event.data.mcpToolName ? { mcpToolName: event.data.mcpToolName } : {}),
              ...(event.data.arguments ? { arguments: event.data.arguments } : {}),
              itemType,
            });
            yield* offerRuntimeEvent({
              type: "item.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              ...providerRefs(sessionCtx),
              itemId: RuntimeItemId.make(event.data.toolCallId),
              payload: {
                itemType,
                status: "inProgress",
                title: titleForCopilotTool(itemType, event.data.toolName),
                detail: summarizeCopilotToolArguments(event.data.toolName, event.data.arguments),
                data: {
                  toolName: event.data.toolName,
                  ...(event.data.mcpServerName ? { mcpServerName: event.data.mcpServerName } : {}),
                  ...(event.data.mcpToolName ? { mcpToolName: event.data.mcpToolName } : {}),
                },
              },
            });
          }),
        );
      });

      copilotSession.on("tool.execution_complete", (event) => {
        // A2: resolve worker attribution synchronously (see message_delta note).
        const isWorker =
          event.agentId !== undefined && sessionCtx.subagentTaskByAgentId.has(event.agentId);
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "tool.execution_complete", event);
            // Mapped-worker tool completions are already represented by the
            // start-time progress row; keep them off the main thread.
            if (isWorker) return;
            const started = sessionCtx.toolCalls.get(event.data.toolCallId);
            sessionCtx.toolCalls.delete(event.data.toolCallId);
            const toolName = started?.toolName ?? event.data.toolDescription?.name ?? "tool";
            const itemType = started?.itemType ?? classifyCopilotToolItemType(toolName);
            const detail = event.data.result?.detailedContent ?? event.data.result?.content;
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              ...providerRefs(sessionCtx),
              itemId: RuntimeItemId.make(event.data.toolCallId),
              payload: {
                itemType,
                status: event.data.success ? "completed" : "failed",
                ...(detail
                  ? { detail }
                  : event.data.error?.message
                    ? { detail: event.data.error.message }
                    : {}),
                data: {
                  toolName,
                  ...(started?.mcpServerName ? { mcpServerName: started.mcpServerName } : {}),
                  ...(started?.mcpToolName ? { mcpToolName: started.mcpToolName } : {}),
                },
              },
            });
          }),
        );
      });

      copilotSession.on("session.idle", (event) => {
        runFork(
          Effect.gen(function* () {
            sessionCtx.toolCalls.clear();
            sessionCtx.subagentTaskByAgentId.clear();
            const turnId = sessionCtx.activeTurnId;
            if (!turnId) return;
            sessionCtx.activeTurnId = undefined;
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { state: event.data.aborted ? "cancelled" : "completed" },
            });
          }),
        );
      });

      yield* offerRuntimeEvent({
        type: "session.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: {},
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { state: "ready", reason: "GitHub Copilot session ready" },
      });
      yield* offerRuntimeEvent({
        type: "thread.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { providerThreadId: copilotSession.sessionId },
      });

      // Resume/startup: the SDK may already hold a plan from a prior run and
      // won't necessarily re-emit todos_changed, so read it once now.
      requestTodoRefresh();

      return session;
    });

  const sendTurn: CopilotAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      const turnModelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const model = turnModelSelection?.model;

      if (model && model !== ctx.session.model) {
        const reasoningEffort = asCopilotReasoningEffort(
          getModelSelectionStringOptionValue(turnModelSelection, "reasoningEffort"),
        );
        yield* Effect.tryPromise(() =>
          ctx.copilotSession.setModel(model, reasoningEffort ? { reasoningEffort } : undefined),
        ).pipe(
          Effect.mapError((cause) => toRequestError(input.threadId, "session/setModel", cause)),
        );
        ctx.session = { ...ctx.session, model };
      }

      const attachments: NonNullable<MessageOptions["attachments"]> = [];
      for (const attachment of input.attachments ?? []) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/send",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const exists = yield* fileSystem
          .exists(attachmentPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/send",
            detail: `Attachment file not found for id '${attachment.id}'.`,
          });
        }
        attachments.push({ type: "file", path: attachmentPath, displayName: attachment.name });
      }

      const prompt = input.input?.trim() ?? "";
      if (prompt.length === 0 && attachments.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }

      const isSteering = ctx.activeTurnId !== undefined;
      const turnId = ctx.activeTurnId ?? TurnId.make(yield* randomUUIDv4);
      ctx.activeTurnId = turnId;
      ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };

      if (!isSteering) {
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: ctx.session.model ? { model: ctx.session.model } : {},
        });
      }

      const messageOptions: MessageOptions = {
        prompt,
        ...(attachments.length > 0 ? { attachments } : {}),
        mode: isSteering ? "immediate" : "enqueue",
        ...(input.interactionMode === "plan" ? { agentMode: "plan" as const } : {}),
      };

      const messageId =
        copilotSettings.fleetMode && attachments.length === 0
          ? yield* Effect.gen(function* () {
              const fleetStart = getCopilotFleetStart(ctx.copilotSession);
              if (!fleetStart) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/fleet.start",
                  detail:
                    "Copilot fleet mode is enabled, but this SDK session does not expose fleet.start.",
                });
              }
              const result = yield* Effect.tryPromise(() => fleetStart({ prompt })).pipe(
                Effect.mapError((cause) =>
                  toRequestError(input.threadId, "session/fleet.start", cause),
                ),
              );
              if (!result.started) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/fleet.start",
                  detail: "Copilot fleet mode did not start.",
                });
              }
              return `fleet:${turnId}`;
            })
          : yield* Effect.tryPromise(() => ctx.copilotSession.send(messageOptions)).pipe(
              Effect.mapError((cause) => toRequestError(input.threadId, "session/send", cause)),
            );

      const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
      if (turnRecord) {
        turnRecord.items.push({ prompt, messageId });
      } else {
        ctx.turns.push({ id: turnId, items: [{ prompt, messageId }] });
      }

      return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
    });

  const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
      yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
      yield* Effect.tryPromise(() => ctx.copilotSession.abort()).pipe(Effect.ignore);
    });

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/respondToPermission",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.decision, decision);
    });

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/respondToUserInput",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.answers, answers);
    });

  const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      return {
        threadId,
        turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    });

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
      return {
        threadId,
        turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    });

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      yield* stopSessionInternal(ctx);
    });

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      return ctx !== undefined && !ctx.stopped;
    });

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to emit GitHub Copilot session shutdown event.", { cause }),
      ),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CopilotAdapterShape;
});
