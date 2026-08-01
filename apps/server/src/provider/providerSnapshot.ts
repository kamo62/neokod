import type {
  ProviderDriverKind,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderModel,
  ServerProviderState,
  ServerProviderUsage,
} from "@neokod/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { normalizeModelSlug } from "@neokod/shared/model";
import { isWindowsCommandNotFound } from "../processRunner.ts";
import { createProviderVersionAdvisory } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Auth status checks involve disk/network lookups and can be slow on first run (especially Windows)
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ProviderCommandNotFoundError extends Schema.TaggedErrorClass<ProviderCommandNotFoundError>()(
  "ProviderCommandNotFoundError",
  {
    binaryPath: Schema.String,
    exitCode: Schema.Number,
    stdoutLength: Schema.Number,
    stderrLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider command ${this.binaryPath} was not found (exit code ${this.exitCode}).`;
  }
}

const isProviderCommandNotFoundError = Schema.is(ProviderCommandNotFoundError);

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

export interface ServerProviderPresentation {
  readonly displayName: string;
  readonly badgeLabel?: string;
  readonly showInteractionModeToggle?: boolean;
  readonly requiresNewThreadForModelChange?: boolean;
}

export type ServerProviderDraft = Omit<ServerProvider, "instanceId" | "driver">;

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Builds the probe message for a CLI binary that could not be spawned. Names
 * the PATH that was actually searched (a server under systemd inherits a
 * minimal PATH, so "not installed" alone misleads when the CLI is present in
 * an unlisted directory) and points at the binary path setting as the
 * escape hatch.
 */
export function cliNotFoundMessage(input: {
  readonly cliLabel: string;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv | undefined;
}): string {
  const configured = input.binaryPath.trim();
  if (configured.includes("/") || configured.includes("\\")) {
    return `${input.cliLabel} was not found at \`${configured}\`. Check the binary path in the provider settings.`;
  }
  const searchedPath = nonEmptyTrimmed(
    input.environment?.PATH ?? input.environment?.Path ?? input.environment?.path,
  );
  const pathDetail = searchedPath ? `searched PATH: ${searchedPath}` : "PATH is empty";
  return `${input.cliLabel} (\`${configured}\`) was not found on PATH (${pathDetail}). If it is installed, set the binary path in the provider settings to its absolute path.`;
}

export function isCommandMissingCause(error: unknown): boolean {
  if (isProviderCommandNotFoundError(error)) return true;
  return error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound";
}

const isChildLikelyRunning = (
  child: ChildProcessSpawner.ChildProcessHandle,
): Effect.Effect<boolean> =>
  // On error, assume the child is running: skipping the kills on an unknown
  // state is what would hand control back to the unbounded exit wait below.
  child.isRunning.pipe(Effect.orElseSucceed(() => true));

/**
 * Terminate a spawned child within a bounded window: SIGTERM, wait up to
 * `grace`, then SIGKILL.
 *
 * The spawner's own scope cleanup sends SIGTERM and then waits for the exit
 * signal with no bound, and its `forceKillAfter` option times only the
 * instantaneous signal send rather than the exit wait, so a child that
 * ignores SIGTERM parks the closing fiber forever. That is the dependency
 * defect behind the 3.5.20 updater fix; `DesktopBackendManager`'s
 * `terminateProcess` applies the same treatment on the desktop side. Running
 * this before the spawner's cleanup guarantees the process is gone, which
 * makes the cleanup's unbounded wait resolve immediately.
 */
const escalateChildTermination = (
  child: ChildProcessSpawner.ChildProcessHandle,
  grace: Duration.Duration,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* isChildLikelyRunning(child))) return;
    yield* child.kill({ killSignal: "SIGTERM" }).pipe(Effect.timeoutOption(grace), Effect.ignore);
    if (!(yield* isChildLikelyRunning(child))) return;
    yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.timeoutOption(grace), Effect.ignore);
  });

export const spawnAndCollect = (
  binaryPath: string,
  command: ChildProcess.Command,
  options?: { readonly forceKillAfter?: Duration.Duration },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const forceKillAfter = options?.forceKillAfter;
    if (forceKillAfter !== undefined) {
      // Registered after the spawn, so on scope close it runs before the
      // spawner's own cleanup and bounds that cleanup's exit wait.
      yield* Effect.addFinalizer(() => escalateChildTermination(child, forceKillAfter));
    }
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* new ProviderCommandNotFoundError({
        binaryPath,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
    }
    return result;
  }).pipe(Effect.scoped);

export function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  provider: ProviderDriverKind,
  customModels: ReadonlyArray<string>,
  customModelCapabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildSelectOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly options:
    | ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>
    | undefined;
  readonly description?: string;
  readonly promptInjectedValues?: ReadonlyArray<string>;
}) {
  const options = (input.options ?? []).map((option) =>
    option.isDefault
      ? { id: option.value, label: option.label, isDefault: true }
      : { id: option.value, label: option.label },
  );
  const currentValue = options.find((option) => option.isDefault)?.id;
  return {
    id: input.id,
    label: input.label,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.promptInjectedValues && input.promptInjectedValues.length > 0
      ? { promptInjectedValues: [...input.promptInjectedValues] }
      : {}),
  };
}

export function buildBooleanOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly currentValue?: boolean;
  readonly description?: string;
}) {
  return {
    id: input.id,
    label: input.label,
    type: "boolean" as const,
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.currentValue === "boolean" ? { currentValue: input.currentValue } : {}),
  };
}

export function buildServerProvider(input: {
  driver?: ProviderDriverKind;
  presentation: ServerProviderPresentation;
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  usage?: ServerProviderUsage;
  probe: ProviderProbeResult;
}): ServerProviderDraft {
  const versionAdvisory = input.driver
    ? createProviderVersionAdvisory({
        driver: input.driver,
        currentVersion: input.probe.version,
        checkedAt: input.checkedAt,
      })
    : undefined;
  return {
    displayName: input.presentation.displayName,
    ...(input.presentation.badgeLabel ? { badgeLabel: input.presentation.badgeLabel } : {}),
    ...(typeof input.presentation.showInteractionModeToggle === "boolean"
      ? { showInteractionModeToggle: input.presentation.showInteractionModeToggle }
      : {}),
    ...(typeof input.presentation.requiresNewThreadForModelChange === "boolean"
      ? { requiresNewThreadForModelChange: input.presentation.requiresNewThreadForModelChange }
      : {}),
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    models: input.models,
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
    ...(versionAdvisory ? { versionAdvisory } : {}),
  };
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  collectUint8StreamText({ stream }).pipe(Effect.map((collected) => collected.text));
