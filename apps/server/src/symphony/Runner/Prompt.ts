import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";

/**
 * Prompt building for Symphony runs (plan 8.1, SPEC 7.1).
 *
 * The rendered prompt is the first-turn input for the agent. It binds the
 * issue context (identifier, title, description, acceptance criteria from
 * labels) plus the workflow's own prompt template when configured, and in
 * `prepare` autonomy explicitly instructs the agent to produce a plan and not
 * modify files (edits are blocked at the sandbox anyway).
 */

const CRITERIA_PREFIX = /^acceptance(\s+criteri[ae])?:/i;

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
}

export const buildRunPrompt = (input: RunPromptInput): string => {
  const { issue, config } = input;
  const sections: string[] = [];

  const header = input.continuation
    ? `## Symphony continuation\n\nContinue the in-progress work for ${issue.identifier}: ${issue.title}. Do not re-plan from scratch unless the previous plan is invalidated.`
    : `## Symphony work item\n\nIssue ${issue.identifier}: ${issue.title}`;
  sections.push(header);

  if (issue.description) {
    sections.push(`### Description\n\n${issue.description}`);
  }

  const criteria = extractAcceptanceCriteria(issue.description);
  if (criteria.length > 0) {
    sections.push(`### Acceptance criteria\n\n${criteria.map((c) => `- ${c}`).join("\n")}`);
  }

  if (issue.labels.length > 0) {
    sections.push(`### Labels\n\n${issue.labels.join(", ")}`);
  }

  const policyNote =
    input.planOnly || config.autonomy === "prepare" || config.autonomy === "observe"
      ? "Work in plan mode: analyze the task and produce a concrete plan. Do NOT modify any files."
      : "Work in execution mode: make the changes needed, subject to the configured approval policy.";

  sections.push(`### Operating constraints\n\n${policyNote}`);

  sections.push(
    `### Branch\n\nWork on branch ${input.branch ?? deriveBranchLabel(config)} in the workspace directory.`,
  );

  if (input.reviewFeedback !== undefined) {
    sections.push(
      `### Review feedback\n\n${buildReviewFeedbackSection(input.reviewFeedback, input.branch)}`,
    );
  }

  return sections.join("\n\n");
};

const deriveBranchLabel = (config: EffectiveWorkflowConfig): string => {
  if (config.autonomy === "prepare" || config.autonomy === "observe") {
    return "a read-only exploration branch";
  }
  return "the working branch";
};
