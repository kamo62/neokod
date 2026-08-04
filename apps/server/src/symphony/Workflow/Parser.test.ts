import { describe, expect, it } from "@effect/vitest";

import { WorkflowParseError, parseWorkflowContent } from "./Parser.ts";

describe("parseWorkflowContent", () => {
  it("splits YAML front matter from the prompt body", () => {
    const content = `---
tracker:
  kind: github
  active_states:
    - Ready
---

Implement the selected issue.
`;
    const parsed = parseWorkflowContent(content);
    expect(parsed.promptTemplate).toBe("Implement the selected issue.");
    expect((parsed.config.tracker as Record<string, unknown>).kind).toBe("github");
  });

  it("treats a file without front matter as an all-prompt body", () => {
    const parsed = parseWorkflowContent("Implement the selected issue.");
    expect(parsed.config).toEqual({});
    expect(parsed.promptTemplate).toBe("Implement the selected issue.");
  });

  it("trims the prompt body", () => {
    const parsed = parseWorkflowContent(
      "---\ntracker:\n  kind: github\n---\n\n\n  body with padding  \n\n",
    );
    expect(parsed.promptTemplate).toBe("body with padding");
  });

  it("rejects unterminated front matter", () => {
    expect(() => parseWorkflowContent("---\ntracker:\n  kind: github\n")).toThrow(
      WorkflowParseError,
    );
  });

  it("rejects invalid YAML", () => {
    expect(() => parseWorkflowContent("---\ntracker: [unclosed\n---\nbody")).toThrow(
      WorkflowParseError,
    );
  });

  it("rejects non-map front matter", () => {
    expect(() => parseWorkflowContent("---\n- a\n- b\n---\nbody")).toThrow(WorkflowParseError);
  });

  it("handles empty front matter as empty config", () => {
    const parsed = parseWorkflowContent("---\n---\nbody");
    expect(parsed.config).toEqual({});
    expect(parsed.promptTemplate).toBe("body");
  });

  it("preserves unknown top-level keys for forward compatibility", () => {
    const parsed = parseWorkflowContent("---\ntracker:\n  kind: github\nfuture_key: 42\n---\nbody");
    expect((parsed.config as Record<string, unknown>).future_key).toBe(42);
  });
});
