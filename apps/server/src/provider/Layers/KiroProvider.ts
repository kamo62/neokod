import { type KiroSettings, ProviderDriverKind, type ServerProviderModel } from "@neokod/contracts";
import { createModelCapabilities } from "@neokod/shared/model";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import { buildProviderChildEnv } from "@neokod/shared/providerChildEnv";
import { resolveSpawnCommand } from "@neokod/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { hasKiroV3ApiKey, KIRO_API_KEY_ENV } from "../acp/KiroAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("kiro");
export const MINIMUM_KIRO_CLI_VERSION = "2.16.2";
const VERSION_PROBE_TIMEOUT_MS = 4_000;

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const versionParts = (value: string): readonly [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = value.split(".").map(Number);
  return [major, minor, patch];
};

export function isKiroVersionSupported(version: string | null | undefined): boolean {
  if (!version) return false;
  const current = versionParts(version);
  const minimum = versionParts(MINIMUM_KIRO_CLI_VERSION);
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

const KIRO_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Kiro default",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

export const buildInitialKiroProviderSnapshot = Effect.fn("buildInitialKiroProviderSnapshot")(
  function* (settings: KiroSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: KIRO_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: KIRO_MODELS,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Kiro CLI availability. Crew and Symphony are disabled.",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Kiro is disabled in Neokod settings.",
          },
    });
  },
);

const runKiroVersionCommand = (settings: KiroSettings, parentEnv: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = buildProviderChildEnv({ parentEnv, platform });
    const command = settings.binaryPath || "kiro-cli";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment.env,
      extendEnv: environment.extendEnv,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment.env,
        extendEnv: environment.extendEnv,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  settings: KiroSettings,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = KIRO_MODELS;
  if (!settings.enabled) {
    return yield* buildInitialKiroProviderSnapshot(settings);
  }
  const versionExit = yield* runKiroVersionCommand(settings, parentEnv).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionExit)) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(versionExit.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionExit.failure)
          ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
          : "Failed to execute the Kiro CLI health check.",
      },
    });
  }
  if (Option.isNone(versionExit.success)) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI timed out while running `kiro-cli --version`.",
      },
    });
  }

  const result = versionExit.success.value;
  const version = parseGenericCliVersion(`${result.stdout}\n${result.stderr}`);
  const supported = result.code === 0 && isKiroVersionSupported(version);
  const missingV3ApiKey = settings.agentEngine === "v3" && !hasKiroV3ApiKey(parentEnv);
  return buildServerProvider({
    driver: PROVIDER,
    presentation: KIRO_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: supported && !missingV3ApiKey ? "warning" : "error",
      auth: { status: missingV3ApiKey ? "unauthenticated" : "unknown" },
      message:
        result.code !== 0
          ? "Kiro CLI is installed but failed to run."
          : !supported
            ? `Kiro CLI ${version ?? "unknown"} is below the required ${MINIMUM_KIRO_CLI_VERSION}.`
            : missingV3ApiKey
              ? `Kiro v3 ACP requires an explicit sensitive ${KIRO_API_KEY_ENV} on this provider instance; CLI browser login is available only with v2.`
              : `Kiro ${settings.agentEngine} is available for a supervised Work-mode probe. Readiness requires a completed managed turn with assistant output; Crew and Symphony remain disabled.`,
    },
  });
});
