import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@neokod/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });

  it("supports the terminal and diff built-in commands", () => {
    const items = [
      {
        id: "slash:terminal",
        type: "slash-command",
        command: "terminal",
        label: "/terminal",
        description: "Open this thread's terminal",
      },
      {
        id: "slash:diff",
        type: "slash-command",
        command: "diff",
        label: "/diff",
        description: "Open this thread's diff",
      },
      {
        id: "slash:files",
        type: "slash-command",
        command: "files",
        label: "/files",
        description: "Open this thread's files",
      },
      {
        id: "slash:subagents",
        type: "slash-command",
        command: "subagents",
        label: "/subagents",
        description: "Open this thread's subagent activity",
      },
      {
        id: "slash:mission",
        type: "slash-command",
        command: "mission",
        label: "/mission",
        description: "Open cross-project agent activity",
      },
      {
        id: "slash:goal",
        type: "slash-command",
        command: "goal",
        label: "/goal",
        description: "Set or edit this thread's goal",
      },
      {
        id: "slash:fleet",
        type: "slash-command",
        command: "fleet",
        label: "/fleet",
        description: "Open Copilot fleet & agent controls",
      },
      {
        id: "slash:mcp",
        type: "slash-command",
        command: "mcp",
        label: "/mcp",
        description: "View and enable/disable Copilot MCP servers",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "slash-command" }>>;

    expect(searchSlashCommandItems(items, "term").map((item) => item.id)).toEqual([
      "slash:terminal",
    ]);
    expect(searchSlashCommandItems(items, "df").map((item) => item.id)).toEqual(["slash:diff"]);
    expect(searchSlashCommandItems(items, "files").map((item) => item.id)).toEqual(["slash:files"]);
    expect(searchSlashCommandItems(items, "subagent").map((item) => item.id)).toEqual([
      "slash:subagents",
    ]);
    expect(searchSlashCommandItems(items, "mission").map((item) => item.id)).toEqual([
      "slash:mission",
    ]);
    expect(searchSlashCommandItems(items, "goal").map((item) => item.id)).toEqual(["slash:goal"]);
    expect(searchSlashCommandItems(items, "fleet").map((item) => item.id)).toEqual(["slash:fleet"]);
    expect(searchSlashCommandItems(items, "mcp").map((item) => item.id)).toEqual(["slash:mcp"]);
  });
});
