import type {
  WorkflowDefinition,
  WorkflowValidationField,
  WorkflowValidationResult,
} from "@neokod/contracts";
import * as Schema from "effect/Schema";
import * as YAML from "yaml";

/**
 * WORKFLOW.md parsing (SPEC 5.2).
 *
 * Splits the file into YAML front matter and a Markdown prompt body. If the
 * file starts with `---`, everything up to the next `---` is YAML front
 * matter; the remaining lines (trimmed) are the prompt template. No front
 * matter means an empty config map and the whole file as the prompt body.
 *
 * Errors are structured and classify into `missing_workflow_file`,
 * `workflow_parse_error`, and `workflow_front_matter_not_a_map` (SPEC 5.5).
 */

export const WorkflowParseErrorType = Schema.Literals([
  "missing_workflow_file",
  "workflow_parse_error",
  "workflow_front_matter_not_a_map",
]);
export type WorkflowParseErrorType = typeof WorkflowParseErrorType.Type;

export class WorkflowParseError extends Schema.TaggedErrorClass<WorkflowParseError>()(
  "WorkflowParseError",
  {
    type: WorkflowParseErrorType,
    message: Schema.String,
  },
) {}

const FRONT_MATTER_DELIMITER = "---";

/**
 * Parse `WORKFLOW.md` content into `{config, promptTemplate}`.
 *
 * `config` is the raw front-matter root object (never nested under a
 * `config` key, per SPEC 5.2). Non-map front matter is an error.
 */
export const parseWorkflowContent = (content: string): WorkflowDefinition => {
  const trimmed = content.startsWith("\uFEFF") ? content.slice(1) : content;
  if (!trimmed.startsWith(FRONT_MATTER_DELIMITER)) {
    return { config: {}, promptTemplate: trimmed.trim() };
  }

  // Strip the opening delimiter line.
  const afterOpen = trimmed.slice(FRONT_MATTER_DELIMITER.length);
  const newlineIndex = afterOpen.indexOf("\n");
  const remainderStart = newlineIndex === -1 ? afterOpen.length : newlineIndex + 1;
  const remainder = afterOpen.slice(remainderStart);

  // Find the closing delimiter line (--- at start of a line).
  const closeIndex = remainder.indexOf(`\n${FRONT_MATTER_DELIMITER}`);
  const atStartIndex = remainder.startsWith(FRONT_MATTER_DELIMITER) ? 0 : -1;
  const effectiveClose =
    atStartIndex === 0 ? atStartIndex : closeIndex === -1 ? -1 : closeIndex + 1;
  if (effectiveClose === -1) {
    throw new WorkflowParseError({
      type: "workflow_parse_error",
      message: "Unterminated YAML front matter: missing closing `---` delimiter",
    });
  }

  const yamlBlock = remainder.slice(0, effectiveClose);
  const promptBody = remainder.slice(effectiveClose + FRONT_MATTER_DELIMITER.length + 1);

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlBlock);
  } catch (cause) {
    throw new WorkflowParseError({
      type: "workflow_parse_error",
      message:
        cause instanceof Error
          ? `Invalid YAML front matter: ${cause.message}`
          : "Invalid YAML front matter",
    });
  }

  if (parsed === null || parsed === undefined) {
    return { config: {}, promptTemplate: promptBody.trim() };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowParseError({
      type: "workflow_front_matter_not_a_map",
      message: "YAML front matter must decode to a map/object",
    });
  }

  return { config: parsed as Record<string, unknown>, promptTemplate: promptBody.trim() };
};

export const validateWorkflowResult = (
  errors: ReadonlyArray<WorkflowValidationField>,
): WorkflowValidationResult => ({
  ok: errors.length === 0,
  errors: errors as WorkflowValidationField[],
});
