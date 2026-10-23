**Verdict: accepted.** At this SHA I found no concrete production defect introduced by this lane. Three P2 issues are latent, and each becomes a must-fix at a specific point: when the Work UI starts using the hook, or when something starts supplying stop-closure evidence.

**What I reviewed:** HEAD `4a0e845450a32e025f14cae04b8ed65c3e63c633`, clean according to the session-start git status. I could not re-run git because this review was read-only. I read the three changed files against plan.md 16.15–16.17, AGENTS.md, `docs/architecture/state-and-evidence.md`, `REVIEW-FLOW-2026-10-22.md`, the contracts, the server readers (`getProjectBoard`, `listRuns`, `listAttention`, `prepareDispatch`), `Dispatcher.cancelAttempt` and the client query/subscription plumbing. I ran no tests, typecheck or browser checks. Everything below is source-only and proves nothing about live behaviour.

**Callers:** `useSymphonyProjectWork` and `projectSymphonyWork*` have no production callers. The only references are the lane's own files and the test. The Overview/Running logic is unchanged. Nothing user-visible changes at this SHA.

## What holds up

- **Coverage text matches the server.** The board's `truncated` flag is computed from column totals (`ProjectBoard.ts:116-120`). Project-filtered runs come from the newest 1,000 attempts (`SymphonyOrchestratorLive.ts:1256`). Attention reads are capped and failures fall back to `[]` (`:1366-1377`). Runs and attention are therefore never treated as "known empty".
- **Stale data is retained and labelled.** `AsyncResult.value` keeps the previous success after a failure, so `evidenceFromQuery` marks it stale rather than fresh, and Start, cancel and answer/approve/reject drop to "unknown" while stale.
- **Cancellation is treated as requested, not confirmed.** `cancelAttempt` writes `user_cancelled` before the process is interrupted (`Dispatcher.ts:661-686`). Treating the cancel/interrupted statuses as "stop requested" without closure evidence is correct.
- **Refusal matches the server.** The failed/cancelled → queued → refused path matches `prepareDispatch` (`:1646-1657`).
- **Attention overlaps lifecycle as designed.** One item can be both In progress and Needs your attention, and attention outside the board is counted without inserting rows. This matches `REVIEW-FLOW` lines 18-20.
- **No false claims.** `observedTarget` is labelled a current observation, not admission evidence. Actions are keyed by attention item ID with no per-question or delivery claim. Ordinary Code delegation is not mixed in.

## P2 findings (latent; not blocking at this SHA)

**P2-1: A disconnected board is reported as fresh.**

- **Trigger:** the WebSocket session drops. `subscribe` switches to `Stream.empty` (`packages/client-runtime/src/rpc/client.ts:170-174`). The atom keeps its last success with no error, so `evidenceFromQuery` (`apps/web/src/state/symphonyWork.ts:62-82`) reports a fresh "known" board. The polled runs and attention queries also hold their last value while disconnected.
- **Impact:** the hook docstring (`:136-140`) promises that stale sources cannot authorise actions, and state-and-evidence line 24 requires freshness metadata. Once the UI uses this hook, a disconnected client shows lifecycle and actions as current, without a stale marker.
- **Fix:** read the environment connection phase from the existing `networkStatus`/supervisor state atom. While it isn't `connected`, pass each known source with `staleReason: "Disconnected from the environment."`. Add a test for this.

**P2-2: A work-item closure confirms later stops.**

- **Trigger:** `closureFor` (`symphonyWork.logic.ts:476-490`) and `hasConfirmedWorkItemClosure` (`:492-502`) accept a closure with no `runAttemptId` for any attempt and ignore `observedAt`. An older work-item closure therefore turns a later `user_cancelled` attempt into "stopped". Ownership then becomes `none_observed`, and Run again becomes available while the new process may still be alive.
- **Impact:** this breaks the confirmed-Stop invariant. It is latent only because nothing produces `stop_confirmed` today (the grep finds it only in the lane's own logic and test).
- **Fix:** apply a work-item closure only to attempts whose `startedAt` is at or before `observedAt`, or only to legacy cancelled records with no attempts. Add a regression test with a stale work-item closure and a later cancelled attempt.

**P2-3: Refused items dead-end, and old stop records flood In progress and attention.**

- **Refusal trigger:** Run again on a failed item while paused leaves the card queued with refusal `{paused, priorLifecycle: "failed"}`. The `refused` branch (`:1033-1040`) always returns "unknown" with "Refresh to recheck…", but `refresh()` never clears the dispatch facts the caller holds. The same server state with `priorLifecycle: "queued"` returns "available" (`:1043-1051`), which is inconsistent.
- **Fix:** when every other gate passes, return "available" with the refusal shown in the reason (keep the Not started label). Alternatively, state in the hook API exactly when the caller must clear a refusal.
- **Flood trigger:** take a completed item whose first attempt was `interrupted` (for example, recovery after a restart) and that a later attempt finished. `reconciliation` (`:1402-1406`) and `inProgress` (`:1462-1466`) are true permanently. Every cancelled card among the newest 100 finished items also stays in All, In progress and Needs your attention, with no action to clear it, because no closure producer exists.
- **Fix:** keep these in All and History, and flag them as reconciliation with "Stop not confirmed". Don't add them to `inProgress` unless the stop-requested attempt is the current one or there is no later attempt. Ask the coordinator to get closure evidence from the recovery lane.

## Limitations to hand to the coordinator and UI lane

- **Start is never "available" in production.** Runs and attention coverage are always unknown, so Start and Run again always come out "unknown". This is the honest result under 16.17. Making it available needs server-side completeness or ownership evidence requested through the coordinator. The UI must show the reason, not a broken button.
- **Refusals are lost on reload.** They live only in client memory, so a refused item shows as queued/In progress after a reload. Showing refusals durably needs a server event.
- **The attention count is never "known zero"** for the same coverage reason.

If any code changes, the final SHA needs a recheck.
