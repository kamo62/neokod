/**
 * Fake Codex app-server peer for Symphony runner tests.
 *
 * Drives `makeCodexAgentRuntime` through the real Codex client without a
 * child process. The harness plugs in at the `ChildProcessSpawner` seam:
 * the spawner returns a handle whose stdin decodes client JSONL and whose
 * stdout carries scripted server messages.
 *
 * Test-only. Production code stays untouched.
 */
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";

import { HostProcessPlatform } from "@neokod/shared/hostProcess";

import {
  makeCodexAgentRuntime,
  type AgentRuntimeDeps,
  type AgentRuntimeService,
} from "../AgentRuntime.ts";
import { ApprovalService } from "../ApprovalService.ts";
import type { LiveRequestsService } from "../LiveRequests.ts";
import { LiveRequests } from "../LiveRequests.ts";
import { AgentRuntimeFactory } from "../Dispatcher.ts";

export interface JsonRpcMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface FakeCodexPeerOptions {
  readonly pid?: number;
  readonly threadId?: string;
  readonly turnIds?: ReadonlyArray<string>;
  readonly unanswered?: ReadonlyArray<string>;
}

export interface CommandApprovalParams {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly command?: string;
  readonly cwd?: string;
}

export interface FakeCodexPeer {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly threadId: string;
  readonly currentTurnId: Effect.Effect<string>;
  readonly received: Effect.Effect<ReadonlyArray<JsonRpcMessage>>;
  readonly spawnCount: Effect.Effect<number>;
  readonly awaitClientRequest: (method: string) => Effect.Effect<JsonRpcMessage>;
  readonly awaitClientResponse: (id: string | number) => Effect.Effect<JsonRpcMessage>;
  readonly reply: (id: string | number, result: unknown) => Effect.Effect<void>;
  readonly replyError: (id: string | number, code: number, message: string) => Effect.Effect<void>;
  readonly sendNotification: (method: string, params?: unknown) => Effect.Effect<void>;
  readonly sendRequest: (method: string, params?: unknown) => Effect.Effect<number>;
  readonly sendCommandApproval: (params?: Partial<CommandApprovalParams>) => Effect.Effect<number>;
  readonly sendUserInputRequest: (
    questions: ReadonlyArray<{ id: string; question: string }>,
  ) => Effect.Effect<number>;
  readonly completeTurn: (
    status: "completed" | "failed" | "interrupted",
    options?: {
      readonly error?: string;
      readonly threadId?: string;
      readonly turnId?: string;
    },
  ) => Effect.Effect<void>;
  readonly sendError: (
    message: string,
    options?: { readonly willRetry?: boolean },
  ) => Effect.Effect<void>;
  readonly closeStdout: Effect.Effect<void>;
  readonly crash: (exitCode?: number) => Effect.Effect<void>;
}

const encodeJsonLine = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJsonLine = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const encodeJsonl = (message: unknown): Uint8Array =>
  new TextEncoder().encode(`${encodeJsonLine(message)}\n`);

export const makeFakeCodexPeer = (
  options: FakeCodexPeerOptions = {},
): Effect.Effect<FakeCodexPeer> =>
  Effect.gen(function* () {
    const threadId = options.threadId ?? "thread-1";
    const unanswered = new Set(options.unanswered ?? []);
    const stdoutQueue = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
    const clientMessages = yield* Queue.unbounded<JsonRpcMessage>();
    const received = yield* Ref.make<ReadonlyArray<JsonRpcMessage>>([]);
    const exitSignal = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const turnCount = yield* Ref.make(0);
    const currentTurnId = yield* Ref.make("turn-1");
    const requestIdCounter = yield* Ref.make(0);
    const spawnCount = yield* Ref.make(0);
    const remainder = yield* Ref.make("");

    const writeLine = (message: unknown) => Queue.offer(stdoutQueue, encodeJsonl(message));

    const nextTurnId = Effect.gen(function* () {
      const n = yield* Ref.getAndUpdate(turnCount, (count) => count + 1);
      const id = options.turnIds?.[n] ?? `turn-${n + 1}`;
      yield* Ref.set(currentTurnId, id);
      return id;
    });

    const answerBuiltIn = (message: JsonRpcMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.method === undefined || message.id === undefined) return;
        if (unanswered.has(message.method)) return;
        switch (message.method) {
          case "initialize":
            yield* writeLine({
              id: message.id,
              result: {
                userAgent: "fake-codex-app-server",
                codexHome: "/tmp/fake-codex",
                platformFamily: "unix",
                platformOs: "macos",
              },
            });
            break;
          case "thread/start": {
            yield* writeLine({
              id: message.id,
              result: {
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
                cwd: "/tmp/fake-ws",
                model: "fake-model",
                modelProvider: "fake",
                sandbox: { type: "workspaceWrite" },
                thread: {
                  cliVersion: "0.0.0",
                  createdAt: 0,
                  cwd: "/tmp/fake-ws",
                  ephemeral: false,
                  id: threadId,
                  modelProvider: "fake",
                  preview: "",
                  sessionId: "session-1",
                  source: "appServer",
                  status: { type: "idle" },
                  turns: [],
                  updatedAt: 0,
                },
              },
            });
            break;
          }
          case "turn/start": {
            const id = yield* nextTurnId;
            yield* writeLine({
              id: message.id,
              result: { turn: { id, items: [], status: "inProgress" } },
            });
            break;
          }
          case "turn/interrupt":
            yield* writeLine({ id: message.id, result: {} });
            break;
          default:
            break;
        }
      });

    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        const text = new TextDecoder().decode(chunk);
        const buffered = (yield* Ref.get(remainder)) + text;
        const parts = buffered.split("\n");
        yield* Ref.set(remainder, parts.pop() ?? "");
        for (const line of parts) {
          if (line.trim().length === 0) continue;
          const message = (yield* decodeJsonLine(line).pipe(Effect.orDie)) as JsonRpcMessage;
          yield* Ref.update(received, (messages) => [...messages, message]);
          yield* Queue.offer(clientMessages, message);
          yield* answerBuiltIn(message);
        }
      }),
    );

    // End-of-stream (not shutdown) models stdout EOF: bytes already
    // written are still delivered before the stream completes, while the
    // exit code stays pending until `crash`.
    const stdout = Stream.fromQueue(stdoutQueue);

    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(options.pid ?? 4242),
      exitCode: Deferred.await(exitSignal),
      isRunning: Deferred.isDone(exitSignal).pipe(Effect.map((done) => !done)),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin,
      stdout,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

    const spawner = ChildProcessSpawner.make(() =>
      Ref.update(spawnCount, (count) => count + 1).pipe(Effect.as(handle)),
    );

    const sendRequest = (method: string, params?: unknown): Effect.Effect<number> =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(requestIdCounter, (count) => count + 1);
        yield* writeLine(params === undefined ? { id, method } : { id, method, params }).pipe(
          Effect.asVoid,
        );
        return id;
      });

    const awaitClientRequest = (method: string): Effect.Effect<JsonRpcMessage> =>
      Queue.take(clientMessages).pipe(
        Effect.flatMap((message) =>
          message.method === method ? Effect.succeed(message) : awaitClientRequest(method),
        ),
      );

    const awaitClientResponse = (id: string | number): Effect.Effect<JsonRpcMessage> =>
      Queue.take(clientMessages).pipe(
        Effect.flatMap((message) =>
          message.id === id ? Effect.succeed(message) : awaitClientResponse(id),
        ),
      );

    return {
      spawner,
      threadId,
      currentTurnId: Ref.get(currentTurnId),
      received: Ref.get(received),
      spawnCount: Ref.get(spawnCount),
      awaitClientRequest,
      awaitClientResponse,
      reply: (id, result) => writeLine({ id, result }).pipe(Effect.asVoid),
      replyError: (id, code, message) =>
        writeLine({ id, error: { code, message } }).pipe(Effect.asVoid),
      sendNotification: (method, params) =>
        writeLine(params === undefined ? { method } : { method, params }).pipe(Effect.asVoid),
      sendRequest,
      sendCommandApproval: (params) =>
        Effect.gen(function* () {
          const turnId = yield* Ref.get(currentTurnId);
          return yield* sendRequest("item/commandExecution/requestApproval", {
            threadId,
            turnId,
            itemId: "item-1",
            command: "echo hi",
            cwd: "/tmp/fake-ws",
            ...params,
          });
        }),
      sendUserInputRequest: (questions) =>
        Effect.gen(function* () {
          const turnId = yield* Ref.get(currentTurnId);
          return yield* sendRequest("item/tool/requestUserInput", {
            threadId,
            turnId,
            itemId: "item-2",
            questions: questions.map((q) => ({ header: q.id, id: q.id, question: q.question })),
          });
        }),
      completeTurn: (status, turnOptions) =>
        Effect.gen(function* () {
          const turnId = turnOptions?.turnId ?? (yield* Ref.get(currentTurnId));
          const completedThreadId = turnOptions?.threadId ?? threadId;
          yield* writeLine({
            method: "turn/completed",
            params: {
              threadId: completedThreadId,
              turn: {
                id: turnId,
                items: [],
                status,
                ...(turnOptions?.error !== undefined
                  ? { error: { message: turnOptions.error } }
                  : {}),
              },
            },
          }).pipe(Effect.asVoid);
        }),
      sendError: (message, errorOptions) =>
        Effect.gen(function* () {
          const turnId = yield* Ref.get(currentTurnId);
          yield* writeLine({
            method: "error",
            params: {
              error: { message },
              threadId,
              turnId,
              willRetry: errorOptions?.willRetry ?? false,
            },
          }).pipe(Effect.asVoid);
        }),
      closeStdout: Queue.end(stdoutQueue),
      crash: (exitCode = 1) =>
        Queue.end(stdoutQueue).pipe(
          Effect.andThen(Deferred.succeed(exitSignal, ChildProcessSpawner.ExitCode(exitCode))),
          Effect.asVoid,
        ),
    } satisfies FakeCodexPeer;
  });

export const makeFakeCodexRuntime = (input: {
  readonly peer: FakeCodexPeer;
  readonly liveRequests: LiveRequestsService;
  readonly recordRequest?: AgentRuntimeDeps["recordRequest"];
  readonly secretEnvironmentNames?: ReadonlyArray<string>;
}): Effect.Effect<AgentRuntimeService, never, Scope.Scope> =>
  makeCodexAgentRuntime({
    codexCommand: "fake-codex",
    codexHomePath: undefined,
    env: {},
    liveRequests: input.liveRequests,
    ...(input.recordRequest !== undefined ? { recordRequest: input.recordRequest } : {}),
    ...(input.secretEnvironmentNames !== undefined
      ? { secretEnvironmentNames: input.secretEnvironmentNames }
      : {}),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.peer.spawner),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.orDie,
  );

export const fakeCodexRuntimeFactory = (
  nextPeer: () => FakeCodexPeer,
): Layer.Layer<AgentRuntimeFactory, never, LiveRequests | ApprovalService> =>
  Layer.effect(
    AgentRuntimeFactory,
    Effect.gen(function* () {
      const liveRequests = yield* LiveRequests;
      const approvalService = yield* ApprovalService;
      return {
        make: () =>
          makeFakeCodexRuntime({
            peer: nextPeer(),
            liveRequests,
            recordRequest: (recordInput) =>
              approvalService
                .recordPending({
                  id: recordInput.requestId,
                  requestId: recordInput.requestId,
                  workItemId: recordInput.workItemId,
                  runAttemptId: recordInput.runAttemptId,
                  action: recordInput.action,
                  scope: "once",
                  ...(recordInput.command !== undefined ? { command: recordInput.command } : {}),
                })
                .pipe(
                  Effect.asVoid,
                  Effect.catch(() => Effect.void),
                ),
          }),
      };
    }),
  );
