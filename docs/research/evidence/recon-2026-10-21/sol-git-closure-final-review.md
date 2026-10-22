I’ll pin the checkout, read the listed guidance and review receipts in full, then trace the destructive boundaries and callers. This will be source-only: no edits, tests or runtime actions.HEAD matches `5c86a15c4`, and the worktree is clean. The closure adds fresh RPC checks, but its semaphore only serialises removals. I’m tracing admission and workspace writes to determine the remaining race and the smallest contract that could close it.I found a definite regression: the server treats unique commits on a retained named branch as discarded work, while the client correctly asks for discard consent only for detached commits. Clean worktrees with unique branch commits therefore cannot be removed through the normal UI.

The source also still permits admission and detached-commit races after the final checks. The current ownership API is a cross-mode check, not an exclusion lease.## Closure result: 3 P1 and 3 P2 findings remain

Reviewed `3e5b05f31..5c86a15c4` and the original U11/X9–X11 callers. I would not close the lane yet. No P0 identified.

### 1. [P1] Removal still races authoritative thread admission

**Locations:** `apps/server/src/ws.ts:2437–2466`; `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:165–227,318–335`; `apps/server/src/vcs/GitVcsDriverCore.ts:2914–2923`.

**Trigger:** After removal reads a snapshot containing no surviving links, another command successfully creates or attaches a thread to that worktree before `git worktree remove` executes. The removal semaphore does not participate in orchestration admission, so removal still proceeds. With previously authorised discard, the new thread’s workspace can be force-removed.

The detached-commit variant also remains: a clean detached commit created after the fresh inspection is not checked by Git’s worktree removal. Comparing the full HEAD closes changes made while dialogs are open, not this final check/use window.

**Required correction:** Coordinate admission and removal at the server’s authoritative admission boundary, not through another removal-only check. See the scoped contract below.

### 2. [P1] Case aliases still bypass surviving-thread protection on macOS

**Locations:** `apps/server/src/vcs/WorkspaceIdentity.ts:40–45,57–63`; `apps/server/src/git/worktreeLinks.ts:33–45`.

**Trigger:** On a case-insensitive macOS filesystem, a surviving thread uses `/…/Worktree` while cleanup targets `/…/worktree`. The resolver folds case only on Windows. Effect delegates to Node’s `fs.realpath`, which does not perform case conversion, so resolving symlinks does not make these identities equal.

Both inspection and the destructive check can miss the surviving thread.

**Required correction:** Use same-file identity for existing targets, such as filesystem device/inode evidence where available. Preserve the existing-parent handling for absent targets. Do not simply lowercase every macOS path, since case-sensitive volumes must remain distinct.

### 3. [P1] The inspected physical target is not actually pinned

**Locations:** `packages/contracts/src/git.ts:159–177`; `apps/server/src/ws.ts:2381–2405,2489–2508`; `apps/server/src/vcs/GitVcsDriverCore.ts:2802–2814`.

Inspection returns the original path spelling, not an immutable physical-target identity. Removal resolves both `input.path` and `expected.path` again at removal time.

**Trigger:** Inspect a symlinked-parent path pointing to worktree A, then retarget that parent to worktree B before submitting removal. If both detached worktrees have the same HEAD and loss counts, both path resolutions now identify B and every comparison passes. B can be removed using consent obtained for A.

This is separate from the final TOCTOU window: the substitution can happen before the removal RPC starts.

**Required correction:** Return physical worktree/registration identity in the inspection evidence and compare that captured identity with the fresh target. Re-resolving the old path is not a comparison with the old identity.

### 4. [P2] Retained named-branch commits incorrectly require discard consent

**Locations:** `apps/server/src/git/worktreeLinks.ts:68–74`; `apps/server/src/ws.ts:2427–2435`; `apps/web/src/worktreeCleanup.ts:22–24,54–55`; `apps/web/src/hooks/useThreadActions.ts:354–361,403–410`.

**Trigger:** Delete the only thread attached to a clean named-branch worktree containing a unique commit.

The client correctly says the branch will be kept and sends `force: false`. The server treats _any_ `localOnlyCommitCount > 0` as loss and refuses removal. Reinspection returns unchanged evidence, so cleanup ends with a warning. This breaks ordinary removal of completed, unpushed worktrees even though their commits remain on the retained branch.

**Required correction:** Share one loss predicate between server and client. Commit loss requires detached HEAD, not merely unique named-branch commits. Keep Git’s force requirement separate from commit-loss consent.

### 5. [P2] A resolved merge with no tree delta still cannot be concluded

**Locations:** `apps/server/src/vcs/GitVcsDriverCore.ts:1734–1740`; `apps/server/src/git/GitManager.ts:1343–1345,1419–1420`; `apps/web/src/components/GitActionsControl.logic.ts:136–141`; `apps/web/src/components/gitActions/GitCommitDialog.tsx:58,229–234`.

**Trigger:** Resolve every merge conflict by choosing the current branch’s version, then stage the resolutions. `MERGE_HEAD` still requires a merge commit, but the index equals HEAD.

The UI disables Commit because there are no changed files. A direct full-commit request also returns `skipped_no_changes` because the staged summary is empty.

This is a remaining pre-existing X10 edge, not introduced by the closure commit. The new regressions cover a resolution that produces a tree delta.

**Required correction:** Treat a resolved pending merge as committable independently of its staged diff. Permit its full merge commit while retaining the selected-file refusal. Do not automatically apply the same empty-commit policy to cherry-pick or revert.

### 6. [P2] Failed acknowledgement is reported as proof that the worktree was kept

**Locations:** `apps/web/src/hooks/useThreadActions.ts:381–389,427–441`.

**Trigger:** Physical removal completes, but the connection fails before its acknowledgement arrives; reinspection then also fails. The warning states, “The worktree was kept,” although its existence is unknown and it may already be gone.

Returning successful thread deletion separately is correct. Claiming filesystem preservation from a failed RPC is not.

**Required correction:** Use an unknown-outcome warning when removal cannot be reconciled: “Thread deleted; could not confirm worktree removal. Check `<path>` before retrying.” Reserve “kept” for affirmative evidence of preservation.

## Smallest scoped coordination contract

The existing mechanisms are insufficient as exclusion contracts:

- The orchestration queue serialises admission commands, but removal runs outside it.
- `WorkspaceRemovalGuard.assertRemovable` reads ownership without holding anything through deletion.
- `WorkspaceOwnershipRepository.acquire` allows same-owner replacement at `apps/server/src/symphony/Persistence/Layers/WorkspaceOwnershipRepository.ts:89–101`. Its generation fences are not same-mode admission/removal exclusion.

Use the existing engine admission point to establish a narrow, identity-keyed removal reservation. Check links and install the reservation in admission order; hold it through fresh Git evidence, the cross-mode guard and subprocess settlement. Admissions must reject a reserved target and revalidate a missing or replaced target after removal. Another snapshot read alone is insufficient.

The exact participating callers are:

| Boundary                      | Callers requiring coordination                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoritative workspace links | `thread.create`, workspace-changing `thread.meta.update`, and `project.meta.update` changing root fallback: `orchestration/decider.ts:135–158,214–244,315–346` |
| Bootstrap creation/attachment | `ws.ts:1583–1629`                                                                                                                                              |
| PR worktree preparation/reuse | `GitManager.ts:1760–1803,1814–1825`; its returned path later reaches bootstrap through `ChatView.tsx:1656–1662,4296–4304`                                      |
| Internal Work-mode handoff    | `symphony/HandoffService.ts:215–257`                                                                                                                           |
| Physical removal              | Work-mode gateway at `GitWorkflowService.ts:317–345` and Symphony’s direct driver call at `symphony/Workspaces/Manager.ts:252–274`                             |

A prepared PR path is not ownership by itself. Its later attachment must validate the physical target again.

This contract can close managed admission races. It cannot exclude arbitrary external Git processes. Strict detached-commit no-loss acceptance additionally needs enforceable writer quiescence, or retention of the worktree when quiescence is unknown. Do not describe an application reservation as atomic Git/filesystem safety.

## Acceptance for the scoped follow-up

- Deterministically pause removal after its final evidence read. Concurrent create, attach and project-root changes must either win first and block removal, or be rejected without creating a stale link.
- Exercise both removal gateways, aliases, failed/cancelled removal and reservation release.
- Reject a symlink retarget between inspection and removal even when HEAD and counts match.
- Cover case variants on case-insensitive macOS, distinct paths on case-sensitive volumes, and existing-parent resolution.
- Remove a clean worktree with unique named-branch commits using one confirmation; retain its branch.
- Conclude a resolved, zero-delta merge with two parents; preserve selected-file refusal before reset.
- Lose acknowledgement after successful removal and fail reinspection; retain thread-deletion success and report the worktree outcome as unknown.

## Other requested checks and evidence limits

No additional concrete P0–P2 finding identified in the scoped X11 argv paths, lower publishing conflict guard, newline Git-directory lookup, strict commit-count parsing, or branch compare-and-delete. Ordinary symlink aliases, project-root fallback, ignored-file consent and non-empty resolved full commits are addressed in source.

All named guidance, cards and four review receipts were read in full. The worker’s passing checks are receipt evidence only; none were rerun.

Start and end HEAD were both `5c86a15c485d4f604d1fa5f29658efb4688b1005`; the worktree remained clean. No edits, tests, builds, application/browser/provider execution, child agents, commits, pushes or external messages were performed. This is source-review evidence, not runtime or atomic-safety proof.
