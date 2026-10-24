import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type {
  ChatAttachment,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@neokod/contracts";
import { TextGenerationError } from "@neokod/contracts";
import { normalizeModelSlug } from "@neokod/shared/model";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface CodeReviewGenerationInput {
  cwd: string;
  objective: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baseRef: string;
  headRef: string;
  diffPatch: string;
  /** What model and provider instance to use for this reviewer. */
  modelSelection: ModelSelection;
}

export interface CodeReviewGenerationResult {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: ReadonlyArray<{
    readonly severity: "info" | "warning" | "blocking";
    readonly title: string;
    readonly detail: string;
    readonly path?: string | undefined;
  }>;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateCodeReview(input: CodeReviewGenerationInput): Promise<CodeReviewGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate pull request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Review a bounded host-provided diff using a read-only model call.
     */
    readonly generateCodeReview: (
      input: CodeReviewGenerationInput,
    ) => Effect.Effect<CodeReviewGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /**
     * Generate a concise thread title from a user's first message.
     */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("neokod/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateCodeReview"
  | "generateBranchName"
  | "generateThreadTitle";

const SETTINGS_RECOVERY_HINT = "Settings → Text generation model";

const failAdmission = (operation: TextGenerationOp, detail: string) =>
  Effect.fail(new TextGenerationError({ operation, detail }));

/**
 * Catalogue membership, not a capability claim. The selected slug counts as
 * listed when it appears verbatim or matches an advertised slug after the
 * driver's alias normalisation (for example `gpt-5-codex` → `gpt-5.4`).
 * Custom models are ordinary catalogue entries once a driver appends them,
 * and a null `capabilities` field must not be treated as unsupported.
 */
const isModelAdvertised = (
  driverKind: ProviderInstance["driverKind"],
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
): boolean => {
  const normalizedSelection = normalizeModelSlug(model, driverKind);
  if (!normalizedSelection) {
    return false;
  }
  return models.some((candidate) => {
    if (candidate.slug === model) {
      return true;
    }
    const normalizedCandidate = normalizeModelSlug(candidate.slug, driverKind) ?? candidate.slug;
    return normalizedCandidate === normalizedSelection;
  });
};

const instanceDisabledDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `Provider instance '${instanceId}' is disabled, so model '${model}' cannot be used for auxiliary text generation. Enable the instance or choose another one in ${SETTINGS_RECOVERY_HINT}.`;

const instanceUnavailableDetail = (
  instanceId: ProviderInstanceId,
  model: string,
  snapshot: ServerProvider,
): string => {
  const reason = snapshot.unavailableReason?.trim();
  const suffix = reason ? ` (${reason})` : "";
  return `Provider instance '${instanceId}' is unavailable${suffix}, so model '${model}' cannot be used for auxiliary text generation. Choose a provider instance in ${SETTINGS_RECOVERY_HINT}.`;
};

const evidenceUnavailableDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `Provider evidence for instance '${instanceId}' is unavailable, so model '${model}' could not be verified. Retry, refresh providers, or choose a model in ${SETTINGS_RECOVERY_HINT}.`;

const catalogueIncompleteDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `The provider catalogue for instance '${instanceId}' is empty or incomplete, so model '${model}' could not be verified. Refresh providers or choose a model in ${SETTINGS_RECOVERY_HINT}.`;

const refreshFailedDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `The provider catalogue for instance '${instanceId}' could not be refreshed, so model '${model}' could not be verified. Retry or choose a model in ${SETTINGS_RECOVERY_HINT}.`;

const modelNotAdvertisedDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `Model '${model}' is not advertised by the current provider catalogue for instance '${instanceId}'. Refresh providers or choose a model in ${SETTINGS_RECOVERY_HINT}; auxiliary text generation will not run with an unlisted model.`;

/**
 * One admission gate in front of every registry-dispatched auxiliary
 * operation. It proves catalogue membership for the selected instance only,
 * preserving the caller's original model and options — it never substitutes
 * another instance, model, or options. A single refresh re-checks a missing
 * slug, so an old cached omission is not treated as final. Refresh defects are
 * contained as typed generation errors rather than becoming generation runs.
 */
const resolveAdmittedTextGeneration = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  selection: ModelSelection,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  Effect.gen(function* () {
    const instance = yield* registry.getInstance(selection.instanceId);
    if (instance === undefined) {
      return yield* failAdmission(
        operation,
        `No provider instance is registered for id '${selection.instanceId}'. Choose a provider instance in ${SETTINGS_RECOVERY_HINT}.`,
      );
    }
    if (!instance.enabled) {
      return yield* failAdmission(
        operation,
        instanceDisabledDetail(selection.instanceId, selection.model),
      );
    }

    const snapshotExit = yield* Effect.exit(instance.snapshot.getSnapshot);
    if (Exit.isFailure(snapshotExit)) {
      return yield* failAdmission(
        operation,
        evidenceUnavailableDetail(selection.instanceId, selection.model),
      );
    }
    const snapshot = snapshotExit.value;
    if (snapshot.availability === "unavailable") {
      return yield* failAdmission(
        operation,
        instanceUnavailableDetail(selection.instanceId, selection.model, snapshot),
      );
    }
    if (isModelAdvertised(instance.driverKind, snapshot.models, selection.model)) {
      return instance.textGeneration;
    }

    // Exactly one refresh for an absent slug — including one the initial
    // catalogue could not describe. The selected instance owns this probe;
    // another instance of the same driver is never consulted.
    const refreshedExit = yield* Effect.exit(instance.snapshot.refresh);
    if (Exit.isFailure(refreshedExit)) {
      return yield* failAdmission(
        operation,
        refreshFailedDetail(selection.instanceId, selection.model),
      );
    }
    const refreshed = refreshedExit.value;
    if (isModelAdvertised(instance.driverKind, refreshed.models, selection.model)) {
      return instance.textGeneration;
    }
    if (refreshed.models.length === 0) {
      return yield* failAdmission(
        operation,
        catalogueIncompleteDetail(selection.instanceId, selection.model),
      );
    }
    return yield* failAdmission(
      operation,
      modelNotAdvertisedDetail(selection.instanceId, selection.model),
    );
  });

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveAdmittedTextGeneration(registry, "generateCommitMessage", input.modelSelection).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveAdmittedTextGeneration(registry, "generatePrContent", input.modelSelection).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      ),
    generateCodeReview: (input) =>
      resolveAdmittedTextGeneration(registry, "generateCodeReview", input.modelSelection).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCodeReview(input)),
      ),
    generateBranchName: (input) =>
      resolveAdmittedTextGeneration(registry, "generateBranchName", input.modelSelection).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveAdmittedTextGeneration(registry, "generateThreadTitle", input.modelSelection).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
