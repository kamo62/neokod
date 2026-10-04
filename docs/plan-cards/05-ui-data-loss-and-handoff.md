# S5 UI data-loss and chat-to-Symphony handoff cards

Base commit da7655bb2, branch fix/symphony-runner-and-config-wip. Sources: plan.md sections 5 (W6) and 11, the files named in each card.

Conventions: test commands run from the package directory with Node 24 on the PATH: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run <relative test file>`. Typecheck is `pnpm exec tsgo --noEmit` in each touched package. Finish each card with `vp check` and `vp run typecheck` from the repo root. Line numbers are at the base commit and shift after earlier cards; search by symbol.

# Part A: UI data loss

### U-01 Rendered Markdown over 1 MB must not save the truncated prefix

- Problem: `FilePreviewPanel.tsx` checks `isMarkdown && renderMarkdown` (line 825) before `file.data.truncated` (line 839), so a truncated Markdown file renders `RenderedMarkdownSurface` and its task toggle (`onTaskListChange`, line 590) writes `contents` (the first 1,048,576 bytes, `PROJECT_READ_FILE_MAX_BYTES` in `apps/server/src/workspace/WorkspaceFileSystem.ts:24`) over the whole file. A second defect hides it: `setProjectFileQueryData` (`projectFilesQueryState.ts:36-47`) stores the optimistic copy with `truncated: false`, so the warning banner (line 809) disappears after the first toggle.
- Files to change:
  - `apps/web/src/components/files/filePreviewMode.ts` : add `decideMarkdownTaskToggle` (new, after `setMarkdownTaskChecked`).
  - `apps/web/src/components/files/FilePreviewPanel.tsx` : `RenderedMarkdownSurface` (line 556), its call site (line 826-833), `useFileSaveCoordinator` (line 247).
  - `apps/web/src/components/files/fileSaveCoordinator.ts` : new option `canWrite`, used in `change` (line 21).
  - `apps/web/src/components/files/FilePreviewPanel.test.ts` and `fileSaveCoordinator.test.ts`.
- Change:
  1. In `filePreviewMode.ts` add the pure decision, no React:

     ```ts
     export type MarkdownTaskToggleDecision =
       | { readonly kind: "blocked_truncated" }
       | { readonly kind: "unchanged" }
       | { readonly kind: "write"; readonly contents: string };

     export function decideMarkdownTaskToggle(input: {
       readonly truncated: boolean;
       readonly currentContents: string;
       readonly markerOffset: number;
       readonly checked: boolean;
     }): MarkdownTaskToggleDecision {
       if (input.truncated) return { kind: "blocked_truncated" };
       const contents = setMarkdownTaskChecked(
         input.currentContents,
         input.markerOffset,
         input.checked,
       );
       return contents === input.currentContents
         ? { kind: "unchanged" }
         : { kind: "write", contents };
     }
     ```

  2. `RenderedMarkdownSurface`: add prop `truncated: boolean`. In `onTaskListChange` call `decideMarkdownTaskToggle({ truncated, currentContents, markerOffset, checked })`; return on `blocked_truncated` and `unchanged`; on `write` do the existing `setProjectFileQueryData` and `saveCoordinator.change(decision.contents)` with `decision.contents`. The call site passes `truncated={file.data.truncated}`. `file.data` is the server read until the first optimistic write, and because toggles are now blocked on a truncated read the optimistic copy never exists for such files, so the flag is reliable.
  3. Disable the checkboxes: `ChatMarkdown.tsx:1345` renders a plain `disabled`, `readOnly` checkbox whenever `onTaskListChange` is absent, so pass `onTaskListChange={truncated ? undefined : handleTaskListChange}` (name the existing inline handler). No change to `ChatMarkdown` is needed.
  4. Show the reason: the existing truncation banner (line 809-813) already shows. Append to its text for Markdown only: ` Task checkboxes are read-only.` Condition: `isMarkdown && renderMarkdown`.
  5. Guard at the save call. `FileSaveCoordinatorOptions` gets `readonly canWrite?: () => boolean`. In `change`, first line: `if (this.options.canWrite?.() === false) return;` so nothing is scheduled and `onPendingChange(true)` is never raised. `useFileSaveCoordinator` takes `writable: boolean`, stores it in a ref (`const writableRef = useRef(writable); writableRef.current = writable;`) and passes `canWrite: () => writableRef.current` (the ref keeps the memoised coordinator from being rebuilt). `RenderedMarkdownSurface` passes `writable: !truncated`; `EditableFileSurface` passes `true`.

- Do not: rely only on the disabled checkbox; read `truncated` from `getOptimisticProjectFileQueryData` (it is always false); change `setProjectFileQueryData` to copy `truncated` (a truncated optimistic write is never valid); touch the server read limit.
- Tests:
  - `FilePreviewPanel.test.ts`, new `describe("decideMarkdownTaskToggle")`: (a) `truncated: true`, 1,120,066-character-style fixture is unnecessary, use `currentContents: "- [ ] A\n"`, `markerOffset: 2`, returns `{ kind: "blocked_truncated" }`; (b) `truncated: false` same input returns `{ kind: "write", contents: "- [x] A\n" }`; (c) stale offset 0 with `truncated: false` returns `{ kind: "unchanged" }`; (d) a 1,120,066 character string built with `"- [ ] A\n" + "x".repeat(1_120_000)` with `truncated: true` returns `blocked_truncated` and never a `write`.
  - `fileSaveCoordinator.test.ts`: `ignores edits when canWrite is false`: build the coordinator with `canWrite: () => false`, call `change("x")`, advance timers 500 ms, expect `persist` not called and `onPendingChange` not called.
  - Both fail on the base commit (`decideMarkdownTaskToggle` and `canWrite` do not exist; with the old code `persist` is called).
  - A `*.browser.tsx` test is not recommended here: `RenderedMarkdownSurface` needs `appAtomRegistry`, `ChatMarkdown` providers and a thread ref, which `src/test/browser/render.tsx` (`renderBrowserHarness`) does not supply. The pure function plus the coordinator test cover the guard.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/files/FilePreviewPanel.test.ts src/components/files/fileSaveCoordinator.test.ts`; `pnpm exec tsgo --noEmit`. Manual: open a Markdown file above 1 MB containing `- [ ]`, switch to rendered view; the checkbox is disabled and the file on disk keeps its size.
- Depends on: none. Effort: S. Commit message: `fix(web): never save a truncated Markdown preview over the full file`

### U-02 Closing a saved file must not rewrite the old buffer (client)

- Problem: `FileSaveCoordinator.dispose` (`fileSaveCoordinator.ts:28-32`) runs `if (this.latestRevision > 0) void this.persistLatest();`. `latestRevision` only ever grows, so after any successful save a later dispose writes the same old buffer again, overwriting whatever an agent or editor wrote to disk since. There is no record of which revision the server confirmed.
- Files to change:
  - `apps/web/src/components/files/fileSaveCoordinator.ts` : fields (line 12-18), `dispose` (line 28), `persistLatest` (line 51).
  - `apps/web/src/components/files/fileSaveCoordinator.test.ts`.
- Change:
  1. Add `private confirmedRevision = 0;`. Add a getter `get hasUnsavedEdits(): boolean { return this.latestRevision > this.confirmedRevision; }`.
  2. In `persistLatest`: change the early return to `if (this.saving || !this.hasUnsavedEdits) return;`. After a successful persist set `this.confirmedRevision = Math.max(this.confirmedRevision, revision);` immediately before `this.options.onConfirmed(contents)`.
  3. `dispose`: `this.disposed = true; this.clearTimer(); if (this.hasUnsavedEdits) void this.persistLatest();`.
  4. The tail of `persistLatest` (`if (revision === this.latestRevision)`) stays; it already handles edits made during a write. A failed write leaves `confirmedRevision` unchanged, so a failed save is still flushed on dispose (that is an unsaved edit).
  5. If a write is in flight when `dispose` runs, `persistLatest` returns early (`saving`), and the in-flight call's tail already re-persists when `disposed` and the revision moved. Leave that.
- Do not: reset `latestRevision`; flush on dispose when the last write failed twice in a row without telling the user (U-02b surfaces conflicts); change the debounce.
- Tests, in `fileSaveCoordinator.test.ts` (reuse `deferred` and the `persist` mock pattern):
  - `does not rewrite a saved buffer on dispose`: `change("a")`, advance 500 ms, expect `persist` called once, `dispose()`, `await vi.runAllTimersAsync()`, expect `persist` still called once. Fails on base (called twice).
  - `flushes an unsaved edit on dispose`: `change("a")`, `dispose()` before the debounce, expect `persist` called once with `"a"`.
  - `flushes again on dispose after a failed save`: first `persist` returns `AsyncResult.failure(Cause.fail(new Error("x")))`, then `dispose()`; expect `persist` called twice.
  - `flushes only the edit made after the last confirmed save`: `change("a")`, advance 500 ms (confirmed), `change("b")`, `dispose()`; expect calls `["a", "b"]`.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/files/fileSaveCoordinator.test.ts`; `pnpm exec tsgo --noEmit`.
- Depends on: U-01 (same file, adds `canWrite`). Effort: S. Commit message: `fix(web): flush only unsaved edits when a file editor closes`

### U-02b Conditional file write with a content hash, conflict state in the editor

- Problem: `projects.writeFile` writes unconditionally (`WorkspaceFileSystem.ts:writeFile`, `fileSystem.writeFileString(target.absolutePath, input.contents)`) and `ProjectWriteFileInput` (`packages/contracts/src/project.ts:190-195`) has no precondition, so any stale client buffer overwrites newer disk content. `ProjectReadFileResult` (line 126-131) carries no version.
- Files to change:
  - `packages/contracts/src/project.ts` : `ProjectReadFileResult`, `ProjectFileFailure` (line 133), `ProjectWriteFileInput`, `ProjectWriteFileResult`.
  - `apps/server/src/workspace/WorkspaceFileSystem.ts` : new error class, `readFile` return (line 200-205), `writeFile` (line 222), imports.
  - `apps/server/src/ws.ts` : `projectFileFailureContext` (line 244) new case.
  - `apps/server/src/workspace/WorkspaceFileSystem.test.ts` : update the two exact-match assertions and add tests.
  - `apps/web/src/components/files/fileSaveCoordinator.ts`, `FilePreviewPanel.tsx` (`useFileSaveCoordinator` line 247, banner area line 809), `projectFilesQueryState.ts` (`confirmProjectFileQueryData`).
- Change:
  1. Contracts (additive, optional, so older callers and PlanSidebar and ProposedPlanCard writes keep working):
     ```ts
     // ProjectReadFileResult
     contentHash: Schema.optional(Schema.String),   // sha256 hex of the full file bytes; absent when truncated
     // ProjectWriteFileInput
     expectedHash: Schema.optional(Schema.String),   // when present the write is refused if the disk hash differs
     // ProjectWriteFileResult
     contentHash: Schema.optional(Schema.String),   // sha256 hex of the bytes just written
     // ProjectFileFailure: add the literal
     "file_changed_on_disk",
     ```
  2. Server: add `WorkspaceFileChangedOnDiskError` (`Schema.TaggedErrorClass`, fields `workspaceRoot, relativePath, resolvedPath`, `get message()` returning `Workspace file '<relativePath>' changed on disk since it was read.`) and include it in the `WorkspaceFileSystemError` union. Add a local `const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");` with `import { createHash } from "node:crypto";` (the file already carries `// @effect-diagnostics nodeBuiltinImport:off`).
  3. `readFile`: after `fileBytes` is computed, return `contentHash: stat.size > PROJECT_READ_FILE_MAX_BYTES ? undefined : sha256Hex(fileBytes)`. Spread conditionally so the key is absent, not `undefined`: `...(truncated ? {} : { contentHash })`.
  4. `writeFile`: when `input.expectedHash !== undefined`, before `makeDirectory` read the current bytes with `fileSystem.readFile(target.absolutePath)` and compare: on a read failure treat as "file is gone" and fail with `WorkspaceFileChangedOnDiskError`; if `sha256Hex(current) !== input.expectedHash` fail with the same error. Encode the contents once: `const bytes = new TextEncoder().encode(input.contents)`; write with `fileSystem.writeFile(target.absolutePath, bytes)` (keep the same `write-file` error mapping) and return `{ relativePath, contentHash: sha256Hex(bytes) }`. The compare then write is two steps; the window is milliseconds and the failure mode is the same as today, so document that in a one-line comment and do not add a lock.
  5. `ws.ts` `projectFileFailureContext`: `case "WorkspaceFileChangedOnDiskError": return { failure: "file_changed_on_disk", resolvedPath: error.resolvedPath };` (the `default` branch calls `unexpectedCompatibilityError`, so TypeScript will force this case).
  6. Coordinator: new option `readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>` stays; add `readonly onConflict?: () => void` and `readonly isConflict?: (result: AtomCommandResult<A, E>) => boolean`. After a failed persist, if `isConflict?.(result)` then set `this.conflicted = true`, call `onConflict`, keep pending, and stop scheduling (`change` still records revisions but `schedule` is skipped while `conflicted`; `dispose` does not flush while `conflicted`). Add `resolveConflict(): void` which clears the flag; the caller then either reloads or retries with a fresh hash.
  7. `useFileSaveCoordinator`: keep `const hashRef = useRef<string | undefined>(initialHash)` where `initialHash` is `file.data.contentHash` passed down from the panel as a new prop `contentHash`. `persist` sends `expectedHash: hashRef.current` and on success stores `result.value.contentHash` into `hashRef.current`. Detect the conflict with a helper `isFileChangedOnDisk(result)` that squashes the failure (see `squashAtomCommandFailure` used in `FilePreviewPanel.tsx:675`) and checks `error instanceof ProjectWriteFileError && error.failure === "file_changed_on_disk"`; put the helper in `fileSaveCoordinator.ts` so it can be tested.
  8. Conflict UI, in `FilePreviewPanel`: state `const [conflictPath, setConflictPath] = useState<string | null>(null)`, set by `onConflict`. When `conflictPath === relativePath` render, under the truncation banner, a banner with the same classes: `This file changed on disk. Your edits are not saved.` and two buttons `Reload from disk` and `Overwrite`. Reload: `clearProjectFileQueryData(...)`, `file.refresh()`, clear the conflict, remount the editor by adding a counter to the `EditableFileSurface` `key`. Overwrite: set `hashRef.current = undefined`, call `coordinator.resolveConflict()` then `coordinator.change(latestContents)` so the write goes unconditional. Pass the hash and handlers through `EditableFileSurfaceProps`; mirror `onPendingChange`.
  9. `confirmProjectFileQueryData` already refreshes the read query after a confirmed write; no change except that the refreshed read now carries the new `contentHash`.
- Do not: make `expectedHash` required; hash a truncated read; compare by mtime (clock skew, coarse granularity on some filesystems); add the conflict UI to `PlanSidebar` or `ProposedPlanCard` writes (they create new files and send no hash).
- Tests:
  - `WorkspaceFileSystem.test.ts`: update `reads UTF-8 files...` to `expect(result).toEqual({ ..., contentHash: createHash("sha256").update("export const answer = 42;\n").digest("hex") })` and `writes files relative to the workspace root` to include `contentHash`. New tests inside `describe("writeFile")`: `writes when expectedHash matches the disk` (write `a`, read to get the hash, write `b` with that hash, expect saved `b`); `refuses when the disk changed` (read hash, then `writeTextFile(cwd, "f.txt", "external")`, write with the old hash, `Effect.flip`, expect `error._tag === "WorkspaceFileChangedOnDiskError"` and the file still reads `external`); `refuses when the file was deleted`; `writes unconditionally without expectedHash`. Layer and helpers are already in the file (`makeTempDir`, `writeTextFile`).
  - `fileSaveCoordinator.test.ts`: `stops saving and reports a conflict`: `persist` returns a failure that `isConflict` accepts; expect `onConflict` called once, no second `persist` call after advancing timers, `onPendingChange` never `false`; then `resolveConflict()` and `change("c")` persists again.
  - `packages/contracts/src/project.test.ts`: extend the `ProjectWriteFileError` decode test with `failure: "file_changed_on_disk"`.
  - Server tests fail on base (no `contentHash`, no conflict).
- Verify: from `apps/server`: `pnpm exec vp test run src/workspace/WorkspaceFileSystem.test.ts`; from `packages/contracts`: `pnpm exec vp test run src/project.test.ts`; typecheck `packages/contracts`, `apps/server`, `apps/web`. Manual: open a file, edit it in another editor, type in Neokod; the conflict banner appears and the external edit survives.
- Depends on: U-02. Effort: M. Commit message: `feat(files): refuse a file write when the disk changed since it was read`

### U-03 Diff panel: allow registered project roots in the review service, remove the server-cwd fallback

- Problem: `ReviewService.assertWorkspaceBoundCwd` (`apps/server/src/review/ReviewService.ts:58-79`) only accepts a cwd inside `config.cwd` (the directory the server was launched in) or `config.worktreesDir`. For a project registered elsewhere the request fails with "must stay within the configured workspace root", and `DiffPanel.tsx:327-345` reacts by asking again with `cwd: serverConfig.cwd` (`shouldRetryBranchDiffAtEnvironmentCwd`, `fallbackBranchDiffPreview`), so the panel shows the Neokod checkout's own diff under the selected project's name. `activeCwd` is `activeThread?.worktreePath ?? activeProject?.workspaceRoot` (`DiffPanel.tsx:216`).
- Decision and security reasoning: keep the containment check and widen it to the roots the owner has registered, and remove the client fallback. Removing the check would let any authenticated client run `git diff` in any path the server user can read (the file RPCs already accept an arbitrary `cwd`, but they confine the relative path; the review RPC returns whole repository diffs, which is a larger read). Only returning an error would leave every project outside the launch directory without a Diff panel. The allowed roots become: `config.cwd`, `config.worktreesDir`, the `workspaceRoot` of every non-deleted project in `ProjectionProjectRepository`, and the `worktreePath` of every non-deleted thread of those projects (`ProjectionThreadRepository.listByProjectId`). Those are the only paths the UI ever sends as `activeCwd`. The fallback is removed because showing another repository's diff as if it were the selected one is a wrong-result bug whatever the server decides.
- Files to change:
  - `apps/server/src/review/ReviewService.ts` : `make` (line 27), `assertWorkspaceBoundCwd` (line 58), imports.
  - `apps/server/src/server.ts` : `ReviewLayerLive` (line 226).
  - `apps/web/src/components/DiffPanel.tsx` : lines 327-347, `serverConfig` use (line 217).
  - `apps/server/src/review/ReviewService.test.ts`.
- Change:
  1. In `make`, add `const projects = yield* ProjectionProjectRepository; const threads = yield* ProjectionThreadRepository;` (import from `../persistence/Services/ProjectionProjects.ts` and `ProjectionThreads.ts`). Add a helper:
     ```ts
     const registeredRoots = (cwd: string) =>
       Effect.gen(function* () {
         const rows = yield* projects.listAll();
         const live = rows.filter((project) => project.deletedAt === null);
         const worktrees = yield* Effect.forEach(live, (project) =>
           threads.listByProjectId({ projectId: project.projectId }),
         );
         return [
           ...live.map((project) => project.workspaceRoot),
           ...worktrees
             .flat()
             .filter((thread) => thread.deletedAt === null && thread.worktreePath !== null)
             .map((thread) => thread.worktreePath as string),
         ];
       }).pipe(
         Effect.mapError(
           (cause) =>
             new VcsRepositoryDetectionError({
               operation: "ReviewService.assertWorkspaceBoundCwd.registeredRoots",
               cwd,
               detail: "Failed to read registered project roots.",
               cause,
             }),
         ),
       );
     ```
     (`VcsRepositoryDetectionError` has `operation`, `cwd`, `detail`, optional `cause`, `packages/contracts/src/vcs.ts:242`.)
  2. `assertWorkspaceBoundCwd`: canonicalise `config.cwd`, `config.worktreesDir` and each registered root with the existing `canonicalizePath` (`Effect.forEach(..., { concurrency: 1 })`; a registered root that no longer exists is already tolerated by the `NotFound` branch). Accept when `isWithinRoot(candidate, root)` for any of them.
  3. Change the rejection detail to `Review diff preview cwd must be inside the server workspace, a registered project or one of its worktrees.` The `detail` is what the web panel prints at `DiffPanel.tsx:766`.
  4. `server.ts` `ReviewLayerLive`: add `Layer.provide(ProjectionProjectRepositoryLive)` and `Layer.provide(ProjectionThreadRepositoryLive)` (import both from `./persistence/Layers/...`), the same way `orchestration/Layers/ProjectionPipeline.ts:1754` provides them. The `SqlClient` requirement flows to the outer chain, which already contains `PersistenceLayerLive`; run `pnpm exec tsgo --noEmit` in `apps/server` and fix any unsatisfied requirement by providing it where `ReviewLayerLive` is merged (`VcsLayerLive`, line 231).
  5. `DiffPanel.tsx`: delete `shouldRetryBranchDiffAtEnvironmentCwd`, `fallbackBranchDiffPreview` and the ternary; `const branchDiffPreview = primaryBranchDiffPreview;` (or rename the query to `branchDiffPreview` directly). Keep the `serverConfig` atom at line 217, it still supplies `availableEditors`.
- Do not: keep any client-side retry with another cwd; accept a cwd by string prefix (use the existing canonicalised `path.relative` check, `..` and symlinks matter); read the project list from the client request; broaden `ProjectionProjectRepository.listAll` (it already includes deleted rows, filter `deletedAt`).
- Tests, in `ReviewService.test.ts` (extend `makeLayer` at line 11 to take an optional `projects: ReadonlyArray<{ workspaceRoot: string; threadWorktrees?: string[] }>` and provide `ProjectionProjectRepositoryLive` and `ProjectionThreadRepositoryLive` over `SqlitePersistenceMemory`, as in `persistence/Layers/ProjectionRepositories.test.ts:15-20`; seed rows with `upsert`):
  - `allows a registered project root outside the server workspace`: server workspace A, registered project root B (separate temp dirs), `getDiffPreview({ cwd: B })` succeeds and `detectCalls` equals `[{ cwd: B }]`.
  - `rejects a path that is not registered`: A is the server workspace, B registered, C unregistered; `getDiffPreview({ cwd: C })` fails with `VcsRepositoryDetectionError` and `detectCalls` is empty.
  - `rejects a deleted project root`: B upserted with `deletedAt` set.
  - `allows a thread worktree outside the worktrees directory`: project B with a thread whose `worktreePath` is D.
  - `does not accept a sibling directory with the same prefix`: registered root `/tmp/x/app`, cwd `/tmp/x/app-evil` (use real temp dirs named `app` and `app-evil`).
  - Update the existing rejection test's regex (line 56) to the new detail text. The first and second new tests fail on the base commit (B is rejected).
  - Two-repository fixture for the end-to-end check: create two git repos in temp dirs with `git init` and different files; with the real `GitVcsDriver` layer (see `vcs/GitVcsDriverCore.test.ts:359` for how it is built) assert that `getDiffPreview({ cwd: B })` returns B's file and not A's. If building the real driver layer in this file is heavy, keep the mocked registry and assert the `cwd` passed to `detect`.
- Verify: from `apps/server`: `pnpm exec vp test run src/review/ReviewService.test.ts`; `pnpm exec tsgo --noEmit` in `apps/server` and `apps/web`; `git grep -n "shouldRetryBranchDiff" apps` returns nothing. Manual: start the server from the Neokod checkout, add a project elsewhere, open its Diff panel; it shows that project's changes.
- Depends on: none. Effort: M. Commit message: `fix(review): allow registered project roots for diff previews and drop the server-cwd fallback`

### U-04 Environment variable rows: unchecking Sensitive or renaming a stored secret must not delete it

- Problem: a stored secret is shown to the client as `{ name, value: "", sensitive: true, valueRedacted: true }` (`apps/server/src/serverSettings.ts:redactProviderEnvironmentVariable`, line 159). In `ProviderInstanceCard.tsx` the Sensitive checkbox handler (lines 288-300) publishes `{ sensitive: false, valueRedacted: false, value: "" }`; on save `persistProviderEnvironmentSecrets` (`serverSettings.ts:652`) takes the non-sensitive branch, calls `secretStore.remove(secretName)` and keeps the empty value. Renaming has the same effect: the secret key is `providerEnvironmentSecretName({ instanceId, name })` (line 95), so a renamed redacted row looks up a key that has no secret, and the stale-secret sweep (lines 730-745) removes the old one. The client has no copy of the secret, so it cannot carry the value across.
- Decision: require a replacement value. Server-side conversion would need to hand a stored secret back as plain text in `settings.json` and would need a rename identity on the wire; neither is needed to stop the data loss. While a row has lost its stored secret and has no new value, the section does not publish anything, the same mechanism the section already uses for an invalid variable name (`publishRows`, line 168).
- Files to change:
  - `apps/web/src/components/settings/providerEnvironmentDraft.ts` (new): the pure row logic.
  - `apps/web/src/components/settings/ProviderInstanceCard.tsx` : `EnvironmentDraftRow` and `makeEnvironmentDraftRow` (lines 66-86, move out), `ProviderEnvironmentSection` (line 163-325): `publishRows`, `updateVariable`, the value cell and the Sensitive checkbox.
  - `apps/web/src/components/settings/providerEnvironmentDraft.test.ts` (new).
- Change:
  1. New `providerEnvironmentDraft.ts` exporting:
     ```ts
     export type EnvironmentDraftRow = {
       readonly id: string;
       readonly name: string;
       readonly value: string;
       readonly sensitive: boolean;
       readonly valueRedacted?: boolean;
       /** Present when the row was loaded with a stored secret; holds the key it is stored under. */
       readonly stored?: { readonly name: string };
     };
     export function makeEnvironmentDraftRow(
       variable: ProviderInstanceEnvironmentVariable,
       index: number,
     ): EnvironmentDraftRow;
     export function applyEnvironmentRowPatch(
       row: EnvironmentDraftRow,
       patch: Partial<Omit<EnvironmentDraftRow, "id" | "stored">>,
     ): EnvironmentDraftRow;
     export function environmentRowNeedsValue(row: EnvironmentDraftRow): boolean;
     export function publishableEnvironment(
       rows: ReadonlyArray<EnvironmentDraftRow>,
     ): ReadonlyArray<ProviderInstanceEnvironmentVariable> | null;
     ```
  2. `makeEnvironmentDraftRow`: identical to today, plus `...(variable.sensitive && variable.valueRedacted === true ? { stored: { name: variable.name } } : {})`.
  3. `applyEnvironmentRowPatch`: `const merged = { ...row, ...patch };` then if `patch.value !== undefined` set `valueRedacted: false` (today's behaviour at line 198); otherwise if `row.stored !== undefined` set `valueRedacted` to `merged.value === "" && merged.sensitive && merged.name.trim() === row.stored.name` (so reverting the name and the checkbox restores the link to the stored secret, and any change that detaches it clears the flag). Rows without `stored` keep the current logic: `patch.sensitive` handling stays as in the checkbox handler (`sensitive: false` forces `valueRedacted: false`).
  4. `environmentRowNeedsValue(row)`: `row.stored !== undefined && row.value === "" && (!row.sensitive || row.name.trim() !== row.stored.name)`.
  5. `publishableEnvironment(rows)`: move the body of `publishRows` (lines 168-189) here. Return `null` (do not publish) when any row `environmentRowNeedsValue`, or for the existing invalid-name case; otherwise return the array built exactly as today (`const { id: _id, stored: _stored, ...rest } = row; published.push({ ...rest, name })`). `stored` must not reach the server.
  6. `ProviderEnvironmentSection`: `publishRows` becomes `const published = publishableEnvironment(nextRows); if (published !== null) props.onChange(published);`. `updateVariable` uses `applyEnvironmentRowPatch`. The Sensitive checkbox handler (line 288) passes only `{ sensitive }` (drop the hand-written `valueRedacted` spread, the helper owns it).
  7. UI for a row where `environmentRowNeedsValue(variable)`: value `DraftInput` gets `aria-invalid` and placeholder `Enter the value for this variable`; the value cell shows beneath it `<p className="mt-1 text-[11px] text-warning-foreground">The stored secret is kept only under the original name and as sensitive. Enter a new value to continue, or restore the name and the Sensitive checkbox.</p>`; the section footer text (line 316) is unchanged. While any row needs a value show once, above the table, `Changes are not saved until every highlighted row has a value.`
- Do not: send `valueRedacted: false` for a row the user did not detach; change server behaviour in this card; show or echo any secret; touch the Add button logic (new rows have no `stored`).
- Tests, `providerEnvironmentDraft.test.ts` (plain vitest, `import { describe, expect, it } from "vite-plus/test"`):
  - `unchecking Sensitive on a stored secret blocks publishing`: `rows = [makeEnvironmentDraftRow({ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }, 0)]`; `const next = [applyEnvironmentRowPatch(rows[0], { sensitive: false })]`; expect `environmentRowNeedsValue(next[0])` true and `publishableEnvironment(next)` null. Fails on base (the old code publishes an empty plain value).
  - `renaming a stored secret blocks publishing`: patch `{ name: "OTHER_KEY" }`, same expectations.
  - `a replacement value unblocks and drops the link`: patch `{ sensitive: false }` then `{ value: "plain" }`; `publishableEnvironment` returns `[{ name: "API_KEY", value: "plain", sensitive: false, valueRedacted: false }]` and the result has no `stored` key.
  - `restoring name and Sensitive re-links the secret`: patch name to `OTHER_KEY` then back to `API_KEY`; `valueRedacted` is true again and `publishableEnvironment` returns the original redacted variable.
  - `typing a new secret value on an untouched stored row replaces it`: patch `{ value: "new" }`; published `{ name, value: "new", sensitive: true, valueRedacted: false }`.
  - `a new empty sensitive row is published as today`: `makeEnvironmentDraftRow({ name: "", value: "", sensitive: true }, 0)` alone gives `publishableEnvironment(...)` equal to `[]` (existing blank-row rule, lines 173-186).
  - Optionally extend `apps/server/src/serverSettings.test.ts` with a case documenting that a non-sensitive variable with an empty value removes the secret (existing behaviour), so a later server guard has a baseline.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/settings/providerEnvironmentDraft.test.ts src/components/settings/ProviderInstanceCard.test.ts`; `pnpm exec tsgo --noEmit`. Manual: store a sensitive variable, uncheck Sensitive; nothing is saved and the row asks for a value; reload the page and the secret still shows as stored.
- Depends on: none. Effort: M. Commit message: `fix(web): keep a stored provider secret until a replacement value is entered`

### S-01 Symphony settings list fields: buffer the text, parse on blur

- Problem: `SymphonyProjectConfigurationForm.tsx` binds each list field to `value.xxx.join(", ")` and calls `update({ xxx: splitList(event.target.value) })` on every keystroke (Required labels line 527-530, Active states 538, Terminal states 546-548, Validation commands 558). `splitList` (line 175-179) trims and drops empty parts, so a typed space or newline is removed before the next render: typing `npm test` yields `npmtest`, a second validation line cannot be started, and a comma disappears. `splitList` also splits on commas, so a validation command such as `pnpm test -- --reporter=a,b` is cut in two.
- Files to change:
  - `apps/web/src/hooks/useCommitOnBlur.ts` : make the element type generic and make Enter-commits optional.
  - `apps/web/src/components/ui/draft-input.tsx` : add `DraftTextarea`.
  - `apps/web/src/components/symphony/SymphonyProjectConfigurationForm.tsx` : replace `splitList` (line 175) with two exported parsers; use `DraftInput` and `DraftTextarea` in the four fields.
  - `apps/web/src/components/symphony/SymphonyProjectConfigurationForm.test.ts`.
- Change:
  1. `useCommitOnBlur`: signature `useCommitOnBlur<E extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement>(value: string, onCommit: (next: string) => void, options: { readonly commitOnEnter?: boolean } = {})`. `onChange` takes `ChangeEvent<E>`, `onKeyDown` takes `KeyboardEvent<E>`; the Enter branch runs only when `options.commitOnEnter !== false`. Default behaviour for `DraftInput` is unchanged.
  2. `draft-input.tsx`:
     ```tsx
     export type DraftTextareaProps = Omit<
       React.ComponentProps<typeof Textarea>,
       "value" | "onChange" | "defaultValue"
     > & {
       readonly value: string;
       readonly onCommit: (next: string) => void;
     };
     export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
       const bag = useCommitOnBlur<HTMLTextAreaElement>(value, onCommit, { commitOnEnter: false });
       return <Textarea {...rest} {...bag} />;
     }
     ```
     (import `Textarea` from `./textarea`, `type * as React from "react"`). Enter must insert a newline in a textarea, which is why `commitOnEnter` is off.
     2b. Verify `Textarea` forwards `onFocus`, `onBlur`, `onChange` and `onKeyDown` to the inner `<textarea>` (it spreads `props` through `FieldPrimitive.Control`, `components/ui/textarea.tsx:12-40`); if it does not, render a plain `<textarea>` with the existing classes instead.
  3. In the form file export:
     ```ts
     /** Labels and states: one item per comma or newline. */
     export const parseCommaList = (text: string): string[] =>
       text
         .split(/[\n,]/)
         .map((part) => part.trim())
         .filter(Boolean);
     /** Commands: one item per line, commas are part of the command. */
     export const parseLineList = (text: string): string[] =>
       text
         .split("\n")
         .map((part) => part.trim())
         .filter(Boolean);
     ```
     Delete `splitList`.
  4. Fields: Required labels, Active states and Terminal states become `<DraftInput nativeInput value={value.trackerRequiredLabels.join(", ")} onCommit={(text) => update({ trackerRequiredLabels: parseCommaList(text) })} />` (same for the other two). Validation commands becomes `<DraftTextarea className="min-h-24 font-mono text-xs" placeholder="One command per line" value={value.validationRequired.join("\n")} onCommit={(text) => update({ validationRequired: parseLineList(text) })} />`.
  5. Save while editing: the parent Save button blurs the field first (mousedown moves focus), `onBlur` commits through `update`, and React flushes that discrete event update before the click handler runs, so the saved configuration includes the last edit. Do not add a second commit path.
- Do not: parse in `onChange`; keep splitting validation commands on commas; change the number inputs (separate item S-16); touch the `field()` helper for tracker scope, it has no parsing.
- Tests, in `SymphonyProjectConfigurationForm.test.ts` (it uses `@effect/vitest` `describe`/`it`):
  - `parseLineList keeps spaces and commas inside a command`: `parseLineList("npm test\npnpm run a,b\n\n  vp check  ")` equals `["npm test", "pnpm run a,b", "vp check"]`.
  - `parseCommaList splits on commas and newlines`: `parseCommaList("bug, ready\nagent,")` equals `["bug", "ready", "agent"]`.
  - `typing a command in pieces is not parsed until commit`: render-free simulation is not possible, so cover the component with a browser test `SymphonyProjectConfigurationForm.browser.tsx` (pattern: `PullRequestPanel.browser.tsx`, `page.getByRole`, mounting through `render`). Mount the form with a stateful wrapper holding `useState(defaultSymphonyProjectConfiguration(provider))` with one `ServerProvider` fixture (build it from the `ServerProvider` type; copy a minimal object from `apps/web/src/components/chat/ComposerModelTraitsControl.browser.tsx` if one exists there). Open the Advanced `<details>`, `await page.getByPlaceholder("One command per line").fill("npm test")` then press Enter-free blur by clicking another field; expect the wrapper's `validationRequired` to be `["npm test"]` exactly (assert through a `data-testid` echo of `JSON.stringify(value.validationRequired)`). A second case types `npm test\nnpm run lint` and expects two entries. If the browser project cannot run in the owner's environment, keep the two pure tests and note it.
  - Both parser tests fail on the base commit (the functions do not exist); the browser test fails on base because `fill` is re-parsed per keystroke.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/symphony/SymphonyProjectConfigurationForm.test.ts`; `pnpm exec tsgo --noEmit`. Manual: Settings, Advanced, type `npm test` then Enter and `npm run lint` in Validation commands, click away; both lines persist after Save and reload.
- Depends on: none. Effort: S. Commit message: `fix(web): parse Symphony settings list fields on blur instead of every keystroke`

### S-02 Symphony settings form: keep one draft per project with its base revision

- Problem: `SymphonyProjectView.tsx:443-449` renders `<SettingsTab key={project.id + ":" + project.revision} ...>` (a template literal in the source). Starting or pausing the project, a poll that bumps the revision, or any save remounts the tab and `useState(project.configuration ...)` (line 173-175) re-reads the server copy, so unsaved edits vanish. The tab also unmounts on every tab switch (`tab === "settings" && ...`, line 442), which has the same effect. Because the form is always rebuilt from the latest revision, the server's `symphony_project_revision_conflict` (`ws.ts:428`) is practically unreachable and a stale form can never be told apart from a fresh one.
- Files to change:
  - `apps/web/src/components/symphony/projectSettingsDraft.ts` (new): pure draft logic.
  - `apps/web/src/components/symphony/projectSettingsDraftStore.ts` (new): in-memory zustand store.
  - `apps/web/src/components/symphony/SymphonyProjectView.tsx` : `SettingsTab` (line 162-262) and its call site (line 442-449).
  - `apps/web/src/components/symphony/projectSettingsDraft.test.ts` (new).
- Change:
  1. `projectSettingsDraft.ts` (imports `Equal` from `effect/Equal`, the same as `SettingsPanels.tsx:352`):
     ```ts
     export interface ProjectSettingsDraft {
       readonly baseRevision: number; // project.revision when the draft was taken
       readonly serverBase: SymphonyProjectConfiguration | null; // project.configuration at that time
       readonly initial: SymphonyProjectConfiguration; // what the form first showed
       readonly value: SymphonyProjectConfiguration; // what the user has now
     }
     export type DraftSync = "clean" | "dirty" | "changed_elsewhere";
     export function startDraft(
       project: SymphonyProject,
       fallback: SymphonyProjectConfiguration | null,
     ): ProjectSettingsDraft | null; // null when both are null
     export function isDraftDirty(draft: ProjectSettingsDraft): boolean; // !Equal.equals(draft.value, draft.initial)
     export function editDraft(
       draft: ProjectSettingsDraft,
       value: SymphonyProjectConfiguration,
     ): ProjectSettingsDraft; // { ...draft, value }
     export function reconcileDraft(
       draft: ProjectSettingsDraft,
       project: SymphonyProject,
       fallback: SymphonyProjectConfiguration | null,
     ): { draft: ProjectSettingsDraft; sync: DraftSync };
     export function savedDraft(project: SymphonyProject): ProjectSettingsDraft | null; // draft equal to the server copy returned by the save
     ```
     `reconcileDraft` rules, in order: (a) draft not dirty and `project.revision !== draft.baseRevision`: return `{ draft: startDraft(project, fallback) ?? draft, sync: "clean" }` (a clean form follows the server); (b) not dirty and same revision: `{ draft, sync: "clean" }`; (c) dirty and same revision: `{ draft, sync: "dirty" }`; (d) dirty, revision moved, and `Equal.equals(project.configuration, draft.serverBase)` (only status or other non-configuration fields changed, e.g. Start or Pause): `{ draft: { ...draft, baseRevision: project.revision }, sync: "dirty" }`; (e) dirty, revision moved, configuration differs: `{ draft, sync: "changed_elsewhere" }`.
  2. `projectSettingsDraftStore.ts`: `export const useProjectSettingsDraftStore = create<{ drafts: Readonly<Record<string, ProjectSettingsDraft>>; setDraft: (projectId: string, draft: ProjectSettingsDraft) => void; clearDraft: (projectId: string) => void }>(...)`. No `persist` middleware: drafts live for the browser session only.
  3. `SettingsTab` drops its `configuration` state. It reads `const stored = useProjectSettingsDraftStore((s) => s.drafts[project.id])`, then `const { draft, sync } = stored ? reconcileDraft(stored, project, fallbackConfig) : { draft: startDraft(project, fallbackConfig), sync: "clean" as const }` where `fallbackConfig = fallback ? defaultSymphonyProjectConfiguration(fallback) : null`. Compute on render, never write the store during render. `onChange={(value) => setDraft(project.id, editDraft(draft, value))}` (use the reconciled `draft` so a rebase is persisted by the first edit).
  4. Save: `expectedRevision: draft.baseRevision` (not `project.revision`) so a stale draft gets the server's conflict. On success: `setDraft(project.id, savedDraft(result.value))` (`result.value` is the returned `SymphonyProject`, `rpc.ts:788-792`), then `onSaved()`. A failure keeps the existing error text and leaves the draft untouched.
  5. Banner when `sync === "changed_elsewhere"`, above the form, classes copied from the `actionError` paragraph (`SymphonyProjectView.tsx:419`): text `These settings changed elsewhere after you started editing.` with two buttons. `Reload` calls `clearDraft(project.id)` (the form restarts from the server copy, your edits are discarded). `Save my edits` runs `save` with `expectedRevision: project.revision` (explicit overwrite). While `sync === "changed_elsewhere"` the normal Save button is disabled so an overwrite is always the explicit second button.
  6. Remove the `key={...}` prop at line 444. Keep `onSaved={boardQuery.refresh}`.
  7. Dirty marker: in the `Tab` nav (line 424-437) append ` •` to the Settings label when the stored draft for this project is dirty (`isDraftDirty`), so edits are not forgotten when switching tabs.
- Do not: key anything on `project.revision`; write to the zustand store from render or from an effect that runs on every render; persist drafts to localStorage (the configuration is project policy, a stale persisted copy would be worse than none); change the server revision semantics.
- Tests, `projectSettingsDraft.test.ts` (plain vitest), with fixtures `makeProject(revision, configuration)` built from `SymphonyProject` (use `SymphonyProjectId.make`, `ProviderInstanceId.make`, `ProviderDriverKind.make` as in `SymphonyProjectConfigurationForm.test.ts`) and `makeConfiguration(overrides)`:
  - `a clean draft follows the server revision`: draft from revision 1, project at revision 2 with a different configuration; `reconcileDraft` returns the new configuration and `sync: "clean"`.
  - `a dirty draft survives a revision bump that did not change the configuration`: edit the value, project revision 2 with the same configuration; result keeps the edited value, `baseRevision` is 2, `sync: "dirty"`. Fails on base (the form remounts).
  - `a dirty draft is flagged when the configuration changed elsewhere`: project revision 2 with a different configuration; `sync: "changed_elsewhere"` and the edited value is untouched.
  - `savedDraft is clean`: `isDraftDirty(savedDraft(project))` is false and `baseRevision` equals the returned revision.
  - `startDraft uses the fallback when the project has no configuration` and returns null when both are null.
  - Optional browser test is not needed; the logic is pure.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/symphony/projectSettingsDraft.test.ts src/components/symphony/SymphonyProjectConfigurationForm.test.ts`; `pnpm exec tsgo --noEmit`. Manual: edit a field, press Pause then Start, switch to Board and back; the edit is still there. Change settings from a second tab, then Save in the first: the "changed elsewhere" banner appears.
- Depends on: none (touches `SymphonyProjectView.tsx` lines that B-1 to B-4 also edit; rebase by symbol). Effort: M. Commit message: `fix(web): keep a per-project draft of Symphony settings and flag changes made elsewhere`

### U-06 Queued message: keep the queue entry until the send is accepted (verified, holds)

- Verification: holds. `dispatchQueuedMessage` (`ChatView.tsx:4400`) calls `removeQueuedComposerMessage` (line 4403) first, then `onSend` (line 4406). `onSend` returns silently, before it does anything, when `isSendBusy || isConnecting || activeEnvironmentUnavailable || sendInFlightRef.current` (lines 4014-4021). The recovery in `.finally` calls `composerRef.current?.insertTextAtEnd(text)` (line 4416) and ignores the boolean result; `ChatComposer.insertTextAtEnd` (`chat/ChatComposer.tsx:2086-2098`) returns `false` when `isConnecting` or `environmentUnavailable !== null`. So a drain that fires while disconnected removes the entry, sends nothing and restores nothing. A second, related defect: when the send itself fails, `onSend` restores the text into the composer and sets `promptRef.current = promptForSend` (lines 4357-4375), so the `.finally` check `promptRef.current === text` is true again and inserts the text a second time (duplicate text; runtime duplication is inferred from reading and not reproduced). A failed send with a non-empty composer drops the text because the restore condition (line 4349-4356) requires an empty composer.
- Problem: see Verification.
- Files to change:
  - `apps/web/src/components/ChatView.tsx` : `onSend` (line 4009; set the outcome ref at lines 4138, 4343 and 4346), `dispatchQueuedMessage` (line 4400), new refs near line 4397.
  - `apps/web/src/components/ChatView.logic.ts` : two pure helpers.
  - `apps/web/src/components/ChatView.logic.test.ts`.
- Change:
  1. `ChatView.logic.ts`:
     ```ts
     export type SendOutcome = "not_attempted" | "attempted" | "accepted" | "failed";
     export function canDispatchQueuedMessage(input: {
       readonly hasActiveThread: boolean;
       readonly isSendBusy: boolean;
       readonly isConnecting: boolean;
       readonly environmentUnavailable: boolean;
       readonly sendInFlight: boolean;
     }): boolean {
       return (
         input.hasActiveThread &&
         !input.isSendBusy &&
         !input.isConnecting &&
         !input.environmentUnavailable &&
         !input.sendInFlight
       );
     }
     export function settleQueuedDispatch(input: {
       readonly outcome: SendOutcome;
       readonly composerStillHoldsText: boolean;
     }): "remove_entry" | "keep_entry" {
       // The send took the text, or onSend moved it back into the composer: the queue no longer owns it.
       if (input.outcome === "accepted") return "remove_entry";
       if (input.outcome === "failed" && input.composerStillHoldsText) return "remove_entry";
       return "keep_entry";
     }
     ```
     `attempted` that never reached accepted or failed (an exception) keeps the entry.
  2. `ChatView.tsx`: add `const sendOutcomeRef = useRef<SendOutcome>("not_attempted");`. In `onSend`: right after `sendInFlightRef.current = true;` (line 4138) set `sendOutcomeRef.current = "attempted";` where the turn start result is evaluated (line 4337-4343) set `"accepted"` when `startResult._tag !== "Failure"` and set `"failed"` at the top of `if (failure !== null) {` (line 4346) before the restore block. The plan follow-up branch is U-07.
  3. `dispatchQueuedMessage(queuedMessageId, text)` becomes:
     ```ts
     if (
       !canDispatchQueuedMessage({
         hasActiveThread: activeThread !== null && activeThread !== undefined,
         isSendBusy,
         isConnecting,
         environmentUnavailable: Boolean(activeEnvironmentUnavailable),
         sendInFlight: sendInFlightRef.current,
       })
     )
       return;
     dispatchingQueuedMessageRef.current = true;
     sendOutcomeRef.current = "not_attempted";
     promptRef.current = text;
     void onSend(undefined, { bypassQueue: true })
       .catch(() => {})
       .finally(() => {
         dispatchingQueuedMessageRef.current = false;
         const composerStillHoldsText = promptRef.current === text;
         if (
           settleQueuedDispatch({ outcome: sendOutcomeRef.current, composerStillHoldsText }) ===
           "remove_entry"
         ) {
           removeQueuedComposerMessage(composerDraftTarget, queuedMessageId);
         } else if (composerStillHoldsText) {
           promptRef.current = "";
         }
       });
     ```
     The queue entry now stays in the store while the send is in flight and is removed only on `accepted`, or on `failed` when the failure path has put the text back into the composer. The old `insertTextAtEnd` recovery is deleted: `onSend`'s own failure restore already does it, and when `onSend` did nothing the entry was never removed. `steerQueuedMessage` (line 4425) needs no change.
  4. The drain effect (line 4437-4448) already returns while `dispatchingQueuedMessageRef.current` is true, so the entry that is still visible during the send is not dispatched twice.
- Do not: call `removeQueuedComposerMessage` before the send settles; ignore the `boolean` from `insertTextAtEnd` anywhere else; change the persisted queue schema (`composerDraftStore.ts:106`); change what `onSend` does for non-queued sends.
- Tests, `ChatView.logic.test.ts` (add to the existing imports): `canDispatchQueuedMessage` returns false for each of the four blockers and true when all clear (five assertions); `settleQueuedDispatch` returns `keep_entry` for `not_attempted`, `attempted` and `failed` with `composerStillHoldsText: false`, and `remove_entry` for `accepted` and for `failed` with `composerStillHoldsText: true`. They fail on base (the exports do not exist). `ChatView.tsx` has no render harness in the repo (no `ChatView.browser.tsx`), so the wiring is covered by the manual check.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/ChatView.logic.test.ts`; `pnpm exec tsgo --noEmit`. Manual: queue a message while a turn runs, stop the server, let the turn end; the queued message is still in the queue after the environment comes back and then sends once.
- Depends on: none. Effort: S to M. Commit message: `fix(web): keep a queued message queued until its send is accepted`

### U-07 Failed plan follow-up must restore the composer draft (verified, holds)

- Verification: holds. In `onSend`, the plan follow-up branch (`ChatView.tsx:4058-4069`) sets `promptRef.current = ""`, calls `clearComposerDraftContent(composerDraftTarget)` (images, terminal contexts, element contexts, preview annotations, review comments and the prompt) and `resetCursorState()` before `await onSubmitPlanFollowUp(...)`. `onSubmitPlanFollowUp` (line 4627) returns without sending on `!activeThread || !isServerThread || isSendBusy || isConnecting || sendInFlightRef.current`, on an empty trimmed text, and on a missing `sendCtx` (lines 4637-4654), and on a failed `persistThreadSettingsForNextTurn` or `startThreadTurn` (lines 4763-4774) it removes the optimistic message and sets the thread error. None of these paths restores the draft, so the typed text and attachments are gone.
- Problem: see Verification.
- Files to change:
  - `apps/web/src/components/ChatView.tsx` : `onSend` plan branch (line 4058-4069), `onSubmitPlanFollowUp` (line 4627-4776), the existing restore block in `onSend` (line 4357-4375).
  - `apps/web/src/components/ChatView.logic.ts` and `ChatView.logic.test.ts`: one pure helper.
- Change:
  1. `onSubmitPlanFollowUp` returns `Promise<"accepted" | "rejected">`: `"rejected"` at every early `return;` in lines 4637-4654, after the `failure !== null` handling (line 4763-4775, including interrupted), and `"accepted"` at the existing success `return;` (line 4761).
  2. Extract the restore block of `onSend` (lines 4357-4375) into a local function defined above `onSend`:
     ```ts
     interface ComposerDraftSnapshot {
       readonly prompt: string;
       readonly images: ReadonlyArray<ComposerImageAttachment>;
       readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
       readonly elementContexts: ReadonlyArray<ElementContextDraft>;
       readonly previewAnnotations: ReadonlyArray<PreviewAnnotationDraft>;
       readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
     }
     const restoreComposerDraftSnapshot = (snapshot: ComposerDraftSnapshot) => {
       /* the body of the existing block, using snapshot.* */
     };
     ```
     Take the real type names from the `composerImagesSnapshot`, `composerTerminalContextsSnapshot`, `composerElementContextsSnapshot`, `composerPreviewAnnotationsSnapshot` and `composerReviewCommentsSnapshot` declarations at lines 4142-4146 (do not invent names). The existing call site passes the five snapshots plus `promptForSend` and keeps its own empty-composer condition.
  3. `ChatView.logic.ts`: export `isComposerDraftEmpty(input: { prompt: string; imageCount: number; terminalContextCount: number; elementContextCount: number; previewAnnotationCount: number; reviewCommentCount: number }): boolean`, true when the prompt is empty and every count is 0. Use it in both restore sites: build its input from the same refs and draft-store reads as the existing condition at lines 4349-4356 (that condition becomes `isComposerDraftEmpty({...})`).
  4. Plan branch in `onSend`: before clearing, `const draftSnapshot: ComposerDraftSnapshot = { prompt: promptForSend, images: [...composerImages], terminalContexts: [...composerTerminalContexts], elementContexts: [...composerElementContexts], previewAnnotations: [...composerPreviewAnnotations], reviewComments: [...composerReviewComments] };`. After `const outcome = await onSubmitPlanFollowUp(...)`: `if (outcome === "rejected" && <composer is empty, same isComposerDraftEmpty call>) restoreComposerDraftSnapshot(draftSnapshot);`, then `return;` as today.
- Do not: restore when the user already typed something new during the await (the emptiness test protects that); restore on the `accepted` path; clear the draft after the await instead of before it (that delays the visible clear and invites double submission).
- Tests, `ChatView.logic.test.ts`: `isComposerDraftEmpty` is true for all-empty input, and false when each field is non-empty in turn (six cases). Fails on base (export missing). The restore itself has no harness (see U-06); manual check below.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/ChatView.logic.test.ts`; `pnpm exec tsgo --noEmit`. Manual: with a proposed plan showing, stop the server, type a follow-up and send; after the error the text is back in the composer.
- Depends on: U-06 (same function area; rebase by symbol). Effort: S to M. Commit message: `fix(web): restore the composer draft when a plan follow-up is rejected`

### U-11 Sidebar "Copy Path" in All threads copies the first project's root (verified, holds)

- Verification: holds. The All threads panel renders `SidebarThreadsContent` with `project={sidebarProjects[0] ?? null}` (`Sidebar.tsx:4126`) and passes every thread through one `SidebarProjectItem` in flat mode (`flatThreads`, lines 3457 and 3462). `handleThreadContextMenu` (line 2222) looks the thread's project up in `memberProjectByScopedKey`, which is built from that first group's `memberProjects` only (line 1307), and falls back to `project.workspaceRoot` (line 2232: `thread.worktreePath ?? threadProject?.workspaceRoot ?? project.workspaceRoot ?? null`). Any thread without a worktree that belongs to another project copies the first project's path. (The row's own git lookup at line 442 already uses `useProject(scopeProjectRef(...))`, which is the correct source.)
- Problem: see Verification.
- Files to change:
  - `apps/web/src/components/Sidebar.logic.ts` : new `resolveThreadWorkspacePath`.
  - `apps/web/src/components/Sidebar.tsx` : `handleThreadContextMenu` (line 2222-2316), `SidebarProjectItem` (line 1167).
  - `apps/web/src/components/Sidebar.logic.test.ts`.
- Change:
  1. `Sidebar.logic.ts`:
     ```ts
     export function resolveThreadWorkspacePath(input: {
       readonly thread: {
         readonly environmentId: string;
         readonly projectId: string;
         readonly worktreePath: string | null;
       };
       readonly projects: ReadonlyArray<{
         readonly environmentId: string;
         readonly id: string;
         readonly workspaceRoot: string;
       }>;
     }): string | null {
       if (input.thread.worktreePath) return input.thread.worktreePath;
       const owner = input.projects.find(
         (project) =>
           project.environmentId === input.thread.environmentId &&
           project.id === input.thread.projectId,
       );
       return owner?.workspaceRoot ?? null;
     }
     ```
  2. `SidebarProjectItem`: `const allProjects = useProjects();` (already imported at `Sidebar.tsx:91`). In `handleThreadContextMenu` replace lines 2228-2232 with `const threadWorkspacePath = resolveThreadWorkspacePath({ thread, projects: allProjects });` Delete the `memberProjectByScopedKey` and `project.workspaceRoot` entries from the callback's dependency array (lines 2310-2311) and add `allProjects`. The existing `Path unavailable` toast (line 2260-2268) now covers an unknown project. Check that `thread` (`SidebarThreadSummary`) exposes `environmentId`, `projectId`, `worktreePath` (it is used with those names at lines 2226-2232).
  3. Look at the two other uses of `project.workspaceRoot` in flat mode (`projectCwd`, lines 2328 and 2475) and leave them; `gitCwd` at line 443 prefers the thread's own project, so they only matter for threads whose project is missing.
- Do not: keep the `project.workspaceRoot` fallback in `handleThreadContextMenu`; change group mode behaviour (a member project lookup that hits gives the same answer as `allProjects`); fetch projects per click.
- Tests, `Sidebar.logic.test.ts`: `resolveThreadWorkspacePath` (a) returns `worktreePath` when set, (b) with projects A (`env-1`, `/repos/a`) and B (`env-1`, `/repos/b`) and a thread of B without a worktree returns `/repos/b` (fails if it returned the first project), (c) same project id in another environment resolves that environment's root, (d) an unknown project returns `null`.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/Sidebar.logic.test.ts`; `pnpm exec tsgo --noEmit`. Manual: All threads, right-click a thread of the second project, Copy Path; the second project's root is on the clipboard.
- Depends on: none. Effort: S. Commit message: `fix(web): copy a thread's own project path from the All threads list`

# Part B: chat to Symphony handoff (GitHub Issues first, plan W6)

## Design summary

Facts read at the base commit that shape the cards:

- `HandoffService.delegateFromThread` (`HandoffService.ts:490-556`) creates a `source: { kind: "manual" }` work item with `trackerIssueId` of `delegated-` plus the work item id and lifecycle `eligible`, never touches a tracker, and is not called by any web code (`git grep delegateFromThread -- apps packages` only hits contracts and the server). `Live.refreshIssueSnapshot` (`SymphonyOrchestratorLive.ts:215-258`) re-reads any non-empty `trackerIssueId` through the tracker adapter (`gh issue view delegated-wi-...`), gets not-found, and `prepareDispatch` then refuses with no issue. This is the plan's H2: a delegated item can never dispatch.
- The GitHub adapter's canonical dispatch id is the issue number as a string (`GitHubIssuesAdapter.ts:mapRawToNormalized`, `id: String(raw.number)`), and `projectWorkItem` (`Orchestrator/Projection.ts:35-70`) builds the item id `<projectId>:github:<number>`. A handoff that uses the same id and `source` is the same row the poll would create. The poll upsert then keeps updating it, and its `evaluateEligibility` (`Eligibility.ts:30-67`) would flip a handed-off issue that lacks the required labels to the not-eligible lifecycle on the next tick, so explicit requests need an eligibility bypass (H-3).
- Appending to a thread: providers and reactors dispatch `thread.activity.append` through `OrchestrationEngineService.dispatch` with `activity: { id: EventId, tone, kind, summary, payload, turnId: null, createdAt }` (`orchestration/Layers/CheckpointReactor.ts:101-121`). The engine stores a command receipt per `commandId` and returns the first result on a repeat (`OrchestrationEngine.ts:130-143`, `existingReceipt` accepted), so a deterministic command id makes delivery idempotent even if the process dies between the append and the acknowledgement. An activity is not a user message and starts no turn, so it is neither user-looking nor a steer. The web renders unknown activity kinds as a work log row using `summary` (`session-logic.ts:deriveWorkLogEntries`, line 673).
- `NotificationCoordinator` is an in-memory `PubSub` (`NotificationCoordinator.ts:38-44`), so it is only usable as a wake-up hint. Delivery state must be durable.
- `AgentRuntime.runTurn` records no evidence that a turn started: `Dispatcher` writes `streaming_turn` and the run event `agent_started` before calling `runTurn` (`Dispatcher.ts:395-398`), and the Codex `turn/start` response (`AgentRuntime.ts:219-229`) is not persisted. So `running` cannot be told apart from "launch requested" today (H-0).
- Latest migration is `041_SymphonyProjects.ts` (`Migrations.ts:109`, files in `apps/server/src/persistence/Migrations/`). Proposed numbering for this work: 042 is taken by B-4 (`042_SymphonyIneligibleLifecycle`, card S4 B-4), plan item 4.7 (`local_labels_json`) also wants a number, so this card proposes 044 for the request table and requires the order B-4 (042), labels (043 if that card is implemented), then H-1 (044). The migrator skips every id at or below the latest recorded id (`Migrator.ts:285-287`, quoted in card 0.5), so a migration that lands later with a lower number than one already applied would silently never run on an existing database. Therefore H-1 must be merged after B-4 and after the labels card, and must use `max(existing) + 1` at merge time with no gap. If the labels card is dropped, H-1 is 043.

Lifecycle names below assume card B-4 (`ineligible`, delegated items start `queued`) and S1 card 1.5 (`cancelled` and `failed` are written). If they are not merged yet, the cards say what to use instead.

Request state meaning (one row per request, advanced by `deriveHandoffRequestState`, H-4):

| State            | Meaning                                               | Source evidence                                                                                       |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| accepted         | Request committed, work item queued, no attempt yet   | work item `queued`/`ineligible`/`draft`, no attempt                                                   |
| queued           | An attempt existed and the item is waiting again      | `retry_scheduled`, `changes_requested`, or `queued` with an attempt                                   |
| admitted         | Claimed, workspace being prepared, agent not launched | work item `preparing`                                                                                 |
| launch_unknown   | Launch requested, no turn-start evidence              | `running`, `testing` or `waiting_for_approval` and no `turn_started` run event for the latest attempt |
| running          | Positive turn-start evidence                          | same lifecycles and a `turn_started` run event (H-0)                                                  |
| stopped          | User cancelled, or took the run over in Work mode     | `cancelled`, `blocked`                                                                                |
| completed        | A result is ready: review, merged or failed           | `ready_for_review`, `ready_to_merge`, `completed`, `failed`, `validation_failed`                      |
| result_delivered | The result activity was appended to the source thread | delivery acknowledged                                                                                 |

Unknown lifecycle values leave the stored state unchanged (preserve unknown evidence, `docs/architecture/state-and-evidence.md`).

Card order: H-0, H-1, H-3, H-2, H-4, H-5a, H-5b, H-6.

### H-0 Record positive turn-start evidence as a run event

- Problem: the dispatcher sets attempt status `streaming_turn` and appends `agent_started` before `agent.runTurn` runs (`Runner/Dispatcher.ts:395-398`), and `AgentRuntime.runTurn` learns the Codex turn id only from the `turn/start` response (`Runner/AgentRuntime.ts:219-229`) without telling anyone. A handoff cannot honestly report `running` instead of `launch_unknown`.
- Files to change:
  - `apps/server/src/symphony/Runner/AgentRuntime.ts` : `AgentRuntimeService.runTurn` input type (line 56-72), `runTurn` (line 188-245).
  - `apps/server/src/symphony/Runner/Dispatcher.ts` : the three `agent.runTurn` calls (lines 318, 405, 421) and `appendEvent` (line 129).
  - `apps/server/src/symphony/Runner/Dispatcher.test.ts`.
- Change:
  1. `AgentRuntimeService.runTurn` input gets `readonly onTurnStarted?: (started: { readonly threadId: string; readonly turnId: string }) => Effect.Effect<void>;`.
  2. In `runTurn`, immediately after `turnId = (turn as ...).turn.id;` (line 229) add `if (input.onTurnStarted !== undefined) yield* input.onTurnStarted({ threadId, turnId }).pipe(Effect.catch(() => Effect.void));` (`threadId` is already set at that point; if the type checker says it may be undefined, use the local `const startedThreadId = threadId;` captured after the `thread/start` block). A failing hook must never fail the turn.
  3. `Dispatcher`: define next to `appendEvent` (line 129) `const turnStartedHook = (runAttemptId: RunAttemptId, turn: number) => (started: { threadId: string; turnId: string }) => appendEvent(runAttemptId, "turn_started", { turn, threadId: started.threadId, turnId: started.turnId });` and pass `onTurnStarted: turnStartedHook(runAttemptId, 1)` in the prepare-autonomy call (line 318) and the first execute call (line 405), `turnStartedHook(runAttemptId, turn)` in the continuation call (line 421). If S1 card 1.4 changed `runTurn`'s signature or call sites, add the field there instead; the contract is the same.
  4. Do not change `agent_started`; it keeps meaning "launch requested".
- Do not: record `turn_started` from the dispatcher before `runTurn` returns its first notification; fail the attempt if the event append fails (`appendEvent` already swallows errors); add a column.
- Tests, `Dispatcher.test.ts` (reuse the fake agent builders at lines 122-195, the run-event repository from the file's layer): `appends turn_started when the runtime reports a started turn`: a fake agent whose `runTurn: (input) => input.onTurnStarted?.({ threadId: "th1", turnId: "t1" }).pipe(Effect.as({ turnId: "t1", threadId: "th1", completed: true }))`; dispatch a queued work item (use the helper the neighbouring tests use) and assert `runEvents.listForAttempt(attemptId)` contains one event with `eventType === "turn_started"` and `payload.turnId === "t1"`, ordered after `agent_started`. `does not append turn_started when runTurn fails before the turn starts`: the fake agent fails without calling the hook; assert no `turn_started` event. Both fail on base (no hook, no event).
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Runner/Dispatcher.test.ts`; `pnpm exec tsgo --noEmit`.
- Depends on: S1 1.4 (same function; rebase by symbol). Effort: S. Commit message: `feat(symphony): record a turn_started run event when the agent confirms a turn`

### H-1 Delegation request table, migration and repository

- Problem: there is no record of who asked for a work item, from which thread, or whether the answer went back. `HandoffService` writes a work item and forgets the request.
- Files to change:
  - `packages/contracts/src/symphony.ts` : new schemas after `SymphonyDelegateFromThreadResult` (line 1224).
  - `apps/server/src/persistence/Migrations/044_SymphonyDelegationRequests.ts` (new), `apps/server/src/persistence/Migrations.ts` (import after line 56, entry after line 109).
  - `apps/server/src/persistence/Migrations/044_SymphonyDelegationRequests.test.ts` (new).
  - `apps/server/src/symphony/Persistence/Services/DelegationRequestRepository.ts` (new), `apps/server/src/symphony/Persistence/Layers/DelegationRequestRepository.ts` (new), `.../Layers/DelegationRequestRepository.test.ts` (new).
  - `apps/server/src/symphony/Persistence/Errors.ts` : two new errors.
  - `apps/server/src/symphony/Domain/Keys.ts` : export `sha256Hex`.
- Change:
  1. Contracts (schema only):
     ```ts
     export const SymphonyHandoffRequestStateSchema = Schema.Literals([
       "accepted",
       "queued",
       "admitted",
       "launch_unknown",
       "running",
       "stopped",
       "completed",
       "result_delivered",
     ]);
     export const SymphonyHandoffDeliveryStateSchema = Schema.Literals([
       "pending",
       "claimed",
       "delivered",
       "disposed",
     ]);
     export const SymphonyHandoffResultKindSchema = Schema.Literals([
       "ready_for_review",
       "completed",
       "failed",
       "stopped",
     ]);
     export const SymphonyHandoffRequestSchema = Schema.Struct({
       requestKey: TrimmedNonEmptyString,
       sourceEnvironmentId: TrimmedNonEmptyString,
       sourceThreadId: ThreadId,
       sourceMessageId: Schema.NullOr(TrimmedNonEmptyString),
       projectId: SymphonyProjectId,
       trackerKind: TrackerKindSchema,
       trackerScope: TrimmedNonEmptyString,
       trackerIssueId: TrimmedNonEmptyString,
       trackerIssueUrl: Schema.NullOr(Schema.String),
       workItemId: WorkItemId,
       runAttemptId: Schema.NullOr(RunAttemptId),
       state: SymphonyHandoffRequestStateSchema,
       resultKind: Schema.NullOr(SymphonyHandoffResultKindSchema),
       deliveryState: SymphonyHandoffDeliveryStateSchema,
       deliveryAttempts: NonNegativeInt,
       deliveryLastError: Schema.NullOr(Schema.String),
       note: Schema.NullOr(Schema.String),
       createdAt: IsoDateTime,
       updatedAt: IsoDateTime,
       stateChangedAt: IsoDateTime,
       deliveredAt: Schema.NullOr(IsoDateTime),
     });
     ```
     The claim token and claim time are server-only and are not in the wire schema. Use the helper schemas already imported in that file (`TrimmedNonEmptyString`, `NonNegativeInt`, `IsoDateTime`, `ThreadId`).
  2. Migration `044_SymphonyDelegationRequests.ts`, same shape as `039_SymphonyPauseScopes.ts` (`export default Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; ... })`), no foreign keys (the other Symphony tables use none):
     ```sql
     CREATE TABLE IF NOT EXISTS symphony_delegation_requests (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       request_key TEXT NOT NULL UNIQUE,
       payload_hash TEXT NOT NULL,
       source_environment_id TEXT NOT NULL,
       source_thread_id TEXT NOT NULL,
       source_message_id TEXT,
       project_id TEXT NOT NULL,
       tracker_kind TEXT NOT NULL,
       tracker_scope TEXT NOT NULL,
       tracker_issue_id TEXT NOT NULL,
       tracker_issue_url TEXT,
       work_item_id TEXT NOT NULL,
       run_attempt_id TEXT,
       state TEXT NOT NULL,
       result_kind TEXT,
       delivery_state TEXT NOT NULL DEFAULT 'pending',
       delivery_claim_token TEXT,
       delivery_claimed_at TEXT,
       delivery_attempts INTEGER NOT NULL DEFAULT 0,
       delivery_next_attempt_at TEXT,
       delivery_last_error TEXT,
       delivered_at TEXT,
       note TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       state_changed_at TEXT NOT NULL
     )
     ```
     Indexes (each `CREATE INDEX IF NOT EXISTS`): `idx_symphony_delegation_thread ON (source_thread_id, created_at)`, `idx_symphony_delegation_work_item ON (work_item_id)`, `idx_symphony_delegation_delivery ON (delivery_state, delivery_next_attempt_at)`, `idx_symphony_delegation_project ON (project_id, created_at)`, and the one-active-request-per-issue guard: `CREATE UNIQUE INDEX IF NOT EXISTS uq_symphony_delegation_active_issue ON symphony_delegation_requests(project_id, tracker_kind, tracker_issue_id) WHERE state IN ('accepted','queued','admitted','launch_unknown','running')`. Register `[44, "SymphonyDelegationRequests", Migration0044]` (use the real next number, see the numbering paragraph above).
  3. `Domain/Keys.ts`: `export const sha256Hex = (value: string): string => NodeCrypto.createHash("sha256").update(value).digest("hex");` (the module already imports `node:crypto`; keep `hashSuffix` as is).
  4. `Errors.ts`: `DelegationRequestKeyConflict` (`Schema.TaggedErrorClass`, fields `requestKey: Schema.String`, message `Request key <key> was already used for a different request`) and `DelegationIssueAlreadyActive` (fields `projectId: Schema.String`, `trackerIssueId: Schema.String`, `requestKey: Schema.String`, message `Issue <id> already has an active Symphony request (<requestKey>)`). Do not add them to the `SymphonyPersistenceError` union (`Errors.ts:92-97`); the `accept` signature lists them explicitly.
  5. Service `DelegationRequestRepository` (`Context.Service`, id `"neokod/symphony/Persistence/Services/DelegationRequestRepository"`), shape:
     ```ts
     export interface DelegationRequestRow extends SymphonyHandoffRequest {
       readonly id: number;
       readonly payloadHash: string;
       readonly deliveryClaimToken: string | null;
       readonly deliveryNextAttemptAt: string | null;
     }
     export interface DelegationRequestRepositoryShape {
       /** Insert unless the key exists. Replay with the same payload hash returns the stored row with created=false; a different hash fails with DelegationRequestKeyConflict; an active request for the same issue under another key fails with DelegationIssueAlreadyActive. */
       readonly accept: (
         input: AcceptDelegationRequestInput,
       ) => Effect.Effect<
         { readonly request: DelegationRequestRow; readonly created: boolean },
         SymphonyPersistenceError | DelegationRequestKeyConflict | DelegationIssueAlreadyActive
       >;
       readonly getByKey: (
         requestKey: string,
       ) => Effect.Effect<DelegationRequestRow | null, SymphonyPersistenceError>;
       readonly listByThread: (
         threadId: string,
         limit?: number,
       ) => Effect.Effect<ReadonlyArray<DelegationRequestRow>, SymphonyPersistenceError>;
       readonly listByProject: (
         projectId: SymphonyProjectId,
       ) => Effect.Effect<ReadonlyArray<DelegationRequestRow>, SymphonyPersistenceError>;
       readonly latestForWorkItem: (
         workItemId: WorkItemId,
       ) => Effect.Effect<DelegationRequestRow | null, SymphonyPersistenceError>;
       readonly listActiveIssueIds: (
         projectId: SymphonyProjectId,
         trackerKind: string,
       ) => Effect.Effect<ReadonlySet<string>, SymphonyPersistenceError>;
       readonly listUnsettled: () => Effect.Effect<
         ReadonlyArray<DelegationRequestRow>,
         SymphonyPersistenceError
       >; // state in accepted..running, oldest first, limit 500
       /** Conditional state write: only when the stored state is in `from`. Returns whether a row changed. */
       readonly setState: (input: {
         readonly requestKey: string;
         readonly from: ReadonlyArray<SymphonyHandoffRequestState>;
         readonly to: SymphonyHandoffRequestState;
         readonly resultKind?: SymphonyHandoffResultKind;
         readonly runAttemptId?: RunAttemptId;
         readonly now: string;
       }) => Effect.Effect<boolean, SymphonyPersistenceError>;
       readonly claimNextDelivery: (input: {
         readonly now: string;
         readonly token: string;
       }) => Effect.Effect<DelegationRequestRow | null, SymphonyPersistenceError>;
       readonly ackDelivery: (input: {
         readonly requestKey: string;
         readonly token: string;
         readonly now: string;
       }) => Effect.Effect<boolean, SymphonyPersistenceError>;
       readonly releaseDelivery: (input: {
         readonly requestKey: string;
         readonly token: string;
         readonly nextAttemptAt: string;
         readonly error: string;
       }) => Effect.Effect<boolean, SymphonyPersistenceError>;
       readonly disposeDelivery: (input: {
         readonly requestKey: string;
         readonly token: string;
         readonly reason: string;
         readonly now: string;
       }) => Effect.Effect<boolean, SymphonyPersistenceError>;
       readonly requeueClaimedDeliveries: (
         now: string,
       ) => Effect.Effect<number, SymphonyPersistenceError>;
     }
     ```
     `AcceptDelegationRequestInput` carries every insert column except the delivery columns (`requestKey`, `payloadHash`, `sourceEnvironmentId`, `sourceThreadId`, `sourceMessageId`, `projectId`, `trackerKind`, `trackerScope`, `trackerIssueId`, `trackerIssueUrl`, `workItemId`, `note`, `now`).
  6. Layer, following `Layers/WorkItemRepository.ts`: a row schema with `Schema.Struct` of the columns, `SELECT_COLUMNS` with `snake AS "camel"` aliases, `SqlSchema.findOneOption` for single rows, `toSqlError("DelegationRequestRepository.<method>")` from `Errors.ts`, `export const DelegationRequestRepositoryLive = Layer.effect(DelegationRequestRepository, makeRepository);`.
     - `accept`: wrap in `sql.withTransaction`. (1) `SELECT` by `request_key`; if found: same `payload_hash` returns `{ request, created: false }`, different fails `DelegationRequestKeyConflict`. (2) `SELECT` an active row for `(project_id, tracker_kind, tracker_issue_id)` with `state IN (accepted,queued,admitted,launch_unknown,running)`: found fails `DelegationIssueAlreadyActive`. (3) `INSERT ... RETURNING` with `state = 'accepted'`, `delivery_state = 'pending'`, `state_changed_at = now`. Map the `SqlError` of the transaction like `Live.createProject` does (`Effect.catchTag("SqlError", ...)` to `SymphonyPersistenceSqlError`).
     - `setState`: `UPDATE ... SET state = ${to}, result_kind = COALESCE(${resultKind}, result_kind), run_attempt_id = COALESCE(${runAttemptId}, run_attempt_id), state_changed_at = CASE WHEN state = ${to} THEN state_changed_at ELSE ${now} END, updated_at = ${now} WHERE request_key = ${requestKey} AND state IN (${from})`; return `changed rows > 0` (use `RETURNING id` and test the array length, as `claimRow` does).
     - `claimNextDelivery`: one `UPDATE symphony_delegation_requests SET delivery_state = 'claimed', delivery_claim_token = ${token}, delivery_claimed_at = ${now}, delivery_attempts = delivery_attempts + 1, updated_at = ${now} WHERE id = (SELECT id FROM symphony_delegation_requests WHERE delivery_state = 'pending' AND state IN ('completed','stopped') AND (delivery_next_attempt_at IS NULL OR delivery_next_attempt_at <= ${now}) AND source_thread_id NOT IN (SELECT source_thread_id FROM symphony_delegation_requests WHERE delivery_state = 'pending' AND delivery_attempts > 0 AND delivery_next_attempt_at > ${now}) ORDER BY COALESCE(delivery_next_attempt_at, state_changed_at) ASC, id ASC LIMIT 1) RETURNING <columns>`. The `NOT IN` subquery is the per-recipient backoff: a thread with a failing delivery in backoff is skipped as a whole while other threads continue.
     - `ackDelivery`: `UPDATE ... SET delivery_state = 'delivered', state = 'result_delivered', delivered_at = ${now}, delivery_claim_token = NULL, delivery_last_error = NULL, updated_at = ${now} WHERE request_key = ${k} AND delivery_state = 'claimed' AND delivery_claim_token = ${token}`.
     - `releaseDelivery`: back to `pending`, token cleared, `delivery_next_attempt_at = ${nextAttemptAt}`, `delivery_last_error = ${error}`, same token fence.
     - `disposeDelivery`: `delivery_state = 'disposed'`, `delivery_last_error = ${reason}`, token cleared, same fence.
     - `requeueClaimedDeliveries`: `UPDATE ... SET delivery_state = 'pending', delivery_claim_token = NULL, delivery_next_attempt_at = NULL WHERE delivery_state = 'claimed'`, return the count.
- Do not: add a foreign key to `symphony_work_items` (rows are replaced during work item pruning in other code); store the claim token or claim time in the wire schema; make `claimNextDelivery` two statements (the claim must be one `UPDATE`); put runtime logic in contracts.
- Tests:
  - `044_SymphonyDelegationRequests.test.ts` mirroring `041_SymphonyProjects.test.ts` (`it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))`, `runMigrations({ toMigrationInclusive: 44 })`): insert two rows with the same `(project_id, tracker_kind, tracker_issue_id)` in state `queued` and assert the second insert fails (`Effect.flip`), insert one `completed` and one `running` for the same issue and assert both succeed, assert `request_key` UNIQUE.
  - `DelegationRequestRepository.test.ts`, layer `DelegationRequestRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))` as in `WorkItemRepository.test.ts:16`: `accept creates then replays with the same payload hash` (created true then false, same `id`); `accept rejects a different payload under the same key` (`DelegationRequestKeyConflict`); `accept rejects a second key for an active issue` (`DelegationIssueAlreadyActive`) and allows it after `setState(... to: "completed")`; `setState only moves from the listed states` (wrong `from` returns false and leaves the row); `claimNextDelivery claims the oldest ready row once` (two completed rows, two claims return them in order, a third returns null); `release backs off one recipient and the next recipient is still served` (rows for thread A and thread B both completed; claim A, `releaseDelivery` with `nextAttemptAt` in the future; the next claim returns B, not A; with `now` past the backoff A is returned again); `ack with a stale token is refused` (claim, release, claim again with a new token, ack with the first token returns false); `requeueClaimedDeliveries returns claimed rows to pending`; `listActiveIssueIds returns only active issues`. All fail on base (nothing exists).
- Verify: from `apps/server`: `pnpm exec vp test run src/persistence/Migrations/044_SymphonyDelegationRequests.test.ts src/symphony/Persistence/Layers/DelegationRequestRepository.test.ts`; `pnpm exec tsgo --noEmit` in `packages/contracts` and `apps/server`.
- Depends on: B-4 (migration 042) and the labels card (043) for the migration number. Effort: M. Commit message: `feat(symphony): add the delegation request table and repository`

### H-3 Resolve a GitHub issue reference through the project's tracker, and let an explicit request pass the label rules

- Problem: today nothing resolves an issue for a handoff. `delegateFromThread` stores `trackerIssueId` of `delegated-` plus the work item id (`HandoffService.ts:540`), so `refreshIssueSnapshot` (`SymphonyOrchestratorLive.ts:226-239`) calls the GitHub adapter with a number that is not one and the item can never dispatch (H2). Even with the real number, the next poll runs `evaluateEligibility` on the issue (`Eligibility.ts:30-67`), and an issue without the project's required labels or one already assigned (`not_dispatchable`) is written back as not eligible (`SymphonyOrchestratorLive.ts:539-553`), which `prepareDispatch` refuses (`:1399`). A person who sends an issue to Symphony from chat has decided to run it, so labels and assignment must not block it. State rules (closed issue) must still apply.
- Files to change:
  - `packages/shared/src/git.ts` : new `parseGitHubIssueReference` after `parseGitHubRepositoryNameWithOwnerFromRemoteUrl` (line 136); tests in `packages/shared/src/git.test.ts`.
  - `apps/server/src/symphony/HandoffIssueResolver.ts` (new) and `HandoffIssueResolver.test.ts` (new).
  - `apps/server/src/symphony/Orchestrator/Eligibility.ts` : `EligibilityInput`, `evaluateEligibility`; `Eligibility.test.ts`.
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts` : `pollWorkflow` deps and loop (line 478-552), its call (line 710), the layer requirements of `makeOrchestrator` (line 556).
  - `apps/server/src/symphony/Layers/SymphonyLayer.ts` : add `DelegationRequestRepositoryLive` to the `SymphonyOrchestratorLive` dependency `Layer.mergeAll` (line 153).
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts` : layer (line 354) and one test.
- Change:
  1. `parseGitHubIssueReference` in `packages/shared/src/git.ts`:
     ```ts
     export type GitHubIssueReferenceResult =
       | { readonly ok: true; readonly repository: string | null; readonly number: number }
       | { readonly ok: false; readonly reason: "empty" | "unrecognised" | "pull_request" };
     export function parseGitHubIssueReference(input: string): GitHubIssueReferenceResult;
     ```
     Accepted forms (trim first; `repository` is `owner/name` as written, `null` for the bare forms): `https://github.com/owner/name/issues/12` (optional trailing `/`, `?query` or `#fragment`, `http` also accepted, host `github.com` or `www.github.com`), `owner/name#12`, `#12`, `12`. `https://github.com/owner/name/pull/12` returns `{ ok: false, reason: "pull_request" }`. Number must match `^[1-9][0-9]{0,8}$`. Anything else is `unrecognised`, empty input is `empty`.
  2. `Eligibility.ts`: add `readonly explicitlyRequested?: boolean;` to `EligibilityInput`. In `evaluateEligibility`, when it is true skip the `not_dispatchable` push and the whole required-label loop. Leave `dispatch_paused`, `state_not_active`, `state_terminal` and `already_claimed` unchanged. Update the doc comment of the module to say an explicit human request overrides labels and assignment, never state.
  3. `HandoffIssueResolver.ts`:
     ```ts
     export class HandoffResolveError extends Schema.TaggedErrorClass<HandoffResolveError>()("HandoffResolveError", {
       code: Schema.Literals(["project_not_github", "reference_invalid", "reference_is_pull_request", "reference_outside_project", "tracker_unavailable", "issue_not_found"]),
       message: Schema.String,
     }) {}
     export interface ResolvedHandoffIssue {
       readonly issue: NormalizedIssue;
       readonly scope: string;      // owner/name as configured on the project
       readonly number: number;
     }
     export const resolveHandoffIssue = (deps: {
       readonly registry: TrackerAdapterRegistry["Service"];
       readonly enablement: TrackerEnablement["Service"];
     }) => (input: {
       readonly project: SymphonyProject;
       readonly config: EffectiveWorkflowConfig;
       readonly reference: string;
     }): Effect.Effect<ResolvedHandoffIssue, HandoffResolveError>
     ```
     Steps, in order: (a) `input.project.configuration?.tracker.kind !== "github"` fails `project_not_github` with message `Handoff supports GitHub Issues projects only for now. This project uses <kind>.`; `scope = input.project.configuration.tracker.repository.trim()`. (b) parse the reference: `empty` and `unrecognised` fail `reference_invalid` with message `Use an issue URL, owner/name#123, #123 or a number.`; `pull_request` fails `reference_is_pull_request` (`That is a pull request. Send the issue it belongs to.`). (c) `repository !== null && repository.toLowerCase() !== scope.toLowerCase()` fails `reference_outside_project` with message `That issue is in <repository>. This project reads issues from <scope>.`. (d) `deps.enablement.validateTrackerEnabled(input.config)` failure becomes `tracker_unavailable` with the `TrackerDisabledError` message. (e) `resolveTrackerAdapter(deps.registry, deps.enablement, input.config)` (`Orchestrator/TrackerEnablement.ts:71`), then `adapter.getIssue(String(number))`. A `TrackerAdapterError` with `code === "tracker_not_found"` fails `issue_not_found` (`Issue #<n> was not found in <scope>.`); every other adapter failure fails `tracker_unavailable` with the adapter message. Never fall back to creating anything. (f) return `{ issue, scope, number }`; `issue.id` is the number as a string for GitHub (`GitHubIssuesAdapter.ts:mapRawToNormalized`) and is the canonical `trackerIssueId`.
  4. `pollWorkflow` (Live line 478): add `readonly delegations: DelegationRequestRepository["Service"]` to the `deps` object, and before the `for (const issue of issues)` loop:
     ```ts
     const requestedIssueIds =
       yield *
       deps.delegations
         .listActiveIssueIds(SymphonyProjectId.make(workflow.id), config.trackerKind)
         .pipe(Effect.catch(() => Effect.succeed(new Set<string>() as ReadonlySet<string>)));
     ```
     and pass `explicitlyRequested: requestedIssueIds.has(issue.id)` to `evaluateEligibility` (line 540). `makeOrchestrator` yields `const delegations = yield* DelegationRequestRepository;` (add it next to `workItems`, line 559) and passes it at the call site (line 710). A read failure degrades to "not requested" and the item is re-evaluated by the normal rules.
  5. `SymphonyLayer.ts`: `DelegationRequestRepositoryLive` joins the list at line 153-170 (next to `WorkItemRepositoryLive`). The test layer at `SymphonyOrchestratorLive.test.ts:354-360` adds `Layer.provideMerge(DelegationRequestRepositoryLive)`.
- Do not: create a work item from an unresolved reference; accept a reference outside the project's repository (the poll could never refresh it); bypass `state_terminal` or `state_not_active`; resolve through `gh` directly (use the registry so the project's configured token and the Tracking settings gate apply).
- Tests:
  - `packages/shared/src/git.test.ts`, `describe("parseGitHubIssueReference")`: URL form `https://github.com/o/r/issues/12` gives `{ ok: true, repository: "o/r", number: 12 }`; with `?x=1#issuecomment-5` same; `o/r#12`; `#12` and `12` give `repository: null`; a `/pull/12` URL gives `pull_request`; `#0`, `#abc`, `https://example.com/o/r/issues/1`, and ``give`unrecognised`/`empty` as specified.
  - `Eligibility.test.ts`: `an explicit request ignores labels and assignment but not state`: config with `trackerRequiredLabels: ["agent-ready"]`, issue without the label and `dispatchable: false`; with `explicitlyRequested: true` result is eligible; with a `closed` state and `explicitlyRequested: true` reasons contain `state_not_active:closed`. Fails on base (field unknown, label reason present).
  - `HandoffIssueResolver.test.ts`: build the registry with `makeTrackerRegistry(new Map([["github", () => makeMemoryTrackerAdapter({ issues: [makeIssue("7")], kind: "github" })]]))` (`Trackers/Registry.ts:33`, `Trackers/MemoryAdapter.ts`), enablement with `makeTrackerEnablement(() => Effect.succeed({ github: { enabled: true } } as never))` (`TrackerEnablement.ts:51`), a `SymphonyProject` fixture with `configuration.tracker = { kind: "github", repository: "owner/repo" }` (shape in `SymphonyOrchestratorLive.test.ts:67`) and the config from `makeConfig` (`:86`). Cases: `#7` and `owner/repo#7` and the issue URL resolve issue id `"7"`; `other/repo#7` fails `reference_outside_project`; a PR URL fails `reference_is_pull_request`; `#99` fails `issue_not_found` (the memory adapter fails with `invalid_tracker_config` for a missing id, so give the factory a wrapper whose `getIssue` fails `trackerNotFoundError("x")` from `Trackers/Errors.ts` for that case); a Jira project fails `project_not_github`; a disabled tracker fails `tracker_unavailable`.
  - `SymphonyOrchestratorLive.test.ts`: `poll keeps an explicitly requested issue queued without the required label`: after `seedWorkflow("wf-handoff-poll", "/repo/handoff-poll")` and `orchestrator.refreshNow()`, issue `"3"` is not eligible (existing test line 545 shows this). Then call `DelegationRequestRepository.accept` for project `wf-handoff-poll`, tracker `github`, issue `"3"` (any valid input), `refreshNow()` again, and expect the queue item for "Issue 3" to have `lifecycle === "queued"` and `eligible === true`. Fails on base. (Use the lifecycle names of the repo at implementation time; before B-4 the non-eligible value is `eligible`.)
- Verify: from `packages/shared`: `pnpm exec vp test run src/git.test.ts`; from `apps/server`: `pnpm exec vp test run src/symphony/HandoffIssueResolver.test.ts src/symphony/Orchestrator/Eligibility.test.ts src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts`; typecheck `packages/shared`, `apps/server`.
- Depends on: H-1, B-4. Effort: M. Commit message: `feat(symphony): resolve a GitHub issue reference for handoff and let explicit requests pass the label rules`

### H-2 Atomic accept, replay and conflict, and the delegateFromThread RPC

- Problem: `delegateFromThread` (`HandoffService.ts:490-556`) validates only that the thread exists, takes a free-form `repositoryPath`, matches a workflow by path equality (`resolveWorkflowForDelegate`, line 590-603) without checking that the thread belongs to that project, writes a `manual` work item and returns, with no idempotency: calling it twice creates two items. The RPC (`ws.ts:1217-1236`) forwards `threadId`, `objective`, `repositoryPath`, `branch`, `summary`, `acceptanceCriteria` and drops `relevantFiles`.
- Files to change:
  - `packages/contracts/src/symphony.ts` : `SymphonyDelegateFromThreadInput` and `SymphonyDelegateFromThreadResult` (line 1215-1226).
  - `apps/server/src/symphony/HandoffService.ts` : service interface (line 82-90), `delegateFromThread` (line 490-556), remove `resolveWorkflowForDelegate` (line 590-603), layer requirements (line 623-637), `makeHandoffService` dependencies (line 98-113).
  - `apps/server/src/symphony/Layers/SymphonyLayer.ts` : `HandoffServiceSlice` (line 102-145).
  - `apps/server/src/ws.ts` : `delegateFromThread` handler (line 1217-1236).
  - `apps/server/src/symphony/HandoffService.test.ts` : replace the `delegateFromThread` suite (line 441 onward).
- Change:
  1. Contracts. The RPC has no caller besides the server, so replace its schemas (keep the method name `symphony.delegateFromThread`, `rpc.ts:998-1002` stays):
     ```ts
     export const SymphonyDelegateFromThreadInput = Schema.Struct({
       requestKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
       threadId: ThreadId,
       sourceMessageId: Schema.optional(TrimmedNonEmptyString),
       reference: TrimmedNonEmptyString.check(Schema.isMaxLength(300)), // issue URL, owner/name#N, #N or N
       note: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
     });
     export const SymphonyDelegateFromThreadResult = Schema.Struct({
       replay: Schema.Boolean,
       request: SymphonyHandoffRequestSchema, // from H-1
       issue: Schema.Struct({
         number: PositiveInt,
         title: Schema.String,
         url: Schema.NullOr(Schema.String),
       }),
       projectTitle: Schema.String,
     });
     ```
     Error codes (free strings on `SymphonyError`, same as `ws.ts` `projectError`): `handoff_request_key_conflict`, `handoff_issue_already_active`, `handoff_thread_not_found`, `handoff_thread_project_mismatch`, `handoff_project_not_ready`, `handoff_project_observe_only`, `handoff_issue_not_eligible`, `handoff_work_item_busy`, plus the six `HandoffResolveError` codes prefixed with `handoff_`.
  2. `HandoffService` interface: `readonly delegateFromThread: (input: { readonly requestKey: string; readonly sourceEnvironmentId: string; readonly threadId: string; readonly sourceMessageId?: string; readonly reference: string; readonly note?: string }) => Effect.Effect<DelegateFromThreadResult, HandoffError>;` where `DelegateFromThreadResult` mirrors the contract result (import the contract type). `HandoffError` gets an optional `code` field: `constructor(detail: string, readonly code: string = "handoff_failed")`; existing call sites keep working.
  3. New dependencies in `makeHandoffService`: `const sql = yield* SqlClient.SqlClient; const delegations = yield* DelegationRequestRepository; const projects = yield* SymphonyProjectRepository; const registry = yield* TrackerAdapterRegistry; const enablement = yield* TrackerEnablement;`. Add them to the `HandoffServiceLive` requirement type and to the dependency `Layer.mergeAll` of `HandoffServiceSlice` (`SymphonyLayer.ts:102-108`): `DelegationRequestRepositoryLive`, `SymphonyProjectRepositoryLive`, `TrackerEnablementLive`, `TrackerRegistryGitHubLive.pipe(Layer.provide(FetchHttpClient.layer))`. `SqlClient` comes from the persistence layer already in the chain; let `tsgo` report anything else unsatisfied. The source environment id is not a service dependency (`ServerEnvironment` is provided outside the Symphony layer boundary, `server.ts:313`); the RPC handler passes it in (step 5).
  4. Accept algorithm in `delegateFromThread`, in this order, each failure a `HandoffError(detail, code)`:
     1. Thread: `projection.getThreadShellById(ThreadId.make(input.threadId))` (existing call); `None` gives `handoff_thread_not_found`. Archived threads are allowed.
     2. Project: `projects.getByCodeProjectId(shell.projectId)`; `null` gives code `handoff_thread_project_mismatch` with detail `This chat's project is not set up in Symphony.`; a project with `setupState !== "ready"` or `configuration === null` gives `handoff_project_not_ready`; `configuration.autonomy === "observe"` gives `handoff_project_observe_only` (`This project is set to watch only. Change its autonomy before sending work.`). The project is derived from the thread, never from client input. (The old `repositoryPath` input is gone.)
     3. Workflow config: `workflows.list()` find `record.id === project.id` and `effectiveConfig !== null` (same lookup as `prepareDispatch`, `Live:1403-1409`); missing gives `handoff_project_not_ready`.
     4. Resolve: `resolveHandoffIssue({ registry, enablement })({ project, config, reference: input.reference })` (H-3), mapping `HandoffResolveError` to `HandoffError(error.message, "handoff_" + error.code)`.
     5. Eligibility: `evaluateEligibility({ config, issue, claimedIssueIds: new Set(), dispatchPaused: false, explicitlyRequested: true })`; non-empty `reasons` gives `handoff_issue_not_eligible` with `reasons.join(", ")`. Then `projectWorkItem(issue, config, eligibility, now, SymphonyProjectId.make(project.id))` (`Orchestrator/Projection.ts:29`) and spread `workflowId: workflow.id` like `pollWorkflow` does (`Live:550`). The item id is `workItemIdForIssue(projectId, "github", issue.id)`, the same row a poll creates. Set `description` from `note` when present: `description: [issue.description, input.note].filter(Boolean).join("\n\nNote from chat:\n")` (bounded: `slice(0, 20000)`).
        5b. Payload hash: `const payloadHash = sha256Hex(JSON.stringify({ t: input.threadId, m: input.sourceMessageId ?? null, k: "github", s: scope.toLowerCase(), i: issue.id, n: input.note ?? null }))` (`sha256Hex` from H-1). The hash covers the resolved canonical issue, so `#7`, `owner/repo#7` and the URL are the same request.
     6. One transaction (`sql.withTransaction(Effect.gen(...))`, mapping `SqlError` as `Live.createProject` does, `SymphonyOrchestrator Live:1129-1157`): (i) `existing = workItems.getByTrackerIssue(projectId, "github", issue.id)`; if it exists and its lifecycle is not one of `draft`, `ineligible`, `queued`, `failed`, `cancelled`, `validation_failed`, fail `handoff_work_item_busy` (`Issue #7 is already being worked on (<lifecycle>).`); (ii) `delegations.accept({...})` (H-1): `DelegationRequestKeyConflict` gives `handoff_request_key_conflict`, `DelegationIssueAlreadyActive` gives `handoff_issue_already_active` with the existing request key in the detail; a replay (`created: false`) returns immediately with `replay: true` and performs no other write; (iii) `workItems.upsert(workItem)` (flips `draft`/`ineligible`/`queued` to the projected `queued`); (iv) for an existing `failed`/`cancelled`/`validation_failed` item `workItems.transition(id, "queued", { from: [existing.lifecycle] })` and fail with `handoff_work_item_busy` if it returns false. The request row and the work item therefore commit together or not at all. Nothing in this transaction starts a run: the scheduler admits the queued item on its next scan (`launchNextQueuedWork`), so the request row exists before any launch ("arm the recipient before launch", H-4).
     7. Return `{ replay: false, request: <accepted row as wire schema>, issue: { number, title, url }, projectTitle: project.title }`.
  5. `ws.ts`: `makeSymphonyRpcHandlers` (line 445) has no `serverEnvironment` in scope, so resolve it like `withHandoffService` resolves its service (`ws.ts:~432`): add `const sourceEnvironmentId = Effect.serviceOption(ServerEnvironment.ServerEnvironment).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.succeed("local"), onSome: (environment) => environment.getEnvironmentId })))` (`getEnvironmentId` is `Effect<EnvironmentId>`, `environment/ServerEnvironment.ts:32`; `ServerEnvironment` is already imported in `ws.ts`, check the import name). The handler becomes `Effect.gen` that yields it, then calls `handoff.delegateFromThread({ requestKey: input.requestKey, sourceEnvironmentId: String(environmentId), threadId: input.threadId, ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}), reference: input.reference, ...(input.note !== undefined ? { note: input.note } : {}) })` and `Effect.mapError((cause) => projectError(cause.code, cause.message))` (`projectError` is at `ws.ts:411`; `handoffError(message)` used today builds the generic code, keep it for the other handoff RPCs).
  6. Delete `resolveWorkflowForDelegate` and the manual-item construction. Do not keep a fallback that creates a manual item.
- Do not: take the project or repository from the client; create the work item outside the transaction; mark the request `queued` or `running` here (the reconciler in H-4 owns every state after `accepted`); set the work item to `eligible` or any dispatchable state other than `queued`; return `ok` when `accept` replays a different payload.
- Tests, `HandoffService.test.ts` (replace the suite at line 441; extend the file's layer with `DelegationRequestRepositoryLive`, `SymphonyProjectRepositoryLive`, a registry from `makeTrackerRegistry` over `makeMemoryTrackerAdapter`, `makeTrackerEnablement`, and the existing `fakeEngine`/`ProjectionSnapshotQuery` mocks near line 120-178; seed a Symphony project with `codeProjectId` equal to the fake thread shell's `projectId` and a workflow row with `effectiveConfig`, as in `Live.test` `seedWorkflow`):
  - `accepts a GitHub issue reference, creates the work item and the request in one step`: result `replay: false`, request state `accepted`, work item id `<project>:github:7`, lifecycle `queued`, `trackerIssueId === "7"`, `source.kind === "github"`, request row `workItemId` equal.
  - `replays the same request key and payload without a second item`: call twice; second result `replay: true`, same `request.requestKey`, `workItems.listByLifecycle(["queued"]).length` unchanged.
  - `refuses the same key with a different issue`: second call with `#8` and the same key fails `handoff_request_key_conflict`; no work item `8` exists.
  - `refuses a second request for an active issue under another key`: `handoff_issue_already_active`.
  - `refuses a thread whose project is not in Symphony`: thread shell with another project id fails `handoff_thread_project_mismatch`.
  - `refuses an unresolved reference and creates nothing`: `#99` fails `handoff_issue_not_found`; `workItems.getByTrackerIssue` for `99` is null and the delegation table is empty (use `delegations.listByThread`).
  - `refuses an issue outside the project's repository` and `refuses an observe-only project` and `refuses a closed issue` (`handoff_issue_not_eligible`, reasons contain `state_not_active`).
  - `an issue the poll already stored as not eligible becomes queued`: seed the work item with lifecycle `ineligible` (or `eligible` before B-4) and reasons; accept; lifecycle `queued`, reasons `[]`.
  - All fail on base (no key, no request table, manual item). `ws-symphony.test.ts` or `ws.test.ts` extension: a handler test that the RPC maps `HandoffError` codes into `SymphonyError.code` (model on the existing handoff handler tests, `git grep -n delegateFromThread apps/server/src/*.test.ts`; if none exist, add one next to the `dispatchWorkItem` test in `ws-symphony.test.ts:128`).
- Verify: from `packages/contracts`: `pnpm exec tsgo --noEmit`; from `apps/server`: `pnpm exec vp test run src/symphony/HandoffService.test.ts src/ws-symphony.test.ts`; `pnpm exec tsgo --noEmit` (this is where an unsatisfied layer requirement shows up).
- Depends on: H-1, H-3, B-4. Effort: L. Commit message: `feat(symphony): accept a chat handoff atomically from a GitHub issue reference`

### H-4 State reconciler and result delivery to the originating chat

- Problem: nothing links a finished run back to the chat that asked for it. `NotificationCoordinator` is an in-memory `PubSub` (`NotificationCoordinator.ts:38-44`), lost on restart, and nothing writes into the thread. A naive "oldest undelivered row first" loop has the starvation failure seen in Agent Orchestrator (one failing row blocks all later rows), and a delivery that appends and then crashes before it marks the row would append twice.
- Files to change:
  - `apps/server/src/symphony/HandoffState.ts` (new): pure `deriveHandoffRequestState`, `buildResultActivity`, `deliveryBackoffMs`; `HandoffState.test.ts` (new).
  - `apps/server/src/symphony/HandoffResultDelivery.ts` (new): service, tick, scoped loop; `HandoffResultDelivery.test.ts` (new).
  - `apps/server/src/symphony/Layers/SymphonyLayer.ts` : `HandoffServiceSlice` (line 102-145): build the delivery layer from the same dependencies.
- Change:
  1. `HandoffState.ts`, pure, no Effect services:
     ```ts
     export interface HandoffStateInput {
       readonly current: SymphonyHandoffRequestState;
       readonly lifecycle: WorkLifecycle | null; // null when the work item row is gone
       readonly hasAttempt: boolean;
       readonly turnStarted: boolean; // a turn_started run event exists for the latest attempt (H-0)
     }
     export interface HandoffStateDecision {
       readonly state: SymphonyHandoffRequestState;
       readonly resultKind: SymphonyHandoffResultKind | null;
     }
     export function deriveHandoffRequestState(input: HandoffStateInput): HandoffStateDecision;
     ```
     Rules in order: `current` in `stopped`, `completed`, `result_delivered` returns `{ state: current, resultKind: null }` (final; the caller keeps the stored kind). `lifecycle === null` returns `current` unchanged (preserve unknown evidence). `ready_for_review` or `ready_to_merge` gives `completed` / `ready_for_review`; `completed` gives `completed` / `completed`; `failed` or `validation_failed` gives `completed` / `failed`; `cancelled` or `blocked` gives `stopped` / `stopped`; `preparing` gives `admitted`; `running`, `testing`, `waiting_for_approval` give `running` when `turnStarted` else `launch_unknown`; `retry_scheduled` and `changes_requested` give `queued`; `queued`, `ineligible`, `eligible`, `draft` give `queued` when `hasAttempt` else `accepted`; any other value (a lifecycle added later) returns `current`.
     ```ts
     export function buildResultActivity(input: {
       readonly requestKey: string;
       readonly resultKind: SymphonyHandoffResultKind;
       readonly issueNumber: number;
       readonly issueTitle: string;
       readonly issueUrl: string | null;
       readonly workItemId: string;
       readonly runAttemptId: string | null;
       readonly attemptNumber: number;
       readonly pullRequest: { readonly number: number; readonly url: string | null } | null;
       readonly failureMessage: string | null;
     }): {
       readonly kind: "symphony.handoff.result";
       readonly tone: "info" | "error";
       readonly summary: string;
       readonly payload: Record<string, unknown>;
     };
     ```
     Bounds (constants exported from the file): `MAX_SUMMARY = 200`, `MAX_TITLE = 120`, `MAX_DETAIL = 1_000`, `MAX_URL = 300`. Summary text by kind: `ready_for_review` with a PR `Symphony finished #<n> and opened pull request #<pr> for review.`, without `Symphony finished #<n>. It is ready for review.`; `completed` `Symphony work on #<n> is complete.`; `failed` `Symphony could not finish #<n>.`; `stopped` `Symphony work on #<n> was stopped.`; always `.slice(0, MAX_SUMMARY)`. `tone` is `error` for `failed` and `info` otherwise. Payload: `{ source: "symphony", attribution: "symphony-handoff", requestKey, resultKind, issue: { number, title (sliced), url }, workItemId, runAttemptId, attemptNumber, pullRequest, detail: failureMessage sliced to MAX_DETAIL or null }`. No raw logs, no diff, no agent text.
     ```ts
     /** 5 s doubling, capped at 5 minutes: attempt 1 -> 5 s, 2 -> 10 s, ... */
     export const deliveryBackoffMs = (attempts: number): number =>
       Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
     export const MAX_DELIVERY_ATTEMPTS = 8;
     ```
  2. `HandoffResultDelivery.ts`: `Context.Service` id `"neokod/symphony/HandoffResultDelivery"` with one member `readonly tick: Effect.Effect<void>` (tests drive it), and `HandoffResultDeliveryLive = Layer.effect(...)` whose constructor yields `DelegationRequestRepository`, `WorkItemRepository`, `RunAttemptRepository`, `RunEventRepository`, `EvidenceRepository`, `OrchestrationEngine.OrchestrationEngineService`, `ProjectionSnapshotQuery.ProjectionSnapshotQuery`, `Crypto.Crypto`. Construction order: (a) `delegations.requeueClaimedDeliveries(now)` (rows left `claimed` by a crash go back to `pending`; one server owns the base directory, so no other worker holds a live claim), log the count; (b) `Effect.forkScoped(tick.pipe(Effect.catchCause(log), Effect.repeat(Schedule.spaced("5 seconds"))))`, forked after `tick` is defined so the first tick cannot race construction (same rule as the orchestrator, `SymphonyOrchestratorLive.ts:1839` comment).
  3. `tick` = `reconcile` then `deliver`, each failure caught per row so one bad row never stops the loop:
     - `reconcile`: `delegations.listUnsettled()`; for each row read `workItems.getById`, `runAttempts.latestForWorkItem`, and only when the lifecycle is `running`, `testing` or `waiting_for_approval` and an attempt exists `runEvents.listForAttempt(attempt.id)` to compute `turnStarted = events.some((e) => e.eventType === "turn_started")`. Call `deriveHandoffRequestState`. When `decision.state !== row.state`, `delegations.setState({ requestKey, from: [row.state], to: decision.state, ...(decision.resultKind === null ? {} : { resultKind: decision.resultKind }), ...(attempt === null ? {} : { runAttemptId: attempt.id }), now })`. Also link the attempt id when it changed but the state did not.
     - `deliver`: up to `MAX_DELIVERIES_PER_TICK = 20` iterations: `token = yield* crypto.randomUUIDv4`; `row = yield* delegations.claimNextDelivery({ now, token })`; stop on `null`; `deliverOne(row, token)`; continue with the next row whatever happened (skip and continue; the claim query already skips a recipient in backoff, H-1).
  4. `deliverOne(row, token)`: (i) `projection.getThreadShellById(ThreadId.make(row.sourceThreadId))`; `Option.isNone` gives `disposeDelivery({ reason: "thread_missing" })` and return. (ii) read the work item (title for the card), the attempt by `row.runAttemptId` (attempt number, `error.message` for `failureMessage`), `evidence.getByWorkItem` (`evidence?.pullRequest` gives `{ number, url }`). (iii) `buildResultActivity`. (iv) deterministic ids: `const h = sha256Hex(row.requestKey).slice(0, 32)`; `commandId = CommandId.make("symphony:handoff-result:" + h + ":" + attemptNumber + ":" + resultKind)`; `activityId = EventId.make("symphony-handoff-result-" + h + "-" + attemptNumber + "-" + resultKind)`. (v) `engine.dispatch({ type: "thread.activity.append", commandId, threadId, activity: { id: activityId, tone, kind, summary, payload, turnId: null, createdAt: now }, createdAt: now })`, the same command shape as `CheckpointReactor.ts:101-121`. The engine returns the first result for a repeated `commandId` (`OrchestrationEngine.ts:130-143`), so a crash between append and acknowledge cannot duplicate the activity. (vi) success: `delegations.ackDelivery({ requestKey, token, now })` (sets `result_delivered`); failure: if `row.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS` then `disposeDelivery({ reason: "attempts_exhausted: " + message })` else `releaseDelivery({ requestKey, token, nextAttemptAt: <now + deliveryBackoffMs(row.deliveryAttempts)>, error: message.slice(0, 500) })`. `row.deliveryAttempts` already counts this attempt because the claim increments it.
  5. Not a steer, not user-looking: the append is an activity (no message, no `thread.turn.start`), `turnId: null`, so no provider session is touched and the timeline shows a work-log row with the `summary`.
  6. `SymphonyLayer.ts`: refactor `HandoffServiceSlice` so both services share one dependency set: `Layer.mergeAll(HandoffServiceLive, HandoffResultDeliveryLive).pipe(Layer.provide(<the existing Layer.mergeAll(...) of dependencies plus EvidenceRepositoryLive and DelegationRequestRepositoryLive>))`. Keep the exported name `HandoffServiceSlice`; it is already merged at `SymphonyLayer.ts:218`.
  7. Arm before launch (invariant, no extra code): the request row is committed in the same transaction as the queued work item (H-2 step 6), and the scheduler can only claim the item afterwards, so the recipient exists before any attempt starts. Do not add any code path that creates a request after the item became claimable.
- Do not: dispatch a user message or `thread.turn.start`; build the command id from a random value (a retry must reuse it); delete or reset `delivery_attempts` on release; hold a claim across the engine call without the token fence; call `listForAttempt` for rows that are not running (cost); depend on `NotificationCoordinator`.
- Tests:
  - `HandoffState.test.ts` (plain vitest): a table test over every `WorkLifecycle` value (iterate `WorkLifecycleSchema.literals`) asserting the mapping above, that `turnStarted` flips `launch_unknown` to `running`, that final `current` states are returned unchanged, that `lifecycle: null` returns `current`; `buildResultActivity` truncates a 10,000 character title and a 10,000 character failure message to the bounds, and `tone` is `error` only for `failed`; `deliveryBackoffMs` gives 5000, 10000, 20000 and caps at 300000.
  - `HandoffResultDelivery.test.ts` with layer: `DelegationRequestRepositoryLive`, `WorkItemRepositoryLive`, `RunAttemptRepositoryLive`, `RunEventRepositoryLive`, `EvidenceRepositoryLive` over `SqlitePersistenceMemory`, a fake `OrchestrationEngineService` (record each `dispatch` command in an array; a `Ref<boolean>` switch makes it fail; copy the mock shape from `HandoffService.test.ts:120-178`), a fake `ProjectionSnapshotQuery` returning `Option.some(shell)` or `Option.none()` per thread id, `Crypto` from `NodeServices.layer`, and `HandoffResultDeliveryLive`. Seed with `makeWorkItem`-style fixtures (`HandoffService.test.ts:49`) and `delegations.accept`. Tests: `reconciles a ready_for_review item and delivers one activity with the PR link` (evidence with a PR, expect one recorded command of type `thread.activity.append`, `activity.kind === "symphony.handoff.result"`, `payload.pullRequest.number`, row `state === "result_delivered"`, `deliveryState === "delivered"`); `reports launch_unknown until a turn_started event exists, then running` (lifecycle `running`, attempt row, no event, tick, expect `launch_unknown`; append `runEvents.append(attemptId, "turn_started", {...})`, tick, expect `running`); `a repeated delivery reuses the command id` (deliver, then force the row back to `claimed` with `delegations.claimNextDelivery` after resetting through SQL, `requeueClaimedDeliveries`, tick again, assert both recorded commands have the same `commandId`); `a failing recipient backs off and does not block others` (two completed rows for threads A and B, engine fails for A only; one tick delivers B and releases A with `deliveryAttempts === 1` and a future `deliveryNextAttemptAt`; a second tick without advancing the clock does nothing for A; after `TestClock.adjust("6 seconds")` A is retried); `disposes after the attempt cap` (always-failing engine, advance the clock by 5 minutes between ticks, expect `deliveryState === "disposed"` after 8 attempts and a `deliveryLastError` starting `attempts_exhausted`); `disposes when the thread is gone` (`Option.none()`), `a claimed row left by a crash is requeued at boot` (insert, claim, then provide the Live layer once and expect `pending`). All fail on base (modules missing).
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/HandoffState.test.ts src/symphony/HandoffResultDelivery.test.ts`; `pnpm exec tsgo --noEmit`.
- Depends on: H-0, H-1, H-2. Effort: L. Commit message: `feat(symphony): reconcile handoff state and deliver results to the originating chat`

### H-5a Read model RPC for a thread's handoffs and client-runtime atoms

- Problem: the web client cannot ask Symphony what became of the work a chat sent. There is no read RPC for requests, `symphonyEnvironment` (`packages/client-runtime/src/state/symphony.ts:22-123`) has no atom for `delegateFromThread`, and the request row alone lacks the issue title, attempt and pull request the thread needs to show.
- Files to change:
  - `packages/contracts/src/symphony.ts` : `SYMPHONY_WS_METHODS` (line 80-82), new schemas after `SymphonyDelegateFromThreadResult`.
  - `packages/contracts/src/rpc.ts` : import block (line 134-200), new `WsSymphonyListThreadHandoffsRpc` after `WsSymphonyDelegateFromThreadRpc` (line 998), the group list (line 1159).
  - `packages/contracts/src/symphony.test.ts` : decode test.
  - `apps/server/src/symphony/HandoffService.ts` : new `listThreadHandoffs`.
  - `apps/server/src/ws.ts` : new handler next to `delegateFromThread` (line 1217).
  - `apps/server/src/symphony/HandoffService.test.ts`, `apps/server/src/ws-symphony.test.ts`.
  - `packages/client-runtime/src/state/symphony.ts` : two atoms.
- Change:
  1. Contracts: method `listThreadHandoffs: "symphony.listThreadHandoffs"` under `// Cross-mode handoff`. Schemas:
     ```ts
     export const SymphonyListThreadHandoffsInput = Schema.Struct({ threadId: ThreadId });
     export const SymphonyHandoffViewSchema = Schema.Struct({
       request: SymphonyHandoffRequestSchema,
       projectTitle: Schema.String,
       issue: Schema.Struct({
         number: PositiveInt,
         title: Schema.String,
         url: Schema.NullOr(Schema.String),
       }),
       lifecycle: Schema.NullOr(WorkLifecycleSchema),
       attempt: Schema.NullOr(
         Schema.Struct({
           id: RunAttemptId,
           attemptNumber: NonNegativeInt,
           status: RunAttemptStatusSchema,
         }),
       ),
       pullRequest: Schema.NullOr(
         Schema.Struct({
           number: NonNegativeInt,
           url: Schema.NullOr(Schema.String),
           status: Schema.optional(Schema.Literals(["open", "draft", "merged", "closed"])),
         }),
       ),
     });
     export type SymphonyHandoffView = typeof SymphonyHandoffViewSchema.Type;
     ```
     The delegate result of H-2 reuses `SymphonyHandoffRequestSchema` only; do not duplicate the view there. `rpc.ts`: `Rpc.make(SYMPHONY_WS_METHODS.listThreadHandoffs, { payload: SymphonyListThreadHandoffsInput, success: Schema.Array(SymphonyHandoffViewSchema), error: SymphonyError })`, imported and added to the group list.
  2. Server `HandoffService.listThreadHandoffs: (input: { threadId: string }) => Effect<ReadonlyArray<SymphonyHandoffView>, HandoffError>`: `delegations.listByThread(threadId, 50)` (newest first), then for each row `workItems.getById` (lifecycle, title fallback), the attempt by `row.runAttemptId` when set else `runAttempts.latestForWorkItem`, `evidence.getByWorkItem(...)?.pullRequest`, and `projects.getById(row.projectId)?.title`. Add `EvidenceRepository` to the service dependencies and to `HandoffServiceSlice`. Row-level failures degrade that field to `null`; the call fails only when `listByThread` fails. Issue number is `Number(row.trackerIssueId)`; skip rows whose id is not numeric (non-GitHub rows cannot exist yet).
  3. `ws.ts`: `[SYMPHONY_WS_METHODS.listThreadHandoffs]: (input) => observeRpcEffect(SYMPHONY_WS_METHODS.listThreadHandoffs, withHandoffService((handoff) => handoff.listThreadHandoffs({ threadId: input.threadId }).pipe(Effect.mapError((cause) => handoffError(cause.message))), Effect.succeed([])), { "rpc.aggregate": "symphony" })`. The fallback is an empty list because a server without the handoff layer has no handoffs; this is a known-empty answer.
  4. Client atoms in `createSymphonyEnvironmentAtoms`:
     ```ts
     threadHandoffs: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:symphony:threadHandoffs", tag: SYMPHONY_WS_METHODS.listThreadHandoffs, staleTimeMs: 3_000, refreshIntervalMs: 5_000 }),
     delegateFromThread: createEnvironmentRpcCommand(runtime, { label: "environment-command:symphony:delegateFromThread", tag: SYMPHONY_WS_METHODS.delegateFromThread }),
     ```
     The 5 second refresh matches the server tick (H-4); the board stream is not reused because a thread view does not need the whole board.
- Do not: put runtime helpers in contracts; add a subscription RPC (polling at 5 s is enough and avoids a second stream to keep alive); expose `payloadHash`, claim token or delivery timestamps.
- Tests: `packages/contracts/src/symphony.test.ts`: `SymphonyHandoffViewSchema decodes a full view and a view with null attempt and pull request` (use `Schema.decodeUnknownSync`). `HandoffService.test.ts`: `listThreadHandoffs enriches requests with issue, attempt and pull request` (seed request via `delegations.accept`, a work item, an attempt, an evidence bundle with a PR; expect one view with `attempt.attemptNumber`, `pullRequest.number`, `projectTitle`) and `returns an empty list for a thread with no requests`. `ws-symphony.test.ts`: the handler returns `[]` when the handoff service is absent (model on the `dispatchWorkItem` test at line 128). All fail on base.
- Verify: from `packages/contracts`, `apps/server`, `packages/client-runtime`: `pnpm exec tsgo --noEmit`; from `apps/server`: `pnpm exec vp test run src/symphony/HandoffService.test.ts src/ws-symphony.test.ts`; from `packages/contracts`: `pnpm exec vp test run src/symphony.test.ts`.
- Depends on: H-2, H-4. Effort: M. Commit message: `feat(symphony): list a thread's handoffs and add the client atoms`

### H-5b Link a board card back to the chat that sent it

- Problem: a card created from chat shows no origin. `SymphonyBoardCardSchema` (`packages/contracts/src/symphony.ts:943-954`) has no source, and `projectBoardFromWorkItems` (`Orchestrator/ProjectBoard.ts:38`) receives only work items.
- Files to change:
  - `packages/contracts/src/symphony.ts` : `SymphonyBoardCardSchema`.
  - `apps/server/src/symphony/Orchestrator/ProjectBoard.ts` and `ProjectBoard.test.ts`.
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts` : `getProjectBoard` (line 1209 at base).
  - `apps/web/src/components/symphony/SymphonyProjectView.tsx` : `BoardTab` card (line 110-152).
- Change:
  1. Contracts: add to the card `sourceThread: Schema.optional(Schema.Struct({ environmentId: TrimmedNonEmptyString, threadId: ThreadId, requestState: SymphonyHandoffRequestStateSchema }))`.
  2. `projectBoardFromWorkItems` takes `readonly sourceThreads?: ReadonlyMap<string, { readonly environmentId: string; readonly threadId: string; readonly requestState: SymphonyHandoffRequestState }>` keyed by work item id and adds `...(source === undefined ? {} : { sourceThread: source })` to the card.
  3. `Live.getProjectBoard`: after loading the work items, `const requests = yield* delegations.listByProject(projectId).pipe(Effect.catch(() => Effect.succeed([])))` and build the map keeping the newest request per work item (the repository returns newest first, so the first one wins). A failed read leaves the cards without the link; it must not fail the board (the board's own errors are handled by card B-1).
  4. Web: in the card, when `card.sourceThread` is set render under the title a link `<Link to="/$environmentId/$threadId" params={{ environmentId: card.sourceThread.environmentId, threadId: card.sourceThread.threadId }} className="mt-2 inline-block text-xs text-muted-foreground underline-offset-2 hover:underline">From chat</Link>` using `Link` from `@tanstack/react-router` (the file imports `useNavigate` from the same package, line 12). Do not render the link for cards without `sourceThread`.
- Do not: add a column to `symphony_work_items`; fetch requests per card from the client; make the link depend on the thread still existing (the route shows its own empty state, `_chat.$environmentId.$threadId.tsx`).
- Tests: `ProjectBoard.test.ts`: `adds the source thread to cards that have a request` (two items, a map for one; the card for it has `sourceThread`, the other has none). A `Live.test` case is optional; if added: create a request with `delegations.accept` for a seeded item and expect the card to carry `sourceThread.threadId`. Fails on base (field and parameter do not exist).
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Orchestrator/ProjectBoard.test.ts`; typecheck `packages/contracts`, `apps/server`, `apps/web`.
- Depends on: H-1, H-2 (and S4 B-2 touches the same function; rebase by symbol). Effort: S. Commit message: `feat(symphony): show the originating chat on board cards`

### H-5c Send to Symphony in the chat header and a workstream summary

- Problem: nothing in the chat UI can start a handoff or show its progress. The existing header (`apps/web/src/components/chat/ChatHeader.tsx`) has a goal chip (`GoalChip`, line 107) and an overflow `Menu` (line 119-181) but no Symphony entry.
- Files to change:
  - `apps/web/src/components/chat/symphonyHandoff.logic.ts` (new) and `symphonyHandoff.logic.test.ts` (new): pure helpers.
  - `apps/web/src/components/chat/SymphonyHandoffControl.tsx` (new): `SendToSymphonyDialog`, `SymphonyWorkstreamChip`.
  - `apps/web/src/components/chat/ChatHeader.tsx` : render the chip next to `GoalChip` (line 107), add the menu item in the overflow menu, extend `hasOverflowActions` (line 91).
  - `apps/web/src/components/chat/ChatHeader.test.ts` : the existing `shouldShowOpenInPicker` tests live there; add none unless a pure helper is added to the header.
- Change:
  1. `symphonyHandoff.logic.ts`:
     ```ts
     export function buildHandoffRequestKey(input: {
       threadId: string;
       sourceMessageId: string | null;
       reference: string;
     }): string;
     export function describeHandoffState(
       view: Pick<SymphonyHandoffView, "request" | "lifecycle" | "pullRequest">,
     ): { label: string; tone: "neutral" | "active" | "success" | "danger" };
     export function describeDelegateError(code: string, message: string): string;
     ```
     `buildHandoffRequestKey` returns `[threadId, sourceMessageId ?? "-", reference.trim().toLowerCase()].join("|")` sliced to 256 characters; the same click, retry or double submit gives the same key, so the server replays instead of creating a second item. `describeHandoffState` maps `accepted` to `Queued` (neutral), `queued` to `Waiting to run` (neutral), `admitted` to `Preparing` (active), `launch_unknown` to `Starting, not confirmed yet` (active), `running` to `Running` (active), `stopped` to `Stopped` (neutral), and `completed` or `result_delivered` by `request.resultKind`: `ready_for_review` to `Ready for review` or `PR #<n> ready for review` (success), `completed` to `Completed` (success), `failed` to `Failed` (danger), `stopped` to `Stopped`. `describeDelegateError` returns the server message for every `handoff_*` code and `Could not send this to Symphony. Try again.` otherwise.
  2. `SendToSymphonyDialog` props `{ environmentId, threadId, projectLabel, open, onOpenChange }`. Contents (components from `../ui/dialog`: `Dialog`, `DialogPopup`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`; `Input` and `Textarea` from `../ui`; `Button`): title `Send to Symphony`; description `Symphony works the GitHub issue in its own workspace and reports back in this chat.`; field `Issue` (`Input nativeInput`, placeholder `#123, owner/repo#123 or an issue URL`, `aria-label="GitHub issue"`); optional `Note for the agent` (`Textarea`, max 2000); footer `Cancel` and `Send` (disabled while the field is empty or while sending). Submit calls `useAtomCommand(symphonyEnvironment.delegateFromThread, { reportFailure: false })` with `{ environmentId, input: { requestKey: buildHandoffRequestKey({ threadId, sourceMessageId: <id of the latest user message in the thread or null>, reference }), threadId, sourceMessageId?, reference, note? } }`. On `Success` close the dialog and show a toast `Sent to Symphony` / `#<n> <title>` (`stackedThreadToast` and `toastManager`, as `GoalChip.tsx` does); when `result.value.replay` is true the description says `Already sent. Showing the existing request.`. On failure show `describeDelegateError(...)` inline under the field (`role="alert"`), keep the dialog open. Use `squashAtomCommandFailure` and `isAtomCommandInterrupted` from `@neokod/client-runtime/state/runtime` as `GoalChip.tsx:5-8` does; the failure is a `SymphonyError` whose `code` and `message` are read from the squashed value.
  3. Availability: the menu item `Send to Symphony` is shown when the thread's project is a Symphony project. Look it up with `useEnvironmentQuery(symphonyEnvironment.projects({ environmentId, input: {} }))` (input `{}`, as `SymphonyProjectsView.tsx:280` does) and `projects.find((p) => p.codeProjectId === thread.projectId)` where `thread = useThreadShell(scopeThreadRef(environmentId, threadId))`. When the project is found but `setupState !== "ready"` or `configuration?.tracker.kind !== "github"` the item is disabled with the tooltip `This project does not read GitHub Issues in Symphony.`; when no project is found the item is hidden. Hide it for any environment other than the primary one if `shouldShowOpenInPicker`-style gating applies (the Symphony atoms use the primary environment, see `SymphonyProjectView.tsx:usePrimaryEnvironmentId`).
  4. `SymphonyWorkstreamChip` props `{ environmentId, threadId }`. `useEnvironmentQuery(symphonyEnvironment.threadHandoffs({ environmentId, input: { threadId } }))`; render nothing when the list is empty. Otherwise a `Popover` (same pattern as `GoalChip.tsx`, `Popover`, `PopoverTrigger`, `PopoverPopup`) whose trigger is a small `Button size="xs" variant="ghost"` with the Symphony icon (`lucide-react`, choose `WorkflowIcon` or the icon the Symphony sidebar entry uses, `components/sidebar/SymphonySidebarNav.tsx`) and the label of the newest view from `describeHandoffState`. The popover lists up to five views, each with: issue link (`#<n> <title>` to `issue.url`, `target="_blank"`, `rel="noreferrer"`), the state label, `Attempt <n>` when `attempt !== null`, a pull request link when `pullRequest?.url`, a `Open on board` link (`to: "/symphony/projects/$projectId"` with `params={{ projectId }}`), and a `Stop` button for views in `accepted`, `queued`, `admitted`, `launch_unknown` or `running` (wired in H-6). Text for the empty `launch_unknown` explanation: `Symphony asked the agent to start but has not seen it begin yet.`.
  5. `ChatHeader.tsx`: `<SymphonyWorkstreamChip environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />` right after `GoalChip`. The menu item and its dialog state live in a small `SendToSymphonyMenuItem` exported from `SymphonyHandoffControl.tsx` that renders a `MenuItem` plus the dialog (so `ChatHeader` only adds one element and keeps `hasOverflowActions` true when it renders: pass the availability up with a prop-free hook `useSymphonyHandoffAvailability(environmentId, threadId)` exported from the same file).
- Do not: call `delegateFromThread` with a repository path or project id (removed in H-2); hide server errors; retry automatically on failure; poll faster than the atom's 5 s refresh; add a second place that derives state labels.
- Tests, `symphonyHandoff.logic.test.ts`: `buildHandoffRequestKey is stable for the same click and differs per issue and message` (same input twice equal; changing the reference or the message id changes it; casing and surrounding spaces of the reference are normalised; a 400 character reference is cut to 256); `describeHandoffState` table: one assertion per `SymphonyHandoffRequestState`, plus `completed` with each `resultKind` and a pull request number; `describeDelegateError` returns the server message for `handoff_issue_not_found` and the generic text for an unknown code. A `SymphonyHandoffControl.browser.tsx` is optional: the dialog needs `symphonyEnvironment` atoms and a registry; if the implementer wants one, copy the mounting approach of `apps/web/src/components/symphony/PullRequestPanel.browser.tsx` and stub only the pure parts. The pure tests fail on base (module missing).
- Verify: from `apps/web`: `pnpm exec vp test run src/components/chat/symphonyHandoff.logic.test.ts src/components/chat/ChatHeader.test.ts`; `pnpm exec tsgo --noEmit`. Manual: in a thread of a GitHub-backed Symphony project, `More thread actions`, `Send to Symphony`, enter `#<n>`; the chip appears in the header with `Queued`.
- Depends on: H-5a. Effort: M. Commit message: `feat(web): send a chat to Symphony and show the workstream in the thread header`

### H-6a Stop from the chat, and stops from the board show in the chat

- Problem: the only stop controls are `cancelRun` on an attempt (`ws.ts:1058`, `Dispatcher.cancelRun`, `Dispatcher.ts:544-571`) and nothing maps a chat request to its run. Before S1 card 1.5 a cancelled run is released to `queued` and the scheduler relaunches it, which would make a stop from chat meaningless. A cancel made on the board must also be visible in the chat that asked for the work.
- Files to change:
  - `packages/contracts/src/symphony.ts` : method `stopHandoff: "symphony.stopHandoff"`, `SymphonyStopHandoffInput`, `SymphonyStopHandoffResult`.
  - `packages/contracts/src/rpc.ts` : `WsSymphonyStopHandoffRpc`, group list.
  - `apps/server/src/symphony/HandoffService.ts` : `stopHandoff`.
  - `apps/server/src/ws.ts` : handler.
  - `packages/client-runtime/src/state/symphony.ts` : `stopHandoff` atom.
  - `apps/web/src/components/chat/SymphonyHandoffControl.tsx` : wire the `Stop` button added in H-5c.
  - `apps/server/src/symphony/HandoffService.test.ts`, `apps/server/src/symphony/HandoffResultDelivery.test.ts`.
- Change:
  1. Contracts: `SymphonyStopHandoffInput = Schema.Struct({ requestKey: TrimmedNonEmptyString })`; `SymphonyStopHandoffResult = Schema.Struct({ status: Schema.Literals(["stopping", "already_final", "not_found"]) })`. Rpc success `SymphonyStopHandoffResult`, error `SymphonyError`.
  2. `HandoffService.stopHandoff({ requestKey })`:
     1. `delegations.getByKey`; `null` returns `{ status: "not_found" }`. A request whose state is `stopped`, `completed` or `result_delivered` returns `{ status: "already_final" }`. Repeating a stop is therefore safe.
     2. Read the work item and `runAttempts.latestForWorkItem(workItemId)`. If the item has a non-terminal attempt (lifecycle `preparing`, `running`, `testing` or `waiting_for_approval` and the attempt row exists): `dispatcher.cancelRun(attempt.id)` (as `takeOver` does, `HandoffService.ts:283-286`), `liveRequests.settleRun(attempt.id, "stopped from chat")`, and append the run event `handoff_stopped` with `{ requestKey }` through the existing `appendEvent`. After S1 card 1.5 this leaves the item `cancelled`.
     3. Otherwise (accepted, queued, retry_scheduled, no live attempt): `workItems.transition(workItemId, "cancelled", { requireUnclaimed: true })` using the default legal sources. If it returns false the item was claimed in the meantime: re-read once; if an attempt now exists cancel it as in step 2, else fail with `HandoffError("The run is starting. Try again in a moment.", "handoff_stop_raced")`.
     4. Return `{ status: "stopping" }`. Do not set the request state here: the reconciler (H-4) derives `stopped` from the `cancelled` lifecycle on its next tick and delivers the `stopped` activity to the chat. That is also what makes a cancel done from the board show in the chat with no extra code: both paths end in a `cancelled` work item.
  3. `ws.ts` handler with `withHandoffService`, `Effect.mapError((cause) => projectError(cause.code, cause.message))`; client atom `stopHandoff: createEnvironmentRpcCommand(runtime, { label: "environment-command:symphony:stopHandoff", tag: SYMPHONY_WS_METHODS.stopHandoff })`.
  4. Web: the `Stop` button of the chip popover (H-5c) calls the atom with the view's `request.requestKey`, disables itself while pending, shows `Stopping` and relies on the 5 s refresh to show `Stopped`; on `handoff_stop_raced` show the server message inline. Use a confirm step only if the existing Symphony stop controls use one (`SymphonyRunDetailView.tsx` cancel button); do not add a new dialog.
- Do not: stop by calling `Dispatcher.cancelRun` for a run that is not the latest attempt; write `stopped` into the request row from this method; relaunch anything.
- Tests:
  - `HandoffService.test.ts`: `stops a queued request by cancelling the work item` (accept, then `stopHandoff`; work item lifecycle `cancelled`, result `stopping`; a second call returns `already_final` once the reconciler has run, and `stopping` is acceptable before that, assert on the lifecycle); `stops a running request through the dispatcher` (seed a `running` item with a `streaming_turn` attempt, use the file's `fakeDispatcher` (line 91-106) that records `cancelRun`; assert it was called with the attempt id and a `handoff_stopped` run event exists); `stopHandoff for an unknown key returns not_found`; `stop on a finished request returns already_final`.
  - `HandoffResultDelivery.test.ts`: `a work item cancelled on the board is reported to the chat as stopped`: accepted request, set the work item lifecycle to `cancelled` with `workItems.transition`, tick; expect the recorded activity `payload.resultKind === "stopped"` and `summary` containing `was stopped`, request `result_delivered`.
  - All fail on base (no method). The last one also covers "stop from the board mirrored in the chat".
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/HandoffService.test.ts src/symphony/HandoffResultDelivery.test.ts`; typecheck `packages/contracts`, `packages/client-runtime`, `apps/server`, `apps/web`.
- Depends on: H-4, H-5c, S1 1.5. Effort: M. Commit message: `feat(symphony): stop a handoff from the chat and report board stops back to it`

### H-6b Restart behaviour tests and the owner acceptance script

- Problem: the handoff promises no duplicate launch and no lost delivery across a restart, and the owner needs one script that proves the whole path against a real GitHub repository. Neither exists.
- Files to change:
  - `apps/server/src/symphony/HandoffRestart.test.ts` (new).
  - `docs/operations/symphony-handoff-acceptance.md` (new).
- Change:
  1. Restart behaviour, as designed (verify each by the test below; no production change is expected in this card, fix the owning card if a test fails):
     - Accept replay never relaunches: `accept` only writes rows (H-2 step 6); a repeated `delegateFromThread` with the same key returns `replay: true` and no second work item or attempt.
     - A crash between the activity append and the acknowledge repeats the append with the same `commandId`, which the engine answers from its receipt (H-4 step 4).
     - Rows left `claimed` by a crash return to `pending` at boot (H-4 step 2).
     - A run interrupted by the restart is marked `interrupted` and the item released by `runStartupRecovery` (`Orchestrator/Recovery.ts:101`); the request state falls back from `running` to `queued` or `launch_unknown` on the next tick (non-final states may move backwards), and a later success is delivered once.
     - An interrupted run that reached `ready_for_review` before the restart delivers its result after boot.
  2. `HandoffRestart.test.ts`: build two layers over the same in-memory database file is not possible with `SqlitePersistenceMemory`; use `makeSqlitePersistenceLive` over a temp file (as `WorkItemRepository.test.ts` imports it at line 16 and `FileSystem.makeTempDirectoryScoped`) and "restart" by building a fresh layer stack on the same file twice inside one test with `Effect.provide` of two `Layer.build` scopes closed in between. Tests: `replay after restart returns the same request and creates no second item`; `an append that was not acknowledged before the restart is repeated with the same command id and recorded once by the engine` (a fake engine that, like the real one, keeps a `Set` of seen command ids and returns early on a repeat; expect `seen.size === 1` and the request `result_delivered` after the second boot); `a claimed delivery is requeued at boot`; `a request whose run was interrupted is queued again, then delivered once after completion`.
  3. Acceptance script `docs/operations/symphony-handoff-acceptance.md`, plain steps, each with an expected result (no em dashes, plain English):
     1. Prerequisites: a GitHub repository you own that is cloned locally, `gh auth status` succeeds for it, an issue `#N` with a one-sentence task such as `Add a CONTRIBUTING.md with a section named "Running checks"`, and no label on it (this proves the label bypass). Neokod running with this base directory and a Codex provider enabled.
     2. In Neokod add the cloned folder as a Code project. Open Symphony, create a Symphony project for it with tracker GitHub Issues and the repository `<owner>/<repo>`, autonomy `Implement and open a PR`, Parallel work items 1. Settings > Tracking: GitHub enabled. Expected: the project shows `Ready`.
     3. Open a chat in that Code project, `More thread actions`, `Send to Symphony`, type `#N`, Send. Expected: toast `Sent to Symphony`, header chip `Queued` then `Preparing`; the board card for `#N` is under In Progress with a `From chat` link.
     4. Press Send again with the same text. Expected: toast `Already sent`; still one card.
     5. Wait for the run. Expected: chip moves `Starting, not confirmed yet` then `Running`; never `Running` before the board shows the run started.
     6. Expected at the end: chip `PR #M ready for review`; a work-log row in the chat `Symphony finished #N and opened pull request #M for review.`; the PR exists on GitHub and mentions the issue; no extra message from the user appears and the chat agent did not start a turn.
     7. Restart check: send a second issue `#K`, and while the chip says `Running` stop Neokod with Ctrl+C and start it again. Expected: no second card for `#K`; after boot the chip returns to `Waiting to run` or `Preparing` and the run resumes; one result row appears when it ends.
     8. Stop check: send issue `#L`, press `Stop` in the chip while it runs. Expected: chip `Stopped`, the board card is in Done as cancelled, a work-log row `Symphony work on #L was stopped.`, and no new attempt starts after 30 seconds.
     9. Board stop check: send `#P`, cancel its run from the board run page. Expected: the chat chip shows `Stopped` within 10 seconds and one stopped row is written.
     10. Wrong project check: open a chat in a different Code project that is not in Symphony; `Send to Symphony` is hidden. In the original chat enter an issue of another repository (`other/repo#1`). Expected: the dialog shows `That issue is in other/repo. This project reads issues from <owner>/<repo>.` and nothing is created.
     11. Failure check: type `#999999`. Expected: `Issue #999999 was not found in <owner>/<repo>.`; the board has no new card.
     12. Clean up: close the PR, delete the branch, delete the test issue comments if wanted.
- Do not: make the acceptance doc describe behaviour that a card above does not deliver; add a test that needs network or a real `gh`.
- Tests: the four tests listed in step 2; they fail on base only because the modules do not exist, and they must pass after H-1 to H-6a. If one fails, the owning card is wrong, not this one.
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/HandoffRestart.test.ts`; then run the acceptance script by hand once on a real repository and record the outcome in the PR description.
- Depends on: H-1 to H-6a. Effort: M. Commit message: `test(symphony): cover handoff restart behaviour and add the owner acceptance script`

# Open questions

1. U-02b: a conflicting write currently stops saving and asks the user to Reload or Overwrite. Should Overwrite be offered at all, or only Reload (the safer data-loss answer)?
2. U-03: thread worktrees outside `worktreesDir` are accepted only if they are registered as a thread `worktreePath`. If you also want to review arbitrary directories under a registered project's parent, say so; it widens the read surface.
3. U-04: a server-side guard (refuse a non-sensitive empty value that would delete a stored secret) would also protect other settings clients. Not included; add a card if you want it.
4. S-02: drafts live in memory per browser session. Persisting them across reloads was left out on purpose.
5. H-2: a request for an issue that already has a finished request (completed or stopped) is accepted as a new request and requeues the item if its lifecycle is `failed`, `cancelled` or `validation_failed`. An item already in review (`ready_for_review`) refuses with `handoff_work_item_busy`. Is that the rule you want?
6. H-4: delivery fires once per request, at the first `ready_for_review` or terminal outcome. A later `changes_requested` cycle that produces a second review is not announced. A per-attempt delivery would need a request-result table; say if it is wanted.
7. H-2: autonomy `observe` projects are refused. The alternative is to accept and queue but run nothing, which looks like a hang.
8. H-1 numbering: 044 assumes the labels card takes 043. If it does not exist at merge time, H-1 is 043.
9. Non-GitHub trackers: `resolveHandoffIssue` refuses them with `handoff_project_not_github`. Jira, Linear and the rest are plan W8.
10. Handoff with no issue (a free-text objective) is not supported by these cards because it needs a manual work item that can dispatch; the plan puts that behind W8 tracker work.

# Unverified

- Nothing was built, typechecked or run. The only command run was read-only searching.
- U-01: whether `ChatMarkdown` shows a disabled checkbox exactly as expected when `onTaskListChange` is undefined was read (`ChatMarkdown.tsx:1345-1355`) but not rendered.
- U-02b: the sha256 of a file read as UTF-8 text and the hash of the same bytes at write time agree because both use raw bytes; invalid UTF-8 content is replaced on read and a client write of the decoded text would change the bytes, so the hash match only guarantees "unchanged since read", which is what is needed.
- U-03: whether `ReviewLayerLive` (`server.ts:226`) can receive `SqlClient` without more wiring was not confirmed; the card says to let `tsgo` decide where to provide it.
- U-04: the claim that `useCommitOnBlur` never commits an unchanged empty value was read (`hooks/useCommitOnBlur.ts`) not tested.
- U-06: the duplicate-text defect in the failure restore path is inferred from reading, not reproduced.
- S-01: `Textarea` (`ui/textarea.tsx`) forwarding `onBlur` and `onFocus` to the inner element was read only in its first 30 lines; the card gives a fallback.
- H-2: the name and location of the `ServerEnvironment` accessor in `ws.ts` handlers uses `Effect.serviceOption`, copied from the `withHandoffService` pattern, and was not compiled.
- H-4: that `Layer.mergeAll(HandoffServiceLive, HandoffResultDeliveryLive)` builds the delivery layer even when nothing requires the delivery service was assumed from how Effect layers build; verify with the restart test and by logging the boot requeue count.
- H-1 and H-4: SQLite supports the partial unique index and the `UPDATE ... WHERE id = (SELECT ...) RETURNING` form used (the repo's SQLite client is `node:sqlite`, `NodeSqliteClient.ts`); not run.
- H-0 and H-6a depend on S1 cards 1.4 and 1.5 that were written but not implemented; the lifecycle names in H-3 and H-4 depend on S4 card B-4.
- The persistent decision to put `parseGitHubIssueReference` in `packages/shared/src/git.ts` reuses the existing `./git` subpath export, no new export was added.
