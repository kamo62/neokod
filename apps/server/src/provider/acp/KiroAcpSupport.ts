import type { KiroSettings } from "@neokod/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@neokod/shared/hostProcess";
import { buildProviderChildEnv } from "@neokod/shared/providerChildEnv";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const KIRO_API_KEY_ENV = "KIRO_API_KEY";

export function hasKiroV3ApiKey(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment[KIRO_API_KEY_ENV]?.trim());
}

export function buildKiroAcpSpawnInput(
  settings: Pick<KiroSettings, "agentEngine" | "binaryPath">,
  cwd: string,
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  managedHome?: string,
): AcpSessionRuntime.AcpSpawnInput {
  const environment = buildProviderChildEnv({
    parentEnv,
    platform,
    allow: settings.agentEngine === "v3" ? [KIRO_API_KEY_ENV] : [],
    ...(managedHome ? { additions: { HOME: managedHome } } : {}),
  });
  return {
    command: settings.binaryPath || "kiro-cli",
    args: ["acp", "--agent-engine", settings.agentEngine],
    cwd,
    env: environment.env,
    extendEnv: environment.extendEnv,
    detached: platform !== "win32",
    forceKillAfter: Duration.seconds(10),
  };
}

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "preAuthenticatedByEnvironmentVariable" | "spawn"
> {
  readonly settings: KiroSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly managedHome?: string;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { settings, environment, managedHome, childProcessSpawner, ...runtimeOptions } = input;
    const parentEnvironment = yield* HostProcessEnvironment;
    const platform = yield* HostProcessPlatform;
    const effectiveEnvironment = environment ?? parentEnvironment;
    if (settings.agentEngine === "v3" && !hasKiroV3ApiKey(effectiveEnvironment)) {
      return yield* EffectAcpErrors.AcpRequestError.authRequired(
        "Kiro v3 ACP requires KIRO_API_KEY in this provider instance's environment",
        { reason: "kiro_v3_api_key_required", environmentVariable: KIRO_API_KEY_ENV },
      );
    }
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildKiroAcpSpawnInput(
          settings,
          input.cwd,
          effectiveEnvironment,
          platform,
          managedHome,
        ),
        // V2 uses the CLI credential store and advertises no auth methods. V3
        // receives KIRO_API_KEY directly and must not launch interactive ACP auth.
        ...(settings.agentEngine === "v3"
          ? { preAuthenticatedByEnvironmentVariable: KIRO_API_KEY_ENV }
          : {}),
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
