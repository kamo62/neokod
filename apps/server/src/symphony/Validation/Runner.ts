import type { EffectiveWorkflowConfig, RunAttemptId, ValidationResult } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { ProcessRunner, ProcessSpawnError, ProcessTimeoutError } from "../../processRunner.ts";
import { nowIso } from "../Domain/Time.ts";

/**
 * Validation runner (plan 10, WS-L).
 *
 * Runs each `validation.required` command via the shared ProcessRunner with
 * `cwd = workspace`. A check is `passed` only when it executed with exit code
 * 0; spawn failures and timeouts are `unavailable`/`failed`, never `passed`
 * (PRD quality 18.3, risk 27.6). Raw output is preserved to
 * `<symphonyLogsDir>/<runId>/validation/` and the returned result references
 * the output file by path.
 */

export interface ValidationRunInput {
  readonly config: EffectiveWorkflowConfig;
  readonly runAttemptId: RunAttemptId;
  readonly workspacePath: string;
}

export class ValidationRunner extends Context.Service<
  ValidationRunner,
  {
    readonly runAll: (input: ValidationRunInput) => Effect.Effect<ValidationResult[], never>;
  }
>()("neokod/symphony/Validation/Runner/ValidationRunner") {}

const DEFAULT_VALIDATION_TIMEOUT = Duration.minutes(10);

const toSafeFileName = (command: string, index: number): string => {
  const stem = command
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${String(index).padStart(2, "0")}-${stem.length === 0 ? "check" : stem}.out`;
};

export interface ValidationRunnerDeps {
  readonly processRunner: ProcessRunner["Service"];
  readonly symphonyLogsDir: string;
  readonly nowIsoEffect?: () => Effect.Effect<string>;
  readonly writeFile?: (path: string, content: string) => Effect.Effect<void>;
  readonly makeDirectory?: (path: string) => Effect.Effect<void>;
  readonly pathJoin?: (...parts: string[]) => string;
}

export const makeValidationRunner = (deps: ValidationRunnerDeps): ValidationRunner["Service"] => {
  const join = deps.pathJoin ?? ((...parts: string[]) => parts.join("/"));

  const runAll: ValidationRunner["Service"]["runAll"] = (input) =>
    Effect.gen(function* () {
      const commands = input.config.validationRequired ?? [];
      if (commands.length === 0) {
        return [];
      }
      const results: ValidationResult[] = [];
      for (const [index, command] of commands.entries()) {
        results.push(
          yield* runOne({
            config: input.config,
            command,
            index,
            runAttemptId: input.runAttemptId,
            workspacePath: input.workspacePath,
          }),
        );
      }
      return results;
    });

  const runOne = (input: {
    readonly config: EffectiveWorkflowConfig;
    readonly command: string;
    readonly index: number;
    readonly runAttemptId: RunAttemptId;
    readonly workspacePath: string;
  }): Effect.Effect<ValidationResult, never> =>
    Effect.gen(function* () {
      const executedAt = yield* deps.nowIsoEffect?.() ?? nowIso;
      const startedAt = Date.now();
      const result = yield* Effect.result(
        deps.processRunner.run({
          command: "sh",
          args: ["-lc", input.command],
          cwd: input.workspacePath,
          timeout: DEFAULT_VALIDATION_TIMEOUT,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 4 * 1024 * 1024,
        }),
      );
      const durationMs = Math.max(0, Date.now() - startedAt);

      if (result._tag === "Success") {
        const output = `${result.success.stdout}\n${result.success.stderr}`.trimEnd();
        const outputPath = yield* persistOutput(
          input.command,
          input.index,
          input.runAttemptId,
          output,
        );
        return {
          command: input.command,
          status: result.success.code === 0 ? "passed" : "failed",
          exitCode: result.success.code === null ? undefined : result.success.code,
          durationMs,
          ...(outputPath !== null ? { outputPath } : {}),
          executedAt,
        } satisfies ValidationResult;
      }

      const failure = result.failure;
      const status =
        failure instanceof ProcessTimeoutError
          ? "failed"
          : failure instanceof ProcessSpawnError
            ? "unavailable"
            : "failed";
      return {
        command: input.command,
        status,
        durationMs,
        executedAt,
      } satisfies ValidationResult;
    });

  const persistOutput = (
    command: string,
    index: number,
    runAttemptId: RunAttemptId,
    output: string,
  ): Effect.Effect<string | null, never> =>
    Effect.gen(function* () {
      if (output.length === 0) {
        return null;
      }
      const fileName = toSafeFileName(command, index);
      const dir = join(deps.symphonyLogsDir, String(runAttemptId), "validation");
      const filePath = join(dir, fileName);
      yield* deps.makeDirectory?.(dir) ?? Effect.void;
      yield* deps.writeFile?.(filePath, output) ?? Effect.void;
      return filePath;
    });

  return { runAll };
};

export const ValidationRunnerLive: Layer.Layer<
  ValidationRunner,
  never,
  ProcessRunner | ServerConfig | FileSystem.FileSystem
> = Layer.effect(
  ValidationRunner,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    return makeValidationRunner({
      processRunner,
      symphonyLogsDir: config.symphonyLogsDir,
      // Production wiring must actually write the output the evidence
      // references (REVIEW P2 #1: non-empty output advertised a file that
      // was never created).
      writeFile: (path, content) =>
        fileSystem.writeFileString(path, content).pipe(Effect.catch(() => Effect.void)),
      makeDirectory: (dir) =>
        fileSystem.makeDirectory(dir, { recursive: true }).pipe(Effect.catch(() => Effect.void)),
    });
  }),
);
