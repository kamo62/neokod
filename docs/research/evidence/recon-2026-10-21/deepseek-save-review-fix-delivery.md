# DeepSeek ACP lane: save-review-fix

Worker report retained verbatim. Central integration/review status is recorded in plan.md section 16.8.

I'll start by reading the repository docs and the relevant files before touching anything.Regression fails behaviourally on current code: the overwrite submitted `expectedHash: "hash-from-read"` instead of `undefined`. Now the minimal fix.Implemented and published the U-02b correction.

## Change

- `FileSaveBaseline` now tracks a private `seeded` flag, separating a never-seeded baseline from an explicitly dropped precondition.
- `clear()` marks the baseline seeded, so the panel rerender at `FilePreviewPanel.tsx:788` cannot reseed `H0` from stale optimistic/cache data before the debounced overwrite.
- `adoptInitialHash` still works before the first seed and still ignores external read hashes afterwards.
- A confirmed overwrite hash (`H1`) becomes the baseline for the next write.
- Only the two owned files changed; no caller or API changes.

## Actual verification

- **Pre-fix regression: FAIL** behaviourally, not from a missing API: overwrite submitted `expectedHash: "hash-from-read"` instead of `undefined`. Log: `lane-save-review-fix-regression-fail.log`.
- **Post-fix focused unit tests: PASS**, 3 files / 25 tests (`fileSaveCoordinator`, `FilePreviewPanel`, `projectFilesQueryState`).
- **`apps/web` `tsgo --noEmit`: PASS**, exit 0.
- **Scoped `vp fmt --check`: PASS**; **scoped `vp lint`: PASS**, exit 0.
- No builds, root checks, installs, app launch, Playwright, or `.repos`/config/auth changes.

## Commit and remote

- Commit: `f81b4cadecde30758368ec09951745f765852ee1`
- Message: `fix(web): preserve explicit overwrite across preview rerenders [skip ci]`
- Parent/base: `5e53f76b967ceb1ecb5c125fedd794dd920a2577`
- Pushed `work/core-u02b-review-fix` with upstream tracking, no force. Local HEAD, `origin/work/core-u02b-review-fix`, and `git ls-remote` all report `f81b4cadecde30758368ec09951745f765852ee1`.
- No PR opened and no merge into dev/main.
- Logs: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-save-review-fix-*.log` (summary plus per-check logs).

## Notes and gaps

- While this lane ran, dev advanced externally from `5e53f76b9` to `4c3183c9d` (`docs: track six DeepSeek lanes and dev review gates [skip ci]`). The lane commit remains based on the requested `5e53f76b9`.
- This is unit-level evidence through the coordinator and baseline. It does not prove rendered conflict-banner behaviour in a running app. UI runtime, integration, and exact-dev review remain with main.
