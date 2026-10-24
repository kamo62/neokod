**FIX** at `3b467710945af04549fcf477d4b5fc6c9573d675` (`feat/neokod-turn-outcomes`, base `1eee19299`).

This was a read-only review: no edits, tests, builds, installs, browser use, signals or commits. I'm running as `claude-opus-5-5`; I can't confirm the reasoning-effort setting myself, so check that in modelUsage. I couldn't write the plan file because this session has no write tool.

## What holds

- **Ownership:** the diff touches exactly the 14 files on the allowlist. There is no migration, lockfile change or install.
- **Contract:** `latestTurnOutcome` is `Schema.optional(completed | interrupted | error)` on both the command and the payload. `null` is rejected, an omitted field keeps the old behaviour, and `latestTurnCompletedAt` can still be an explicit `null`. The command is internal-only.
- **Decider:** it rejects an outcome that has no `interruptedTurnId`, using `OrchestrationCommandInvariantError`.
- **Ingestion:** the mapping is exhaustive over `RuntimeTurnState`, and the outcome is attached only when `turn.completed` has a known `endedTurnId`. It adds no new fallback.
- **Shared resolver:** all three projections use it. A delayed outcome for an old turn leaves the newer session and its active turn alone in SQL (`ProjectionPipeline.ts:1054-1065`), in the server projector and in the client reducer. Other running turns are not settled broadly, and a late `running` update doesn't reopen a settled turn.
- **Messages and checkpoints:** in SQL, these already kept a settled turn's state and closure time before this patch. The report presents that as new work; it isn't, though it isn't a blocker.

## Blockers (both are inside this fix and introduced by it)

**1. The live client turns a real completion after Stop into "Interrupted". This is a regression, and the report is wrong that fixing it needs new provenance.**

- `thread.turn-interrupt-requested` marks the turn `interrupted` straight away, and the session stays running that turn (`threadReducer.ts:166-190`).
- When `latestTurnOutcome: "completed"` arrives for the same turn, `resolveExplicitSettledTurnState` returns `null` for interrupted→completed (`orchestrationTurnOutcome.ts:62-73`). The turn stays `interrupted`, while SQL records `completed`. The base code got this right through `sessionRunsTurn`.
- If the interrupt fails, `preserveTerminalRunningTurn` also stops a later `running` update from reopening the turn. That breaks the reducer's own rule that "a failed interrupt must not freeze the turn here."
- **Fix (in `threadReducer.ts` only):** treat a settled-looking latest turn as provisional while `sessionRunsTurn(thread.session, turnId)` is true. Pass `"running"` to the resolver in that case, and leave it out of `preserveTerminalRunningTurn`. The session identity the reducer already has is enough to tell a provisional Stop from a real settlement; no provenance is needed.
- **Tests to add:**
  - Stop then `completed` ends as `completed`.
  - Stop then `interrupted` ends as `interrupted`, timed at the session time.
  - A failed Stop then `running` for the same turn reopens the turn.

**2. Correcting an inferred completion leaves two different completion times for one turn.**

- SQL (`ProjectionPipeline.ts:1173-1179`), the server projector (`projector.ts:502-513`) and the client (`threadReducer.ts:350-363`) all overwrite `completedAt` with the time of the correction.
- The settlement outbox keeps the first time (`ON CONFLICT DO NOTHING`). It republishes that time through `thread.turn-settled`, which the client writes back into `latestTurn.completedAt` (`threadReducer.ts:379-397`). The ChatView timeline reads that settlement record (`ChatView.tsx:1437`).
- The result:
  - the timeline and the latest-turn banner show different times;
  - the live latest turn can switch between the two times depending on when the reactor publishes;
  - the live view and the view after a reload disagree.
- This breaks the existing rule that a settled turn keeps the completion its settlement published. The SQL test only counts settlement rows, so it never sees the mismatch.
- **Fix:** when the turn is already settled, change only its state and keep the existing `completedAt`. That also makes the same-state branch at `orchestrationTurnOutcome.ts:70` harmless for repeated outcomes.
- **Tests to update or add:** expect the inferred time in all three projections, and assert that the settlement row's `completedAt` equals the turn row's `completedAt`.

## Separate follow-ups (not blockers)

- There is still no durable way to record an unknown outcome.
- Legacy emitters still infer `completed`: steering over a running turn (`ProjectionPipeline.ts:1197`), a turn-start failure that sets `ready`, and a mid-turn `session.state.changed: ready`.
- Moving the outbox row to a later authoritative time would need new outbox update rules, which is new storage design and outside this fix.
