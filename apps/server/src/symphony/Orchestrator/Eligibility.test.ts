import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@neokod/contracts";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";

import { evaluateEligibility } from "./Eligibility.ts";

const makeConfig = (overrides: Partial<EffectiveWorkflowConfig> = {}): EffectiveWorkflowConfig =>
  ({
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    trackerKind: "github",
    trackerRequiredLabels: ["agent-ready"],
    trackerActiveStates: ["Ready", "In Progress"],
    trackerTerminalStates: ["Done", "Cancelled"],
    trackerProvider: {},
    workspaceRoot: "/ws",
    autonomy: "observe",
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
  title: "Fix bug",
  description: null,
  priority: 1,
  state: "Ready",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ["agent-ready"],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

describe("evaluateEligibility", () => {
  it("is eligible when all rules pass", () => {
    const result = evaluateEligibility({
      config: makeConfig(),
      issue: makeIssue(),
      claimedIssueIds: new Set(),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("matches states case-insensitively", () => {
    const result = evaluateEligibility({
      config: makeConfig(),
      issue: makeIssue({ state: "  ready  " }),
      claimedIssueIds: new Set(),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(true);
  });

  it("rejects an inactive state with a named reason", () => {
    const result = evaluateEligibility({
      config: makeConfig(),
      issue: makeIssue({ state: "Blocked" }),
      claimedIssueIds: new Set(),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("state_not_active:Blocked");
  });

  it("rejects a terminal state", () => {
    const result = evaluateEligibility({
      config: makeConfig(),
      issue: makeIssue({ state: "Done" }),
      claimedIssueIds: new Set(),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("state_terminal:Done");
  });

  it("rejects a non-dispatchable issue", () => {
    const result = evaluateEligibility({
      config: makeConfig(),
      issue: makeIssue({ dispatchable: false }),
      claimedIssueIds: new Set(),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("not_dispatchable");
  });

  it("rejects when a required label is missing, case-insensitively", () => {
    const result = evaluateEligibility({
      config: makeConfig({ trackerRequiredLabels: ["Agent-Ready"] }),
      issue: makeIssue({ labels: ["other"] }),
      claimedIssueIds: new Set(),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("missing_label:Agent-Ready");
  });

  it("rejects an already-claimed issue", () => {
    const result = evaluateEligibility({
      config: makeConfig(),
      issue: makeIssue(),
      claimedIssueIds: new Set(["1"]),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("already_claimed");
  });

  it("rejects when dispatch is paused", () => {
    const result = evaluateEligibility({
      config: makeConfig(),
      issue: makeIssue(),
      claimedIssueIds: new Set(),
      dispatchPaused: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("dispatch_paused");
  });

  it("does not require labels when none are configured", () => {
    const result = evaluateEligibility({
      config: makeConfig({ trackerRequiredLabels: [] }),
      issue: makeIssue({ labels: [] }),
      claimedIssueIds: new Set(),
      dispatchPaused: false,
    });
    expect(result.eligible).toBe(true);
  });
});
