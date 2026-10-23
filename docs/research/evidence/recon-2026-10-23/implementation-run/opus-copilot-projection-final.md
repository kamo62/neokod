**Verdict: not a clean accept. I found one P2. It cannot be triggered at this SHA, but it should be fixed before any closure producer is connected.** The other three corrections hold.

**SHA:** HEAD is `2af58b5dbb301eec1d16296fd5b9a32969a3a946` ("fix(web): scope Symphony closure and connection freshness"). The status check showed no uncommitted changes. I reviewed:

- the three owned files;
- the parent commits `4a0e84545` and `c1fb42238`;
- plan.md 16.15–16.17 and state-and-evidence;
- the production adapter path through client-runtime: connection catalog, presentation, query and subscription atoms, `AsyncResult` semantics in effect-smol, and the contracts.

## The four corrections

1. **Disconnection freshness: holds while disconnected.** `symphonyWorkConnectionStaleReason` reads the real `environmentCatalog.networkStatusValueAtom` and the presentation phase. That phase comes from the same supervisor state that controls when queries run, which only happens when the phase is `connected`. Any phase other than `connected`, a missing presentation, or a network status that is offline or unknown marks known board, runs and attention data as stale. With no data it becomes unknown. Stale data then blocks Start, Cancel and the attention actions.
2. **An old closure no longer confirms a later attempt: holds only when the later attempt is loaded.** See P2.
3. **An old interrupted stop no longer floods current filters: holds.** An interrupted attempt followed by a later succeeded attempt is excluded from In progress and Needs attention. It still appears in All and History with `reconciliation: true`. Ownership stays unknown and Start stays unknown, because `stopRequestedAttempts` still drives execution, reconciliation, ownership and Start. A later failed attempt still keeps it in In progress and Needs attention, as the test intends.
4. **Refusal retry passes every affirmative gate: holds.** The `refused` branch is reached only after all of these gates pass: lifecycle known; all sources fresh; no pending dispatch; no actionable attention; no older outstanding attempt; no active attempt; no unconfirmed stop; ownership known; exhaustive runs coverage; known attention; not excluded or blocked; no eligibility reasons.

Server-capped coverage stays `unknown` in `state/symphonyWork.ts`, so production Start never becomes `available`. That matches your stated intent, and no new query or W6 contract is needed.

## P2: an item-level closure confirms cancellations it cannot see

- **Path:** `hasConfirmedWorkItemClosure`, `apps/web/src/symphonyWork.logic.ts:547-563`, used at 1460-1466 and in the membership logic at 1538-1552.
- **Trigger:** a caller supplies an item-level closure (no `runAttemptId`) that was observed before the latest attempt started, and the loaded run evidence does not include that attempt. This happens when:
  - runs are unavailable or unknown;
  - the server mapped a read failure to `[]`;
  - the run history is capped.

  In those cases `attempts.every(...)` checks an empty or partial list and returns true.

- **Impact:** `hasUnconfirmedCancellation` becomes false for a cancelled item whose newer stop is unconfirmed. Reconciliation becomes false, and the item drops out of All, In progress and Needs attention into History only. Ownership still resolves to `unknown`, so Start stays fail-closed. The visibility gap breaches 16.16, which says "unknown earlier ownership is not hidden".

  The older `hasConfirmedStop = history.some(stopped)` line has the same gap: if only an older attempt with an exact closure is loaded, it confirms the cancellation.

- **When it matters:** no closure producer exists at this SHA (`stopClosure` and `stop_confirmed` are absent from contracts and server). The sibling Work UI already passes `workItem.stopClosure`, so this becomes reachable once that is wired.
- **Bounded fix:** item-level or historical closure should confirm a cancellation only when `attempts.currentState === "known"` and that current attempt is covered by the closure (`closureCoversAttempt`). Otherwise keep the cancellation unconfirmed. Add one test: an item-level closure older than `latestRunAttemptId`, with runs empty or unavailable, keeps the item in reconciliation.

## P3 notes (not blocking)

- **Reconnect window:** when the connection returns to `connected`, query atoms re-run and briefly show the pre-disconnect value (marked as waiting) as fresh. Board shows the old snapshot until the first new event. The window lasts about one RPC round trip, and the server remains authoritative. If you want to close it, track the supervisor `generation` when each source last succeeded, and mark the source stale until a success arrives under the new generation.
- **Refused draft or ineligible item:** this is introduced at this SHA. A refusal turns a draft into `not_started/refused`, and the new branch returns Start `available` where an unrefused draft returns `blocked`. In production it can't be reached because of unknown coverage. Fix: in `case "refused"`, keep the draft and ineligible blocked results when the raw lifecycle is draft or ineligible.
- **Small wording issue:** the stale message says "stale after a failed read" even when the cause is a disconnection.

## Proof limits

This is source review only. I ran no tests, typecheck, `vp check`, build or browser session. Existing tests don't cover the P2 trigger. I didn't review the sibling `neokod-work-ui` consumer beyond checking that it supplies closures. Runtime reconnect timing is inferred from the effect-smol `makeEffect`/`waitingFrom` source, not observed.**Verdict: accept. I found no P0–P2 issues in the change from `2af58b5db` to `f7cd0b12e`.**

**SHA and status:** HEAD is `f7cd0b12ef8b60f930f8c8d3bf5ba24be5f3b934` with a clean tree. It is one commit after `2af58b5db` ("fix(web): require a known current attempt for stop closure") and changes only `apps/web/src/symphonyWork.logic.ts` and its test file.

**Cancelled-work closure needs a known current attempt.** The `hasConfirmedWorkItemClosure` helper, its `every(...)` check over history and the `history.some(stopped)` shortcut are all removed. A cancellation now counts as confirmed only when both of these hold (lines 1450–1455):

- `attempts.currentState === "known"`, which requires the board's `latestRunAttemptId` (or the explicitly passed current ID) to be present in the loaded runs;
- that current attempt's own outcome is `stopped`.

A `stopped` outcome comes only from `closureFor`. That accepts either a closure for that exact attempt, or a work-item closure observed no earlier than that attempt's start time. `closureFor` is now the only place closures are read. No empty-list or partial-list check, and no history-based shortcut, can clear a cancellation any more.

**When the current attempt is missing:** cancellations where the current attempt is missing, has no ID, or the runs could not be read keep `hasUnconfirmedCancellation` set. Such an item stays in All, Needs attention and In progress, with reconciliation set, ownership unknown and Start unknown. An unresolved older stop still keeps the cancellation unconfirmed through `hasUnresolvedStop`. The new tests cover all three missing-current cases and the case where the closure does cover the current attempt.

**Refused draft and ineligible items are blocked.** The `refused` branch now returns `blocked` for draft and ineligible items, using the same wording as an unrefused item. Missing or stale evidence returns `unknown` first, so neither path can become `available`. Queued, failed or cancelled items that were refused still need every affirmative check to pass.

**Stale wording is neutral.** "after a failed read" no longer appears in the Start, Cancel or attention action messages. Two leftovers below P2:

- the comment on `staleReason` at line 44 still says "after a live read failed";
- the ownership reason at line 956 still says "capped or failed reads", which is imprecise when the cause is a disconnection.

**Limits.** This was source review only: no tests, typecheck, `vp check`, build or browser. At this SHA nothing on the server produces closure evidence. The P3 notes from my previous review are unchanged and below the threshold: the brief fresh-looking window right after a reconnect, and the server never reporting complete coverage, so production Start stays unknown. The parts of the earlier review not touched by this diff still apply. Server completeness, live UI and provider evidence remain separate gates.
