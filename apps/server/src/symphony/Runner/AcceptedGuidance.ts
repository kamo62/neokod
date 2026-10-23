import * as NodeCrypto from "node:crypto";

import type {
  AcceptedGuidanceSnapshot,
  AcceptedInstructionText,
  AcceptedPermissionScope,
  AutonomyLevel,
  EffectiveWorkflowConfig,
  IsoDateTime,
  NormalizedIssue,
  WorkflowId,
  WorkSource,
} from "@neokod/contracts";

import { resolveRunnerPolicy } from "./Policy.ts";

/**
 * Immutable guidance accepted for one Symphony run attempt (plan 16.16/16.17).
 *
 * Admission freezes what the attempt is allowed to act on: the effective
 * workflow body, the tracker source it was selected from, additive operator
 * guidance, and the permission/delivery scope. Later edits to `WORKFLOW.md`,
 * the tracker issue, or the workflow's policy affect future attempts; they do
 * not rewrite this snapshot.
 *
 * The snapshot shape is the canonical `AcceptedGuidanceSnapshotSchema` from
 * `@neokod/contracts`. This module only builds, digests and narrows it.
 *
 * Boundaries this module keeps structural:
 *
 * - It accepts the parsed workflow *body* only. Raw front matter (tracker
 *   credentials, hooks, $VAR environment references) is never an input, so it
 *   can never be persisted here.
 * - Tracker source is stored in its own `source` field, separate from operator
 *   `guidance`. A generated plan is not part of an accepted brief.
 * - Machine identity is not invented. The current server has no machine
 *   registry, so the target records the repository identity the workflow
 *   already owns and nothing more.
 * - The digest is a content hash, never a credential or environment value.
 */

/**
 * Sub-shapes are derived from the canonical snapshot so this module does not
 * declare a competing contract.
 */
type AcceptedWorkflowGuidance = AcceptedGuidanceSnapshot["workflow"];
type AcceptedSourceSnapshot = AcceptedGuidanceSnapshot["source"];
type AcceptedGuidanceText = AcceptedGuidanceSnapshot["guidance"];
type AcceptedTarget = AcceptedGuidanceSnapshot["target"];

const ACCEPTED_GUIDANCE_SCHEMA_VERSION = 1 as const;

export interface FreezeAcceptedGuidanceInput {
  /** Server clock value at admission. Pure callers pass it in. */
  readonly acceptedAt: IsoDateTime;
  readonly workflowId: WorkflowId;
  /** Persisted workflow `updatedAt` at admission. */
  readonly workflowRevision: IsoDateTime;
  /** Parsed agent-facing body from `WORKFLOW.md`; never front matter. */
  readonly workflowInstructions: string;
  readonly workItem: {
    readonly source: WorkSource;
    readonly repositoryId?: string;
  };
  readonly issue: NormalizedIssue;
  readonly config: EffectiveWorkflowConfig;
  /** Additive batch guidance for the selected run draft. */
  readonly batchInstructions?: string;
  /** Per-story additional instructions. */
  readonly storyInstructions?: string;
  readonly workspacePath?: string;
  readonly baseBranch?: string;
}

export const freezeInstructionText = (value: string | undefined): AcceptedInstructionText =>
  value === undefined ? { state: "absent" } : { state: "present", text: value };

const CRITERIA_PREFIX = /^acceptance(\s+criteri[ae])?:/i;

/**
 * Extract the checklist under an "Acceptance criteria:" heading. Shared by the
 * live prompt and the accepted source snapshot so both freeze the same shape.
 */
export const extractAcceptanceCriteria = (
  description: string | null | undefined,
): ReadonlyArray<string> => {
  if (!description) {
    return [];
  }
  const lines = description
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const criteria: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (capturing) {
      if (line.startsWith("- ") || /^\d+\. /.test(line)) {
        criteria.push(line.replace(/^- |^\d+\. /, ""));
      } else if (/^[A-Za-z].*:$/.test(line)) {
        break;
      } else {
        capturing = false;
      }
    } else if (CRITERIA_PREFIX.test(line)) {
      capturing = true;
    }
  }
  return criteria;
};

const canonicalJson = (value: unknown): string => {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
};

/** Stable SHA-256 content digest. Object key order never changes the result. */
export const digestAcceptedContent = (value: unknown): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

/**
 * Project the workflow's existing runner policy into an accepted permission
 * scope. Reuses the one policy resolver rather than re-deriving approval and
 * sandbox rules here.
 */
export const resolveAcceptedPermissions = (
  config: EffectiveWorkflowConfig,
): AcceptedPermissionScope => {
  const policy = resolveRunnerPolicy(config);
  return {
    autonomy: config.autonomy,
    approvalPolicy: policy.approvalPolicy,
    threadSandbox: policy.threadSandbox,
    turnSandboxPolicy: policy.turnSandboxPolicy,
    editsAllowed: policy.editsAllowed,
    approvalsEnabled: policy.approvalsEnabled,
    protectedPaths: [...config.approvalsProtectedPaths],
    delivery: {
      approvalBeforePush: config.approvalsBeforePush ?? null,
      approvalBeforePullRequest: config.approvalsBeforePullRequest ?? null,
      approvalBeforeMerge: config.approvalsBeforeMerge ?? null,
    },
  };
};

const sourceIdentity = (
  source: WorkSource,
): { readonly externalId?: string; readonly externalUrl?: string } =>
  "externalId" in source ? { externalId: source.externalId, externalUrl: source.externalUrl } : {};

/**
 * Freeze the effective brief for an accepted attempt. Callers pass only
 * already-parsed workflow text and configured target/authority; this function
 * neither reads the environment nor invents a machine identity.
 */
export const freezeAcceptedGuidance = (
  input: FreezeAcceptedGuidanceInput,
): AcceptedGuidanceSnapshot => {
  const { config, issue } = input;
  const validationRequired = [...config.validationRequired];
  const workflowBase = {
    id: input.workflowId,
    path: config.workflowPath,
    revision: input.workflowRevision,
    instructions: input.workflowInstructions,
    validationRequired,
  };
  const workflow: AcceptedWorkflowGuidance = {
    ...workflowBase,
    digest: digestAcceptedContent(workflowBase),
  };

  const sourceBase = {
    trackerId: issue.id,
    kind: input.workItem.source.kind,
    ...sourceIdentity(input.workItem.source),
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    acceptanceCriteria: extractAcceptanceCriteria(issue.description),
    labels: [...issue.labels],
    revision: issue.updatedAt,
  };
  const source: AcceptedSourceSnapshot = {
    ...sourceBase,
    digest: digestAcceptedContent(sourceBase),
  };

  const guidanceBase = {
    batch: freezeInstructionText(input.batchInstructions),
    story: freezeInstructionText(input.storyInstructions),
  };
  const guidance: AcceptedGuidanceText = {
    ...guidanceBase,
    digest: digestAcceptedContent(guidanceBase),
  };

  const target: AcceptedTarget = {
    ...(input.workItem.repositoryId !== undefined
      ? { repositoryId: input.workItem.repositoryId }
      : {}),
    repositoryPath: config.repositoryPath,
    workflowPath: config.workflowPath,
    ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    provider: config.agentProvider,
    ...(config.agentModel !== undefined ? { model: config.agentModel } : {}),
  };

  const permission = resolveAcceptedPermissions(config);

  const body = {
    schemaVersion: ACCEPTED_GUIDANCE_SCHEMA_VERSION,
    workflow,
    source,
    guidance,
    target,
    permission,
  };
  return {
    acceptedAt: input.acceptedAt,
    ...body,
    digest: digestAcceptedContent(body),
  };
};

const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  observe: 0,
  prepare: 1,
  execute: 2,
  deliver: 3,
};

const APPROVAL_RANK: Record<AcceptedPermissionScope["approvalPolicy"], number> = {
  untrusted: 0,
  "on-request": 1,
  never: 2,
};

const SANDBOX_RANK: Record<AcceptedPermissionScope["threadSandbox"], number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

const TURN_SANDBOX_RANK: Record<AcceptedPermissionScope["turnSandboxPolicy"]["type"], number> = {
  readOnly: 0,
  workspaceWrite: 1,
  dangerFullAccess: 2,
};

const narrower = <T extends string>(rank: Record<T, number>, left: T, right: T): T =>
  rank[left] <= rank[right] ? left : right;

const turnSandboxFor = (
  sandbox: AcceptedPermissionScope["threadSandbox"],
): AcceptedPermissionScope["turnSandboxPolicy"] => {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
};

const turnSandboxPolicyFor = (
  type: AcceptedPermissionScope["turnSandboxPolicy"]["type"],
): AcceptedPermissionScope["turnSandboxPolicy"] => {
  switch (type) {
    case "readOnly":
      return { type: "readOnly" };
    case "workspaceWrite":
      return { type: "workspaceWrite" };
    case "dangerFullAccess":
      return { type: "dangerFullAccess" };
  }
};

const narrowDeliveryGate = (left: boolean | null, right: boolean | null): boolean | null => {
  if (left === true || right === true) {
    return true;
  }
  return left === null || right === null ? null : false;
};

const unionStrings = (left: readonly string[], right: readonly string[]): readonly string[] => {
  const union = [...left];
  for (const value of right) {
    if (!union.includes(value)) {
      union.push(value);
    }
  }
  return union;
};

export type AcceptedPermissionNarrowing =
  | { readonly _tag: "narrowed"; readonly permission: AcceptedPermissionScope }
  | {
      readonly _tag: "unrepresentable";
      readonly reason: "approval_policy_conflict";
      readonly acceptedApprovalPolicy: AcceptedPermissionScope["approvalPolicy"];
      readonly liveApprovalPolicy: AcceptedPermissionScope["approvalPolicy"];
    };

/**
 * The permission a continuation may use: the more restrictive of the accepted
 * scope and the live workflow scope. A later workflow edit can narrow an
 * attempt's authority; it can never widen it.
 *
 * Approval policy is not one broadness scale. `never` means the agent may not
 * request approval at all; `on-request`/`untrusted` enable that request path.
 * `untrusted` additionally requires approval for untrusted commands, so
 * collapsing it to `never` would silently drop a required human gate.
 *
 * Therefore:
 * - accepted `never` + live approvals-enabled is unrepresentable;
 * - accepted `untrusted` + live `never` is unrepresentable in the other
 *   direction, because the live policy cannot satisfy the accepted approval
 *   requirement;
 * - accepted `on-request` + live `never` narrows to `never`: no escalation is
 *   required and a no-escalation policy is within the accepted permission.
 */
export const narrowAcceptedPermissions = (
  accepted: AcceptedPermissionScope,
  live: AcceptedPermissionScope,
): AcceptedPermissionNarrowing => {
  const approvalConflict =
    (accepted.approvalPolicy === "never" && live.approvalPolicy !== "never") ||
    (accepted.approvalPolicy === "untrusted" && live.approvalPolicy === "never");
  if (approvalConflict) {
    return {
      _tag: "unrepresentable",
      reason: "approval_policy_conflict",
      acceptedApprovalPolicy: accepted.approvalPolicy,
      liveApprovalPolicy: live.approvalPolicy,
    };
  }

  const autonomy = narrower(AUTONOMY_RANK, accepted.autonomy, live.autonomy);
  const approvalPolicy =
    accepted.approvalPolicy === "never" || live.approvalPolicy === "never"
      ? "never"
      : narrower(APPROVAL_RANK, accepted.approvalPolicy, live.approvalPolicy);
  const threadSandbox = narrower(SANDBOX_RANK, accepted.threadSandbox, live.threadSandbox);
  const turnSandbox = narrower(
    TURN_SANDBOX_RANK,
    accepted.turnSandboxPolicy.type,
    live.turnSandboxPolicy.type,
  );
  const cappedTurnSandbox = narrower(
    TURN_SANDBOX_RANK,
    turnSandbox,
    turnSandboxFor(threadSandbox).type,
  );
  return {
    _tag: "narrowed",
    permission: {
      autonomy,
      approvalPolicy,
      threadSandbox,
      turnSandboxPolicy: turnSandboxPolicyFor(cappedTurnSandbox),
      editsAllowed: accepted.editsAllowed && live.editsAllowed && threadSandbox !== "read-only",
      approvalsEnabled:
        approvalPolicy !== "never" && accepted.approvalsEnabled && live.approvalsEnabled,
      protectedPaths: unionStrings(accepted.protectedPaths, live.protectedPaths),
      delivery: {
        approvalBeforePush: narrowDeliveryGate(
          accepted.delivery.approvalBeforePush,
          live.delivery.approvalBeforePush,
        ),
        approvalBeforePullRequest: narrowDeliveryGate(
          accepted.delivery.approvalBeforePullRequest,
          live.delivery.approvalBeforePullRequest,
        ),
        approvalBeforeMerge: narrowDeliveryGate(
          accepted.delivery.approvalBeforeMerge,
          live.delivery.approvalBeforeMerge,
        ),
      },
    },
  };
};
