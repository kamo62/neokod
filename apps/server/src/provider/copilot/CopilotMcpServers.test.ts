import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CopilotSettings } from "@t3tools/contracts";

import { resolveCopilotMcpServers } from "./CopilotMcpServers.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("resolveCopilotMcpServers", () => {
  it("returns undefined for empty settings", () => {
    NodeAssert.equal(resolveCopilotMcpServers(decodeCopilotSettings({})), undefined);
  });

  it("injects the AI-Orch MCP gateway from managed evidence settings", () => {
    const settings = decodeCopilotSettings({
      managedClientEvidence: {
        // Gateway injection is gated on `gatewayEnabled`, independent of the
        // `enabled` recording flag (which stays false here to prove decoupling).
        gatewayEnabled: true,
        governanceUrl: "https://governance.example/",
        credential: "air_test",
      },
    });

    NodeAssert.deepEqual(resolveCopilotMcpServers(settings), {
      "ai-orch": {
        type: "http",
        url: "https://governance.example/mcp",
        headers: { Authorization: "Bearer air_test" },
        tools: ["*"],
      },
    });
  });

  it("does not inject the AI-Orch MCP gateway when only recording is enabled", () => {
    const settings = decodeCopilotSettings({
      // Recording on, gateway off → no gateway in the request path.
      managedClientEvidence: {
        enabled: true,
        governanceUrl: "https://governance.example",
        credential: "air_test",
      },
    });

    NodeAssert.equal(resolveCopilotMcpServers(settings), undefined);
  });

  it("does not inject the AI-Orch MCP gateway without a credential", () => {
    const settings = decodeCopilotSettings({
      managedClientEvidence: {
        gatewayEnabled: true,
        governanceUrl: "https://governance.example",
      },
    });

    NodeAssert.equal(resolveCopilotMcpServers(settings), undefined);
  });

  it("lets user servers override org presets by name", () => {
    const settings = decodeCopilotSettings({
      mcpServers: {
        gateway: {
          command: "copilot-mcp",
          args: ["serve"],
          tools: ["*"],
        },
        user_only: {
          type: "http",
          url: "https://user.example/mcp",
          headers: { Authorization: "Bearer user" },
        },
      },
    });

    const resolved = resolveCopilotMcpServers(settings, {
      gateway: {
        type: "http",
        url: "https://preset.example/mcp",
        headers: { Authorization: "Bearer preset" },
        tools: ["preset"],
      },
      preset_only: {
        type: "sse",
        url: "https://preset.example/sse",
      },
    });

    NodeAssert.deepEqual(resolved, {
      gateway: {
        command: "copilot-mcp",
        args: ["serve"],
        tools: ["*"],
      },
      preset_only: {
        type: "sse",
        url: "https://preset.example/sse",
      },
      user_only: {
        type: "http",
        url: "https://user.example/mcp",
        headers: { Authorization: "Bearer user" },
      },
    });
  });

  it("lets user servers override the AI-Orch MCP gateway by name", () => {
    const settings = decodeCopilotSettings({
      managedClientEvidence: {
        gatewayEnabled: true,
        governanceUrl: "https://governance.example",
        credential: "air_test",
      },
      mcpServers: {
        "ai-orch": {
          type: "http",
          url: "https://user.example/mcp",
        },
      },
    });

    NodeAssert.deepEqual(resolveCopilotMcpServers(settings), {
      "ai-orch": {
        type: "http",
        url: "https://user.example/mcp",
      },
    });
  });

  it("drops servers explicitly disabled via `enabled: false`", () => {
    const settings = decodeCopilotSettings({
      mcpServers: {
        on: { type: "http", url: "https://on.example/mcp" },
        off: { type: "http", url: "https://off.example/mcp", enabled: false },
      },
    });

    NodeAssert.deepEqual(resolveCopilotMcpServers(settings), {
      on: { type: "http", url: "https://on.example/mcp" },
    });
  });

  it("keeps servers that omit `enabled` or set it true, and never forwards the flag", () => {
    const settings = decodeCopilotSettings({
      mcpServers: {
        implicit: { type: "http", url: "https://implicit.example/mcp" },
        explicit: { type: "http", url: "https://explicit.example/mcp", enabled: true },
      },
    });

    const resolved = resolveCopilotMcpServers(settings);
    NodeAssert.deepEqual(resolved, {
      implicit: { type: "http", url: "https://implicit.example/mcp" },
      explicit: { type: "http", url: "https://explicit.example/mcp" },
    });
    // `enabled` is a fork-owned UI flag and must never reach the SDK config.
    NodeAssert.equal("enabled" in (resolved?.explicit ?? {}), false);
  });
});
