import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@neokod/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "neokod-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

const checkpointRef = CheckpointRef.make("refs/neokod/checkpoints/test-capture");

it.layer(GitContractLayer)("GitVcsDriver checkpoint capture", (it) => {
  const makeRepo = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "neokod-git-checkpoint-",
    });
    yield* runGit(cwd, ["init"]);
    yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test"]);
    return cwd;
  });

  const writeFile = (cwd: string, relativePath: string, contents: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const absolutePath = path.join(cwd, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fileSystem.writeFileString(absolutePath, contents);
    });

  const gitStdout = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const result = yield* driver.execute({
        operation: "GitVcsDriver.checkpointTest.git",
        cwd,
        args,
        timeoutMs: 10_000,
      });
      return result.stdout;
    });

  it.effect("captures worktree content through the seeded repository index", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();

      yield* writeFile(cwd, ".gitignore", "*.log\n");
      yield* writeFile(cwd, "base.txt", "base v1\n");
      yield* writeFile(cwd, "removed.txt", "removed\n");
      yield* runGit(cwd, ["add", "-A"]);
      yield* runGit(cwd, ["commit", "-m", "base"]);

      yield* writeFile(cwd, "base.txt", "base v2\n");
      yield* writeFile(cwd, "staged.txt", "staged v1\n");
      yield* runGit(cwd, ["add", "staged.txt"]);
      yield* writeFile(cwd, "staged.txt", "staged v2\n");
      yield* writeFile(cwd, "untracked.txt", "untracked\n");
      yield* writeFile(cwd, "ignored.log", "ignored\n");
      yield* fileSystem.remove(path.join(cwd, "removed.txt"));

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.equal(yield* gitStdout(cwd, ["show", `${checkpointRef}:base.txt`]), "base v2\n");
      assert.equal(yield* gitStdout(cwd, ["show", `${checkpointRef}:staged.txt`]), "staged v2\n");
      assert.equal(
        yield* gitStdout(cwd, ["show", `${checkpointRef}:untracked.txt`]),
        "untracked\n",
      );
      const capturedPaths = (yield* gitStdout(cwd, ["ls-tree", "-r", "--name-only", checkpointRef]))
        .split("\n")
        .filter((line) => line.length > 0);
      assert.notInclude(capturedPaths, "ignored.log");
      assert.notInclude(capturedPaths, "removed.txt");

      // The capture must not disturb the repository's own index: staged.txt
      // stays staged at its v1 content.
      const stagedInIndex = yield* gitStdout(cwd, ["show", ":staged.txt"]);
      assert.equal(stagedInIndex, "staged v1\n");
    }),
  );

  it.effect("captures changes hidden behind skip-worktree and assume-unchanged bits", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();

      yield* writeFile(cwd, "skip.txt", "skip v1\n");
      yield* writeFile(cwd, "assume.txt", "assume v1\n");
      yield* runGit(cwd, ["add", "-A"]);
      yield* runGit(cwd, ["commit", "-m", "base"]);
      yield* runGit(cwd, ["update-index", "--skip-worktree", "skip.txt"]);
      yield* runGit(cwd, ["update-index", "--assume-unchanged", "assume.txt"]);
      yield* writeFile(cwd, "skip.txt", "skip v2\n");
      yield* writeFile(cwd, "assume.txt", "assume v2\n");

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // A seeded index copy carries both bits; a checkpoint must still see
      // the live worktree content behind them.
      assert.equal(yield* gitStdout(cwd, ["show", `${checkpointRef}:skip.txt`]), "skip v2\n");
      assert.equal(yield* gitStdout(cwd, ["show", `${checkpointRef}:assume.txt`]), "assume v2\n");

      // The repository's own index keeps its bits untouched.
      const indexFlags = yield* gitStdout(cwd, ["ls-files", "-v"]);
      assert.include(indexFlags, "S skip.txt");
      assert.include(indexFlags, "h assume.txt");
    }),
  );

  it.effect("captures a repository that has no index and no HEAD yet", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();

      yield* writeFile(cwd, "fresh.txt", "fresh\n");

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.equal(yield* gitStdout(cwd, ["show", `${checkpointRef}:fresh.txt`]), "fresh\n");
    }),
  );
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/neokod-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/neokod-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});
