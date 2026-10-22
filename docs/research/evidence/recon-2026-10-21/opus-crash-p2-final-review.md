I found three P2 issues and no P0 or P1 issues. Shutdown-snapshot preservation, inactive `host_lost` Stop handling and the URL-apostrophe fix look closed. The start-up subscription gap is a separate fix and should not be counted against these five closures.

This was a source-only review of `75e608f53..c37563ab3` and the code that calls it. HEAD was `c37563ab39c26cc254a9ce1f9d55287069c93532` at both start and end, and the working tree stayed clean. I read README, AGENTS, `state-and-evidence.md`, Effect `LLMS.md`, the prior answer and the receipt. I made no edits and ran no tests, builds, app, browser, provider or child agents. Nothing here proves runtime behaviour.

### P2 findings

**1. Recovered turns now show a near-zero duration (timing closure not closed)**

- **Location:** `apps/server/src/provider/Services/ProviderSessionReconciler.ts:174`, and `:148` when the persisted outcome is missing or `stop_failed`.
- **Trigger:** a turn runs for 30 minutes, then the server crashes. On boot, the turn is settled as `host_lost`.
- **Cause:** `binding.lastSeenAt` is only updated by `directory.upsert`. Nothing writes to the binding during a turn, so the last write is the one in `sendTurn` (`ProviderService.ts:904`), about when the turn started. `latestTurnCompletedAt` therefore ends up roughly equal to `startedAt`, and can be a few milliseconds earlier because nothing clamps it.
- **Effect:**
  - `MessagesTimeline.logic.ts:73,406` clamps negative values to 0 and shows "You stopped after 0s".
  - `threadRunSummary.logic.ts:145` shows "0s", or nothing at all when the end is before the start.
  - The durable turn row can store `completedAt < startedAt`.
  - On a later boot, that `completedAt` also becomes the runtime-item `closedAt` and the command's `createdAt` (`ProviderRuntimeIngestion.ts:2205-2224`, `:913`).
- **Why it matters:** this replaces a timing that included downtime with a fabricated near-zero value. The rule in `state-and-evidence.md` is that a missing last observation stays unknown.
- **Fix:** take the last observation from durable server-owned evidence and clamp it so it is never earlier than the turn's start. `thread.updatedAt` is a good source because the projection pipeline updates it for messages, activities and runtime items (`ProjectionPipeline.ts:784-799`). It also appears to be available in the command read model. If no observation exists after the start, keep the end unknown rather than falling back to boot time. That needs a small "unknown end" representation, because a terminal turn with a null `completedAt` currently keeps ticking in `threadRunSummary`.
- **Test gap:** the tests pass an arbitrary `lastSeenAt`. None models a binding that was last written at turn start.
- **What is fine:** the field is internal-only, not in `ClientOrchestrationCommand`. `session.updatedAt` and the event time are unchanged, the interrupted-closure cutoff is unchanged, and the server projector, durable pipeline and client reducer all handle the field the same way. Older events still decode, and replaying after a crash between the binding write and dispatch stays idempotent through `stoppedAt`.

**2. Recovery clears stop evidence on threads that are still fenced (shutdown-snapshot closure incomplete)**

- **Location:** `ProviderService.ts:582-587` and `:628-633`, reached from `resolveRoutableSession` (`:705`).
- **Callers:** `interruptTurn` (`:954`), `respondToRequest` (`:991`) and `respondToUserInput` (`:1030`). None of these calls `assertNotStopping`.
- **Trigger:** a stop ends as `stop_failed` or a non-`host_lost` `orphan_possible`, so the thread stays fenced (or is re-fenced on restart), and the adapter no longer holds the session. An approval or user-input response, or an interrupt, then reaches recovery. Recovery resumes a new provider process and writes `clearStopEvidence: true`.
- **Effect:** the stop evidence that the next restart needs to rebuild the fence is erased.
- **Context:** this behaviour predates the range. It still breaks the closure's own rule that only an accepted start or turn clears stop evidence; `sendTurn` and `startSession` are fenced, but these recovery callers are not. The shutdown snapshot itself is now fixed.
- **Fix:** call `assertNotStopping(operation, threadId)` in `resolveRoutableSession` before `recoverSessionForThread`.
- **Test:** add a regression test where the stop failed and the adapter has no session, then `respondToRequest` is rejected and the binding keeps its stop fields.

**3. GNU-style backtick-opened paths are still not redacted (sanitiser closure partial)**

- **Location:** `apps/server/src/provider/userFacingErrorText.ts:36`. The `POSIX_PATH` start boundary does not include the backtick.
- **Trigger:** text such as ``make: *** No rule to make target `/Users/alice/proj/x'.  Stop.`` or Ruby-style `` `…' `` quoting. The paired-backtick rule needs a closing backtick, so with only one backtick in the text the whole home path is left in place.
- **Fix:** add the backtick to the `POSIX_PATH` start boundary. This does not affect relative paths, because a match needs a `/` immediately after the boundary character.
- **Test:** add `` `/Users/a/x' `` with no closing backtick, alongside the existing relative-path test.

**Below P2, not blocking:**

- Backticked slash commands such as `` `/login` `` now become `` `[path]/login` ``. Bare `/login` was already rewritten this way before this range.
- The URL rule now protects a quoted URL together with anything glued to it without a space, such as `data:'/Users/…'` or `'https://h/x'/Users/…`. These inputs are contrived.

### Closures that look closed

- **Shutdown snapshot:** the stop-all pre-sweep (`ProviderService.ts:1342`) no longer clears stop fields. Start and `sendTurn` still clear them, after the barrier check.
- **Inactive `host_lost` Stop:** the early return at `:1081` makes no durable write. The reaper, the reconciler on the next boot and stop-all do not overwrite the outcome either. The barrier is released correctly because no stop intent was recorded.
- **URL apostrophes:** the fix holds for unquoted, single-quoted and double-quoted URLs. Over-protection only covers text with no space after the closing quote.

### Start-up subscription gap (separate from the five)

The gap is real and worth fixing, but the window is small. `ProviderRuntimeIngestion.start` (`:2246-2257`) forks `Stream.runForEach(orchestrationEngine.streamDomainEvents)`. That stream is `Stream.fromPubSub` (`OrchestrationEngine.ts:345`), which only subscribes once the forked fiber runs, and Effect forks do not start immediately by default. Start-up then calls `providerSessionReconciler.reconcile` (`serverRuntimeStartup.ts:345`). Whether the forked fiber has subscribed before the reconciler publishes depends on scheduling.

If the interrupted `thread.session-set` is missed, `closeItemsOfSettledSession` does not run. Runtime items stay active until the next boot, because the start-up item reconciliation has already run before the session reconcile.

**Smallest correct fix, using the pattern this repo already uses** (`ProviderRegistry.ts:631-668`, `ProviderService.ts:553-556`, `VcsStatusBroadcaster.ts:526`, with `PubSub.subscribe` returning `Effect<Subscription, never, Scope>`):

1. Add `subscribeDomainEvents: Effect.Effect<PubSub.Subscription<OrchestrationEvent>, never, Scope.Scope>` to `OrchestrationEngineShape`, implemented as `PubSub.subscribe(eventPubSub)`.
2. In `ProviderRuntimeIngestion.start`, take that subscription first, before `reconcileRuntimeItemsAtStartup`, inside the reactor scope. Then fork `Stream.runForEach(Stream.fromSubscription(sub), …)`. When `start()` returns, the subscription is already in place.
3. Keep `streamDomainEvents` for other consumers. Using `forkScoped({ startImmediately: true })` would also work, but it depends on an internal detail of the channel, so the explicit subscription is safer.

**Acceptance:**

- An ingestion test dispatches an interrupted `thread.session-set` straight after `start()`, with no yield, then calls `drain`, and finds the items closed.
- An engine test shows a subscription taken before `dispatch` receives the event.
- Existing ingestion and reconciler tests still pass.
- `vp check` and `vp run typecheck` pass.

### Readiness

The closure is not ready to accept. Findings 1 to 3 need fixing first. Finding 1 is the substantive one and needs a better source for the last observation and an "unknown end" representation. Findings 2 and 3 are one-line fixes, each with one regression test. The subscription-readiness change can go in the same lane or a follow-up. Root `vp check` and `vp run typecheck` have still not been run.
