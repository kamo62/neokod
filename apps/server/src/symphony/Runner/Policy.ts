import type { EffectiveWorkflowConfig } from "@neokod/contracts";

/**
 * Approval/sandbox policy for a Symphony run (SPEC 10.5, plan 8.3).
 *
 * Maps the workflow's autonomy level plus its approval/codex settings onto the
 * Codex thread/turn config. The mapping is pure so it is unit-testable without
 * a live agent.
 */

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexThreadSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReviewer = "user" | "auto_review";
export type CodexTurnSandboxPolicy =
  | { readonly type: "readOnly" }
  | { readonly type: "workspaceWrite" }
  | { readonly type: "dangerFullAccess" };

export interface RunnerPolicy {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly threadSandbox: CodexThreadSandbox;
  readonly reviewer: CodexReviewer;
  readonly turnSandboxPolicy: CodexTurnSandboxPolicy;
  /** Prepare mode blocks edits at the sandbox; Execute allows workspace writes. */
  readonly editsAllowed: boolean;
  /** When false, no approval request may proceed (plan mode fails closed). */
  readonly approvalsEnabled: boolean;
}

/** Resolve the effective codex approval policy for the workflow. */
const resolveApprovalPolicy = (config: EffectiveWorkflowConfig): CodexApprovalPolicy => {
  if (config.codexApprovalPolicy) {
    // `on-failure` is a Codex concept: ask for approval only when a sandboxed
    // action fails. Map it to `on-request` at the runtime boundary so the
    // agent never silently escalates past the configured autonomy.
    return config.codexApprovalPolicy === "on-failure" ? "on-request" : config.codexApprovalPolicy;
  }
  switch (config.autonomy) {
    case "observe":
    case "prepare":
      return "untrusted";
    case "execute":
    case "deliver":
      return "on-request";
  }
};

/** Resolve the thread sandbox mode for the workflow. */
const resolveThreadSandbox = (config: EffectiveWorkflowConfig): CodexThreadSandbox => {
  if (config.codexThreadSandbox) {
    return config.codexThreadSandbox;
  }
  switch (config.autonomy) {
    case "observe":
    case "prepare":
      return "read-only";
    case "execute":
    case "deliver":
      return "workspace-write";
  }
};

const reviewerFor = (approvalPolicy: CodexApprovalPolicy): CodexReviewer =>
  approvalPolicy === "never" ? "auto_review" : "user";

const turnSandboxFor = (threadSandbox: CodexThreadSandbox): CodexTurnSandboxPolicy => {
  switch (threadSandbox) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
};

/**
 * The policy that governs a single run attempt. Driven by the workflow's
 * autonomy level; explicit codex.* settings override the autonomy defaults.
 */
export const resolveRunnerPolicy = (config: EffectiveWorkflowConfig): RunnerPolicy => {
  const approvalPolicy = resolveApprovalPolicy(config);
  const threadSandbox = resolveThreadSandbox(config);
  const reviewer = config.codexTurnSandboxPolicy
    ? config.codexTurnSandboxPolicy === "readOnly"
      ? "user"
      : reviewerFor(approvalPolicy)
    : reviewerFor(approvalPolicy);

  return {
    approvalPolicy,
    threadSandbox,
    reviewer,
    turnSandboxPolicy:
      config.codexTurnSandboxPolicy === "dangerFullAccess"
        ? { type: "dangerFullAccess" }
        : config.codexTurnSandboxPolicy === "readOnly"
          ? { type: "readOnly" }
          : turnSandboxFor(threadSandbox),
    editsAllowed: threadSandbox !== "read-only",
    approvalsEnabled: approvalPolicy !== "never",
  };
};

/**
 * True when the run needs human approval before any edit lands. Prepare mode
 * never allows edits; Execute/Deliver allow them subject to the approval
 * policy.
 */
export const requiresApprovalBeforeEdit = (config: EffectiveWorkflowConfig): boolean => {
  const policy = resolveRunnerPolicy(config);
  return policy.approvalsEnabled && policy.editsAllowed;
};
