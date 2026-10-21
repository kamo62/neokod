Implemented and pushed to `work/core-opencode-cleanup`, range `3523b5478..57f8fe07c`.

## Commits

- `b7296b08a3a0ccb5c8667a94d767bcfa82fbc20c`  
  `fix(opencode): verify birth identity before every shutdown signal [skip ci]`
- `57f8fe07c77404228189be927ea970fb62f87e16`  
  `fix(opencode): keep evidence when an orphan owner is unobservable [skip ci]`

## Changes

`opencodeRuntime.ts` now validates the recorded leader birth identity before both SIGTERM and SIGKILL. Reused, missing, or unverifiable identity sends no signal, logs the reason, and leaves ledger retention to the existing confirmed-exit forget path.

`OpenCodeServerLedger.ts` now distinguishes `present`, `absent`, and `unknown` process evidence. Linux `ENOENT` maps to absent while other read failures map to unknown; macOS uses `ps` exit status and output to separate absence from a failed probe; unsupported platforms report unknown. Orphan reconciliation only reaps after the owner is confirmed absent, zombie, or replaced. An unobservable owner keeps the entry and its child is not signalled.

## Fail and pass sequence

1. Baseline focused ledger and runtime tests: 32 passed.
2. Added and updated runtime regressions: 3 failed, each receiving `SIGTERM` where `[]` was required.
3. Runtime fix applied: 16 runtime tests passed.
4. Added unknown-owner ledger regression: failed with `SIGTERM` and a retained-row assertion not reached.
5. Ledger fix applied: 18 ledger tests passed.
6. Final focused run: ledger 18, runtime 16, OpenCode adapter 26, total 60 passed.

## Verification

- `pnpm exec tsgo --noEmit` in `apps/server`: exit 0, zero errors. Existing suggestion diagnostics remain in unrelated files and pre-existing spots.
- `vp fmt --check` on the four changed files: pass.
- `vp lint` on the four changed files: pass.
- Commits ran with hooks enabled. No force push.
- No SDK, CLI, package manifest, or lockfile changes.

## Limits

- Tests use fake inspectors and fake process signallers only.
- No real `/proc`, `ps`, process signalling, provider, browser, app run, build, install, or root checks were performed, following the stated boundaries.
- The macOS `ps` absence semantics were implemented from the existing probe contract, not verified against a live process on this host.
