// @effect-diagnostics nodeBuiltinImport:off - the Windows taskkill worker needs its native process handle
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@neokod/contracts";
import {
  createOpencodeClient,
  type Agent,
  type Config,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString, escalateChildTermination } from "./providerSnapshot.ts";
import * as NetService from "@neokod/shared/Net";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import {
  captureProcessBirthToken,
  posixProcessBirthReader,
  posixProcessGroupSignaller,
  validateProcessBirthIdentity,
  type ProcessBirthReader,
  type ProcessGroupSignaller,
} from "@neokod/shared/processGroup";
import { resolveSpawnCommand } from "@neokod/shared/shell";
import { OpenCodeServerLedger } from "./OpenCodeServerLedger.ts";
import {
  classifyOpenCodeVersion,
  formatOpenCodeUnsupportedVersionMessage,
  OPENCODE_VERSION_PROBE_TIMEOUT,
  parseOpenCodeVersionOutput,
} from "./openCodeVersion.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

// OpenCode 1.x names its own banner; v2 prints the generic one. Parsing both
// keeps startup diagnostics usable without claiming that v2 is supported.
const OPENCODE_SERVER_READY_PREFIXES = ["opencode server listening", "server listening"] as const;
const OPENCODE_SERVER_USERNAME = "opencode";

/**
 * Names removed from the child's environment: Neokod-internal configuration and
 * any inherited OpenCode auth that would shadow the per-spawn password.
 *
 * Provider API keys, `HOME`, `PATH`, `XDG_*` and `OPENCODE_CONFIG_*` pass
 * through because OpenCode needs them to find its config and credentials.
 */
const OPENCODE_CHILD_ENV_DENY_PREFIXES = ["NEOKOD_", "T3CODE_"] as const;
const OPENCODE_CHILD_ENV_DENY_NAMES = new Set([
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_PASSWORD",
]);

export function buildOpenCodeServerEnvironment(
  base: NodeJS.ProcessEnv,
  serverPassword: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (OPENCODE_CHILD_ENV_DENY_NAMES.has(name)) continue;
    if (OPENCODE_CHILD_ENV_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  env.OPENCODE_SERVER_PASSWORD = serverPassword;
  return env;
}
/**
 * Budget for `opencode serve` to spawn and announce its listening URL.
 *
 * This is a cold process start, not a query against something already running,
 * so it is the most expensive startup step in the provider layer and needs the
 * headroom to match: Claude's capability probe allows 25s and the ACP model
 * discoveries allow 15s, and both of those talk to a live process. The previous
 * 5s was the smallest budget in the layer and the only one covering a spawn,
 * which failed the first turn on a constrained host and then succeeded on retry
 * once the binary was in the page cache.
 */
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 15_000;

/**
 * Operator override for hosts slower than the default allows, following
 * `NEOKOD_STRICT_PROVIDER_LIFECYCLE_GUARD`. A value that is not a positive
 * integer is ignored rather than treated as zero, because a zero or negative
 * budget would fail every start immediately.
 */
export function parseOpenCodeServerTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
  }
  return parsed;
}

const OPENCODE_SERVER_TIMEOUT_MS = parseOpenCodeServerTimeoutMs(
  process.env.NEOKOD_OPENCODE_SERVER_TIMEOUT_MS,
);
const DEFAULT_HOSTNAME = "127.0.0.1";

const OPENCODE_GROUP_TERM_GRACE = "1 second";
const OPENCODE_GROUP_KILL_SETTLE_POLLS = 20;
const OPENCODE_GROUP_KILL_SETTLE_INTERVAL = "50 millis";

/**
 * Grace for each stage of stopping a one-shot command child (`--version`).
 *
 * The caller's probe timeout bounds command collection only; terminating the
 * child adds up to this window for SIGTERM and the same window again for the
 * exit wait after SIGKILL. A version probe can therefore settle about two
 * seconds after its nominal timeout, plus scheduling.
 */
const OPENCODE_COMMAND_TERM_GRACE = Duration.seconds(1);

/**
 * Bound for the Windows `taskkill` worker to settle, and for cancelling it
 * through its own process handle when it does not. Windows has no graceful
 * signal, so one forced tree termination replaces the POSIX TERM-to-KILL
 * escalation. The worker is owned: it is awaited, and on cancellation it is
 * terminated directly through the native handle rather than by launching a
 * second `taskkill`.
 */
const OPENCODE_WINDOWS_TASKKILL_SETTLE_GRACE = Duration.seconds(1);

export interface OpenCodeProcessGroupTerminationInput {
  readonly pgid: number;
  /** Recycle-resistant leader birth token captured immediately after spawn. */
  readonly birthToken: string | null;
}

export interface OpenCodeProcessGroupTerminationDependencies {
  readonly signaller: ProcessGroupSignaller;
  readonly birthReader: ProcessBirthReader;
}

/**
 * TERM-to-KILL escalation for a spawned OpenCode server group.
 *
 * A bare pgid is not proof that the group is still ours: the original group can
 * exit and the kernel can reuse its id before shutdown even starts. Every
 * signal therefore requires the leader's recorded birth token to still match
 * the live process. An unknown or changed identity fails closed, sends nothing,
 * and leaves the ledger evidence for a later, fully verified reaping attempt.
 */
export const terminateOpenCodeProcessGroup = (
  input: OpenCodeProcessGroupTerminationInput,
  dependencies: OpenCodeProcessGroupTerminationDependencies,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const confirmOwnership = (signal: NodeJS.Signals) =>
      validateProcessBirthIdentity(
        { pid: input.pgid, persistedBirthToken: input.birthToken },
        dependencies.birthReader,
      ).pipe(
        Effect.tap((validation) =>
          validation.status === "confirmed"
            ? Effect.void
            : Effect.logWarning(
                `Refusing to send ${signal} to an OpenCode server process group whose birth identity is not confirmed; keeping its ledger entry`,
                {
                  pgid: input.pgid,
                  identity: validation.status,
                  ...(validation.status === "unverifiable" ? { reason: validation.reason } : {}),
                },
              ),
        ),
      );

    const beforeTerm = yield* confirmOwnership("SIGTERM");
    if (beforeTerm.status !== "confirmed") {
      return;
    }

    const term = yield* dependencies.signaller.signalGroup(input.pgid, "SIGTERM");
    if (term === "no_such_group") {
      return;
    }
    if (term !== "sent") {
      yield* Effect.logWarning("Could not send SIGTERM to an OpenCode server process group", {
        pgid: input.pgid,
        result: term,
      });
    }
    yield* Effect.sleep(OPENCODE_GROUP_TERM_GRACE);
    if (!(yield* dependencies.signaller.isGroupAlive(input.pgid))) {
      return;
    }

    const beforeKill = yield* confirmOwnership("SIGKILL");
    if (beforeKill.status !== "confirmed") {
      return;
    }

    const kill = yield* dependencies.signaller.signalGroup(input.pgid, "SIGKILL");
    if (kill === "no_such_group") {
      return;
    }
    if (kill !== "sent") {
      yield* Effect.logWarning("Could not send SIGKILL to an OpenCode server process group", {
        pgid: input.pgid,
        result: kill,
      });
      return;
    }
    for (let poll = 0; poll < OPENCODE_GROUP_KILL_SETTLE_POLLS; poll++) {
      if (!(yield* dependencies.signaller.isGroupAlive(input.pgid))) {
        return;
      }
      yield* Effect.sleep(OPENCODE_GROUP_KILL_SETTLE_INTERVAL);
    }
    yield* Effect.logWarning(
      "OpenCode server process group survived SIGKILL; keeping its ledger entry",
      { pgid: input.pgid },
    );
  });
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
  readonly serverPassword?: string;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
  readonly serverPassword?: string;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);

  // Without this the cause prints as a bare "OpenCodeRuntimeError:" with no
  // text, because `detail` is a field and nothing populates `Error.message`.
  // The reason only ever reached a reader through whichever outer error
  // happened to interpolate it.
  override get message(): string {
    return this.detail;
  }
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly config: Config;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   *
   * Termination runs through the birth-identity-checked cleanup registered here,
   * never through the spawner's own scope finalizer. See the ownership note in
   * the implementation for why the spawner scope must not be closed.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Runs a one-shot command and collects its output. Interruption (including a
   * caller timeout) terminates the child with a bounded TERM-to-KILL escalation
   * and a bounded exit wait, so callers never wait on the spawner's own
   * unbounded cleanup.
   */
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
}

export function parseOpenCodeServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!OPENCODE_SERVER_READY_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  switch (runtimeMode) {
    case "full-access":
      return [{ permission: "*", pattern: "*", action: "allow" }];
    case "auto":
      // OpenCode has no AI reviewer; Auto intentionally uses the user approval path.
      break;
    case "approval-required":
    case "auto-accept-edits":
      break;
  }

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

/**
 * The Windows termination worker started for one command child. It keeps the
 * native process handle so cancellation can terminate the worker directly and
 * await its exit instead of launching another `taskkill`.
 */
export interface WindowsTaskkillWorkerHandle {
  readonly pid: number | undefined;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, WindowsTaskkillWorkerError>;
  readonly terminate: Effect.Effect<void>;
}

export class WindowsTaskkillWorkerError extends Data.TaggedError("WindowsTaskkillWorkerError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface WindowsTaskkillSpawnerShape {
  readonly spawn: (
    pid: number,
  ) => Effect.Effect<WindowsTaskkillWorkerHandle, WindowsTaskkillWorkerError>;
}

const windowsTaskkillExecutable = (): string => {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  return systemRoot && systemRoot.trim().length > 0
    ? `${systemRoot.replace(/[\\/]+$/u, "")}\\System32\\taskkill.exe`
    : "taskkill";
};

/**
 * Start one `taskkill /pid <pid> /T /F` worker without a shell and retain its
 * native handle. `/T /F` is already the forced tree termination, so the POSIX
 * TERM-then-KILL escalation must not run here: both signals would launch the
 * same command twice.
 */
const spawnWindowsTaskkillWorker = (
  pid: number,
): Effect.Effect<WindowsTaskkillWorkerHandle, WindowsTaskkillWorkerError> =>
  Effect.try({
    try: () =>
      NodeChildProcess.spawn(windowsTaskkillExecutable(), ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    catch: (cause) =>
      new WindowsTaskkillWorkerError({ detail: `Could not start taskkill: ${String(cause)}` }),
  }).pipe(
    Effect.map((child) => {
      const exitCode = Effect.callback<number, WindowsTaskkillWorkerError>((resume) => {
        if (child.exitCode !== null) {
          resume(Effect.succeed(child.exitCode));
          return;
        }
        let settled = false;
        const settle = (effect: Effect.Effect<number, WindowsTaskkillWorkerError>) => {
          if (settled) return;
          settled = true;
          resume(effect);
        };
        const onExit = (code: number | null) => settle(Effect.succeed(code ?? -1));
        const onError = (cause: Error) =>
          settle(Effect.fail(new WindowsTaskkillWorkerError({ detail: cause.message })));
        child.once("exit", onExit);
        child.once("error", onError);
        return Effect.sync(() => {
          child.off("exit", onExit);
          child.off("error", onError);
        });
      });

      return {
        pid: child.pid,
        isRunning: Effect.sync(() => child.exitCode === null && child.signalCode === null),
        exitCode,
        // `child.kill` targets this worker's owned native handle. On Windows
        // Node terminates that process directly, so cancellation cannot
        // recurse into another taskkill.
        terminate: Effect.sync(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // The worker exited between the check and the signal.
          }
        }),
      } satisfies WindowsTaskkillWorkerHandle;
    }),
  );

/**
 * Injectable so tests can exercise worker settlement without running taskkill
 * on a non-Windows host. Production uses the owned native-process worker above.
 */
export const WindowsTaskkillSpawner = Context.Reference<WindowsTaskkillSpawnerShape>(
  "neokod/provider/opencodeWindowsTaskkillSpawner",
  { defaultValue: () => ({ spawn: spawnWindowsTaskkillWorker }) },
);

type WindowsTaskkillAwait =
  | { readonly state: "exited"; readonly exitCode: number }
  | { readonly state: "timeout" }
  | { readonly state: "failed"; readonly detail: string };

type WindowsTaskkillSettlement =
  | {
      readonly state: "exited";
      readonly workerPid: number | undefined;
      readonly exitCode: number;
    }
  | {
      readonly state: "unknown";
      readonly workerPid: number | undefined;
      readonly reason: "worker_failed" | "worker_cancelled" | "worker_did_not_settle";
      readonly detail?: string;
    };

const awaitWindowsTaskkillWorker = (
  worker: WindowsTaskkillWorkerHandle,
): Effect.Effect<WindowsTaskkillAwait> =>
  worker.exitCode.pipe(
    Effect.timeoutOption(OPENCODE_WINDOWS_TASKKILL_SETTLE_GRACE),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) {
        return { state: "failed", detail: result.failure.detail } as const;
      }
      return Option.isNone(result.success)
        ? ({ state: "timeout" } as const)
        : ({ state: "exited", exitCode: result.success.value } as const);
    }),
  );

const cancelWindowsTaskkillWorker = (
  worker: WindowsTaskkillWorkerHandle,
  reason: "worker_failed" | "worker_cancelled",
): Effect.Effect<WindowsTaskkillSettlement> =>
  Effect.gen(function* () {
    if (yield* worker.isRunning.pipe(Effect.orElseSucceed(() => true))) {
      yield* worker.terminate;
    }
    const after = yield* awaitWindowsTaskkillWorker(worker);
    return after.state === "exited"
      ? ({
          state: "unknown",
          workerPid: worker.pid,
          reason,
        } as const)
      : ({
          state: "unknown",
          workerPid: worker.pid,
          reason: "worker_did_not_settle",
          ...(after.state === "failed" ? { detail: after.detail } : {}),
        } as const);
  });

const settleWindowsTaskkillWorker = (
  worker: WindowsTaskkillWorkerHandle,
): Effect.Effect<WindowsTaskkillSettlement> =>
  Effect.gen(function* () {
    const first = yield* awaitWindowsTaskkillWorker(worker);
    if (first.state === "exited") {
      return {
        state: "exited",
        workerPid: worker.pid,
        exitCode: first.exitCode,
      } as const;
    }
    return yield* cancelWindowsTaskkillWorker(
      worker,
      first.state === "failed" ? "worker_failed" : "worker_cancelled",
    );
  });

/**
 * Run the one owned Windows termination worker through settlement. A spawn
 * failure leaves no worker; a worker that outlives its bounded window is
 * cancelled through its native handle and awaited again. If it still does not
 * exit, the caller reports the command's state as unknown rather than claiming
 * it stopped.
 */
const runOwnedWindowsTaskkill = (
  workerSpawner: WindowsTaskkillSpawnerShape,
  pid: number,
): Effect.Effect<WindowsTaskkillSettlement> =>
  Effect.gen(function* () {
    const worker = yield* workerSpawner.spawn(pid).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(
          "Could not start the Windows OpenCode termination worker; the command process state is unknown",
          { pid, cause: cause.detail },
        ),
      ),
      Effect.option,
    );
    if (Option.isNone(worker)) {
      return { state: "unknown", workerPid: undefined, reason: "worker_failed" } as const;
    }
    return yield* settleWindowsTaskkillWorker(worker.value).pipe(
      Effect.onInterrupt(() =>
        cancelWindowsTaskkillWorker(worker.value, "worker_cancelled").pipe(
          Effect.tap((settlement) =>
            settlement.state === "unknown" && settlement.reason === "worker_did_not_settle"
              ? Effect.logWarning(
                  "Windows OpenCode termination worker did not exit after cancellation; its outcome and the command process state are unknown",
                  { pid, workerPid: settlement.workerPid },
                )
              : Effect.void,
          ),
          Effect.ignore,
        ),
      ),
    );
  });

const isCommandChildRunning = (
  child: ChildProcessSpawner.ChildProcessHandle,
): Effect.Effect<boolean> =>
  // Unknown liveness stays unknown: it is not proof that the child stopped.
  child.isRunning.pipe(Effect.orElseSucceed(() => true));

/**
 * Stop a command child within a bounded window and report what could not be
 * stopped.
 *
 * POSIX keeps the existing TERM-then-KILL escalation: it bounds the signal
 * delivery and the exit wait. Windows has no graceful signal and the installed
 * spawner implements both signals as the same `taskkill /T /F` without keeping
 * the worker handle, so a timeout leaves an unowned process that can act on the
 * recorded pid later. This path runs one owned worker, waits for it, and
 * cancels it through its native handle if it hangs.
 *
 * The preflight is the command handle's exit state: if Node has already
 * observed the child exit, no worker is started. `taskkill` itself resolves a
 * pid, and Windows cannot pin that pid against reuse through this API, so this
 * is only as strong as the spawner handle's exit observation. The worker is
 * never left to run after cleanup, which removes the delayed-action window.
 *
 * This needs no birth-token guard like the server path: the signals go through
 * the live spawner handle for a child this process just spawned, and only while
 * that handle still reports it running. The ledger guard exists for servers
 * whose pid survives a Neokod crash; a command's ownership ends with the call.
 */
const releaseOpenCodeCommandChild = (
  child: ChildProcessSpawner.ChildProcessHandle,
  hostPlatform: NodeJS.Platform,
  windowsTaskkill: WindowsTaskkillSpawnerShape,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pid = Number(child.pid);
    if (!(yield* isCommandChildRunning(child))) return;

    if (hostPlatform === "win32") {
      const settlement = yield* runOwnedWindowsTaskkill(windowsTaskkill, pid);
      if (settlement.state === "exited") {
        if (settlement.exitCode !== 0) {
          yield* Effect.logWarning("Windows OpenCode termination worker exited non-zero", {
            pid,
            workerPid: settlement.workerPid,
            exitCode: settlement.exitCode,
          });
        }
      } else {
        yield* Effect.logWarning(
          "Windows OpenCode termination worker did not settle; the command process state is unknown",
          {
            pid,
            workerPid: settlement.workerPid,
            reason: settlement.reason,
            ...(settlement.detail ? { cause: settlement.detail } : {}),
          },
        );
      }
      if (yield* isCommandChildRunning(child)) {
        yield* Effect.logWarning(
          "OpenCode command process survived Windows taskkill; it may still be running",
          { pid, workerPid: settlement.workerPid },
        );
      }
      return;
    }

    yield* escalateChildTermination(child, OPENCODE_COMMAND_TERM_GRACE);
    if (yield* isCommandChildRunning(child)) {
      yield* Effect.logWarning(
        "OpenCode command process survived SIGTERM and SIGKILL; it may still be running",
        { pid },
      );
    }
  });

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const windowsTaskkill = yield* WindowsTaskkillSpawner;
  const ledger = yield* OpenCodeServerLedger;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      // The Node spawner registers its own scope finalizer, which sends SIGTERM
      // and then waits for the exit signal with no bound. `forceKillAfter` only
      // times the signal send, not that wait, so a command that ignores SIGTERM
      // (for example a `--version` probe stuck before it can answer) parks the
      // finalizer, and the caller's timeout keeps waiting for the interrupted
      // fibre to finish. That finalizer also signals the process group without
      // an ownership check when the child exited non-zero. Give the command a
      // private scope this runtime never closes, so the finalizer can never run,
      // and make the `acquireRelease` below the only cleanup owner. It bounds
      // termination and the exit wait; the private scope holds no OS resources
      // of its own.
      const spawnScope = yield* Scope.make();
      const child = yield* Effect.acquireRelease(
        spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              shell: spawnCommand.shell,
              ...(input.environment ? { env: input.environment } : { extendEnv: true }),
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, spawnScope)),
        (child) => releaseOpenCodeCommandChild(child, hostPlatform, windowsTaskkill),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      // The `acquireRelease` above must run its bounded cleanup when this
      // command completes or is interrupted, not when the caller's ambient
      // scope eventually closes.
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  /**
   * Refuse to launch a local OpenCode 2 HTTP server before the child exists.
   *
   * The provider status check normally rejects v2 first, but adapters and
   * text generation can start a server without refreshing that snapshot.
   * The probe is bounded by {@link OPENCODE_VERSION_PROBE_TIMEOUT}: an
   * executable that never answers `--version` must not hold server startup.
   * A timed-out, failed or unparseable probe preserves the existing behaviour:
   * only an affirmatively classified unsupported major is blocked.
   */
  const assertSupportedOpenCodeVersion = (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) =>
    Effect.gen(function* () {
      const versionExit = yield* Effect.exit(
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["--version"],
          ...(input.environment ? { environment: input.environment } : {}),
        }).pipe(Effect.timeoutOption(OPENCODE_VERSION_PROBE_TIMEOUT)),
      );
      if (Exit.isFailure(versionExit)) {
        yield* Effect.logDebug(
          "Could not verify the OpenCode CLI version before starting its server; continuing without a version guard",
          { binaryPath: input.binaryPath, cause: Cause.squash(versionExit.cause) },
        );
        return;
      }
      if (Option.isNone(versionExit.value)) {
        yield* Effect.logDebug(
          "OpenCode CLI version probe timed out before starting its server; continuing without a version guard",
          { binaryPath: input.binaryPath },
        );
        return;
      }

      const parsed = parseOpenCodeVersionOutput(versionExit.value.value.stdout);
      const knownVersion = parsed ? classifyOpenCodeVersion(parsed) : null;
      if (knownVersion && !knownVersion.supported) {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: formatOpenCodeUnsupportedVersionMessage(knownVersion),
        });
      }
    });

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      yield* assertSupportedOpenCodeVersion({
        binaryPath: input.binaryPath,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });

      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      // The password lives only in the child environment, never in argv where
      // any local `ps` could read it. `extendEnv: false` is required because
      // the spawner otherwise merges the parent environment back over `env`,
      // restoring the names the scrub just removed.
      const serverPassword = NodeCrypto.randomBytes(32).toString("base64url");
      const childEnvironment = buildOpenCodeServerEnvironment(
        input.environment ?? process.env,
        serverPassword,
      );
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, childEnvironment);

      // The Node spawner's `spawn` implementation registers its own scope
      // finalizer, which sends `-pid` to the process group whenever the child
      // has already exited with a non-zero code, without any birth-identity
      // check. `unref()` does not cover that branch: the finalizer tests the
      // exit signal before it tests whether the handle is still referenced.
      // Registering that finalizer on the caller's scope would therefore send a
      // second, unguarded signal after the guarded cleanup below refused, or
      // after it stopped the group and the pgid was recycled.
      //
      // Give the spawner a private scope that this runtime never closes, so its
      // finalizer can never run, and let the `acquireRelease` below be the only
      // cleanup owner. The private scope holds no OS resources of its own: the
      // child's pipes close when the process exits, and the scope (with the
      // unused finalizer) becomes unreachable once this effect returns.
      //
      // The child's forget action is folded into that release instead of being
      // registered as a separate finalizer: finalizers run in reverse order, so
      // a separate `forget` would remove the durable evidence before the child
      // was terminated. A crash between those two would leave a detached child
      // with no record. Filling the forget action in after tracking returns
      // also preserves cleanup when tracking fails or is interrupted.
      const spawnScope = yield* Scope.make();
      const forgetRef = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const spawned = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const child = yield* spawner
            .spawn(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                detached: hostPlatform !== "win32",
                shell: spawnCommand.shell,
                // The caller's environment reaches opencode with Neokod-internal
                // names and inherited OpenCode auth removed. This spawn used to
                // write OPENCODE_CONFIG_CONTENT="{}" after the spread, which
                // silently replaced a value the operator had exported. It was
                // never a way to run opencode without a config: opencode loads its
                // global and project config first and merges this variable as one
                // more source on top, so "{}" only ever applied an empty overlay.
                // Nothing here needs a config-less opencode either; the
                // whitelist/blacklist handling in OpenCodeProvider.flattenOpenCodeModels
                // reads the real config.
                env: childEnvironment,
                extendEnv: false,
              }),
            )
            .pipe(
              Effect.provideService(Scope.Scope, spawnScope),
              Effect.mapError(
                (cause) =>
                  new OpenCodeRuntimeError({
                    operation: "startOpenCodeServerProcess",
                    detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                    cause,
                  }),
              ),
            );

          const childPid = Number(child.pid);
          const birthToken =
            hostPlatform === "win32" ? null : yield* captureProcessBirthToken(childPid);
          return { child, childPid, birthToken } as const;
        }),
        ({ child, childPid, birthToken }) =>
          Effect.gen(function* () {
            const terminateChild = Effect.gen(function* () {
              if (hostPlatform === "win32") {
                yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(
                  Effect.asVoid,
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not send SIGTERM to the OpenCode server child", {
                      pid: childPid,
                      cause,
                    }),
                  ),
                );
                yield* Effect.sleep("1 second");
                yield* child.kill({ killSignal: "SIGKILL", forceKillAfter: "1 second" }).pipe(
                  Effect.asVoid,
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not send SIGKILL to the OpenCode server child", {
                      pid: childPid,
                      cause,
                    }),
                  ),
                );
                return;
              }
              yield* terminateOpenCodeProcessGroup(
                { pgid: childPid, birthToken },
                { signaller: posixProcessGroupSignaller, birthReader: posixProcessBirthReader },
              );
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "Could not terminate the OpenCode server process group; keeping its ledger entry",
                  { pid: childPid, cause },
                ),
              ),
            );
            // Terminate before forgetting so a crash cannot erase the only
            // durable record of a child that still needs cleanup.
            yield* terminateChild;
            const forget = yield* Ref.get(forgetRef);
            yield* forget;
          }),
      );
      const { child, childPid } = spawned;
      const forget = yield* ledger.track({ pid: childPid, port, args });
      yield* Ref.set(forgetRef, forget);

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseOpenCodeServerUrlFromOutput(nextStdout);
            return parsed
              ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
              : Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      // Startup-time fibers are no longer needed once ready has resolved (either
      // way). The exit fiber is only interrupted on failure; on success it keeps
      // the caller's `exitCode` effect observable until the scope closes.
      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: [
            `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
            "On a slow host, raise NEOKOD_OPENCODE_SERVER_TIMEOUT_MS, or run",
            "`opencode serve` yourself and set the OpenCode server URL in settings.",
          ].join(" "),
        });
      }

      return {
        url: readyOption.value,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
        serverPassword,
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      // We don't own externally-configured servers — no scope interaction.
      return Effect.succeed({
        url: serverUrl,
        exitCode: null,
        external: true,
      });
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        exitCode: server.exitCode,
        external: false,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
      })),
    );
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", () => client.app.agents()).pipe(
      Effect.map((result) => result.data ?? []),
    );

  const loadConfig = (client: OpencodeClient) =>
    runOpenCodeSdk("config.get", () => client.config.get()).pipe(
      Effect.filterMapOrFail(
        (result) =>
          result.data
            ? Result.succeed(result.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "config.get",
                  detail: "OpenCode configuration was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client), loadConfig(client)], {
      concurrency: "unbounded",
    }).pipe(Effect.map(([providerList, agents, config]) => ({ providerList, agents, config })));

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "neokod/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
