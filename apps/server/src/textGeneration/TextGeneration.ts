import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  ChatAttachment,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
} from "@neokod/contracts";
import { TextGenerationError } from "@neokod/contracts";
import {
  evaluateModelCatalogueEvidence,
  type ModelCatalogueEvidenceInput,
} from "@neokod/shared/model";

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

const catalogueEvidenceFor = (
  instance: ProviderInstance,
  snapshot: ServerProvider,
): ModelCatalogueEvidenceInput => ({
  enabled: instance.enabled,
  installed: snapshot.installed,
  status: snapshot.status,
  ...(snapshot.availability !== undefined ? { availability: snapshot.availability } : {}),
  auth: snapshot.auth,
  models: snapshot.models,
});

/**
 * Contain actual probe failures as typed generation errors, but keep an
 * interruption-only cause intact so the reactor's auxiliary-activity
 * suppression can still recognise cancellation.
 */
const runAuxiliaryProbe = <A>(
  operation: TextGenerationOp,
  detail: string,
  probe: Effect.Effect<A>,
): Effect.Effect<A, TextGenerationError> =>
  probe.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(new TextGenerationError({ operation, detail })),
    ),
  );

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
  `Provider evidence for instance '${instanceId}' is unavailable or invalid, so model '${model}' could not be verified. Retry, refresh providers, or choose a model in ${SETTINGS_RECOVERY_HINT}.`;

const catalogueIncompleteDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `The provider catalogue for instance '${instanceId}' is empty or incomplete, so model '${model}' could not be verified. Refresh providers or choose a model in ${SETTINGS_RECOVERY_HINT}.`;

const refreshFailedDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `The provider catalogue for instance '${instanceId}' could not be refreshed, so model '${model}' could not be verified. Retry or choose a model in ${SETTINGS_RECOVERY_HINT}.`;

const modelNotAdvertisedDetail = (instanceId: ProviderInstanceId, model: string): string =>
  `Model '${model}' is not advertised by the current provider catalogue for instance '${instanceId}'. Refresh providers or choose a model in ${SETTINGS_RECOVERY_HINT}; auxiliary text generation will not run with an unlisted model.`;

/**
 * One admission gate in front of every registry-dispatched auxiliary
 * operation. It proves exact catalogue/configuration membership for the
 * selected instance only, preserving the caller's original model and options
 * — it never substitutes another instance, model, or options. Snapshot
 * validity is evaluated before membership, and the same shared projection is
 * applied to the initial and refreshed evidence. A missing slug (or an
 * insufficient but valid catalogue) gets at most one exact-instance refresh.
 * Disabled, unavailable, or otherwise invalid evidence is never probed.
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

    const snapshot = yield* runAuxiliaryProbe(
      operation,
      evidenceUnavailableDetail(selection.instanceId, selection.model),
      instance.snapshot.getSnapshot,
    );
    if (snapshot.availability === "unavailable") {
      return yield* failAdmission(
        operation,
        instanceUnavailableDetail(selection.instanceId, selection.model, snapshot),
      );
    }

    const initialEvidence = evaluateModelCatalogueEvidence(
      catalogueEvidenceFor(instance, snapshot),
      selection.model,
    );
    if (initialEvidence.status === "listed") {
      return instance.textGeneration;
    }
    if (initialEvidence.status === "unverified" && initialEvidence.reason === "invalid-evidence") {
      return yield* failAdmission(
        operation,
        evidenceUnavailableDetail(selection.instanceId, selection.model),
      );
    }

    // Exactly one refresh for a valid catalogue that cannot confirm the slug.
    // The selected instance owns this probe; another instance of the same
    // driver is never consulted.
    const refreshed = yield* runAuxiliaryProbe(
      operation,
      refreshFailedDetail(selection.instanceId, selection.model),
      instance.snapshot.refresh,
    );
    const refreshedEvidence = evaluateModelCatalogueEvidence(
      catalogueEvidenceFor(instance, refreshed),
      selection.model,
    );
    if (refreshedEvidence.status === "listed") {
      return instance.textGeneration;
    }
    if (refreshedEvidence.status === "not-listed") {
      return yield* failAdmission(
        operation,
        modelNotAdvertisedDetail(selection.instanceId, selection.model),
      );
    }
    return yield* failAdmission(
      operation,
      refreshedEvidence.reason === "invalid-evidence"
        ? evidenceUnavailableDetail(selection.instanceId, selection.model)
        : catalogueIncompleteDetail(selection.instanceId, selection.model),
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
