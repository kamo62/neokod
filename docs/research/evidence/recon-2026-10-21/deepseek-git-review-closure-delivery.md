## Result

Commit `5c86a15c4` on `work/core-git-safety`, pushed as `3e5b05f31..5c86a15c4`.

`fix(git): bind worktree removal to fresh evidence and keep resolved operations committable [skip ci]`

### What changed

**X9 destructive boundary**

- `vcs.removeWorktree` now requires `expectedState`; a direct RPC cannot skip inspection.
- Removal freshly re-inspects Git and re-reads the authoritative projection before deleting.
- Surviving links are found by canonical physical identity of `thread.worktreePath ?? project.workspaceRoot`, resolving symlinks and existing parents, reusing the existing resolver. Platform case rules are shared.
- Identity or read-model failures fail closed.
- Removal ignores client `excludeThreadIds`; only inspection uses them for the thread being deleted.
- Removal is bound to inspected path identity, ref, full `headSha`, changed/untracked/ignored counts, local-only commits and branch-reclaimability.
- Detached HEAD moving, loss counts changing, or a link appearing rejects as stale. The web cleanup re-inspects and re-confirms once.
- `force` is applied only after the fresh state matches and the inspected loss exists. Client-supplied `force` alone cannot remove a dirty worktree.
- Ignored files are now counted and included in loss confirmation. An isolated git fixture confirmed `git worktree remove` deletes ignored files without `--force`.
- Branch reclaim uses full `refs/heads/...`, strict numeric parsing, `neokod/` prefix and compare-and-delete with the expected SHA.
- Removal RPCs are serialised with a server semaphore.

**X10 UI**

- `resolveConflictBlockReason` now blocks only unmerged paths and rebase.
- Merge, cherry-pick and revert are informational notices; resolved operations remain committable through menu, quick action and Environment.
- Matches the client-runtime mirror.
- Web regressions added for resolved merge, cherry-pick and revert.

**X10 lower publishing**

- Shared `assertNoUnmergedPaths` guard in `pushCurrentBranch`.
- `publishRepository` checks before creating the remote.
- Symphony PR creation stops before body write or change-request creation when push is refused.

**Selected-file commit**

- `prepareCommitContext` refuses selected-file commits during merge, cherry-pick and revert before the unscoped `git reset`.
- Full resolved merge commit remains allowed; fixture verifies two parents and preserved `MERGE_HEAD`.

**Operation lookup**

- Replaced five newline-split `--git-path` outputs with one `rev-parse --path-format=absolute --git-dir`, then joins fixed state filenames.
- Newline-in-administrative-path regression added.

**Deletion versus cleanup**

- A successful thread deletion is returned as success even when worktree cleanup fails.
- Cleanup warnings name the kept path and recovery action.
- Pinned/dismissed metadata now clears on deletion success.
- Bulk cleanup still uses successful deletion outcomes only.

### Checks run

- `pnpm exec vp check` root: exit 0, 0 errors, 30 pre-existing warnings.
- `pnpm exec vp run typecheck` root: exit 0.
- `pnpm exec vp fmt --check` on all 19 committed files: pass.
- `apps/server` `vp test run src/vcs/GitVcsDriverCore.test.ts`: 54 passed.
- `apps/server` `vp test run src/git/GitManager.test.ts`: 71 passed.
- `apps/server` `vp test run src/sourceControl/SourceControlRepositoryService.test.ts`: 9 passed.
- `apps/server` `vp test run src/symphony/Evidence/PullRequest.test.ts`: 13 passed.
- `apps/server` `vp test run src/server.test.ts -t "worktree removal"`: 1 passed.
- `apps/server` `vp test run src/server.test.ts -t "routes websocket rpc git methods"`: 1 passed.
- `apps/web` `vp test run src/worktreeCleanup.test.ts src/components/GitActionsControl.logic.test.ts src/components/EnvironmentPanel.logic.test.ts`: 104 passed.

### Proof gaps

- A full `apps/web` test run was attempted but includes Playwright browser projects, which cannot run under the no-browser constraint. Only the listed unit suites ran.
- No live app, browser, Electron, provider or manual dialog verification.
- The admission race is reduced, not atomically closed. A thread can still be linked, or a detached commit created, between the final read-model/inspection check and `git worktree remove`. The semaphore serialises removal RPCs only. Closing it fully needs a per-worktree lease or lock shared by thread admission/attach and removal in the orchestration path.
- Windows case-insensitive identity is implemented but not exercised at runtime.
- No runtime proof for the hosted/remote deployment beyond the existing invariant that removal still passes the cross-mode ownership guard.
