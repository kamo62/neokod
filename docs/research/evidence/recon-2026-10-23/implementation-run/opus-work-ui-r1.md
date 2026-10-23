# Opus 5.5 independent review: work-ui lane

**Verdict: request changes.**

- **Reviewed SHA:** `bbe352a84d216a16e5e9f71c5d923e496f80c317` on `feat/neokod-work-ui`, status clean.
- **What I read:** source only, using Read/Glob/Grep. I made no edits and ran no commands, builds, tests or browser checks.
- **Dependency checked:** I compared the lane against the projection files in `/Users/kamogelo/.codex/worktrees/neokod-projection/t3code`. That branch ref resolves to `c1fb42238ea347bad6e4c15d5f41a896b1b3e4b9`. I can't confirm that worktree is clean.
- **Not proven:** this is source evidence only. It says nothing about live runtime, provider or browser behaviour.

## P1: will block

### P1-1: The lane imports modules that aren't in its tree

- **Where:** `apps/web/src/components/symphony/SymphonyWorkView.tsx:21`, `:23` and `SymphonyWorkDetail.tsx:14` import `../../symphonyWork.logic` and `../../state/symphonyWork`.
- **Trigger:** neither file exists at the reviewed SHA. A Glob for `**/symphonyWork*` finds nothing.
- **Impact:** typecheck fails, and the project route can't resolve its modules. The commit can't be integrated on its own. This is the plan's own dependency ("filters wait for projection"), but the commit wires filters to it anyway.
- **Fix:** rebase or integrate after the projection commit, then re-review the combined SHA. The projection worktree's current API matches what this lane uses (`useSymphonyProjectWork`, `SymphonyWorkCollection` fields, `attempts.current/currentState/currentReason`, `actions[].kind/state/reason`, `attentionOutsideFilter/Outside Board`, `SymphonyWorkDispatchFacts`).

### P1-2: A known attempt is hidden and reported as "none recorded"

- **Where:** `SymphonyWorkView.tsx:300` loads `getRun` only from `selectedItem.attempts.current`.
- **Why that is null when it shouldn't be:** `attempts.current` is null whenever the board's `latestRunAttemptId` isn't in the loaded runs evidence. In the projection's `buildAttempts`, `currentState` is then `"unknown"`.
- **Trigger:** any of these:
  - the server's `listRuns` reads only the newest 1,000 attempts across all projects, then filters (`SymphonyOrchestratorLive.ts:1256`);
  - `listRuns` silently returns `[]` when the read fails (`:1257`);
  - the runs query is still pending while the board has loaded.
- **Impact:** `SymphonyWorkDetail.tsx` then claims absence:
  - `:282` says "No execution attempt is recorded for this item."
  - `:392` says "No evidence bundle is recorded for this item."
  - `:227` says "No execution record…"
  - The PR panel, pending run-scoped requests from `getRun` and the "Open full run" link (`:383`) all become unreachable.

  The old board card always linked `latestRunAttemptId`, so this is a regression. It also breaks the unknown-versus-zero rule.

- **Fix:**
  - Key `getRun` on `selectedCard.latestRunAttemptId`. That is the projection's own current-attempt input, so this is not a re-derivation.
  - When `details === null`, render based on `attempts.currentState`: show `currentReason` for unknown and "not loaded" while pending. Reserve "none" for `currentState === "none"`.
  - Keep a link to the known run ID.

## P2: should fix, scoped corrections

### P2-1: A stale client refusal keeps "Run now" blocked

- **Where:** `SymphonyWorkView.tsx:263` and `:358`. Refusals are cleared only by a later successful dispatch.
- **Why it sticks:** the projection blocks start for any refusal that isn't `concurrency_cap` or `tracker_refresh_failed` (projection `startAction`), so that successful dispatch can never happen.
- **Trigger:** the project is paused, the user clicks Run now and gets refused with `paused`, then the user clicks Start project. Run now stays disabled with "last dispatch was refused (paused)". The same happens with `already_running` or `not_dispatchable` after the lifecycle moves on.
- **Fix:** store a snapshot with each refusal (item lifecycle plus `project.status`/`revision`). Drop the refusal when they change, mirroring the pending-ack effect at `:409`.

### P2-2: An unknown acknowledgement has no way out, and the guard leaks

- **Where:** `:384` sets pending on a non-interrupt failure. The effect at `:409`/`:422` clears it only if the lifecycle or attempt changes, or execution is observed.
- **Trigger:** the dispatch fails in transport before reaching the server. Nothing changes, so Run now stays "unknown"/disabled, and "Reconcile status" (`:485`) is just a refresh that can't resolve it.
- **Leak:** the state is local to the component. Switching to Settings and back, or reloading, silently drops the guard, which defeats the "no blind second dispatch" intent.
- **Fix:** after a fresh, non-stale board and runs read that shows no change and no active attempt, let Reconcile explicitly clear pending with copy that says so. Keep pending outside the component (keyed by environment, project and work item) so it survives switching tabs.

### P2-3: The Attention empty state claims zero when coverage is unknown

- **Where:** `:218`.
- **Trigger:** filter = attention with no rows. Production attention coverage is always `unknown` (`state/symphonyWork.ts` `ATTENTION_COVERAGE`), and it can also be `unavailable`.
- **Impact:** the copy says "Nothing needs you… There is no open question or approval," while the count shows "—" and the note says "may be missing." The messages contradict each other and the empty-state claim is false.
- **Fix:** choose the empty copy from `collection.counts.attention.state`: known → none; unknown → "None observed; completeness not reported"; unavailable → read failed.

### P2-4: Attention outside the board can no longer be acted on

- **What changed:** the removed Attention tab listed every project request through `SymphonyAttentionList`, with Open run links and actions. That component now has no caller.
- **Trigger:** an open request on an item outside the loaded board, for example a finished item beyond the newest 100.
- **Impact:** `coverageNote` (`:179`) shows only a count. No project or global surface can reach the request, which breaks "pending approvals remain discoverable."
- **Fix:** render `collection.attentionOutsideBoard` entries as a compact list with run links. They are already projected, so this adds no re-derivation.

### P2-5: The Plan tab calls the current brief "accepted"

- **Where:** `SymphonyWorkDetail.tsx:274–275` says "The accepted work brief above is the recorded input."
- **Why it's wrong:** it renders `details.workItem` (the current durable record from `getById`) or `card.title`. That isn't a frozen accepted-attempt snapshot, and tracker edits change it. The claim conflicts with F6 and the frozen provenance requirement.
- **Fix:** label it as the current work-item brief that may differ from what the attempt accepted. Show the accepted guidance, permission and provenance snapshot only once the guidance lane exposes it.

## Checked and not blocking

- **Hook order:** fine in `SymphonyProjectView`. The early return for a null environment comes after all hooks.
- **Attention source:** `getRun` returns only pending attention (`SymphonyOrchestratorLive.ts:1347`), so `RequestList` can't show resolved items as waiting. `attentionMode` matches the projection's gating on `availableActions`.
- **Work runs and Symphony stay separate:** nothing in the diff changes conversational Code children or turns them into Symphony runs.
- **Question answering:** still the existing single-text `SymphonyApprovalActions`, so the per-question S2 gap carries over unchanged from the old Attention tab and run page. It isn't new, but inline questions stay gated on the feedback contract.
- **Not introduced here, noted:**
  - Raw `JSON.stringify` of the timeline payload, and `workItem.evidence` scoped to the item rather than the attempt, both predate this lane (`SymphonyRunDetailView`).
  - `/symphony/$runId` doesn't use the projection yet.
  - The "Server" / machine label is the client connection's target label, not a machine identity the server reports.
- **Route parsing:** the legacy aliases (`tab=board/runs/attention`, with `attention` carrying its filter) are correct. No caller in the tree still passes the old tab values.

## Recheck needed

Re-review is required on the final integrated SHA, with the projection commit included, after the P1 fixes.
