**Verdict: blocking — not ACCEPT.** There is one source defect in the correction scope, and it sits in the exact case `4c9587615` was meant to close. The other items you listed check out at HEAD.

## Blocking defect

**After a restart, Stop treats "this process never saw a spawn" as proof that no child spawned.**

- **Where:** `apps/server/src/symphony/Runner/Dispatcher.ts:1396-1398`, using the rule at `:379-381`. The record of observed spawns, `spawnedAttempts`, lives only in memory (`:320`, filled at `:831`). `cancelAttempt` never checks the in-memory `ownershipFailures` set or `hasOwnershipFailureEvent`; those are only used at `:508-509` and `:1146-1147`.
- **Trigger:** A child spawns and its identity write fails, so the persisted pid stays null. The failure event may or may not have been written. The server restarts. Recovery correctly holds the item (`identity_missing_for_bound_attempt` or `ownership_unverified`, `Recovery.ts:201-208` and `:341-352`). The user then presses Stop.
- **What happens:** The new dispatcher has an empty spawn record, so `knownNoSpawn` comes out true. Stop then runs `resolveStopClosure` → `closed / no_owner_recorded` → `releaseConfirmedStop` → returns `confirmed` with a `releasedGeneration`. This happens even when the durable `ownership_record_failed` event exists.
- **Impact:** `HandoffService.ts:290-359` accepts that receipt and parks the item, then hands the workspace to Work mode while a child may still be alive. The handback says Stop holds this case; at HEAD it holds only inside the process that dispatched the run.
- **Bounded fix:** Treat "no spawn" as known only when this process dispatched the attempt (for example, a set filled at `:803`), it never saw a spawn, and there is no in-memory or durable ownership failure. In every other case, hold with `identity_missing_for_bound_attempt` or `ownership_unverified`. The other callers (`markFailed`, the cleanup block, the resume check) only run inside the dispatching fiber, so they are not affected.
- **Missing test:** A fresh dispatcher with a bound claim and a null pid, with and without the failure event: `cancelRun` must return `held`. `Dispatcher.test.ts` currently has no test for `identity_missing`, `ownership_unverified` or `no_owner_recorded` at all.

## Verified at HEAD

- **Exact `issue_claimed` token/generation:** the binding is written before any spawn (`Dispatcher.ts:774-802`). `failEarly` moves the item to `failed` if that write fails (`:629-636`). Stop, `markFailed`, cleanup, Recovery and Reconciler all use `claimBindingMatches`; nothing matches on timestamps.
- **Null-pid owner held when both writes failed (dispatching process):** the spawn is recorded at `:831` before the identity write. Recovery (`:201`) and Reconciler (`:112`) always hold a null pid. Only Stop after a restart breaks this (the defect above).
- **Stop intent durable before interrupt:** `stop_requested` is written at `:1312-1325` and the interrupt comes later, at `:1374`. On failure Stop returns `stop_intent_unpersisted` and keeps the claim.
- **Legacy exact `stop_confirmed`:** `:1333-1351` reads the receipt for that exact attempt; a cancelled status alone returns `stop_not_confirmed`.
- **Unreadable latest attempt held:** Recovery `:281-288`; an unreadable ownership row also holds (`:271-278`). Reconciler reads a failure as "no attempt" and leaves the item alone.
- **Resume fence:** `:938-968` checks the binding and closure before validation or PR creation.
- **`releasedGeneration` handoff:** the generation+1 the Stop receipt reports matches the repository's release (`WorkItemRepository.ts:779`). `HandoffService.ts:326-359` refuses if the receipt has no generation or if a replacement claim intervened.
- **Shared platform admission gate:** `SymphonyOrchestratorLive.ts:1715` runs before the `started` acknowledgement at `:1971`, and the Dispatcher uses the same function at `:677`.
- **v2 partial/unavailable reconciliation:** `SymphonyOrchestratorLive.ts:1115-1145` logs unavailable and partial results separately, and a thrown error counts as unavailable, not success.

## Known gaps, kept separate

- **Failed `stop_requested` write test:** this is test coverage only. The production guard is in place (`:1312-1325`), and guidance is adding the test serially. It does not block.
- **Live OS / Stop proof:** none exists and none is claimed. Everything above comes from reading source and the existing deterministic tests.

## Not blocking (all fail closed)

- The c599 notes say `isAgentActive` includes runs that are still starting; it doesn't (`:1451-1460`). Since `4c95`, Reconciler holds a null pid anyway, so the only effect is a spurious `reconciliation_hold` event on a live run during startup.
- Recovery's `settleConfirmedStopIntent` writes `stop_confirmed` without a generation (`Recovery.ts:174-178`). A later Stop on that item is confirmed without a `releasedGeneration`, so Handoff refuses the takeover.
- If the server crashes during workspace preparation for a re-claim, the previous attempt's binding no longer matches the new claim. Recovery and Reconciler then hold the item indefinitely.
- A Stop that ends `held` before interrupting (unpersisted intent, unreadable rows) leaves its in-memory stop marker set. This blocks the run's own failure handling until restart.

I read the source at the working tree's current state. I couldn't run git here, so I did not confirm the HEAD hash, the clean status, or the commit diffs myself, and I didn't write a plan file. I made no edits and ran no builds, tests or signals.
