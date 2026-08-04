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

export interface RunPromptInput {
  readonly issue: NormalizedIssue;
  readonly config: EffectiveWorkflowConfig;
  readonly branch?: string;
  readonly continuation?: boolean;
  readonly planOnly?: boolean;
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

  return sections.join("\n\n");
};

const deriveBranchLabel = (config: EffectiveWorkflowConfig): string => {
  if (config.autonomy === "prepare" || config.autonomy === "observe") {
    return "a read-only exploration branch";
  }
  return "the working branch";
};
