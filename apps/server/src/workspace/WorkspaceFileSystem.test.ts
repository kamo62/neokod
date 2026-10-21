// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "neokod-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "neokod-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const makeFifo = (absolutePath: string) => NodeChildProcess.execFileSync("mkfifo", [absolutePath]);

const releaseFifo = (absolutePath: string) => {
  const fd = NodeFS.openSync(absolutePath, NodeFS.constants.O_RDWR);
  NodeFS.closeSync(fd);
};

// The blocking open runs inside an uninterruptible acquire, so a timeout alone
// cannot end the test. Release the FIFOs just after the test deadline: a blocked
// open then returns, the pending interruption wins, and no libuv worker stays
// blocked.
const scheduleFifoRelease = (absolutePaths: readonly string[], delayMs: number) => {
  const releaseAll = () => {
    for (const absolutePath of absolutePaths) {
      try {
        releaseFifo(absolutePath);
      } catch {
        // The test may have finished and removed its temporary directory.
      }
    }
  };
  // A host timer, not Effect.sleep: this watchdog must run while the Effect fiber
  // is stuck in the uninterruptible FIFO open.
  // @effect-diagnostics-next-line globalTimers:off
  const timer = setTimeout(releaseAll, delayMs);
  return () => {
    clearTimeout(timer);
    releaseAll();
  };
};

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("rejects a FIFO as not a file without blocking", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return;

        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const fifoPath = path.join(cwd, "fifo");
        makeFifo(fifoPath);
        const releaseFifos = scheduleFifoRelease([fifoPath], 2_500);

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "fifo" })
          .pipe(
            Effect.timeout("2 seconds"),
            Effect.flip,
            Effect.ensuring(Effect.sync(releaseFifos)),
          );

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({ relativePath: "fifo" });
      }),
    );

    it.effect("keeps serving regular files after many FIFO reads", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return;

        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const fifoNames = ["f0", "f1", "f2", "f3", "f4", "f5"];
        const fifoPaths = fifoNames.map((name) => path.join(cwd, name));
        for (const fifoPath of fifoPaths) makeFifo(fifoPath);
        yield* writeTextFile(cwd, "ok.txt", "fine\n");
        const releaseFifos = scheduleFifoRelease(fifoPaths, 5_500);

        const result = yield* Effect.gen(function* () {
          const errors = yield* Effect.forEach(
            fifoNames,
            (relativePath) => workspaceFileSystem.readFile({ cwd, relativePath }).pipe(Effect.flip),
            { concurrency: "unbounded" },
          );
          const regularFile = yield* workspaceFileSystem.readFile({
            cwd,
            relativePath: "ok.txt",
          });
          return { errors, regularFile };
        }).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Effect.sync(releaseFifos)));

        expect(result.errors).toHaveLength(fifoNames.length);
        for (const error of result.errors) {
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        }
        expect(result.regularFile.contents).toBe("fine\n");
      }),
    );

    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
          contentHash: NodeCrypto.createHash("sha256")
            .update("export const answer = 42;\n")
            .digest("hex"),
        });
      }),
    );

    it.effect("omits the content hash for a truncated read", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const contents = "a".repeat(1024 * 1024 + 1);
        yield* writeTextFile(cwd, "large.txt", contents);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "large.txt",
        });

        expect(result.truncated).toBe(true);
        expect(result.contents.length).toBe(1024 * 1024);
        expect(result).not.toHaveProperty("contentHash");
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("round-trips a BOM and CRLF byte for byte", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const original = Uint8Array.from([
          0xef, 0xbb, 0xbf, 0x6c, 0x31, 0x0d, 0x0a, 0x6c, 0x32, 0x0d, 0x0a,
        ]);
        const absolutePath = path.join(cwd, "bom.txt");
        yield* fileSystem.writeFile(absolutePath, original);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "bom.txt",
        });
        expect(result.contents.charCodeAt(0)).toBe(0xfeff);
        expect(result.contents).toBe("\uFEFFl1\r\nl2\r\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "bom.txt",
          contents: result.contents,
        });
        const saved = yield* fileSystem.readFile(absolutePath);

        expect(Array.from(saved)).toEqual(Array.from(original));
      }),
    );

    it.effect("refuses invalid UTF-8 instead of returning replacement characters", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const original = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xff, 0x0a]);
        const absolutePath = path.join(cwd, "latin1.txt");
        yield* fileSystem.writeFile(absolutePath, original);

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "latin1.txt" })
          .pipe(Effect.flip);
        const saved = yield* fileSystem.readFile(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(Array.from(saved)).toEqual(Array.from(original));
      }),
    );

    it.effect("does not report a truncated multi-byte tail as invalid", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const prefix = "a".repeat(1024 * 1024 - 1);
        const absolutePath = path.join(cwd, "truncated.txt");
        yield* fileSystem.writeFile(absolutePath, Buffer.from(`${prefix}é`, "utf8"));

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "truncated.txt",
        });

        expect(result.truncated).toBe(true);
        expect(result.contents.length).toBe(1024 * 1024 - 1);
        expect(result.contents).toBe(prefix);
      }),
    );

    it.effect.each([
      { name: "a lone 0xff", tail: [0xff] },
      { name: "a malformed E0 80 prefix", tail: [0xe0, 0x80] },
      { name: "a malformed F4 90 prefix", tail: [0xf4, 0x90] },
    ])("rejects $name cut off by the read limit", ({ tail }) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const prefix = Buffer.alloc(1024 * 1024 - tail.length, 0x61);
        const absolutePath = path.join(cwd, "boundary.txt");
        // The read cap lands exactly on the last byte of the invalid tail, and
        // one ASCII byte follows it, so only a valid incomplete sequence may be
        // withheld at the boundary.
        yield* fileSystem.writeFile(
          absolutePath,
          Buffer.concat([prefix, Buffer.from([...tail, 0x62])]),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "boundary.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          contentHash: NodeCrypto.createHash("sha256").update("# Plan\n").digest("hex"),
        });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("writes when expectedHash matches the disk", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        // The hash returned by the first save is the expected hash for the next
        // save, without a separate read.
        const first = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "f.txt",
          contents: "a",
        });

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "f.txt",
          contents: "b",
          expectedHash: first.contentHash,
        });
        const saved = yield* fileSystem.readFileString(path.join(cwd, "f.txt")).pipe(Effect.orDie);

        expect(saved).toBe("b");
        expect(result).toEqual({
          relativePath: "f.txt",
          contentHash: NodeCrypto.createHash("sha256").update("b").digest("hex"),
        });
      }),
    );

    it.effect("compares the hash against the canonical target through an in-root symlink", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "real"));
        yield* writeTextFile(cwd, "real/target.txt", "a");
        yield* fileSystem.symlink(path.join(cwd, "real/target.txt"), path.join(cwd, "link.txt"));
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "link.txt" });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "link.txt",
          contents: "b",
          expectedHash: read.contentHash,
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "real/target.txt"))
          .pipe(Effect.orDie);
        const linkStat = yield* Effect.promise(() => NodeFSP.lstat(path.join(cwd, "link.txt")));

        expect(saved).toBe("b");
        expect(linkStat.isSymbolicLink()).toBe(true);
      }),
    );

    it.effect("round-trips BOM and CRLF bytes with an expected hash", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const original = Uint8Array.from([
          0xef, 0xbb, 0xbf, 0x6c, 0x31, 0x0d, 0x0a, 0x6c, 0x32, 0x0d, 0x0a,
        ]);
        const absolutePath = path.join(cwd, "bom.txt");
        yield* fileSystem.writeFile(absolutePath, original);
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "bom.txt" });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "bom.txt",
          contents: read.contents,
          expectedHash: read.contentHash,
        });
        const saved = yield* fileSystem.readFile(absolutePath).pipe(Effect.orDie);

        expect(Array.from(saved)).toEqual(Array.from(original));
      }),
    );

    it.effect("refuses when the disk changed and preserves the external bytes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* workspaceFileSystem.writeFile({ cwd, relativePath: "f.txt", contents: "original" });
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "f.txt" });
        yield* writeTextFile(cwd, "f.txt", "external");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "f.txt",
            contents: "mine",
            expectedHash: read.contentHash,
          })
          .pipe(Effect.flip);
        const saved = yield* fileSystem.readFileString(path.join(cwd, "f.txt")).pipe(Effect.orDie);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileChangedOnDiskError);
        expect(error).toMatchObject({ relativePath: "f.txt" });
        expect(saved).toBe("external");
      }),
    );

    it.effect("refuses when the file was deleted", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* workspaceFileSystem.writeFile({ cwd, relativePath: "f.txt", contents: "original" });
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "f.txt" });
        yield* fileSystem.remove(path.join(cwd, "f.txt"));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "f.txt",
            contents: "mine",
            expectedHash: read.contentHash,
          })
          .pipe(Effect.flip);
        const exists = yield* fileSystem.exists(path.join(cwd, "f.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileChangedOnDiskError);
        expect(exists).toBe(false);
      }),
    );

    it.effect("writes unconditionally without expectedHash", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "f.txt", "old");

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "f.txt",
          contents: "new",
        });
        const saved = yield* fileSystem.readFileString(path.join(cwd, "f.txt")).pipe(Effect.orDie);

        expect(result.contentHash).toBe(
          NodeCrypto.createHash("sha256").update("new").digest("hex"),
        );
        expect(saved).toBe("new");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("refuses to write through a symlinked file that leaves the root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const outsidePath = path.join(outsideDir, "secret.txt");
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(outsidePath, path.join(cwd, "link.txt"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "link.txt", contents: "X" })
          .pipe(Effect.flip);
        const outside = yield* fileSystem.readFileString(outsidePath).pipe(Effect.orDie);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(outside).toBe("outside\n");
      }),
    );

    it.effect("refuses to create files through a symlinked directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* fileSystem.symlink(outsideDir, path.join(cwd, "linkdir"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "linkdir/new.txt", contents: "X" })
          .pipe(Effect.flip);
        const createdOutside = yield* fileSystem.exists(path.join(outsideDir, "new.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(createdOutside).toBe(false);
      }),
    );

    it.effect("refuses a nested not-yet-existing path under a symlinked directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "sub"));
        yield* fileSystem.symlink(outsideDir, path.join(cwd, "sub/up"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "sub/up/deep/x/new2.txt", contents: "X" })
          .pipe(Effect.flip);
        const createdOutside = yield* fileSystem.exists(path.join(outsideDir, "deep"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(createdOutside).toBe(false);
      }),
    );

    it.effect("refuses a dangling symlink", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const missingOutsidePath = path.join(outsideDir, "missing.txt");
        yield* fileSystem.symlink(missingOutsidePath, path.join(cwd, "dangling.txt"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "dangling.txt", contents: "X" })
          .pipe(Effect.flip);
        const createdOutside = yield* fileSystem.exists(missingOutsidePath);

        expect(["WorkspaceFileSystemOperationError", "WorkspaceFilePathEscapeError"]).toContain(
          error._tag,
        );
        expect(createdOutside).toBe(false);
      }),
    );

    it.effect("creates nested missing directories inside the root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "a/b/c/file.txt",
          contents: "nested\n",
        });
        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "a/b/c/file.txt",
        });

        expect(result.contents).toBe("nested\n");
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("writes through an in-root symlinked directory and file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "real"));
        yield* fileSystem.symlink(path.join(cwd, "real"), path.join(cwd, "alias"));

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "alias/f.txt",
          contents: "through dir\n",
        });
        const throughDirectory = yield* fileSystem
          .readFileString(path.join(cwd, "real/f.txt"))
          .pipe(Effect.orDie);
        expect(throughDirectory).toBe("through dir\n");

        yield* writeTextFile(cwd, "real/g.txt", "old");
        yield* fileSystem.symlink(path.join(cwd, "real/g.txt"), path.join(cwd, "g-link.txt"));
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "g-link.txt",
          contents: "new",
        });
        const throughFile = yield* fileSystem
          .readFileString(path.join(cwd, "real/g.txt"))
          .pipe(Effect.orDie);
        const linkStat = yield* Effect.promise(() => NodeFSP.lstat(path.join(cwd, "g-link.txt")));

        expect(throughFile).toBe("new");
        expect(linkStat.isSymbolicLink()).toBe(true);
      }),
    );

    it.effect("works when the workspace root itself is a symlink", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const rootLink = path.join(yield* makeTempDir, "root-link");
        yield* fileSystem.symlink(cwd, rootLink);

        yield* workspaceFileSystem.writeFile({
          cwd: rootLink,
          relativePath: "through-root-link.txt",
          contents: "root\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "through-root-link.txt"))
          .pipe(Effect.orDie);

        expect(saved).toBe("root\n");
      }),
    );

    it.effect("replaces the file atomically and keeps its mode", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "run.sh");
        yield* writeTextFile(cwd, "run.sh", "old");
        yield* fileSystem.chmod(absolutePath, 0o755);
        const before = yield* Effect.promise(() => NodeFSP.stat(absolutePath));

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "run.sh",
          contents: "new",
        });
        const after = yield* Effect.promise(() => NodeFSP.stat(absolutePath));
        const saved = yield* fileSystem.readFileString(absolutePath).pipe(Effect.orDie);
        const entries = yield* fileSystem.readDirectory(cwd);

        expect(saved).toBe("new");
        expect(after.mode & 0o777).toBe(0o755);
        expect(after.ino).not.toBe(before.ino);
        expect(entries).toEqual(["run.sh"]);
      }),
    );

    it.effect("rejects a directory target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "dir"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "dir", contents: "X" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
      }),
    );

    it.effect("rejects contents over the write limit with a typed error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "big.txt", "keep\n");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "big.txt",
            contents: "é".repeat(5 * 1024 * 1024 + 1),
          })
          .pipe(Effect.flip);
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "big.txt"))
          .pipe(Effect.orDie);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileTooLargeError);
        expect(error).toMatchObject({
          byteLength: 10 * 1024 * 1024 + 2,
          maxBytes: 10 * 1024 * 1024,
        });
        expect(saved).toBe("keep\n");
      }),
    );

    it.effect("accepts contents of exactly the limit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const contents = "a".repeat(10 * 1024 * 1024);

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "limit.txt",
          contents,
        });
        const stat = yield* Effect.promise(() => NodeFSP.stat(path.join(cwd, "limit.txt")));
        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "limit.txt",
        });

        expect(stat.size).toBe(10 * 1024 * 1024);
        expect(result.byteLength).toBe(10 * 1024 * 1024);
        expect(result.truncated).toBe(true);
        expect(result.contents.length).toBe(1024 * 1024);
      }),
    );
  });
});
