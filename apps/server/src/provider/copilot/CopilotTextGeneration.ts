/**
 * CopilotTextGeneration — commit/PR/branch/title text generation via the
 * shared `CopilotClient`. Modeled on `GrokTextGeneration.ts`: the Copilot
 * SDK (like Grok's ACP CLI) has no native structured-output flag, so this
 * asks the model for JSON via the shared prompt builders in
 * `TextGenerationPrompts.ts` and decodes the response with
 * `extractJsonObject` + `Schema.decodeEffect`, same as Grok/Cursor.
 *
 * Each generation call opens a short-lived Copilot session (streaming
 * disabled, tool use declined) against the already-started shared client
 * and disconnects it when done — text generation never needs a persistent
 * session the way chat threads do.
 *
 * @module provider/copilot/CopilotTextGeneration
 */
import type { CopilotClient, PermissionRequestResult } from "@github/copilot-sdk";
import { TextGenerationError, type ModelSelection } from "@neokod/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@neokod/shared/git";
import { extractJsonObject } from "@neokod/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";

const COPILOT_TEXT_GENERATION_TIMEOUT_MS = 180_000;

const declineAllPermissions = (): PermissionRequestResult => ({
  kind: "reject",
  feedback: "Tool use is not available during text generation.",
});

type CopilotTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  client: Pick<CopilotClient, "createSession">,
) {
  yield* Effect.void;

  const runCopilotJson = <S extends Schema.Top>(input: {
    readonly operation: CopilotTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise({
        try: () =>
          client.createSession({
            model: input.modelSelection.model,
            workingDirectory: input.cwd,
            streaming: false,
            onPermissionRequest: declineAllPermissions,
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Failed to start a GitHub Copilot session for text generation.",
            cause,
          }),
      });

      const result = yield* Effect.tryPromise({
        try: () =>
          session.sendAndWait({ prompt: input.prompt }, COPILOT_TEXT_GENERATION_TIMEOUT_MS),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "GitHub Copilot text generation request failed or timed out.",
            cause,
          }),
      }).pipe(Effect.ensuring(Effect.tryPromise(() => session.disconnect()).pipe(Effect.ignore)));

      const content = result?.data.content.trim() ?? "";
      if (!content) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "GitHub Copilot returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(content)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "GitHub Copilot returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CopilotTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runCopilotJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CopilotTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runCopilotJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CopilotTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCopilotJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CopilotTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCopilotJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
