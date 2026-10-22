# Sol review: checkpoint-r19 (work/core-checkpoint-recovery @ ffbb72575)

## Verdict: CHANGES-REQUIRED

## Findings

### [P2] Include Git’s default global ignore file in preservation evidence

**File:** `apps/server/src/orchestration/Layers/CheckpointReactor.ts:529-538`

When `git config --path --get core.excludesFile` returns exit code 1, the guard records no global ignore file. Git still uses `$XDG_CONFIG_HOME/git/ignore`, or `$HOME/.config/git/ignore` when XDG_CONFIG_HOME is unset or empty.

Concrete failure:

1. The workspace is `R`, with `XDG_CONFIG_HOME=R/.config` and no explicit `core.excludesFile`.
2. The checkpoint contains an empty tracked `.config/git/ignore`.
3. Its current contents are `secret.txt`, and an untracked `R/secret.txt` contains valuable data. No `.gitignore` supplies that rule.
4. Ignored-file enumeration finds `secret.txt`, but the guard never compares `.config/git/ignore` with the checkpoint. There is no tracked-path collision, so it permits the revert.
5. Recovery capture excludes `secret.txt`. Restore empties `.config/git/ignore`, and the subsequent `git clean -fd` deletes `secret.txt`.

The file is lost and absent from the recovery snapshot. This requires no concurrent external writer. A home-directory/dotfiles workspace can encounter the same failure through Git’s default HOME path.

**Suggested fix:** Resolve the effective global ignore path, including Git’s documented XDG/HOME default when the configuration is absent, and apply the existing identity and preservation checks to it. Add a temporary-repository regression with no explicit `core.excludesFile`, a default ignore file inside the workspace, and a checkpoint that removes its protective rule.

## Card acceptance

| Acceptance criterion                                                                               | Status                          | Evidence                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save the current tracked and untracked non-ignored files before restore                            | **Met, source-level**           | Recovery capture precedes `restoreCheckpoint`; the regression at `CheckpointReactor.test.ts:1621` checks saved contents, including a subsequently deleted scratch file.                               |
| Capture failure aborts without restore, conversation rollback or checkpoint deletion               | **Met, source-level**           | Failed capture returns before those operations; dedicated regression at `CheckpointReactor.test.ts:3082`.                                                                                             |
| Refuse active or admitted work in the same or overlapping folder                                   | **Met, source-level**           | Reservation covers fresh session and durable turn reads through completion. Tests cover admission ordering, parent/child overlap, moved workspaces, archived threads and pending-to-running handover. |
| Permit idle sessions and active sessions in unrelated folders                                      | **Met, source-level**           | Activity requires running/connecting status or an active turn; corresponding allow-case regression at `CheckpointReactor.test.ts:3067`.                                                               |
| Retain the recovery reference and recovery activity after revert                                   | **Met, source-level**           | Recovery activity has `turnId: null`; stale-ref deletion selects later checkpoint refs only. Serial and restart uniqueness regressions are present.                                                   |
| Confirmation truthfully describes file reset/deletion, other-thread impact, chat loss and recovery | **Met, source-level**           | `buildRevertCheckpointConfirmMessage` is wired into the confirmation caller and includes these consequences plus staging behaviour.                                                                   |
| Preserve ignored files or refuse when preservation cannot be established                           | **Not met**                     | Explicit `core.excludesFile` is covered, but its implicit default is omitted, allowing the data-loss scenario above.                                                                                  |
| Required regression execution and repository checks pass                                           | **Unverifiable in this review** | Tests were inspected, not executed. `vp` is unavailable on this shell’s PATH. Exact-range `git diff --check` passed.                                                                                  |

## Notes for integrator

- Reviewed the requested base-to-branch diff and commit range. No repository files were changed.
- The round-18 ordinary-project branch-rename correction is present: non-null admission workspace alone no longer establishes managed-worktree eligibility.
- `work/turn-timing-evidence` also changes `ProjectionPipeline.ts`, its tests, the integration harness, migration registration/tests and `ChatView.tsx`. Preserve admission-workspace propagation and identity-scoped pending settlement when integrating its turn-settlement changes.
- External Git/editor writers remain outside the accepted in-process lease guarantee. The finding above occurs without that limitation being exercised.
