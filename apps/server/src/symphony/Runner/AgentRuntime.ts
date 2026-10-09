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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { resolveSpawnCommand } from "@neokod/shared/shell";
import { expandHomePath } from "../../pathExpansion.ts";
import { WORKFLOW_DEFAULTS } from "../Workflow/Config.ts";
import { buildCodexInitializeParams } from "../../provider/Layers/CodexProvider.ts";
import { buildRunPrompt, type ReviewFeedbackContext } from "./Prompt.ts";
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

/** `turn/interrupt` must not block cancel on a hung or dead child. */
export const INTERRUPT_REQUEST_TIMEOUT = Duration.seconds(5);

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
    /** Agent-facing Markdown body from WORKFLOW.md. Sent on the first turn of
     * each dispatch and omitted from continuation turns in the same thread. */
    readonly workflowInstructions?: string;
    /** Review context for a post-review continuation dispatch (plan
     * FR-102-104). Only meaningful on the first turn of a dispatch — it
     * rides in the rendered prompt, so it is never re-sent on later
     * continuation turns within the same live thread (SPEC 8.2). */
    readonly reviewFeedback?: ReviewFeedbackContext;
  }) => Effect.Effect<AgentTurnResult, AgentRuntimeSpawnError, Scope.Scope>;

  readonly interrupt: () => Effect.Effect<void, never, never>;

  /** The spawned app-server child PID, or null before the process is up. */
  readonly pid: () => Effect.Effect<number | null, never, never>;
}

export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "neokod/symphony/Runner/AgentRuntime",
) {}

/**
 * SPEC 15.3 env scrubbing (audit item 8 lane F): strip the tracker/credential
 * secret names from the inherited environment before it reaches the agent
 * child. Exported for tests.
 */
export const scrubEnvironment = (
  env: NodeJS.ProcessEnv,
  secretNames: ReadonlyArray<string>,
): NodeJS.ProcessEnv => {
  const secrets = new Set(secretNames);
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!secrets.has(key)) {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
};

/** The only place Symphony's decision vocabulary meets Codex's wire enum. */
export const toCodexApprovalDecision = (
  decision: ApprovalDecision,
): EffectCodexSchema.CommandExecutionRequestApprovalResponse["decision"] &
  EffectCodexSchema.FileChangeRequestApprovalResponse["decision"] =>
  decision === "approved" ? "accept" : "decline";

export const toCodexUserInputResponse = (
  questions: unknown,
  text: string,
): EffectCodexSchema.ToolRequestUserInputResponse => ({
  answers: Object.fromEntries(
    (Array.isArray(questions) ? questions : []).flatMap((question) =>
      typeof question === "object" &&
      question !== null &&
      typeof (question as { id?: unknown }).id === "string"
        ? [[(question as { id: string }).id, { answers: [text] }] as const]
        : [],
    ),
  ),
});

export interface AgentRuntimeDeps {
  readonly codexCommand: string;
  readonly codexHomePath: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** Environment names that MUST NOT reach the agent child (SPEC 15.3;
   * audit item 8 lane F — tracker secrets used to flow wholesale). */
  readonly secretEnvironmentNames?: ReadonlyArray<string> | null;
  readonly liveRequests: LiveRequestsService;
  /** Called once, right after the app-server child is spawned, with its pid. Failures are ignored. */
  readonly onChildSpawned?: (pid: number) => Effect.Effect<void>;
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
    let requestConsumerStarted = false;

    const spawnAppServer = Effect.gen(function* () {
      if (deps.secretEnvironmentNames === null) {
        return yield* Effect.fail(
          new AgentRuntimeSpawnError(
            "tracker credentials could not be resolved, so the agent environment cannot be scrubbed; fix the tracker configuration and retry",
          ),
        );
      }
      // SPEC 15.3 env scrubbing (audit item 8 lane F): the agent child must
      // not see tracker/credential secrets. Remove every name the adapters
      // flagged from the inherited environment.
      const scrubbed = scrubEnvironment(deps.env, deps.secretEnvironmentNames ?? []);
      // `env` is the complete child environment. `extendEnv: true` would merge `process.env` back in and undo the scrub.
      const env = {
        ...scrubbed,
        ...(deps.codexHomePath ? { CODEX_HOME: expandHomePath(deps.codexHomePath) } : {}),
      };
      const spawnCommand = yield* resolveSpawnCommand(deps.codexCommand, ["app-server"], {
        env,
        extendEnv: false,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: deps.env.PWD,
            env,
            extendEnv: false,
            forceKillAfter: Duration.seconds(10),
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => new AgentRuntimeSpawnError(String(cause))),
        );
      activePid = Number(child.pid);
      if (deps.onChildSpawned !== undefined) {
        yield* deps.onChildSpawned(activePid).pipe(Effect.catch(() => Effect.void));
      }
      const clientContext = yield* CodexClient.layerChildProcess(child, { rawStreams: true }).pipe(
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

        if (!requestConsumerStarted) {
          requestConsumerStarted = true;
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
        }

        if (threadId === undefined) {
          const thread = yield* client
            .request("thread/start", {
              cwd: input.workspacePath,
              ...(input.config.agentModel !== undefined ? { model: input.config.agentModel } : {}),
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
            branch: input.branch,
            ...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
            ...(input.workflowInstructions !== undefined
              ? { workflowInstructions: input.workflowInstructions }
              : {}),
            ...(input.reviewFeedback !== undefined ? { reviewFeedback: input.reviewFeedback } : {}),
          });
        const turn = yield* client
          .request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
            cwd: input.workspacePath,
            approvalPolicy: policy.approvalPolicy,
            approvalsReviewer: policy.reviewer,
            sandboxPolicy: policy.turnSandboxPolicy,
            ...(input.config.agentModel !== undefined ? { model: input.config.agentModel } : {}),
          })
          .pipe(Effect.mapError((cause) => new AgentRuntimeSpawnError(cause.message)));
        turnId = (turn as { readonly turn: { readonly id: string } }).turn.id;

        const activeThreadId = threadId;
        const activeTurnId = turnId;
        const completed = yield* waitForTurnCompletion(client, input.config, {
          threadId: activeThreadId,
          turnId: activeTurnId,
        });

        return {
          turnId: activeTurnId,
          threadId: activeThreadId,
          completed,
        } satisfies AgentTurnResult;
      });

    const interrupt: AgentRuntimeService["interrupt"] = () =>
      Effect.gen(function* () {
        if (activeClient && threadId && turnId) {
          yield* activeClient.request("turn/interrupt", { threadId, turnId }).pipe(
            Effect.timeoutOption(INTERRUPT_REQUEST_TIMEOUT),
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          );
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

const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  CodexRpc.SERVER_REQUEST_METHODS["item/commandExecution/requestApproval"],
  CodexRpc.SERVER_REQUEST_METHODS["item/fileChange/requestApproval"],
]);
const isApprovalRequest = (method: string): boolean => APPROVAL_METHODS.has(method);

const isUserInputRequest = (method: string): boolean =>
  method === CodexRpc.SERVER_REQUEST_METHODS["item/tool/requestUserInput"];

const consumeIncoming = (
  client: CodexClientService,
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  liveRequests: LiveRequestsService,
  recordRequest: AgentRuntimeDeps["recordRequest"],
  config: EffectiveWorkflowConfig,
): Effect.Effect<void, never, never> =>
  Stream.runForEach(client.raw.requests, (request) =>
    handleRequest(client, request, runAttemptId, workItemId, liveRequests, recordRequest, config),
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
    const waitTimeoutMs =
      config.liveRequestsWaitTimeoutMs ?? WORKFLOW_DEFAULTS.liveRequestsWaitTimeoutMs;
    if (isApprovalRequest(request.method)) {
      const requestId = String(params.requestId ?? params.approvalId ?? request.id);
      const action = String(params.kind ?? request.method.split("/").at(-2) ?? "action");
      const command = typeof params.command === "string" ? params.command : undefined;
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
      yield* (
        recordRequest?.({
          requestId,
          workItemId,
          runAttemptId,
          action,
          ...(command !== undefined ? { command } : {}),
        }).pipe(Effect.catch(() => Effect.void)) ?? Effect.void
      );
      const decision = yield* waitWithTimeout(deferred, Duration.millis(waitTimeoutMs)).pipe(
        Effect.catch(() => Effect.succeed("rejected" as ApprovalDecision)),
      );
      yield* client.raw
        .respond(request.id, { decision: toCodexApprovalDecision(decision) })
        .pipe(Effect.catch(() => Effect.void));
    } else if (isUserInputRequest(request.method)) {
      const requestId = String(params.requestId ?? request.id);
      const promptText =
        typeof params.prompt === "string"
          ? params.prompt
          : `The agent needs your input for ${request.method}.`;
      const deferred = yield* liveRequests
        .registerUserInput({
          requestId,
          workItemId,
          runAttemptId,
          prompt: promptText,
        })
        .pipe(Effect.catch(() => Effect.never as Effect.Effect<Deferred.Deferred<string>>));
      yield* (
        recordRequest?.({
          requestId,
          workItemId,
          runAttemptId,
          action: "user_input",
        }).pipe(Effect.catch(() => Effect.void)) ?? Effect.void
      );
      const answer = yield* waitWithTimeout(deferred, Duration.millis(waitTimeoutMs)).pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      yield* client.raw
        .respond(request.id, toCodexUserInputResponse(params.questions, answer))
        .pipe(Effect.catch(() => Effect.void));
    } else {
      yield* client.raw
        .respondError(
          request.id,
          CodexErrors.CodexAppServerRequestError.methodNotFound(request.method),
        )
        .pipe(Effect.catch(() => Effect.void));
    }
  });

export interface PinnedTurn {
  readonly threadId: string;
  readonly turnId: string;
}
export type TurnSignal =
  | { readonly _tag: "completed" }
  | { readonly _tag: "failed"; readonly message: string };

export const classifyTurnNotification = (
  notification: { readonly method: string; readonly params?: unknown },
  pinned: PinnedTurn,
): TurnSignal | null => {
  const params = (notification.params ?? {}) as Record<string, unknown>;
  if (notification.method === "turn/completed") {
    const turn = (params.turn ?? {}) as {
      id?: unknown;
      status?: unknown;
      error?: { message?: unknown } | null;
    };
    if (params.threadId !== pinned.threadId || turn.id !== pinned.turnId) return null;
    if (turn.status === "completed") return { _tag: "completed" };
    if (turn.status === "failed") {
      return {
        _tag: "failed",
        message: typeof turn.error?.message === "string" ? turn.error.message : "Codex turn failed",
      };
    }
    if (turn.status === "interrupted")
      return { _tag: "failed", message: "Codex turn was interrupted" };
    return null; // inProgress or unknown: keep waiting
  }
  if (notification.method === "error") {
    if (params.willRetry === true) return null;
    if (typeof params.threadId === "string" && params.threadId !== pinned.threadId) return null;
    if (typeof params.turnId === "string" && params.turnId !== pinned.turnId) return null;
    const error = params.error as { message?: unknown } | undefined;
    return {
      _tag: "failed",
      message:
        typeof error?.message === "string" ? error.message : "Codex app-server reported an error",
    };
  }
  return null;
};

export const waitForTurnCompletion = (
  client: CodexClientService,
  config: EffectiveWorkflowConfig,
  pinned: PinnedTurn,
): Effect.Effect<boolean, AgentRuntimeSpawnError> =>
  Effect.gen(function* () {
    const timeout = Duration.millis(
      config.codexTurnTimeoutMs ?? WORKFLOW_DEFAULTS.codexTurnTimeoutMs,
    );
    const outcome = yield* Deferred.make<boolean, AgentRuntimeSpawnError>();
    const pump = yield* Stream.runForEach(client.raw.notifications, (notification) => {
      const signal = classifyTurnNotification(notification, pinned);
      if (signal === null) return Effect.void;
      return (
        signal._tag === "completed"
          ? Deferred.succeed(outcome, true)
          : Deferred.fail(outcome, new AgentRuntimeSpawnError(signal.message))
      ).pipe(Effect.asVoid);
    }).pipe(
      // The stream completes when the app-server connection ends (step 2).
      Effect.andThen(
        Deferred.fail(
          outcome,
          new AgentRuntimeSpawnError("Codex app-server exited before the turn finished"),
        ),
      ),
      Effect.catch(() => Effect.void),
      Effect.forkChild,
    );
    return yield* Deferred.await(outcome).pipe(
      Effect.timeoutOption(timeout),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentRuntimeSpawnError("turn timed out")),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.ensuring(Fiber.interrupt(pump)),
    );
  });

const waitWithTimeout = <A>(
  deferred: Deferred.Deferred<A>,
  duration: Duration.Duration,
): Effect.Effect<A, AgentRuntimeSpawnError> =>
  Deferred.await(deferred).pipe(
    Effect.timeoutOption(duration),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () => Effect.fail(new AgentRuntimeSpawnError("request timed out")),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  );
