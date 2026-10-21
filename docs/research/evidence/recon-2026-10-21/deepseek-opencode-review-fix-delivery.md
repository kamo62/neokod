# DeepSeek ACP correction: opencode-review-fix

Worker report. Subsequent integration and review status are in plan.md section 16.8.

Now I'll add the failing tests first. Starting with the ledger test fixtures and cases.Fail-first confirmed: 5 failures including the ordering and retention cases. Now the ledger fix.Corrected the shared lifecycle root cause and pushed the correction.

## What changed

**`opencodeRuntime.ts`** — scope shutdown now uses one finalizer: terminate the child, then run the forget action. The forget action lives in a `Ref` filled after tracking returns, so:

- termination always precedes forgetting, closing the crash window that left a detached child with no durable record;
- a failed or interrupted `ledger.track` still terminates the child immediately after spawn;
- there is only one termination sequence, so no second signal can hit a reused pid.

**`OpenCodeServerLedger.ts`** — `stopOrphan` now reports `exited | stale | unresolved` and the reaper removes the entry only for confirmed exit or a definitive identity mismatch:

- group exit is confirmed via `groupExists` after SIGTERM and again after SIGKILL;
- failed signalling, surviving groups, zombie leaders with surviving groups, and unobservable identities retain the entry with a warning;
- unavailable inspection is never converted into a successful stop;
- stale identities are never signalled; they are forgotten with an info log.

## Fail-first evidence

Pre-fix run: **5 failed, 20 passed**. Failures included the entry being removed for a still-live group, failed signalling, and unavailable inspection, plus the ordering assertion showing `forget` before `terminate`.

Post-fix: **67 passed across 5 focused files** (ledger, runtime, OpenCode adapter, OpenCode provider, OpenCode text generation).

## Checks

- `vp test run` on the 5 focused files: 67 passed
- `tsgo --noEmit` (apps/server): exit 0, 0 errors
- `vp fmt --list-different` on the 4 files: clean
- `vp lint` on the 4 files: exit 0

## Commit

`e2ca195d30612dcba5164d26f6becb6deb13bebd` on `origin/work/core-opencode-cleanup`, hooks enabled, non-force push.

Logs are under `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-review-fix-*.log`.

## Limitations

- No real process inspection, signalling, or OpenCode spawn was exercised; the fake inspector and fake spawner cover the behavioural cases only.
- No end-to-end crash test; the crash window is covered by the finalizer ordering assertion.
- The zombie-leader-with-live-group case retains evidence, which is deliberate but may delay cleanup until the zombie is reaped or the group exits.
