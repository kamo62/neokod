Now I'll implement the ledger changes.Implemented, committed and pushed.

## What changed

`apps/server/src/provider/OpenCodeServerLedger.ts`

- `track` now returns a forget effect that removes the entry **only** when `groupExists` returns false.
- A present group or an inspector failure retains the file and logs a warning.
- `stopOrphan` captures a member identity proof only when the snapshot still contains the already-validated leader, then revalidates that proof immediately before `SIGTERM` and again before `SIGKILL`.
- A gone group is treated as exited. Changed or unavailable identity skips the next signal and retains the entry with an explicit diagnostic. Repeated liveness is no longer treated as identity.

`apps/server/src/provider/opencodeRuntime.ts`

- Captures the leader's recycle-resistant birth token after spawn.
- New `terminateOpenCodeProcessGroup` reuses the existing `@neokod/shared/processGroup` signaller and birth reader: TERM, grace window, liveness check, birth-identity validation, then KILL only when confirmed.
- Signal failures are logged instead of silently ignored.
- The ledger forget effect remains the final evidence gate, so an unconfirmed shutdown keeps the entry.
- External configured server auth and the external connection path are unchanged.
- `packages/shared/src/processGroup.ts` was not edited.

Tests

- Existing graceful forget test now simulates the group being gone first.
- Added regressions for live-group forget, unknown-liveness forget, group-id reuse between TERM and KILL, and unavailable identity after TERM.
- Added runtime escalation tests with fake signaller and birth reader only.

## Chronological evidence

1. Starting branch was clean at `e2ca195d3`.
2. New regressions were run against the temporary pre-fix source (tests left in place):
   - `4 failed | 13 passed`
   - live/unknown forget returned success and deleted the entry
   - changed/unavailable identity still produced `[SIGTERM, SIGKILL]`
   - log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-shutdown-proof-before-ledger.log`
3. Fix restored; focused ledger/runtime tests passed `32/32`.
   - log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-shutdown-proof-after-tests.log`
4. Adapter/provider focused tests passed `33/33`.
   - log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-shutdown-proof-adapter.log`
5. Final focused run of ledger, runtime, adapter and provider tests passed `65/65`.
   - log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-shutdown-proof-final-tests.log`
6. `apps/server` `tsgo --noEmit` exited 0 with zero errors. Only pre-existing Effect suggestions remain.
   - log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-shutdown-proof-tsgo.log`
7. Scoped `vp fmt` and `vp fmt --check` passed; scoped `vp lint` produced no findings.
8. Commit with hooks enabled: `3523b5478 fix(opencode): verify group identity before escalating shutdown [skip ci]`
9. Pushed without force: `e2ca195d3..3523b5478 work/core-opencode-cleanup`
10. Post-commit focused tests passed `65/65`; worktree clean and local HEAD equals `origin/work/core-opencode-cleanup`.

## Remaining limits

- There is still an unavoidable check-to-signal window because this path uses numeric `pgid` signals rather than a kernel handle. Identity is revalidated as close to the signal as the existing API allows.
- The runtime holds only the leader birth token. If the leader exits while descendants keep the group alive, the runtime refuses escalation and retains evidence instead of guessing that the surviving group is original.
- On a later boot, an entry whose recorded member is already gone while its group survives remains unresolved and is retained rather than signalled. This is the existing fail-closed evidence model.
- On hosts where `ps` cannot provide a birth token, POSIX escalation sends TERM but skips KILL and retains the ledger entry.
- No live worker was inspected or signalled. Tests used only fake inspectors, signallers, spawners and temporary files. No build, install, agent run or user-data access was performed.
- No version or changelog change: this is a scoped correction on the same unmerged branch, matching the previous commit’s release-metadata scope.
