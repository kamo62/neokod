import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { ThreadId, TurnId } from "@neokod/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  activeTurnIdAfterStart,
  buildTurnStartParams,
  type CodexServerNotification,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  openCodexThread,
  rememberChildThreadTurns,
  shouldApplyParentTurnCompletion,
  shouldSuppressChildConversationNotification,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

describe("activeTurnIdAfterStart", () => {
  it("keeps the active id when Codex accepts a queued follow-up", () => {
    const active = TurnId.make("turn-active");
    const queued = TurnId.make("turn-queued");

    NodeAssert.equal(activeTurnIdAfterStart(active, queued), active);
    NodeAssert.equal(activeTurnIdAfterStart(undefined, queued), queued);
  });
});

function subAgentActivityNotification(input: {
  readonly method: "item/started" | "item/completed";
  readonly kind: "started" | "interacted" | "interrupted";
}): CodexServerNotification {
  const item = {
    agentPath: "/root/fixture_child_a",
    agentThreadId: "child-thread-fixture-a",
    id: "call_fixture_a",
    kind: input.kind,
    type: "subAgentActivity",
  } as const;
  return input.method === "item/started"
    ? {
        method: "item/started",
        params: {
          item,
          startedAtMs: 1_778_000_000_000,
          threadId: "parent-thread",
          turnId: "parent-turn",
        },
      }
    : {
        method: "item/completed",
        params: {
          completedAtMs: 1_778_000_000_000,
          item,
          threadId: "parent-thread",
          turnId: "parent-turn",
        },
      };
}

describe("rememberChildThreadTurns", () => {
  it("retains the child thread of a new-shape subAgentActivity start", () => {
    const childThreadTurns = new Map<string, TurnId>();

    rememberChildThreadTurns(
      childThreadTurns,
      subAgentActivityNotification({ method: "item/started", kind: "started" }),
      TurnId.make("parent-turn"),
    );

    NodeAssert.deepStrictEqual(
      [...childThreadTurns],
      [["child-thread-fixture-a", TurnId.make("parent-turn")]],
    );
  });

  it("retains every receiver of the older collabAgentToolCall shape", () => {
    const childThreadTurns = new Map<string, TurnId>();
    const notification: CodexServerNotification = {
      method: "item/started",
      params: {
        item: {
          agentsStates: {},
          id: "call_collab_fixture",
          receiverThreadIds: ["old-child-a", "old-child-b"],
          senderThreadId: "parent-thread",
          status: "inProgress",
          tool: "spawnAgent",
          type: "collabAgentToolCall",
        },
        startedAtMs: 1_778_000_000_000,
        threadId: "parent-thread",
        turnId: "parent-turn",
      },
    };

    rememberChildThreadTurns(childThreadTurns, notification, TurnId.make("parent-turn"));

    NodeAssert.deepStrictEqual(
      [...childThreadTurns],
      [
        ["old-child-a", TurnId.make("parent-turn")],
        ["old-child-b", TurnId.make("parent-turn")],
      ],
    );
  });

  it("does not invent child identity from a non-start subAgentActivity", () => {
    const childThreadTurns = new Map<string, TurnId>();

    rememberChildThreadTurns(
      childThreadTurns,
      subAgentActivityNotification({ method: "item/completed", kind: "interacted" }),
      TurnId.make("parent-turn"),
    );
    rememberChildThreadTurns(
      childThreadTurns,
      subAgentActivityNotification({ method: "item/started", kind: "started" }),
      undefined,
    );

    NodeAssert.deepStrictEqual([...childThreadTurns], []);
  });
});

describe("shouldSuppressChildConversationNotification", () => {
  it("forwards a child terminal so the adapter can close its task", () => {
    NodeAssert.equal(shouldSuppressChildConversationNotification("turn/completed"), false);
    NodeAssert.equal(shouldSuppressChildConversationNotification("item/completed"), false);
  });

  it("still suppresses child lifecycle and thread-level notifications", () => {
    NodeAssert.equal(shouldSuppressChildConversationNotification("turn/started"), true);
    NodeAssert.equal(shouldSuppressChildConversationNotification("thread/status/changed"), true);
    NodeAssert.equal(shouldSuppressChildConversationNotification("thread/started"), true);
  });
});

describe("shouldApplyParentTurnCompletion", () => {
  const childThreadTurns = new Map([["child-thread-fixture-a", TurnId.make("parent-turn")]]);

  it("rejects a registered child completion before the parent thread id is known", () => {
    NodeAssert.equal(
      shouldApplyParentTurnCompletion({
        providerThreadId: undefined,
        completedThreadId: "child-thread-fixture-a",
        childThreadTurns,
      }),
      false,
    );
  });

  it("rejects a child or unrelated thread completion when the parent is known", () => {
    NodeAssert.equal(
      shouldApplyParentTurnCompletion({
        providerThreadId: "parent-thread",
        completedThreadId: "child-thread-fixture-a",
        childThreadTurns,
      }),
      false,
    );
    NodeAssert.equal(
      shouldApplyParentTurnCompletion({
        providerThreadId: "parent-thread",
        completedThreadId: "unrelated-thread",
        childThreadTurns: new Map(),
      }),
      false,
    );
  });

  it("accepts only the exact parent thread completion", () => {
    NodeAssert.equal(
      shouldApplyParentTurnCompletion({
        providerThreadId: "parent-thread",
        completedThreadId: "parent-thread",
        childThreadTurns: new Map(),
      }),
      true,
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );
});

describe("Neokod browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /neokod/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.neokod.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
