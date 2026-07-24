// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeOS from "node:os";
import { describe, it, vi } from "vite-plus/test";

import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@neokod/contracts";

import {
  collectClientIdentity,
  evidenceFromOrchestrationEvent,
  evidenceFromProviderRuntimeEvent,
  makeManagedClientEvidenceBatch,
  sha256EvidenceContent,
  withClientIdentity,
  type ManagedClientEvidenceRepoContext,
} from "./ManagedClientEvidence.ts";

// `vi.spyOn` can't redefine a live ESM namespace export, so `userInfo()`
// failure/override is modeled through a hoisted interceptor the mock
// factory reads on every call instead — everything else on `node:os`
// (notably `hostname()`) passes through to the real implementation.
const userInfoInterceptor = vi.hoisted(() => ({
  mode: "real" as "real" | "throw" | "value",
  value: undefined as { readonly username: string } | undefined,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: (...args: Parameters<typeof actual.userInfo>) => {
      if (userInfoInterceptor.mode === "throw") {
        throw new Error("no passwd entry for uid");
      }
      if (userInfoInterceptor.mode === "value" && userInfoInterceptor.value) {
        return userInfoInterceptor.value as ReturnType<typeof actual.userInfo>;
      }
      return actual.userInfo(...args);
    },
  };
});

const COPILOT_DRIVER = ProviderDriverKind.make("githubCopilot");
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");
const CREATED_AT = "2026-07-02T10:00:00.000Z";

const eventId = (value: string): EventId => EventId.make(value);

const runtimeBase = (
  id: string,
): Pick<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt"> => ({
  eventId: eventId(id),
  provider: COPILOT_DRIVER,
  threadId: THREAD_ID,
  createdAt: CREATED_AT,
});

const domainBase = (
  id: string,
): Pick<
  OrchestrationEvent,
  | "sequence"
  | "eventId"
  | "aggregateKind"
  | "aggregateId"
  | "occurredAt"
  | "commandId"
  | "causationEventId"
  | "correlationId"
  | "metadata"
> => ({
  sequence: 1,
  eventId: eventId(id),
  aggregateKind: "thread",
  aggregateId: THREAD_ID,
  occurredAt: CREATED_AT,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

describe("ManagedClientEvidence", () => {
  it("maps Copilot session starts to managed-client session evidence", () => {
    const repo: ManagedClientEvidenceRepoContext = {
      remote: "https://user:secret@github.com/acme/app.git",
      branch: "feature/managed-client",
      commit: "abc123",
    };
    const event: Extract<ProviderRuntimeEvent, { type: "session.started" }> = {
      ...runtimeBase("evt-session-start"),
      type: "session.started",
      payload: {},
    };

    NodeAssert.deepEqual(evidenceFromProviderRuntimeEvent(event, repo), {
      event_id: "evt-session-start",
      schema_version: "v0",
      client: "neokod",
      client_session_id: "thread-1",
      event_type: "session_start",
      timestamp: CREATED_AT,
      repo: {
        remote: "https://github.com/acme/app.git",
        branch: "feature/managed-client",
        commit: "abc123",
      },
    });
  });

  it("maps user messages to prompt hashes by default", () => {
    const event: Extract<OrchestrationEvent, { type: "thread.message-sent" }> = {
      ...domainBase("evt-prompt"),
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "please inspect the diff",
        turnId: null,
        streaming: false,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    };

    NodeAssert.deepEqual(evidenceFromOrchestrationEvent(event), {
      event_id: "evt-prompt",
      schema_version: "v0",
      client: "neokod",
      client_session_id: "thread-1",
      event_type: "prompt",
      timestamp: CREATED_AT,
      content_sha256: sha256EvidenceContent("please inspect the diff"),
    });
  });

  it("maps completed assistant items to assistant message hashes", () => {
    const event: Extract<ProviderRuntimeEvent, { type: "item.completed" }> = {
      ...runtimeBase("evt-assistant"),
      type: "item.completed",
      turnId: TURN_ID,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Done. I patched the tests.",
      },
    };

    NodeAssert.deepEqual(evidenceFromProviderRuntimeEvent(event), {
      event_id: "evt-assistant",
      schema_version: "v0",
      client: "neokod",
      client_session_id: "thread-1",
      event_type: "assistant_message",
      timestamp: CREATED_AT,
      content_sha256: sha256EvidenceContent("Done. I patched the tests."),
    });
  });

  it("maps tool completion and approval resolution to evidence events", () => {
    const toolEvent: Extract<ProviderRuntimeEvent, { type: "item.completed" }> = {
      ...runtimeBase("evt-tool"),
      type: "item.completed",
      turnId: TURN_ID,
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "bun test",
      },
    };
    const permissionEvent: Extract<ProviderRuntimeEvent, { type: "request.resolved" }> = {
      ...runtimeBase("evt-permission"),
      type: "request.resolved",
      payload: {
        requestType: "command_execution_approval",
        decision: "approved",
        resolution: { command: "bun test" },
      },
    };

    NodeAssert.deepEqual(evidenceFromProviderRuntimeEvent(toolEvent), {
      event_id: "evt-tool",
      schema_version: "v0",
      client: "neokod",
      client_session_id: "thread-1",
      event_type: "tool_execution",
      timestamp: CREATED_AT,
      tool: {
        name: "bun test",
        ended_at: CREATED_AT,
        status: "ok",
      },
    });
    NodeAssert.deepEqual(evidenceFromProviderRuntimeEvent(permissionEvent), {
      event_id: "evt-permission",
      schema_version: "v0",
      client: "neokod",
      client_session_id: "thread-1",
      event_type: "permission_decision",
      timestamp: CREATED_AT,
      permission_decision: {
        command: "bun test",
        decision: "approved",
        decider: "user",
        reason: "approved",
      },
    });
  });

  it("maps SDK permission completion results to evidence decisions", () => {
    const permissionEvent: Extract<ProviderRuntimeEvent, { type: "request.resolved" }> = {
      ...runtimeBase("evt-sdk-permission"),
      type: "request.resolved",
      payload: {
        requestType: "command_execution_approval",
        resolution: { kind: "approved" },
      },
    };

    NodeAssert.deepEqual(evidenceFromProviderRuntimeEvent(permissionEvent), {
      event_id: "evt-sdk-permission",
      schema_version: "v0",
      client: "neokod",
      client_session_id: "thread-1",
      event_type: "permission_decision",
      timestamp: CREATED_AT,
      permission_decision: {
        tool: "command_execution_approval",
        decision: "approved",
        decider: "user",
      },
    });
  });

  it("maps token usage and ignores streaming deltas", () => {
    const usageEvent: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> = {
      ...runtimeBase("evt-usage"),
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 30,
          lastInputTokens: 10,
          lastOutputTokens: 20,
        },
      },
    };
    const deltaEvent: Extract<ProviderRuntimeEvent, { type: "content.delta" }> = {
      ...runtimeBase("evt-delta"),
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    };

    NodeAssert.deepEqual(evidenceFromProviderRuntimeEvent(usageEvent), {
      event_id: "evt-usage",
      schema_version: "v0",
      client: "neokod",
      client_session_id: "thread-1",
      event_type: "token_usage",
      timestamp: CREATED_AT,
      token_usage: {
        input_tokens: 10,
        output_tokens: 20,
        source: "client_reported",
      },
    });
    NodeAssert.equal(evidenceFromProviderRuntimeEvent(deltaEvent), undefined);
  });

  it("caps batch envelopes at the endpoint limit", () => {
    const event: Extract<ProviderRuntimeEvent, { type: "session.started" }> = {
      ...runtimeBase("evt-session-start"),
      type: "session.started",
      payload: {},
    };
    const evidence = evidenceFromProviderRuntimeEvent(event);
    if (!evidence) throw new Error("expected evidence");

    NodeAssert.equal(
      makeManagedClientEvidenceBatch(Array<NonNullable<typeof evidence>>(51).fill(evidence)).events
        .length,
      50,
    );
  });

  describe("collectClientIdentity", () => {
    it("collects v1, hostname, and the supplied platform, and trims/omits a blank github login", () => {
      const identity = collectClientIdentity("linux", "  ");

      NodeAssert.equal(identity.v, 1);
      NodeAssert.equal(identity.hostname, NodeOS.hostname());
      NodeAssert.equal(identity.os_platform, "linux");
      NodeAssert.equal(identity.github_login, undefined);
    });

    it("includes a trimmed github_login when supplied", () => {
      const identity = collectClientIdentity("linux", "  octocat  ");

      NodeAssert.equal(identity.github_login, "octocat");
    });

    it("omits os_username but keeps the rest of the identity when userInfo() throws", () => {
      userInfoInterceptor.mode = "throw";

      try {
        const identity = collectClientIdentity("darwin");

        NodeAssert.equal(identity.v, 1);
        NodeAssert.equal("os_username" in identity, false);
        NodeAssert.equal(identity.hostname, NodeOS.hostname());
        NodeAssert.equal(identity.os_platform, "darwin");
      } finally {
        userInfoInterceptor.mode = "real";
      }
    });

    it("includes a trimmed os_username when userInfo() succeeds", () => {
      userInfoInterceptor.mode = "value";
      userInfoInterceptor.value = { username: "jdoe" };

      try {
        const identity = collectClientIdentity("darwin");
        NodeAssert.equal(identity.os_username, "jdoe");
      } finally {
        userInfoInterceptor.mode = "real";
        userInfoInterceptor.value = undefined;
      }
    });
  });

  describe("withClientIdentity", () => {
    it("attaches client_identity alongside events without altering the events array", () => {
      const batch = makeManagedClientEvidenceBatch([]);
      const identity = collectClientIdentity("linux");

      const withIdentity = withClientIdentity(batch, identity);

      NodeAssert.deepEqual(withIdentity.events, batch.events);
      NodeAssert.deepEqual(withIdentity.client_identity, identity);
    });
  });
});
