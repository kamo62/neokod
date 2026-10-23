# Review of lane "Recovery and confirmed Stop": changes requested

**Reviewed SHA:** `b79afbcd3d8c393215545fc62c638daba8208bef`, working tree clean. Both the SHA and the clean status come from what you supplied; I was not allowed to run git to confirm them. I did read the source at that tree, and it matches the diff.

**Evidence:** source and caller tracing only. I ran no tests, builds or browser checks, so nothing here proves live provider, runtime or browser behaviour.

**What's sound:** the shared `confirmOwnedProcessClosure` policy is correct in isolation. It never signals a bare, recycled or unverifiable pid, and a leader that exits is not treated as closure of its group. Recovery re-reads the claim and compares it before acting. The tests use fake readers and signallers, so no real process is ever signalled.

The problem is that production never supplies the identity this policy needs. On top of that, an unchanged sweeper (the Reconciler) undoes every hold. As a result, both headline guarantees fail on the real path.

---

## P0-1: A Stop on any spawned run is never confirmed, and the Reconciler then relaunches the run

**Root cause:** production never stores or captures the group id (pgid) or birth token.

- The work-item row holds only `owner_pid`: `WorkItemRepository.ts:54, 191, 246` and migrations 035/041. The contract fields at `packages/contracts/src/symphony.ts:496-500` are never persisted.
- The Codex child is not spawned as a group leader, and no birth token is captured (`Runner/AgentRuntime.ts:207-224`). `onChildSpawned` passes only the pid.
- `processGroup.ts:351-379` says itself that "Today Symphony persists only `ownerPid`". So every run that has spawned its child resolves to `held: unproven_group_identity`.
- The line in plan 16.17 (`plan.md:1962`), "Ready with existing stored PID/PGID/birth-token fields", is false for production.

**Trigger:** clicking Cancel on any run in `streaming_turn`. The call path is `SymphonyRunDetailView.tsx:189` → `ws.ts:1104` → `SymphonyOrchestratorLive.ts:1887` → `Dispatcher.cancelAttempt`.

**What happens:**

1. `Dispatcher.ts:771` returns held, so the unconfirmed branch at 803-836 runs.
2. The cleanup block that runs when the dispatch fiber ends returns early (667-669). The item stays `running` with its owner token, and the attempt stays non-terminal.
3. On each poll tick, `Reconciler.ts:105-141` (called from `SymphonyOrchestratorLive.ts:819`) sees no active agent and an attempt older than `codexStallTimeoutMs` (default 300 000 ms, `Config.ts:45`).
4. It writes `stalled`, runs `releaseClaim("queued")`, and `launchNextQueuedWork` (line 822) dispatches the item again.

**Impact:** the user's Stop becomes an automatic relaunch of a full-permission agent. Runs older than 5 minutes relaunch on the next tick; younger ones relaunch once they pass 5 minutes. That means new token spend, new edits and possibly a push or PR. Before this commit, the same Stop ended in `cancelled`. This breaks "never release ownership on an unconfirmed Stop".

**Why the tests miss it:**

- `Dispatcher.test.ts` and `Recovery.test.ts` inject pgid and birth token through decorated repositories. Their own comment says the schema "does not store yet".
- `fakeCodexRuntimeFactory` ignores `onChildSpawned` (`FakeCodexPeer.ts:353`), so the RunnerFlow cancel test never records a pid.

**Bounded correction:**

- **(a) Store real identity.** Through the shared migration/contract owner, add `owner_pgid` and `owner_birth_token` columns plus the row mapping. Through the feedback/AgentRuntime owner, spawn the child detached and capture `captureProcessBirthToken`, as `AcpSessionRuntime.ts:376` already does. Then carry pid, pgid and token through `setClaimOwnerPid`.
- **(b) Make holds stick.** Route the Reconciler's terminal and stall releases through `confirmOwnedProcessClosure`, or skip items whose latest attempt has an unresolved `stop_unconfirmed` or `recovery_hold`.
- **(c) Add a regression test:** unconfirmed Stop, then a reconcile tick past the stall timeout. The item must still be held and not dispatched again.

(b) needs the coordinator to give this lane `Reconciler.ts`. It must land before merge even if (a) is staged.

## P1-2: Recovery holds are undone by the Reconciler, and a succeeded run is now re-dispatched

**Trigger:** a restart with any spawned run still held. In production that is every spawned run, for the reason in P0-1.

**What happens:**

- `Recovery.ts:224-236` records `recovery_hold` and returns.
- On the next tick, `Reconciler.ts:110-116` immediately releases items whose attempt is terminal to `queued`.
- Items with non-terminal attempts are marked stalled and released at 119-141.

**Impact:**

- The documented hold (`Recovery.ts:42-47`) and the behaviour test 3203 asserts both disappear within one tick.
- **Regression:** a `succeeded` attempt used to land in `ready_for_review` (REVIEW P1 #11). Now it is requeued and re-dispatched, repeating its edits, push and PR creation.
- Any surviving orphan process now runs beside the relaunch with no signal at all.

**Correction:** the same as P0-1 (b), with a test that a held `succeeded` attempt is never requeued by a sweeper.

## P1-3: The UI and callers report a Stop as cancelled even when it is held

**Callers report success regardless of outcome:**

- `cancelRun` still returns `void`.
- `SymphonyOrchestratorLive.ts:1887-1908` always writes audit `run_cancelled` and publishes "Run cancelled".
- `ws.ts:1104` always returns `{ok:true}`.
- `stopAllRuns` counts held stops as stopped (`Dispatcher.ts:849-860`, `ws.ts:1182`).

**Repeat clicks and the UI:**

- On the held path the stopping marker is never cleared, so a second Stop returns silently (`Dispatcher.ts:730-735`). Closure is never re-checked and no event is written.
- Nothing in `apps/web` reads `stop_unconfirmed` or `recovery_hold`. The run detail page keeps showing the run as active with a Cancel button.

**Impact:** the user is told the run was cancelled while it is actually held, and per P0-1 it will be relaunched. This breaks honest delivery, and the lane's requirement of "visible reconciliation for unverifiable ownership" is not met.

**Correction:**

- Return a typed outcome, `{status:"confirmed", evidence} | {status:"held", reason}`, from `cancelRun` and `stopAllRuns`, and carry it through the orchestrator, ws, notifications and Handoff.
- On a repeated Stop, re-check closure instead of returning silently.
- Show the hold reason in the single lifecycle projection (owned by the projection lane).

## P1-4: A Stop can hit the wrong run, and Stop now cancels items the transition rules never allowed

**What changed:**

- The guard `latest.id === runAttemptId` was removed from `cancelAttempt`.
- Closure is now checked against the item's current claim (`Dispatcher.ts:740-745, 771`), whichever attempt is being stopped.
- `releaseConfirmedStop` (`WorkItemRepository.ts:690-711`) has no owner-token or generation check. It matches any non-terminal lifecycle, including `ready_for_review`, `changes_requested`, `ready_to_merge` and `validation_failed`. The transition rules table (`WorkItemRepository.ts:105-115`) never allowed those to become `cancelled`.

**Trigger:** a cancel request for an attempt that is no longer current. For example, a stale tab still shows attempt N as running after a retry started attempt N+1.

**What happens if N+1 has not spawned yet (`ownerPid` null):**

- The closure check returns closed with `no_owner_recorded`.
- Attempt N's recorded result is overwritten with `user_cancelled`.
- N+1's live claim is cleared and the item is cancelled while N+1's fiber keeps running. N+1 is not marked as stopping, and its owner-checked writes now silently fail.
- If the item was in review, the review item is cancelled.
- Once pgid is stored, attempt N's Stop would SIGTERM N+1's process group.

**Correction:**

- Restore the latest-attempt check, and refuse a Stop for an attempt that is not current or already terminal.
- Make `releaseConfirmedStop` check the snapshot's `ownerToken` and generation, and limit its source lifecycles to the existing `cancelled` sources.
- Add a test for a Stop on a stale attempt.

## P2-5: The Stop closure check can use a stale snapshot

**Stale read:** the item is read before the interrupt (`Dispatcher.ts:740-745`). The pid is written during the first turn (`AgentRuntime.ts:221-224` → `Dispatcher.ts:440-450`). A Stop that lands during spawn therefore sees a null pid and records `stop_confirmed` with `no_owner_recorded`, which is false.

**Timeout:** if the 5 s wait for the fiber to exit times out (764-768), the code still goes on to settle the Stop. It releases the claim with no evidence that the dispatch fiber exited.

**Correction:** re-read the claim after `Fiber.await` and compare it, as Recovery's `resolveOwnerClosure` does. On timeout, hold with a reason such as `dispatch_not_exited`.

---

**Not blocking:** Handoff takeover after Stop already aborts at the park step. It did so before this commit too (the `cancelled` item, `HandoffService.ts:336-356`), so this commit didn't cause it. It is still worth fixing once Stop returns a typed outcome.

**Verdict: request changes** on `b79afbcd3d8c393215545fc62c638daba8208bef` (clean as supplied). Once code changes, the final SHA needs a fresh review covering P0-1 (a) and (b), P1-2 to P1-4, and the regression tests named above.

I couldn't save this to the plan file or call `ExitPlanMode`, because this session only had read-only tools.
