import type { EffectiveWorkflowConfig } from "@neokod/contracts";
import { ProviderDriverKind, ProviderInstanceId, RunAttemptId } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeValidationRunner, ValidationRunner, type ValidationRunnerDeps } from "./Runner.ts";
import { ProcessSpawnError, ProcessTimeoutError } from "../../processRunner.ts";
import type { ProcessRunOutput } from "../../processRunner.ts";

const makeConfig = (validationRequired: string[]): EffectiveWorkflowConfig => ({
  repositoryPath: "/repo",
  workflowPath: "/repo/WORKFLOW.md",
  trackerKind: "github",
  trackerRequiredLabels: [],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  trackerProvider: {},
  workspaceRoot: "/ws",
  autonomy: "execute",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  validationRequired,
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
});

const runAttemptId = RunAttemptId.make("run-test-1");

const out = (overrides: Partial<ProcessRunOutput> = {}): ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const makeDeps = (overrides: Partial<ValidationRunnerDeps> = {}): ValidationRunnerDeps => ({
  processRunner: {
    run: () => Effect.succeed(out({ code: ChildProcessSpawner.ExitCode(0) })),
  },
  symphonyLogsDir: "/logs/symphony",
  nowIsoEffect: () => Effect.succeed("2026-08-05T00:00:00.000Z"),
  writeFile: () => Effect.void,
  makeDirectory: () => Effect.void,
  pathJoin: (...parts) => parts.join("/"),
  ...overrides,
});

it.effect("runs each required command in the workspace via sh -lc", () =>
  Effect.gen(function* () {
    const ran: Array<{ command: string; args: string[]; cwd: string }> = [];
    const deps = makeDeps({
      processRunner: {
        run: (input) => {
          ran.push({ command: input.command, args: [...input.args], cwd: input.cwd ?? "" });
          return Effect.succeed(out({ code: ChildProcessSpawner.ExitCode(0) }));
        },
      },
    });
    const service = makeValidationRunner(deps);
    yield* service.runAll({
      config: makeConfig(["npm test", "cargo check"]),
      runAttemptId,
      workspacePath: "/ws/key-1",
    });
    expect(ran).toEqual([
      { command: "sh", args: ["-lc", "npm test"], cwd: "/ws/key-1" },
      { command: "sh", args: ["-lc", "cargo check"], cwd: "/ws/key-1" },
    ]);
  }),
);

it.effect("returns passed only for exit code 0", () =>
  Effect.gen(function* () {
    const deps = makeDeps({
      processRunner: {
        run: (input) => {
          const command = input.args.at(-1);
          if (command === "fail") {
            return Effect.succeed(out({ code: ChildProcessSpawner.ExitCode(2), stderr: "boom\n" }));
          }
          return Effect.succeed(out({ code: ChildProcessSpawner.ExitCode(0) }));
        },
      },
    });
    const results = yield* makeValidationRunner(deps).runAll({
      config: makeConfig(["pass", "fail"]),
      runAttemptId,
      workspacePath: "/ws/key-1",
    });
    expect(results[0]).toMatchObject({ command: "pass", status: "passed", exitCode: 0 });
    expect(results[1]).toMatchObject({ command: "fail", status: "failed", exitCode: 2 });
  }),
);

it.effect("never reports spawn failure as passed", () =>
  Effect.gen(function* () {
    const deps = makeDeps({
      processRunner: {
        run: () =>
          Effect.fail(
            new ProcessSpawnError({
              command: "sh",
              argumentCount: 2,
              resolvedCommand: "sh",
              resolvedArgumentCount: 2,
              shell: true,
              cause: new Error("no such binary"),
            }),
          ),
      },
    });
    const [result] = yield* makeValidationRunner(deps).runAll({
      config: makeConfig(["missing-tool"]),
      runAttemptId,
      workspacePath: "/ws/key-1",
    });
    expect(result).toMatchObject({ command: "missing-tool", status: "unavailable" });
  }),
);

it.effect("reports timeout as failed, not passed", () =>
  Effect.gen(function* () {
    const deps = makeDeps({
      processRunner: {
        run: () =>
          Effect.fail(
            new ProcessTimeoutError({
              command: "sh",
              argumentCount: 2,
              cwd: "/ws/key-1",
              timeoutMs: 1000,
            }),
          ),
      },
    });
    const [result] = yield* makeValidationRunner(deps).runAll({
      config: makeConfig(["slow-check"]),
      runAttemptId,
      workspacePath: "/ws/key-1",
    });
    expect(result).toMatchObject({ command: "slow-check", status: "failed" });
  }),
);

it.effect("persists non-empty output to the run validation dir", () =>
  Effect.gen(function* () {
    const written: Array<{ path: string; content: string }> = [];
    const deps = makeDeps({
      processRunner: {
        run: () =>
          Effect.succeed(out({ code: ChildProcessSpawner.ExitCode(0), stdout: "all good\n" })),
      },
      writeFile: (path, content) =>
        Effect.sync(() => {
          written.push({ path, content });
        }),
      makeDirectory: () => Effect.void,
    });
    const [result] = yield* makeValidationRunner(deps).runAll({
      config: makeConfig(["npm test"]),
      runAttemptId,
      workspacePath: "/ws/key-1",
    });
    expect(result?.outputPath).toBe("/logs/symphony/run-test-1/validation/00-npm_test.out");
    expect(written).toEqual([
      { path: "/logs/symphony/run-test-1/validation/00-npm_test.out", content: "all good" },
    ]);
  }),
);

it.effect("returns no results when no commands are configured", () =>
  Effect.gen(function* () {
    const results = yield* makeValidationRunner(makeDeps()).runAll({
      config: makeConfig([]),
      runAttemptId,
      workspacePath: "/ws/key-1",
    });
    expect(results).toEqual([]);
  }),
);

it.effect("omits outputPath when output is empty", () =>
  Effect.gen(function* () {
    const deps = makeDeps({
      processRunner: {
        run: () =>
          Effect.succeed(out({ code: ChildProcessSpawner.ExitCode(0), stdout: "", stderr: "" })),
      },
    });
    const [result] = yield* makeValidationRunner(deps).runAll({
      config: makeConfig(["quiet"]),
      runAttemptId,
      workspacePath: "/ws/key-1",
    });
    expect(result?.outputPath).toBeUndefined();
  }),
);

it("exposes the service tag through the class", () => {
  expect(ValidationRunner.key).toContain("Validation/Runner");
});
