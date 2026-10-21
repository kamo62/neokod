I'll start by reading the required documents and understanding the current state of the repository.Implemented the four locked cards serially on `work/core-git-safety`, based on `cc054117d`. Each card is one commit, normal push, no force, no `main`/`dev` writes. Working tree is clean.

## Commits

| Card | Commit      | Message                                                                                           |
| ---- | ----------- | ------------------------------------------------------------------------------------------------- |
| U-11 | `3357c8693` | `fix(web): copy a thread's own project path from the All threads list [skip ci]`                  |
| X-9  | `eaab8d39f` | `fix: inspect worktree state before thread delete and reclaim safe branches [skip ci]`            |
| X-10 | `06c428103` | `fix(git): refuse commit and push with unmerged paths and report merge or rebase state [skip ci]` |
| X-11 | `3e5b05f31` | `fix(git): validate ref names and terminate options in every git invocation [skip ci]`            |

Pushed `work/core-git-safety` to `neokod` after each commit; branch tracks `neokod/work/core-git-safety`.

## What changed

- **U-11:** `resolveThreadWorkspacePath` resolves worktree first, then the owning project by environment + project identity; unknown owner returns `null` (Path unavailable), never the first project root. `SidebarProjectItem` uses all projects rather than group members plus a first-project fallback.
- **X-9:** `vcs.inspectWorktree` contract, RPC, driver, workflow service, ws handler and client command. Inspection failures keep the worktree. Linked threads come from the server read model after deletion outcomes (deleted threads excluded, trailing separators normalised, `excludeThreadIds` honoured). Delete flow now inspects, shows the full path and loss counts, asks a second discard confirmation before `force`, and only reclaims `neokod/` branches via compare-and-delete `update-ref` after a clean `worktree remove`. Bulk delete defers cleanup until outcomes are known and only cleans successful candidates.
- **X-10:** Conflict and operation state are captured in `GitVcsDriverCore`, passed through `status`, `GitManager.readLocalStatus` and `toLocalStatusPart`, and exposed in `VcsStatusLocalResult`. `GitUnmergedPathsError` rejects commit/push/PR before staging; resolved merges still commit. Thin guards added in web Git action logic, Environment panel logic, the menu warning line, and the mirrored client-runtime action logic.
- **X-11:** Pure `validateGitRefName` / `validateGitArgumentValue`; every enumerated driver call site validates names, `git checkout` uses trailing `--` (not leading), `worktree`/`branch`/`fetch`/`remote`/`push`/`clone` use `--`, and revision/range calls use `--end-of-options`. Unicode and slash names remain accepted. Clone URL and Symphony revision/evidence argv corrected. No git version probe or removal-policy change.

## Checks run

Focused, all passing at integrated HEAD:

- `apps/web`: `Sidebar.logic.test.ts`, `worktreeCleanup.test.ts`, `GitActionsControl.logic.test.ts` — 149 tests.
- `apps/server`: `GitVcsDriverCore.test.ts`, `GitManager.test.ts`, `SourceControlRepositoryService.test.ts` — 127 tests.
- `apps/server`: `src/symphony` — 51 files / 446 tests.
- `packages/shared`: `src/git.test.ts` — 14 tests.
- `tsgo --noEmit`: `packages/contracts`, `packages/shared`, `packages/client-runtime`, `apps/server`, `apps/web` — pass.
- Scoped `vp fmt`, `git diff --check`, scoped `vp lint` — clean; only two pre-existing `Sidebar.tsx` unused-symbol warnings.

Root `vp check` / `vp run typecheck`, builds, Electron, Docker, installs, live app/provider/browser checks and real project/`~/.neokod` actions were not run, per the brief.

## Failure and evidence gaps

- `apps/server/src/server.test.ts` has one failure unrelated to these cards: `routes websocket rpc projects.listEntries and projects.readFile` expects a file object without `contentHash`, while the response includes it. The same assertion exists unchanged on `dev`; I did not edit it beyond the required `inspectWorktree` mock method.
- Fail-first evidence is limited by missing base APIs on U-11/X-9/X-10, so their new suites could not compile before the fixes. For X-11 I reproduced the old argv mechanism in a disposable temp repo: `git checkout -f` discarded a modified file (0 changed entries) and `git diff --stat --output=<tmp>/pwn..HEAD` created the output file. The post-fix suites assert rejection, preserved local changes and protected argv.
- No live UI/manual runtime verification: Copy Path across projects, the two confirm dialogs, branch deletion, conflict menu/toast and clone rejection were not exercised in the app. The X-9 RPC is covered by the mocked workflow signature; I did not add the optional direct RPC call test.
- Remaining cards in this lane: none. X-12 onward and the wider audit were left untouched.
