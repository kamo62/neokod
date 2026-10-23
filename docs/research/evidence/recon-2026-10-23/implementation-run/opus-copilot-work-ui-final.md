**REQUEST_CHANGES**

I reviewed HEAD `6debed050336ff904056d80d9f7e6013f975c7b0` with a clean working tree (`git status` is empty). The range is `0967ea61a..HEAD`: 15 commits and 42 files. Most of the requested checks hold. One P2 remains, on the delivering/interrupted history path.

## P2: Delivering history hides the staged decision, and startup reconciliation is never called

**Trigger.** A request reaches `delivering` in either of two ways:

- the live answer or approval is accepted locally, then `completeDelivery` fails (`ApprovalHistoryPendingError`, delivered = true); or
- the process stops between `stageDelivery` and `completeDelivery`.

**Path**

- `apps/server/src/symphony/Runner/ApprovalService.ts:547-570` (stage, claim, complete) and `:733-751` (`reconcileUncertainDeliveries`). The repo-wide `grep` finds no caller of `reconcileUncertainDeliveries`; it was added in `915eb9bc1`. Its comment says it runs at startup, but nothing calls it.
- `apps/server/src/symphony/Persistence/Layers/ApprovalRepository.ts:361-371`. `reconcileDelivery` sets both `state` and `decision` to `interrupted`.
- `apps/web/src/components/symphony/SymphonyWorkDetail.tsx:333-343` and `RequestActions:463-468`.
- `apps/web/src/components/symphony/attention.logic.ts:118-128`.

**Impact**

- **Approvals:** a delivering approval shows only "Approval delivering". It never shows `request.decision`, so the operator cannot tell whether approve or reject may have reached the agent.
- **No retry after reload:** the in-process retry only works while the original panel stays mounted. After a refresh or remount the request is no longer `pending`, so the UI shows "already delivering" with no retry.
- **Stuck rows:** because reconciliation is never called, these rows stay "delivery pending" across restarts even though delivery is unknown.
- **If wired as written:** `reconcileDelivery` would overwrite the staged approve/reject with `interrupted`. That would erase the one fact that matters, even though the comment says the content is kept.

**Bounded fix**

1. In the web history adapter, show `delivering` as "Delivery unknown" and show the staged `request.decision` (approved, rejected or answered) for approvals.
2. Then choose one:
   - make `reconcileDelivery` keep the staged decision (`state = interrupted`, `decision` unchanged; update the contract comment), call it from Symphony startup, and show interrupted rows with a staged decision as delivery unknown; or
   - remove the unused method and its startup claim, and record the gap.
3. Add one repository test (staged decision survives reconciliation) and one history-projection test (a delivering approval shows its staged decision).

## Verified (source only)

- **Exact request and attempt identity:**
  - `RequestActions` and `ExactRequestActions` send `entry.runAttemptId ?? request.runAttemptId`. Older and outside-board requests load through `getRun` for their own attempt id.
  - The server rejects a mismatched `runAttemptId`, and live requests are keyed by `runAttemptId:requestId` with insert-if-absent.
  - Attribution comes from the loaded attempt only.
- **Exact loaded run in the single projection:**
  - The exact `getRun` attempt replaces its duplicate. Coverage drops to bounded when that attempt was not already in the capped list, and is never raised to exhaustive.
  - `stopClosure` is only used when there is no detail error, and it must match the exact attempt id with closure time at or after the attempt start.
- **Malformed history rows:** an undecodable answer or note now produces `historyUnavailable` instead of failing the row, and the UI says that missing content is not evidence of an empty answer. Blank option descriptions now decode.
- **Empty, capped and stale copy:**
  - "Nothing needs you" and "No current work" require known, exhaustive and fresh evidence. In production, run and attention coverage are always unknown, so the attention empty state stays "observed".
  - The History empty state cannot be changed by the filter.
- **Unmatched runs:** the footer lists only active or stop-status attempts.
- **Refusals:** `shouldClearWorkRefusal` keeps a refusal through the server's terminal → queued requeue and through unknown lifecycle or attempt evidence. It clears only on a project policy or status change, a different attempt, or a lifecycle change outside that requeue.
- **Lost dispatch:** the pending guard clears only on an observed lifecycle or attempt change. An item missing from the capped read keeps the guard, and refresh never clears it.
- **Typed Stop:**
  - `orchestrator.cancelRun` returns `void`, so production always shows "did not include a confirmed or held outcome". A held Stop is reported as not ok and ownership is not released.
  - A Stop without closure stays "Stop requested; closure unknown", so ownership stays unknown and the item stays in progress and needing attention.
- **Accepted Plan copy:** "Accepted brief not recorded" is neutral, and the current tracker brief is labelled as not proof of what the attempt accepted.
- **Machine and provider:** shows "Machine not reported" or the attempt's actual provider; nothing is invented.
- **Header:** the header stacks into a column below `sm` and the action buttons wrap.
- **Permission narrowing:** accepted `untrusted` with live `never` is now refused; the regression test exists. The other policy pairings choose the more restrictive policy.

## Non-blocking notes

- **Drawer staleness:** the drawer rebuilds the projection with the board card but without the board's stale reason. When the work list never loaded runs or attention, cached exact detail also counts as fresh while disconnected. Today this only changes the Start reason text or briefly enables actions the server will reject. The merge and the stop-closure extraction duplicated in `SymphonyWorkView.tsx` and `SymphonyRunDetailView.tsx` would sit better as one tested pure helper.
- **Stop result attempt id:** `stopResultFrom` does not check that `outcome.runAttemptId` matches the requested attempt. This cannot happen today because `cancelRun` returns `void`, but it should be checked before a typed outcome ships.
- **Duplicated stop statuses:** `UNRESOLVED_UNMATCHED_RUN_STATUSES` repeats `STOPPED_RUN_STATUSES` from the projection, so the two lists can drift.

## Limits

This verdict is from reading source only. I ran no tests, typecheck, build or browser, used no subagents and read no other reviewer findings. I did not inspect the Chrome captures. Matching-runtime validation remains a separate gate after integration.
