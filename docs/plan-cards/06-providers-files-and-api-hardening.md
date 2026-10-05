# S6 Phase 1 additions A (cards X-1 to X-8)

Base: /Users/kamogelo/Code/t3code on main at a712441fb. All line numbers verified against that checkout.

Conventions: test commands run from the package directory with Node 24 on the PATH: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run <relative test file>`. Typecheck is `pnpm exec tsgo --noEmit` in each touched package. Finish each card with `vp check` and `vp run typecheck` from the repo root. Line numbers are at the base commit and shift after earlier cards; search by symbol. Reference code under `/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/` (t3 clone at `repos/t3code`, Synara at `synara`) has different licences: read it, then write the logic in Neokod style. Do not paste it.

Landing order for the file API: X-1, then X-2, then plan card U-02b (details in X-2).

### X-1 readFile on a FIFO must not block a worker thread

- Problem: `readFile` calls `NodeFSP.open(realTargetPath, "r")` (`apps/server/src/workspace/WorkspaceFileSystem.ts` line 183) and only afterwards checks `stat.isFile()` (line 208). Opening a FIFO with no writer for reading blocks a libuv threadpool worker forever, and the default pool has 4 workers, so five `projects.readFile` calls on a FIFO freeze every fs-backed request (FA-01, reproduced). T3 fixed it by opening non-blocking (`repos/t3code/apps/server/src/workspace/WorkspaceFileSystem.ts` lines 222-226: `O_RDONLY | (O_NONBLOCK ?? 0)`, with the comment that the later stat rejects it).
- Files to change:
  - `apps/server/src/workspace/WorkspaceFileSystem.ts` : imports (line 10), `readFile` open call (line 183).
  - `apps/server/src/workspace/WorkspaceFileSystem.test.ts` : new tests in `describe("readFile")` (ends at line 198).
- Change:
  1. Add `import * as NodeFS from "node:fs";` next to the existing `NodeFSP` import (the file already has `// @effect-diagnostics nodeBuiltinImport:off`).
  2. Replace the open call with a non-blocking open. A pre-open `stat` would leave a swap race between stat and open; the flag closes it, and the existing `handle.stat()` plus `isFile()` check (lines 196-214) stays as the actual regular-file check:
     ```ts
     // O_NONBLOCK makes open() return at once on a FIFO with no writer; the
     // handle.stat() check below then rejects it. Regular files ignore the flag.
     // Windows has no O_NONBLOCK, so fall back to 0 there.
     try: () =>
       NodeFSP.open(realTargetPath, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0)),
     ```
  3. No error mapping change: a FIFO ends in the existing `WorkspacePathNotFileError`, which `ws.ts` `projectFileFailureContext` already maps to `failure: "path_not_file"` (line 271).
- Do not: add a timeout around the open (the blocked worker thread stays blocked); read from the handle before the `isFile()` check; remove the post-open `stat` check; use `fs.createReadStream`.
- Tests, in `WorkspaceFileSystem.test.ts` (add `// @effect-diagnostics nodeBuiltinImport:off` as the first line, `import * as NodeChildProcess from "node:child_process";` and `import * as NodeFS from "node:fs";`; reuse `makeTempDir`, `writeTextFile`, and the `it.layer(TestLayer, { excludeTestServices: true })` block, which runs on the real clock):
  - Helper in the test file: `const makeFifo = (absolutePath: string) => NodeChildProcess.execFileSync("mkfifo", [absolutePath]);` and a release helper `const releaseFifo = (absolutePath: string) => { const fd = NodeFS.openSync(absolutePath, NodeFS.constants.O_RDWR); NodeFS.closeSync(fd); };` (an O_RDWR open succeeds without a peer and lets any blocked reader open return, so the test process never keeps a stuck worker).
  - `it.effect.skipIf(process.platform === "win32")("rejects a FIFO as not a file without blocking", ...)`: `cwd = yield* makeTempDir`, `makeFifo(path.join(cwd, "fifo"))`, then `const error = yield* workspaceFileSystem.readFile({ cwd, relativePath: "fifo" }).pipe(Effect.timeout("2 seconds"), Effect.flip, Effect.ensuring(Effect.sync(() => releaseFifo(path.join(cwd, "fifo")))))`. Assert `expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError)` and `expect(error).toMatchObject({ relativePath: "fifo" })`. On the base commit the effect times out, `error` is a `TimeoutError`, and the assertion fails.
  - `it.effect.skipIf(process.platform === "win32")("keeps serving regular files after many FIFO reads", ...)`: create 6 FIFOs `f0`..`f5` (more than the 4 default workers) and `ok.txt` containing `"fine\n"`; run `Effect.forEach(["f0","f1","f2","f3","f4","f5"], (name) => workspaceFileSystem.readFile({ cwd, relativePath: name }).pipe(Effect.flip), { concurrency: "unbounded" })` then `readFile({ cwd, relativePath: "ok.txt" })`, all inside `Effect.timeout("5 seconds")` with the same ensuring-release for all six FIFOs. Assert the six errors are `WorkspacePathNotFileError` and the final read returns `contents: "fine\n"`. Fails on base (timeout).
  - If `it.effect.skipIf` is not available in this `@effect/vitest` version, use `it.effect` and return early with `if (process.platform === "win32") return;` inside the generator.
- Verify: from `apps/server`: `pnpm exec vp test run src/workspace/WorkspaceFileSystem.test.ts` shows all tests passing in under 3 s; `pnpm exec tsgo --noEmit`. Manual (optional, throwaway dir only): `mkfifo /tmp/x/fifo` in a project, open it in the file panel; the panel shows "is not a file" instead of hanging.
- Depends on: none. Effort: S. Commit message: `fix(server): open workspace files non-blocking so a FIFO cannot hang readFile`

### X-2 writeFile: contain symlinks, write atomically, bound size, no encoding loss

- Problem: `writeFile` (`apps/server/src/workspace/WorkspaceFileSystem.ts` lines 262-298) checks the path only lexically (`workspacePaths.resolveRelativePathWithinRoot`, `WorkspacePaths.ts` lines 196-225), then runs `makeDirectory(recursive)` and `fileSystem.writeFileString(target.absolutePath, ...)` (line 283). That follows a symlinked file, creates directories through a symlinked directory, and truncates in place (a crash or a concurrent reader sees an empty file). `readFile` has the realpath containment (lines 143-179) so the same symlinks are refused on read and accepted on write (FA-03, FA-04, CP-01, CP-07). Separately `readFile` decodes with `new TextDecoder("utf-8")` (line 241): invalid UTF-8 becomes U+FFFD, a BOM is dropped, and the editor can save that back, so a Latin-1 file is silently corrupted; there is no size limit on `contents`.
- Files to change:
  - `apps/server/src/workspace/realPathContainment.ts` (new) : `isContainedPath`, `resolveWriteTargetWithinRoot`.
  - `apps/server/src/workspace/WorkspaceFileSystem.ts` : `PROJECT_READ_FILE_MAX_BYTES` (line 28) neighbour constant, new `WorkspaceFileTooLargeError`, `WorkspaceFileSystemError` union (line 95), `readFile` containment check (lines 167-179) and decode (line 241), `writeFile` (line 262), `WorkspaceBinaryFileError.message` (line 91).
  - `apps/server/src/atomicWrite.ts` : `writeFileStringAtomically` (line 5) gains an optional `mode`.
  - `packages/contracts/src/project.ts` : `ProjectFileFailure` (line 133) new literal `"file_too_large"`.
  - `apps/server/src/ws.ts` : `projectFileFailureContext` (line 244) new case.
  - `apps/server/src/workspace/WorkspaceFileSystem.test.ts`, `packages/contracts/src/project.test.ts`.
- Change:
  1. New file `realPathContainment.ts`. It holds the one containment predicate, used by both read and write (replace the inline copy at `WorkspaceFileSystem.ts` lines 167-179 with a call to it):
     ```ts
     import * as NodeFSP from "node:fs/promises";
     import * as NodePath from "node:path";
     export const isContainedPath = (realRoot: string, candidate: string): boolean => {
       const relative = NodePath.relative(realRoot, candidate);
       return (
         relative === "" ||
         (relative !== ".." &&
           !relative.startsWith(`..${NodePath.sep}`) &&
           !NodePath.isAbsolute(relative))
       );
     };
     ```
     Behaviour change to keep in mind: `relative === ""` (the root itself) counts as contained, as it does today (the current read check accepts it and then fails at `isFile`).
  2. Same file, `resolveWriteTargetWithinRoot(realRoot: string, absolutePath: string): Promise<string | null>`: returns the canonical path to write to, or `null` when it escapes. `absolutePath` is the lexically resolved path from `resolveRelativePathWithinRoot` (so it contains no `..`). Algorithm (resolve the deepest existing ancestor, then re-append the not-yet-existing tail):
     ```
     let existing = absolutePath; const missing: string[] = [];
     for (;;) {
       try { realBase = await NodeFSP.realpath(existing); break; }
       catch (cause) {
         if (cause.code !== "ENOENT") throw cause;            // ENOTDIR, EACCES, ELOOP surface as operation errors
         // realpath also says ENOENT for a dangling symlink; never treat that as "missing"
         try { await NodeFSP.lstat(existing); throw cause; } catch (lstatCause) { if (lstatCause.code !== "ENOENT") throw lstatCause; }
         const parent = NodePath.dirname(existing);
         if (parent === existing) throw cause;                // reached the filesystem root
         missing.unshift(NodePath.basename(existing)); existing = parent;
       }
     }
     if (!isContainedPath(realRoot, realBase)) return null;
     return NodePath.join(realBase, ...missing);
     ```
     Careful with the dangling-symlink branch: the `throw cause` inside the inner `try` must not be swallowed by the inner `catch`. Write it with a boolean (`let linkExists = true; try { await lstat } catch (e) { if (e.code !== "ENOENT") throw e; linkExists = false; } if (linkExists) throw cause;`).
     Reference: `synara/apps/server/src/workspace/realPathContainment.ts` lines 99-163 (per-component walk) and `bb` `apps/host-daemon/src/command-handlers/file-write.ts` lines 22-54 (deepest existing ancestor). The ancestor form is shorter and equivalent because missing components cannot be symlinks.
  3. `WorkspaceFileSystem.ts`, new constant and error. Limit: 10 MiB, measured in UTF-8 bytes. Reason: it is ten times the 1 MiB read cap (`PROJECT_READ_FILE_MAX_BYTES`), so every file the editor can load can be saved, while a 50 MiB write was seen to grow server memory with no limit (FA-04f) and the WebSocket layer drops frames near 100 MB with an opaque close (1009) and no RPC error.
     ```ts
     const PROJECT_WRITE_FILE_MAX_BYTES = 10 * 1024 * 1024;
     export class WorkspaceFileTooLargeError extends Schema.TaggedErrorClass<WorkspaceFileTooLargeError>()(
       "WorkspaceFileTooLargeError",
       {
         workspaceRoot: Schema.String,
         relativePath: Schema.String,
         byteLength: Schema.Number,
         maxBytes: Schema.Number,
       },
     ) {
       override get message(): string {
         return `Workspace file '${this.relativePath}' is ${this.byteLength} bytes, over the ${this.maxBytes} byte write limit.`;
       }
     }
     ```
     Add it to the `WorkspaceFileSystemError` union.
  4. `contracts/project.ts`: add `"file_too_large"` to `ProjectFileFailure`. `ws.ts` `projectFileFailureContext`: `case "WorkspaceFileTooLargeError": return { failure: "file_too_large" };` (the `default` branch calls `unexpectedCompatibilityError`, so the compiler forces this).
  5. `atomicWrite.ts`: add `readonly mode?: number` to the input. After `fs.writeFileString(tempPath, input.contents)` add `if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);` before the rename. Existing callers (settings, keybindings, runtime state, provider status cache) pass no mode and behave as before. This keeps the existing temp-directory-plus-rename design; the temp directory is a sibling of the target and is removed by the scope.
  6. Rewrite `writeFile` to this order (each failure maps to the existing error classes; wrap each Promise call with `Effect.tryPromise` the way `readFile` does):
     a. `const bytes = Buffer.byteLength(input.contents, "utf8")`; if `bytes > PROJECT_WRITE_FILE_MAX_BYTES` fail `WorkspaceFileTooLargeError` before any fs call.
     b. `target = resolveRelativePathWithinRoot(...)` (unchanged).
     c. `realWorkspaceRoot = realpath(input.cwd)` (operation `"realpath-workspace-root"`, same mapping as `readFile`).
     d. `realTargetPath = resolveWriteTargetWithinRoot(realWorkspaceRoot, target.absolutePath)`; a `null` result fails `WorkspaceFilePathEscapeError` with `resolvedPath: target.absolutePath`; a thrown error maps to `WorkspaceFileSystemOperationError` operation `"realpath-target"`. This also refuses a symlink whose target leaves the root, a dangling symlink, and a symlinked directory in the middle of the path.
     e. `lstat(realTargetPath)`: ENOENT means a new file (`mode` undefined). Any other stat error maps to operation `"stat"`. If it exists and `!stat.isFile()` fail `WorkspacePathNotFileError` (a directory, FIFO or socket is never replaced). Otherwise `mode = stat.mode & 0o7777`.
     f. `fileSystem.makeDirectory(NodePath/path.dirname(realTargetPath), { recursive: true })` (operation `"make-directory"`). Only canonical paths reach this call, and the missing tail has no links. Then re-check `isContainedPath(realWorkspaceRoot, await realpath(dirname(realTargetPath)))` and fail `WorkspaceFilePathEscapeError` if false (narrows the race with a concurrent symlink swap; Node has no `renameat`, so a small window remains and is accepted).
     g. `writeFileStringAtomically({ filePath: realTargetPath, contents: input.contents, ...(mode === undefined ? {} : { mode }) })`, mapped to operation `"write-file"`. The string is written as UTF-8 exactly as given, no BOM added, no newline conversion.
     h. `workspaceEntries.refresh(input.cwd)` and return `{ relativePath: target.relativePath }` (unchanged). Return the requested relative path, not the real path, so the client cache keys do not change.
     When the target is an in-root symlink, the write lands on the real file and the link stays a link, because the rename replaces `realTargetPath`, not the link.
  7. Encoding decision. `readFile` refuses text that is not valid UTF-8 instead of returning a lossy copy, and keeps the BOM, so what the client holds is exactly the file's text and a save round-trips byte for byte. No new field on `ProjectReadFileResult`. Replace line 241 with:
     ```ts
     const completeLength = truncated ? completeUtf8Length(fileBytes) : fileBytes.length;
     let contents: string;
     try {
       contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
         fileBytes.subarray(0, completeLength),
       );
     } catch {
       return (
         yield *
         new WorkspaceBinaryFileError({
           workspaceRoot: input.cwd,
           relativePath: input.relativePath,
           resolvedPath: realTargetPath,
         })
       );
     }
     ```
     where `truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES` (compute once, use it in the returned object too) and
     ```ts
     // A read cut at the byte limit can end inside a multi-byte sequence; drop the partial tail so it is not reported as invalid UTF-8.
     const completeUtf8Length = (bytes: Uint8Array): number => {
       const n = bytes.length;
       for (let back = 1; back <= Math.min(3, n); back += 1) {
         const b = bytes[n - back]!;
         if ((b & 0xc0) === 0x80) continue;
         const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
         return need > back ? n - back : n;
       }
       return n;
     };
     ```
     `ignoreBOM: true` makes the decoder keep U+FEFF in the output (the default strips it). Update `WorkspaceBinaryFileError.message` to `... is not valid UTF-8 text and cannot be previewed or edited as text.` (no test asserts the old wording; `WorkspaceFileSystem.test.ts` line 158 checks the class only). The error still maps to `failure: "binary_file"`.
  8. Web: no code change needed. `FilePreviewPanel.tsx` shows `file.error` text for a failed read (line 821-823) and `useFileSaveCoordinator` (line 262) sends the string unchanged. A rejected write (`file_too_large`, `resolved_path_outside_root`) stays pending in the coordinator today; surfacing it is part of the conflict banner in plan card U-02b and is not duplicated here. The other callers, `PlanSidebar.tsx` line 118 and `ProposedPlanCard.tsx` line 117, write small markdown files and are unaffected.
- How X-2 composes with U-01, U-02 and U-02b (`docs/plan-cards/05-ui-data-loss-and-handoff.md`):
  - U-01 and U-02 are web-only (`fileSaveCoordinator.ts`, `FilePreviewPanel.tsx`) and independent of X-2; they can land in any order.
  - U-02b adds `expectedHash` and `contentHash` to the same two server functions. X-2 lands first, because U-02b step 4 reads the current bytes with `fileSystem.readFile(target.absolutePath)` and writes with `fileSystem.writeFile(target.absolutePath, bytes)`, both of which follow symlinks and are not FIFO safe. After X-2, U-02b must instead: (1) do the hash comparison in `writeFile` after step e above, against `realTargetPath` (a regular file by then; a missing file with `expectedHash` set is still `WorkspaceFileChangedOnDiskError`); (2) keep the final write as the X-2 `writeFileStringAtomically` call and compute its returned `contentHash` as `sha256Hex(Buffer.from(input.contents, "utf8"))`, so no second encode path exists; (3) in `readFile` compute `contentHash` from the exact `fileBytes` (not from the decoded string), which is consistent with X-2 because a non-truncated valid UTF-8 read round-trips byte for byte. The `ProjectFileFailure` literals `file_too_large` (X-2) and `file_changed_on_disk` (U-02b) are separate additions to one list; the second card to land resolves a trivial merge. X-2 changes no result shape, so only U-02b has to update the exact-match `toEqual` assertions in `WorkspaceFileSystem.test.ts` (the `reads UTF-8 files` and `writes files relative` tests).
- Do not: call `NodeFSP.realpath` on a path that may not exist and treat the failure as "outside"; use `realpath(dirname(target))` alone (it does not cover a nested not-yet-existing path or a dangling link); keep the old `fileSystem.makeDirectory(path.dirname(target.absolutePath))` call on the lexical path; return the real path to the client; put runtime logic in `packages/contracts` (only the failure literal goes there).
- Tests, in `WorkspaceFileSystem.test.ts` inside `describe("writeFile")` (add `// @effect-diagnostics nodeBuiltinImport:off` if X-1 has not already, and `import * as NodeFSP from "node:fs/promises";`; reuse `makeTempDir`, `writeTextFile`, `fileSystem.symlink(target, linkPath)` as in the existing `rejects symlinks that resolve outside the workspace root` test). Every symlink test uses two temp dirs, `cwd` and `outsideDir`, and asserts both the typed error and that the outside tree is untouched:
  - `refuses to write through a symlinked file that leaves the root`: `writeTextFile(outsideDir, "secret.txt", "outside\n")`, symlink `cwd/link.txt -> outsideDir/secret.txt`, `writeFile({ cwd, relativePath: "link.txt", contents: "X" })` flips to `WorkspaceFilePathEscapeError`; `outsideDir/secret.txt` still reads `outside\n`. Fails on base (file overwritten).
  - `refuses to create files through a symlinked directory`: symlink `cwd/linkdir -> outsideDir`, write `linkdir/new.txt`; escape error; `outsideDir/new.txt` does not exist (`fileSystem.exists` false).
  - `refuses a nested not-yet-existing path under a symlinked directory`: `fileSystem.makeDirectory(cwd/sub)`, symlink `cwd/sub/up -> outsideDir`, write `sub/up/deep/x/new2.txt`; escape error; `outsideDir/deep` does not exist.
  - `refuses a dangling symlink`: symlink `cwd/dangling.txt -> outsideDir/missing.txt` (target absent); write `dangling.txt` fails (any typed error, assert `_tag` is `WorkspaceFileSystemOperationError` or `WorkspaceFilePathEscapeError`) and `outsideDir/missing.txt` is not created.
  - `creates nested missing directories inside the root`: write `a/b/c/file.txt`, read it back through `readFile`, and assert content.
  - `writes through an in-root symlinked directory and file`: `makeDirectory(cwd/real)`, symlink `cwd/alias -> cwd/real` (absolute target), write `alias/f.txt` then check `real/f.txt` has the content; `writeTextFile(cwd, "real/g.txt", "old")`, symlink `cwd/g-link.txt -> cwd/real/g.txt`, write `g-link.txt` with `new`; `real/g.txt` reads `new` and `NodeFSP.lstat(cwd/g-link.txt).isSymbolicLink()` is still true.
  - `works when the workspace root itself is a symlink`: `rootLink` symlink to `cwd`, write via `rootLink` as the `cwd` input; file exists in `cwd`.
  - `replaces the file atomically and keeps its mode`: `writeTextFile(cwd, "run.sh", "old")`, `fileSystem.chmod(path, 0o755)`, record `NodeFSP.stat(...).ino`, write `new`; assert content `new`, `(stat.mode & 0o777) === 0o755`, the inode differs (temp file plus rename), and `fileSystem.readDirectory(cwd)` equals `["run.sh"]` (no temp leftovers).
  - `rejects a directory target`: `makeDirectory(cwd/dir)`, write `dir`; flips to `WorkspacePathNotFileError`.
  - `rejects contents over the write limit with a typed error`: `"é".repeat(5 * 1024 * 1024 + 1)` (fewer than 10 MiB characters, 10 MiB + 2 bytes); flips to `WorkspaceFileTooLargeError` with `maxBytes: 10 * 1024 * 1024` and `byteLength: 10 * 1024 * 1024 + 2`; a pre-existing file at that path is unchanged. Also `accepts contents of exactly the limit`: `"a".repeat(10 * 1024 * 1024)` succeeds.
  - In `describe("readFile")`: `round-trips a BOM and CRLF byte for byte`: write bytes `EF BB BF 6C 31 0D 0A 6C 32 0D 0A` with `fileSystem.writeFile`, `readFile`, `writeFile({ contents: result.contents })`, then read bytes with `fileSystem.readFile` and `expect` equality with the original and `result.contents.charCodeAt(0) === 0xfeff`. Fails on base (BOM dropped).
  - `refuses invalid UTF-8 instead of returning replacement characters`: bytes `63 61 66 E9 20 FF 0A` (Latin-1); flips to `WorkspaceBinaryFileError`; the file bytes are unchanged. Fails on base (returns text).
  - `does not report a truncated multi-byte tail as invalid`: bytes `"a".repeat(1024*1024 - 1)` followed by `"é"` (2 bytes, so the limit cuts the sequence); `readFile` succeeds with `truncated: true` and `contents.length === 1024*1024 - 1`.
  - `packages/contracts/src/project.test.ts`: extend the `ProjectWriteFileError` decode test (line 46 onward) with `failure: "file_too_large"` decoding.
  - Tests 1, 2, 3, 4, 8 (mode and inode), 9, 10, 11, 12, 13 fail on the base commit.
- Verify: from `apps/server`: `pnpm exec vp test run src/workspace/WorkspaceFileSystem.test.ts` and any suite touching `atomicWrite.ts` (`pnpm exec vp test run src/serverSettings.test.ts src/keybindings.test.ts`); from `packages/contracts`: `pnpm exec vp test run src/project.test.ts`; `pnpm exec tsgo --noEmit` in `apps/server`, `packages/contracts`, `apps/web`. Manual (throwaway dirs only): in a project make `ln -s ../outside-dir linkdir`, save a file under `linkdir/` from the file panel; the save is rejected and `outside-dir` is unchanged.
- Depends on: X-1 (same function and test file). Effort: L. Commit message: `fix(server): contain, atomically write and size-limit workspace file writes`

### X-3 Claude usage limits and API errors end the turn as failed and show on the provider card

- Problem: the Claude CLI reports a usage limit as `result` with `subtype: "success"`, `is_error: true`, `api_error_status: 429`, `terminal_reason: "api_error"` and the human text in `result`, preceded by a `rate_limit_event` (status `rejected`) and a synthetic assistant message with `error: "rate_limit"` (recorded in `rt-c/base/userdata/logs/provider/f6c270f5-82ea-4eff-b07f-ae92efaf983d.log` lines 9, 16, 17). `turnStatusFromResult` (`apps/server/src/provider/Layers/ClaudeAdapter.ts` line 1075) returns `"completed"` for every `success`, `handleResultMessage` (line 2694: `message.subtype === "success" ? undefined : message.errors[0]`) builds no error text, and `handleAssistantMessage` returns early on `message.error !== undefined` (line 2592) so the limit text is discarded. The thread shows a green "Completed" turn with no message. The `rate_limit_event` is forwarded as `account.rate-limits.updated` (line 3019) and nothing consumes it, so Settings keeps saying "Authenticated" (`apps/web/src/components/settings/providerStatus.ts` line 66).
- Files to change:
  - `apps/server/src/provider/Layers/ClaudeUsageLimit.ts` (new) : pure helpers.
  - `apps/server/src/provider/Layers/ClaudeAdapter.ts` : `ClaudeSessionContext` (line 200), `ClaudeAdapterLiveOptions` (line 237), `turnStatusFromResult` (line 1075), `emitRuntimeError` (line 1758), `handleAssistantMessage` (line 2587), `handleResultMessage` (line 2680), `handleSdkTelemetryMessage` rate-limit branch (line 3019), `sendTurn` turn start (line 3932), session context literal (line 3790).
  - `apps/server/src/provider/Drivers/ClaudeDriver.ts` : `create` (the `adapterOptions` object and `enrichSnapshot`, lines 160-190 region).
  - `apps/server/src/textGeneration/ClaudeTextGeneration.ts` : `runClaudeCommand` (line 162 region, before the `exitCode !== 0` check).
  - `packages/contracts/src/server.ts` : new `ServerProviderLimit`, `ServerProvider` (line 172) new optional `limit`.
  - `apps/web/src/components/settings/providerStatus.ts` : `getProviderSummary` (line 31).
  - Tests: `apps/server/src/provider/Layers/ClaudeUsageLimit.test.ts` (new), `ClaudeAdapter.test.ts`, `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts`, `apps/web/src/components/settings/providerStatus.test.ts`, `packages/contracts/src/server.test.ts`.
- SDK shapes (from `apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, package version 0.3.226):
  - `SDKRateLimitEvent` (line 4408): `{ type: 'rate_limit_event'; rate_limit_info: SDKRateLimitInfo; uuid; session_id }`. `SDKRateLimitInfo` (line 4421): `{ status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number /* unix seconds */; rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'; utilization?: number; overageStatus?; overageDisabledReason?; isUsingOverage?; ... }`. The recorded value was `resetsAt: 1791145800`, which is 2026-10-04T20:30:00Z (22:30 in Africa/Johannesburg, matching the CLI text).
  - `SDKAssistantMessage` (line 3016): `{ type: 'assistant'; message: BetaMessage; parent_tool_use_id: string | null; error?: SDKAssistantMessageError; uuid; session_id }`; `SDKAssistantMessageError` (line 3066) is `'authentication_failed' | 'oauth_org_not_allowed' | 'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens'`.
  - `SDKResultSuccess` (line 4472): has `is_error: boolean`, `api_error_status?: number | null`, `result: string`, `terminal_reason?: TerminalReason`. `SDKResultError` (line 4440): `is_error: boolean`, `errors: string[]`, `terminal_reason?`, no `api_error_status`. `TerminalReason` (line 7213): `'blocking_limit' | 'rapid_refill_breaker' | 'prompt_too_long' | 'image_error' | 'model_error' | 'api_error' | 'malformed_tool_use_exhausted' | 'aborted_streaming' | 'aborted_tools' | 'stop_hook_prevented' | 'hook_stopped' | 'tool_deferred' | 'max_turns' | 'background_requested' | 'completed' | 'budget_exhausted' | 'structured_output_retry_exhausted' | 'tool_deferred_unavailable' | 'turn_setup_failed'`.
- Reference (read, then re-implement): T3 `repos/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` `terminalResultError` (lines 2296-2331), `terminalStatusFromResult` (2335-2365), `providerFailureFromResult` (2461-2495), and the `usageLimited` / `resetAt` derivation (6326-6360: rejected rate-limit types plus a `latestAssistantRateLimited` flag set from `message.error === "rate_limit"` at line 5633, reset time is the latest of the rejected windows). Avoid their open defects: every 429 labelled "usage limit" even without evidence (#13399), and replacing the CLI text with a generic one.
- Change:
  1. Contracts, additive and optional (`packages/contracts/src/server.ts`, next to `ServerProviderUsage`, line 161):
     ```ts
     export const ServerProviderLimit = Schema.Struct({
       kind: Schema.Literals(["usage_limit"]),
       window: Schema.optional(TrimmedNonEmptyString), // e.g. "five_hour"
       resetsAt: Schema.optional(IsoDateTime),
       observedAt: IsoDateTime,
     });
     export type ServerProviderLimit = typeof ServerProviderLimit.Type;
     ```
     and in `ServerProvider` after `usage`: `limit: Schema.optional(ServerProviderLimit),`. Do not add a `usage_limit` value to `RuntimeErrorClass` (`providerRuntime.ts` line 103); the structured data rides in `detail`.
  2. New `ClaudeUsageLimit.ts`, all pure (no Effect, no SDK runtime import; a structural input type lets the text generation path reuse it):
     ```ts
     import type { ServerProvider, ServerProviderLimit } from "@neokod/contracts";
     export interface ClaudeResultLike {
       readonly subtype?: string;
       readonly is_error?: boolean;
       readonly api_error_status?: number | null;
       readonly terminal_reason?: string | null;
       readonly result?: string;
     }
     export type ClaudeFailureKind = "usage_limit" | "auth" | "overloaded" | "provider_error";
     export interface ClaudeResultFailure {
       readonly kind: ClaudeFailureKind;
       readonly message: string;
       readonly resetsAt?: string; // ISO, from rate_limit_event
       readonly apiErrorStatus?: number;
       readonly terminalReason?: string;
     }
     export interface ClaudeFailureHints {
       readonly assistantError?: { readonly code: string; readonly text: string | undefined };
       readonly resetsAtEpochSeconds?: number;
     }
     export const FAILING_TERMINAL_REASONS: ReadonlySet<string>; // blocking_limit, rapid_refill_breaker, prompt_too_long, image_error, model_error, api_error, malformed_tool_use_exhausted, budget_exhausted, structured_output_retry_exhausted, tool_deferred_unavailable, turn_setup_failed
     export function claudeResultFailure(
       result: ClaudeResultLike,
       hints?: ClaudeFailureHints,
     ): ClaudeResultFailure | undefined;
     ```
     `claudeResultFailure` rules, in order: (a) return `undefined` unless `result.subtype === "success"` (non-success subtypes keep the existing path); (b) return `undefined` when `terminal_reason` is `aborted_streaming` or `aborted_tools` (an abort, never a failure); (c) it is a failure when `is_error === true`, or `api_error_status` is 401, 429 or 529, or `terminal_reason` is in `FAILING_TERMINAL_REASONS`; otherwise `undefined`. Kind: `usage_limit` when `api_error_status === 429`, `terminal_reason === "blocking_limit"`, or `hints.assistantError?.code === "rate_limit"`; `auth` when status 401 or code is `authentication_failed` or `oauth_org_not_allowed`; `overloaded` when status 529 or code `overloaded`; else `provider_error`. Message: first non-empty of `hints.assistantError?.text`, then `result.result` (when `is_error`), then a default per kind (`"Claude usage limit reached."`, `"Claude authentication failed. Sign in again with the Claude CLI."`, `"Claude is overloaded (529). Try again shortly."`, `"Claude turn failed."`). For `usage_limit`, when `hints.resetsAtEpochSeconds` is a finite number, set `resetsAt = new Date(seconds * 1000).toISOString()` and, if the chosen message does not already match `/reset/i`, append ` Resets ${isoMinuteUtc(resetsAt)}.` where `isoMinuteUtc` renders `2026-10-04 20:30 UTC` (`iso.slice(0, 16).replace("T", " ") + " UTC"`). Include `apiErrorStatus` and `terminalReason` when present.
     Rate-limit tracking, same file:
     ```ts
     export type RejectedRateLimits = ReadonlyMap<string, number | undefined>; // key: rateLimitType ?? "unknown", value: resetsAt seconds
     export function updateRejectedRateLimits(
       previous: RejectedRateLimits,
       info: { status: string; rateLimitType?: string; resetsAt?: number },
     ): RejectedRateLimits;
     export function latestRejectedResetSeconds(
       rejected: RejectedRateLimits,
       nowSeconds: number,
     ): number | undefined; // max over entries with a value > nowSeconds
     export function providerLimitFromRejected(
       rejected: RejectedRateLimits,
       nowMs: number,
     ): ServerProviderLimit | null;
     export function applyClaudeLimit(
       snapshot: ServerProvider,
       limit: ServerProviderLimit | null | undefined,
       nowMs: number,
     ): ServerProvider;
     ```
     `updateRejectedRateLimits` copies the map, sets the key when `status === "rejected"`, deletes it for `allowed` and `allowed_warning`. `providerLimitFromRejected` ignores entries whose `resetsAt` is a number not after `nowMs / 1000`, returns `null` when none remain, otherwise `{ kind: "usage_limit", window: <type of the entry with the latest reset, or the first>, resetsAt: <ISO of the latest known reset>, observedAt: new Date(nowMs).toISOString() }` (omit `resetsAt` when no entry has one). `applyClaudeLimit` returns `snapshot` unchanged when `limit` is nullish or when its `resetsAt` exists and is not after `nowMs`; otherwise `{ ...snapshot, limit, status: snapshot.status === "ready" ? "warning" : snapshot.status, message: <limitMessage> + (snapshot.message ? " " + snapshot.message : "") }` where `limitMessage` is `Usage limit reached.` plus ` Resets ${isoMinuteUtc(limit.resetsAt)}.` when `resetsAt` exists. It never touches `auth`.
  3. `ClaudeAdapter.ts` state and options:
     - `ClaudeSessionContext`: add `lastApiError: { readonly code: string; readonly text: string | undefined } | undefined;` and `rejectedRateLimits: RejectedRateLimits;`; initialise `undefined` and `new Map()` in the context literal (line 3790).
     - `ClaudeAdapterLiveOptions`: add `readonly onRateLimitChange?: (rejected: ReadonlyArray<{ readonly rateLimitType: string; readonly resetsAtEpochSeconds: number | undefined }>) => Effect.Effect<void>;`.
     - `handleAssistantMessage`: replace the first guard with
       ```ts
       if (message.type !== "assistant") return;
       if (message.error !== undefined) {
         // The CLI renders API failures as a synthetic assistant message. Keep it out of the
         // transcript and keep its text for the failing result that follows.
         if (message.parent_tool_use_id === null) {
           const text = extractAssistantTextBlocks(message).join("\n").trim();
           context.lastApiError = { code: message.error, text: text.length > 0 ? text : undefined };
         }
         return;
       }
       ```
       (`extractAssistantTextBlocks` exists at line 1108.)
     - Rate-limit branch (line 3019): before offering the existing event, `context.rejectedRateLimits = updateRejectedRateLimits(context.rejectedRateLimits, { status: message.rate_limit_info.status, rateLimitType: message.rate_limit_info.rateLimitType, resetsAt: message.rate_limit_info.resetsAt })` (guard `message.rate_limit_info` being absent: skip the update). After offering the event call `options?.onRateLimitChange?.([...context.rejectedRateLimits].map(([rateLimitType, resetsAtEpochSeconds]) => ({ rateLimitType, resetsAtEpochSeconds })))`. Keep emitting `account.rate-limits.updated` unchanged.
     - `turnStatusFromResult(result, failure)`: new second parameter `failure: ClaudeResultFailure | undefined`; for `subtype === "success"` return `failure === undefined ? "completed" : "failed"`; the rest is unchanged.
     - `emitRuntimeError(context, message, cause?, errorClass: RuntimeErrorClass = "provider_error")`: use `errorClass` for `payload.class` (import `type RuntimeErrorClass` from `@neokod/contracts`, as `CopilotAdapter.ts` line 38 does).
     - `handleResultMessage` after the interrupted-turn absorb block:
       ```ts
       const nowSeconds = Math.floor(DateTime.toEpochMillis(yield * DateTime.now) / 1000);
       const failure = claudeResultFailure(message, {
         ...(context.lastApiError ? { assistantError: context.lastApiError } : {}),
         ...(() => {
           const s = latestRejectedResetSeconds(context.rejectedRateLimits, nowSeconds);
           return s === undefined ? {} : { resetsAtEpochSeconds: s };
         })(),
       });
       const status = turnStatusFromResult(message, failure);
       const errorMessage =
         failure?.message ?? (message.subtype === "success" ? undefined : message.errors[0]);
       context.lastApiError = undefined;
       if (status === "failed") {
         yield *
           emitRuntimeError(
             context,
             errorMessage ?? "Claude turn failed.",
             failure
               ? {
                   kind: failure.kind,
                   ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
                   ...(failure.apiErrorStatus !== undefined
                     ? { apiErrorStatus: failure.apiErrorStatus }
                     : {}),
                   ...(failure.terminalReason ? { terminalReason: failure.terminalReason } : {}),
                 }
               : undefined,
             failure?.kind === "auth" ? "permission_error" : "provider_error",
           );
       }
       if (status === "completed" && context.rejectedRateLimits.size > 0) {
         context.rejectedRateLimits = new Map();
         yield * options?.onRateLimitChange?.([]) ?? Effect.void;
       }
       yield * completeTurn(context, status, errorMessage, message);
       ```
       `DateTime` is already imported in this file (line 58). Replace the inline IIFE with a small local `const` if it reads better.
     - `sendTurn` non-steering branch (line 3920 region): `context.lastApiError = undefined;` next to `context.turnState = turnState`.
       The existing ingestion already turns `runtime.error` into an error activity row ("Runtime error" with the message, `ProviderRuntimeIngestion.ts` line 554) and `turn.completed` with `state: "failed"` and `errorMessage` into a failed turn with `lastError`, so no ingestion change is needed.
  4. Driver, `ClaudeDriver.ts` `create`. Mirror the Kiro pattern (`KiroDriver.ts` lines 148-200: `SubscriptionRef` fed by an adapter callback, published from `enrichSnapshot`):
     ```ts
     const providerLimit = yield * SubscriptionRef.make<ServerProviderLimit | null>(null);
     const adapterOptions = {
       ...existing,
       onRateLimitChange: (rejected) =>
         Effect.gen(function* () {
           const nowMs = yield* Clock.currentTimeMillis; // import * as Clock from "effect/Clock"
           yield* SubscriptionRef.set(
             providerLimit,
             providerLimitFromRejected(
               new Map(rejected.map((r) => [r.rateLimitType, r.resetsAtEpochSeconds])),
               nowMs,
             ),
           );
         }),
     };
     ```
     and replace `enrichSnapshot` with:
     ```ts
     enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
       Effect.gen(function* () {
         const initial = yield* SubscriptionRef.get(providerLimit);
         yield* publishSnapshot(applyClaudeLimit(snapshot, initial, yield* Clock.currentTimeMillis));
         const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, { enableProviderUpdateChecks: settings.enableProviderUpdateChecks }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
         yield* SubscriptionRef.changes(providerLimit).pipe(
           Stream.runForEach((limit) =>
             Clock.currentTimeMillis.pipe(Effect.flatMap((nowMs) => publishSnapshot(applyClaudeLimit(enriched, limit, nowMs)))),
           ),
         );
       }),
     ```
     `applyClaudeLimit` is a pure function of the base snapshot and the limit, so a cleared limit restores the base status and message (the base is never mutated). Add `import * as Clock from "effect/Clock"`, `import * as SubscriptionRef from "effect/SubscriptionRef"` and `import * as Stream from "effect/Stream"` if absent. The enrichment restarts on every probe (default every 5 minutes, `SNAPSHOT_REFRESH_INTERVAL`), which re-reads the ref and drops an expired limit.
  5. Text generation (`ClaudeTextGeneration.ts`): the CLI is run as `claude -p --output-format json` and the envelope schema (line 55) only requires `structured_output`. After `Effect.all([stdout, stderr, exitCode])` and before the `exitCode !== 0` check add:
     ```ts
     const cliFailure = describeClaudeCliResultFailure(stdout);
     if (cliFailure !== undefined) {
       return yield * new TextGenerationError({ operation, detail: cliFailure });
     }
     ```
     with `describeClaudeCliResultFailure(stdout: string): string | undefined` exported from `ClaudeUsageLimit.ts`: `JSON.parse` in a try (invalid JSON returns `undefined`), accept an object with `type === "result"`, call `claudeResultFailure(parsed)` and return `failure?.message`. A limit reply therefore becomes a typed failure and never reaches `generateCommitMessage`, `generatePrContent`, `generateBranchName` or `generateThreadTitle` output. Import the helper from `../provider/Layers/ClaudeUsageLimit.ts` (the file already imports from `../provider/Layers/ClaudeProvider.ts`).
  6. Web, `providerStatus.ts` `getProviderSummary`: after the `!provider.installed` branch and before the authenticated branch add
     ```ts
     if (provider.limit) {
       const resets = provider.limit.resetsAt
         ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
             new Date(provider.limit.resetsAt),
           )
         : null;
       return {
         headline: "Usage limit reached",
         detail: resets
           ? `Resets ${resets}.`
           : (provider.message ?? "Try again after the limit resets."),
       };
     }
     ```
     So the card never shows a bare "Authenticated" while a limit is active. The composer banner (`ProviderStatusBanner.tsx`) already renders for `status: "warning"` and shows `provider.message`, which now carries the limit text.
- Do not: treat a non-429 `is_error` as a usage limit; drop the CLI's own text in favour of a generic one (it carries the user's local reset time and zone); render the synthetic assistant text as a chat message; set `auth.status` to anything but what the probe reported; copy `limit` in `hydrateCachedProvider` (`providerStatusCache.ts` line 44); touch the non-success result path beyond reading `errors[0]`.
- Tests:
  - `ClaudeUsageLimit.test.ts` (new, plain `it`/`expect` from `vite-plus/test`): `claudeResultFailure` returns `undefined` for `{ subtype: "success", is_error: false, terminal_reason: "completed" }`; failure `usage_limit` for `{ subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", result: "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)" }` with message equal to that text (already contains "resets", no suffix) and `resetsAt` `2026-10-04T20:30:00.000Z` when `resetsAtEpochSeconds: 1791145800` is given; the same input with `result: "Rate limited"` gets the suffix `Rate limited Resets 2026-10-04 20:30 UTC.`; `api_error_status: 401` gives kind `auth`; 529 gives `overloaded`; `terminal_reason: "aborted_tools"` with `is_error: true` gives `undefined`; `terminal_reason: "blocking_limit"` with `is_error: false` gives `usage_limit`. `updateRejectedRateLimits`: reject `five_hour`, reject `seven_day`, allow `five_hour` leaves only `seven_day`. `providerLimitFromRejected`: an entry whose reset is in the past returns `null`. `applyClaudeLimit`: ready snapshot becomes `warning` with message starting `Usage limit reached. Resets 2026-10-04 20:30 UTC.`, `auth` unchanged, `limit` set; `null` returns the identical object; an expired limit returns the identical object.
  - `ClaudeAdapter.test.ts`, new test `X3 ends a usage-limit result as a failed turn with the reset time`, modelled on `T7` (line 1997): `makeHarness({ onRateLimitChange })` (extend `makeHarness`'s config type at line 164 with `readonly onRateLimitChange?: ClaudeAdapterLiveOptions["onRateLimitChange"]` and spread it into `adapterOptions`), start a session, `sendTurn`, then emit these three messages (cast `as unknown as SDKMessage`, then `yield* drainSdkMessages`):
    ```ts
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1791145800, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false }, uuid: "rl-1", session_id: "sdk-1" }
    { type: "assistant", message: { id: "msg-limit", model: "<synthetic>", role: "assistant", type: "message", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)" }], usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, error: "rate_limit", uuid: "as-1", session_id: "sdk-1" }
    { type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", stop_reason: "stop_sequence", result: "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)", duration_ms: 1456, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], uuid: "res-1", session_id: "sdk-1" }
    ```
    Assert: exactly one `turn.completed` whose `payload.state === "failed"` and `payload.errorMessage` contains `session limit`; exactly one `runtime.error` whose `payload.message` equals the CLI text and `payload.detail` `toMatchObject({ kind: "usage_limit", resetsAt: "2026-10-04T20:30:00.000Z", apiErrorStatus: 429 })`; no `content.delta` event and no `item.completed` event whose `payload.itemType === "assistant_message"` containing the limit text; `(yield* adapter.listSessions())[0]?.status === "ready"` and its `lastError` contains `session limit`; `onRateLimitChange` was called once with `[{ rateLimitType: "five_hour", resetsAtEpochSeconds: 1791145800 }]`. Fails on base: the turn completes as `completed`.
  - `ClaudeAdapter.test.ts`, `X3 clears the rate-limit state after a successful turn`: reject via event, then in a second turn emit a normal `result` `{ subtype: "success", is_error: false, ... }`; `onRateLimitChange` last call is `[]`. And `X3 fails a 529 result without an assistant error message`: only the result with `api_error_status: 529, is_error: true, result: "Overloaded"`; state `failed`, message `Overloaded`.
  - `ClaudeTextGeneration.test.ts`, new test using `withFakeClaudeEnv` (line 70) with `output: JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", result: "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)" })` and once with `exitCode: 1`; call `textGeneration.generateCommitMessage({ ... same input as the first test ... })`, `Effect.flip`, expect a `TextGenerationError` whose `detail` contains `session limit`. Fails on base (detail is "unexpected output format" or the raw stdout).
  - `providerStatus.test.ts`: a provider fixture with `auth: { status: "authenticated", label: "Claude Pro Subscription" }` and `limit: { kind: "usage_limit", resetsAt: "2026-10-04T20:30:00.000Z", observedAt: "2026-10-04T20:00:00.000Z" }` gives `headline === "Usage limit reached"`, `detail` starts with `Resets`, and neither string contains `Authenticated`. Without `limit` the headline is `Authenticated · Claude Pro Subscription`. Build the fixture from the `ServerProvider` shape in `packages/contracts/src/server.test.ts` (`baseProviderSnapshot`).
  - `packages/contracts/src/server.test.ts`: decoding `{ ...baseProviderSnapshot, limit: { kind: "usage_limit", observedAt: "2026-10-04T20:00:00.000Z" } }` succeeds, and a snapshot without `limit` still decodes.
- Verify: from `apps/server`: `pnpm exec vp test run src/provider/Layers/ClaudeUsageLimit.test.ts src/provider/Layers/ClaudeAdapter.test.ts src/textGeneration/ClaudeTextGeneration.test.ts src/provider/Drivers/ClaudeDriver.test.ts`; from `apps/web`: `pnpm exec vp test run src/components/settings/providerStatus.test.ts`; from `packages/contracts`: `pnpm exec vp test run src/server.test.ts`; `pnpm exec tsgo --noEmit` in all three. Manual (needs an account at its limit, do not force one): a new Claude turn ends red with the CLI sentence and a "Runtime error" activity row; Settings > Providers shows `Usage limit reached` with the reset time.
- Depends on: none. Effort: L. Commit message: `fix(claude): fail turns that end on an API or usage limit error and surface the limit on the provider card`

### X-4 Copilot runtime death must settle the running turn and recover without a restart

- Problem: all Copilot threads of an instance share one `CopilotClient` that `CopilotDriver.ts` starts once (`client.start()`, line 166). When the CLI child dies the SDK only flips a private `state` to `"disconnected"` (`node_modules/@github/copilot-sdk/dist/client.js` lines 2096-2101) and emits nothing; `CopilotAdapter.ts` has no handler for it, so the running turn never completes and the thread shows Working forever (PV-12). `interruptTurn` swallows the failure of the abort request (`CopilotAdapter.ts` line 1693: `Effect.tryPromise(() => ctx.copilotSession.abort()).pipe(Effect.ignore)`), so Stop reports success. `checkCopilotProviderStatus` keeps answering "Could not reach the GitHub Copilot runtime." (`CopilotProvider.ts` line 250) because nothing restarts the client, and the SDK does not restart itself: `createSession` and `resumeSession` only auto-start when `this.connection` is null (`client.js` lines 981 and 1202), and after a child death the connection object is still set (only `stop()` and `forceStop()` null it, lines 677-681 and 800-815).
- Files to change:
  - `apps/server/src/provider/copilot/CopilotRuntimeSupervisor.ts` (new) : liveness probe and serialized restart.
  - `apps/server/src/provider/copilot/CopilotAdapter.ts` : `CopilotAdapterLiveOptions` (line 99), `stopSessionInternal` (line 621), `sendTurn` send call (line 1669), `interruptTurn` (line 1688), a watchdog fiber in `makeCopilotAdapter` (line 530).
  - `apps/server/src/provider/copilot/CopilotDriver.ts` : `create` (client at line 150, `adapterOptions` line 186, `checkProvider` line 193, snapshot at line 199).
  - Tests: `CopilotRuntimeSupervisor.test.ts` (new), `CopilotAdapter.test.ts`.
- Change:
  1. New `CopilotRuntimeSupervisor.ts`:
     ```ts
     export interface CopilotRuntimeClient {
       readonly ping: (message?: string) => Promise<unknown>;
       readonly start: () => Promise<void>;
       readonly forceStop: () => Promise<void>;
     }
     export type CopilotRuntimeLiveness = "alive" | "dead" | "unknown";
     export interface CopilotRuntimeSupervisor {
       /** "dead" only when ping rejects; a ping that times out is "unknown" and never triggers a restart. */
       readonly probe: Effect.Effect<CopilotRuntimeLiveness>;
       /** Under a one-permit semaphore: re-probe; when dead, forceStop (errors ignored) then start. True when a restart succeeded. */
       readonly restartIfDead: Effect.Effect<boolean>;
       readonly restartCount: SubscriptionRef.SubscriptionRef<number>;
     }
     export const makeCopilotRuntimeSupervisor: (
       client: CopilotRuntimeClient,
     ) => Effect.Effect<CopilotRuntimeSupervisor>;
     ```
     `probe`: `Effect.tryPromise(() => client.ping()).pipe(Effect.timeoutOption("5 seconds"), Effect.result)` then map `Result.isFailure` to `"dead"`, `Option.isNone(success)` to `"unknown"`, otherwise `"alive"` (same pattern as `CopilotProvider.ts` lines 234-239). Why `ping` rejects on a dead child: the SDK keeps the closed `vscode-jsonrpc` connection, and a request on it throws. `restartIfDead` logs a warning with `Effect.logWarning("GitHub Copilot runtime restart failed.", { cause })` when `start()` fails, and returns false. On success increment `restartCount` and log `Effect.logInfo("GitHub Copilot runtime restarted.")`.
  2. `CopilotAdapter.ts`:
     - `CopilotAdapterLiveOptions` gets `readonly runtime?: Pick<CopilotRuntimeSupervisor, "probe" | "restartIfDead">;`. When it is absent (the existing tests) no watchdog runs and the abort path below only surfaces errors.
     - Add `const handleRuntimeLost = Effect.fn("handleRuntimeLost")(function* (reason: string) {...})` after `stopSessionInternal`. For every `ctx` in `sessions` that is not `stopped` do, in this order (it mirrors `settleSessionFailure` in `OpenCodeAdapter.ts` lines 684-770, whose event order matters because `runtime.error` with a `turnId` would re-assert that turn as active in ingestion, `ProviderRuntimeIngestion.ts` lines 1960-1986):
       a. `yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals)` and `settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs)` (existing helpers, lines 510 and 520);
       b. `const turnId = ctx.activeTurnId; ctx.activeTurnId = undefined;` and when `turnId` is defined emit `turn.completed` with `turnId` and `payload: { state: "failed", errorMessage: reason }`;
       c. emit `runtime.error` WITHOUT `turnId` and with `payload: { message: reason, class: "transport_error", detail: { kind: "runtime_lost" } }`;
       d. `yield* stopSessionInternal(ctx, { reason })`, where `stopSessionInternal` gains an optional second parameter and emits `session.exited` with `payload: { exitKind: "error", reason, recoverable: true }` instead of `{ exitKind: "graceful" }` when it is given. The existing `copilotSession.disconnect()` call stays inside `Effect.ignore`.
       After the loop, when `options?.runtime` exists, start the restart in the background so Stop and send are not delayed by a process spawn: `yield* options.runtime.restartIfDead.pipe(Effect.ignore, Effect.forkIn(adapterScope))` with `const adapterScope = yield* Effect.scope` captured at the top of `makeCopilotAdapter`. Use the message `GitHub Copilot runtime exited unexpectedly. Send your message again to resume.` as the `reason` in all call sites.
       After this, `adapter.hasSession(threadId)` is false and the provider service recovers the thread on the next send through `recoverSessionForThread` (`ProviderService.ts` line 532), which restarts the session from the persisted resume cursor; no change is needed there.
     - Watchdog, started once in `makeCopilotAdapter` when `options?.runtime` is defined:
       ```ts
       const COPILOT_RUNTIME_LIVENESS_INTERVAL = Duration.seconds(3);
       yield *
         Effect.forever(
           Effect.sleep(COPILOT_RUNTIME_LIVENESS_INTERVAL).pipe(
             Effect.andThen(
               Effect.suspend(() =>
                 Array.from(sessions.values()).some(
                   (ctx) => !ctx.stopped && ctx.activeTurnId !== undefined,
                 )
                   ? runtime.probe.pipe(
                       Effect.flatMap((state) =>
                         state === "dead" ? handleRuntimeLost(LOST) : Effect.void,
                       ),
                     )
                   : Effect.void,
               ),
             ),
           ),
         ).pipe(Effect.forkScoped);
       ```
       It only pings while a turn is active, so idle sessions cost nothing; an idle dead session is caught by the send path below.
     - `interruptTurn` (line 1688): replace the `Effect.ignore` with
       ```ts
       const aborted =
         yield * Effect.tryPromise(() => ctx.copilotSession.abort()).pipe(Effect.result);
       if (Result.isFailure(aborted)) {
         if (options?.runtime && yield * options.runtime.probe === "dead") {
           yield * handleRuntimeLost(LOST); // the stop request is satisfied: the turn is gone
           return;
         }
         return yield * toRequestError(threadId, "session/abort", aborted.failure);
       }
       ```
       (the approvals and user inputs are already settled just above, keep that). `toRequestError` returns a `ProviderAdapterError` value (line 493); yield it with `Effect.fail(...)` the way line 1666 does through `Effect.mapError`.
     - `sendTurn`: the `session.send` call (line 1669) and the fleet call both map failures with `toRequestError`. Change the `send` branch to `.pipe(Effect.tapError(() => options?.runtime ? options.runtime.probe.pipe(Effect.flatMap((s) => s === "dead" ? handleRuntimeLost(LOST) : Effect.void)) : Effect.void), Effect.mapError(...))`. The turn was already announced with `turn.started` before the send (line 1627), so without this a failed send on a dead runtime would leave the turn open; `handleRuntimeLost` closes it as failed. A failed send on a live runtime keeps today's behaviour.
  3. `CopilotDriver.ts` `create`, when `effectiveConfig.enabled`:
     - `const runtime = yield* makeCopilotRuntimeSupervisor(client);` and pass it: `adapterOptions = { ...existing, runtime }` (the supervisor takes the SDK `CopilotClient` directly, it has `ping`, `start` and `forceStop`; for a disabled instance pass nothing).
     - `checkProvider`: prefix the probe with the recovery, `(effectiveConfig.enabled ? runtime.restartIfDead : Effect.void).pipe(Effect.andThen(checkCopilotProviderStatus(...)), Effect.map(stampIdentity), ...)`. A manual Refresh or the 5 minute refresh then restarts a dead runtime and reports the real status.
     - After the snapshot is built: `yield* SubscriptionRef.changes(runtime.restartCount).pipe(Stream.drop(1), Stream.runForEach(() => snapshot.refresh), Effect.forkScoped);` so Settings flips back to ready right after an adapter-triggered restart (`snapshot.refresh` is `ServerProviderShape.refresh`, `makeManagedServerProvider.ts` line 148). Imports: `SubscriptionRef`, `Stream`.
- Do not: ping an idle session on a timer; restart on a probe timeout (a busy child is not a dead child); emit `runtime.error` with a `turnId`; call `client.stop()` for the dead child (it first tries a graceful shutdown request over the dead connection; `forceStop()` does not); let two restarts run at once (the semaphore and the re-probe inside it prevent double `start()`); change the resume cursor handling.
- Tests:
  - `CopilotRuntimeSupervisor.test.ts` (new, `@effect/vitest`, `TestClock`): `restarts a dead runtime once` (ping rejects, `forceStop` and `start` counters, two concurrent `restartIfDead` calls via `Effect.all(..., { concurrency: 2 })` give `start` called once and `restartCount` 1); `leaves an alive runtime alone` (ping resolves, no `forceStop`); `treats a ping timeout as unknown` (ping never resolves, `TestClock.adjust("6 seconds")`, `probe` returns `"unknown"`, no restart); `reports a failed start` (start rejects, returns false, `restartCount` stays 0).
  - `CopilotAdapter.test.ts`, new tests built like the Claude tests: a helper `makeRuntimeLayer(liveness: { value: CopilotRuntimeLiveness }, calls: { restarts: number })` returns `Layer.effect(CopilotAdapterTag, makeCopilotAdapter(makeCopilotClientTestDouble(), testCopilotSettings, { instanceId: INSTANCE_ID, runtime: { probe: Effect.sync(() => liveness.value), restartIfDead: Effect.sync(() => { calls.restarts += 1; return true; }) } })).pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())), Layer.provideMerge(NodeServices.layer))`; each test does `Effect.provide(makeRuntimeLayer(...))` so `TestClock` drives the 3 second watchdog. Override fake session methods with `Object.assign(session, { abort: async () => { throw new Error("Connection is closed.") } })` (the double at line 82 builds plain objects). Tests:
    1. `settles a running turn as failed when the runtime dies`: start a session, `sendTurn`, collect events for the thread in a forked fiber, set `liveness.value = "dead"`, `TestClock.adjust("3 seconds")`. Expect in order: `turn.completed` with `payload.state === "failed"` and `payload.errorMessage` containing `GitHub Copilot runtime exited unexpectedly`, then `runtime.error` with `turnId === undefined` and `payload.class === "transport_error"`, then `session.exited` with `payload.exitKind === "error"`; `yield* adapter.hasSession(threadId)` is false; `calls.restarts` is 1. Fails on base (no event is ever emitted).
    2. `does not ping while no turn is active`: start a session, never send, count `probe` calls through the `liveness` object (wrap `probe` with a counter), `TestClock.adjust("30 seconds")`, expect 0 probes.
    3. `surfaces an abort failure on a live runtime`: abort rejects with `new Error("boom")`, liveness `"alive"`, `adapter.interruptTurn(threadId).pipe(Effect.flip)` is a `ProviderAdapterRequestError` with `method === "session/abort"`; no `turn.completed`. Fails on base (the call succeeds).
    4. `treats an abort failure on a dead runtime as a settled turn`: abort rejects, liveness `"dead"`; `interruptTurn` succeeds; exactly one `turn.completed` failed event; `hasSession` false.
    5. `fails the started turn when send hits a dead runtime`: replace `send` with a rejecting function, liveness `"dead"`; `sendTurn` fails with `ProviderAdapterRequestError`; the event list contains `turn.started` then `turn.completed` with `state: "failed"`.
- Verify: from `apps/server`: `pnpm exec vp test run src/provider/copilot/CopilotRuntimeSupervisor.test.ts src/provider/copilot/CopilotAdapter.test.ts src/provider/copilot/CopilotDriver.test.ts`; `pnpm exec tsgo --noEmit`. Manual (the owner's own Copilot runtime child only, per the PV-12 repro): start a long Copilot turn, `kill -9` the `copilot --headless --no-auto-update --stdio` child of the Neokod server; within about 5 seconds the thread shows a failed turn with the runtime message and Settings returns to ready; the next message resumes the session.
- Depends on: none. Effort: M. Commit message: `fix(copilot): settle turns and restart the runtime when the Copilot CLI child dies`

### X-5 Stop on an OpenCode turn must end the turn as interrupted, not failed

- Problem: `interruptTurn` (`apps/server/src/provider/Layers/OpenCodeAdapter.ts` line 1407) calls `session.abort` and emits only `turn.aborted` (line 1417). It does not clear `context.activeTurnId` and it does not settle the turn. OpenCode then sends `session.error` with `{ name: "MessageAbortedError", data: { message: "Aborted" } }` (type `MessageAbortedError`, `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` line 80), and the `session.error` case (line 1065) passes it to `settleSessionFailure` (line 684), which sets the provider session to `error`, emits `turn.completed` with `state: "failed"` and a `runtime.error` "Aborted". The thread shows Failed with a red toast and a double-settled turn (PV-01, reproduced). A `session.status: idle` that arrives after the abort also completes the turn as `completed` (line 1048), so the outcome depends on event order.
- Files to change:
  - `apps/server/src/provider/Layers/OpenCodeAdapter.ts` : `OpenCodeSessionContext` (line 69), context literal (line 1243), `settleSessionFailure` (line 684), `handleSubscribedEvent` `session.status` idle branch (line 1048) and `session.error` case (line 1065), terminal retry abort (line 1042), `sendTurn` (line 1285 region), `interruptTurn` (line 1407), helper near `sessionErrorMessage` (line 368).
  - `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts` : test double (lines 56-215) and new tests.
- Change:
  1. Context state. In `OpenCodeSessionContext` add `abortRequestedTurnId: TurnId | "adapter" | undefined;` (documented: set when Neokod asked OpenCode to abort; cleared when a fresh turn starts). Initialise it `undefined` in the literal at line 1243. A plain mutable field is enough: every access runs on the adapter's single event pump or a request fiber and the existing context already mutates `activeTurnId` the same way.
  2. Helper next to `sessionErrorMessage` (line 368):
     ```ts
     function isMessageAbortedError(error: unknown): boolean {
       return (
         typeof error === "object" &&
         error !== null &&
         "name" in error &&
         error.name === "MessageAbortedError"
       );
     }
     ```
  3. Extract the pending-request clearing out of `settleSessionFailure` (lines 693-728: the `pendingPermissions`/`pendingQuestions` loops emitting `request.resolved` with `decision: "cancel"` and `user-input.resolved`) into `const resolvePendingRequests = Effect.fn("resolvePendingRequests")(function* (context, turnId, raw) {...})` defined just above `settleSessionFailure`, and call it from there. Behaviour of `settleSessionFailure` is unchanged (the existing test `resolves pending permissions when the session errors` must still pass).
  4. New `settleInterruptedTurn`, defined after `settleSessionFailure`:
     ```ts
     const settleInterruptedTurn = Effect.fn("settleInterruptedTurn")(function* (
       context: OpenCodeSessionContext,
       raw: unknown,
     ) {
       const turnId = context.activeTurnId;
       if (turnId === undefined) return; // already settled (idle won the race, or a late abort echo)
       context.activeTurnId = undefined;
       context.activeAgent = undefined;
       context.activeVariant = undefined;
       yield* resolvePendingRequests(context, turnId, raw);
       yield* updateProviderSession(
         context,
         { status: "ready" },
         { clearActiveTurnId: true, clearLastError: true },
       );
       yield* emit({
         ...(yield* buildEventBase({ threadId: context.session.threadId, turnId, raw })),
         type: "turn.completed",
         payload: { state: "interrupted" },
       });
     });
     ```
     (`ProviderRuntimeIngestion.ts` line 1619-1623 maps any non-failed `turn.completed` to session status `ready` with no error, and `normalizeRuntimeTurnState` line 221 keeps `"interrupted"`, so the thread returns to idle with a neutral turn state, the same shape the Claude adapter emits.)
  5. `interruptTurn` (line 1407). Mark first, abort, then settle:
     ```ts
     const context = ensureSessionContext(sessions, threadId);
     const targetTurnId = turnId ?? context.activeTurnId;
     // Mark before the request: OpenCode can deliver the abort echo (session.error or idle) while session.abort is still in flight.
     if (targetTurnId !== undefined) context.abortRequestedTurnId = targetTurnId;
     yield* runOpenCodeSdk("session.abort", ...).pipe(Effect.mapError(toRequestError));
     if (targetTurnId !== undefined) {
       yield* emit({ ...(yield* buildEventBase({ threadId, turnId: targetTurnId })), type: "turn.aborted", payload: { reason: "Interrupted by user." } });
       if (context.activeTurnId === targetTurnId) yield* settleInterruptedTurn(context, undefined);
     }
     ```
     If `session.abort` fails, the `Effect.mapError` failure propagates as today and the mark stays set; the next `sendTurn` clears it. Keep the `turn.aborted` event: ingestion uses it as a turn-boundary closure signal for runtime items (`ProviderRuntimeIngestion.ts` line 424).
  6. `handleSubscribedEvent`:
     - `session.error` case becomes
       ```ts
       case "session.error": {
         if (isMessageAbortedError(event.properties.error) && context.abortRequestedTurnId !== undefined) {
           yield* settleInterruptedTurn(context, event); // no-op when interruptTurn or idle already settled it
           break;
         }
         yield* settleSessionFailure(context, { message: sessionErrorMessage(event.properties.error), detail: event.properties.error, raw: event });
         break;
       }
       ```
       An abort error that Neokod did not request keeps today's failure path (it means something else cancelled the work).
     - `session.status` idle branch (line 1048): choose the state with `const state = context.abortRequestedTurnId === turnId ? "interrupted" : "completed";` and emit `{ state }` (the rest of the branch is unchanged), so an idle that wins the race still reports the interrupted outcome.
     - Terminal retry path (line 1042): before the existing `session.abort` call add `context.abortRequestedTurnId = "adapter";` so the abort echo that follows the already settled failure is absorbed instead of emitting a second `runtime.error` (`settleInterruptedTurn` returns early because `activeTurnId` is already undefined).
  7. `sendTurn` (line 1285 region): inside the fresh-turn branch (`steeringTurnId === undefined`, line 1346, where `turn.started` is emitted) set `context.abortRequestedTurnId = undefined;` before emitting. A steer keeps the mark untouched.
- Do not: treat every `MessageAbortedError` as an interrupt (only after a request from Neokod); emit `runtime.error` for an interrupt; call `settleSessionFailure` from `interruptTurn`; await the abort echo before returning from `interruptTurn`; clear the mark on the idle event (a late `session.error` can still follow idle).
- Tests, in `OpenCodeAdapter.test.ts`:
  - Test double: add to `runtimeMock.state` (and to `reset()`) `eventsAfterAbort: [] as unknown[]` and `onAbortCall: null as (() => void) | null`. In `session.abort` (line 108) after pushing to `abortCalls` call `runtimeMock.state.onAbortCall?.()`. In the `event.subscribe` generator (line 187) after the existing `for` loop add: `if (runtimeMock.state.eventsAfterAbort.length > 0) { if (runtimeMock.state.abortCalls.length === 0) { await new Promise<void>((resolve) => { runtimeMock.state.onAbortCall = resolve; }); } for (const event of runtimeMock.state.eventsAfterAbort) yield event; }`.
  - `settles Stop as interrupted when the abort echo arrives as MessageAbortedError`: `holdSubscribedEventsUntilPrompt = true`, `eventsAfterAbort = [{ type: "session.error", properties: { sessionID: "http://127.0.0.1:9999/session", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }]`. Fork a collector for events of this thread with types `turn.completed`, `runtime.error`, `turn.aborted`, taking events until a 300 ms real-time quiet period, e.g. use `joinWithinRealTime` with `Stream.take(2)` for `turn.aborted` and `turn.completed`, then wait 200 ms real time and read the collected list (follow `settles the active turn when OpenCode retries a terminal credential failure`, line 502, for the pattern). Steps: `startSession`, `sendTurn` (model `openai/gpt-5`), `interruptTurn(threadId, turn.turnId)`. Assert: exactly one `turn.completed` with `payload` equal to `{ state: "interrupted" }` and `turnId` equal to `turn.turnId`; zero `runtime.error` events; `listSessions()` entry has `status === "ready"`, `activeTurnId === undefined`, `lastError === undefined`. Fails on base: the base emits `turn.completed` `failed` and `runtime.error` "Aborted".
  - `reports interrupted when idle wins the race against the abort echo`: `eventsAfterAbort = [{ type: "session.status", properties: { sessionID: "http://127.0.0.1:9999/session", status: { type: "idle" } }}]`; same steps; exactly one `turn.completed` with `state: "interrupted"`. Fails on base (`completed` or two events).
  - `keeps an unrequested MessageAbortedError as a failure`: no `interruptTurn`; `subscribedEvents` with the aborted `session.error` and `holdSubscribedEventsUntilPrompt = true`; `turn.completed` has `state: "failed"` and a `runtime.error` is emitted. Passes on base and after.
  - `absorbs the abort echo after a terminal credential retry`: extend the existing terminal retry test fixture (line 502) with `eventsAfterAbort` holding the aborted `session.error`; assert only the two events `turn.completed` (failed) and `runtime.error` (from the retry) exist and a later `session.error` adds none (assert the collector, after a 200 ms real wait, still has length 2). Fails on base (a third `runtime.error`).
  - `a new turn clears the interrupt mark`: after the first interrupt, `sendTurn` again and deliver an aborted `session.error` through `eventsAfterAbort` without calling `interruptTurn`; expect `turn.completed` `failed` for the second turn.
  - `resolves pending permissions on interrupt`: emit `permission.asked` in `subscribedEvents` (as at line 456), call `interruptTurn`, expect a `request.resolved` with `decision: "cancel"` and that `respondToRequest` fails with `Unknown pending permission request`.
- Verify: from `apps/server`: `pnpm exec vp test run src/provider/Layers/OpenCodeAdapter.test.ts`; `pnpm exec tsgo --noEmit`. Manual (PV-01 repro on a throwaway repo): start a long OpenCode turn, press Stop; the header returns to idle, the turn shows Interrupted, no red toast, no "Runtime error" row.
- Depends on: none. Effort: M. Commit message: `fix(opencode): settle a user Stop as interrupted instead of failing on the abort echo`

### X-6 Spawned `opencode serve` children: random password, scrubbed environment, orphan ledger

- Problem: `startOpenCodeServerProcess` (`apps/server/src/provider/opencodeRuntime.ts` line 367) spawns `opencode serve --hostname=127.0.0.1 --port=<n>` with `detached: hostPlatform !== "win32"` (line 394), `extendEnv: true` when no environment is given (line 405), and no password. Any local process can drive that server (sessions, shell tool, permission replies) while it lives, and after a `kill -9` of the Neokod server the scope finalizer (line 420-440) never runs, so seven servers were left running, unauthenticated (PV-11, CP-19, CP-22). There is no record of spawned groups and no startup reaper. The three clients that talk to a spawned server pass no password: `OpenCodeAdapter.ts` line 1167-1171 (`...(server.external && serverPassword ? ...)`), `OpenCodeProvider.ts` line 436-442, `OpenCodeTextGeneration.ts` line 388-393.
- Verified facts (run on the owner's binary 1.18.34 with an isolated HOME and XDG\_\* directories under a temp dir, killed afterwards): with `OPENCODE_SERVER_PASSWORD=testpw123` in the environment, `opencode serve` still prints `opencode server listening on http://127.0.0.1:<port>` (the readiness line `parseServerUrlFromOutput` waits for), `GET /global/health` without credentials returns 401, with `Authorization: Basic base64(opencode:testpw123)` returns 200, with a wrong password 401. The username is fixed to `opencode` unless `OPENCODE_SERVER_USERNAME` is set. The existing SDK client already sends `Basic base64("opencode:" + serverPassword)` (`opencodeRuntime.ts` line 560-571). The OpenCode 2.x source (`oc` clone, `packages/cli/src/env.ts` lines 9-12) reads `OPENCODE_PASSWORD` first and falls back to the legacy `OPENCODE_SERVER_PASSWORD`, so set only the legacy name and remove an inherited `OPENCODE_PASSWORD` so it cannot shadow it.
- References (read, then re-implement; licences differ): T3 `repos/t3code/apps/server/src/provider/OpenCodeServerLedger.ts` (whole file: entry schema lines 14-35, `observeLinux` 112-130, `psDarwin` 132-146, `track` 213-257, `stopOrphan` 267-289, `reapEntry`/`reapOrphans` 291-315). Synara `synara/apps/server/src/provider/opencodeRuntime.ts` lines 1021-1050 (random password per spawn, `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` in the child env only). T3's gaps to avoid: it writes the entry with plain `writeFileString` (line 249), and it takes the owner pid from the current process only.
- Files to change:
  - `apps/server/src/provider/OpenCodeServerLedger.ts` (new) : service, system inspector, `reapOrphans`.
  - `apps/server/src/provider/opencodeRuntime.ts` : `OpenCodeServerProcess` (line 62), `OpenCodeServerConnection` (line 67), `makeOpenCodeRuntime` (line 316) spawn block (lines 367-440), `connectToOpenCodeServer` (line 534).
  - `apps/server/src/provider/Layers/OpenCodeAdapter.ts` : `createOpenCodeSdkClient` call (line 1167).
  - `apps/server/src/provider/Layers/OpenCodeProvider.ts` : `createOpenCodeSdkClient` call (line 436).
  - `apps/server/src/textGeneration/OpenCodeTextGeneration.ts` : `runAgainstServer` (line 383) and its external call (line 499).
  - `apps/server/src/server.ts` : runtime layer chain near line 308.
  - `apps/server/src/provider/OpenCodeServerLedger.test.ts` (new), `apps/server/src/provider/opencodeRuntime.test.ts`, `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`.
- Change:
  1. Environment and password in `opencodeRuntime.ts`. Add near the top-level helpers:
     ```ts
     import * as NodeCrypto from "node:crypto";
     const OPENCODE_SERVER_USERNAME = "opencode";
     // Names removed from the child's environment: Neokod-internal configuration and any inherited OpenCode auth that would shadow the per-spawn password.
     const OPENCODE_CHILD_ENV_DENY_PREFIXES = ["NEOKOD_", "T3CODE_"] as const;
     const OPENCODE_CHILD_ENV_DENY_NAMES = new Set([
       "OPENCODE_SERVER_PASSWORD",
       "OPENCODE_SERVER_USERNAME",
       "OPENCODE_PASSWORD",
     ]);
     export function buildOpenCodeServerEnvironment(
       base: NodeJS.ProcessEnv,
       serverPassword: string,
     ): Record<string, string> {
       const env: Record<string, string> = {};
       for (const [name, value] of Object.entries(base)) {
         if (value === undefined) continue;
         if (OPENCODE_CHILD_ENV_DENY_NAMES.has(name)) continue;
         if (OPENCODE_CHILD_ENV_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
         env[name] = value;
       }
       env.OPENCODE_SERVER_PASSWORD = serverPassword;
       return env;
     }
     ```
     The prefix rule matches the terminal's rule (`terminal/Manager.ts` lines 1087-1093). Provider API keys, `HOME`, `PATH`, `XDG_*` and `OPENCODE_CONFIG_*` pass through, because OpenCode needs them to find its config and credentials. A stricter allowlist is an owner decision (see Open questions); do not add one here.
  2. In `startOpenCodeServerProcess` replace lines 391-406 (the `env`/`extendEnv` spread) with an explicit complete environment and no password in argv:
     ```ts
     const serverPassword = NodeCrypto.randomBytes(32).toString("base64url");
     const childEnvironment = buildOpenCodeServerEnvironment(input.environment ?? process.env, serverPassword);
     const spawnCommand = yield* resolveCommand(input.binaryPath, args, childEnvironment);   // existing line 391 moves below the password creation
     ... ChildProcess.make(spawnCommand.command, spawnCommand.args, { detached: hostPlatform !== "win32", shell: spawnCommand.shell, env: childEnvironment, extendEnv: false })
     ```
     Keep the existing comment about not injecting `OPENCODE_CONFIG_CONTENT`. `extendEnv: false` is required: with `true` the spawner merges the parent `process.env` back over `env` (`.repos/effect-smol/packages/platform-node-shared/src/NodeChildProcessSpawner.ts` lines 80-85), which would put the denied names back. This is the same fix plan card 1.14 makes for Symphony (`docs/plan-cards/02-w0-w1-w2-containment.md` card 1.14); the two cards touch different files and can land in any order. `runOpenCodeCommand` (line 331) keeps its own behaviour; it does not run a server.
  3. Return the password: `OpenCodeServerProcess` and `OpenCodeServerConnection` get `readonly serverPassword?: string;` (optional so the test doubles and external connections stay valid). `startOpenCodeServerProcess` returns `{ url, exitCode, serverPassword }`. `connectToOpenCodeServer` copies it for the local branch (`serverPassword: server.serverPassword`) and leaves it unset for the external branch (the user's configured password stays in settings).
  4. Client call sites. In each of the three files compute the password as "the external server's configured password, else the spawned server's generated one":
     - `OpenCodeAdapter.ts` line 1170: `...((server.external ? serverPassword : server.serverPassword) ? { serverPassword: server.external ? serverPassword : server.serverPassword } : {})`; write it with a local `const clientPassword = server.external ? serverPassword : server.serverPassword;` placed before the `createOpenCodeSdkClient` call and spread `...(clientPassword ? { serverPassword: clientPassword } : {})`.
     - `OpenCodeProvider.ts` line 439: `const clientPassword = isExternalServer ? openCodeSettings.serverPassword : server.serverPassword;` then the same spread.
     - `OpenCodeTextGeneration.ts`: change `runAgainstServer`'s parameter type (line 384) to `Pick<OpenCodeRuntime.OpenCodeServerConnection, "url" | "serverPassword">` and the client creation (line 388-393) to `const clientPassword = openCodeSettings.serverUrl.length > 0 ? openCodeSettings.serverPassword : server.serverPassword;` with the same spread. `acquireSharedServer` returns an `OpenCodeServerProcess`, which now carries the password, so the shared server path needs no other change; the external call at line 499 stays `{ url: openCodeSettings.serverUrl }`.
  5. `OpenCodeServerLedger.ts` (new, Neokod style: `Context.Service`, `Effect.fn`, `Schema`, no new dependency). Contents:
     - Entry schema (version 1): `{ version: 1, pgid, pid, startTime, command, port, stateDir, owner: { pid, startTime } }` with `Schema.fromJsonString`, `decodeUnknownOption` as in T3 lines 14-39. File path `<stateDir>/opencode-servers/<pgid>.json`; the file name regex is `^\d+\.json$`.
     - `ProcessInspector` interface so tests need no real processes:
       ```ts
       export interface ObservedProcess {
         readonly pid: number;
         readonly pgid: number;
         readonly startTime: string;
         readonly command: string;
         readonly zombie: boolean;
       }
       export interface ProcessInspector {
         readonly observe: (pid: number) => Effect.Effect<ObservedProcess | undefined>;
         readonly observeGroup: (pgid: number) => Effect.Effect<ReadonlyArray<ObservedProcess>>;
         readonly groupExists: (pgid: number) => Effect.Effect<boolean>;
         readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => Effect.Effect<void>;
       }
       ```
       `makeSystemProcessInspector` (needs `FileSystem`, `ChildProcessSpawner`, `HostProcessPlatform`): Linux reads `/proc/<pid>/stat` (fields after the last `)`: state, ppid, pgrp at index 2, starttime at index 19) and `/proc/<pid>/cmdline` (NUL to space); macOS runs `/bin/ps -ww -o pid=,pgid=,stat=,lstart=,args= -p <pid>` (or `-A` for `observeGroup`) with env `{ LC_ALL: "C", TZ: "UTC" }`, `extendEnv: true`, `stdin: "ignore"`, 5 second timeout, parsed with `^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$` (verified on this machine: output ` 4908  4908 Ss   Sun Oct  4 22:04:25 2026     /bin/zsh ...`; `lstart` has whole-second resolution); other platforms return `undefined`/`[]`. `groupExists` and `signalGroup` use `process.kill(-pgid, signal)` in try/catch (`ESRCH` means gone; signal 0 probes). This is the same call `killOpenCodeProcessGroup` already uses (`opencodeRuntime.ts` line 420).
     - `OpenCodeServerLedger` service: `track(server: { pid: number; port: number; args: ReadonlyArray<string> }): Effect<Effect<void>>` (returns the effect that forgets the entry after a graceful stop) and `reapOrphans: Effect<void>`. Use `Context.Reference` so the runtime has a no-op default and the six test files that build `OpenCodeRuntimeLive` over `NodeServices` alone keep working without a ledger layer:
       ```ts
       export const OpenCodeServerLedger = Context.Reference<{ readonly track: ...; }>("neokod/provider/OpenCodeServerLedger", { defaultValue: () => ({ track: () => Effect.succeed(Effect.void) }) });
       ```
       Follow the `Context.Reference` form already used in `packages/shared/src/hostProcess.ts`.
     - `make({ stateDir, ownerPid = process.pid, inspector })`:
       - `owner` = `inspector.observe(ownerPid)`; when undefined (unsupported platform) `track` records nothing and logs a warning only if the group exists.
       - `track`: `pgid = server.pid`; `leader = observe(pgid)`; members = `[leader]` when it is a live non-zombie with `pgid === pgid`, else `observeGroup(pgid)` without zombies; pick the member whose command ends with ` ${args.join(" ")}` else the first; write the entry with `writeFileStringAtomically({ filePath, contents })` from `../atomicWrite.ts` (create `opencode-servers` first; a crash mid-write then leaves no half file, and the reaper ignores the temp directories because they do not match the file regex). Every failure is caught and logged (`Effect.logWarning("Could not record an OpenCode server process", { cause })`) and returns a no-op forget effect: tracking must never fail a spawn.
       - `stopOrphan(entry)`: only when `observe(entry.pid)` returns a non-zombie process with the same `startTime`, same `pgid` and an identical `command` string; then log, `signalGroup(pgid, "SIGTERM")`, poll `groupExists` 40 times every 50 ms, then `SIGKILL` if the group never emptied (a group that never emptied cannot have had its id reused).
       - `reapEntry(path)`: decode; drop entries whose `stateDir` differs from this one; skip (keep the file) when `owner` is still running (`observe(owner.pid)` non-zombie with the same `startTime`); otherwise `stopOrphan` then remove the file. Failures are logged and never thrown.
       - `reapOrphans`: list `<stateDir>/opencode-servers`, run `reapEntry` for names matching `^\d+\.json$`.
     - `layer`: `Layer.effect(OpenCodeServerLedger, Effect.gen(function* () { const config = yield* ServerConfig; const inspector = yield* makeSystemProcessInspector; const ledger = yield* make({ stateDir: config.stateDir, inspector }); yield* ledger.reapOrphans.pipe(Effect.forkScoped); return { track: ledger.track }; }))`. The reap is forked so waiting for orphans to exit never delays startup.
  6. Track the spawn in `startOpenCodeServerProcess`. Read the ledger at the top of `makeOpenCodeRuntime` (`const ledger = yield* OpenCodeServerLedger;`) and, right after `Scope.addFinalizer(runtimeScope, terminateChild)`, add `const forget = yield* ledger.track({ pid: Number(child.pid), port, args }); yield* Scope.addFinalizer(runtimeScope, forget);` (`args` and `port` are already in scope, lines 365-390). Finalizers run in reverse order of registration, so `forget` runs before the process kill; that is acceptable because the entry is only meaningful while the owner is alive and a crash between the two leaves an entry whose owner is dead, which the next start reaps and verifies. On win32 `track` returns the no-op (the platform check lives in the system inspector, which returns `undefined`).
  7. `server.ts` line 308: change to `Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive.pipe(Layer.provideMerge(OpenCodeServerLedger.layer)))`, importing `* as OpenCodeServerLedger from "./provider/OpenCodeServerLedger.ts"`. The ledger needs `ServerConfig`, `FileSystem`, `ChildProcessSpawner` and `HostProcessPlatform`, which the runtime chain already provides; let `tsgo` tell you if a layer must move.
- Do not: put the password on the command line (visible in `ps`); log the password or the child environment; kill a group by pid alone without the identity match (pid, start time, pgid, full command); reap an entry whose owner is still running (a second Neokod server on the same base directory); wait for the reaper before starting the server; start any real `opencode serve` in tests.
- Tests:
  - `opencodeRuntime.test.ts` (reuse `makeCapturingSpawner`, `startServerAndSettle`, `runtimeLayerWith`; note `startServerAndSettle` currently passes the environment through `startOpenCodeServerProcess`):
    - Update `passes an inherited OPENCODE_CONFIG_CONTENT ...`: still asserts `captured[0].options.env?.OPENCODE_CONFIG_CONTENT` equals the value.
    - Update `does not synthesize an empty OPENCODE_CONFIG_CONTENT ...` to `toEqual({ HOME: "/home/operator", PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: expect.any(String) })` (the password is the only addition).
    - Replace `inherits the parent environment wholesale when no environment is given` with `uses the scrubbed process environment when none is given`: set `process.env.NEOKOD_TEST_SECRET = "x"` and `process.env.OPENCODE_PASSWORD = "inherited"` (restore in `Effect.ensuring`), call `startServerAndSettle()`; assert `captured[0].options.extendEnv` is `false`, `env.NEOKOD_TEST_SECRET` is `undefined`, `env.OPENCODE_PASSWORD` is `undefined`, `env.PATH` equals `process.env.PATH`. Fails on base (`env` undefined, `extendEnv` true).
    - New `generates a distinct password per spawn and keeps it out of argv`: start two servers through two `startServerAndSettle` calls; passwords `server.serverPassword` are strings of at least 40 characters, differ, equal `captured[i].options.env.OPENCODE_SERVER_PASSWORD`, and `captured[i].args.join(" ")` does not contain either. Fails on base (no password).
    - New `buildOpenCodeServerEnvironment drops NEOKOD_, T3CODE_ and opencode auth names` as a pure test.
  - `OpenCodeServerLedger.test.ts` (new, `@effect/vitest` with `NodeServices.layer` for the real `FileSystem` and `Path`, temp directory from `fileSystem.makeTempDirectoryScoped`, a fake `ProcessInspector` backed by a mutable `Map<number, ObservedProcess>` and a `signals: Array<{ pgid, signal }>` array; `signalGroup` removes the group members from the map on `SIGTERM` to simulate exit, `groupExists` reads the map). Tests:
    - `records a spawned group atomically`: `track({ pid: 500, port: 4100, args: ["serve", "--hostname=127.0.0.1", "--port=4100"] })` with the map holding pid 500 (`pgid: 500`, command `/bin/opencode serve --hostname=127.0.0.1 --port=4100`) and owner 100; read `<stateDir>/opencode-servers/500.json` and decode it: `pgid 500`, `pid 500`, `command` equal to the observed string, `owner` equal to `{ pid: 100, startTime }`, `stateDir` equal; the directory has no other entries (no leftover temp directory).
    - `forgets the entry after a graceful stop`: run the returned effect; the file is gone.
    - `reaps a group whose owner is gone and whose identity matches`: write the entry through `track`, then build a second ledger with `ownerPid: 101` and an inspector whose owner 100 is absent; `reapOrphans`; `signals` equals `[{ pgid: 500, signal: "SIGTERM" }]` and the file is removed.
    - `leaves a group alone when the owner is still running`: owner 100 present with the same start time; `reapOrphans`; no signals; the file remains.
    - `does not signal when the pid was reused`: same entry, pid 500 now has a different `startTime`; no signals; the stale file is removed.
    - `does not signal when the command line differs`: pid 500 has command `/bin/vim file`; no signals; file removed.
    - `escalates to SIGKILL when the group does not exit`: inspector ignores `SIGTERM`; use `TestClock.adjust` to cover the 40 polls; signals are `[SIGTERM, SIGKILL]`.
    - `ignores entries recorded for another state directory`: write an entry whose `stateDir` differs; no signals; the file is removed.
    - `ignores unreadable and unrelated files`: `garbage.json` is not touched, `501.json` containing `not json` is removed.
    - `track never fails when the platform is unsupported`: inspector `observe` returns `undefined`; `track` succeeds and writes nothing.
  - `OpenCodeAdapter.test.ts`: the test double `startOpenCodeServerProcess` (line 94) returns `serverPassword: "spawned-password"`, `connectToOpenCodeServer` for no `serverUrl` returns it too; add `spawned local server clients authenticate with the generated password`: a layer variant with `serverUrl: ""` (see how the file builds alternative layers at lines 392 and 776) starts a session and asserts `runtimeMock.state.authHeaders` equals `[`Basic ${btoa("opencode:spawned-password")}`]`. Fails on base (header is null). The existing external-server test (line 296) keeps passing.
- Verify: from `apps/server`: `pnpm exec vp test run src/provider/opencodeRuntime.test.ts src/provider/OpenCodeServerLedger.test.ts src/provider/Layers/OpenCodeAdapter.test.ts src/provider/Layers/OpenCodeProvider.test.ts src/textGeneration/OpenCodeTextGeneration.test.ts src/provider/Layers/ProviderRegistry.test.ts`; `pnpm exec tsgo --noEmit`. Manual (throwaway base directory only, never the owner's): start a server with `--base-dir <temp>`, start one OpenCode turn, run `ps eww -p <opencode serve pid>` and confirm the environment has `OPENCODE_SERVER_PASSWORD` and no `NEOKOD_` names, `curl http://127.0.0.1:<port>/global/health` returns 401, `ls <temp>/userdata/opencode-servers` shows `<pid>.json`; `kill -9` the server, restart it with the same base directory, and the old `opencode serve` is gone within a few seconds and the file is removed.
- Depends on: none (coordinates with plan card 1.14, no shared files). Effort: L. Commit message: `fix(opencode): authenticate spawned servers with a per-spawn password and reap orphans after a crash`

### X-7 Stop and approval responses on a binding with no resume state settle the thread and expire approvals; provider error text is sanitised (amendment to plan card 2.3)

Read plan card 2.3 (`docs/plan-cards/02-w0-w1-w2-containment.md` line 762) first. Card 2.3 settles threads left `running` by a crash at boot. This card covers what card 2.3 leaves open (evidence: `rt-c/FINDINGS.md` PV-10, PV-15, `rt-d/FINDINGS.md` FA-10 item 2). Land it after 2.3.

- Problem: (a) After `kill -9`, an OpenCode binding has no resume cursor (the adapter never persists one), so `recoverSessionForThread` fails with `Cannot recover thread '<id>' because no provider resume state is persisted.` (`apps/server/src/provider/Layers/ProviderService.ts` lines 568-573). Both `interruptTurn` (line 905) and `respondToRequest` (line 942) route with `allowRecovery: true`, so Stop and Approve fail, `ProviderCommandReactor` records `provider.turn.interrupt.failed` / `provider.approval.respond.failed`, and the thread stays `running`. A fresh failed Stop gives a collapsed work-log row and nothing else. (b) Card 2.3 settles the session at boot, but the runtime items (pending approvals) are only closed by `reconcileRuntimeItemsAtStartup`, which runs inside `orchestrationReactor.start()` (`serverRuntimeStartup.ts` line 348), before `providerSessionReconciler.reconcile` (line 353). After 2.3 alone, the approval card stays until a second restart. (c) The stored failure detail is `Cause.pretty(cause)` (`ProviderCommandReactor.ts` lines 268, 916, 958, 1002), which prints `at toValidationError (file:///Users/.../bin.mjs:40875:9)` frames and absolute paths. The web banner renders `session.lastError` verbatim (`apps/web/src/components/chat/ThreadErrorBanner.tsx`, fed by `ChatView.tsx` line 1308), so the server text is the only place to fix. `toProcessError` (`OpenCodeAdapter.ts` line 131) is not the leak: it keeps only `detail`.
- Behaviour to implement:
  - A binding that cannot be resumed is a typed condition (`ProviderSessionNotRecoverableError`), not a validation string.
  - Stop on such a thread: settle the projected session as `interrupted` with a clear message. No failure activity.
  - Approve, Decline or user-input answer on such a thread: write the existing stale-request failure detail (this is what `ProjectionPipeline.ts` `isStalePendingApprovalFailureDetail`, line 129, and web `derivePendingApprovals` already treat as "resolved") and settle the session the same way.
  - Settling a session to `interrupted` closes every still-active runtime item of that session (approvals become `approval.resolved`, "Approval orphaned", because termination is not confirmed). This reuses `closeRuntimeItems` in `ProviderRuntimeIngestion.ts`, so it also fixes the gap in card 2.3.
  - User-visible provider failure text has no stack frames and no absolute paths.
- Files to change:
  - `apps/server/src/provider/Errors.ts` : new `ProviderSessionNotRecoverableError` (after `ProviderSessionNotFoundError`, line 162), `ProviderServiceError` union (line 217).
  - `apps/server/src/provider/Layers/ProviderService.ts` : `Errors.ts` import (lines 54-58), `recoverSessionForThread` (lines 568-573).
  - `apps/server/src/provider/userFacingErrorText.ts` (new) : `scrubErrorText`, `userFacingFailureDetail`.
  - `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` : imports (line 32), `isProviderAdapterRequestError` (line 46), `findProviderAdapterRequestError` (line 120), `formatFailureDetail` (line 260), `handleTurnStartFailure` (line 831), `processTurnInterruptRequested` (line 890), `processApprovalResponseRequested` (line 924), `processUserInputResponseRequested` (line 967).
  - `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` : `RuntimeIngestionInput` (line 71), `closeRuntimeItems` (line 874), `processDomainEvent` (line 2051), `reconcileRuntimeItemsAtStartup` settled-session branch (lines 2091-2118), `start` domain filter (around line 2192), `lastError` values (lines 1641, 1644, 1981), `runtime.error` activity (line 554, message at line 563).
  - Tests: `apps/server/src/provider/userFacingErrorText.test.ts` (new), `apps/server/src/provider/Layers/ProviderService.test.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`.
- Change:
  1. `Errors.ts`: add, with the same shape as its neighbours,
     ```ts
     /**
      * ProviderSessionNotRecoverableError - The thread has a persisted binding but
      * no live session and no resume state, so the provider session cannot be rebuilt.
      * Typical after a hard crash of an adapter that never persists a resume cursor.
      */
     export class ProviderSessionNotRecoverableError extends Schema.TaggedErrorClass<ProviderSessionNotRecoverableError>()(
       "ProviderSessionNotRecoverableError",
       { operation: Schema.String, threadId: Schema.String },
     ) {
       override get message(): string {
         return "This thread's provider session was lost when Neokod last restarted and no resume state was saved, so the turn cannot be continued.";
       }
     }
     ```
     Add `| ProviderSessionNotRecoverableError` to `ProviderServiceError`. The message has no ids or paths on purpose because the reactor stores it as `session.lastError`.
  2. `ProviderService.ts`: import the class and replace the `toValidationError(...)` return in the `!hasResumeCursor` branch with
     ```ts
     return (
       yield *
       new ProviderSessionNotRecoverableError({
         operation: input.operation,
         threadId: input.binding.threadId,
       })
     );
     ```
     Everything else in `recoverSessionForThread` stays.
  3. New `userFacingErrorText.ts`. Import `* as Cause from "effect/Cause"`, `* as Option from "effect/Option"`, `truncate` from `@neokod/shared/String`.
     ```ts
     const MAX_USER_FACING_ERROR_CHARS = 2000;
     const STACK_FRAME_LINE = /^\s*at\s.+$/gm;
     const FILE_URL = /file:\/\/[^\s)'"]+/g;
     // POSIX path with at least one directory, not part of a URL or word (lookbehind).
     const POSIX_PATH = /(?<![\w:/.~-])\/(?:[^\s/'"()<>:]+\/)+[^\s/'"()<>:,;]*/g;
     const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s'"<>|]+\\)*[^\\\s'"<>|]*/g;
     const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1);
     const toPlaceholder = (path: string) => {
       const name = lastSegment(path);
       return name ? `[path]/${name}` : "[path]";
     };
     export const scrubErrorText = (text: string): string =>
       text
         .replace(STACK_FRAME_LINE, "")
         .replace(FILE_URL, "[path]")
         .replace(POSIX_PATH, toPlaceholder)
         .replace(WINDOWS_PATH, toPlaceholder)
         .replace(/\n{3,}/g, "\n\n")
         .trim();
     export const GENERIC_INTERNAL_ERROR_DETAIL =
       "Unexpected internal error. See the Neokod server log for details.";
     export const userFacingFailureDetail = (cause: Cause.Cause<unknown>): string => {
       const failure = Cause.findErrorOption(cause);
       if (Option.isNone(failure)) return GENERIC_INTERNAL_ERROR_DETAIL;
       const error = failure.value;
       const detail =
         typeof error === "object" &&
         error !== null &&
         "detail" in error &&
         typeof error.detail === "string"
           ? error.detail
           : error instanceof Error && error.message.trim().length > 0
             ? error.message
             : String(error);
       return truncate(scrubErrorText(detail), MAX_USER_FACING_ERROR_CHARS);
     };
     ```
     Rules in words: a typed failure with a string `detail` (the `ProviderAdapterRequestError` and `ProviderAdapterProcessError` shape, which `formatFailureDetail` already preferred) uses that; otherwise the `message` of an `Error` (tagged errors expose a `message` getter that never contains a stack); a defect or interruption gives the generic text. The full cause is logged by the reactor (next step), never stored.
  4. `ProviderCommandReactor.ts`:
     - Import `ProviderSessionNotRecoverableError` next to `ProviderAdapterRequestError` (line 32), add `const isProviderSessionNotRecoverableError = Schema.is(ProviderSessionNotRecoverableError);` under line 46, and a finder beside `findProviderAdapterRequestError` (line 120):
       ```ts
       function findSessionNotRecoverableError(cause: Cause.Cause<unknown>) {
         const error = Cause.findErrorOption(cause);
         return Option.isSome(error) && isProviderSessionNotRecoverableError(error.value)
           ? error.value
           : undefined;
       }
       ```
     - Replace `formatFailureDetail` (line 260) with an effect that logs the real cause and returns the safe text:
       ```ts
       const describeFailure = (input: {
         readonly operation: string;
         readonly threadId: ThreadId;
         readonly cause: Cause.Cause<unknown>;
       }) =>
         Effect.logWarning("provider.command.failed", {
           operation: input.operation,
           threadId: input.threadId,
           cause: Cause.pretty(input.cause),
         }).pipe(Effect.as(userFacingFailureDetail(input.cause)));
       ```
       `handleTurnStartFailure` (line 831) becomes `describeFailure({ operation: "turn-start", threadId: event.payload.threadId, cause }).pipe(Effect.flatMap((detail) => setThreadSessionErrorOnTurnStartFailure({...detail...}).pipe(Effect.flatMap(() => appendProviderFailureActivity({...detail...})), Effect.asVoid)))` with the existing body otherwise unchanged. The `Cause.hasInterruptsOnly` early return stays first.
     - New helper after `setThreadSessionErrorOnTurnStartFailure` (line 288):
       ```ts
       const settleUnrecoverableSession = (input: {
         readonly threadId: ThreadId;
         readonly message: string;
         readonly createdAt: string;
       }) =>
         Effect.gen(function* () {
           const session = (yield* resolveThread(input.threadId))?.session;
           if (!session || (session.status !== "running" && session.status !== "starting")) return;
           yield* Effect.logInfo("provider.session.unrecoverable-settled", {
             threadId: input.threadId,
           });
           yield* setThreadSession({
             threadId: input.threadId,
             session: {
               ...session,
               status: "interrupted",
               activeTurnId: null,
               lastError: input.message,
               updatedAt: DateTime.formatIso(yield* DateTime.now),
             },
             createdAt: input.createdAt,
           });
         });
       ```
       Only `running` and `starting` sessions are touched, so an idle `ready` thread keeps its state.
     - `processTurnInterruptRequested` (line 910): in the `catchCause`, first branch on `findSessionNotRecoverableError(cause)`; when defined call `settleUnrecoverableSession({ threadId, message: error.message, createdAt: event.payload.createdAt })` and append nothing; otherwise `describeFailure({ operation: "interrupt-turn", ... })` then `appendProviderFailureActivity` with that detail (replacing `Cause.pretty(cause)` at line 916).
     - `processApprovalResponseRequested` (line 951) and `processUserInputResponseRequested` (line 995): in the `catchCause`, when `findSessionNotRecoverableError(cause)` is defined, first `appendProviderFailureActivity` with `detail: stalePendingRequestDetail("approval" | "user-input", event.payload.requestId)` (so the clicked card clears through the existing stale mechanism), then `settleUnrecoverableSession(...)`. Otherwise keep the existing stale-detail test, and replace the `Cause.pretty(cause)` fallback (lines 958, 1002) with `describeFailure({ operation: "approval-response" | "user-input-response", ... })`.
  5. `ProviderRuntimeIngestion.ts`, one shared closure for a settled session:
     - Add after `closeRuntimeItems` (line 905):
       ```ts
       const closeItemsOfSettledSession = Effect.fn("closeItemsOfSettledSession")(
         function* (input: {
           readonly threadId: ThreadId;
           readonly status: "stopped" | "interrupted" | "error";
           readonly updatedAt: string;
           readonly startedNoLaterThan?: string;
         }) {
           const items = yield* projectionRuntimeItemRepository.listByThreadId({
             threadId: input.threadId,
           });
           const sessionIds = new Set(
             items
               .filter((item) => item.effectiveState === "active")
               .filter(
                 (item) =>
                   input.startedNoLaterThan === undefined ||
                   item.startedAt <= input.startedNoLaterThan,
               )
               .map((item) => item.sessionId),
           );
           yield* Effect.forEach(
             sessionIds,
             (sessionId) => {
               const boundaryId = `reconcile:runtime-items:${input.threadId}:session:${sessionId}:${input.status}:${input.updatedAt}`;
               return closeRuntimeItems({
                 threadId: input.threadId,
                 sessionId,
                 boundary: "session",
                 turnId: null,
                 outcome: input.status === "error" ? "failed" : "stopped",
                 terminationGuaranteed: false,
                 commandId: CommandId.make(boundaryId),
                 boundaryEventId: EventId.make(boundaryId),
                 closedAt: input.updatedAt,
               });
             },
             { concurrency: 1, discard: true },
           );
         },
       );
       ```
       The boundary id string is the one the startup code uses today, so the live path and the startup path are idempotent against each other (same command id).
     - In `reconcileRuntimeItemsAtStartup`, replace the body of the settled-session branch (lines 2097-2116) with `yield* closeItemsOfSettledSession({ threadId: thread.id, status: session.status, updatedAt: session.updatedAt }); return;` (no `startedNoLaterThan`, startup behaviour is unchanged).
     - Domain input: add `type SessionSetDomainEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;` under `TurnStartRequestedDomainEvent` (line 66); `RuntimeIngestionInput` domain `event` becomes `TurnStartRequestedDomainEvent | SessionSetDomainEvent`; `processDomainEvent` (line 2051) becomes
       ```ts
       const processDomainEvent = (event: TurnStartRequestedDomainEvent | SessionSetDomainEvent) =>
         event.type === "thread.session-set" && event.payload.session.status === "interrupted"
           ? closeItemsOfSettledSession({
               threadId: event.payload.threadId,
               status: "interrupted",
               updatedAt: event.payload.session.updatedAt,
               startedNoLaterThan: event.payload.session.updatedAt,
             })
           : Effect.void;
       ```
       and the `start` stream filter (line 2192) admits `event.type === "thread.turn-start-requested" || (event.type === "thread.session-set" && event.payload.session.status === "interrupted")`.
       Only `interrupted` is handled live. `error` is not (the reactor sets `error` for a failed turn start while the provider session may be alive) and `stopped` is covered by the stop outcome path. `startedNoLaterThan` stops a late-processed event from closing items a newer turn of the same session opened afterwards.
     - Scrub provider-originated error text: wrap the values at lines 1641 (`event.payload.reason`), 1644 (`event.payload.errorMessage`), 1981 (`runtimeErrorMessage`) and the `runtime.error` activity message at line 563 (before `truncateDetail`) with `scrubErrorText(...)`, imported from `../../provider/userFacingErrorText.ts`. Plain strings without paths are unchanged, so existing assertions such as `"runtime exploded"` keep passing.
- Do not: build the settlement into `ProviderService` (it has no thread projection; the reactor owns `thread.session.set`); mark the turn `completed`/`error` or the binding `stopped` (card 2.3 already writes the honest `error` + `orphan_possible` binding at boot); settle sessions that are not `running`/`starting`; handle `thread.session-set` with status `error` or `stopped` live; strip every `/` from text (URLs and `a/b` model ids must survive, see the tests); change `ThreadErrorBanner` or add a client-side sanitiser (the server stores the safe text; see Open questions for rows stored before this change).
- Tests:
  - `userFacingErrorText.test.ts` (new, `import { describe, expect, it } from "vitest"`, `Cause` from `effect/Cause`, the real `ProviderValidationError`, `ProviderAdapterRequestError` from `./Errors.ts`):
    - `strips stack frames`: input `"ProviderValidationError: Provider validation failed in ProviderService.interruptTurn: boom\n    at toValidationError (file:///Users/kamogelo/Code/t3code/apps/server/dist/bin.mjs:40875:9)\n    at next (/Users/kamogelo/Code/t3code/a.js:1:2)"`; `scrubErrorText` equals the first line.
    - `replaces absolute paths but keeps the file name`: `"ENOENT: no such file or directory, open '/Users/kamogelo/Code/t3code/crash.txt'"` gives `"ENOENT: no such file or directory, open '[path]/crash.txt'"`; `"C:\\Users\\me\\proj\\a.txt missing"` gives `"[path]/a.txt missing"`; `"see file:///Users/me/x.mjs:1:2"` gives `"see [path]"`.
    - `leaves URLs, ids and relative paths alone`: `"GET https://api.example.com/v1/models failed for anthropic/claude-3 in src/a.ts"` is unchanged.
    - `userFacingFailureDetail uses message of a typed error without a stack`: `Cause.fail(new ProviderValidationError({ operation: "ProviderService.interruptTurn", issue: "x" }))` equals `"Provider validation failed in ProviderService.interruptTurn: x"`.
    - `userFacingFailureDetail keeps the detail of request errors`: `Cause.fail(new ProviderAdapterRequestError({ provider: "codex", method: "m", detail: "interrupt failed" }))` equals `"interrupt failed"`.
    - `userFacingFailureDetail hides defects`: `Cause.die(new Error("boom /Users/a/b.ts"))` equals `GENERIC_INTERNAL_ERROR_DETAIL`.
    - `truncates long text`: 5000 `x` characters gives a string of length 2003 ending in `...`.
  - `ProviderService.test.ts`: new `fails interruptTurn with ProviderSessionNotRecoverableError when the binding has no resume cursor` using the existing layer and `routing.codex`. `routing.codex.startSession.mockImplementationOnce` returns a session without `resumeCursor` (copy the fake at line 94 and omit the field, so `upsertSessionBinding`, line 445, stores none), call `provider.startSession(asThreadId("thread-1"), {... same input as the test at line 1127 ...})`, `yield* routing.codex.stopAll()`, then `const failure = yield* Effect.flip(provider.interruptTurn({ threadId: asThreadId("thread-1") }))`. Assert `failure._tag === "ProviderSessionNotRecoverableError"`, `failure.threadId === "thread-1"`, and that `failure.message` contains neither `thread-1` nor `/`. Fails on base (`ProviderValidationError`).
  - `ProviderCommandReactor.test.ts` (reuse `createHarness`, `harness.interruptTurn`, `harness.respondToRequest`, `harness.readModel`, `waitFor`, the dispatch sequences of the tests at lines 1729 and 2009):
    - `settles the thread as interrupted when Stop hits a binding with no resume state`: `harness.interruptTurn.mockImplementation(() => Effect.fail(new ProviderSessionNotRecoverableError({ operation: "ProviderService.interruptTurn", threadId: "thread-1" })))`; session `running` with `activeTurnId: asTurnId("turn-1")`, then `thread.turn.interrupt`. Wait for `session.status === "interrupted"`. Assert `session.activeTurnId === null`, `session.lastError` equals `new ProviderSessionNotRecoverableError({ operation: "x", threadId: "thread-1" }).message`, and no activity has kind `provider.turn.interrupt.failed`. Fails on base (a failure activity, status stays `running`).
    - `does not touch an idle ready thread when Stop hits a binding with no resume state`: same failure, session `ready`; after `waitFor` on `harness.interruptTurn.mock.calls.length === 1` and a drain, `session.status` is still `ready` and there is no failure activity.
    - `expires the approval and settles the thread when Approve hits a binding with no resume state`: copy the test at line 2009 but with the not-recoverable error and `requestId` `approval-request-1`; assert a `provider.approval.respond.failed` activity whose `payload.detail` contains `Stale pending approval request: approval-request-1`, and `session.status === "interrupted"`.
    - `stores no stack frames or paths in provider failure details`: `harness.interruptTurn.mockImplementation(() => Effect.die(new Error("boom at /Users/me/secret/file.ts")))` with a running session; the `provider.turn.interrupt.failed` activity `payload.detail` equals `GENERIC_INTERNAL_ERROR_DETAIL`. A second case with `Effect.fail(new ProviderValidationError({ operation: "ProviderService.interruptTurn", issue: "bad" }))` gives a detail equal to the error `message` and not matching `/\n\s+at /`. Fails on base (`Cause.pretty` includes `Error: boom` plus `at` frames).
  - `ProviderRuntimeIngestion.test.ts` (reuse `createHarness()` with ingestion started, `harness.runtimeItems()`, `waitForThread`):
    - `closes active approvals when the session is set to interrupted`: dispatch `thread.runtime-item.observe` for `kind: "approval"`, `scope: "turn"`, `runtimeItemId: RuntimeItemId.make("approval-1")`, `sessionId: RuntimeSessionId.make("session-1")`, `turnId`, `providerState: "active"`, `label: "Approve command"`, `observedAt: "2026-01-01T00:03:01.000Z"` (copy the field set from the test at line 634), then `thread.session.set` with `status: "interrupted"`, `activeTurnId: null`, `updatedAt: "2026-01-01T00:04:00.000Z"`. `waitForThread` until an `approval.resolved` activity exists. Assert `harness.runtimeItems()` is `[{ effectiveState: "orphaned", mayStillBeRunning: true }]` and the activity payload has `requestId: "approval-1"` and `synthetic: true`. Fails on base (the item stays `active`).
    - `does not close items observed after the interrupted session update`: same, with `observedAt: "2026-01-01T00:05:00.000Z"`; after `harness.drain()` the item is still `active`.
    - `scrubs absolute paths from runtime.error text`: emit `runtime.error` with `message: "ENOENT: open '/Users/kamogelo/Code/t3code/crash.txt'"` (copy the emit at line 2989); the thread `session.lastError` and the `runtime.error` activity `payload.message` both equal `"ENOENT: open '[path]/crash.txt'"`. Fails on base.
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/provider/userFacingErrorText.test.ts src/provider/Layers/ProviderService.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts src/orchestration/Layers/ProjectionPipeline.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` and `vp run typecheck` from the repo root. Manual (throwaway base dir only): the PV-10 repro. Start an OpenCode turn with a pending Supervised approval, `kill -9` the server, restart on the same base dir. Press Stop on the running thread: it becomes idle with the banner text from `ProviderSessionNotRecoverableError`, no work-log failure row. On the approval thread press Approve once: the card disappears and the thread is idle. `sqlite3 <base>/userdata/state.sqlite "select kind, payload_json from projection_thread_activities where kind like 'provider.%failed'"` shows no `file://` and no `/Users/`.
- Depends on: 2.3 (shares the host-lost wording and the reconcile path; X-7 works without it for threads the user stops manually). Effort: L. Commit message: `fix(provider): settle unrecoverable threads on Stop and approval, expire approvals, and scrub provider error text`

### X-8 OTLP traces proxy: 1 MiB body limit with 413, no body logging, keep browser tracing working (FA-09)

- Problem: `otlpTracesProxyRouteLayer` (`apps/server/src/http.ts` line 90) reads the whole body with `request.json` (line 101) and has no size limit. A 300 MB POST took server RSS from 50 to 831 MB (`rt-d/FINDINGS.md` FA-09). The decode failure handler logs the parsed body: `Effect.logWarning("Failed to decode browser OTLP traces", { cause, bodyJson })` (lines 109-112, and `DecodeOtlpTraceRecordsError` carries `bodyJson`, lines 85-88), which put 5 MB of garbage and a `secret` field into `server.log`. CORS answers `*` for this route (`server.test.ts` line 1147 pins it), so any web page can drive both. The upstream export failure log (lines 127-132) logs the whole `HttpClientError`, which holds the request and so the body.
- Why not just set `HttpServerRequest.MaxBodySize`: in `effect-smol` (`platform-node-shared/src/NodeStream.ts` lines 242-275, used by `request.text`/`request.json`) the limit only fails the read; the `data` listener stays attached and keeps appending to the string, and the cleanup effect only runs on interruption. Memory would still grow for a chunked upload. The card therefore reads the pull-based `request.stream` with its own counter, which applies back-pressure and fails at the limit.
- Files to change:
  - `apps/server/src/http.ts` : imports (lines 4, 9, 10), new constant beside `OTLP_TRACES_PROXY_PATH` (line 31), `DecodeOtlpTraceRecordsError` (line 85), `otlpTracesProxyRouteLayer` (lines 90-142).
  - `apps/web/src/observability/clientTracing.ts` : `OtlpTracer.make` options (lines 91-95).
  - `apps/server/src/server.test.ts` : new tests after the test `stores browser OTLP trace exports locally when no upstream collector is configured` (starts line 1171, ends line 1241); new imports `* as Logger from "effect/Logger";`, `* as References from "effect/References";` and `* as NodeUtil from "node:util";` (add `// @effect-diagnostics nodeBuiltinImport:off` as the first line if the file does not already carry it).
- Change:
  1. `http.ts` constants and errors:

     ```ts
     const OTLP_TRACES_MAX_BODY_BYTES = 1024 * 1024;

     class OtlpTracesBodyTooLargeError extends Data.TaggedError("OtlpTracesBodyTooLargeError")<{
       readonly maxBytes: number;
     }> {}

     class OtlpTracesBodyInvalidError extends Data.TaggedError("OtlpTracesBodyInvalidError")<{}> {}

     class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
       readonly cause: unknown;
     }> {}
     ```

     If the lint rule rejects the empty type literal, use `{ readonly reason: "invalid_json" }` for `OtlpTracesBodyInvalidError`.

  2. Bounded reader (module level, same file). Add `import * as Stream from "effect/Stream";` after the `Path` import (line 9):
     ```ts
     const readBoundedRequestText = (
       request: HttpServerRequest.HttpServerRequest,
       maxBytes: number,
     ) =>
       Effect.gen(function* () {
         const decoder = new TextDecoder();
         let received = 0;
         let text = "";
         yield* Stream.runForEach(request.stream, (chunk) => {
           received += chunk.byteLength;
           if (received > maxBytes) {
             return Effect.fail(new OtlpTracesBodyTooLargeError({ maxBytes }));
           }
           text += decoder.decode(chunk, { stream: true });
           return Effect.void;
         });
         return text + decoder.decode();
       });
     ```
  3. Handler. Keep the auth line first (line 95). Replace line 101 (`const bodyJson = cast<...>(yield* request.json);`) with:
     ```ts
     const declaredLength = Number(request.headers["content-length"]);
     if (Number.isFinite(declaredLength) && declaredLength > OTLP_TRACES_MAX_BODY_BYTES) {
       return payloadTooLargeResponse;
     }
     const bodyText = yield * readBoundedRequestText(request, OTLP_TRACES_MAX_BODY_BYTES);
     const bodyJson =
       yield *
       Effect.try({
         // @effect-diagnostics-next-line preferSchemaOverJson:off
         try: () => (bodyText === "" ? null : JSON.parse(bodyText)),
         catch: () => new OtlpTracesBodyInvalidError({}),
       }).pipe(Effect.map((parsed) => cast<unknown, OtlpTracer.TraceData>(parsed)));
     ```
     with, beside the constants,
     ```ts
     const payloadTooLargeResponse = HttpServerResponse.text("Payload too large.", {
       status: 413,
       headers: { connection: "close" },
     });
     ```
     The `content-length` check answers before reading anything; Node discards the unread request body without buffering it, and `connection: close` ends a huge upload early. The streaming counter covers bodies with no or a false `content-length` (chunked).
  4. Decode failure log, no body (replaces lines 103-114):
     ```ts
     yield *
       Effect.try({
         try: () => decodeOtlpTraceRecords(bodyJson),
         catch: (cause) => new DecodeOtlpTraceRecordsError({ cause }),
       }).pipe(
         Effect.flatMap((records) => browserTraceCollector.record(records)),
         Effect.catch((error) =>
           Effect.logWarning("Failed to decode browser OTLP traces", {
             errorName: error.cause instanceof Error ? error.cause.name : "unknown",
             bodyBytes: bodyText.length,
           }),
         ),
       );
     ```
     Never log `cause` there: a `TypeError` message can echo payload fragments in other runtimes and the cause object is the whole parse context.
  5. Upstream export failure log (lines 127-132): replace `cause,` with `reason: cause.reason._tag, status: cause.response?.status,` so the logged value is a tag and a number. Keep `otlpTracesUrl` as is (a separate finding, FA-10 item 3, covers credentials in that URL).
  6. Error mapping: extend the final `catchTags` (line 138) to
     ```ts
     Effect.catchTags({
       EnvironmentWslBearerInvalidError: HttpServerRespondable.toResponse,
       OtlpTracesBodyTooLargeError: () => Effect.succeed(payloadTooLargeResponse),
       OtlpTracesBodyInvalidError: () => Effect.succeed(HttpServerResponse.text("Invalid JSON.", { status: 400 })),
     }),
     ```
     An `HttpServerError` from the stream (client aborted, parse failure) stays unhandled and keeps the existing default `400`/`500` behaviour. Remove the `cast` import only if no other use remains (it is still used in step 3).
  7. `clientTracing.ts`: add `maxBatchSize: 100` to the `OtlpTracer.make({ ... })` options (after `exportInterval`, line 93). The default is 1000 spans per request (`OtlpTracer.ts` line 86), which with rich RPC span attributes could approach 1 MiB and be rejected with 413 and dropped. A batch of 100 is well under the limit and the 1 second export interval is unchanged. No other web change: the exporter posts JSON to the same path, which is unchanged.

- Do not: set the limit through `MaxBodySize` alone (see above); parse before the size check; return the limit error as `400`; change the route path, CORS, or `wslBearerAuth` order; drop the `204` for a decodable body or for a valid-JSON body that fails to decode (the web exporter treats non-2xx as a failed export); log `bodyText`, `bodyJson` or any prefix of them.
- Tests (`apps/server/src/server.test.ts`, reuse `buildAppUnderTest`, `makeBrowserOtlpPayload`, `HttpClient`, `HttpBody`, and the `Effect.provide(NodeHttpServer.layerTest)` tail of the neighbouring tests; the stub collector with `browserTraceCollector.record` pushing into an array as in the test at line 1176; every new test must fail on the base commit):
  - `rejects an OTLP trace body over 1 MiB with 413 and records nothing`: `POST /api/observability/v1/traces` with `HttpBody.text("x".repeat(1024 * 1024 + 1), "application/json")` and header `content-type: application/json`. Assert `response.status === 413` and the recorded array is empty. Base: `400` (the body is not JSON).
  - `rejects a chunked OTLP trace body over 1 MiB without recording it`: body `HttpBody.stream(Stream.make(new Uint8Array(600_000), new Uint8Array(600_000)), "application/json")` (no length given, so chunked). Use `Effect.exit` around the request and assert the recorded array is empty and that the exit is either a success with status `413` or a transport failure (the server may close the connection while the client is still sending). Base: status `400` after buffering both chunks, so the "413 or failure" assertion fails.
  - `accepts an OTLP trace body just under the limit`: build the valid payload from `makeBrowserOtlpPayload("client.test")`, pad `resourceSpans[0].resource.attributes` with one attribute whose string value makes `JSON.stringify(payload).length` between 1_000_000 and 1_040_000 bytes, post it, assert `204` and one recorded span. Guards against an off-by-one or a limit that is too low.
  - `does not log OTLP request bodies`: capture logs with `const logs: string[] = []; const logger = Logger.make(({ message, fiber }) => { logs.push(NodeUtil.inspect([message, fiber.getRef(References.CurrentLogAnnotations)], { depth: 6 })); });` (same pattern as `serverRuntimeState.test.ts` lines 64-94) and provide it with `Effect.provide(Layer.merge(NodeHttpServer.layerTest, Logger.layer([logger], { mergeWithExisting: false })))` in place of the plain `NodeHttpServer.layerTest`. Post `{"marker":"LEAKME-body-marker"}` as JSON. Assert `204`, assert first that `logs.some((entry) => entry.includes("Failed to decode browser OTLP traces"))` (positive control: if this is false the logger is not reaching the route fiber, move the `Logger.layer` provision so it wraps `buildAppUnderTest` as well), then assert no entry includes `LEAKME-body-marker`. Base: the entry contains `bodyJson` with the marker.
  - Keep the existing tests at lines 957-1241 (including the preflight test) unchanged; they must still pass (the 1 MiB limit does not touch their small payloads).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/server.test.ts`; `pnpm exec tsgo --noEmit`; from `apps/web`: `pnpm exec tsgo --noEmit`; `vp check` and `vp run typecheck` from the repo root. Manual (throwaway base dir, loopback only): start the server, `head -c 300000000 /dev/zero | curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:<port>/api/observability/v1/traces` prints `413` and `ps -o rss= -p <server pid>` stays near the idle value. The same with `-H 'transfer-encoding: chunked'` ends with `413` or a reset and no RSS growth. Then open the web app for a minute, confirm `logs/server.trace.ndjson` still gains `otlp-span` records from `neokod-web`.
- Depends on: none. Effort: S. Commit message: `fix(server): cap the browser OTLP traces route at 1 MiB and stop logging request bodies`

## Open questions

1. X-6, child environment: should the spawned `opencode serve` environment move from the current prefix scrub to a strict allowlist (`HOME`, `PATH`, `XDG_*`, `OPENCODE_*` config names, provider API key names)? The card keeps the prefix rule so existing provider logins keep working.
2. X-7, rows stored before the change: failure activities and `session.lastError` values already in `state.sqlite` still contain stack frames and absolute paths (FA-10 item 2, PV-10). Options: leave them (new data is clean), or apply `scrubErrorText` in `ThreadErrorBanner` and the work-log renderer as a display-time filter. The card does the first. The second needs `scrubErrorText` moved to `packages/shared` with a subpath export.
3. X-7, paths in provider text: the scrub replaces every absolute path with `[path]/<file name>`, including the project's own paths in provider errors (for example an `ENOENT` for a workspace file). The file name stays, the directory goes. Say if you want paths inside the active workspace root kept.
4. X-7, the interrupted banner: a thread settled this way shows the `ProviderSessionNotRecoverableError` text as a red error banner on an `interrupted` session, the same way card 2.3 shows `HOST_LOST_SESSION_ERROR`. If you prefer a neutral info banner for `interrupted`, that is a separate web change in `ChatView.tsx` line 1308.
5. X-7, binding row: the Stop and approval paths settle the projected session only; the binding stays `running` until the next boot where card 2.3 writes `error` + `orphan_possible`. Should `ProviderService.interruptTurn` also write that binding settlement when it finds a binding without resume state?
6. X-8, rate limiting: FA-09 also asks for a rate limit on the route. The card only adds the size cap and stops body logging. A limiter needs a decision on the key (remote address is meaningless behind a reverse proxy) and is not specified here.
7. X-8, forwarding: a body that is valid JSON but does not decode as OTLP is still forwarded to the configured upstream collector (existing behaviour, unchanged). Should the proxy refuse to forward it?

## Unverified

- Nothing was built or run for X-7 and X-8; no test command was executed. Line numbers were read from the checkout on `main` at a712441fb. I did not re-read cards X-1 to X-6 beyond their headings and style.
- X-7: that `Cause.findErrorOption` and `Schema.is(<TaggedErrorClass>)` narrow as written under the repo's `tsgo` settings (the repo already uses `Schema.is` on tagged errors at `ProviderCommandReactor.ts` line 46 and `Cause.findErrorOption` exists at `.repos/effect-smol/packages/effect/src/Cause.ts` line 935, but no existing code combines them).
- X-7: whether the ingestion `start()` subscription to `orchestrationEngine.streamDomainEvents` (a `forkScoped` stream) is already subscribed by the time `providerSessionReconciler.reconcile` dispatches its `thread.session.set` (`serverRuntimeStartup.ts` lines 348-353). The existing `thread.turn-start-requested` path has the same property. If the event can be missed at boot, call `closeItemsOfSettledSession` from the reconciler's own flow too; the test `closes active approvals when the session is set to interrupted` does not cover boot ordering.
- X-7: the `ProviderService.test.ts` test relies on `upsertSessionBinding` (line 445) storing no resume cursor when the fake adapter omits it, and on `directory.getBinding` returning `resumeCursor` as null or undefined for that row. I read both paths but did not run them.
- X-7: the exact fake-adapter helper names in `ProviderService.test.ts` (`routing.codex`, `asThreadId`, `codexInstanceId`) were copied from the neighbouring tests at lines 935 and 1127; check they are in scope at the insertion point.
- X-8: that `request.stream` on the Node server request releases the socket (destroys or drains the readable) when the stream fails at the limit, and that the test HTTP client in `NodeHttpServer.layerTest` surfaces either a 413 or a transport error for the chunked case. The chunked test is written to accept both. The `content-length` path (the common one) is covered by a deterministic test.
- X-8: whether `OtlpTracer` posts a rejected batch again. If it does, a client that exceeds the limit would loop; `maxBatchSize: 100` is meant to make that unreachable but I did not measure span sizes in a real session.
- X-8: `cause.reason._tag` and `cause.response?.status` on the `HttpClientError` of the upstream export: read from `effect-smol` `HttpClientError.ts` lines 54-96, not type-checked.
