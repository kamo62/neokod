import { TextGenerationError } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import type { TextGeneration } from "./TextGeneration.ts";

const unsupported = <A>(operation: string): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        operation === "generateCodeReview"
          ? "Kiro ACP is not eligible for Symphony code review."
          : "Kiro ACP does not expose this bounded text-generation operation.",
    }),
  );

/**
 * Kiro is a Work-mode ACP runtime, not a `TextGeneration` reviewer. Keeping a
 * complete service here satisfies the instance contract while failing every
 * unsupported seam explicitly and, most importantly, never fabricating a
 * Symphony review verdict.
 */
export const makeKiroTextGeneration = (): TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateCodeReview: () => unsupported("generateCodeReview"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
