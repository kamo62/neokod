import type { KiroSettings } from "@neokod/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@neokod/shared/hostProcess";
import { buildProviderChildEnv } from "@neokod/shared/providerChildEnv";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export function buildKiroAcpSpawnInput(
  settings: Pick<KiroSettings, "binaryPath">,
  cwd: string,
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): AcpSessionRuntime.AcpSpawnInput {
  const environment = buildProviderChildEnv({ parentEnv, platform });
  return {
    command: settings.binaryPath || "kiro-cli",
    args: ["acp"],
    cwd,
    env: environment.env,
    extendEnv: environment.extendEnv,
    detached: platform !== "win32",
    forceKillAfter: Duration.seconds(10),
  };
}

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: KiroSettings;
  readonly environment?: NodeJS.ProcessEnv;
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
    const { settings, environment, childProcessSpawner, ...runtimeOptions } = input;
    const parentEnvironment = yield* HostProcessEnvironment;
    const platform = yield* HostProcessPlatform;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildKiroAcpSpawnInput(
          settings,
          input.cwd,
          environment ?? parentEnvironment,
          platform,
        ),
        // Kiro CLI uses its own credential store and advertises authMethods: [].
        // No ACP authenticate request is sent.
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
