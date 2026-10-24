# SQL outcome correction review

Verdict: FIX

Frozen HEAD: `5e4ccac2305051fa6300b1484fe287f34b123deb`, compared with `9874ed3953f84922307eb55915a7d28267a79ff2`. Working tree was clean. Read the requested answer and exact two-file diff. Source-only review; no tests, runtime actions, source edits or builds performed. The reported 198 passing tests and 32 pipeline tests are implementer evidence.

## Previous live SQL blocker is resolved

The running-update admissibility check now runs before session upsert, latest-pointer assignment and the entire turn-running branch. For terminal A, newer running B, pending start and delayed running A, rejection prevents pointer movement, supersession, pending-start consumption and false settlement. Explicit old-target terminal outcomes still reach their pinned historical row, while legitimate unseen running IDs remain admissible. The extended existing regression asserts all five affected outputs. First-settlement immutability, known-only contract and the previous fixes are unchanged in this two-file correction.

## Remaining blocker: independent offsets still expose future evidence during bootstrap

`ProjectionPipeline.ts:1884-1913` replays events in order but skips projectors already beyond each replayed event (`:1906-1907`). It does not rewind their persisted rows. A lagging projector's new admissibility query (`:1060-1078`) therefore reads the advanced session/turn rows at their later state, not the replay event's state. The comment at `:1880-1883` and answer's claim that every projector has previous-event evidence do not hold for independently advanced offsets.

Concrete source walkthrough:

1. Event 1 creates a project, event 2 creates a thread, event 3 starts running turn A, event 4 confirms A interrupted with session ready and active ID null. No checkpoint event is required.
2. Sessions and turns are projected through event 4. The thread-shell projector is independently at event 2, with its existing created row and `latest_turn_id = null`.
3. Bootstrap starts at event 2 and reaches event 3. Sessions/turns are skipped because their offsets are already 4. The lagging thread-shell projector calls `appliesRunningSessionSetEvent` before assigning its latest pointer.
4. That query sees future terminal A and future ready/null-active session from event 4, so it rejects the original legitimate running event 3. The pointer remains null.
5. At event 4 the ready payload has null active ID, so `applyThreadsProjection` retains the null pointer. All offsets reach 4, but the latest turn has disappeared from the thread snapshot. A full replay from zero would correctly retain A.

This is a concrete independent-offset inconsistency in the newly added guard/replay path. It does not require malformed events, a new outcome state or a change to settlement policy.

The new bootstrap regression at `ProjectionPipeline.test.ts:2449` appends its full event array and bootstraps empty projections. It contains no independently advanced offsets or rows, so it proves full replay only. Existing cursor-resume tests do not establish the new cross-projector terminal-evidence invariant.

Required correction: establish admissibility against evidence at the replayed event, or bring the dependent projections to a consistent replay boundary before using cross-projector state. Merely sorting events while leaving other projections ahead is insufficient. Extend the existing bootstrap regression with the concrete advanced session/turn offsets and lagging thread pointer above, asserting the final latest identity and parity with full replay. Retain the A/B running/pending/no-false-settlement assertions already added. No claim of independent-offset acceptance should be made until that case is covered.

No other scope expansion is requested. The disclosed pure/client historical-evidence limitation and deferred durable-unknown representation remain separate.
