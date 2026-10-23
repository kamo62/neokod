**Verdict: REQUEST_CHANGES.** The source is correct for all four points. The one blocking item is test-only: nothing tests the exact window that the prior P2-1 fix closed.

I reviewed the frozen checkout at `c3e5fd420` by reading files only. I have no shell tool, so I couldn't run `git diff 7574eb450..HEAD`. I worked out the changed areas from the two prior review files and traced each fix through its actual callers. I didn't run tests or edit anything. I also couldn't write the plan file or exit plan mode, so the review is here.

## Blocking finding

**B1: No test interrupts after the row is saved but before saving returns.**

- **Source:** `apps/server/src/symphony/Runner/AgentRuntime.ts:823-865`. The fix itself is correct (details below).
- **Gap:** the only scope-closure test, `ApprovalService.test.ts:1135-1180`, closes the scope while the handler is waiting for an answer (after the row is recorded plus `yieldNow ×20`), not while it is saving the request. The old code at `7574eb450`, which attached its cleanup around the wait, passes that test too. `AgentRuntime.test.ts:1157` only covers a save that returns `record_failed`. So if someone moved saving back outside the protected section, no test would fail. The prior reviewer asked for exactly this regression.
- **Fix:** add one test to `ApprovalService.test.ts` (or `AgentRuntime.test.ts`). Wrap `approvalServiceRequestCallbacks(service).recordRequest` so it calls the real `recordPending` and then blocks on a latch. Close the scope while it is blocked. Then assert the row is `interrupted` and `live.listPending(runAttemptId)` is empty.

## Verified in source (no change needed)

1. **Registration and cleanup are now atomic and cover saving the request.**
   - `runWithRegistration` (`AgentRuntime.ts:831-847`) registers inside `uninterruptibleMask` + `acquireUseRelease`. The whole use step runs under `restore(...)`: saving the request, waiting, and responding. So cleanup is attached in the same step as registration, and any interruption, including during `recordPending`, runs the release.
   - The release runs `finalizeRequest` (`:807-816`, uninterruptible). That first withdraws only this caller's exact registration, then calls `requestSettled`. `requestSettled` is wired in `AgentRequestCallbacks.ts:70-81` to `listForRun` → `approvals.interrupt(row.id)`.
   - Because the live entry is already withdrawn, `interrupt` loses the live claim. A `pending` row then becomes `interrupted` (`ApprovalService.ts:765-768`). A `delivering` row is left untouched (`:757-763`).
   - `setSettleOnRelease(false)` (`:926`, `:995`) keeps the release from touching durable rows on the `record_failed` / `duplicate_*` paths.
   - On a normal finish, the release's `interrupt` waits on `resolutionMutex`, then re-reads the row. It finds the decided row, or a `delivering` row with no live claim, and does nothing.
2. **Uncertain `delivering` content is kept unless the live claim is positively won.**
   - `expire` (`ApprovalService.ts:728`) and `interrupt` (`:758`) now require both `claimed` and no local receipt before calling `abortDelivery`. `expireRequest` already returns early when the claim isn't won (`:783`).
   - `decide` and `respondToUserInput` only abort when they lost the claim inside the same uninterruptible save-and-claim step (`:569-576`, `:671-675`). That is positive evidence nothing was sent.
   - Test coverage: `ApprovalService.test.ts:885-891` simulates a restart, calls `interrupt`, and checks that the `delivering` state, the `answered` decision and the answer are all kept, and that reconciliation then keeps them as delivery-unknown (`:893-905`). Only the `interrupt` path is tested. `expire` uses the same guard, which is acceptable.
3. **An unrecognised Stop-all result is `ok:false`.** `ws.ts:482` now returns `{ ok: false }`. It's tested in `ws-symphony.test.ts:183-200`, alongside the legacy numeric case (`:202-215`) and the confirmed/held case (`:434`).
4. **The real Codex factory refuses an unsupported driver or instance before spawning.**
   - `runTurn` checks `driver === "codex"` and `instanceId === "codex_default"` at `AgentRuntime.ts:473-483`. That check comes before the accepted-target check, the permission narrowing, and `initialize`/`spawnAppServer` at `:524`, which is the only place a process is spawned.
   - The production factory (`Live.ts:59`) only builds the runtime and spawns nothing at build time. `AgentRuntimeUnsupportedProviderError` is part of the runtime error union (`:109`). The loader default is `codex_default` (`Workflow/Loader.ts:110`).
   - Tests: `AgentRuntime.test.ts:1192` (Claude driver) and `:1222` (Codex driver with another instance) both assert `spawnCount === 0`.

## Non-blocking notes

- `AgentRuntime.ts:860`: `return yield* Effect.never` sits inside the uninterruptible section. The error type means it can't be reached today, but if a future error type ever reached it, the fiber would hang and couldn't be interrupted. `Effect.void` or `Effect.die` would be safer.
- `AgentRuntime.ts:850-857`: the duplicate-request `respondError` also runs while uninterruptible. It's a short write, so this is acceptable.

Source acceptance is separate from live proof. Codex continuation, the production caller of `reconcileUncertainDeliveries` (recovery lane), and the provider-neutral frameworks are not judged here.
