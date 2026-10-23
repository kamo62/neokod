import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, WorkflowId } from "@neokod/contracts";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";

import { freezeAcceptedGuidance } from "./AcceptedGuidance.ts";
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
    validationRequired: [],
    approvalsProtectedPaths: [],
    approvalsPolicies: [],
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

const makeAcceptedGuidance = (
  overrides: Partial<Parameters<typeof freezeAcceptedGuidance>[0]> = {},
) =>
  freezeAcceptedGuidance({
    acceptedAt: "2026-10-23T08:00:00.000Z",
    workflowId: WorkflowId.make("wf-1"),
    workflowRevision: "2026-10-22T09:00:00.000Z",
    workflowInstructions: "Accepted workflow policy.",
    workItem: {
      source: {
        kind: "github",
        externalId: "1",
        externalUrl: "https://example.test/issues/1",
      },
    },
    issue: makeIssue(),
    config: makeConfig({ autonomy: "execute", validationRequired: ["vp check"] }),
    batchInstructions: "Accepted batch guidance.",
    storyInstructions: "Accepted story instruction.",
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

  it("renders the effective WORKFLOW contract on the first execution turn", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({
        autonomy: "execute",
        validationRequired: ["vp check", "vp run typecheck"],
        codexApprovalPolicy: "never",
        codexThreadSandbox: "danger-full-access",
      }),
      branch: "symphony/issue-1",
      workflowInstructions: "Follow the repository contribution policy.",
    });

    expect(prompt).toContain("### WORKFLOW contract");
    expect(prompt).toContain("existing branch symphony/issue-1");
    expect(prompt).toContain("Autonomy level: execute");
    expect(prompt).toContain("Effective approval policy: never");
    expect(prompt).toContain("Effective sandbox: danger-full-access");
    expect(prompt).toContain("- vp check");
    expect(prompt).toContain("- vp run typecheck");
    expect(prompt).toContain("Write SYMPHONY_EVIDENCE.md");
    expect(prompt).toContain("Follow the repository contribution policy.");
  });

  it("does not require delivery artifacts in plan-only runs", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ validationRequired: ["vp check"] }),
      workflowInstructions: "Investigate before editing.",
    });

    expect(prompt).toContain("Investigate before editing.");
    expect(prompt).toContain("Do NOT modify any files");
    expect(prompt).not.toContain("Write SYMPHONY_EVIDENCE.md");
    expect(prompt).not.toContain("Stage and commit");
  });

  it("uses continuation wording without re-sending the WORKFLOW contract", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig(),
      continuation: true,
      workflowInstructions: "This must only appear on the first turn.",
    });
    expect(prompt).toContain("Symphony continuation");
    expect(prompt).toContain("Continue the in-progress work");
    expect(prompt).not.toContain("### WORKFLOW contract");
    expect(prompt).not.toContain("This must only appear on the first turn.");
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

  it("renders the frozen accepted brief instead of live issue and workflow edits", () => {
    const accepted = makeAcceptedGuidance();
    const prompt = buildRunPrompt({
      issue: makeIssue({
        title: "Edited live title",
        description: "Edited live description",
      }),
      config: makeConfig({
        autonomy: "deliver",
        validationRequired: ["live-command"],
        codexThreadSandbox: "danger-full-access",
      }),
      workflowInstructions: "Edited live workflow instructions.",
      acceptedGuidance: accepted,
    });

    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("Valid password logs in");
    expect(prompt).not.toContain("Edited live title");
    expect(prompt).not.toContain("Edited live description");
    expect(prompt).not.toContain("Edited live workflow instructions.");
    expect(prompt).not.toContain("live-command");
    expect(prompt).toContain("Accepted workflow policy.");
    expect(prompt).toContain("- vp check");
    expect(prompt).toContain("Autonomy level: execute");
    expect(prompt).toContain("Effective approval policy: on-request");
    expect(prompt).toContain("Effective sandbox: workspace-write");
  });

  it("binds batch guidance and per-story instructions additively", () => {
    const accepted = makeAcceptedGuidance();
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
      acceptedGuidance: accepted,
    });

    expect(prompt).toContain("### Operator guidance");
    expect(prompt).toContain("Batch guidance:\n\nAccepted batch guidance.");
    expect(prompt).toContain("Story instructions:\n\nAccepted story instruction.");
    // The tracker source stays in its own section and is not rewritten.
    expect(prompt).toContain("### Description\n\nThe login form rejects valid passwords.");
  });

  it("renders live operator guidance for an unaccepted draft only", () => {
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
      operatorGuidance: {
        batch: { state: "present", text: "Draft batch guidance." },
        story: { state: "absent" },
      },
    });

    expect(prompt).toContain("Draft batch guidance.");
    expect(prompt).not.toContain("Story instructions:");
  });

  it("renders the frozen delivery scope, including unknown gates", () => {
    const accepted = makeAcceptedGuidance({
      config: makeConfig({
        autonomy: "execute",
        approvalsBeforePush: true,
        approvalsBeforeMerge: true,
      }),
    });
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
      acceptedGuidance: accepted,
    });

    expect(prompt).toContain(
      "Delivery approvals: push required, pull request not configured, merge required",
    );
  });

  it("does not re-send accepted guidance on a continuation turn", () => {
    const accepted = makeAcceptedGuidance();
    const prompt = buildRunPrompt({
      issue: makeIssue(),
      config: makeConfig({ autonomy: "execute" }),
      acceptedGuidance: accepted,
      continuation: true,
    });

    expect(prompt).toContain("Symphony continuation");
    expect(prompt).not.toContain("### WORKFLOW contract");
    expect(prompt).not.toContain("Accepted workflow policy.");
    expect(prompt).not.toContain("Accepted batch guidance.");
  });
});
