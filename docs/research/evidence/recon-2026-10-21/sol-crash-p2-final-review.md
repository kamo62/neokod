HEAD matches the requested pin and the working tree is clean. I’ll review the five P2 fixes against their durable-write and projection callers, then assess startup subscription readiness separately. No edits or execution checks.
The new completion field reaches all three projections without changing server event time or the runtime-item cutoff. The shutdown snapshot and inactive `host_lost` Stop paths also preserve the reviewed stop evidence. I’m checking whether binding timestamps actually observe the recovered turn, and whether startup ordering guarantees subscription before reconciliation publishes.
One timing gap remains: Kiro emits `turn.started` before its blocking prompt returns, but the binding is updated only after `sendTurn` returns. Recovery can therefore freeze completion before the turn started, which the timeline clamps to zero. The URL matcher also still splits valid URLs containing consecutive apostrophes. For startup readiness, an awaited scoped subscription is the smallest fix and matches an existing registry pattern.
Two P2 closure issues remain. The other three reviewed fixes have no actionable P0–P2 finding. Startup subscription readiness is a separate P2 concern, not part of the five-fix closure.

Reviewed `75e608f53..c37563ab39c26cc254a9ce1f9d55287069c93532` and actual callers. HEAD matched that pin at both start and end; the working tree remained clean.

## Remaining closure findings

### 1. P2: A binding write can predate the recovered turn, producing a false zero duration

Location: `apps/server/src/provider/Services/ProviderSessionReconciler.ts:144–148,174`.

Trigger: Kiro has a persisted session binding, starts a turn, then the server crashes while its prompt is still running.

Kiro publishes `turn.started` at `apps/server/src/provider/Layers/KiroAdapter.ts:998–1005`, then awaits the prompt at `:1011`. `ProviderService` updates the binding only after `adapter.sendTurn` returns (`apps/server/src/provider/Layers/ProviderService.ts:903–915`). The binding’s `lastSeenAt` can therefore precede this turn.

Recovery nevertheless treats that timestamp as the turn’s completion. All three projections faithfully propagate it. `apps/web/src/components/chat/MessagesTimeline.logic.ts:69–73,403–406` then clamps the negative interval to zero, while `threadRunSummary.logic.ts:142–145` returns unknown. The surfaces disagree, and the stored completion predates the start.

Use evidence belonging to the current turn and validate its temporal bounds. Where no qualifying observation exists, preserve unknown completion explicitly. Simply omitting `latestTurnCompletedAt` is insufficient: all three projections then substitute recovery-time `session.updatedAt`.

### 2. P2: Valid consecutive apostrophes still break URL protection

Location: `apps/server/src/provider/userFacingErrorText.ts:25–26`, followed by path replacement at `:79`.

Trigger:

```text
https://api.example.com/v1?name=O''Reilly&redirect=/docs/api
```

The lookahead rejects an apostrophe followed by another apostrophe, so protection ends after `name=O`. Path scrubbing then changes `redirect=/docs/api` to `redirect=[path]/api`. Consecutive apostrophes are valid URL characters and occur in escaped query expressions.

The original `O'Reilly` example is fixed, including the tested quoted forms, but the general URL-preservation requirement remains incomplete.

## Other three fixes

No actionable P0–P2 finding in:

- Shutdown snapshots preserving prior unresolved-stop metadata.
- Inactive `host_lost` Stop preserving the persisted outcome without a binding write.
- Backtick-quoted absolute-path redaction while retaining the reviewed relative paths and ordinary prose.

The optional completion field reaches the command/event schemas, decider, server projector, durable projection and client reducer. Its transport does not change server event time or the runtime-item observation cutoff. No additional finding arose from the reviewed legacy-event, restart, pagination or deduplication callers.

## Separate startup-readiness finding and recommendation

### P2: Startup does not establish subscription readiness before recovery dispatch

Locations:

- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:2241–2263`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:344–345`
- `apps/server/src/serverRuntimeStartup.ts:340–345`

Trigger: persisted running work has active runtime items; the startup scan leaves it alone, then boot reconciliation publishes its interrupted session event before the forked domain stream acquires its subscription.

The hot PubSub has no replay. If that interleaving occurs, the turn settles durably but ingestion misses its item-closure boundary. No subsequent startup scan runs in that process.

This is actionable as a subscription-contract race, not evidence that a live incident occurred. Vendored Effect confirms that `forkScoped` schedules work and `Stream.fromPubSub` subscribes lazily.

Smallest correct plan:

1. Add an engine acquisition contract such as `subscribeDomainEvents: Effect<PubSub.Subscription<OrchestrationEvent>, never, Scope.Scope>`, implemented with `PubSub.subscribe`.
2. In ingestion `start()`, await acquisition in the caller’s scope before the startup scan, then fork consumption using `Stream.fromSubscription`. Returning from acquisition is the readiness signal; no separate Deferred is necessary.
3. Retain the existing hot-stream API for other callers. Avoid replay buffers, sleeps or a broad reactor rewrite.

This matches the existing `subscribeChanges` pattern in `apps/server/src/provider/Services/ProviderInstanceRegistry.ts:55–81` and vendored `PubSub.ts:1130–1140`.

Acceptance:

- Delay consumer execution until recovery dispatch has committed; the acquired subscription must retain the boundary and closure must subsequently complete.
- Exercise the real startup ordering with persisted running work, including items observed after the binding write but before recovery.
- Repeated recovery must not duplicate synthetic closure; scope disposal must release the subscription.
- Preserve frozen turn timing, server event time, item cutoff and provider-terminal precedence.

Source-only review. No edits, tests, builds, app/browser/provider launches, child agents, commits, pushes or external messages. Receipt results were not independently rerun; this is not runtime proof or broader readiness approval.
