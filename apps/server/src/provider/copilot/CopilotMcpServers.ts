import type { MCPServerConfig } from "@github/copilot-sdk";
import type { CopilotMcpServers, CopilotSettings } from "@neokod/contracts";

// The settings schema mirrors the SDK union but its optional keys admit an
// explicit `undefined` (Effect Schema optionals under
// `exactOptionalPropertyTypes`), so the SDK type is assignable to it while
// the reverse is not. Copying field-by-field below converts either shape
// into a clean SDK `MCPServerConfig`.
type CopilotMcpServerSetting = CopilotMcpServers[string] | MCPServerConfig;

// AI-Orch's shared MCP gateway will be injected here once the governance
// settings path is wired up. User-defined servers override presets by name.
export const COPILOT_ORG_MCP_PRESETS: Readonly<Record<string, MCPServerConfig>> = {};
const AI_ORCH_MCP_SERVER_NAME = "ai-orch";

function aiOrchMcpServerFromSettings(settings: CopilotSettings): MCPServerConfig | undefined {
  const evidence = settings.managedClientEvidence;
  // Gated on `gatewayEnabled` (the active routing role), NOT `enabled` (passive
  // recording). This is the recorder/gateway decoupling: turning on evidence
  // recording no longer pulls the AI-Orch MCP gateway into the request path.
  if (!evidence.gatewayEnabled || !evidence.governanceUrl || !evidence.credential) {
    return undefined;
  }

  return {
    type: "http",
    url: `${evidence.governanceUrl.replace(/\/+$/, "")}/mcp`,
    headers: { Authorization: `Bearer ${evidence.credential}` },
    tools: ["*"],
  };
}

function copyMcpServerConfig(config: CopilotMcpServerSetting): MCPServerConfig {
  switch (config.type) {
    case "http":
    case "sse":
      return {
        type: config.type,
        url: config.url,
        ...(config.headers ? { headers: { ...config.headers } } : {}),
        ...(config.tools ? { tools: [...config.tools] } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      };
    default:
      return {
        ...(config.type ? { type: config.type } : {}),
        command: config.command,
        ...(config.args ? { args: [...config.args] } : {}),
        ...(config.env ? { env: { ...config.env } } : {}),
        ...(config.workingDirectory !== undefined
          ? { workingDirectory: config.workingDirectory }
          : {}),
        ...(config.tools ? { tools: [...config.tools] } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      };
  }
}

export function copyCopilotMcpServerConfigs(
  configs: Readonly<Record<string, CopilotMcpServerSetting>>,
): Record<string, MCPServerConfig> {
  const copied: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(configs)) {
    copied[name] = copyMcpServerConfig(config);
  }
  return copied;
}

/** A server is active unless it has been explicitly disabled (`enabled: false`). */
export function isCopilotMcpServerEnabled(config: CopilotMcpServerSetting): boolean {
  return (config as { enabled?: boolean }).enabled !== false;
}

export function resolveCopilotMcpServers(
  settings: CopilotSettings,
  orgPresets: Readonly<Record<string, MCPServerConfig>> = COPILOT_ORG_MCP_PRESETS,
): Record<string, MCPServerConfig> | undefined {
  const merged: Record<string, MCPServerConfig> = {};

  Object.assign(merged, copyCopilotMcpServerConfigs(orgPresets));
  const aiOrchMcpServer = aiOrchMcpServerFromSettings(settings);
  if (aiOrchMcpServer) {
    merged[AI_ORCH_MCP_SERVER_NAME] = aiOrchMcpServer;
  }
  // Disabled servers are dropped here so a `/mcp` toggle takes effect on the
  // next session without deleting the user's saved config.
  const enabledUserServers = Object.fromEntries(
    Object.entries(settings.mcpServers).filter(([, config]) => isCopilotMcpServerEnabled(config)),
  );
  Object.assign(merged, copyCopilotMcpServerConfigs(enabledUserServers));

  return Object.keys(merged).length > 0 ? merged : undefined;
}
