I'll start by inspecting the current state of the worktree and the required docs.Baseline is green. Now I'll add the P2 regression first, which uses only existing source.Now the P1 lane: first a behavior-preserving extraction of the queued mutation preparation so the regression can drive the same boundary useSettings uses.Both regressions now pass. Let me run the focused affected suites together.All focused checks pass. Staging only the five touched files and committing with hooks enabled.Implemented and pushed `work/core-u04-review-fix`.

## Commit

`9e0fe1fff fix(settings): reject stale secret references in queued updates [skip ci]`

Remote: `origin/work/core-u04-review-fix` advanced from `e71ab3c0b` without force.

## Changes

- `apps/web/src/hooks/settingsMutation.logic.ts`
  - Added `prepareServerSettingsMutation`, the now-shared preparation step for the `useSettings` queue.
  - It selects the authoritative base (streamed or acknowledged revision), then validates every sensitive `valueRedacted: true` provider-environment reference against that base environment.
  - Stale references reject the queued mutation before `persistServerSettings`, so no server secret-store cleanup runs.
- `apps/web/src/hooks/useSettings.ts`
  - Queue dispatch now goes through that preparation boundary and records a normal settings failure on rejection. Pending count, failure revision, and recovery behaviour are unchanged.
- `apps/web/src/components/settings/providerEnvironmentDraft.ts`
  - Reconciliation no longer materialises `valueRedacted: false` on a pristine row with no stored link. Blank rows added with Add now stay pristine through reconciliation.
- Added regressions in `settingsMutation.logic.test.ts` and `providerEnvironmentDraft.test.ts`.

## Regression evidence

- P2 on current source: `keeps a pristine blank row publishable through reconciliation` failed with the blank row gaining `valueRedacted: false` (`p2-fail.log`). Passes after the fix.
- P1: the regression drives `A stored -> replace with B acknowledged -> queued redacted A`. Before the guard it failed with `expected 'acknowledged' to be 'rejected'` (`p1-fail.log`); after the guard it shows stale A rejected and B still stored.
- Chronology note: I first extracted the queue preparation behaviour-preservingly so the regression could drive the actual dispatch boundary. The P1 failing assertion was recorded against that extraction before the guard, not against pristine `e71ab3c0b`.

## Checks

- Focused web tests: 4 files, 41 tests passed (`providerEnvironmentDraft`, `ProviderInstanceCard`, `settingsMutation.logic`, `useSettings`).
- `apps/web` `tsgo --noEmit`: clean.
- Scoped `vp lint`: clean.
- Scoped `vp fmt --check`: clean.
- `git diff --check`: clean.
- Commit hook ran `vp fmt` successfully.

Logs are under `/tmp/neokod-core-symphony-2026-10-21/acp/lane-secret-queue-fix-*.log`.

## Limits

- No server changes were required; `serverSettings.ts` is untouched.
- No real secret store, runtime, browser, Playwright, build, install, or root checks were used.
- The regression simulates server persistence and acknowledgement around the real queue preparation; it does not run the React component queue in a browser.
