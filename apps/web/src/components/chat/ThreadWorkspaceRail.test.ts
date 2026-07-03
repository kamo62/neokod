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
});

function base() {
  return {
    modelSelection: null,
    runningTerminalIds: [] as ReadonlyArray<string>,
    hasWorkspace: false,
    fleetMode: false,
  };
}
