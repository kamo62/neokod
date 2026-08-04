import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@neokod/contracts";
import type { EffectiveWorkflowConfig } from "@neokod/contracts";

import { requiresApprovalBeforeEdit, resolveRunnerPolicy } from "./Policy.ts";

const makeConfig = (overrides: Partial<EffectiveWorkflowConfig> = {}): EffectiveWorkflowConfig =>
  ({
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    trackerKind: "github",
    trackerRequiredLabels: [],
    trackerActiveStates: ["Ready"],
    trackerTerminalStates: ["Done"],
    trackerProvider: {},
    workspaceRoot: "/ws",
    autonomy: "execute",
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex_default"),
      driver: ProviderDriverKind.make("codex"),
    },
    ...overrides,
  }) as EffectiveWorkflowConfig;

describe("resolveRunnerPolicy", () => {
  it("prepare mode is read-only, untrusted, and blocks edits", () => {
    const policy = resolveRunnerPolicy(makeConfig({ autonomy: "prepare" }));
    expect(policy.approvalPolicy).toBe("untrusted");
    expect(policy.threadSandbox).toBe("read-only");
    expect(policy.editsAllowed).toBe(false);
    expect(policy.approvalsEnabled).toBe(true);
    expect(policy.turnSandboxPolicy).toEqual({ type: "readOnly" });
  });

  it("execute mode is workspace-write with on-request approvals", () => {
    const policy = resolveRunnerPolicy(makeConfig({ autonomy: "execute" }));
    expect(policy.approvalPolicy).toBe("on-request");
    expect(policy.threadSandbox).toBe("workspace-write");
    expect(policy.editsAllowed).toBe(true);
    expect(policy.turnSandboxPolicy).toEqual({ type: "workspaceWrite" });
  });

  it("deliver mode matches execute mode", () => {
    const policy = resolveRunnerPolicy(makeConfig({ autonomy: "deliver" }));
    expect(policy.threadSandbox).toBe("workspace-write");
    expect(policy.approvalPolicy).toBe("on-request");
  });

  it("explicit codex settings override autonomy defaults", () => {
    const policy = resolveRunnerPolicy(
      makeConfig({
        autonomy: "prepare",
        codexThreadSandbox: "workspace-write",
        codexApprovalPolicy: "never",
      }),
    );
    expect(policy.threadSandbox).toBe("workspace-write");
    expect(policy.approvalPolicy).toBe("never");
    expect(policy.editsAllowed).toBe(true);
    expect(policy.approvalsEnabled).toBe(false);
  });

  it("maps codex on-failure approval to on-request", () => {
    const policy = resolveRunnerPolicy(
      makeConfig({ autonomy: "execute", codexApprovalPolicy: "on-failure" }),
    );
    expect(policy.approvalPolicy).toBe("on-request");
  });

  it("read-only turn sandbox policy maps to readOnly", () => {
    const policy = resolveRunnerPolicy(
      makeConfig({ autonomy: "execute", codexTurnSandboxPolicy: "readOnly" }),
    );
    expect(policy.turnSandboxPolicy).toEqual({ type: "readOnly" });
  });
});

describe("requiresApprovalBeforeEdit", () => {
  it("true when edits allowed and approvals enabled", () => {
    expect(requiresApprovalBeforeEdit(makeConfig({ autonomy: "execute" }))).toBe(true);
  });

  it("false in prepare mode (no edits at all)", () => {
    expect(requiresApprovalBeforeEdit(makeConfig({ autonomy: "prepare" }))).toBe(false);
  });

  it("false when approval policy is never", () => {
    expect(
      requiresApprovalBeforeEdit(makeConfig({ autonomy: "execute", codexApprovalPolicy: "never" })),
    ).toBe(false);
  });
});
