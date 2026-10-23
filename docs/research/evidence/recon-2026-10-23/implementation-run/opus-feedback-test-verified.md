**Verdict: ACCEPT** at `41a49b825`.

The new test at `apps/server/src/symphony/Runner/ApprovalService.test.ts:1135` deterministically hits the old window, the period after the row is inserted but before `recordRequest` returns to the runtime. Its assertions would fail if cleanup didn't cover that window. The source accepted at `c3e5fd420` passes them by reasoning; I didn't run the test.

**1. The barrier holds `recordRequest` open after the insert (lines 1146–1160, 1182).**

- The wrapper sets `persisted` only after the production `callbacks.recordRequest` finishes, which includes `recordPending` → `repository.create` and the status mapping.
- It then waits on `releasePublication`, which is never released, so `recordRequest` never returns to `handleRequest` (`AgentRuntime.ts:910`).
- When the test passes `Deferred.await(persisted)`, the row is guaranteed to exist and the runtime fiber is guaranteed to be stuck inside publication, before `waitForAnswer`. The assertions at 1186–1187 (row `pending`, one live entry) confirm that state. There is no polling or `yieldNow` race any more.

**2. Closing the scope really interrupts that fiber and waits for cleanup.**

- `consumeIncoming` is started with `Effect.forkScoped` (`AgentRuntime.ts:528`) in the test's `scope`, because `runTurn` gets the scope via `provideService`. `handleRequest` runs inline in that stream.
- In effect `4.0.0-beta.78`, `forkIn` registers a finaliser that calls `fiberInterrupt(fiber)` (`internal/effect.ts:5143`), which waits for the fiber to finish its finalisers. So once `Scope.close` returns, cleanup is done.
- The blocked `Deferred.await` is inside `restore(use(...))` within `uninterruptibleMask` (`AgentRuntime.ts:831–837`), and `consumeIncoming` is `Effect.interruptible`, so the interrupt lands there.

**3. Cleanup is correct and the assertions exercise it.**

- The release step runs `settleOnRelease`, which defaults to `true` (line 833), so `finalizeRequest` runs.
- `finalizeRequest` calls `withdrawPending`, which removes only this exact registration (`LiveRequests.ts:397`), and then `markSettled`.
- `markSettled` calls `requestSettled`, which finds the `pending` row and calls `approvals.interrupt(row.id)`. There `settleRequest` returns false because the entry was already withdrawn, but the state is `pending`, so `decide(id, "interrupted")` runs (`ApprovalService.ts:765–768`).
- Line 1193 (row `interrupted`) and line 1194 (no live entries) would both fail under the old bug, where cleanup was only installed after publication: the registration would leak and the row would stay `pending`. So the test tells the two versions apart.
- Line 1198 (nothing sent for `wireId`) holds because withdrawal sends no response.
- Lines 1202–1211 show the request id can be registered again and that `withdrawPending` checks the exact registration it was given.

**Non-blocking nits:**

- The comment at 1156–1157 says the block is "inside the real production recordRequest wrapper". It's actually in the test's wrapper, after the production callback has returned. From the runtime's side it's still inside `recordRequest`, so the meaning holds.
- `Effect.andThen(Deferred.await(...))` swaps the result for `void`. That's harmless here because it's never released, and the runtime would treat `void` as `recorded` (line 919). If someone later releases the barrier, `Effect.tap` would keep the status.
- Leaving out `Effect.scoped` is fine: `makeFakeCodexPeer` needs no `Scope`, and the runtime gets an explicit one.

Since only the test file changed, the source accepted at `c3e5fd420` still stands. Live proof is still separate.
