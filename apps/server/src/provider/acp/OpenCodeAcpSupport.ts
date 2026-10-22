import type { OpenCodeSettings } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  collectSessionConfigOptionValues,
  findSessionModelConfigOption,
} from "./AcpRuntimeModel.ts";

export const OPENCODE_ACP_BINARY = "opencode";
// OpenCode 2.0.32 advertises exactly one ACP auth method. The handler returns
// success for this id and reads the CLI's own `opencode auth login` state.
export const OPENCODE_ACP_AUTH_METHOD_ID = "opencode-login";

type OpenCodeAcpRuntimeOpenCodeSettings = Pick<OpenCodeSettings, "binaryPath">;

export interface OpenCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "preAuthenticatedByEnvironmentVariable" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly openCodeSettings: OpenCodeAcpRuntimeOpenCodeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Builds the `opencode acp` launch without merging an inherited environment
 * when the caller supplies one. Credential filtering remains the caller's
 * responsibility; this seam never reads process.env.
 */
export function buildOpenCodeAcpSpawnInput(
  openCodeSettings: OpenCodeAcpRuntimeOpenCodeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: openCodeSettings?.binaryPath?.trim() || OPENCODE_ACP_BINARY,
    args: ["acp"],
    cwd,
    ...(environment === undefined ? {} : { env: environment, extendEnv: false }),
  };
}

export const makeOpenCodeAcpRuntime = (
  input: OpenCodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { openCodeSettings, environment, childProcessSpawner, ...runtimeOptions } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildOpenCodeAcpSpawnInput(openCodeSettings, input.cwd, environment),
        authMethodId: OPENCODE_ACP_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export type OpenCodeAcpSelectableCategory = "model" | "thought_level" | "mode";

export interface OpenCodeAcpConfigCapabilities {
  readonly modelOptionId?: string;
  readonly modelValues: ReadonlyArray<string>;
  readonly modelCurrentValue?: string;
  readonly effortOptionId?: string;
  readonly effortValues: ReadonlyArray<string>;
  readonly modeOptionId?: string;
  readonly modeValues: ReadonlyArray<string>;
}

export interface OpenCodeAcpSelectionRequest {
  readonly model?: string | null | undefined;
  readonly effort?: string | null | undefined;
  readonly mode?: string | null | undefined;
}

export interface OpenCodeAcpAppliedConfig {
  readonly configId: string;
  readonly value: string;
}

export interface OpenCodeAcpAppliedSelection {
  readonly applied: ReadonlyArray<OpenCodeAcpAppliedConfig>;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
}

type SelectConfigOption = Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>;

function findSelectConfigOptionByCategory(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  category: OpenCodeAcpSelectableCategory,
): SelectConfigOption | undefined {
  return configOptions?.find(
    (option): option is SelectConfigOption =>
      option.category === category && option.type === "select",
  );
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function inspectOpenCodeAcpCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): OpenCodeAcpConfigCapabilities {
  const modelOption = findSessionModelConfigOption(configOptions);
  const effortOption = findSelectConfigOptionByCategory(configOptions, "thought_level");
  const modeOption = findSelectConfigOptionByCategory(configOptions, "mode");
  const currentModelValue = modelOption?.currentValue.trim();
  return {
    ...(modelOption === undefined ? {} : { modelOptionId: modelOption.id }),
    ...(currentModelValue ? { modelCurrentValue: currentModelValue } : {}),
    modelValues: modelOption ? collectSessionConfigOptionValues(modelOption) : [],
    ...(effortOption === undefined ? {} : { effortOptionId: effortOption.id }),
    effortValues: effortOption ? collectSessionConfigOptionValues(effortOption) : [],
    ...(modeOption === undefined ? {} : { modeOptionId: modeOption.id }),
    modeValues: modeOption ? collectSessionConfigOptionValues(modeOption) : [],
  };
}

function missingConfigOptionError(
  kind: "model" | "effort" | "mode",
  value: string,
): EffectAcpErrors.AcpRequestError {
  return EffectAcpErrors.AcpRequestError.invalidParams(
    `OpenCode ACP does not advertise a ${kind} configuration option`,
    {
      reason: "config_option_not_advertised",
      configKind: kind,
      requestedValue: value,
    },
  );
}

function unadvertisedConfigValueError(
  kind: "model" | "effort" | "mode",
  configId: string,
  value: string,
  allowedValues: ReadonlyArray<string>,
  applied: ReadonlyArray<OpenCodeAcpAppliedConfig>,
): EffectAcpErrors.AcpRequestError {
  return EffectAcpErrors.AcpRequestError.invalidParams(
    `OpenCode ACP ${kind} value "${value}" is not advertised for config option "${configId}"`,
    {
      reason: "config_value_not_advertised",
      configKind: kind,
      configId,
      requestedValue: value,
      allowedValues,
      appliedConfig: applied,
    },
  );
}

/**
 * Applies model, effort, and mode through the advertised ACP config options.
 * Model is written first because OpenCode 2.0.32 changes the available effort
 * values for the selected model. Every write is preceded by a capability check;
 * unsupported selections fail without sending `session/set_config_option`.
 */
export function applyOpenCodeAcpSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly selection: OpenCodeAcpSelectionRequest;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<OpenCodeAcpAppliedSelection, E> {
  const applied: Array<OpenCodeAcpAppliedConfig> = [];

  const applyValue = (
    kind: "model" | "effort" | "mode",
    category: OpenCodeAcpSelectableCategory,
    value: string,
  ): Effect.Effect<string, EffectAcpErrors.AcpError> =>
    Effect.gen(function* () {
      const configOptions = yield* input.runtime.getConfigOptions;
      const option = findSelectConfigOptionByCategory(configOptions, category);
      if (option === undefined) {
        return yield* missingConfigOptionError(kind, value);
      }
      const allowedValues = collectSessionConfigOptionValues(option);
      if (!allowedValues.includes(value)) {
        return yield* unadvertisedConfigValueError(kind, option.id, value, allowedValues, applied);
      }
      if (option.currentValue.trim() !== value) {
        yield* input.runtime.setConfigOption(option.id, value);
        applied.push({ configId: option.id, value });
      }
      return value;
    });

  return Effect.gen(function* () {
    const requestedModel = trimToUndefined(input.selection.model);
    const requestedEffort = trimToUndefined(input.selection.effort);
    const requestedMode = trimToUndefined(input.selection.mode);

    const model =
      requestedModel === undefined
        ? undefined
        : yield* applyValue("model", "model", requestedModel);
    const effort =
      requestedEffort === undefined
        ? undefined
        : yield* applyValue("effort", "thought_level", requestedEffort);
    const mode =
      requestedMode === undefined ? undefined : yield* applyValue("mode", "mode", requestedMode);

    return {
      applied,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(mode === undefined ? {} : { mode }),
    };
  }).pipe(Effect.mapError(input.mapError));
}

export interface OpenCodeAcpTextPromptResult {
  readonly stopReason: EffectAcpSchema.PromptResponse["stopReason"];
  readonly text: string;
  readonly usage?: EffectAcpSchema.PromptResponse["usage"];
}

/**
 * Collects streamed assistant text for model-backed text generation (for example
 * review or commit-message prompts). Timeout and structured-output policy stay
 * with the caller, as in the existing Cursor and Grok text-generation adapters.
 *
 * This replaces the runtime's session-update handler, so callers must choose
 * between this helper and consuming `getEvents` for the same runtime.
 */
export function runOpenCodeAcpTextPrompt<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "handleSessionUpdate" | "start" | "prompt"
  >;
  readonly prompt: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<OpenCodeAcpTextPromptResult, E> {
  return Effect.gen(function* () {
    const outputRef = yield* Ref.make("");
    yield* input.runtime.handleSessionUpdate((notification) => {
      const update = notification.update;
      if (update.sessionUpdate !== "agent_message_chunk") {
        return Effect.void;
      }
      const content = update.content;
      if (content.type !== "text") {
        return Effect.void;
      }
      return Ref.update(outputRef, (current) => current + content.text);
    });

    yield* input.runtime.start();
    const response = yield* input.runtime.prompt({
      prompt: [{ type: "text", text: input.prompt }],
    });
    return {
      stopReason: response.stopReason,
      text: (yield* Ref.get(outputRef)).trim(),
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    };
  }).pipe(Effect.mapError(input.mapError));
}
