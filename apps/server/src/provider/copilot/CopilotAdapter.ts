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
  RuntimeItemId,
  RuntimeRequestId,
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
const COPILOT_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
]);

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

interface CopilotSessionContext {
  session: ProviderSession;
  readonly copilotSession: CopilotSession;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
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

function asCopilotReasoningEffort(value: string | null | undefined): CopilotReasoningEffort | undefined {
  return value && COPILOT_REASONING_EFFORTS.has(value) ? (value as CopilotReasoningEffort) : undefined;
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

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (message.includes("unknown session") || message.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId, cause });
  }
  return new ProviderAdapterRequestError({ provider: PROVIDER, method, detail: `${method} failed`, cause });
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
        return runPromise(program);
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
      const sessionConfig: SessionConfigBase = {
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
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
        turns: [],
        activeTurnId: undefined,
        stopped: false,
      };
      const sessionCtx = ctx;
      sessions.set(input.threadId, sessionCtx);

      copilotSession.on("assistant.message_delta", (event) => {
        runFork(
          Effect.gen(function* () {
            if (event.data.deltaContent.length === 0) return;
            yield* offerRuntimeEvent({
              type: "content.delta",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              itemId: RuntimeItemId.make(event.data.messageId),
              payload: { streamKind: "assistant_text", delta: event.data.deltaContent },
            });
          }),
        );
      });

      copilotSession.on("assistant.reasoning_delta", (event) => {
        runFork(
          Effect.gen(function* () {
            if (event.data.deltaContent.length === 0) return;
            yield* offerRuntimeEvent({
              type: "content.delta",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              itemId: RuntimeItemId.make(event.data.reasoningId),
              payload: { streamKind: "reasoning_text", delta: event.data.deltaContent },
            });
          }),
        );
      });

      copilotSession.on("assistant.message", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "assistant.message", event);
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
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
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "assistant.reasoning", event);
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
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
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "tool.execution_start", event);
            const itemType = classifyCopilotToolItemType(event.data.toolName);
            yield* offerRuntimeEvent({
              type: "item.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              itemId: RuntimeItemId.make(event.data.toolCallId),
              payload: {
                itemType,
                status: "inProgress",
                title: titleForCopilotTool(itemType, event.data.toolName),
                detail: summarizeCopilotToolArguments(event.data.toolName, event.data.arguments),
              },
            });
          }),
        );
      });

      copilotSession.on("tool.execution_complete", (event) => {
        runFork(
          Effect.gen(function* () {
            yield* logNative(input.threadId, "tool.execution_complete", event);
            const itemType = classifyCopilotToolItemType(
              event.data.toolDescription?.name ?? "tool",
            );
            const detail = event.data.result?.detailedContent ?? event.data.result?.content;
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: sessionCtx.activeTurnId,
              itemId: RuntimeItemId.make(event.data.toolCallId),
              payload: {
                itemType,
                status: event.data.success ? "completed" : "failed",
                ...(detail ? { detail } : event.data.error?.message ? { detail: event.data.error.message } : {}),
              },
            });
          }),
        );
      });

      copilotSession.on("session.idle", (event) => {
        runFork(
          Effect.gen(function* () {
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
        const exists = yield* fileSystem.exists(attachmentPath).pipe(Effect.orElseSucceed(() => false));
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
          payload: { ...(ctx.session.model ? { model: ctx.session.model } : {}) },
        });
      }

      const messageOptions: MessageOptions = {
        prompt,
        ...(attachments.length > 0 ? { attachments } : {}),
        mode: "enqueue",
        ...(input.interactionMode === "plan" ? { agentMode: "plan" as const } : {}),
      };

      const messageId = yield* Effect.tryPromise(() => ctx.copilotSession.send(messageOptions)).pipe(
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

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
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
      return { threadId, turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })) };
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
      return { threadId, turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })) };
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
