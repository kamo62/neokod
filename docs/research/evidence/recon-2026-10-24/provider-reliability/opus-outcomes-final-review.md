I recommend **ACCEPT** for frozen HEAD `9874ed3953f84922307eb55915a7d28267a79ff2` (`feat/neokod-turn-outcomes`). All five blockers are fixed for the sequences they describe, in the SQL, pure and client projections. Two related SQL gaps remain (R1 and R2 below); they should be written down as open, not counted as fixed.

**Review conditions:**

- The worktree was clean and HEAD's parent is `3b4677109`; the merge base with `1eee19299` is that commit.
- This was read-only: no tests, edits, builds, installs, signals or commits.
- The 197 tests and the check/noEmit runs are the implementer's results; I did not rerun them. Nothing here is live proof.
- I'm `claude-opus-5-5`, but I can't confirm the "high" effort setting from inside the session. I also couldn't write the plan file because this session has no write tool.

## The five blockers

1. **Late streaming keeps the settled state and time.**
   - Client: `threadReducer.ts:246-274` keeps the existing state and time once the session no longer runs the turn.
   - SQL: the message path (`ProjectionPipeline.ts:1345-1383`) keeps the state and time, and records no new settlement.
   - Pure: the message handler only updates messages.
   - A provisional Stop still resumes on streaming output, because the session is still running that turn.

2. **A late `running` with the same ID doesn't revive the session.**
   - `shouldApplySessionUpdate` (`orchestrationTurnOutcome.ts:134-146`) rejects a running update for a turn that has already ended, unless the current session is still running that turn.
   - SQL looks the turn up by its ID (`:1063-1081`); pure and client check the latest turn.
   - The session stays ready with no active turn, so `deriveThreadLifecycle` doesn't show "working". New turn IDs are still accepted.

3. **A late checkpoint for an older turn doesn't move the latest-turn pointer.**
   - `shouldReplaceLatestTurnPointer` is applied to the SQL pointer (`:817-822`), the pure projector (`projector.ts:612-622`) and the client (`threadReducer.ts:481-486`).
   - This holds whether the newer turn is running or settled. The test asserts the actual SQL pointer and session in both cases, and the old turn still receives its checkpoint metadata.

4. **A provisional Stop can still become completed or interrupted, and a failed Stop can resume running.**
   - The client treats an `interrupted` turn as provisional while its session still runs it (`threadReducer.ts:328-331`). It resolves against `running`, uses the session time, and isn't caught by the late-running guard.
   - SQL needs no special case: it ignores the interrupt request (`:1423-1428`), and the pure projector has no handler for it, so both see the turn as running.

5. **Correcting or repeating an outcome keeps the first settlement time.**
   - All three projections keep the existing `completedAt` once a turn is settled (SQL `:1190-1209`, pure `projector.ts:511-518`, client `threadReducer.ts:381-386`). This also keeps an explicit `null`.
   - Every first-settlement path in SQL writes the same value to the turn row and the outbox, so the outbox's `DO NOTHING` keeps them equal.
   - The client's `thread.turn-settled` handler then republishes the same value.

## Open gaps to record (not counted as fixed)

- **R1 (not disclosed by the implementer): an older turn can still take the SQL pointer through a session update.**
  - The SQL thread projector at `ProjectionPipeline.ts:799-801` sets `latest_turn_id` from `activeTurnId` without the session guard.
  - Sequence: old turn A has ended, newer turn B has settled, then a stale `turn.started` for A arrives. Ingestion accepts it once no turn is active (`ProviderRuntimeIngestion.ts:1726-1757`).
  - SQL then keeps the session ready but points latest at A. Pure and client go further and show A running again.
  - The implementer disclosed the pure/client part as an evidence limitation, but their note says SQL handles it via the turn row, which is wrong for the pointer.
  - Smallest fix if you want this in scope: apply the same decision to that pointer write.
- **R2 (already present in base): a rejected late `running` still runs SQL's turn-start logic.**
  - At `:1225-1327` it deletes the pending turn start, settles any other running turns as completed, and can attach the pending message to the old turn.
  - It only matters if the user sent the next message before the stale event arrived.
- **R3: a checkpoint can no longer move the pointer to a newer turn.** In SQL and pure, the pointer now advances only through a running session update. The client already behaved this way, and the adapters I checked include the turn ID in `turn.started`, so I'd rate this low risk.
- **R4: two test gaps.**
  - The SQL "reload" test reruns `bootstrap` from the last applied sequence, so it doesn't prove a rebuild from scratch. Equality after reload follows from the projection being deterministic.
  - Explicit `null` combined with a correction or repeat isn't tested; the existing explicit-null tests predate this branch. I checked those paths by reading the code only.
- **Unchanged limits, as disclosed:**
  - The settlement outbox still keeps the first time written and never retracts it.
  - The provisional Stop check depends only on the session still running that turn.
  - No unknown or provenance state is stored.
  - Nothing was tested live, in a browser, in the installed app or across a restart.
