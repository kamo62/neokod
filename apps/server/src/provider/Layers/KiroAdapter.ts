import {
  ApprovalRequestId,
  EventId,
  type KiroSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@neokod/contracts";
import { terminateProcessGroup, type ProcessGroupIdentity } from "@neokod/shared/processGroup";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { WorkspaceOwnershipRepositoryShape } from "../../symphony/Persistence/Services/WorkspaceOwnershipRepository.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kiro");
const KIRO_RESUME_VERSION = 2 as const;
const KIRO_V3_PERMISSION_POLICY = "rules:\n  - capability: all\n    effect: ask\n";
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

export type KiroManagedTurnEvidence =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

export interface KiroAdapterLiveOptions {
  readonly ownershipRepository: WorkspaceOwnershipRepositoryShape;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly onManagedTurnEvidence?: (evidence: KiroManagedTurnEvidence) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly response: Deferred.Deferred<EffectAcpSchema.CreateElicitationResponse>;
}

interface KiroSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly identity: ProcessGroupIdentity;
  readonly workspacePath: string;
  readonly workspaceLeaseGeneration: number;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly extensionError: Ref.Ref<string | undefined>;
  session: ProviderSession;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  readonly assistantOutputTurnIds: Set<TurnId>;
  interruptedTurnIds: Set<TurnId>;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKiroResume(
  raw: unknown,
): { sessionId: string; agentEngine: KiroSettings["agentEngine"] } | undefined {
  if (!isRecord(raw) || typeof raw.sessionId !== "string" || !raw.sessionId.trim()) {
    return undefined;
  }
  if (raw.schemaVersion === 1) {
    return { sessionId: raw.sessionId.trim(), agentEngine: "v2" };
  }
  if (
    raw.schemaVersion === KIRO_RESUME_VERSION &&
    (raw.agentEngine === "v2" || raw.agentEngine === "v3")
  ) {
    return { sessionId: raw.sessionId.trim(), agentEngine: raw.agentEngine };
  }
  return undefined;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
}

function appendPromptResult(
  context: KiroSessionContext,
  turnId: TurnId,
  prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existing = context.turns.find((turn) => turn.id === turnId);
  context.turns = existing
    ? context.turns.map((turn) =>
        turn.id === turnId ? { ...turn, items: [...turn.items, { prompt, result }] } : turn,
      )
    : [...context.turns, { id: turnId, items: [{ prompt, result }] }];
}

const settleApprovals = (pending: ReadonlyMap<ApprovalRequestId, PendingApproval>) =>
  Effect.forEach(
    Array.from(pending.values()),
    (approval) => Deferred.succeed(approval.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );

const settleUserInputs = (pending: ReadonlyMap<ApprovalRequestId, PendingUserInput>) =>
  Effect.forEach(
    Array.from(pending.values()),
    (input) => Deferred.succeed(input.response, { action: "cancel" }).pipe(Effect.ignore),
    { discard: true },
  );

type StructuredElicitationRequest = Extract<
  EffectAcpSchema.CreateElicitationRequest,
  { readonly requestedSchema: unknown }
>;

function isStructuredElicitationRequest(
  request: EffectAcpSchema.CreateElicitationRequest,
): request is StructuredElicitationRequest {
  return request.mode === "form" && "requestedSchema" in request;
}

function elicitationQuestions(
  request: EffectAcpSchema.CreateElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (!isStructuredElicitationRequest(request)) return [];
  const requestedSchema = request.requestedSchema;
  const properties = requestedSchema.properties ?? {};
  return Object.entries(properties).map(([id, property]) => {
    const fields: Record<string, unknown> = isRecord(property) ? property : {};
    const propertyType = typeof fields.type === "string" ? fields.type : "unknown";
    const stringOptions = (value: unknown) =>
      Array.isArray(value)
        ? value.flatMap((entry) =>
            typeof entry === "string" ? [{ label: entry, description: entry }] : [],
          )
        : [];
    const titledOptions = (value: unknown) =>
      Array.isArray(value)
        ? value.flatMap((entry) => {
            if (!isRecord(entry) || typeof entry.const !== "string") return [];
            const title = typeof entry.title === "string" ? entry.title : entry.const;
            const description =
              typeof entry.description === "string" && entry.description.trim().length > 0
                ? entry.description.trim()
                : title;
            return [{ label: entry.const, description }];
          })
        : [];
    let options: ReadonlyArray<{ label: string; description: string }> = [];
    let multiSelect = false;
    if (propertyType === "string") {
      options = titledOptions(fields.oneOf);
      if (options.length === 0) options = stringOptions(fields.enum);
    } else if (propertyType === "array") {
      multiSelect = true;
      const items: Record<string, unknown> = isRecord(fields.items) ? fields.items : {};
      options = stringOptions(items.enum);
      if (options.length === 0) options = titledOptions(items.anyOf);
    } else if (propertyType === "boolean") {
      options = [
        { label: "true", description: "Yes" },
        { label: "false", description: "No" },
      ];
    }
    const propertyTitle = typeof fields.title === "string" ? fields.title.trim() : "";
    const propertyDescription =
      typeof fields.description === "string" ? fields.description.trim() : "";
    return {
      id,
      header: propertyTitle || requestedSchema.title?.trim() || "Question",
      question: propertyDescription || request.message,
      options: options.length > 0 ? options : [{ label: "OK", description: "Continue" }],
      multiSelect,
    };
  });
}

function normalizeElicitationAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([key, value]) => {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
      ) {
        return [[key, value as EffectAcpSchema.ElicitationContentValue]];
      }
      return [];
    }),
  );
}

export function makeKiroAdapter(settings: KiroSettings, options: KiroAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("kiro");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const platform = yield* HostProcessPlatform;
    const nativeEventLogger =
      options.nativeEventLogger ??
      (options.nativeEventLogPath
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const managedV3Home =
      settings.agentEngine === "v3"
        ? path.join(
            serverConfig.stateDir,
            "provider-homes",
            "kiro-v3",
            encodeURIComponent(String(boundInstanceId)),
          )
        : undefined;
    if (managedV3Home) {
      const kiroSettingsDir = path.join(managedV3Home, ".kiro", "settings");
      const permissionsPath = path.join(kiroSettingsDir, "permissions.yaml");
      yield* fileSystem.makeDirectory(kiroSettingsDir, { recursive: true });
      yield* Effect.all(
        [managedV3Home, path.join(managedV3Home, ".kiro"), kiroSettingsDir].map((directory) =>
          fileSystem.chmod(directory, 0o700),
        ),
      );
      yield* fileSystem.writeFileString(permissionsPath, KIRO_V3_PERMISSION_POLICY);
      yield* fileSystem.chmod(permissionsPath, 0o600);
    }

    const sessions = new Map<ThreadId, KiroSessionContext>();
    const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Kiro runtime identifier.",
            cause,
          }),
      ),
    );
    const eventStamp = () =>
      Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    const getLock = (threadId: string) =>
      SynchronizedRef.modifyEffect(locks, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });
    const withLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getLock(threadId), (lock) => lock.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KiroSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return !context || context.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(context);
    };

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomId,
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
      }).pipe(Effect.catch(() => Effect.void));

    const mapCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Kiro ACP callback.",
              cause,
            }),
        ),
      );

    const releaseWorkspaceLease = (context: KiroSessionContext) =>
      options.ownershipRepository
        .release({
          workspacePath: context.workspacePath,
          owner: "work",
          generation: context.workspaceLeaseGeneration,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.threadId,
                detail: `Failed to release Kiro workspace lease: ${cause.message}`,
                cause,
              }),
          ),
        );

    const closeSession = (
      context: KiroSessionContext,
      exitKind: "graceful" | "error",
      releaseLease = true,
    ) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        if (releaseLease) {
          const released = yield* releaseWorkspaceLease(context);
          if (!released) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.threadId,
              detail: "Kiro workspace lease release failed its ownership-generation fence.",
            });
          }
        }
        context.stopped = true;
        yield* settleApprovals(context.pendingApprovals);
        yield* settleUserInputs(context.pendingUserInputs);
        if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(context.threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: { exitKind },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withLock(
        input.threadId,
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
          if (platform === "win32") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "Kiro managed sessions are unavailable on Windows until process-tree containment is supported.",
            });
          }
          if (input.runtimeMode !== "approval-required") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Kiro runtime mode '${input.runtimeMode}' is unavailable until its live containment and trust-policy probes pass. Use 'approval-required'.`,
            });
          }

          const requestedCwd = path.resolve(input.cwd.trim());
          const cwdStats = yield* fileSystem.stat(requestedCwd).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: `Cannot access Kiro workspace '${requestedCwd}': ${cause.message}`,
                  cause,
                }),
            ),
          );
          if (cwdStats.type !== "Directory") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Kiro workspace is not a directory: ${requestedCwd}`,
            });
          }
          const cwd = yield* fileSystem.realPath(requestedCwd).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: `Cannot canonicalize Kiro workspace '${requestedCwd}': ${cause.message}`,
                  cause,
                }),
            ),
          );
          const previous = sessions.get(input.threadId);
          if (previous && !previous.stopped) {
            yield* settleApprovals(previous.pendingApprovals);
            yield* settleUserInputs(previous.pendingUserInputs);
            yield* previous.acp.cancel.pipe(Effect.ignore);
            const termination = yield* terminateProcessGroup(previous.identity, { graceMs: 3_000 });
            if (termination.status === "termination_failed") {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `Cannot replace the existing Kiro process group: ${termination.detail}`,
              });
            }
            yield* closeSession(previous, "graceful");
          }

          const lease = yield* options.ownershipRepository
            .acquire({
              workspacePath: cwd,
              owner: "work",
              threadId: String(input.threadId),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Failed to acquire Kiro workspace lease: ${cause.message}`,
                    cause,
                  }),
              ),
            );
          if (lease === null) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Kiro workspace '${cwd}' is held by another live owner.`,
            });
          }
          let leaseTransferred = false;
          yield* Effect.addFinalizer(() =>
            leaseTransferred
              ? Effect.void
              : options.ownershipRepository
                  .release({
                    workspacePath: cwd,
                    owner: "work",
                    generation: lease.generation,
                  })
                  .pipe(Effect.ignore),
          );

          // The ACP runtime spawns eagerly. Re-resolve both the path and its
          // durable lease at the last possible point before constructing it.
          const spawnCwd = yield* fileSystem.realPath(requestedCwd).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: `Cannot revalidate Kiro workspace '${requestedCwd}': ${cause.message}`,
                  cause,
                }),
            ),
          );
          const verifiedLease = yield* options.ownershipRepository
            .getByWorkspacePath(spawnCwd)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Failed to verify Kiro workspace lease: ${cause.message}`,
                    cause,
                  }),
              ),
            );
          if (
            spawnCwd !== cwd ||
            verifiedLease === null ||
            verifiedLease.owner !== "work" ||
            verifiedLease.threadId !== String(input.threadId) ||
            verifiedLease.generation !== lease.generation
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Kiro workspace path or ownership generation changed before child spawn.",
            });
          }

          const sessionScope = yield* Scope.make("sequential");
          let scopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const extensionError = yield* Ref.make<string | undefined>(undefined);
          const resume = parseKiroResume(input.resumeCursor);
          if (input.resumeCursor !== undefined && resume === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Kiro resume cursor is invalid or unsupported.",
            });
          }
          if (resume && resume.agentEngine !== settings.agentEngine) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Kiro ${resume.agentEngine} sessions cannot resume with the ${settings.agentEngine} engine.`,
            });
          }
          const resumeSessionId = resume?.sessionId;
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const acpLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeKiroAcpRuntime({
            settings,
            ...(options.environment ? { environment: options.environment } : {}),
            ...(managedV3Home ? { managedHome: managedV3Home } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "neokod", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "neokod",
                      url: mcpSession.endpoint,
                      headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
                    },
                  ],
                }
              : {}),
            ...acpLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          yield* acp.handleRequestPermission((params) =>
            mapCallbackFailure(
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const permission = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* randomId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision });
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const active = sessions.get(input.threadId)?.activeTurnId;
                yield* publish(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* eventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: active,
                    requestId: runtimeRequestId,
                    permissionRequest: permission,
                    detail: permission.detail ?? "Kiro requests permission to use a tool.",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* publish(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* eventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: active,
                    requestId: runtimeRequestId,
                    permissionRequest: permission,
                    decision: resolved,
                  }),
                );
                const optionId =
                  resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                return {
                  outcome: optionId
                    ? { outcome: "selected" as const, optionId }
                    : ({ outcome: "cancelled" } as const),
                };
              }),
            ),
          );
          yield* acp.handleElicitation((params) =>
            mapCallbackFailure(
              Effect.gen(function* () {
                yield* logNative(input.threadId, "elicitation/create", params);
                const questions = elicitationQuestions(params);
                if (questions.length === 0) return { action: "decline" as const };
                const requestId = ApprovalRequestId.make(yield* randomId);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const response = yield* Deferred.make<EffectAcpSchema.CreateElicitationResponse>();
                pendingUserInputs.set(requestId, { response });
                const turnId = sessions.get(input.threadId)?.activeTurnId;
                yield* publish({
                  type: "user-input.requested",
                  ...(yield* eventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: { source: "acp.jsonrpc", method: "elicitation/create", payload: params },
                });
                const resolved = yield* Deferred.await(response);
                pendingUserInputs.delete(requestId);
                const answers =
                  resolved.action === "accept" && "content" in resolved
                    ? (resolved.content ?? {})
                    : {};
                yield* publish({
                  type: "user-input.resolved",
                  ...(yield* eventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: { answers },
                  raw: { source: "acp.jsonrpc", method: "elicitation/create", payload: params },
                });
                return resolved;
              }),
            ),
          );
          yield* acp.handleUnknownExtNotification((method, params) =>
            mapCallbackFailure(
              Effect.gen(function* () {
                if (
                  method.startsWith("_kiro.dev/error/") &&
                  isRecord(params) &&
                  typeof params.message === "string" &&
                  params.message.trim().length > 0
                ) {
                  yield* Ref.set(extensionError, params.message.trim());
                }
                yield* logNative(input.threadId, method, params);
              }),
            ),
          );
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
              ),
            );
          const identity = yield* acp.identity;
          if (identity === null || identity.birthToken === null) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail:
                "Kiro child process-group identity could not be proven; managed recovery is unavailable on this platform.",
            });
          }
          const pid = yield* acp.pid;
          if (pid === null || pid !== identity.pid) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Kiro child PID does not match its proven process-group leader.",
            });
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model ?? "auto",
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: KIRO_RESUME_VERSION,
              sessionId: started.sessionId,
              agentEngine: settings.agentEngine,
            },
            createdAt: now,
            updatedAt: now,
          };
          const context: KiroSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            scope: sessionScope,
            acp,
            identity,
            workspacePath: cwd,
            workspaceLeaseGeneration: lease.generation,
            pendingApprovals,
            pendingUserInputs,
            extensionError,
            session,
            turns: [],
            notificationFiber: undefined,
            activeTurnId: undefined,
            assistantOutputTurnIds: new Set(),
            interruptedTurnIds: new Set(),
            stopped: false,
          };

          const notificationFiber = yield* Stream.runForEach(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              if (event._tag === "EventStreamBarrier") {
                yield* Deferred.succeed(event.acknowledge, undefined);
                return;
              }
              const turnId = context.activeTurnId;
              if (
                event._tag === "ModeChanged" ||
                !turnId ||
                context.interruptedTurnIds.has(turnId)
              ) {
                return;
              }
              const stamp = yield* eventStamp();
              switch (event._tag) {
                case "AssistantItemStarted":
                case "AssistantItemCompleted":
                  yield* publish(
                    makeAcpAssistantItemEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      itemId: event.itemId,
                      lifecycle:
                        event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated":
                  yield* publish(
                    makeAcpPlanUpdatedEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ToolCallUpdated":
                  yield* publish(
                    makeAcpToolCallEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ContentDelta":
                  if (event.text.trim()) context.assistantOutputTurnIds.add(turnId);
                  yield* publish(
                    makeAcpContentDeltaEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
              }
            }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Kiro ACP notification.", { cause }),
            ),
            Effect.forkIn(sessionScope),
          );
          context.notificationFiber = notificationFiber;
          sessions.set(input.threadId, context);
          scopeTransferred = true;
          leaseTransferred = true;

          yield* publish({
            type: "session.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* publish({
            type: "session.state.changed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Kiro ACP session ready" },
          });
          yield* publish({
            type: "thread.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withLock(
          input.threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(input.threadId);
            if (context.activeTurnId !== undefined) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Kiro already has an active turn for this thread.",
              });
            }
            if (
              input.modelSelection?.instanceId === boundInstanceId &&
              input.modelSelection.model !== context.session.model
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Changing a Kiro model requires a new thread.",
              });
            }
            const text = input.input?.trim();
            const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
              Effect.gen(function* () {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (!attachmentPath) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
                return {
                  type: "image" as const,
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                } satisfies EffectAcpSchema.ContentBlock;
              }),
            );
            const prompt: Array<EffectAcpSchema.ContentBlock> = [
              ...(text ? [{ type: "text" as const, text }] : []),
              ...images,
            ];
            if (prompt.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }
            const turnId = TurnId.make(yield* randomId);
            context.activeTurnId = turnId;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };
            yield* publish({
              type: "turn.started",
              ...(yield* eventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: context.session.model ? { model: context.session.model } : {},
            });
            return { context, prompt, turnId };
          }),
        );

        yield* Ref.set(prepared.context.extensionError, undefined);
        const result = yield* prepared.context.acp.prompt({ prompt: prepared.prompt }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            return Ref.get(prepared.context.extensionError).pipe(
              Effect.flatMap((detail) =>
                Effect.fail(
                  detail
                    ? new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail,
                        cause,
                      })
                    : isAcpError(error)
                      ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error)
                      : new ProviderAdapterRequestError({
                          provider: PROVIDER,
                          method: "session/prompt",
                          detail: String(error),
                          cause,
                        }),
                ),
              ),
            );
          }),
          Effect.tapError((error) =>
            withLock(
              input.threadId,
              Effect.gen(function* () {
                const context = sessions.get(input.threadId);
                if (
                  !context ||
                  context.stopped ||
                  context.acpSessionId !== prepared.context.acpSessionId ||
                  context.activeTurnId !== prepared.turnId
                ) {
                  return;
                }
                const { activeTurnId: _activeTurnId, ...ready } = context.session;
                context.activeTurnId = undefined;
                context.assistantOutputTurnIds.delete(prepared.turnId);
                context.session = { ...ready, status: "ready", updatedAt: yield* nowIso };
                yield* publish({
                  type: "turn.completed",
                  ...(yield* eventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: { state: "failed", errorMessage: error.message },
                });
                yield* (
                  options.onManagedTurnEvidence?.({
                    ready: false,
                    reason:
                      error._tag === "ProviderAdapterRequestError" ? error.detail : error.message,
                  }) ?? Effect.void
                );
              }),
            ).pipe(Effect.catch(() => Effect.void)),
          ),
        );
        return yield* withLock(
          input.threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(input.threadId);
            yield* context.acp.drainEvents;
            if (context.interruptedTurnIds.has(prepared.turnId)) {
              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: context.session.resumeCursor,
              };
            }
            appendPromptResult(context, prepared.turnId, prepared.prompt, result);
            const hasAssistantOutput = context.assistantOutputTurnIds.delete(prepared.turnId);
            const { activeTurnId: _activeTurnId, ...ready } = context.session;
            context.activeTurnId = undefined;
            context.session = { ...ready, status: "ready", updatedAt: yield* nowIso };
            yield* publish({
              type: "turn.completed",
              ...(yield* eventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: prepared.turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason,
              },
            });
            if (result.stopReason !== "cancelled") {
              yield* (
                options.onManagedTurnEvidence?.(
                  hasAssistantOutput
                    ? { ready: true }
                    : {
                        ready: false,
                        reason: "Managed turn completed without assistant output.",
                      },
                ) ?? Effect.void
              );
            }
            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              resumeCursor: context.session.resumeCursor,
            };
          }),
        );
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      requestedTurnId,
    ) =>
      withLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const turnId = requestedTurnId ?? context.activeTurnId;
          if (!turnId || (context.activeTurnId && turnId !== context.activeTurnId)) return;
          context.interruptedTurnIds.add(turnId);
          context.assistantOutputTurnIds.delete(turnId);
          yield* settleApprovals(context.pendingApprovals);
          yield* settleUserInputs(context.pendingUserInputs);
          yield* context.acp.cancel.pipe(Effect.ignore);
          const { activeTurnId: _activeTurnId, ...ready } = context.session;
          context.activeTurnId = undefined;
          context.session = { ...ready, status: "ready", updatedAt: yield* nowIso };
          yield* publish({
            type: "turn.completed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            threadId,
            turnId,
            payload: { state: "cancelled", stopReason: "cancelled" },
          });
        }),
      );

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "elicitation/create",
            detail: `Unknown pending Kiro user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.response, {
          action: "accept",
          content: normalizeElicitationAnswers(answers),
        });
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withLock(
        threadId,
        Effect.gen(function* (): Effect.fn.Return<void, ProviderAdapterError> {
          const context = yield* requireSession(threadId);
          yield* settleApprovals(context.pendingApprovals);
          yield* settleUserInputs(context.pendingUserInputs);
          yield* context.acp.cancel.pipe(Effect.ignore);
          const termination = yield* terminateProcessGroup(context.identity, { graceMs: 3_000 });
          if (
            termination.status === "termination_failed" ||
            termination.status === "unsupported_platform"
          ) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail:
                termination.status === "termination_failed"
                  ? termination.detail
                  : "Kiro process-group termination is unsupported on this platform.",
            });
          }
          const released = yield* releaseWorkspaceLease(context);
          if (!released) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: "Kiro workspace lease release failed its ownership-generation fence.",
            });
          }
          yield* closeSession(context, "graceful", false);
        }),
      );

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns }));

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Kiro ACP sessions do not support provider-side rollback.",
        });
      });

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });
    const stopAll = () =>
      Effect.forEach(
        Array.from(sessions.keys()),
        (threadId) => stopSession(threadId).pipe(Effect.asVoid),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.andThen(PubSub.shutdown(events)),
        Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
