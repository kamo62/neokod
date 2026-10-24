I'll start by reading the required docs and traced files.Both ports are implemented in exactly the four assigned files, at `0c05baa3f`, with no changes to contracts, shared source, docs, plan, release or other checkouts.

## What changed

**`apps/server/src/terminal/Manager.ts`**

- The OSC/DCS/PM/APC string terminator scan now resumes from the existing buffered prefix boundary instead of rescanning the whole prefix on every chunk. The resume offset is derived from the persistent `pendingControlSequence`, so there is no new session state and no contract change.
- Semantics are preserved: BEL, C1 ST, split `ESC \`, mixed controls, stripped query traffic, history persistence and reopen all rely on the same parser branches.

**`apps/server/src/vcs/GitVcsDriverCore.ts`**

- `lineBuffer` accumulation and `emitCompleteLines` now run only when an `onLine` callback exists. Output decoding, byte caps, truncation marker, remainder flush, `text` accumulation and the progress callbacks are unchanged.

**Tests**

- `Manager.test.ts`: one focused regression with large chunked OSC 52 and DCS strings. It counts reads on strings larger than one chunk, so prefix rescanning fails deterministically, then checks persisted history and reopen history.
- `GitVcsDriverCore.test.ts`: two focused regressions. Split UTF-8/NUL/CRLF/trailing output must be identical with and without line callbacks, and caps/truncation must still work without callbacks. Both import the edited local `./GitVcsDriverCore.ts`.

## Measurements

Disposable harnesses outside the repo:

`/tmp/neokod-measure-23819/terminal-measure.mjs` (131,121-character expected output, 4 KiB chunks):

| State  | Large-string `charCodeAt` reads | Elapsed (single run) |
| ------ | ------------------------------: | -------------------: |
| Before |                       1,368,145 |                12 ms |
| After  |                         123,036 |                 4 ms |

Persisted output matched expected before and after. The committed regression reproduces the before figure: `expected 1368145 to be less than 262242`, and passes after.

`/tmp/neokod-measure-23953/git-measure.mjs` (16 MiB single-line stdout, 64 KiB chunks):

| State  | No callbacks                      | With callbacks    |
| ------ | --------------------------------- | ----------------- |
| Before | 397 ms, 256 large `indexOf` scans | 417 ms, 256 scans |
| After  | 5 ms, 0 scans                     | 379 ms, 256 scans |

The structural result is that unused line buffering and scanning are skipped. Timings are single local runs and are indicative only. No application-wide performance claim is made.

## Verification

Run with Node 24.22.1 and root `node_modules/.bin/vp`:

- `vp test run apps/server/src/terminal/Manager.test.ts` -> 68 passed
- `vp test run apps/server/src/terminal/Manager.test.ts -t "preserves large chunk-split"` -> 1 passed
- `vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts` -> 65 passed
- `vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts -t "Git output collection"` -> 2 passed
- Both files together -> 133 passed
- `vp test run apps/server/src/vcs/GitVcsDriver.test.ts` -> 10 passed
- `vp check` -> 0 errors, 54 warnings, none in the four edited files (warnings are pre-existing elsewhere)
- `vp run --concurrency-limit 2 typecheck` -> 10/10 packages, `tsgo --noEmit` passed, including `apps/server`
- `vp fmt --check` on the four files -> clean
- `vp lint --report-unused-disable-directives` on the four files -> clean

## Diff

```diff
diff --git a/apps/server/src/terminal/Manager.test.ts b/apps/server/src/terminal/Manager.test.ts
index bd037228e..457eacbf8 100644
--- a/apps/server/src/terminal/Manager.test.ts
+++ b/apps/server/src/terminal/Manager.test.ts
@@ -16,6 +16,7 @@ import type {
   TerminalOwnershipEvidence,
 } from "@neokod/shared/processGroup";
 import * as Data from "effect/Data";
+import * as Deferred from "effect/Deferred";
 import * as Duration from "effect/Duration";
 import * as Effect from "effect/Effect";
 import * as Encoding from "effect/Encoding";
@@ -1363,6 +1364,72 @@ it.layer(
       }),
   );

+  it.effect(
+    "preserves large chunk-split string sequences without rescanning the pending prefix",
+    () =>
+      Effect.gen(function* () {
+        const { manager, ptyAdapter, logsDir } = yield* createManager();
+        yield* manager.open(openInput());
+        const process = ptyAdapter.processes[0];
+        expect(process).toBeDefined();
+        if (!process) return;
+
+        const outputSeen = yield* Deferred.make<void>();
+        const unsubscribe = yield* manager.subscribe((event) =>
+          event.type === "output" && event.data === "done\n"
+            ? Deferred.succeed(outputSeen, undefined).pipe(Effect.asVoid)
+            : Effect.void,
+        );
+        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
+
+        const sequences = [
+          { prefix: `\u001b]52;c;${"YWJj".repeat(16_384)}\u001b`, terminator: "\\" },
+          { prefix: `\u0090q${"?".repeat(65_536)}`, terminator: "\u009c" },
+        ];
+        const stripped = "\u001b]11;?\u0007\u0090$q m\u009c";
+        const preserved = "\u001b[31m\u009d52;c;YWJj\u009c";
+        const expected =
+          sequences.map(({ prefix, terminator }) => prefix + terminator + preserved).join("") +
+          "done\n";
+
+        // Counts reads of strings larger than one emitted chunk, so rescanning
+        // the buffered prefix on every chunk shows up as quadratic work.
+        const charCodeAt = String.prototype.charCodeAt;
+        let largeStringReads = 0;
+        yield* Effect.gen(function* () {
+          // oxlint-disable-next-line no-extend-native -- Count reads without retaining millions of spy records.
+          String.prototype.charCodeAt = function (this: string, index: number) {
+            if (this.length > 4_096) largeStringReads += 1;
+            return charCodeAt.call(this, index);
+          };
+          for (const { prefix, terminator } of sequences) {
+            for (let offset = 0; offset < prefix.length; offset += 4_096) {
+              process.emitData(prefix.slice(offset, offset + 4_096));
+            }
+            process.emitData(terminator + stripped + preserved);
+          }
+          process.emitData("done\n");
+          yield* Deferred.await(outputSeen);
+        }).pipe(
+          Effect.ensuring(
+            Effect.sync(() => {
+              // oxlint-disable-next-line no-extend-native -- Restore the counting hook even when the test fails.
+              String.prototype.charCodeAt = charCodeAt;
+            }),
+          ),
+        );
+
+        expect(largeStringReads).toBeLessThan(2 * expected.length);
+        const logPath = yield* historyLogPath(logsDir);
+        yield* waitFor(Effect.map(readFileString(logPath), (text) => text === expected));
+        yield* manager.close({ threadId: "thread-1" });
+        const persisted = yield* readFileString(logPath);
+        expect(persisted).toBe(expected);
+        const reopened = yield* manager.open(openInput());
+        expect(reopened.history.startsWith(expected)).toBe(true);
+      }),
+  );
+
   const withFlakyFileSystem = (
     real: Record<string, unknown>,
     shouldFail: () => boolean,
diff --git a/apps/server/src/terminal/Manager.ts b/apps/server/src/terminal/Manager.ts
index 05e2b9116..ce1345c5b 100644
--- a/apps/server/src/terminal/Manager.ts
+++ b/apps/server/src/terminal/Manager.ts
@@ -1000,6 +1000,11 @@ function sanitizeTerminalHistoryChunk(
   data: string,
 ): { visibleText: string; pendingControlSequence: string } {
   const input = `${pendingControlSequence}${data}`;
+  // The buffered prefix was already scanned for terminators when it was
+  // stored, so only a terminator split at the chunk boundary remains possible:
+  // an ESC at the end of the prefix followed by a backslash in the new chunk.
+  // Resume one character before the boundary instead of rescanning the prefix.
+  const pendingScanStart = Math.max(0, pendingControlSequence.length - 1);
   let visibleText = "";
   let index = 0;

@@ -1042,7 +1047,10 @@ function sanitizeTerminalHistoryChunk(
         nextCodePoint === 0x5e ||
         nextCodePoint === 0x5f
       ) {
-        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
+        const terminatorIndex = findStringTerminatorIndex(
+          input,
+          Math.max(index + 2, pendingScanStart),
+        );
         if (terminatorIndex === null) {
           return { visibleText, pendingControlSequence: input.slice(index) };
         }
@@ -1088,7 +1096,10 @@ function sanitizeTerminalHistoryChunk(
     }

     if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
-      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
+      const terminatorIndex = findStringTerminatorIndex(
+        input,
+        Math.max(index + 1, pendingScanStart),
+      );
       if (terminatorIndex === null) {
         return { visibleText, pendingControlSequence: input.slice(index) };
       }
diff --git a/apps/server/src/vcs/GitVcsDriverCore.test.ts b/apps/server/src/vcs/GitVcsDriverCore.test.ts
index dad398763..3f91c3eae 100644
--- a/apps/server/src/vcs/GitVcsDriverCore.test.ts
+++ b/apps/server/src/vcs/GitVcsDriverCore.test.ts
@@ -12,7 +12,11 @@ import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

 import { GitCommandError } from "@neokod/contracts";
 import { ServerConfig } from "../config.ts";
-import { parseGitWorktreePorcelain, splitNullSeparatedGitStdoutPaths } from "./GitVcsDriverCore.ts";
+import {
+  makeGitVcsDriverCore,
+  parseGitWorktreePorcelain,
+  splitNullSeparatedGitStdoutPaths,
+} from "./GitVcsDriverCore.ts";
 import * as GitVcsDriver from "./GitVcsDriver.ts";

 const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
@@ -102,6 +106,82 @@ const initRepoWithCommit = (
     return { initialBranch };
   });

+describe("Git output collection", () => {
+  // Git writes in arbitrary chunk sizes; one byte per chunk splits every
+  // multibyte character across reads.
+  const byteChunks = (text: string) =>
+    Stream.fromIterable(Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte)));
+
+  const makeCoreDriver = (output: { readonly stdout?: string; readonly stderr?: string }) =>
+    makeGitVcsDriverCore().pipe(
+      Effect.provideService(
+        ChildProcessSpawner.ChildProcessSpawner,
+        ChildProcessSpawner.make(() =>
+          Effect.succeed(
+            ChildProcessSpawner.makeHandle({
+              ...makeProcessHandle({ exitCode: 0 }),
+              stdout: byteChunks(output.stdout ?? ""),
+              stderr: byteChunks(output.stderr ?? ""),
+            }),
+          ),
+        ),
+      ),
+    );
+
+  const outputServiceLayer = ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer));
+
+  it.effect("returns split UTF-8 and NUL output with and without line callbacks", () =>
+    Effect.gen(function* () {
+      const stdout = "a\\b\0雪\nlast ";
+      const stderr = "Receiving é\r\nUpdating 雪\rdone";
+      const driver = yield* makeCoreDriver({ stdout, stderr });
+      const input = { operation: "test.chunkedGitOutput", cwd: "/repo", args: ["status"] };
+      const expected = {
+        exitCode: 0,
+        stdout,
+        stderr,
+        stdoutTruncated: false,
+        stderrTruncated: false,
+      };
+
+      assert.deepEqual(yield* driver.execute(input), expected);
+
+      const stdoutLines: string[] = [];
+      const stderrLines: string[] = [];
+      const withCallbacks = yield* driver.execute({
+        ...input,
+        progress: {
+          onStdoutLine: (line) => Effect.sync(() => void stdoutLines.push(line)),
+          onStderrLine: (line) => Effect.sync(() => void stderrLines.push(line)),
+        },
+      });
+      assert.deepEqual(withCallbacks, expected);
+      assert.deepEqual(stdoutLines, ["a\\b\0雪", "last "]);
+      assert.deepEqual(stderrLines, ["Receiving é", "Updating 雪\rdone"]);
+    }).pipe(Effect.provide(outputServiceLayer)),
+  );
+
+  it.effect("caps output without line callbacks", () =>
+    Effect.gen(function* () {
+      const driver = yield* makeCoreDriver({ stderr: "é雪\rdone" });
+      const input = {
+        operation: "test.cappedGitOutput",
+        cwd: "/repo",
+        args: ["status"],
+        maxOutputBytes: 3,
+      };
+
+      const truncated = yield* driver.execute({ ...input, appendTruncationMarker: true });
+      assert.equal(truncated.stderr, "é\uFFFD");
+      assert.isTrue(truncated.stderrTruncated);
+
+      const error = yield* driver.execute(input).pipe(Effect.flip);
+      assert.equal(error.outputLength, 4);
+      assert.include(error.detail, "exceeded 3 bytes");
+    }).pipe(Effect.provide(outputServiceLayer)),
+  );
+});
+
 it.effect("uses stable diagnostics for every parsed non-repository command", () => {
   const commands: Array<{ readonly args: ReadonlyArray<string>; readonly lcAll?: string }> = [];
   const spawner = ChildProcessSpawner.make((command) =>
diff --git a/apps/server/src/vcs/GitVcsDriverCore.ts b/apps/server/src/vcs/GitVcsDriverCore.ts
index ec3c1e9d4..3055afd02 100644
--- a/apps/server/src/vcs/GitVcsDriverCore.ts
+++ b/apps/server/src/vcs/GitVcsDriverCore.ts
@@ -662,8 +662,10 @@ const collectOutput = Effect.fnUntraced(function* (

     const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
     text += decoded;
-    lineBuffer += decoded;
-    yield* emitCompleteLines(false);
+    if (onLine) {
+      lineBuffer += decoded;
+      yield* emitCompleteLines(false);
+    }
   });

   yield* Stream.runForEach(stream, processChunk).pipe(
@@ -679,8 +681,10 @@ const collectOutput = Effect.fnUntraced(function* (

   const remainder = truncated ? "" : decoder.decode();
   text += remainder;
-  lineBuffer += remainder;
-  yield* emitCompleteLines(true);
+  if (onLine) {
+    lineBuffer += remainder;
+    yield* emitCompleteLines(true);
+  }
   return {
     text,
     truncated,
```

## Limits

- Timings are single local runs from disposable harnesses in `/tmp`, not a repeatable benchmark. The deterministic read/scan counts are the defensible evidence.
- The terminal regression patches `String.prototype.charCodeAt` briefly inside the test, restores it in `Effect.ensuring`, and was linted with unused-disable reporting.
- Not validated on Windows or against a real interactive shell; coverage is the faked PTY and git spawner used by the existing suite.
- No install, build, package, deploy, Playwright, commit or push was performed. The 54 `vp check` warnings are pre-existing and outside the four files.
- Version and changelog were not touched, per the file scope.
- Execution used `deepseek/deepseek-flash`, DeepSeek V4.1 Flash 1017, as owner-confirmed.
