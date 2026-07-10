import { describe, expect, it } from "vite-plus/test";
import { resolveThreadWorkspaceRailView } from "./ThreadWorkspaceRail";

const model = (slug: string) => ({ instanceId: "codex", model: slug }) as never;

describe("resolveThreadWorkspaceRailView", () => {
  it("surfaces the active model slug, or null when unset", () => {
    expect(resolveThreadWorkspaceRailView(base()).modelLabel).toBeNull();
    expect(
      resolveThreadWorkspaceRailView({ ...base(), modelSelection: model("gpt-5.4") }).modelLabel,
    ).toBe("gpt-5.4");
  });

  it("only reports a terminal indicator when ids are running", () => {
    expect(resolveThreadWorkspaceRailView(base()).terminal).toBeNull();
    const running = resolveThreadWorkspaceRailView({ ...base(), runningTerminalIds: ["t1"] });
    expect(running.terminal).not.toBeNull();
    expect(running.terminal?.pulse).toBe(true);
  });

  it("gates the diff surface on having a workspace", () => {
    expect(resolveThreadWorkspaceRailView({ ...base(), hasWorkspace: false }).showDiff).toBe(false);
    expect(resolveThreadWorkspaceRailView({ ...base(), hasWorkspace: true }).showDiff).toBe(true);
  });

  it("shows the fleet chip only when fleet mode is enabled", () => {
    expect(resolveThreadWorkspaceRailView({ ...base(), fleetMode: false }).showFleet).toBe(false);
    expect(resolveThreadWorkspaceRailView({ ...base(), fleetMode: true }).showFleet).toBe(true);
  });

  it("hides governance when the thread is not using Copilot", () => {
    expect(
      resolveThreadWorkspaceRailView({
        ...base(),
        usesCopilot: false,
        managedClientEvidence: { enabled: true, gatewayEnabled: true },
      }).governance,
    ).toBeNull();
  });

  it("hides governance when evidence recording is disabled", () => {
    expect(
      resolveThreadWorkspaceRailView({
        ...base(),
        usesCopilot: true,
        managedClientEvidence: { enabled: false, gatewayEnabled: true },
      }).governance,
    ).toBeNull();
  });

  it("shows the configured evidence-recording state", () => {
    expect(
      resolveThreadWorkspaceRailView({
        ...base(),
        usesCopilot: true,
        managedClientEvidence: { enabled: true, gatewayEnabled: false },
      }).governance,
    ).toEqual({
      label: "Evidence recording",
      tooltip: "AI-Orch evidence recording configured",
      variant: "recording",
    });
  });

  it("shows the configured evidence and MCP gateway state", () => {
    expect(
      resolveThreadWorkspaceRailView({
        ...base(),
        usesCopilot: true,
        managedClientEvidence: { enabled: true, gatewayEnabled: true },
      }).governance,
    ).toEqual({
      label: "Evidence + MCP gateway",
      tooltip: "Evidence recording + MCP gateway routing configured",
      variant: "gateway",
    });
  });
});

function base() {
  return {
    modelSelection: null,
    runningTerminalIds: [] as ReadonlyArray<string>,
    hasWorkspace: false,
    fleetMode: false,
    usesCopilot: false,
    managedClientEvidence: { enabled: false, gatewayEnabled: false },
  };
}
