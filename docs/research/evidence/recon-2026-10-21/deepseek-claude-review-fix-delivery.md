# DeepSeek ACP correction: claude-review-fix

Worker report. Subsequent integration and review status are in plan.md section 16.8.

Now I understand the flow. Let me implement the usage helper changes first.Tests pass. Now let me capture fail-first evidence by temporarily restoring the old behaviours in owned source files.Implemented and pushed the fix.

## Changes

**`ClaudeUsageLimit.ts`**

- `providerLimitFromRejected` now treats any live unknown-reset rejection as authoritative: it never borrows a sibling window's known reset, so `applyClaudeLimit` cannot expire the whole limit while an unresolved rejection remains.
- `latestRejectedResetSeconds` likewise returns `undefined` when any rejected window has an unknown reset.
- Added `pruneExpiredRejectedRateLimits` to drop only known-expired windows and keep unknown-reset evidence.

**`ClaudeAdapter.ts`**

- `onRateLimitChange` now reports a single per-window change (`status`, `rateLimitType`, `resetsAtEpochSeconds`) instead of one session's whole map.
- A completed turn clears only the windows that session had observed rejected, as per-window `allowed` reports. Abort/failure paths are unchanged.

**`ClaudeDriver.ts`**

- Retains `RejectedRateLimits` per provider instance in a `SubscriptionRef`, merging per-window reports from every session.
- Polling (`enrichSnapshot`) re-projects the retained evidence against the current clock and prunes known-expired windows, so unknown-reset evidence survives until an explicit allowed report or driver/instance recreation.

## Regression evidence

Fail-first, captured against temporarily restored old behaviour:

- Old aggregate projection failed: `does not borrow a sibling window's known reset for an unresolved rejection` produced `{window: five_hour, resetsAt: ...}` instead of unresolved `seven_day_opus`.
- Old replacement semantics failed: session B's `five_hour allowed` erased session A's `seven_day_opus` limit (`undefined`); the mixed known/unknown test also failed to publish the unresolved limit.
- Logs: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-claude-review-fix-failfirst-usage.log`, `...-failfirst-driver.log`.

Passing checks on the committed tree:

- Focused tests: 3 files, 123 tests passed.
- `tsgo --noEmit` in `apps/server`: exit 0.
- Scoped `vp lint` on the six owned files: exit 0.
- `git diff --check`: exit 0.
- Logs: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-claude-review-fix-{tests-final,tsgo-final,lint-2}.log`.

## Commit / remote

- Commit `089c6b86481b04b0a46be59501e1f1308e509546`
- Pushed to `origin/work/core-claude-recovery` (`c288fe0e1..089c6b864`)
- Working tree clean; only the six owned Claude adapter/driver/usage files were changed.

## Limitations

- No application launch, real Claude CLI traffic, full suite, root checks, or builds were run per lane constraints.
- Driver retention tests inject the adapter's per-window callback through a mocked adapter; the real adapter callback is covered separately in its own tests.
- Instance/settings recreation is handled by the existing registry `create()` lifecycle, not separately exercised here.
