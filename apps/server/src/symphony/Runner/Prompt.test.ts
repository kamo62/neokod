import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@neokod/contracts";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";

import { buildRunPrompt, extractAcceptanceCriteria } from "./Prompt.ts";

const makeConfig = (overrides: Partial<EffectiveWorkflowConfig> = {}): EffectiveWorkflowConfig =>
  ({
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    trackerKind: "github",
    trackerRequiredLabels: ["agent-ready"],
    trackerActiveStates: ["Ready"],
    trackerTerminalStates: ["Done"],
    trackerProvider: {},
    workspaceRoot: "/ws",
    autonomy: "prepare",
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex_default"),
      driver: ProviderDriverKind.make("codex"),
    },
    ...overrides,
  }) as EffectiveWorkflowConfig;

const makeIssue = (overrides: Partial<NormalizedIssue> = {}): NormalizedIssue => ({
  id: "1",
  nativeRef: null,
  identifier: "#1",
  title: "Fix the login bug",
  description:
    "The login form rejects valid passwords.\n\nAcceptance criteria:\n- Valid password logs in\n- Shows error on invalid password",
  priority: 1,
  state: "Ready",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ["agent-ready", "bug"],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

describe("extractAcceptanceCriteria", () => {
  it("parses a checklist under an acceptance criteria header", () => {
    const criteria = extractAcceptanceCriteria(
      "Task body.\n\nAcceptance criteria:\n- Valid password logs in\n- Shows error on invalid password",
    );
    expect(criteria).toEqual(["Valid password logs in", "Shows error on invalid password"]);
  });

  it("returns empty for missing description", () => {
    expect(extractAcceptanceCriteria(null)).toEqual([]);
    expect(extractAcceptanceCriteria("")).toEqual([]);
  });

  it("returns empty when no acceptance criteria section exists", () => {
    expect(extractAcceptanceCriteria("Just a body.")).toEqual([]);
  });
});

describe("buildRunPrompt", () => {
  it("includes issue context and labels", () => {
    const prompt = buildRunPrompt({ issue: makeIssue(), config: makeConfig() });
    expect(prompt).toContain("#1");
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("agent-ready, bug");
  });

  it("instructs plan mode for prepare autonomy", () => {
    const prompt = buildRunPrompt({ issue: makeIssue(), config: makeConfig() });
    expect(prompt).toContain("Do NOT modify any files");
  });

  it("instructs execution mode for execute autonomy", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
    });
    expect(prompt).toContain("make the changes needed");
    expect(prompt).not.toContain("Do NOT modify any files");
  });

  it("uses continuation wording when continuation is set", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig(),
      continuation: true,
    });
    expect(prompt).toContain("Symphony continuation");
    expect(prompt).toContain("Continue the in-progress work");
  });

  it("omits the review feedback section when none is given", () => {
    const prompt = buildRunPrompt({ issue: makeIssue(), config: makeConfig() });
    expect(prompt).not.toContain("Review feedback");
  });

  it("carries review context and instructs working on the existing branch/workspace", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
      branch: "symphony/issue-1",
      reviewFeedback: {
        unresolvedCommentCount: 2,
        reviewState: "changes_requested",
        latestCommit: "deadbeef0001",
        comments: [
          { body: "Please add a null check here.", author: "reviewer1" },
          { body: "This function needs a test." },
        ],
      },
    });
    expect(prompt).toContain("### Review feedback");
    expect(prompt).toContain("EXISTING branch symphony/issue-1");
    expect(prompt).toContain("EXISTING workspace");
    expect(prompt).toContain("Review state: changes_requested");
    expect(prompt).toContain("Unresolved comments: 2");
    expect(prompt).toContain("Latest reviewed commit: deadbeef0001");
    expect(prompt).toContain("1. reviewer1: Please add a null check here.");
    expect(prompt).toContain("2. This function needs a test.");
  });

  it("degrades honestly to counts-only when comment bodies are unavailable", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
      reviewFeedback: {
        unresolvedCommentCount: 3,
        reviewState: "changes_requested",
      },
    });
    expect(prompt).toContain("Unresolved comments: 3");
    expect(prompt).toContain(
      "Comment bodies are not available for this host; only the counts above are known.",
    );
    expect(prompt).not.toContain("Unresolved review comments:");
  });

  it("bounds comments to the first ~20 and truncates long bodies", () => {
    const comments = Array.from({ length: 25 }, (_unused, index) => ({
      body: index === 0 ? "x".repeat(600) : `comment ${index}`,
    }));
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
      reviewFeedback: {
        unresolvedCommentCount: 25,
        reviewState: "changes_requested",
        comments,
      },
    });
    expect(prompt).toContain("20. comment 19");
    expect(prompt).not.toContain("21. comment 20");
    expect(prompt).not.toContain("x".repeat(600));
    expect(prompt).toContain(`${"x".repeat(500)}…`);
  });
});
