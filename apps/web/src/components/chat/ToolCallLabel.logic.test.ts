import { describe, expect, it } from "vite-plus/test";
import { deriveToolCallLabel, deriveToolCallResultSummary } from "./ToolCallLabel.logic";

describe("deriveToolCallLabel", () => {
  it("summarizes shell commands without their long arguments", () => {
    expect(
      deriveToolCallLabel({
        toolName: "bash",
        command:
          "git diff --git a/Users/kamogelo/code/project/src/spec.py b/Users/kamogelo/code/project/src/spec.py",
        fallbackLabel: "Command run",
      }),
    ).toEqual({ verb: "Ran", target: "git diff", iconKind: "terminal" });
  });

  it("labels file reads, edits, and searches from structured input", () => {
    expect(
      deriveToolCallLabel({
        toolName: "Read",
        input: { path: "/work/src/spec.py" },
        fallbackLabel: "Tool",
      }),
    ).toEqual({ verb: "Read", target: "spec.py", iconKind: "eye" });
    expect(
      deriveToolCallLabel({
        toolName: "Edit",
        input: { filePath: "/work/src/app.ts" },
        fallbackLabel: "Tool",
      }),
    ).toEqual({ verb: "Edited", target: "app.ts", iconKind: "square-pen" });
    expect(
      deriveToolCallLabel({
        toolName: "Grep",
        input: { pattern: "PulseCanvas actions" },
        fallbackLabel: "Tool",
      }),
    ).toEqual({ verb: "Searched", target: '"PulseCanvas actions"', iconKind: "search" });
  });

  it("falls back to the tool name and truncates long search labels", () => {
    expect(
      deriveToolCallLabel({ toolName: "Open Shortcuts editor", fallbackLabel: "Tool" }),
    ).toEqual({
      verb: "Open Shortcuts editor",
      iconKind: "wrench",
    });
    const result = deriveToolCallLabel({
      toolName: "Search",
      input: { query: "a".repeat(100) },
      fallbackLabel: "Tool",
    });
    expect(result.target).toHaveLength(74);
    expect(result.target?.endsWith('…"')).toBe(true);
  });

  it("uses a workspace-relative path for file changes and keeps its basename when truncated", () => {
    expect(
      deriveToolCallLabel({
        changedFiles: ["C:/Users/mike/dev-stuff/neokod/apps/web/src/session-logic.ts"],
        workspaceRoot: "C:/Users/mike/dev-stuff/neokod",
        fallbackLabel: "Updated files",
      }),
    ).toEqual({
      verb: "Edited",
      target: "neokod/apps/web/src/session-logic.ts",
      iconKind: "square-pen",
    });
  });

  it("only exposes result summaries supplied by the work entry", () => {
    expect(deriveToolCallResultSummary({ exitCode: 0 })).toBe("exit 0");
    expect(deriveToolCallResultSummary({})).toBeUndefined();
  });
});
