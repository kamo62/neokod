import { expect, it } from "vite-plus/test";
import type { CopilotCustomAgents } from "@neokod/contracts/settings";
import { buildAgentOptions } from "./CopilotThreadControls";

it("buildAgentOptions prepends a Default option with empty value", () => {
  expect(buildAgentOptions([] as unknown as CopilotCustomAgents)).toEqual([
    { value: "", label: "Default" },
  ]);
});

it("buildAgentOptions prefers displayName and falls back to name", () => {
  const agents = [
    { name: "reviewer", displayName: "Code Reviewer", prompt: "" },
    { name: "fixer", prompt: "" },
  ] as unknown as CopilotCustomAgents;

  expect(buildAgentOptions(agents)).toEqual([
    { value: "", label: "Default" },
    { value: "reviewer", label: "Code Reviewer" },
    { value: "fixer", label: "fixer" },
  ]);
});
