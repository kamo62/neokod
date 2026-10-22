// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  applyOpenCodeAcpSelection,
  buildOpenCodeAcpSpawnInput,
  inspectOpenCodeAcpCapabilities,
  makeOpenCodeAcpRuntime,
  OPENCODE_ACP_AUTH_METHOD_ID,
  runOpenCodeAcpTextPrompt,
} from "./OpenCodeAcpSupport.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixturePath = NodePath.join(__dirname, "../../../scripts/opencode2-acp-mock-agent.ts");

function testEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    ...extra,
  };
}

async function makeFixtureWrapper(
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<{ readonly wrapperPath: string; readonly directory: string }> {
  const directory = await NodeFS.promises.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "opencode2-acp-wrapper-"),
  );
  const wrapperPath = NodePath.join(directory, "fake-opencode.sh");
  const envExports = Object.entries(extraEnvironment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} "$@"
`;
  await NodeFS.promises.writeFile(wrapperPath, script, "utf8");
  await NodeFS.promises.chmod(wrapperPath, 0o755);
  return { wrapperPath, directory };
}

function waitForFileContent(filePath: string, attempts = 4000): Effect.Effect<string> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const raw = yield* Effect.promise(() =>
        NodeFS.promises.readFile(filePath, "utf8").catch(() => ""),
      );
      if (raw.trim().length > 0) {
        return raw;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
  });
}

const makeRuntime = (
  input: {
    readonly extraEnvironment?: NodeJS.ProcessEnv;
    readonly resumeSessionId?: string;
    readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  } = {},
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const wrapper = yield* Effect.acquireRelease(
      Effect.promise(() => makeFixtureWrapper(input.extraEnvironment)),
      (created) =>
        Effect.promise(() =>
          NodeFS.promises.rm(created.directory, { recursive: true, force: true }),
        ),
    );
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    const runtime = yield* makeOpenCodeAcpRuntime({
      childProcessSpawner: spawner,
      openCodeSettings: { binaryPath: wrapper.wrapperPath },
      environment: testEnvironment(),
      cwd: process.cwd(),
      clientInfo: { name: "neokod-opencode2-acp-test", version: "0.0.0" },
      ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      requestLogger: (event) =>
        Effect.sync(() => {
          requestEvents.push(event);
        }),
    });
    return { runtime, requestEvents, wrapperDirectory: wrapper.directory };
  });

const collectEvents = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  count: number,
): Effect.Effect<ReadonlyArray<AcpSessionRuntime.AcpSessionRuntimeEvent>, never> =>
  Stream.runCollect(Stream.take(runtime.getEvents(), count)).pipe(
    Effect.map((chunk) => Array.from(chunk)),
  );

describe("buildOpenCodeAcpSpawnInput", () => {
  it("uses the configured binary and preserves a supplied environment exactly", () => {
    const environment = { PATH: "/safe/bin", HOME: "/safe/home" };
    const spawn = buildOpenCodeAcpSpawnInput(
      { binaryPath: "/opt/opencode/bin/opencode" },
      "/workspace",
      environment,
    );

    expect(spawn).toEqual({
      command: "/opt/opencode/bin/opencode",
      args: ["acp"],
      cwd: "/workspace",
      env: environment,
      extendEnv: false,
    });
  });

  it("falls back to the opencode command without inventing an environment", () => {
    expect(buildOpenCodeAcpSpawnInput(null, "/workspace")).toEqual({
      command: "opencode",
      args: ["acp"],
      cwd: "/workspace",
    });
  });
});

describe("OpenCode 2 ACP runtime parity", () => {
  it.effect("initializes, authenticates, creates a session, and forwards MCP servers", () =>
    Effect.gen(function* () {
      const mcpServers: ReadonlyArray<EffectAcpSchema.McpServer> = [
        {
          name: "neokod-http",
          type: "http",
          url: "http://127.0.0.1:4319/mcp",
          headers: [{ name: "X-Neokod-Test", value: "fixture" }],
        },
        {
          name: "neokod-stdio",
          command: "node",
          args: ["mcp-fixture.mjs"],
          env: [{ name: "FIXTURE_MODE", value: "1" }],
        },
      ];
      const { runtime, requestEvents } = yield* makeRuntime({ mcpServers });
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("mock-opencode2-session-1");
      expect(started.initializeResult.agentInfo).toEqual({
        name: "OpenCode",
        version: "2.0.32",
      });
      expect(started.initializeResult.authMethods?.map((method) => method.id)).toEqual([
        OPENCODE_ACP_AUTH_METHOD_ID,
      ]);
      expect(started.modelConfigId).toBe("model");

      const initialize = requestEvents.find(
        (event) => event.method === "initialize" && event.status === "started",
      );
      expect(initialize?.payload).toMatchObject({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });

      const authenticate = requestEvents.find(
        (event) => event.method === "authenticate" && event.status === "started",
      );
      expect(authenticate?.payload).toEqual({ methodId: OPENCODE_ACP_AUTH_METHOD_ID });

      const createSession = requestEvents.find(
        (event) => event.method === "session/new" && event.status === "started",
      );
      expect(createSession?.payload).toMatchObject({
        cwd: process.cwd(),
        mcpServers,
      });

      const capabilities = inspectOpenCodeAcpCapabilities(yield* runtime.getConfigOptions);
      expect(capabilities.modelOptionId).toBe("model");
      expect(capabilities.effortOptionId).toBe("effort");
      expect(capabilities.modeOptionId).toBe("mode");
      expect(capabilities.modelValues).toContain("deepseek/deepseek-flash");
      expect(capabilities.effortValues).toContain("high");
      expect(capabilities.modeValues).toEqual(["build", "plan"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when the advertised auth method changes", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        extraEnvironment: {
          NEOKOD_OPENCODE_ACP_AUTH_METHOD_IDS: "different-login",
        },
      });
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.data).toMatchObject({
          reason: "auth_method_unadvertised",
          configuredMethodId: OPENCODE_ACP_AUTH_METHOD_ID,
          advertisedMethodIds: ["different-login"],
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies model, effort, and mode through advertised config options", () =>
    Effect.gen(function* () {
      const { runtime, requestEvents } = yield* makeRuntime();
      yield* runtime.start();

      const result = yield* applyOpenCodeAcpSelection({
        runtime,
        selection: {
          model: "deepseek/deepseek-flash",
          effort: "high",
          mode: "plan",
        },
        mapError: (cause) => cause,
      });

      expect(result).toEqual({
        applied: [
          { configId: "model", value: "deepseek/deepseek-flash" },
          { configId: "effort", value: "high" },
          { configId: "mode", value: "plan" },
        ],
        model: "deepseek/deepseek-flash",
        effort: "high",
        mode: "plan",
      });
      expect(
        requestEvents.filter(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toHaveLength(3);
      expect(requestEvents.some((event) => event.method === "session/set_model")).toBe(false);

      const capabilities = inspectOpenCodeAcpCapabilities(yield* runtime.getConfigOptions);
      expect(capabilities.modelCurrentValue).toBe("deepseek/deepseek-flash");
      expect(capabilities.effortValues).toEqual(["none", "low", "high", "max", "default"]);
      expect(capabilities.modeValues).toEqual(["build", "plan"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a model-specific effort that the active model does not advertise", () =>
    Effect.gen(function* () {
      const { runtime, requestEvents } = yield* makeRuntime();
      yield* runtime.start();
      yield* applyOpenCodeAcpSelection({
        runtime,
        selection: { model: "deepseek/deepseek-flash" },
        mapError: (cause) => cause,
      });

      const error = yield* applyOpenCodeAcpSelection({
        runtime,
        selection: { effort: "xhigh" },
        mapError: (cause) => cause,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.data).toMatchObject({
          reason: "config_value_not_advertised",
          configId: "effort",
          requestedValue: "xhigh",
        });
      }
      expect(
        requestEvents.filter(
          (event) =>
            event.method === "session/set_config_option" &&
            event.status === "started" &&
            (event.payload as { configId?: string }).configId === "effort",
        ),
      ).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps each selection execution's applied evidence independent", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime();
      yield* runtime.start();
      const selection = applyOpenCodeAcpSelection({
        runtime,
        selection: { model: "deepseek/deepseek-flash" },
        mapError: (cause) => cause,
      });

      const first = yield* selection;
      yield* runtime.setConfigOption("model", "opencode/minimax-m3.1-flash-free");
      const second = yield* selection;
      const third = yield* selection;

      expect(first.applied).toEqual([{ configId: "model", value: "deepseek/deepseek-flash" }]);
      expect(second.applied).toEqual([{ configId: "model", value: "deepseek/deepseek-flash" }]);
      expect(third.applied).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("streams assistant text and ignores unsupported OpenCode 2 updates", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime();
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(promptResult).toMatchObject({
        stopReason: "end_turn",
        usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 },
      });

      const events = yield* collectEvents(runtime, 3);
      expect(events.map((event) => event._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const started = events[0];
      const delta = events[1];
      if (started?._tag === "AssistantItemStarted" && delta?._tag === "ContentDelta") {
        expect(delta.itemId).toBe(started.itemId);
        expect(delta.text).toBe("opencode fixture response");
      }
      const completed = events[2];
      if (
        started?._tag === "AssistantItemStarted" &&
        completed?._tag === "AssistantItemCompleted"
      ) {
        expect(completed.itemId).toBe(started.itemId);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("carries tool calls and answers a permission request through the runtime", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        extraEnvironment: {
          NEOKOD_OPENCODE_ACP_EMIT_TOOL_PERMISSION: "1",
        },
      });
      const permissionRequests: Array<EffectAcpSchema.RequestPermissionRequest> = [];
      yield* runtime.handleRequestPermission((request) =>
        Effect.sync(() => {
          permissionRequests.push(request);
          return {
            outcome: { outcome: "selected" as const, optionId: "allow-once" },
          };
        }),
      );
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "run a command" }],
      });
      expect(promptResult.stopReason).toBe("end_turn");

      const events = yield* collectEvents(runtime, 5);
      expect(events.map((event) => event._tag)).toEqual([
        "ToolCallUpdated",
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const firstTool = events[0];
      const completedTool = events[1];
      if (firstTool?._tag === "ToolCallUpdated" && completedTool?._tag === "ToolCallUpdated") {
        expect(firstTool.toolCall.kind).toBe("execute");
        expect(firstTool.toolCall.command).toBe("echo fixture");
        expect(completedTool.toolCall.status).toBe("completed");
      }

      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]?.toolCall.kind).toBe("execute");
      expect(permissionRequests[0]?.options.map((option) => option.optionId)).toEqual([
        "allow-once",
        "reject-once",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns a synthetic cancelled result for a local cancel", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        extraEnvironment: { NEOKOD_OPENCODE_ACP_HANG_PROMPT: "1" },
      });
      yield* runtime.start();

      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "wait forever" }] })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("500 millis");
      yield* runtime.cancel;
      const cancelled = yield* Fiber.join(promptFiber);

      expect(cancelled.stopReason).toBe("cancelled");
      // A locally synthesised cancellation has no provider response, so it
      // cannot carry provider usage evidence.
      expect(cancelled.usage).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("passes through an agent-confirmed cancelled turn with its usage evidence", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        extraEnvironment: { NEOKOD_OPENCODE_ACP_RETURN_CANCELLED: "1" },
      });
      yield* runtime.start();

      const result = yield* runtime.prompt({
        prompt: [{ type: "text", text: "cancel without a local request" }],
      });
      expect(result).toMatchObject({
        stopReason: "cancelled",
        usage: { totalTokens: 7, inputTokens: 5, outputTokens: 2 },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces a failed prompt as a failure rather than cancellation", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        extraEnvironment: { NEOKOD_OPENCODE_ACP_FAIL_PROMPT: "1" },
      });
      yield* runtime.start();
      const error = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "fail" }] })
        .pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("loads an existing session, suppresses replay, and then streams new output", () =>
    Effect.gen(function* () {
      const { runtime, requestEvents } = yield* makeRuntime({
        resumeSessionId: "opencode-existing-session",
      });
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("opencode-existing-session");
      expect(requestEvents.some((event) => event.method === "session/load")).toBe(true);
      expect(requestEvents.some((event) => event.method === "session/new")).toBe(false);
      expect(requestEvents.some((event) => event.method === "session/resume")).toBe(false);

      yield* runtime.prompt({ prompt: [{ type: "text", text: "after load" }] });
      const events = yield* collectEvents(runtime, 3);
      expect(events.map((event) => event._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const delta = events[1];
      if (delta?._tag === "ContentDelta") {
        expect(delta.text).toBe("opencode fixture response");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces a session/load failure without falling back to a new session", () =>
    Effect.gen(function* () {
      const { runtime, requestEvents } = yield* makeRuntime({
        resumeSessionId: "opencode-failing-session",
        extraEnvironment: { NEOKOD_OPENCODE_ACP_FAIL_LOAD: "1" },
      });
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      expect(requestEvents.some((event) => event.method === "session/load")).toBe(true);
      expect(requestEvents.some((event) => event.method === "session/new")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets OpenCode 2 reject an MCP transport it does not advertise", () =>
    Effect.gen(function* () {
      const { runtime, requestEvents } = yield* makeRuntime({
        mcpServers: [
          {
            name: "unsupported-sse",
            type: "sse",
            url: "http://127.0.0.1:4319/sse",
            headers: [],
          },
        ],
      });
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      expect(requestEvents.some((event) => event.method === "session/new")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("collects model-backed review text without changing runtime ownership", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        extraEnvironment: {
          NEOKOD_OPENCODE_ACP_PROMPT_TEXT: '{"subject":"fixture","body":"ok"}',
        },
      });
      yield* runtime.start();
      yield* applyOpenCodeAcpSelection({
        runtime,
        selection: { model: "deepseek/deepseek-flash", effort: "high" },
        mapError: (cause) => cause,
      });

      const result = yield* runOpenCodeAcpTextPrompt({
        runtime,
        prompt: "Produce the review JSON.",
        mapError: (cause) => cause,
      });

      expect(result).toEqual({
        stopReason: "end_turn",
        text: '{"subject":"fixture","body":"ok"}',
        usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("excludes load replay from text generation", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        resumeSessionId: "opencode-existing-session",
        extraEnvironment: {
          NEOKOD_OPENCODE_ACP_PROMPT_TEXT: "new output",
        },
      });

      const result = yield* runOpenCodeAcpTextPrompt({
        runtime,
        prompt: "Generate after load.",
        mapError: (cause) => cause,
      });

      expect(result.text).toBe("new output");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("excludes assistant chunks from a foreign session in text generation", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime({
        extraEnvironment: {
          NEOKOD_OPENCODE_ACP_PROMPT_TEXT: "root output",
          NEOKOD_OPENCODE_ACP_EMIT_FOREIGN_SESSION_UPDATE: "1",
        },
      });
      yield* runtime.start();

      const result = yield* runOpenCodeAcpTextPrompt({
        runtime,
        prompt: "Generate without child content.",
        mapError: (cause) => cause,
      });

      expect(result.text).toBe("root output");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps child ownership inside the wrapper scope without claiming group identity", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime();
      yield* runtime.start();
      const pid = yield* runtime.pid;
      const identity = yield* runtime.identity;

      expect(pid).toBeGreaterThan(0);
      // The wrapper does not request a detached spawn. The runtime therefore
      // reports no process-group identity even though the platform spawner may
      // place the child in its own group by default.
      expect(identity).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the fixture wrapper directory when the wrapper scope ends", () =>
    Effect.gen(function* () {
      let wrapperDirectory = "";
      yield* Effect.gen(function* () {
        const made = yield* makeRuntime();
        wrapperDirectory = made.wrapperDirectory;
        yield* made.runtime.start();
      }).pipe(Effect.scoped);

      expect(wrapperDirectory).not.toBe("");
      expect(NodeFS.existsSync(wrapperDirectory)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes the fixture exit log when the wrapper scope ends", () =>
    Effect.gen(function* () {
      const logDirectory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode2-acp-exit-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFS.promises.rm(directory, { recursive: true, force: true })),
      );
      const exitLogPath = NodePath.join(logDirectory, "exit.log");

      yield* Effect.gen(function* () {
        const { runtime } = yield* makeRuntime({
          extraEnvironment: { NEOKOD_OPENCODE_ACP_EXIT_LOG_PATH: exitLogPath },
        });
        yield* runtime.start();
      }).pipe(Effect.scoped);

      const exitLog = yield* waitForFileContent(exitLogPath);
      expect(exitLog).toContain("SIGTERM");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  );
});
