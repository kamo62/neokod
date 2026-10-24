# Outcome guard correction review (5e4ccac23)

Verdict: FIX (narrow). The committed correction closes R1/R2 for the live path and for lockstep replay. It does not hold when the threads projector replays behind the sessions and turns projectors, which the new bootstrap comment claims to handle.

Reviewer: github-copilot/claude-opus-5.5 (Copilot fallback after the native Opus session limit). I can't confirm the "high" effort setting from inside the session.

Scope: `9874ed395..5e4ccac23` and the full lane `1eee19299..5e4ccac23`. I also read `sol-outcomes-verified-review.md` and `opus-outcomes-final-review.md`. This was read-only: no edits, tests, builds, installs, signals, commits, pushes or delegation. The only file written is this review.

Working tree note: the tree was clean when I started at HEAD `5e4ccac2305051fa6300b1484fe287f34b123deb`. During the review, uncommitted changes appeared in `ProjectionPipeline.ts` and `ProjectionPipeline.test.ts`. They were not mine. I reviewed the commit and assess the WIP separately below. I did not touch it.

## Verified in the commit

- **R2 side effects are guarded in every SQL projector.** `thread.session-set` is handled only by the threads, thread-sessions and thread-turns projectors. All three now check admission first (`ProjectionPipeline.ts:793`, `:1100`, `:1172`). A rejected stale `running A` no longer supersedes B, consumes B's pending start, attaches the pending message to A, records a false B settlement or moves the pointer. The extended A/B test asserts all of these.
- **R1 SQL pointer.** A stale `running A` after B has settled is now rejected by the threads projector (A's row is terminal and the session isn't running A), so the pointer stays on B.
- **Live decisions agree.** Per event, the projectors run in a fixed order (sessions, then turns, then threads) inside the command transaction (`OrchestrationEngine.ts:205-216`).
  - If sessions accepts, the session row becomes `running X`. The later guards then see `sessionRunsTurnIdentity` and accept.
  - If sessions rejects, nothing changes, so the later guards see the same inputs and reject.
  - The explicit-outcome branch also stays consistent.
- **Lockstep bootstrap.** Replaying once in event order gives a full rebuild from zero the same as-of state as live. The old projector-by-projector bootstrap evaluated the sessions guard against empty turn rows. If bootstrap fails partway through an event, earlier projectors sit at N and later ones at N-1. Replay then matches live order, so it is equivalent.
- **First settlement time stays fixed.**
  - SQL keeps `completedAt` once a turn is terminal: session settle at `:1216-1218`, message at `:1383-1387`, checkpoint at `:1508-1510`. Supersession only touches rows that are still running.
  - The outbox keeps the first write.
  - Pure (`projector.ts:514-518`) and client (`threadReducer.ts:381-386`) match, and the client stores `thread.turn-settled` exactly as received.
- **An explicit old terminal outcome settles only its own row.**
  - While B is active, the sessions guard rejects it (current B, target A, incoming active null).
  - Turns resolves only the pinned A row through `resolveExplicitSettledTurnState`.
  - Threads keeps the pointer because ingestion sends `activeTurnId: null` on `turn.completed`.
  - Pure and client also leave latest B alone, because the target doesn't match.
- **Provisional client Stop.** The interrupt request leaves the session running, and `currentLatestIsProvisional` resolves against `running`.
  - Explicit completed, error or interrupted outcomes apply with the session time, or `latestTurnCompletedAt` when present.
  - Legacy `ready` gives completed.
  - A failed Stop resumes on a later running update (`preserveTerminalRunningTurn` is false while provisional) or on streaming output (`turnStillRunning`).
  - SQL ignores the request (`:1459-1465`), so the actual result wins.

## FIX: the guard is unsound when the threads projector lags

`appliesSessionSetEvent` (`:1057-1081` in the commit) reads the session row and the turn row, both owned by other projectors. If threads replays behind them, it judges old events against future rows.

Sequence (no pointer-preserving checkpoint):

1. `running X` is accepted live.
2. Later, `ready` is set with X settled.
3. The threads cursor is rewound or lags behind sessions and turns.
4. Replaying (1), threads sees X as terminal and the session as ready, so `shouldApplySessionUpdate` rejects it. `latest_turn_id` is never set to X.
5. Event (2) has `activeTurnId: null`, so it doesn't repair the pointer.
6. A checkpoint for X only repairs it if the pointer is null. Because of `shouldReplaceLatestTurnPointer` (`:820`), any older pointer stays.

The result is a stale or null latest turn after a threads-only catch-up. Before this commit, the threads projector's pointer write didn't depend on other projectors' rows. The new bootstrap comment says it keeps as-of evidence consistent "during an independent catch-up", which is only true when cursors are in lockstep. The WIP test's rewound-threads scenario shows the failure against the committed code (by reading, not run).

No current production path creates this skew: live is atomic, bootstrap partial failure stays ordered, and no migration resets one projector. The turns projector already reads future session rows in its message and checkpoint handlers (`:1369`, `:1470`), so skew was never safe. Still, this commit adds a new, silent dependency and documents the opposite.

Required correction (choose one):

1. **Preferred, smallest:** make the coupling an enforced invariant.
   - Treat `threadSessions`, `threadTurns` and `threads` as a group that must be rebuilt together.
   - In bootstrap, accept only the skew the pipeline can create: cursors non-increasing in projector order and at most one event apart. Otherwise fail with an explicit error that says to clear and reset the group together.
   - Fix the comment.
   - Turn the WIP rewind test into an assertion of that failure.
2. **If self-healing lagging replay is wanted:** use sequence evidence (store the settling event's sequence on the turn row and compare it with `event.sequence`). This needs a migration.

Do not use the uncommitted time heuristic (`event.occurredAt < turn.completedAt`, treated as running):

- **Explicit `null` completion:** these terminal turns (recovery with no observation) skip the heuristic, so the lag defect remains.
- **Mixed time sources:** `completedAt` can come from session time, the recovery observation (`latestTurnCompletedAt`), the message's `updatedAt` or the checkpoint's `completedAt`. Comparing any of these with `occurredAt` assumes one clock and one ISO format, and the comparison is lexical.
- **Live behaviour changes:** it also affects the live sessions guard, which was already verified. If `completedAt` is later than the stale event's `occurredAt`, a stale running event would reopen the session.
- **Partial coverage:** it doesn't address future session rows.

## Remaining limits (not blocking)

- **Pure and client still reopen a stale `running A` after B (R1).** They check against latest B, so the guard admits A. The live UI can show A as working until the next turn or a reload; SQL and ingestion stay correct, since ingestion reads SQL.
  - The smallest complete fix would be at ingestion: drop a `turn.started` whose SQL turn row is terminal unless the session runs it. The stale event would then never be persisted.
- **An explicit old outcome with no active turn still changes the session.** For example, a late failed `turn.completed` for A after B settled sets the session to `error` with A's `lastError`. This was already the behaviour before this branch, and the guard contract only protects an active binding. The latest pointer and B are unchanged.
- **A non-running `thread.session-set` with a non-null `activeTurnId` skips the threads guard** and can move the pointer. Nothing produces this today; ingestion sends null on `turn.completed`.
- **A legitimate start that arrives after a final assistant message** for the same turn is treated as stale everywhere, because the message already settled the row. This is the design inherited from 9874ed395. It is unlikely with ordered provider streams.
- **Unchanged from before:** no unknown or provenance state is stored, and the outbox never retracts a value.
- **Evidence:** tests, check and typecheck are the implementer's runs. Nothing was tested live, in a browser, in the installed app or across a restart.
