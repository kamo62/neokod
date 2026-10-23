import type {
  AcceptedGuidanceSnapshot,
  EffectiveWorkflowConfig,
  NormalizedIssue,
  ApprovalQuestion,
  ApprovalQuestionPayload,
  RunAttemptId,
  WorkItemId,
} from "@neokod/contracts";
import { ApprovalQuestionPayloadSchema } from "@neokod/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { resolveSpawnCommand } from "@neokod/shared/shell";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import {
  type ProcessGroupIdentity,
  captureProcessBirthToken,
  makeProvenGroupIdentity,
} from "@neokod/shared/processGroup";
import { expandHomePath } from "../../pathExpansion.ts";
import { questionIsSensitive } from "../Domain/Approvals.ts";
import { WORKFLOW_DEFAULTS } from "../Workflow/Config.ts";
import { buildCodexInitializeParams } from "../../provider/Layers/CodexProvider.ts";
import { narrowAcceptedPermissions, resolveAcceptedPermissions } from "./AcceptedGuidance.ts";
import { buildRunPrompt, type ReviewFeedbackContext } from "./Prompt.ts";
import { resolveRunnerPolicy, reviewerForPolicy } from "./Policy.ts";
import {
  type ApprovalDecision,
  type LiveRequestsService,
  answerMapProblems,
  type UserInputAnswers,
  LiveRequestAlreadyPendingError,
} from "./LiveRequests.ts";

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

/**
 * An accepted snapshot names a provider/model/repository that the live config
 * no longer matches. Continuing would silently retarget an accepted attempt, so
 * the runtime refuses instead.
 */
export class AgentRuntimeTargetMismatchError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Accepted guidance conflicts with the live run target: ${detail}`);
    this.name = "AgentRuntimeTargetMismatchError";
    this.detail = detail;
  }
}

/**
 * The accepted brief cannot be enforced against the current live policy
 * without re-enabling an approval path the accepted permission forbids.
 */
export class AgentRuntimePermissionConflictError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Accepted guidance permission cannot be enforced: ${detail}`);
    this.name = "AgentRuntimePermissionConflictError";
    this.detail = detail;
  }
}

export type AgentRuntimeRunError =
  | AgentRuntimeSpawnError
  | AgentRuntimeTargetMismatchError
  | AgentRuntimePermissionConflictError
  | AgentRuntimeChildOwnershipError
  | AgentRuntimeUnsupportedProviderError;

/**
 * The callback had positive knowledge of a spawned child but could not record
 * its ownership. The runtime treats this as fail-closed before provider use.
 */
/**
 * The runtime factory is a Codex app-server factory. It cannot substantiate any
 * other driver or instance; silently spawning Codex for a configured Claude or
 * other provider would misrepresent execution.
 */
export class AgentRuntimeUnsupportedProviderError extends Error {
  readonly driver: string;
  readonly instanceId: string;

  constructor(driver: string, instanceId: string) {
    super(
      `The Symphony agent runtime supports the default Codex provider (codex_default/codex), but the workflow selected ${instanceId}/${driver}`,
    );
    this.name = "AgentRuntimeUnsupportedProviderError";
    this.driver = driver;
    this.instanceId = instanceId;
  }
}

export class AgentRuntimeChildOwnershipError extends Error {
  readonly detail: string;
  /** Positively observed spawned child, when raised by the runtime. */
  readonly pid: number | undefined;
  readonly identity: ProcessGroupIdentity | undefined;

  constructor(detail: string, pid?: number, identity?: ProcessGroupIdentity) {
    super(`Failed to record agent child ownership: ${detail}`);
    this.name = "AgentRuntimeChildOwnershipError";
    this.detail = detail;
    this.pid = pid;
    this.identity = identity;
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
    /** Actual base branch of the workspace, distinct from the working branch. */
    readonly baseBranch?: string;
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
    /** Frozen accepted brief for this attempt. Supplying it makes the runtime
     * render that brief and enforce its narrowed permissions. */
    readonly acceptedGuidance?: AcceptedGuidanceSnapshot;
  }) => Effect.Effect<AgentTurnResult, AgentRuntimeRunError, Scope.Scope>;

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

export interface CodexUserInputResponse {
  readonly answers: Record<string, { readonly answers: ReadonlyArray<string> }>;
}

/**
 * Map independent answers onto Codex's per-question response. The caller must
 * pass answers validated against exactly these ids: this function never
 * duplicates one value under another question or invents a missing answer.
 */
export const toCodexUserInputResponse = (
  questionIds: ReadonlyArray<string>,
  answers: UserInputAnswers,
): CodexUserInputResponse => ({
  answers: Object.fromEntries(
    questionIds.flatMap((id) => {
      const value = answers[id];
      if (value === undefined) return [];
      return [[id, { answers: typeof value === "string" ? [value] : [...value] }] as const];
    }),
  ),
});

export interface AgentRequestRecordResult {
  readonly status:
    | "recorded"
    | "duplicate_pending"
    | "duplicate_decided"
    | "duplicate_mismatched"
    | "record_failed";
}

export interface AgentRuntimeDeps {
  readonly codexCommand: string;
  readonly codexHomePath: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** Environment names that MUST NOT reach the agent child (SPEC 15.3;
   * audit item 8 lane F — tracker secrets used to flow wholesale). */
  readonly secretEnvironmentNames?: ReadonlyArray<string> | null;
  readonly liveRequests: LiveRequestsService;
  /**
   * Called once, immediately after the app-server child is spawned, before the
   * Codex client is built.
   *
   * `identity` is present only when this spawn is demonstrably a detached POSIX
   * group leader (pid === pgid) *and* its OS birth token was captured. It is
   * absent on unsupported platforms or when identity cannot be proven, so a
   * caller must never infer a group id from the bare pid.
   *
   * A failure is fail-closed: the runtime logs the surviving child, releases
   * the scoped child resources and refuses further provider use.
   */
  readonly onChildSpawned?: (
    pid: number,
    identity?: ProcessGroupIdentity,
  ) => Effect.Effect<void, AgentRuntimeChildOwnershipError>;
  /** Durable request record (WS-J2); best-effort, never blocks the agent. */
  readonly recordRequest?: (input: {
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
    readonly action: string;
    readonly command?: string;
    /** The agent's question (user-input requests) or its stated reason (approvals). */
    readonly reason?: string;
    /** Preserved structured question shape for a user-input request. */
    readonly questionPayload?: ApprovalQuestionPayload;
  }) => Effect.Effect<AgentRequestRecordResult | void>;
  /**
   * The runtime's own wait elapsed. Competes for the request through the live
   * registry: returns `true` when this runtime won (the request is settled and
   * the agent gets its fallback answer) and `false` when a human answer claimed
   * it first (the runtime must then send that answer to the provider).
   * Best-effort: an implementation reports `true` when it cannot settle.
   */
  readonly requestTimedOut?: (input: {
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
  }) => Effect.Effect<boolean>;
  /**
   * The live request was settled by cancellation/run end (not a timeout).
   * Implementations close the durable row as interrupted for this exact
   * run/request only.
   */
  readonly requestSettled?: (input: {
    readonly requestId: string;
    readonly workItemId: WorkItemId;
    readonly runAttemptId: RunAttemptId;
  }) => Effect.Effect<void>;
}

const assertAcceptedTarget = (
  accepted: AcceptedGuidanceSnapshot,
  input: {
    readonly config: EffectiveWorkflowConfig;
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseBranch?: string;
  },
): Effect.Effect<void, AgentRuntimeTargetMismatchError> => {
  const mismatches: string[] = [];
  const target = accepted.target;
  const config = input.config;
  if (target.repositoryPath !== config.repositoryPath) {
    mismatches.push(`repository ${target.repositoryPath} != live ${config.repositoryPath}`);
  }
  if (target.workflowPath !== config.workflowPath) {
    mismatches.push(`workflow ${target.workflowPath} != live ${config.workflowPath}`);
  }
  if (target.workspacePath !== undefined && target.workspacePath !== input.workspacePath) {
    mismatches.push(`workspace ${target.workspacePath} != live ${input.workspacePath}`);
  }
  if (target.baseBranch !== undefined) {
    if (input.baseBranch === undefined) {
      mismatches.push(`base branch ${target.baseBranch} != live (not supplied)`);
    } else if (target.baseBranch !== input.baseBranch) {
      mismatches.push(`base branch ${target.baseBranch} != live ${input.baseBranch}`);
    }
  }
  if (
    target.provider.instanceId !== config.agentProvider.instanceId ||
    target.provider.driver !== config.agentProvider.driver
  ) {
    mismatches.push(
      `provider ${String(target.provider.instanceId)}/${String(target.provider.driver)} != live ${String(config.agentProvider.instanceId)}/${String(config.agentProvider.driver)}`,
    );
  }
  if (target.model !== config.agentModel) {
    mismatches.push(`model ${target.model ?? "(none)"} != live ${config.agentModel ?? "(none)"}`);
  }
  return mismatches.length === 0
    ? Effect.void
    : Effect.fail(new AgentRuntimeTargetMismatchError(mismatches.join("; ")));
};

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
    const { liveRequests, recordRequest, requestTimedOut, requestSettled } = deps;

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
      const platform = yield* HostProcessPlatform;
      const spawnDetached = platform !== "win32";
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: deps.env.PWD,
            env,
            extendEnv: false,
            // Explicit group leadership on POSIX. The platform spawner defaults
            // to detached there; being explicit keeps ownership recovery tied to
            // a fact this runtime requested rather than an inherited default.
            detached: spawnDetached,
            forceKillAfter: Duration.seconds(10),
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => new AgentRuntimeSpawnError(String(cause))),
        );
      const childPid = Number(child.pid);
      activePid = childPid;
      // A group identity is reported only for a detached POSIX leader whose
      // birth token was actually captured. A bare pid (or missing token) stays
      // unknown; recovery must fail closed rather than infer `pid === pgid`.
      const childIdentity = yield* Effect.gen(function* () {
        if (!spawnDetached || !Number.isSafeInteger(childPid) || childPid <= 0) return undefined;
        const spawnedAtMs = yield* Clock.currentTimeMillis;
        const birthToken = yield* captureProcessBirthToken(childPid);
        if (birthToken === null || birthToken.trim().length === 0) return undefined;
        const proven = makeProvenGroupIdentity({
          pid: childPid,
          pgid: childPid,
          spawnedAtMs,
          platform,
          birthToken,
        });
        return proven.ok ? proven.identity : undefined;
      });
      if (deps.onChildSpawned !== undefined) {
        yield* deps.onChildSpawned(childPid, childIdentity).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("symphony.agent.ownership_record_failed", {
              pid: childPid,
              pgid: childIdentity?.pgid ?? null,
              birthTokenCaptured: childIdentity !== undefined,
              cause,
            }),
          ),
          Effect.mapError(
            (cause) => new AgentRuntimeChildOwnershipError(cause.detail, childPid, childIdentity),
          ),
        );
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
        const provider = input.config.agentProvider;
        // This is the Codex app-server factory with the workflow's Codex
        // command/home. It cannot substantiate another driver or instance.
        if (
          String(provider.driver) !== "codex" ||
          String(provider.instanceId) !== "codex_default"
        ) {
          return yield* Effect.fail(
            new AgentRuntimeUnsupportedProviderError(
              String(provider.driver),
              String(provider.instanceId),
            ),
          );
        }
        const accepted = input.acceptedGuidance;
        if (accepted !== undefined) {
          // Refuse a retarget before spawning, opening a thread or touching an
          // existing client: an accepted attempt must never silently move to a
          // different provider, model, repository or workspace.
          yield* assertAcceptedTarget(accepted, input);
        }
        const livePolicy = resolveRunnerPolicy(input.config);
        const narrowedPermission =
          accepted === undefined
            ? undefined
            : narrowAcceptedPermissions(
                accepted.permission,
                resolveAcceptedPermissions(input.config),
              );
        if (narrowedPermission?._tag === "unrepresentable") {
          return yield* Effect.fail(
            new AgentRuntimePermissionConflictError(
              `${narrowedPermission.reason}: accepted ${narrowedPermission.acceptedApprovalPolicy} vs live ${narrowedPermission.liveApprovalPolicy}`,
            ),
          );
        }
        const acceptedForPrompt =
          accepted === undefined || narrowedPermission === undefined
            ? undefined
            : { ...accepted, permission: narrowedPermission.permission };
        const effectivePolicy =
          narrowedPermission === undefined
            ? livePolicy
            : {
                approvalPolicy: narrowedPermission.permission.approvalPolicy,
                threadSandbox: narrowedPermission.permission.threadSandbox,
                turnSandboxPolicy: narrowedPermission.permission.turnSandboxPolicy,
                reviewer: reviewerForPolicy(
                  narrowedPermission.permission.approvalPolicy,
                  narrowedPermission.permission.turnSandboxPolicy,
                ),
                editsAllowed: narrowedPermission.permission.editsAllowed,
                approvalsEnabled: narrowedPermission.permission.approvalsEnabled,
              };
        const client = activeClient ?? (yield* initialize);

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
              requestTimedOut,
              requestSettled,
            ),
          );
        }

        if (threadId === undefined) {
          const thread = yield* client
            .request("thread/start", {
              cwd: input.workspacePath,
              ...(input.config.agentModel !== undefined ? { model: input.config.agentModel } : {}),
              approvalPolicy: effectivePolicy.approvalPolicy,
              sandbox: effectivePolicy.threadSandbox,
              approvalsReviewer: effectivePolicy.reviewer,
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
            ...(acceptedForPrompt !== undefined ? { acceptedGuidance: acceptedForPrompt } : {}),
          });
        const turn = yield* client
          .request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
            cwd: input.workspacePath,
            approvalPolicy: effectivePolicy.approvalPolicy,
            approvalsReviewer: effectivePolicy.reviewer,
            sandboxPolicy: effectivePolicy.turnSandboxPolicy,
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

const userInputQuestionText = (params: Record<string, unknown>): string => {
  // Codex's `item/tool/requestUserInput` carries `questions[]`
  // ({ header, id, question, options }) and no `prompt` field (generated
  // schema: ToolRequestUserInputParams). A shim may still send `prompt`.
  if (typeof params.prompt === "string" && params.prompt.trim().length > 0) {
    return params.prompt.trim();
  }
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const lines: string[] = [];
  for (const raw of questions) {
    if (typeof raw !== "object" || raw === null) continue;
    const question = raw as Record<string, unknown>;
    const text = typeof question.question === "string" ? question.question.trim() : "";
    if (text.length === 0) continue;
    const header = typeof question.header === "string" ? question.header.trim() : "";
    const label = header.length > 0 && header !== text ? `${header}: ${text}` : text;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) =>
          typeof option === "object" &&
          option !== null &&
          typeof (option as { label?: unknown }).label === "string"
            ? [(option as { label: string }).label]
            : [],
        )
      : [];
    lines.push(options.length > 0 ? `${label} (options: ${options.join(", ")})` : label);
  }
  return lines.join("\n");
};

/** Compose the durable/prompt text for a user-input request. */
export const userInputRequestText = (params: Record<string, unknown>, method: string): string => {
  const text = userInputQuestionText(params);
  return text.length > 0 ? text : `The agent needs your input for ${method}.`;
};

const unsupportedQuestionPayload = (detail: string): ApprovalQuestionPayload => ({
  kind: "unsupported",
  providerMethod: CodexRpc.SERVER_REQUEST_METHODS["item/tool/requestUserInput"],
  detail,
});

const decodeQuestionPayload = Schema.decodeUnknownOption(ApprovalQuestionPayloadSchema);

/**
 * Preserve the provider's question structure for the durable record.
 *
 * Codex may omit `options` (or send null), so an empty option list is valid,
 * but a question without a stable id or text is not: the whole payload becomes
 * explicitly `unsupported` rather than dropping one question and letting the
 * remaining answers shift ids. `isSecret` is carried through for the durable
 * redaction policy.
 */
export const parseQuestionPayload = (params: Record<string, unknown>): ApprovalQuestionPayload => {
  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  if (rawQuestions.length === 0) {
    return unsupportedQuestionPayload("the provider request did not include a question list");
  }
  const questions: ApprovalQuestion[] = [];
  for (const raw of rawQuestions) {
    if (typeof raw !== "object" || raw === null) {
      return unsupportedQuestionPayload("a question was not an object");
    }
    const question = raw as Record<string, unknown>;
    const id = typeof question.id === "string" ? question.id.trim() : "";
    const text = typeof question.question === "string" ? question.question.trim() : "";
    if (id.length === 0 || text.length === 0) {
      return unsupportedQuestionPayload("a question did not include an id and question text");
    }
    const header =
      typeof question.header === "string" && question.header.trim().length > 0
        ? question.header.trim()
        : text;
    const options =
      question.options === undefined || question.options === null
        ? []
        : Array.isArray(question.options)
          ? question.options
          : null;
    if (options === null) {
      return unsupportedQuestionPayload(`question ${id} had an unsupported options shape`);
    }
    const parsedOptions: Array<{ readonly label: string; readonly description: string }> = [];
    for (const rawOption of options) {
      if (typeof rawOption !== "object" || rawOption === null) {
        return unsupportedQuestionPayload(`question ${id} had an unsupported option`);
      }
      const option = rawOption as Record<string, unknown>;
      const rawLabel = typeof option.label === "string" ? option.label.trim() : "";
      const rawDescription =
        typeof option.description === "string" ? option.description.trim() : "";
      // Codex descriptions are not guaranteed non-empty. If the label is
      // missing but the description carries actual text, keep that text as the
      // label rather than discarding a usable choice.
      const label = rawLabel.length > 0 ? rawLabel : rawDescription;
      if (label.length === 0) {
        return unsupportedQuestionPayload(`question ${id} had an option without a label`);
      }
      parsedOptions.push({ label, description: rawDescription });
    }
    questions.push({
      id,
      header,
      question: text,
      options: parsedOptions,
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      ...(questionIsSensitive({ header, question: text, sensitive: question.isSecret === true })
        ? { sensitive: true }
        : {}),
    });
  }
  const candidate = { kind: "structured" as const, version: 1 as const, questions };
  // Validate the whole payload before it can be persisted. A partially
  // decodable question list becomes explicitly unsupported instead of a row
  // that fails list decodes (and hides every other request).
  const decoded = decodeQuestionPayload(candidate);
  return Option.isSome(decoded)
    ? decoded.value
    : unsupportedQuestionPayload("the provider question payload could not be preserved");
};

const questionPayloadIds = (payload: ApprovalQuestionPayload): ReadonlyArray<string> =>
  payload.kind === "structured" ? payload.questions.map((question) => question.id) : [];

const consumeIncoming = (
  client: CodexClientService,
  runAttemptId: RunAttemptId,
  workItemId: WorkItemId,
  liveRequests: LiveRequestsService,
  recordRequest: AgentRuntimeDeps["recordRequest"],
  config: EffectiveWorkflowConfig,
  requestTimedOut?: AgentRuntimeDeps["requestTimedOut"],
  requestSettled?: AgentRuntimeDeps["requestSettled"],
): Effect.Effect<void, never, never> =>
  Stream.runForEach(client.raw.requests, (request) =>
    handleRequest(
      client,
      request,
      runAttemptId,
      workItemId,
      liveRequests,
      recordRequest,
      config,
      requestTimedOut,
      requestSettled,
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
  requestTimedOut?: AgentRuntimeDeps["requestTimedOut"],
  requestSettled?: AgentRuntimeDeps["requestSettled"],
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const waitTimeoutMs =
      config.liveRequestsWaitTimeoutMs ?? WORKFLOW_DEFAULTS.liveRequestsWaitTimeoutMs;
    const settleTimedOut = (requestId: string) =>
      requestTimedOut === undefined
        ? Effect.succeed(true)
        : requestTimedOut({ requestId, workItemId, runAttemptId });
    const markSettled = (requestId: string) =>
      requestSettled === undefined
        ? Effect.void
        : requestSettled({ requestId, workItemId, runAttemptId });
    /**
     * Scope-closure finaliser: remove only this caller's exact registration and
     * close the durable row if it is still pending or an unclaimed staged row.
     * Already decided rows and deliveries with a positive local receipt are
     * left untouched. Kept short and uninterruptible so it cannot be cut off by
     * the same scope closure that triggered it.
     */
    const finalizeRequest = (
      requestId: string,
      deferred: Deferred.Deferred<unknown>,
    ): Effect.Effect<void> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* liveRequests.withdrawPending(runAttemptId, requestId, deferred);
          yield* markSettled(requestId);
        }).pipe(Effect.catch(() => Effect.void)),
      );

    /**
     * Acquire the live registration and install its cleanup atomically, then
     * restore interruptibility for publication and the provider wait. The
     * cleanup covers the whole publish + wait + response window.
     */
    const runWithRegistration = (
      requestId: string,
      register: Effect.Effect<Deferred.Deferred<unknown>, LiveRequestAlreadyPendingError>,
      use: (
        deferred: Deferred.Deferred<unknown>,
        setSettleOnRelease: (value: boolean) => Effect.Effect<void>,
      ) => Effect.Effect<void>,
    ): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const settleOnRelease = yield* Ref.make(true);
          const result = yield* Effect.result(
            Effect.acquireUseRelease(
              register,
              (deferred) => restore(use(deferred, (value) => Ref.set(settleOnRelease, value))),
              (deferred) =>
                Effect.gen(function* () {
                  if (yield* Ref.get(settleOnRelease)) {
                    yield* finalizeRequest(requestId, deferred);
                  } else {
                    yield* liveRequests.withdrawPending(runAttemptId, requestId, deferred);
                  }
                }),
            ),
          );
          if (result._tag === "Failure") {
            if (result.failure instanceof LiveRequestAlreadyPendingError) {
              yield* client.raw
                .respondError(
                  request.id,
                  CodexErrors.CodexAppServerRequestError.invalidParams(
                    `Request id ${requestId} is already pending; preserving the original request`,
                  ),
                )
                .pipe(Effect.catch(() => Effect.void));
              return;
            }
            return yield* Effect.never;
          }
          // A normal return runs the release finaliser too; it is a no-op for
          // already-decided rows.
        }),
      );
    /**
     * Resolve what happened when this runtime's own wait elapsed.
     *
     * `expired` means this runtime won the settlement claim and no human
     * answer exists. `settled` means another path (cancellation, run
     * settlement) closed the request. `answered` means a human answer won
     * first, and that exact answer must be sent.
     */
    const resolveAfterWait = <A>(
      deferred: Deferred.Deferred<A>,
      requestId: string,
    ): Effect.Effect<
      | { readonly _tag: "answered"; readonly value: A }
      | { readonly _tag: "expired" }
      | { readonly _tag: "settled" }
    > =>
      Effect.gen(function* () {
        const won = yield* settleTimedOut(requestId);
        if (won) {
          return { _tag: "expired" as const };
        }
        const winner = yield* Effect.result(Deferred.await(deferred));
        // A failed Deferred means run settlement/cancellation, not an answer.
        return winner._tag === "Success"
          ? { _tag: "answered" as const, value: winner.success }
          : { _tag: "settled" as const };
      });
    if (isApprovalRequest(request.method)) {
      const requestId = String(params.requestId ?? params.approvalId ?? request.id);
      const action = String(params.kind ?? request.method.split("/").at(-2) ?? "action");
      const command = typeof params.command === "string" ? params.command : undefined;
      yield* runWithRegistration(
        requestId,
        liveRequests
          .registerApproval({
            requestId,
            workItemId,
            runAttemptId,
            action,
            prompt: command ?? `The agent requests approval for ${request.method}.`,
          })
          .pipe(Effect.map((value) => value as Deferred.Deferred<unknown>)),
        (deferred, setSettleOnRelease) =>
          Effect.gen(function* () {
            const record = yield* (
              recordRequest?.({
                requestId,
                workItemId,
                runAttemptId,
                action,
                ...(command !== undefined ? { command } : {}),
              }) ?? Effect.succeed({ status: "recorded" as const })
            ).pipe(
              Effect.map((result) => result ?? { status: "recorded" as const }),
              Effect.catch(() => Effect.succeed({ status: "record_failed" as const })),
            );
            if (record.status !== "recorded" && record.status !== "duplicate_pending") {
              // Publication failed or the durable history is decided/mismatched.
              // Withdraw only this caller's just-registered Deferred, then report
              // the provider error; no invisible waiter survives.
              yield* setSettleOnRelease(false);
              yield* liveRequests.withdrawPending(runAttemptId, requestId, deferred);
              yield* client.raw
                .respondError(
                  request.id,
                  CodexErrors.CodexAppServerRequestError.invalidParams(
                    record.status === "record_failed"
                      ? `Request id ${requestId} could not be recorded`
                      : `Request id ${requestId} was already used for a ${record.status === "duplicate_decided" ? "decided" : "different"} request`,
                  ),
                )
                .pipe(Effect.catch(() => Effect.void));
              return;
            }
            const typed = deferred as Deferred.Deferred<ApprovalDecision>;
            const decision = yield* waitForAnswer<ApprovalDecision>(
              typed,
              Duration.millis(waitTimeoutMs),
            );
            // Denying an expired approval is the policy-safe terminal outcome,
            // not a fabricated human decision. The row records `expired`.
            const effectiveDecision = Option.isSome(decision)
              ? decision.value
              : yield* Effect.gen(function* () {
                  const outcome = yield* resolveAfterWait(typed, requestId);
                  if (outcome._tag === "answered") return outcome.value;
                  if (outcome._tag === "settled") yield* markSettled(requestId);
                  return "rejected" as ApprovalDecision;
                });
            yield* client.raw
              .respond(request.id, { decision: toCodexApprovalDecision(effectiveDecision) })
              .pipe(Effect.catch(() => Effect.void));
          }),
      );
    } else if (isUserInputRequest(request.method)) {
      const requestId = String(params.requestId ?? request.id);
      const promptText = userInputRequestText(params, request.method);
      const questionPayload = parseQuestionPayload(params);
      const questionIds = questionPayloadIds(questionPayload);
      yield* runWithRegistration(
        requestId,
        liveRequests
          .registerUserInput({
            requestId,
            workItemId,
            runAttemptId,
            prompt: promptText,
            questionIds,
          })
          .pipe(Effect.map((value) => value as Deferred.Deferred<unknown>)),
        (deferred, setSettleOnRelease) =>
          Effect.gen(function* () {
            const record = yield* (
              recordRequest?.({
                requestId,
                workItemId,
                runAttemptId,
                action: "user_input",
                // Persist the question itself and its preserved structure: the
                // live registry only holds it in memory, so without this the
                // Attention tab can only say that something was asked.
                reason: promptText,
                questionPayload,
              }) ?? Effect.succeed({ status: "recorded" as const })
            ).pipe(
              Effect.map((result) => result ?? { status: "recorded" as const }),
              Effect.catch(() => Effect.succeed({ status: "record_failed" as const })),
            );
            if (record.status !== "recorded" && record.status !== "duplicate_pending") {
              yield* setSettleOnRelease(false);
              yield* liveRequests.withdrawPending(runAttemptId, requestId, deferred);
              yield* client.raw
                .respondError(
                  request.id,
                  CodexErrors.CodexAppServerRequestError.invalidParams(
                    record.status === "record_failed"
                      ? `Request id ${requestId} could not be recorded`
                      : `Request id ${requestId} was already used for a ${record.status === "duplicate_decided" ? "decided" : "different"} request`,
                  ),
                )
                .pipe(Effect.catch(() => Effect.void));
              return;
            }
            const typed = deferred as Deferred.Deferred<UserInputAnswers>;
            const answer = yield* waitForAnswer<UserInputAnswers>(
              typed,
              Duration.millis(waitTimeoutMs),
            );
            const sendAnswers = (answers: UserInputAnswers) => {
              // Never send a partial map: a missing or extra id would silence a
              // blocking question or answer the wrong one.
              const problems = answerMapProblems(questionIds, answers);
              return problems.length > 0
                ? client.raw
                    .respondError(
                      request.id,
                      CodexErrors.CodexAppServerRequestError.invalidParams(
                        `The operator answers did not match the provider questions: ${problems.join("; ")}`,
                      ),
                    )
                    .pipe(Effect.catch(() => Effect.void))
                : client.raw
                    .respond(request.id, toCodexUserInputResponse(questionIds, answers))
                    .pipe(Effect.catch(() => Effect.void));
            };
            if (Option.isSome(answer)) {
              yield* sendAnswers(answer.value);
            } else {
              const outcome = yield* resolveAfterWait(typed, requestId);
              if (outcome._tag === "answered") {
                yield* sendAnswers(outcome.value);
              } else {
                if (outcome._tag === "settled") yield* markSettled(requestId);
                // A question has no safe default answer. Terminate its provider
                // request explicitly and leave the durable row
                // `expired`/`interrupted` instead of sending an empty synthetic
                // answer that looks human.
                const message =
                  outcome._tag === "expired"
                    ? "The operator did not answer before the request wait expired. The request is expired; answer a current request."
                    : "The request was settled before an answer arrived (the run was cancelled or interrupted).";
                yield* client.raw
                  .respondError(
                    request.id,
                    new CodexErrors.CodexAppServerRequestError({
                      code: -32001,
                      errorMessage: message,
                    }),
                  )
                  .pipe(Effect.catch(() => Effect.void));
              }
            }
          }),
      );
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

/**
 * Wait for an answer, yielding `none` when the wait elapsed or the live
 * request was settled elsewhere (run settlement, cancellation). Callers answer
 * the provider with their fallback and settle the durable request.
 */
const waitForAnswer = <A>(
  deferred: Deferred.Deferred<A>,
  duration: Duration.Duration,
): Effect.Effect<Option.Option<A>> =>
  Deferred.await(deferred).pipe(
    Effect.timeoutOption(duration),
    Effect.catch(() => Effect.succeed(Option.none<A>())),
  );
