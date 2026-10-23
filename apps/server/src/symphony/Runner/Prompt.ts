import type {
  AcceptedDeliveryScope,
  AcceptedGuidanceSnapshot,
  AcceptedPermissionScope,
  AutonomyLevel,
  EffectiveWorkflowConfig,
  NormalizedIssue,
} from "@neokod/contracts";

import { extractAcceptanceCriteria, resolveAcceptedPermissions } from "./AcceptedGuidance.ts";

export { extractAcceptanceCriteria } from "./AcceptedGuidance.ts";

type AcceptedGuidanceText = AcceptedGuidanceSnapshot["guidance"];

/**
 * Prompt building for Symphony runs (plan 8.1, SPEC 7.1).
 *
 * The rendered prompt is the first-turn input for the agent. It binds the
 * issue context (identifier, title, description, acceptance criteria from
 * labels) plus the workflow's own prompt template when configured, and in
 * `prepare` autonomy explicitly instructs the agent to produce a plan and not
 * modify files (edits are blocked at the sandbox anyway).
 *
 * When an accepted guidance snapshot is supplied, the prompt renders that
 * frozen brief instead of the live issue/workflow text. A later tracker or
 * `WORKFLOW.md` edit therefore cannot rewrite what an accepted attempt was
 * asked to do.
 */

/**
 * One unresolved review comment for prompt inclusion (plan FR-102-104).
 * Mirrors `GitHubCli.GitHubReviewComment` but stays independent of the
 * source-control layer so `Runner/` does not need to import `sourceControl/`
 * just for a two-field shape.
 */
export interface ReviewFeedbackComment {
  readonly body: string;
  readonly author?: string;
}

/**
 * Review context for a continuation dispatch (plan FR-102-104, section 14):
 * built from the host's PR evidence when a refresh detects changes-requested
 * or new unresolved comments. `comments` is present only for hosts with
 * comment-body enrichment (GitHub today); its absence means the host could
 * only supply counts, and the prompt says so rather than implying there is
 * no feedback to address.
 */
export interface ReviewFeedbackContext {
  readonly unresolvedCommentCount: number;
  readonly reviewState: string;
  readonly latestCommit?: string;
  readonly comments?: ReadonlyArray<ReviewFeedbackComment>;
}

/** First ~20 comments ride in the prompt; the rest are on the host if the
 * agent needs more (plan FR-102-104 requirement: bounded inclusion). */
const MAX_REVIEW_COMMENTS_IN_PROMPT = 20;
/** Each comment body is truncated to a sane length so one long review
 * comment cannot dominate the prompt. */
const MAX_REVIEW_COMMENT_BODY_LENGTH = 500;

const truncateCommentBody = (body: string): string =>
  body.length > MAX_REVIEW_COMMENT_BODY_LENGTH
    ? `${body.slice(0, MAX_REVIEW_COMMENT_BODY_LENGTH)}…`
    : body;

const buildReviewFeedbackSection = (
  reviewFeedback: ReviewFeedbackContext,
  branch: string | undefined,
): string => {
  const branchLabel = branch ?? "for this work item";
  const lines: string[] = [
    `A reviewer left feedback on this pull request. Address it on the EXISTING branch ${branchLabel} in the EXISTING workspace: do not create a new branch or a new workspace.`,
    "",
    `- Review state: ${reviewFeedback.reviewState}`,
    `- Unresolved comments: ${reviewFeedback.unresolvedCommentCount}`,
  ];
  if (reviewFeedback.latestCommit !== undefined) {
    lines.push(`- Latest reviewed commit: ${reviewFeedback.latestCommit}`);
  }
  if (reviewFeedback.comments !== undefined) {
    const bounded = reviewFeedback.comments.slice(0, MAX_REVIEW_COMMENTS_IN_PROMPT);
    if (bounded.length > 0) {
      lines.push("", "Unresolved review comments:");
      bounded.forEach((comment, index) => {
        const author = comment.author !== undefined ? `${comment.author}: ` : "";
        lines.push(`${index + 1}. ${author}${truncateCommentBody(comment.body)}`);
      });
    }
  } else {
    lines.push(
      "",
      "Comment bodies are not available for this host; only the counts above are known.",
    );
  }
  return lines.join("\n");
};

export interface RunPromptInput {
  readonly issue: NormalizedIssue;
  readonly config: EffectiveWorkflowConfig;
  readonly branch?: string;
  readonly continuation?: boolean;
  readonly planOnly?: boolean;
  readonly reviewFeedback?: ReviewFeedbackContext;
  /** Agent-facing Markdown body from WORKFLOW.md. Front matter is deliberately
   * excluded so tracker credentials and host-only configuration never enter
   * the model prompt. Ignored when `acceptedGuidance` is present. */
  readonly workflowInstructions?: string;
  /**
   * Additive operator text for an unaccepted draft/preview. Ignored when a
   * frozen `acceptedGuidance` snapshot is present.
   */
  readonly operatorGuidance?: Pick<AcceptedGuidanceText, "batch" | "story">;
  /**
   * Immutable accepted brief for this attempt. It takes precedence over the
   * live issue, workflow body and workflow policy.
   */
  readonly acceptedGuidance?: AcceptedGuidanceSnapshot;
}

interface PromptSourceView {
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly acceptanceCriteria: readonly string[];
  readonly labels: readonly string[];
}

interface WorkflowContractView {
  readonly autonomy: AutonomyLevel;
  readonly approvalPolicy: AcceptedPermissionScope["approvalPolicy"];
  readonly threadSandbox: AcceptedPermissionScope["threadSandbox"];
  readonly validationRequired: readonly string[];
  readonly delivery: AcceptedDeliveryScope;
  readonly workflowInstructions?: string;
  readonly branch: string;
  readonly planOnly: boolean;
}

const sourceViewFor = (input: RunPromptInput): PromptSourceView => {
  const accepted = input.acceptedGuidance;
  if (accepted !== undefined) {
    return {
      identifier: accepted.source.identifier,
      title: accepted.source.title,
      description: accepted.source.description,
      acceptanceCriteria: accepted.source.acceptanceCriteria,
      labels: accepted.source.labels,
    };
  }
  return {
    identifier: input.issue.identifier,
    title: input.issue.title,
    description: input.issue.description,
    acceptanceCriteria: Array.from(extractAcceptanceCriteria(input.issue.description)),
    labels: input.issue.labels,
  };
};

const contractViewFor = (input: RunPromptInput): WorkflowContractView => {
  const branch =
    input.branch ??
    deriveBranchLabel(input.acceptedGuidance?.permission.autonomy ?? input.config.autonomy);
  const accepted = input.acceptedGuidance;
  if (accepted !== undefined) {
    return {
      autonomy: accepted.permission.autonomy,
      approvalPolicy: accepted.permission.approvalPolicy,
      threadSandbox: accepted.permission.threadSandbox,
      validationRequired: accepted.workflow.validationRequired,
      delivery: accepted.permission.delivery,
      ...(accepted.workflow.instructions.length > 0
        ? { workflowInstructions: accepted.workflow.instructions }
        : {}),
      branch,
      planOnly:
        input.planOnly === true ||
        accepted.permission.autonomy === "prepare" ||
        accepted.permission.autonomy === "observe",
    };
  }
  const permission = resolveAcceptedPermissions(input.config);
  return {
    autonomy: permission.autonomy,
    approvalPolicy: permission.approvalPolicy,
    threadSandbox: permission.threadSandbox,
    validationRequired: input.config.validationRequired,
    delivery: permission.delivery,
    ...(input.workflowInstructions !== undefined
      ? { workflowInstructions: input.workflowInstructions }
      : {}),
    branch,
    planOnly:
      input.planOnly === true ||
      input.config.autonomy === "prepare" ||
      input.config.autonomy === "observe",
  };
};

const describeDeliveryGate = (value: boolean | null): string => {
  if (value === null) {
    return "not configured";
  }
  return value ? "required" : "not required";
};

const buildWorkflowContractSection = (view: WorkflowContractView): string => {
  const lines = [
    `Work ONLY in the provided workspace on the existing branch ${view.branch}.`,
    "Do not create or switch branches, create another worktree, or edit files outside the provided workspace.",
    `- Autonomy level: ${view.autonomy}`,
    `- Effective approval policy: ${view.approvalPolicy}`,
    `- Effective sandbox: ${view.threadSandbox}`,
    `- Delivery approvals: push ${describeDeliveryGate(view.delivery.approvalBeforePush)}, pull request ${describeDeliveryGate(view.delivery.approvalBeforePullRequest)}, merge ${describeDeliveryGate(view.delivery.approvalBeforeMerge)}`,
    "",
    "Configured validation commands:",
    ...(view.validationRequired.length > 0
      ? view.validationRequired.map((command) => `- ${command}`)
      : ["- No workflow validation commands are configured."]),
  ];

  if (!view.planOnly) {
    lines.push(
      "",
      "Before finishing:",
      "- Run the configured validation commands and resolve any failures.",
      "- Stage and commit the intended changes on the existing branch so Symphony can deliver them.",
      "- Write SYMPHONY_EVIDENCE.md with these headings: Implementation Summary, Assumptions, Risks, and Unresolved. Summarize the change, files touched, and validation performed.",
    );
  }

  const workflowInstructions = view.workflowInstructions?.trim();
  if (workflowInstructions) {
    lines.push("", "Repository workflow instructions:", workflowInstructions);
  }

  return lines.join("\n");
};

const renderInstruction = (label: string, instruction: AcceptedGuidanceText["batch"]): string[] =>
  instruction.state === "present" && instruction.text.trim().length > 0
    ? [`${label}:\n\n${instruction.text}`]
    : [];

const buildOperatorGuidanceSection = (
  guidance: Pick<AcceptedGuidanceText, "batch" | "story">,
): string | null => {
  const blocks = [
    ...renderInstruction("Batch guidance", guidance.batch),
    ...renderInstruction("Story instructions", guidance.story),
  ];
  return blocks.length > 0 ? blocks.join("\n\n") : null;
};

export const buildRunPrompt = (input: RunPromptInput): string => {
  const source = sourceViewFor(input);
  const contract = contractViewFor(input);
  const sections: string[] = [];

  const header = input.continuation
    ? `## Symphony continuation\n\nContinue the in-progress work for ${source.identifier}: ${source.title}. Do not re-plan from scratch unless the previous plan is invalidated.`
    : `## Symphony work item\n\nIssue ${source.identifier}: ${source.title}`;
  sections.push(header);

  if (input.acceptedGuidance !== undefined) {
    sections.push(
      `Accepted brief: workflow revision ${input.acceptedGuidance.workflow.revision}; digest ${input.acceptedGuidance.digest}.`,
    );
  }

  if (source.description) {
    sections.push(`### Description\n\n${source.description}`);
  }

  if (source.acceptanceCriteria.length > 0) {
    sections.push(
      `### Acceptance criteria\n\n${source.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  if (source.labels.length > 0) {
    sections.push(`### Labels\n\n${source.labels.join(", ")}`);
  }

  const guidance = input.acceptedGuidance?.guidance ?? input.operatorGuidance;
  if (guidance !== undefined && !input.continuation) {
    const guidanceSection = buildOperatorGuidanceSection(guidance);
    if (guidanceSection !== null) {
      sections.push(`### Operator guidance\n\n${guidanceSection}`);
    }
  }

  if (!input.continuation) {
    sections.push(`### WORKFLOW contract\n\n${buildWorkflowContractSection(contract)}`);
  }

  const policyNote = contract.planOnly
    ? "Work in plan mode: analyze the task and produce a concrete plan. Do NOT modify any files."
    : "Work in execution mode: make the changes needed, subject to the configured approval policy.";

  sections.push(`### Operating constraints\n\n${policyNote}`);

  sections.push(`### Branch\n\nWork on branch ${contract.branch} in the workspace directory.`);

  if (input.reviewFeedback !== undefined) {
    sections.push(
      `### Review feedback\n\n${buildReviewFeedbackSection(input.reviewFeedback, input.branch)}`,
    );
  }

  return sections.join("\n\n");
};

const deriveBranchLabel = (autonomy: AutonomyLevel): string => {
  if (autonomy === "prepare" || autonomy === "observe") {
    return "a read-only exploration branch";
  }
  return "the working branch";
};
