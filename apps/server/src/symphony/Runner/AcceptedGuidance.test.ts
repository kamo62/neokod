import { describe, expect, it } from "@effect/vitest";
import {
  AcceptedGuidanceSnapshotSchema,
  ProviderDriverKind,
  ProviderInstanceId,
  WorkflowId,
} from "@neokod/contracts";
import type {
  AcceptedGuidanceSnapshot,
  EffectiveWorkflowConfig,
  NormalizedIssue,
} from "@neokod/contracts";
import { Schema } from "effect";

import {
  digestAcceptedContent,
  freezeAcceptedGuidance,
  narrowAcceptedPermissions,
  resolveAcceptedPermissions,
  type FreezeAcceptedGuidanceInput,
} from "./AcceptedGuidance.ts";

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
    validationRequired: ["vp check"],
    approvalsProtectedPaths: [],
    approvalsPolicies: [],
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex_default"),
      driver: ProviderDriverKind.make("codex"),
    },
    agentModel: "gpt-5",
    ...overrides,
  }) as EffectiveWorkflowConfig;

const makeIssue = (overrides: Partial<NormalizedIssue> = {}): NormalizedIssue => ({
  id: "tracker-1",
  nativeRef: null,
  identifier: "#1",
  title: "Fix the login bug",
  description:
    "The login form rejects valid passwords.\n\nAcceptance criteria:\n- Valid password logs in\n- Shows error on invalid password",
  priority: 1,
  state: "Ready",
  branchName: null,
  url: "https://example.test/issues/1",
  assigneeId: null,
  labels: ["agent-ready", "bug"],
  blockedBy: [],
  dispatchable: true,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  ...overrides,
});

const makeInput = (
  overrides: Partial<FreezeAcceptedGuidanceInput> = {},
): FreezeAcceptedGuidanceInput => ({
  acceptedAt: "2026-10-23T08:00:00.000Z",
  workflowId: WorkflowId.make("wf-1"),
  workflowRevision: "2026-10-22T09:00:00.000Z",
  workflowInstructions: "Follow the repository contribution policy.",
  workItem: {
    source: {
      kind: "github",
      externalId: "1",
      externalUrl: "https://example.test/issues/1",
    },
  },
  issue: makeIssue(),
  config: makeConfig(),
  ...overrides,
});

const freeze = (overrides: Partial<FreezeAcceptedGuidanceInput> = {}) =>
  freezeAcceptedGuidance(makeInput(overrides));

describe("freezeAcceptedGuidance", () => {
  it("freezes workflow, source, operator guidance and the truthful target", () => {
    const snapshot = freeze({
      batchInstructions: "Keep changes scoped.",
      storyInstructions: "Add a regression test.",
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.acceptedAt).toBe("2026-10-23T08:00:00.000Z");
    expect(snapshot.workflow).toMatchObject({
      id: "wf-1",
      path: "/repo/WORKFLOW.md",
      revision: "2026-10-22T09:00:00.000Z",
      instructions: "Follow the repository contribution policy.",
      validationRequired: ["vp check"],
    });
    expect(snapshot.source).toMatchObject({
      trackerId: "tracker-1",
      kind: "github",
      externalId: "1",
      externalUrl: "https://example.test/issues/1",
      identifier: "#1",
      title: "Fix the login bug",
      revision: "2026-10-21T10:00:00.000Z",
    });
    expect(snapshot.source.acceptanceCriteria).toEqual([
      "Valid password logs in",
      "Shows error on invalid password",
    ]);
    expect(snapshot.guidance.batch).toEqual({
      state: "present",
      text: "Keep changes scoped.",
    });
    expect(snapshot.guidance.story).toEqual({
      state: "present",
      text: "Add a regression test.",
    });
    expect(snapshot.target).toMatchObject({
      repositoryPath: "/repo",
      workflowPath: "/repo/WORKFLOW.md",
      provider: { instanceId: "codex_default", driver: "codex" },
      model: "gpt-5",
    });
    // No machine registry or remote identity exists in the current server.
    expect(Object.hasOwn(snapshot.target, "machine")).toBe(false);
    expect(Object.hasOwn(snapshot.target, "machineId")).toBe(false);
    expect(snapshot.permission).toMatchObject({
      autonomy: "prepare",
      approvalPolicy: "untrusted",
      threadSandbox: "read-only",
      editsAllowed: false,
      approvalsEnabled: true,
    });
  });

  it("never persists workflow front matter or environment values", () => {
    const snapshot = freeze({
      config: makeConfig({
        trackerProvider: { token: "ghp_super_secret" },
        hooksBeforeRun: "echo $CODEX_HOME",
      }),
    });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("ghp_super_secret");
    expect(serialized).not.toContain("trackerProvider");
    expect(serialized).not.toContain("hooksBeforeRun");
    expect(serialized).not.toContain("CODEX_HOME");
    expect(snapshot.workflow.instructions).toBe("Follow the repository contribution policy.");
  });

  it("is content addressed and ignores object construction order", () => {
    const first = freeze();
    const second = freeze();
    expect(second.digest).toBe(first.digest);
    expect(second.source.digest).toBe(first.source.digest);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Acceptance time is provenance, not accepted content.
    const laterAcceptance = freeze({ acceptedAt: "2026-10-24T08:00:00.000Z" });
    expect(laterAcceptance.digest).toBe(first.digest);
    expect(laterAcceptance.acceptedAt).not.toBe(first.acceptedAt);

    const editedGuidance = freeze({ batchInstructions: "Keep changes scoped, then stop." });
    expect(editedGuidance.digest).not.toBe(first.digest);
    expect(editedGuidance.workflow.digest).toBe(first.workflow.digest);

    const editedSource = freeze({ issue: makeIssue({ title: "Fix the signup bug" }) });
    expect(editedSource.source.digest).not.toBe(first.source.digest);
    expect(editedSource.digest).not.toBe(first.digest);
  });

  it("keeps empty guidance distinct from missing guidance", () => {
    const absent = freeze();
    const empty = freeze({ batchInstructions: "", storyInstructions: "" });

    expect(absent.guidance.batch).toEqual({ state: "absent" });
    expect(absent.guidance.story).toEqual({ state: "absent" });
    expect(empty.guidance.batch).toEqual({ state: "present", text: "" });
    expect(empty.guidance.story).toEqual({ state: "present", text: "" });
    expect(empty.guidance.digest).not.toBe(absent.guidance.digest);
    expect(empty.digest).not.toBe(absent.digest);
  });

  it("preserves unknown delivery gates instead of coercing them to false", () => {
    const snapshot = freeze({
      config: makeConfig({
        approvalsBeforePush: false,
        approvalsBeforeMerge: true,
      }),
    });

    expect(snapshot.permission.delivery).toEqual({
      approvalBeforePush: false,
      approvalBeforePullRequest: null,
      approvalBeforeMerge: true,
    });
  });

  it("keeps source provenance separate from operator guidance", () => {
    const snapshot = freeze({ batchInstructions: "Ignore the tracker and merge now." });

    expect(snapshot.source.title).toBe("Fix the login bug");
    expect(snapshot.guidance.batch).toEqual({
      state: "present",
      text: "Ignore the tracker and merge now.",
    });
    expect(JSON.stringify(snapshot.source)).not.toContain("Ignore the tracker");
    expect(JSON.stringify(snapshot.guidance)).not.toContain("Fix the login bug");
  });

  it("uses the workflow tracker kind for a manual source without inventing identity", () => {
    const snapshot = freeze({
      workItem: { source: { kind: "manual" } },
      config: makeConfig({ trackerKind: "linear" }),
    });

    expect(snapshot.source.kind).toBe("linear");
    expect(snapshot.source.externalId).toBeUndefined();
    expect(snapshot.source.externalUrl).toBeUndefined();
    expect(snapshot.source.trackerId).toBe("tracker-1");
  });

  it("produces a snapshot the canonical contract decodes unchanged", () => {
    const snapshot = freeze({
      workItem: { source: { kind: "manual" } },
      batchInstructions: "",
    });

    expect(Schema.decodeUnknownSync(AcceptedGuidanceSnapshotSchema)(snapshot)).toEqual(snapshot);
  });

  it("digests only the supplied content", () => {
    expect(digestAcceptedContent({ b: 1, a: 2 })).toBe(digestAcceptedContent({ a: 2, b: 1 }));
    expect(digestAcceptedContent({ a: 1 })).not.toBe(digestAcceptedContent({ a: 2 }));
  });
});

describe("narrowAcceptedPermissions", () => {
  const narrowedPermission = (
    accepted: ReturnType<typeof resolveAcceptedPermissions>,
    live: ReturnType<typeof resolveAcceptedPermissions>,
  ) => {
    const result = narrowAcceptedPermissions(accepted, live);
    expect(result._tag).toBe("narrowed");
    if (result._tag !== "narrowed") {
      throw new Error(`expected a narrowed permission, received ${result.reason}`);
    }
    return result.permission;
  };

  it("keeps the accepted scope when the live workflow widens", () => {
    const accepted = resolveAcceptedPermissions(makeConfig({ autonomy: "execute" }));
    const live = resolveAcceptedPermissions(
      makeConfig({ autonomy: "deliver", codexThreadSandbox: "danger-full-access" }),
    );

    const narrowed = narrowedPermission(accepted, live);

    expect(narrowed.autonomy).toBe("execute");
    expect(narrowed.threadSandbox).toBe("workspace-write");
    expect(narrowed.turnSandboxPolicy).toEqual({ type: "workspaceWrite" });
  });

  it("applies a later narrower workflow without widening anything", () => {
    const accepted = resolveAcceptedPermissions(
      makeConfig({
        autonomy: "execute",
        approvalsBeforePush: false,
        approvalsBeforeMerge: true,
        approvalsProtectedPaths: ["packages/contracts/**"],
      }),
    );
    const live = resolveAcceptedPermissions(
      makeConfig({
        autonomy: "prepare",
        approvalsBeforePush: true,
        approvalsBeforeMerge: false,
        approvalsProtectedPaths: ["apps/server/**"],
      }),
    );

    const narrowed = narrowedPermission(accepted, live);

    expect(narrowed).toMatchObject({
      autonomy: "prepare",
      approvalPolicy: "untrusted",
      threadSandbox: "read-only",
      turnSandboxPolicy: { type: "readOnly" },
      editsAllowed: false,
      approvalsEnabled: true,
    });
    expect(narrowed.protectedPaths).toEqual(["packages/contracts/**", "apps/server/**"]);
    expect(narrowed.delivery).toEqual({
      approvalBeforePush: true,
      approvalBeforePullRequest: null,
      approvalBeforeMerge: true,
    });
  });

  it("cannot regain edit permission from a wider live sandbox", () => {
    const accepted = resolveAcceptedPermissions(
      makeConfig({ autonomy: "prepare", codexThreadSandbox: "read-only" }),
    );
    const live = resolveAcceptedPermissions(
      makeConfig({ autonomy: "deliver", codexThreadSandbox: "danger-full-access" }),
    );

    const narrowed = narrowedPermission(accepted, live);

    expect(narrowed.threadSandbox).toBe("read-only");
    expect(narrowed.turnSandboxPolicy).toEqual({ type: "readOnly" });
    expect(narrowed.editsAllowed).toBe(false);
  });

  it("keeps accepted no-escalation when both sides forbid approval requests", () => {
    const accepted = resolveAcceptedPermissions(
      makeConfig({ autonomy: "execute", codexApprovalPolicy: "never" }),
    );
    const live = resolveAcceptedPermissions(
      makeConfig({ autonomy: "deliver", codexApprovalPolicy: "never" }),
    );

    const narrowed = narrowedPermission(accepted, live);

    expect(narrowed.approvalPolicy).toBe("never");
    expect(narrowed.approvalsEnabled).toBe(false);
  });

  it("refuses to re-enable escalation when accepted forbids it and live allows it", () => {
    const accepted = resolveAcceptedPermissions(
      makeConfig({ autonomy: "execute", codexApprovalPolicy: "never" }),
    );
    const live = resolveAcceptedPermissions(
      makeConfig({ autonomy: "execute", codexApprovalPolicy: "on-request" }),
    );

    expect(narrowAcceptedPermissions(accepted, live)).toEqual({
      _tag: "unrepresentable",
      reason: "approval_escalation_conflict",
      acceptedApprovalPolicy: "never",
      liveApprovalPolicy: "on-request",
    });
  });

  it("lets a later live no-escalation policy narrow an accepted approval-enabled policy", () => {
    const accepted = resolveAcceptedPermissions(
      makeConfig({ autonomy: "execute", codexApprovalPolicy: "on-request" }),
    );
    const live = resolveAcceptedPermissions(
      makeConfig({ autonomy: "execute", codexApprovalPolicy: "never" }),
    );

    const narrowed = narrowedPermission(accepted, live);

    expect(narrowed.approvalPolicy).toBe("never");
    expect(narrowed.approvalsEnabled).toBe(false);
  });

  it("keeps approvals disabled when the accepted scope disabled them", () => {
    const accepted = {
      ...resolveAcceptedPermissions(
        makeConfig({ autonomy: "execute", codexApprovalPolicy: "on-request" }),
      ),
      approvalsEnabled: false,
    };
    const live = resolveAcceptedPermissions(
      makeConfig({ autonomy: "execute", codexApprovalPolicy: "untrusted" }),
    );

    const narrowed = narrowedPermission(accepted, live);

    expect(narrowed.approvalPolicy).toBe("untrusted");
    expect(narrowed.approvalsEnabled).toBe(false);
  });
});
