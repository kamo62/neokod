HEAD is pinned at `2a924dea91aa6fe45eb9bc54c71269b1539e97ee`, and the working tree is clean. I’ll review the correction and scheduler fixture from source only, with no tests or runtime activity, then recheck HEAD.
The source now puts native spawn and both observers inside one synchronous callback, with the Deferred created beforehand. The new fixture also targets the missing scheduling window: it arms a one-shot yield during spawn and checks that the queued error arrives before the caller continuation. I’m finishing the cleanup-ownership trace and checking the limits of the old-source failure claim.
No actionable P0–P2 findings in `c7571d0d8..2a924dea9`. The prior scheduler-gap P2 is closed at source level.

### Closure evidence

- **Spawn and observation are synchronous.** In [`opencodeRuntime.ts:570–635`](apps/server/src/provider/opencodeRuntime.ts#L570), the replayable Deferred is created before native spawn. Spawn, `exit`/`error` listener attachment, already-exited replay and handle construction execute inside one `Effect.try` callback. There is no Effect continuation between spawn and observation.
- **This fixes the actual interpreter boundary.** Vendored [`Effect.try`](.repos/effect-smol/packages/effect/src/internal/effect.ts#L953) returns a success effect after its callback. The [run loop](.repos/effect-smol/packages/effect/src/internal/effect.ts#L621) can yield before evaluating that success. The returned handle is now fully observed before that yield can happen.
- **Settlement and bounded ownership remain intact.** [`opencodeRuntime.ts:681–787`](apps/server/src/provider/opencodeRuntime.ts#L681) retains the initial one-second wait, direct native-handle cancellation and second one-second wait. Cancellation does not launch another `taskkill`. Failure or non-settlement remains unknown, rather than becoming proof that the command stopped.
- **No automatic-finaliser bypass or unbounded wait is reintroduced.** The [command cleanup owner](apps/server/src/provider/opencodeRuntime.ts#L876) remains `acquireRelease` inside the command’s own scope. The private spawner scope is not closed, so its unbounded or unguarded finaliser does not follow the owned cleanup.

### Scheduler fixture

The [new fixture](apps/server/src/provider/opencodeRuntime.test.ts#L762) targets the earlier gap, not merely the first wait:

1. Native spawn arms a one-shot `Scheduler.shouldYield`.
2. The interpreter yields after the synchronous callback returns.
3. `process.nextTick` delivers the launch error before the dispatcher’s `setImmediate` continuation.
4. Assertions require an actual yield, error delivery before the caller continuation, two failure replays, stopped worker liveness and no termination signal.

Against the old source, that scheduling point precedes listener installation. The fixture’s [no-observer branch](apps/server/src/provider/opencodeRuntime.test.ts#L569) records the miss without crashing the host. The current fixture would fail before its Deferred waits. No listeners are removed to manufacture failure.

### Limits and integration

This is source-only evidence. I did not reproduce the receipt’s red/green runs or quoted failure location. No tests, checks, builds, application/browser/provider execution, child agents or repository changes were performed. Native Windows timing and actual worker termination remain unproven; bounded waiting does not guarantee OS-level termination.

The correction touches only `opencodeRuntime.ts` and its test. It does not establish merge preservation of dev’s `d54cc1e96` unknown-version maintenance guard. Main retains that integration responsibility; an endpoint diff is not merge proof.

HEAD at start and end: `2a924dea91aa6fe45eb9bc54c71269b1539e97ee`, branch `work/core-opencode-cleanup`. Working tree remained clean.
