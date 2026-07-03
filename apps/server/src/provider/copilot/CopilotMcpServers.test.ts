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
        enabled: true,
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

  it("does not inject the AI-Orch MCP gateway without a credential", () => {
    const settings = decodeCopilotSettings({
      managedClientEvidence: {
        enabled: true,
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
        enabled: true,
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
});
