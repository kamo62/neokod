/**
 * CopilotProvider — status probing + model catalog for the GitHub Copilot
 * driver. Mirrors `Layers/ClaudeProvider.ts`'s snapshot-building shape, but
 * probes over the already-started `CopilotClient` RPC connection instead of
 * spawning a disposable CLI process: Copilot's CLI is a long-lived
 * JSON-RPC server bundled with `@github/copilot-sdk`, not a one-shot
 * binary invoked per health check.
 *
 * @module provider/copilot/CopilotProvider
 */
import type { CopilotClient, ModelInfo } from "@github/copilot-sdk";
import {
  type CopilotSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const COPILOT_DRIVER_KIND = ProviderDriverKind.make("githubCopilot");
const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: false,
} as const;
const STATUS_PROBE_TIMEOUT_MS = 8_000;

// `ReasoningEffort` lives in the SDK's `types.ts` but is not re-exported
// from the package root in 1.0.5 — derive it structurally from `ModelInfo`
// the same way the adapter derives its user-input request/response types.
type CopilotSdkReasoningEffort = NonNullable<ModelInfo["defaultReasoningEffort"]>;

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function buildReasoningEffortOption(
  supportedReasoningEfforts: ReadonlyArray<CopilotSdkReasoningEffort>,
  defaultReasoningEffort: CopilotSdkReasoningEffort | undefined,
) {
  return buildSelectOptionDescriptor({
    id: "reasoningEffort",
    label: "Reasoning",
    options: supportedReasoningEfforts.map((value) => ({
      value,
      label: REASONING_EFFORT_LABELS[value] ?? value,
      ...(value === defaultReasoningEffort ? { isDefault: true } : {}),
    })),
  });
}

const REASONING_EFFORT_OPTION = buildReasoningEffortOption(
  ["low", "medium", "high", "xhigh"],
  "medium",
);

const DEFAULT_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const REASONING_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [REASONING_EFFORT_OPTION],
});

/**
 * Small static catalog of the models GitHub Copilot exposes out of the box.
 * `client.listModels()` returns the live, account-scoped catalog (billing
 * and policy metadata included), but requires a started, authenticated
 * client to succeed. This static list keeps the settings UI populated even
 * before the first successful probe, matching the other built-in drivers
 * (Claude, Codex, Grok all ship a static `BUILT_IN_MODELS` list rather than
 * probing for it live).
 */
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: REASONING_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 mini",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.1",
    name: "Claude Opus 4.1",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
];

export function getCopilotModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_COPILOT_MODEL_CAPABILITIES
  );
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function copilotModels(
  copilotSettings: CopilotSettings,
  builtInModels: ReadonlyArray<ServerProviderModel> = BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    COPILOT_DRIVER_KIND,
    copilotSettings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );
}

function capabilitiesForModelInfo(model: ModelInfo): ModelCapabilities {
  const efforts =
    model.supportedReasoningEfforts ??
    (model.defaultReasoningEffort ? [model.defaultReasoningEffort] : []);
  return efforts.length > 0
    ? createModelCapabilities({
        optionDescriptors: [buildReasoningEffortOption(efforts, model.defaultReasoningEffort)],
      })
    : DEFAULT_COPILOT_MODEL_CAPABILITIES;
}

function modelsFromModelInfo(models: ReadonlyArray<ModelInfo>): ReadonlyArray<ServerProviderModel> {
  return models
    .filter((model) => model.policy?.state !== "disabled")
    .map((model) => ({
      slug: model.id,
      name: model.name,
      isCustom: false,
      capabilities: capabilitiesForModelInfo(model),
    }));
}

/**
 * Snapshot used before the driver has completed its first live probe (or
 * when Copilot is disabled). Mirrors `makePendingClaudeProvider`.
 */
export const makePendingCopilotProvider = (
  copilotSettings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = copilotModels(copilotSettings);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot provider status has not been checked in this session yet.",
      },
    });
  });

/**
 * Live probe against a started `CopilotClient`. Unlike Claude/Codex/Grok,
 * "installed" is effectively always true once `client.start()` has
 * succeeded — the Copilot CLI runtime ships bundled inside
 * `@github/copilot-sdk` rather than as a separate binary the user installs.
 * The interesting signal here is authentication, not installation.
 */
export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  client: Pick<CopilotClient, "getStatus" | "getAuthStatus" | "listModels">,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* nowIso;
  const models = copilotModels(copilotSettings);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const statusResult = yield* Effect.tryPromise(() => client.getStatus()).pipe(
    Effect.timeoutOption(STATUS_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(statusResult) || Option.isNone(statusResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Could not reach the GitHub Copilot runtime.",
      },
    });
  }

  const status = statusResult.success.value;
  const authResult = yield* Effect.tryPromise(() => client.getAuthStatus()).pipe(
    Effect.timeoutOption(STATUS_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authResult) || Option.isNone(authResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: status.version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify GitHub Copilot authentication status.",
      },
    });
  }

  const auth = authResult.success.value;
  if (!auth.isAuthenticated) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: status.version,
        status: "error",
        auth: { status: "unauthenticated" },
        message:
          auth.statusMessage ??
          "GitHub Copilot is not authenticated. Sign in with `copilot` CLI or set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.",
      },
    });
  }

  const modelListResult = yield* Effect.tryPromise(() => client.listModels()).pipe(
    Effect.timeoutOption(STATUS_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const liveModels =
    Result.isSuccess(modelListResult) && Option.isSome(modelListResult.success)
      ? modelsFromModelInfo(modelListResult.success.value)
      : [];
  const readyModels = liveModels.length > 0 ? copilotModels(copilotSettings, liveModels) : models;

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models: readyModels,
    probe: {
      installed: true,
      version: status.version,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(auth.login ? { email: auth.login } : {}),
        ...(auth.authType ? { type: auth.authType, label: `GitHub (${auth.authType})` } : {}),
      },
    },
  });
});
