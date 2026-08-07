import type {
  EffectiveWorkflowConfig,
  NormalizedIssue,
  RunAttemptId,
  WorkItemId,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as CodexClient from "effect-codex-app-server/client";

import { resolveSpawnCommand } from "@neokod/shared/shell";
import { expandHomePath } from "../../pathExpansion.ts";
import { buildCodexInitializeParams } from "../../provider/Layers/CodexProvider.ts";
import { buildRunPrompt } from "./Prompt.ts";
import { resolveRunnerPolicy } from "./Policy.ts";
import { type ApprovalDecision, type LiveRequestsService } from "./LiveRequests.ts";

/**
 * Agent runtime (WS-J, SPEC 10.1 to 10.5).
 *
 * Per work item, the runner spawns `codex app-server` in the workspace path,
 * completes the initialize handshake, opens a thread, and starts a turn with
 * the rendered prompt. Continuation turns reuse the same live thread. All
 * approval and user-input requests are blocking JSON-RPC requests answered
 * through the LiveRequests registry (plan 8.3.1). Raw protocol handling keeps
 * the runtime resilient to schema-drift in the generated protocol.
 */

type CodexClientService = CodexClient.CodexAppServerClient["Service"];

export class AgentRuntimeSpawnError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Failed to spawn Codex app-server: ${detail}`);
    this.name = "AgentRuntimeSpawnError";
    this.detail = detail;
  }
}

export interface AgentTurnResult {
  readonly turnId: string;
  readonly threadId: string;
  readonly completed: boolean;
}

export interface AgentRuntimeService {
  readonly runTurn: (input: {
    readonly issue: NormalizedIssue;
    readonly config: EffectiveWorkflowConfig;
    readonly workspacePath: string;
    readonly branch: string;
    readonly runAttemptId: RunAttemptId;
    readonly workItemId: WorkItemId;
    readonly prompt?: string;
    readonly continuation?: boolean;
  }) => Effect.Effect<AgentTurnResult, AgentRuntimeSpawnError, Scope.Scope>;

  readonly interrupt: () => Effect.Effect<void, never, never>;

  /** The spawned app-server child PID, or null before the process is up. */
  readonly pid: () => Effect.Effect<number | null, never, never>;
}

export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "neokod/symphony/Runner/AgentRuntime",
) {}

export interface AgentRuntimeDeps {
  readonly codexCommand: string;
  readonly codexHomePath: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly liveRequests: LiveRequestsService;
  /** Durable request record (WS-J2); best-effort, never blocks the agent. */
  readonly recordRequest?: (input: {
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
    readonly action: string;
    readonly command?: string;
  }) => Effect.Effect<void>;
}

export const makeCodexAgentRuntime = (
  deps: AgentRuntimeDeps,
): Effect.Effect<
  AgentRuntimeService,
  AgentRuntimeSpawnError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { liveRequests, recordRequest } = deps;

    let activeClient: CodexClientService | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let activePid: number | null = null;

    const spawnAppServer = Effect.gen(function* () {
      const env = {
        ...deps.env,
        ...(deps.codexHomePath ? { CODEX_HOME: expandHomePath(deps.codexHomePath) } : {}),
      };
      const spawnCommand = yield* resolveSpawnCommand(deps.codexCommand, ["app-server"], {
        env,
        extendEnv: true,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: deps.env.PWD,
            env,
            extendEnv: true,
            forceKillAfter: Duration.seconds(10),
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => new AgentRuntimeSpawnError(String(cause))),
        );
      activePid = Number(child.pid);
      const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
        Layer.build,
        Effect.provideService(Scope.Scope, scope),
      );
      return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
    });

    const initialize = Effect.gen(function* () {
      const client = yield* spawnAppServer;
      yield* client
        .request("initialize", buildCodexInitializeParams())
        .pipe(Effect.mapError((cause) => new AgentRuntimeSpawnError(cause.message)));
      yield* client
        .notify("initialized", undefined)
        .pipe(Effect.mapError((cause) => new AgentRuntimeSpawnError(cause.message)));
      activeClient = client;
      return client;
    });

    const runTurn: AgentRuntimeService["runTurn"] = (input) =>
      Effect.gen(function* () {
        const client = activeClient ?? (yield* initialize);
        const policy = resolveRunnerPolicy(input.config);

        if (threadId === undefined) {
          const thread = yield* client
            .request("thread/start", {
              cwd: input.workspacePath,
              approvalPolicy: policy.approvalPolicy,
              sandbox: policy.threadSandbox,
              approvalsReviewer: policy.reviewer,
            })
            .pipe(Effect.mapError((cause) => new AgentRuntimeSpawnError(cause.message)));
          threadId = (thread as { readonly thread: { readonly id: string } }).thread.id;
        }

        const prompt =
          input.prompt ??
          buildRunPrompt({
            issue: input.issue,
            config: input.config,
            ...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
          });
        const turn = yield* client
          .request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
            cwd: input.workspacePath,
            approvalPolicy: policy.approvalPolicy,
            approvalsReviewer: policy.reviewer,
            sandboxPolicy: policy.turnSandboxPolicy,
          })
          .pipe(Effect.mapError((cause) => new AgentRuntimeSpawnError(cause.message)));
        turnId = (turn as { readonly turn: { readonly id: string } }).turn.id;

        yield* Effect.forkScoped(
          consumeIncoming(
            client,
            input.runAttemptId,
            input.workItemId,
            liveRequests,
            recordRequest,
            input.config,
          ),
        );

        const completed = yield* waitForTurnCompletion(client, input.config);

        return { turnId, threadId, completed } satisfies AgentTurnResult;
      });

    const interrupt: AgentRuntimeService["interrupt"] = () =>
      Effect.gen(function* () {
        if (activeClient && threadId && turnId) {
          yield* activeClient
            .request("turn/interrupt", { threadId, turnId })
            .pipe(Effect.catch(() => Effect.void));
        }
      });

    const pid: AgentRuntimeService["pid"] = () => Effect.sync(() => activePid);

    return { runTurn, interrupt, pid };
  });

interface IncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

const isApprovalRequest = (method: string): boolean => method.endsWith("/requestApproval");

const isUserInputRequest = (method: string): boolean => method.endsWith("/requestUserInput");

const consumeIncoming = (
  client: CodexClientService,
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  liveRequests: LiveRequestsService,
  recordRequest: AgentRuntimeDeps["recordRequest"],
  config: EffectiveWorkflowConfig,
): Effect.Effect<void, never, never> =>
  Stream.runDrain(
    Stream.map(client.raw.requests, (request) =>
      handleRequest(client, request, runAttemptId, workItemId, liveRequests, recordRequest, config),
    ),
  ).pipe(
    Effect.catch(() => Effect.void),
    Effect.interruptible,
  );

const handleRequest = (
  client: CodexClientService,
  request: IncomingRequest,
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  liveRequests: LiveRequestsService,
  recordRequest: AgentRuntimeDeps["recordRequest"],
  config: EffectiveWorkflowConfig,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const waitTimeoutMs = config.liveRequestsWaitTimeoutMs ?? 1_800_000;
    if (isApprovalRequest(request.method)) {
      const requestId = String(params.requestId ?? params.approvalId ?? request.id);
      const action = String(params.kind ?? request.method.split("/").at(-2) ?? "action");
      const command = typeof params.command === "string" ? params.command : undefined;
      yield* (
        recordRequest?.({
          requestId,
          workItemId,
          runAttemptId,
          action,
          ...(command !== undefined ? { command } : {}),
        }).pipe(Effect.catch(() => Effect.void)) ?? Effect.void
      );
      const deferred = yield* liveRequests
        .registerApproval({
          requestId,
          workItemId,
          runAttemptId,
          action,
          prompt: command ?? `The agent requests approval for ${request.method}.`,
        })
        .pipe(
          Effect.catch(() => Effect.never as Effect.Effect<Deferred.Deferred<ApprovalDecision>>),
        );
      const decision = yield* waitWithTimeout(deferred, Duration.millis(waitTimeoutMs)).pipe(
        Effect.catch(() => Effect.succeed("rejected" as ApprovalDecision)),
      );
      yield* client.raw.respond(request.id, { decision }).pipe(Effect.catch(() => Effect.void));
    } else if (isUserInputRequest(request.method)) {
      const requestId = String(params.requestId ?? request.id);
      const promptText =
        typeof params.prompt === "string"
          ? params.prompt
          : `The agent needs your input for ${request.method}.`;
      yield* (
        recordRequest?.({
          requestId,
          workItemId,
          runAttemptId,
          action: "user_input",
        }).pipe(Effect.catch(() => Effect.void)) ?? Effect.void
      );
      const deferred = yield* liveRequests
        .registerUserInput({
          requestId,
          workItemId,
          runAttemptId,
          prompt: promptText,
        })
        .pipe(Effect.catch(() => Effect.never as Effect.Effect<Deferred.Deferred<string>>));
      const answer = yield* waitWithTimeout(deferred, Duration.millis(waitTimeoutMs)).pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      yield* client.raw.respond(request.id, { text: answer }).pipe(Effect.catch(() => Effect.void));
    } else {
      yield* client.raw.respond(request.id, {}).pipe(Effect.catch(() => Effect.void));
    }
  });

const waitForTurnCompletion = (
  client: CodexClientService,
  config: EffectiveWorkflowConfig,
): Effect.Effect<boolean, AgentRuntimeSpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const timeout = Duration.millis(config.codexTurnTimeoutMs ?? 3_600_000);
    const waitDeferred = yield* Deferred.make<boolean>();
    yield* Effect.forkScoped(
      Stream.runDrain(
        Stream.map(client.raw.notifications, (notification) => {
          if (notification.method === "turn/completed") {
            return Deferred.succeed(waitDeferred, true).pipe(Effect.asVoid);
          }
          if (notification.method === "error") {
            return Deferred.succeed(waitDeferred, false).pipe(Effect.asVoid);
          }
          return Effect.void;
        }),
      ).pipe(Effect.catch(() => Effect.void)),
    );
    return yield* Deferred.await(waitDeferred).pipe(
      Effect.timeoutOption(timeout),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () => Effect.fail(new AgentRuntimeSpawnError("turn timed out")),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
  });

const waitWithTimeout = <A>(
  deferred: Deferred.Deferred<A>,
  duration: Duration.Duration,
): Effect.Effect<A, Error> =>
  Deferred.await(deferred).pipe(
    Effect.timeoutOption(duration),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () => Effect.fail(new Error("request timed out")),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  );
