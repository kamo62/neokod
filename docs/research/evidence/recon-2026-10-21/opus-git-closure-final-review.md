I found three new concrete P2s and one known residual P2. There is no P0 or P1. The earlier P1s are closed in source: removal can no longer skip inspection, and survivor links now match canonical paths. Removal is still not atomic.

HEAD was `5c86a15c485d4f604d1fa5f29658efb4688b1005` on `work/core-git-safety` at the start and at the end, and the worktree was clean both times. This is source evidence only, not runtime proof. I read README, AGENTS, `state-and-evidence.md`, `.repos/effect-smol/LLMS.md` and the X-9, X-10, X-11 and U-11 cards, plus the four receipts. I made no edits, ran no tests or builds, and used no agents.

## Findings

### P2-1. A clean branch with unpushed commits can never be removed from the UI

- **Server rule:** `apps/server/src/git/worktreeLinks.ts:68-76` (`worktreeStateHasLoss`) treats any `localOnlyCommitCount > 0` as loss. It applies this to branches as well as detached HEAD. `ws.ts:2427-2435` then refuses unless `force === true`.
- **Web rule:** `apps/web/src/worktreeCleanup.ts:22-24` counts commits as lost only on a detached HEAD. A branch with unique commits gets no discard prompt, so the client sends `force: false`.
- **Trigger:**
  1. Commit in a `neokod/…` worktree and don't push.
  2. Delete the thread and accept the single confirmation.
  3. The server refuses with "Confirm the discard…".
  4. The client re-inspects, finds the same state and shows "Thread deleted, but worktree removal failed". The UI never offers the discard step.
- This is the normal case for agent work. It fails closed, so no data is lost, but cleanup does not work.
- **Duplicated policy:** the loss rule is now written twice and disagrees. The equality check is also duplicated (`worktreeGitStatesMatch` against `worktreeStatesEqual`).
- **Test gap:** neither the server test nor the web test covers a branch with unique commits.

### P2-2. The server now passes `--force` when the only loss is ignored files or commits

- **Location:** `ws.ts:2463-2466` sends `force: hasLoss`.
- `git worktree remove` without `--force` already deletes ignored files; the worker's receipt says its git fixture confirmed this. Git's force check also ignores commit reachability.
- Without `--force`, git does its own last-moment check for changed and untracked files. Passing `--force` here switches that check off for almost every JavaScript worktree, because nearly all have `node_modules/` or `.env`.
- **Trigger:**
  1. A worktree has ignored files.
  2. A terminal job, an editor or an external tool writes a tracked change or a new file after the server's fresh inspection.
  3. `--force` deletes that write. Plain `git worktree remove` would have refused.
- **Fix:** git's force flag should be `changedFileCount + untrackedFileCount > 0`. Discard consent is a separate rule and should stay as it is.

### P2-3. The survivor check misses workspaces nested inside the worktree

- **Location:** `worktreeLinks.ts:45` uses identity equality only.
- **Trigger:** a project whose `workspaceRoot` is `<worktree>/packages/x` has a live thread with `worktreePath: null`.
- Deleting the worktree's own thread finds no links. The dialog says this is the only linked thread, and removal deletes the surviving project's directory.
- Uncommitted files there still show in the counts. But a surviving thread loses its workspace, which is what X-9 is meant to prevent.
- This is unlikely, but the trigger is concrete.

### P2-4 (known residual). A link can still be admitted between the final check and `git worktree remove`

- **Location:** `ws.ts:2437-2466`. The semaphore at `:1302` only serialises removal RPCs.
- **Admission paths:** every link enters through `OrchestrationEngine.dispatch`, which has one queue and one worker (`OrchestrationEngine.ts:92, 318`). Projection runs inside the commit transaction. The relevant commands are:
  - `thread.create` (`decider.ts:214`), effective workspace `worktreePath ?? project.workspaceRoot`
  - `thread.meta.update` with `worktreePath` (`:315`; server caller `ProviderCommandReactor.ts:709-715`)
  - `project.meta.update` with `workspaceRoot` (`:135`)
  - `project.create` (`:108`), which only matters once a thread follows
- **Order makes it worse:** the handler inspects first, then loads the full read model and resolves every thread's path, then removes. So git evidence is the oldest evidence at the moment of deletion.

## Smallest correct coordination

An in-process lease shared by the orchestration worker and removal is enough for read-model links. External writers cannot be locked out.

1. **Lease service.** Add one small server service, for example `apps/server/src/git/WorktreeRemovalLease.ts`, with a `Semaphore(1)` gate and a set of leased identities:
   - `lease(identity)` is scoped. It takes the gate briefly to insert the identity, refuses if that identity or a containing one is already leased, and releases in a finaliser.
   - `admit(command, readModel)` returns at once when the set is empty, so there is no cost in normal use. Otherwise it resolves the effective workspace identity and rejects any path equal to or inside a leased identity with `OrchestrationCommandInvariantError`.
   - It replaces `worktreeRemovalSemaphore`.
2. **Engine hook.** In `OrchestrationEngine.processEnvelope`, for the four commands above only, run `gate.withPermit(admit → decide → commit transaction)`.
   - Any admission that passed before the lease was inserted has already committed, so the removal's read-model read sees it.
   - Any admission after the insert is rejected.
3. **Removal order** in `ws.ts`:
   1. Check `expectedState` and the path identity.
   2. Take the lease.
   3. Load the read model and check links (including nested workspaces, P2-3).
   4. Run the fresh git inspection and compare it with the expected state.
   5. Compute discard consent and git's force flag separately (P2-1 and P2-2).
   6. Pass `expectedHeadSha` to the driver, which re-runs `rev-parse --verify HEAD` immediately before `worktree remove` and refuses on a mismatch.
   7. Remove, then release the lease.
4. **One shared rule.** Move the loss and consent rule, state equality and containment into `@neokod/shared/git` and use them from both `ws.ts` and `worktreeCleanup.ts`. Delete the duplicates.
5. **Symphony.** No change. `Manager.ts:269` stays guarded by `WorkspaceRemovalGuard`.

### Acceptance checks

- A clean branch with unique commits gets one confirmation, removes with `force: false`, and keeps the branch.
- A worktree with ignored files only is removed after consent without `--force`.
- In a git fixture, a tracked edit made after inspection makes a no-force removal fail and the file survives.
- A server test holds the lease and shows that `thread.create` and `thread.meta.update` pointing at that path or a subdirectory are rejected, and that unrelated commands still pass.
- A test enqueues an admission just before the lease and shows that removal sees the link and refuses.
- A nested-project survivor blocks removal.
- A detached HEAD that moves before the driver call is refused.
- `vp check` and `vp run typecheck` pass.

### Remaining limits (not claimed as fixed)

- Writes and commits by processes outside the orchestrator (terminal jobs, editors, external git) can still land in the last milliseconds between git's own check and its delete. A detached commit made in that window becomes unreachable. Neokod cannot close this atomically.
- The engine admission check adds `realpath` calls while a lease is active.
- Windows case-folding has not been run.

Other items checked with no finding:

- Ignored files are counted and shown in the loss prompt.
- Count parsing is strict, and branch reclaim uses full `refs/heads/…` refs with compare-and-delete.
- X-10: resolved merge, cherry-pick and revert stay committable in the web UI.
- The unmerged-paths guard in `pushCurrentBranch` also covers `publishRepository` and Symphony PR creation, which stops before writing the PR body.
- A selected-file commit is refused during merge, cherry-pick or revert before the `git reset`.
- Operation-state lookup uses a single `--git-dir` call, so newline paths no longer break it.
- A successful deletion is kept as success when cleanup fails, and the warning names the kept path.

This session is in Plan mode. Switch agents if you want these fixes implemented.
