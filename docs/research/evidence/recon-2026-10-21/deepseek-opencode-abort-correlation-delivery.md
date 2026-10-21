I'll start by reading the review finding and the current adapter/test code.Now I understand the protocol limits. The installed SDK's `session.error`/`session.status` events carry only `sessionID` (no turn/message id), and v1.18.15 publishes the abort's `MessageAbortedError` and idle before `session.abort` resolves. I'll preserve turn attribution with an abort-echo ledger that survives the next turn's admission and drains on the new turn's own stream progress, rather than clearing on `sendTurn`.Focused tests pass. Now I need to prove the new regression fails against the pre-fix adapter. I'll temporarily restore the committed adapter from HEAD, run the focused tests, then restore my version.The current barrier clears on the next turn's `busy`/user message even if that event predates the abort echo. I'll tighten it: hold the marker until a terminal echo has actually been observed, then release on the next new-turn stream event. That keeps the ordering proof sound while still handling idle-first/error-first echo orders.Finding 5 was real, and the old test at line 1117 codified it. I fixed it in `OpenCodeAdapter.ts`/`.test.ts` only and pushed the existing branch.

**Before**

- `sendTurn` cleared `abortRequestedTurnId` on every fresh turn.
- A delayed `MessageAbortedError`/`idle` from the aborted turn was therefore attributed to the new turn: error failed it, idle completed it.
- The old test expected the new turn to fail with `Aborted`.

**After**

- The abort mark survives admission of the next turn and is now per-session.
- A terminal `MessageAbortedError` or idle belonging to the earlier aborted turn is consumed without settling the active turn, and sets `abortTerminalObserved`.
- The mark is released only when the new turn produces an event that can only belong to it (its user-message update or `busy` status) _after_ a terminal echo was observed. This uses the ordered event stream, not a timer or blanket error suppression.
- A `MessageAbortedError` matching the active turn still settles it interrupted; genuine errors still settle the active turn as failed; unrequested aborts still fail; `"adapter"` retry aborts keep working.
- Cross-session masking is unchanged: all state is per `OpenCodeSessionContext` and events are already filtered by `sessionID`.

**Protocol evidence**

- Installed `@opencode-ai/sdk` 1.18.15: `EventSessionError` (`types.gen.d.ts:518`) and `EventSessionStatus`/`EventSessionIdle` carry only `sessionID`; `MessageAbortedError` carries only `name` + `data.message`. There is no turn id to correlate on.
- Pinned upstream `v1.18.15`: `SessionStatus.set` publishes status then idle; the processor’s interrupt path publishes `session.error` then idle; `runLoop` sets `busy` at start and the user message is updated before it. That is the ordered drain point the adapter now uses.

**Regression proof**

- Replaced the bug-codifying test with two tests: late abort error and late idle, both after prompt 2 is admitted. The error test also injects a stale pre-abort `busy` to prove it cannot release the mark early.
- Against the committed pre-fix adapter: both tests fail (`2 failed | 26 passed`).
- With the fix: `28 passed (28)`, run three times plus once after commit.
- The error test then delivers a genuine second-turn error and asserts exactly one failed completion for turn 2; the idle test then delivers turn 2’s own busy/idle and asserts normal completion, not interrupted.

**Checks run**

- `vp test run src/provider/Layers/OpenCodeAdapter.test.ts`: pass.
- `apps/server` `vp run typecheck`: exit 0; no `OpenCodeAdapter` diagnostics (only pre-existing Effect suggestions elsewhere).
- Scoped `vp fmt --check` and `vp lint --report-unused-disable-directives`: pass.
- `git diff --check`: pass.

**Commit**
`ea285ff08 fix(opencode): keep late abort echoes on the aborted turn [skip ci]`, pushed non-force to `origin/work/core-opencode-stop-order` (`c76f08d49..ea285ff08`). Hooks ran.

**Limits**
This is client-side abort-ledger attribution plus ordered-stream drain, not protocol turn ids, because none exist. It assumes one ordered SSE connection and that an abort publishes at least one terminal echo before `session.abort` resolves. A genuinely external abort of the new turn arriving before that turn’s first event would be indistinguishable from the old echo; Neokod-initiated cancels set the mark to the active turn and settle normally. No live provider, browser, user data, build, root check, or install was used.
