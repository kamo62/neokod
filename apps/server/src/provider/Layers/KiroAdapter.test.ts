// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  KiroSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@neokod/contracts";

import { ServerConfig } from "../../config.ts";
import type {
  WorkspaceOwnershipRecord,
  WorkspaceOwnershipRepositoryShape,
} from "../../symphony/Persistence/Services/WorkspaceOwnershipRepository.ts";
import {
  makeKiroAdapter,
  type KiroAdapterLiveOptions,
  type KiroManagedTurnEvidence,
} from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockKiroWrapper(
  extraEnv?: Record<string, string>,
  captureEnvironmentAt?: string,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kiro.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${captureEnvironmentAt ? `env > ${JSON.stringify(captureEnvironmentAt)}` : ""}
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 60): Effect.Effect<string> {
  const readAttempt = (remaining: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remaining <= 0) return yield* Effect.die(`Timed out waiting for ${filePath}`);
      const content = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (content.trim().length > 0) return content;
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remaining - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const kiroAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "neokod-kiro-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeTestOwnershipRepository(): WorkspaceOwnershipRepositoryShape {
  const records = new Map<string, WorkspaceOwnershipRecord>();
  const acquire: WorkspaceOwnershipRepositoryShape["acquire"] = (input) =>
    Effect.sync(() => {
      const existing = records.get(input.workspacePath);
      if (
        existing &&
        !(
          existing.owner === input.owner &&
          (input.owner === "symphony" || existing.threadId === (input.threadId ?? null))
        )
      ) {
        return null;
      }
      const record: WorkspaceOwnershipRecord = {
        workspacePath: input.workspacePath,
        owner: input.owner,
        workItemId: input.workItemId ?? null,
        threadId: input.threadId ?? null,
        generation: (existing?.generation ?? 0) + 1,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      records.set(input.workspacePath, record);
      return record;
    });
  return {
    acquire,
    transfer: () => Effect.succeed(null),
    renew: () => Effect.succeed(null),
    release: (input) =>
      Effect.sync(() => {
        const existing = records.get(input.workspacePath);
        if (
          !existing ||
          existing.owner !== input.owner ||
          existing.generation !== input.generation
        ) {
          return false;
        }
        records.delete(input.workspacePath);
        return true;
      }),
    getByWorkspacePath: (workspacePath) => Effect.sync(() => records.get(workspacePath) ?? null),
  };
}

const makeTestAdapter = (
  binaryPath: string,
  settings?: Partial<KiroSettings>,
  options?: Partial<KiroAdapterLiveOptions>,
) =>
  makeKiroAdapter(decodeKiroSettings({ enabled: true, binaryPath, ...settings }), {
    ownershipRepository: options?.ownershipRepository ?? makeTestOwnershipRepository(),
    ...(options?.environment ? { environment: options.environment } : {}),
    ...(options?.nativeEventLogPath ? { nativeEventLogPath: options.nativeEventLogPath } : {}),
    ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
    ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
    ...(options?.onManagedTurnEvidence
      ? { onManagedTurnEvidence: options.onManagedTurnEvidence }
      : {}),
  }).pipe(Effect.orDie);

it.layer(kiroAdapterTestLayer)("KiroAdapterLive", (it) => {
  it.effect(
    "creates a no-auth ACP session, streams canonical events, and settles its process group",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-create-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const exitLogPath = NodePath.join(tempDir, "exit.log");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKiroWrapper({
            NEOKOD_ACP_AUTH_METHOD_IDS: "",
            NEOKOD_ACP_REQUEST_LOG_PATH: requestLogPath,
            NEOKOD_ACP_EXIT_LOG_PATH: exitLogPath,
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);
        const threadId = ThreadId.make("kiro-create-thread");
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kiro"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId, input: "hello kiro", attachments: [] });

        assert.equal(session.model, "auto");
        assert.includeMembers(
          events.map((event) => event.type),
          ["session.started", "thread.started", "turn.started", "content.delta", "turn.completed"],
        );

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const methods = requests.flatMap((entry) =>
          typeof entry.method === "string" ? [entry.method] : [],
        );
        assert.include(methods, "initialize");
        assert.include(methods, "session/new");
        assert.notInclude(methods, "authenticate");

        yield* adapter.stopSession(threadId);
        assert.include(yield* waitForFileContent(exitLogPath), "SIGTERM");
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(TestClock.withLive),
  );

  it.effect("loads an existing ACP session from the durable resume cursor", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-load-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          NEOKOD_ACP_AUTH_METHOD_IDS: "",
          NEOKOD_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("kiro-load-thread");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "kiro-resume-session" },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 2,
        sessionId: "kiro-resume-session",
        agentEngine: "v2",
      });

      const methods = (yield* Effect.promise(() => readJsonLines(requestLogPath))).flatMap(
        (entry) => (typeof entry.method === "string" ? [entry.method] : []),
      );
      assert.include(methods, "session/load");
      assert.notInclude(methods, "session/new");
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("starts v3 ACP with an explicit provider API key", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-v3-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const environmentLogPath = NodePath.join(tempDir, "environment.txt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper(
          {
            NEOKOD_ACP_AUTH_METHOD_IDS: "aws-builder-id",
            NEOKOD_ACP_REQUEST_LOG_PATH: requestLogPath,
          },
          environmentLogPath,
        ),
      );
      const adapter = yield* makeTestAdapter(
        wrapperPath,
        { agentEngine: "v3" },
        {
          environment: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            KIRO_API_KEY: "kiro-test-key",
            ANTHROPIC_API_KEY: "must-not-reach-child",
          },
        },
      );
      const threadId = ThreadId.make("kiro-v3-thread");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-1",
        agentEngine: "v3",
      });
      const childEnvironment = yield* Effect.promise(() =>
        NodeFSP.readFile(environmentLogPath, "utf8"),
      );
      assert.include(childEnvironment, "KIRO_API_KEY=kiro-test-key");
      assert.notInclude(childEnvironment, "ANTHROPIC_API_KEY=");
      const managedHome = childEnvironment
        .split("\n")
        .find((line) => line.startsWith("HOME="))
        ?.slice("HOME=".length);
      assert.isString(managedHome);
      assert.notEqual(managedHome, process.env.HOME);
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(managedHome!, ".kiro/settings/permissions.yaml"), "utf8"),
        ),
        "rules:\n  - capability: all\n    effect: ask\n",
      );
      const methods = (yield* Effect.promise(() => readJsonLines(requestLogPath))).flatMap(
        (entry) => (typeof entry.method === "string" ? [entry.method] : []),
      );
      assert.notInclude(methods, "authenticate");
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects v3 before spawn when its provider API key is missing", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(
        "/kiro-must-not-spawn",
        { agentEngine: "v3" },
        { environment: { PATH: process.env.PATH, HOME: process.env.HOME } },
      );

      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("kiro-v3-missing-key"),
          provider: ProviderDriverKind.make("kiro"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, Error);
      assert.include(error.message, "KIRO_API_KEY");
    }),
  );

  it.effect("rejects cross-engine resume before starting ACP", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ NEOKOD_ACP_AUTH_METHOD_IDS: "" }),
      );
      const adapter = yield* makeTestAdapter(
        wrapperPath,
        { agentEngine: "v3" },
        {
          environment: { PATH: process.env.PATH, HOME: process.env.HOME, KIRO_API_KEY: "test-key" },
        },
      );

      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("kiro-cross-engine-resume"),
          provider: ProviderDriverKind.make("kiro"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: { schemaVersion: 1, sessionId: "legacy-v2-session" },
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, Error);
      assert.include(error.message, "cannot resume");
    }),
  );

  it.effect("maps semantic approvals and canonical tool events", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-approval-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          NEOKOD_ACP_AUTH_METHOD_IDS: "",
          NEOKOD_ACP_REQUEST_LOG_PATH: requestLogPath,
          NEOKOD_ACP_EMIT_TOOL_CALLS: "1",
          NEOKOD_ACP_ALLOW_ALWAYS_OPTION_ID: "kiro-allow-session",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("kiro-approval-thread");
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "run a tool", attachments: [] })
        .pipe(Effect.forkChild);
      const opened = yield* Deferred.await(requestOpened);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "acceptForSession",
      );
      yield* Fiber.join(turnFiber);

      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      assert.include(requestLog, "kiro-allow-session");
      assert.includeMembers(
        events.map((event) => event.type),
        ["item.updated", "request.opened", "request.resolved", "turn.completed"],
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("handles standard ACP form elicitation through provider user input", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          NEOKOD_ACP_AUTH_METHOD_IDS: "",
          NEOKOD_ACP_EMIT_ELICITATION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("kiro-elicitation-thread");
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "user-input.requested"
              ? Deferred.succeed(requested, event).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me", attachments: [] })
        .pipe(Effect.forkChild);
      const event = yield* Deferred.await(requested);
      assert.deepStrictEqual(event.payload.questions[0]?.options, [
        { label: "staging", description: "staging" },
        { label: "production", description: "production" },
      ]);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(String(event.requestId)), {
        target: "staging",
      });
      yield* Fiber.join(turnFiber);
      assert.include(
        events.map((runtimeEvent) => runtimeEvent.type),
        "user-input.resolved",
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("clears the active turn and emits failed completion when session/prompt fails", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          NEOKOD_ACP_AUTH_METHOD_IDS: "",
          NEOKOD_ACP_FAIL_PROMPT: "1",
          NEOKOD_ACP_PROMPT_EXTENSION_ERROR: "The monthly usage limit has been reached",
        }),
      );
      let readinessFailure: string | undefined;
      const adapter = yield* makeTestAdapter(wrapperPath, undefined, {
        onManagedTurnEvidence: (evidence) =>
          Effect.sync(() => {
            if (!evidence.ready) readinessFailure = evidence.reason;
          }),
      });
      const threadId = ThreadId.make("kiro-failed-prompt-thread");
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const failure = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "fail", attachments: [] }),
      );
      assert.equal(failure._tag, "ProviderAdapterRequestError");
      assert.include(failure.message, "The monthly usage limit has been reached");
      assert.equal(readinessFailure, "The monthly usage limit has been reached");
      const [session] = yield* adapter.listSessions();
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);
      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(completed?.payload.state, "failed");
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not mark a completed turn ready without assistant output", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          NEOKOD_ACP_AUTH_METHOD_IDS: "",
          NEOKOD_ACP_PROMPT_RESPONSE_TEXT: "",
        }),
      );
      let evidence: KiroManagedTurnEvidence | undefined;
      const adapter = yield* makeTestAdapter(wrapperPath, undefined, {
        onManagedTurnEvidence: (next) => Effect.sync(() => (evidence = next)),
      });
      const threadId = ThreadId.make("kiro-empty-assistant-output");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "empty", attachments: [] });
      assert.deepStrictEqual(evidence, {
        ready: false,
        reason: "Managed turn completed without assistant output.",
      });
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects unverified runtime modes before spawning", () =>
    Effect.gen(function* () {
      const approvalOnly = yield* makeTestAdapter("/not-used");
      const fullAccessError = yield* Effect.flip(
        approvalOnly.startSession({
          threadId: ThreadId.make("kiro-full-access-rejected"),
          provider: ProviderDriverKind.make("kiro"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );
      assert.equal(fullAccessError._tag, "ProviderAdapterValidationError");
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects a live Work lease held by another thread and releases it on stop", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ NEOKOD_ACP_AUTH_METHOD_IDS: "" }),
      );
      const ownershipRepository = makeTestOwnershipRepository();
      const adapter = yield* makeTestAdapter(wrapperPath, undefined, { ownershipRepository });
      const firstThread = ThreadId.make("kiro-lease-owner");
      const secondThread = ThreadId.make("kiro-lease-conflict");
      yield* adapter.startSession({
        threadId: firstThread,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const conflict = yield* Effect.flip(
        adapter.startSession({
          threadId: secondThread,
          provider: ProviderDriverKind.make("kiro"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      );
      assert.equal(conflict._tag, "ProviderAdapterValidationError");
      yield* adapter.stopSession(firstThread);
      yield* adapter.startSession({
        threadId: secondThread,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.stopSession(secondThread);
    }).pipe(TestClock.withLive),
  );

  it.effect("isolates and stops concurrent ACP sessions independently", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          NEOKOD_ACP_AUTH_METHOD_IDS: "",
          NEOKOD_ACP_PROMPT_DELAY_MS: "100",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const firstThread = ThreadId.make("kiro-concurrent-one");
      const secondThread = ThreadId.make("kiro-concurrent-two");
      const firstCwd = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-cwd-one-")),
      );
      const secondCwd = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-cwd-two-")),
      );
      yield* Effect.all(
        [
          { threadId: firstThread, cwd: firstCwd },
          { threadId: secondThread, cwd: secondCwd },
        ].map(({ threadId, cwd }) =>
          adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("kiro"),
            cwd,
            runtimeMode: "approval-required",
          }),
        ),
        { concurrency: 2 },
      );
      yield* Effect.all(
        [firstThread, secondThread].map((threadId) =>
          adapter.sendTurn({ threadId, input: String(threadId), attachments: [] }),
        ),
        { concurrency: 2 },
      );
      assert.equal((yield* adapter.listSessions()).length, 2);
      yield* adapter.stopSession(firstThread);
      yield* adapter.stopSession(secondThread);
    }).pipe(TestClock.withLive),
  );

  it.effect("filters secrets in the real production child spawner", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-env-canary-")),
      );
      const environmentLogPath = NodePath.join(tempDir, "environment.txt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ NEOKOD_ACP_AUTH_METHOD_IDS: "" }, environmentLogPath),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, undefined, {
        environment: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          KIRO_CANARY_SECRET: "must-not-reach-child",
          AWS_SECRET_ACCESS_KEY: "must-not-reach-child",
        },
      });
      const threadId = ThreadId.make("kiro-environment-canary");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const childEnvironment = yield* waitForFileContent(environmentLogPath);
      assert.notInclude(childEnvironment, "KIRO_CANARY_SECRET=");
      assert.notInclude(childEnvironment, "AWS_SECRET_ACCESS_KEY=");
      if (process.env.HOME) assert.include(childEnvironment, `HOME=${process.env.HOME}`);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
