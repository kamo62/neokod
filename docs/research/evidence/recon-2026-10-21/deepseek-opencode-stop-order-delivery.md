Now I'll add the regression test against the current source, before fixing.The regression fails on current source at the expected point: idle settlement emits the interrupted terminal but leaves the pending approval unresolved (0 vs 1). Now I'll fix the adapter's idle closure.Done.

**Commit**: `c76f08d4969311fd088fd349d24de2804d21b78e` (`fix(opencode): settle interrupted turns before abort response [skip ci]`)
**Branch**: `work/core-opencode-stop-order`, pushed to `origin`, remote SHA matches local. Never touched `dev` or `main`.

**Changed files** (only these two):

- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`

**Behaviour fix**

- The `idle` abort echo now routes through the shared `settleInterruptedTurn` closure, passing the observed turn id, so the first echo resolves pending permissions and questions, clears turn state, and emits exactly one `turn.completed` with `interrupted`.
- A later `MessageAbortedError` or a post-`session.abort` settlement sees no active turn and returns `false` without a second terminal event, duplicate request resolution, or synthetic `runtime.error`.
- Natural idle with no Stop request keeps the existing `completed` path.
- `settleInterruptedTurn` now returns whether it actually settled and accepts an expected turn id, so a stale echo cannot clear a newer turn.

**Regression test**

- Active turn plus pending approval and question.
- `idle` is delivered while `session.abort` is still blocked.
- Asserts one interrupted terminal event, both requests resolved exactly once, pending maps no longer actionable, then releases the abort response and delivers the late `MessageAbortedError`.
- Re-asserts one terminal event, one resolution each, no `runtime.error`, session `ready`, no active turn.

**Chronological evidence**

1. Pre-fix, corrected regression run failed on unmodified source: `idle settlement must resolve the pending approval once`, actual `0`, expected `1`.
2. Post-fix focused test passed: `1 passed`.
3. Full focused adapter suite passed: `27 passed`.
4. Server `vp run typecheck` (tsgo) exited `0`; repo-wide pre-existing Effect suggestions remain, none in the changed files.
5. Scoped `vp fmt` and `vp lint` on both files clean.
6. `git diff --check` exited `0`.
7. Commit hooks passed (`vp fmt` on staged files).

**Limits**

- No root `vp check`, full repo suite, builds, installs, app/provider/browser/live process launch, or `.repos` edits.
- Verification is source and fake-SDK level only; no live OpenCode process evidence.
