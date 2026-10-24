Verdict: **FIX**, at frozen HEAD `1b2b16f8891375f59d148bc95aaa744fa511a6d8`. The new cursor check is correct, but the error message's recovery advice is misleading and needs rewording. The full report is at `/tmp/neokod-provider-reliability-2026-10-24/opus-outcomes-final-acceptance.md`.

This was a source-only review. I made no edits and ran no tests, builds or other actions; that report is my only write. Test results are the implementer's figures. I reviewed the two-file correction `5e4ccac23..1b2b16f88` and the whole branch from `1eee19299`.

**What I accept:**

- **The check runs before any writes.** Bootstrap reads all ten projector cursors (0 if missing). It accepts them only when they never increase in projector order and are at most one event apart. Anything else gets a typed `PersistenceSqlError` before any event is read or applied. There is no automatic reset, deletion or migration.
- **The accepted shapes are the ones the pipeline can actually produce.** Live projection runs inside the engine's command transaction, so it always leaves the cursors level. An interrupted bootstrap can only leave earlier projectors at N and later ones at N-1. Replaying from that state gives each projector the same view of the session and turn data that it has during live projection.
- **The independent-offset case both previous reviewers rejected is now refused**, not repaired.
- **Test shapes match the claims.** Events `savedEvents[8]`, `[9]` and `[10]` are thread created, running and ready/interrupted.

  | Case                   | Cursors                         | Result                                                                                                                                |
  | ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | Full replay            | all from 0                      | Accepted; the original A/B assertions still hold                                                                                      |
  | Supported interruption | all at `[10]`, threads at `[9]` | Accepted; cursors advance to `[10]`                                                                                                   |
  | Unsupported skew       | all at `[10]`, threads at `[8]` | Typed error; latest-turn pointer stays empty, the three cursors stay `[10]`/`[10]`/`[8]`, session stays ready, turn stays interrupted |

  The supported case doesn't clear the latest-turn pointer before replay, so it only proves the state is accepted and the cursor advances. The refusal test leaves the shared test database skewed. A later test still passes only because live projection overwrites every cursor.

- **Earlier corrections are retained.** The source change only touches bootstrap and an import, so the earlier Stop, outcome, timestamp and old-target corrections are unchanged. The rejected timestamp heuristic appears nowhere in the code.

**What needs fixing (message text only):**

1. **The main instruction gets refused again.** Resetting just the sessions, turns and threads projectors puts them more than one event behind the rest. Recovery needs every projector rebuilt together, and the message's "projector outside the allowed prefix" wording can't be worked out from the cursor list.
2. **It suggests a safe, tested manual cleanup that doesn't exist.**
   - It doesn't say which "projection rows" belong to each projector. The turns projector also owns the settlement outbox, which stores publish timestamps.
   - It gives no advice to stop the app or back up first.
   - Partial resets can corrupt data: resetting a cursor without clearing its rows appends streaming message text again.
3. **Users can hit this on a real upgrade.** Migration 040 never set a starting cursor for the runtime-items projector. A database last opened before v3.5.34 will therefore be refused at startup. So will one left part-way through a bootstrap by pre-branch code; the old bootstrap caught both up silently. Runtime items also read turn rows, so letting that projector catch up alone isn't obviously safe either. Refusing remains the right behaviour.

**Required change:** keep the operation name, cursor summary, the "no automatic reset" note and the "coordinated recovery" phrase so the existing test still matches. The message should instead say that:

- this version has no automated or verified repair;
- recovery means rebuilding all projections together from the event store;
- the database must be backed up with the app stopped before any manual action;
- no individual tables should be named.

Record the pre-v3.5.34 upgrade refusal in the lane notes. No new test is needed.

**Limitations recorded in the report:**

- Adding a projector in future will hit the same refusal unless its cursor is seeded level with the others.
- The pure projector and client reducer still can't recognise stale updates for older turns once the latest turn has moved on.
- No durable unknown or provenance state is stored, and the settlement outbox never retracts its first value.
- Smaller session edge cases from the earlier guard review still apply.
- Nothing was checked against a live provider, browser, installed app, restart or upgrade from an old database.**ACCEPT** at frozen SHA `773ac63866473f036988c8d60fa453969e4e7e95` (`fix: preserve evidence when projection recovery is unavailable`), compared with `1b2b16f88`. The working tree is clean and HEAD matches that SHA.

This check covers only that final correction. I made no edits and ran no tests, builds, installs, processes, commits, pushes or delegation.

**What the diff contains.** It touches one file, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, with 1 line added and 6 removed:

- **Unused list removed.** The local `coordinatedProjectors` list is gone. `ORCHESTRATION_PROJECTOR_NAMES` is still used by the projector definitions.
- **Detail text replaced.** The second part of the error's detail text is the only other change.
- **Everything else is unchanged:**
  - the cursor check (`offsetsAreOrdered`, and `maximumOffset - minimumOffset > 1`);
  - the error type `PersistenceSqlError` and its operation name `ProjectionPipeline.bootstrap:projector-coordination`;
  - the cursor summary and the replay loop;
  - storage, contracts and tests.
- **The refusal test still matches.** The text still contains "require coordinated recovery", so the assertion at `ProjectionPipeline.test.ts:2827` (`/coordinated recovery/`) should still pass. I read this from source and did not run it.

**The message now covers every caveat from my FIX:**

- The unsafe "clear and reset the coupled group" instruction is gone. No tables or cursor edits are named as a fix.
- It says unsupported skew needs investigation and that this version has no automated or verified repair.
- It says to stop the app and back up the database, event store and attachments before any manual action.
- It says recovery needs a separately validated procedure that rebuilds all projections together from the event store. It also says row deletion and cursor resets must not be assumed safe.
- It still says no automatic reset was performed.

The message no longer suggests a safe cleanup that hasn't been checked.

**Bounded source, cumulative:** I accept the outcome-lane source from `1eee19299` to `773ac6386`. This rests on my earlier logic review of the cursor invariant at `1b2b16f88` plus this string-only correction. Your note says root integration added the stopped-app and verified-repair wording. I assessed only the committed text, not who wrote it.

**Limits that still apply:**

- **Upgrade compatibility.** Projection data from a database last opened before v3.5.34 has no runtime-items cursor, so it reads as 0. Data left part-way through an older, pre-branch bootstrap is also refused at startup. This is a known compatibility limitation, not a fixed or validated upgrade path. Any projector added later will hit the same refusal unless its cursor starts level with the others.
- **Stale identity outside SQL.** The pure projector and client reducer still can't recognise stale updates for older turns once the latest turn has moved on.
- **No unknown or provenance state.** None is stored, and the settlement outbox never retracts its first value.
- **Not proven at runtime.** Nothing was checked against a live provider, browser, installed app, restart or upgrade from an old database.

This accepts the bounded source and this correction only. It is not whole-app, core-exit or live-upgrade acceptance.**ACCEPT** at frozen HEAD `5d91f949ab2d99f7cc88da8a4d399e5831d3b064` (`fix: replay legacy runtime item projections`), compared with `773ac6386`. The working tree is clean.

Narrowing the guard to sessions, turns and threads covers every new cross-projector read added on this branch. It doesn't let any other projector make a decision against another projector's future rows in a way the pre-branch code didn't already allow. It removes the migration 040 startup refusal and adds no new startup or data risk.

I assessed this delta on its own merits; the earlier `773` acceptance does not carry over. This was a source-only review: no edits, tests, builds, installs, provider runs or process operations. The test results are the implementer's figures.

**What changed (two files):**

- **Production code.** The order-and-gap check now runs only on the threadSessions, threadTurns and threads cursors, still in projector order. The error lists only those three cursors. Replay starts from the lowest cursor across all projectors, so any lagging projector catches up within the same event-ordered pass. The refusal still happens before any reads of events or writes. The operation name, error type and the evidence-preserving message from `773` are unchanged.
- **Tests.**
  - The refusal test now puts the threads cursor back to a supported position. That removes the shared-test-database fragility I flagged earlier.
  - A new test covers the legacy runtime-items cursor at zero in two forms: rows kept, and the empty table that migration 040 actually leaves.

**Is the guard scope complete?** I mapped which tables each projector reads from other projectors:

| Projector                                  | Reads from other projectors                                                                                                       | In the group? |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| sessions                                   | session and turn rows, through the new session-update check                                                                       | yes           |
| turns                                      | sessions, turns, threads, plus the project row for the pending-start workspace path                                               | yes           |
| threads                                    | sessions and turns through the new check; the shell summary reads messages, plans, activities, approvals, turns and runtime items | yes           |
| messages, plans, activities, runtime items | turn rows during revert handling                                                                                                  | no            |
| projects                                   | the same sources as the shell summary                                                                                             | no            |
| approvals                                  | none                                                                                                                              | no            |
| checkpoints                                | none (does nothing)                                                                                                               | no            |

- The only new cross-projector reads on this branch come from the two new session-update checks, which read session and turn rows. They are called only in the threads, sessions and turns projectors (`:797`, `:1104`, `:1176`). No projector outside the group gained a new dependency.
- **A projector outside the group lagging behind.** It replays against the current turn rows. The pre-branch bootstrap did exactly the same, because it caught up one projector at a time after sessions and turns had finished. This is existing behaviour, not a regression. It covers runtime items and messages reading final turn rows during revert, and plans and activities doing the same.
- **The group lagging behind another projector.** The group's own as-of decisions still read only group rows. Two group reads touch other projectors' tables:
  - the shell summary, which is a derived view recomputed from current rows;
  - the project's workspace path for pending starts.

  Both read the same way in the pre-branch per-projector bootstrap. No new risk.

- **Interrupted bootstrap.** Replay applies each event to projectors in fixed order, so an interruption leaves the group in the accepted N / N-1 shape. Projectors outside the group can't affect that.

**Supported compatibility:**

- Upgrade from a database last opened before v3.5.34, where runtime items have no cursor or are at 0 while everything else is current. The table may be empty or have retained rows. Both now catch up instead of being refused. The new test asserts the full final state matches a full replay for runtime items, session, turns and checkpoint counts, latest-turn pointer, pending start and settlements, and that the runtime-items cursor ends at the last event.
- A pre-branch bootstrap interrupted while catching up a new projector outside the group is accepted.
- Group cursors that are equal, or in the single N / N-1 interruption shape, are accepted.
- Any other skew within the group is refused, with rows and cursors left unchanged.

**Remaining limits (all existing behaviour or explicitly out of scope):**

- **Stale shell summary after a runtime-items-only catch-up.** The threads projector doesn't replay, so worker, approval and user-input counts in existing thread shells refresh only on that thread's next event. The pre-branch code behaved the same way. These are derived counts, not lifecycle evidence.
- **Runtime-items revert reads final turn rows.** In normal ordered history this matches a full replay. A later mutation of the checkpoint turn count could in theory change which items are kept; that is unchanged from before.
- **Skew within the group still stops startup.** It needs investigation and a separately validated full rebuild. There is no automatic reset. Pre-branch shapes where threads trails sessions and turns by more than one event are still refused, though the pre-branch code only produced them while catching up a projector.
- **Earlier limits still stand:**
  - the pure projector and client reducer can't recognise stale updates for older turns once the latest turn has moved on;
  - no unknown or provenance state is stored;
  - the settlement outbox keeps its first value.
- **Not proven live.** No live upgrade from a real pre-v3.5.34 database, installed app, restart, browser or provider run was checked. This accepts the bounded source change only, not the whole app, core exit or a live upgrade.**ACCEPT** at frozen HEAD `886c49aa32d35d49997d44af42e915e8db0f7650` (`fix: replay projection catch-up beyond event page cap`), compared with `5d91f949a`. This covers both the latest correction and the bounded outcome lane `1eee19299..886c49aa3`. The working tree is clean.

This was a read-only review: no edits, tests, builds, installs, provider runs or process actions. Test outcomes are not my evidence; the root runs the final focused tests, check and typecheck.

### Sol's finding is correct, and my 5d acceptance was wrong on this point

- **The cap.** `readFromSequence` defaults to a total limit of 1,000 events (`OrchestrationEventStore.ts:67` and `:213`). It reads in pages of 500 and stops once the limit is used up (`:249-251`). At `5d91f949a`, bootstrap called it without a limit. I said a legacy runtime-items cursor at 0 "catches up". That only holds for event stores of 1,000 events or fewer.
- **The counterexample.** Take a legacy database with more than 1,000 events, runtime items at cursor 0, and the session, turn and thread projections at N, with threads possibly at N-1.
  - Replay starts from 0 and stops after 1,000 events. Runtime items reaches about sequence 1,000, and threads never reaches its N-1 tail.
  - The engine then starts. The next live `projectEvent` moves every cursor to the new sequence (`runProjectorForEvent` always records it), so the events that were never replayed are skipped permanently.
  - Runtime-item evidence after the cap is lost, and so is the thread projection's last event. Bootstrap reports no error.
- **How it came about.** The cap itself predates this branch: the old one-projector-at-a-time bootstrap used the same default. The specific regression came from `5d91f949a`, which started replay from the lowest cursor of all projectors, so the session/turn/thread tail could sit beyond a lagging cursor's 1,000-event window. At `1b2b16f88` and `773ac6386`, replay normally covered at most one event, because every cursor had to be within one event of the others.

### The correction

- **Production change.** Bootstrap now calls `eventStore.readFromSequence(replayFrom, Number.MAX_SAFE_INTEGER)`. That is the same paginated reader `readAll` uses (`:266`): it reads 500 per page until a page comes back empty. Nothing else changes. The scope of the cursor check, the refusal before writes, the error text and the replay loop are as before.
  - After bootstrap, every cursor reaches the end of the event store before the command worker starts (`OrchestrationEngine.ts:356` runs before the worker fork). Live projection therefore no longer overwrites cursors that hadn't caught up.
- **The test** (`ProjectionPipeline.test.ts`, new suite on a fresh layer):
  - It builds 1,506 events: three setup events, then 1,500 runtime-mode filler events. Index 1503 holds the runtime-item evidence, past the cap. Index 1504 sets the session to ready and settles the turn. Index 1505 is a pending turn start.
  - **Full replay from zero** asserts the completed runtime item, the ready session, the completed turn, the pending start and the settlement time. Before the fix this part fails on its own, because the cap stops at 1,000.
  - **Legacy shape:** runtime-item rows are deleted and that cursor set to 0, while threads sits at index 1504 and sessions and turns are at the end. That is migration 040's empty table plus a supported thread lag of one event. The test asserts the final state matches the full replay, and that both the runtime-items and threads cursors end at the last event. Before the fix this fails on the missing item and on both cursors.
  - This reproduces the original counterexample directly and checks the correction.
- **Cost.** Startup now does work proportional to the lag across all events, not just 1,000. That is the intended catch-up behaviour, and it uses the existing lazy paginated pattern.

### Cumulative lane, `1eee19299..886c49aa3`

The changes from earlier rounds remain in place:

- explicit turn outcomes using known values only, applied only to the targeted turn;
- the decider rejecting an outcome without a target;
- the live guard against stale running updates across SQL, the pure projector and the client;
- first settlement time kept, and the latest-turn pointer rule;
- provisional Stop in the client;
- event-ordered bootstrap;
- the cursor check limited to sessions, turns and threads, with typed refusal before writes;
- the evidence-preserving refusal text;
- legacy runtime-items catch-up;
- and now replay past the page cap.

Between `5d91f949a` and HEAD, only the replay call and the new test changed.

### Known limits

- **Pure projector and client identity.** They can't recognise a stale running update for an older turn once the latest pointer has moved on. SQL and ingestion are correct.
- **No unknown or provenance state** is stored.
- **First outbox value.** The settlement outbox keeps its first value and never retracts it.
- **Derived views (existing behaviour):**
  - after a runtime-items-only catch-up, the thread shell's worker, approval and user-input counts refresh only on that thread's next event;
  - revert handling for runtime items, messages, plans and activities reads the final turn rows.
- **Unsupported skew within sessions, turns and threads** is refused at startup. There is no automatic reset; recovery needs investigation and a separately validated full rebuild.
- **Damage from before this lane is not repaired.** Under the pre-branch code, an installation that caught up a projector across more than 1,000 events, such as a pre-v3.5.34 upgrade with a large store, already had cursors advanced past events that were never replayed. This fix doesn't detect or restore those missing rows.
- **Not reviewed:** other `readFromSequence` callers that rely on the 1,000 default are outside this bounded review.
- **No runtime evidence:** no live upgrade from a real old database, restart, installed app, browser or provider run. This is not a core-exit or live-upgrade acceptance.
