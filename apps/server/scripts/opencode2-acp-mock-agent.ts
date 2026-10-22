#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
//
// Deterministic ACP fixture shaped from OpenCode 2.0.32 receipts. It is not the
// OpenCode CLI and does not contact a provider. It exists so the shared
// AcpSessionRuntime can be exercised against the methods and update shapes
// OpenCode 2.0.32 actually exposes.
//
// Kept separate from scripts/acp-mock-agent.ts on purpose: that fixture models
// Cursor/Grok auth, mode and config-option shapes and is shared by many existing
// tests. OpenCode 2.0.32 differs in auth methods, absent `modes`, the
// model/effort/mode config-option set, `session/set_model` being unsupported and
// its MCP transport filter. Adding those as switches would change a shared
// fixture's defaults for unrelated providers.
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const exitLogPath = process.env.NEOKOD_OPENCODE_ACP_EXIT_LOG_PATH;
const emitToolPermission = process.env.NEOKOD_OPENCODE_ACP_EMIT_TOOL_PERMISSION === "1";
const hangPrompt = process.env.NEOKOD_OPENCODE_ACP_HANG_PROMPT === "1";
const returnCancelled = process.env.NEOKOD_OPENCODE_ACP_RETURN_CANCELLED === "1";
const failPrompt = process.env.NEOKOD_OPENCODE_ACP_FAIL_PROMPT === "1";
const failLoadSession = process.env.NEOKOD_OPENCODE_ACP_FAIL_LOAD === "1";
const emitForeignSessionUpdate =
  process.env.NEOKOD_OPENCODE_ACP_EMIT_FOREIGN_SESSION_UPDATE === "1";
const promptResponseText =
  process.env.NEOKOD_OPENCODE_ACP_PROMPT_TEXT ?? "opencode fixture response";

const advertisedAuthMethodIds: ReadonlyArray<string> = (
  process.env.NEOKOD_OPENCODE_ACP_AUTH_METHOD_IDS ?? "opencode-login"
)
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

const sessionId = "mock-opencode2-session-1";
const defaultModelId = "opencode/minimax-m3.1-flash-free";

const modelOptions: ReadonlyArray<{ readonly value: string; readonly name: string }> = [
  { value: defaultModelId, name: "MiniMax M3.1 Flash Free" },
  { value: "deepseek/deepseek-flash", name: "DeepSeek V4.1 Flash" },
  { value: "azure/claude-opus-5-5", name: "Claude Opus 5.5" },
];

const effortValuesByModel: Readonly<Record<string, ReadonlyArray<string>>> = {
  [defaultModelId]: ["low", "medium", "high", "xhigh", "max", "default"],
  "deepseek/deepseek-flash": ["none", "low", "high", "max", "default"],
  "azure/claude-opus-5-5": ["low", "medium", "high", "default"],
};

const modeValues = ["build", "plan"] as const;

let currentModelId = defaultModelId;
let currentEffort = "default";
let currentMode = "build";

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

// The ACP client closes stdin during shutdown. Exit promptly so the wrapper's
// cleanup test observes the fixture's own exit evidence rather than a fallback
// kill timeout.
process.stdin.once("end", () => {
  logExit("stdin-end");
  process.exit(0);
});

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const effortValues = effortValuesByModel[currentModelId] ?? ["default"];
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: modelOptions,
    },
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: effortValues.map((value) => ({ value, name: value })),
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: modeValues.map((value) => ({ value, name: value })),
    },
  ];
}

function validateMcpServers(
  servers: ReadonlyArray<AcpSchema.McpServer>,
): Effect.Effect<void, AcpError.AcpRequestError> {
  return Effect.gen(function* () {
    for (const server of servers) {
      if ("type" in server && server.type !== "http") {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Only stdio and HTTP MCP servers are supported",
          {
            field: "mcpServers",
            serverName: server.name,
            serverType: server.type,
          },
        );
      }
    }
  });
}

function applyConfigValue(
  configId: string,
  value: string,
): Effect.Effect<void, AcpError.AcpRequestError> {
  switch (configId) {
    case "model": {
      if (!modelOptions.some((option) => option.value === value)) {
        return Effect.fail(
          AcpError.AcpRequestError.invalidParams(`Unknown model id: ${value}`, {
            configId,
            requestedValue: value,
          }),
        );
      }
      currentModelId = value;
      const allowedEffort = effortValuesByModel[value] ?? ["default"];
      if (!allowedEffort.includes(currentEffort)) {
        currentEffort = "default";
      }
      return Effect.void;
    }
    case "effort": {
      const allowedEffort = effortValuesByModel[currentModelId] ?? ["default"];
      if (!allowedEffort.includes(value)) {
        return Effect.fail(
          AcpError.AcpRequestError.invalidParams(`Unknown effort: ${value}`, {
            configId,
            requestedValue: value,
            allowedValues: allowedEffort,
          }),
        );
      }
      currentEffort = value;
      return Effect.void;
    }
    case "mode": {
      if (!modeValues.some((mode) => mode === value)) {
        return Effect.fail(
          AcpError.AcpRequestError.invalidParams(`Unknown mode: ${value}`, {
            configId,
            requestedValue: value,
            allowedValues: modeValues,
          }),
        );
      }
      currentMode = value;
      return Effect.void;
    }
    default:
      return Effect.fail(
        AcpError.AcpRequestError.invalidParams(`Unsupported config option: ${configId}`, {
          configId,
        }),
      );
  }
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
        },
        _meta: {
          "opencode/child-session-updates": true,
        },
      },
      authMethods: advertisedAuthMethodIds.map((id) => ({ id, name: id })),
      agentInfo: {
        name: "OpenCode",
        version: "2.0.32",
      },
    }),
  );

  yield* agent.handleAuthenticate((request) =>
    request.methodId === "opencode-login"
      ? Effect.succeed({})
      : Effect.fail(
          AcpError.AcpRequestError.invalidParams(`Unknown auth method: ${request.methodId}`, {
            methodId: request.methodId,
          }),
        ),
  );

  yield* agent.handleCreateSession((request) =>
    Effect.gen(function* () {
      yield* validateMcpServers(request.mcpServers);
      return {
        sessionId,
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      yield* validateMcpServers(request.mcpServers);
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (failLoadSession) {
        return yield* AcpError.AcpRequestError.internalError("Mock load session failure");
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        _meta: { isReplay: true },
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed assistant text" },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replayed user text" },
        },
      });
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (typeof request.value !== "string") {
        return yield* AcpError.AcpRequestError.invalidParams(
          `OpenCode ACP requires string config values: ${request.configId}`,
          {
            configId: request.configId,
            requestedValue: request.value,
          },
        );
      }
      yield* applyConfigValue(request.configId, request.value);
      const nextConfigOptions = configOptions();
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: nextConfigOptions,
        },
      });
      return {
        configOptions: nextConfigOptions,
      };
    }),
  );

  // OpenCode 2.0.32's ACP service does not register session/set_model.
  yield* agent.handleSetSessionModel(() =>
    Effect.fail(AcpError.AcpRequestError.methodNotFound("session/set_model")),
  );

  yield* agent.handleCancel(() => Effect.void);

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);

      if (hangPrompt) {
        return yield* Effect.never;
      }

      if (failPrompt) {
        return yield* AcpError.AcpRequestError.internalError("Mock prompt failure");
      }

      if (returnCancelled) {
        return {
          stopReason: "cancelled",
          usage: {
            totalTokens: 7,
            inputTokens: 5,
            outputTokens: 2,
          },
        };
      }

      if (emitToolPermission) {
        const toolCallId = "opencode-tool-call-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "shell",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "fixture"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permission = yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId,
            title: "shell",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "fixture"],
            },
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });

        const outcome = permission.outcome;
        if (outcome.outcome === "cancelled") {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "failed",
              rawOutput: { reason: "cancelled" },
            },
          });
          return { stopReason: "cancelled" };
        }

        const rejected = outcome.optionId === "reject-once";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: rejected ? "failed" : "completed",
            ...(rejected
              ? { rawOutput: { reason: "rejected" } }
              : { rawOutput: { exitCode: 0, stdout: "fixture", stderr: "" } }),
          },
        });
        if (rejected) {
          return { stopReason: "end_turn" };
        }
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "fixture reasoning is intentionally ignored" },
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "review", description: "review changes" }],
        },
      });

      if (emitForeignSessionUpdate) {
        yield* agent.client.sessionUpdate({
          sessionId: "mock-opencode2-child-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "foreign session text" },
          },
        });
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText },
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 128,
          size: 1048576,
          cost: { amount: 0.0001, currency: "USD" },
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: "fixture session",
        },
      });

      return {
        stopReason: "end_turn",
        usage: {
          totalTokens: 42,
          inputTokens: 30,
          outputTokens: 12,
        },
      };
    }),
  );

  return yield* Effect.never;
}).pipe(
  Effect.provide(EffectAcpAgent.layerStdio()),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
