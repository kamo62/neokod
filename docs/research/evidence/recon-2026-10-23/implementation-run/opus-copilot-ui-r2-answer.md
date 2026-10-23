Now the state adapter and UI files.**Verdict: request changes.** The changes are small and bounded. Nothing at P0 or P1 can be triggered at this HEAD. Two latent P1 defects sit in UI-owned dispatch handling and should be fixed before, or together with, opening the start gate.

**Review target**

- HEAD `0967ea61aec12fcd8739ff35b1de82c2313d8328` on branch `feat/neokod-work-ui`. The worktree is clean (`## feat/neokod-work-ui`, no changes).
- Base `0b5ccd78e6448bba891cb393e0563fb869751894`.
- The projection files are byte-identical to `4a0e84545`, carried as `2af3b49f3`.
- The feedback code here is the older `f08312a96`. Guidance `04d5a172c` is not integrated.

**Why the dispatch defects are latent:** "Run now" and "Run again" are never `available` at this HEAD. Run and attention coverage are always `unknown` (`state/symphonyWork.ts:37-47`), and `startAction` requires exhaustive run history (`symphonyWork.logic.ts:992-996`). That gate belongs to the projection owner, so I have not required server completeness. Findings 1 and 2 become live when it opens.

## Findings

**1. P1, latent: the refusal is erased by the requeue that comes before it**

- **Trigger:**
  - "Run again" on a failed or cancelled item.
  - The server moves the item from failed to queued first (`SymphonyOrchestratorLive.ts:1646-1656`), then refuses it, for example as paused (1667+).
  - The UI stores `priorLifecycle: "failed"` (`SymphonyWorkView.tsx:578-589`).
  - The board then shows the item as queued.
  - The cleanup effect at `SymphonyWorkView.tsx:747-768` sees that queued differs from failed and deletes the refusal.
- **Impact:**
  - The projection's failed → queued → refused path (`logic.ts:710-726`, test at `logic.test.ts:409`) is never reached.
  - The item shows as "queued" under In progress, and the refusal reason disappears.
  - This breaks the 16.16 requirement that a refused admission stays on its story as Not started with a reason.
- **Fix:**
  - When the prior lifecycle is terminal, treat queued as the expected state after a refusal.
  - Clear the refusal only when the current attempt ID changes, the lifecycle moves outside {prior, queued}, the project revision or status changes, or a new dispatch result replaces it.
  - Coordinate with the projection owner. For a refusal, the projection returns `unknown`, "Refresh to recheck" (`logic.ts:1033-1040`), but Refresh never clears the refusal. Either an explicit retry must be allowed, or an explicit operator action must clear it.
  - Move the clearing rule into a pure helper with one test.

**2. P1, latent: the stored unknown-dispatch guard has no way out**

- **Trigger:**
  - The dispatch call fails for a reason other than refusal or interruption, such as a transport drop during reconnect, Symphony being unavailable, or a persistence error.
  - The guard entry stays in localStorage (`SymphonyWorkView.tsx:542-562, 607-611`).
  - It is cleared only when the lifecycle or attempt changes (`708-745`).
- **Impact:**
  - If the request never reached the server for a failed or cancelled item, nothing ever changes.
  - The start action stays `unknown` permanently (`logic.ts:963-967`).
  - The item permanently counts as needing reconciliation, so it appears under In progress and Needs your attention and inflates those counts (`logic.ts:1402-1467`).
  - "Reconcile status" only refreshes.
  - The guard survives reloads and shows in other tabs.
- **Fix:**
  - After the call settles, if a fresh, non-stale board and run read shows the same terminal lifecycle and the same current attempt ID, clear the entry. The server's explicit retry requeues with a `from` guard first, so an unchanged state proves the work was not admitted.
  - For other lifecycles, offer an explicit operator action to clear it, with clear wording.

**3. P2: attention on work outside the loaded list is harder to find**

- **Trigger:**
  - This commit removed the header notes for outside-board attention and unmatched runs.
  - The "Needs your attention" chip counts only board items (`SymphonyWorkView.tsx:138-150`).
  - The only remaining signal is a collapsed `<details>` block after all rows (`290-318`).
- **Impact:** an open question or approval on hidden work can show as "0+" or be missed entirely.
- **Fix:** restore one header note with the outside-board request count, or show it separately on the chip.

**4. P2: "Outside loaded work" lists old run history**

- **Trigger:** `unmatchedRuns` includes every run for any item not on the board (`logic.ts:1703-1707`). That can be up to 1,000 finished attempts beyond the 100-item cap, and all are rendered (`SymphonyWorkView.tsx:365-393`).
- **Impact:** clutter and extra rendering. Finished attempts are not uncertain ownership.
- **Fix:** list only attempts that are active, stop-requested or unknown.

**5. P2: a detail load error hides open requests**

- **Trigger:** if loading the current attempt fails with no data, the error state replaces the whole tab panel (`SymphonyWorkDetail.tsx:1306-1315`).
- **Impact:** requests on older attempts disappear from the detail, even though they can be loaded on their own.
- **Fix:** keep `RequestList` visible next to the error. With no details loaded, it falls back to `ExactRequestActions`.

**6. P2: "no truncation" is treated as proof of no work**

- **Trigger:** the empty-state copy counts as confirmed when only the board reports no truncation (`SymphonyWorkView.tsx:248-287`). It then shows "No work in progress" or "No current work" even when run evidence is unknown, unavailable or stale.
- **Impact:** an active attempt on a finished item cannot be seen without run evidence, so the copy can be false.
- **Fix:** claim confirmed only when run evidence is known and fresh. Otherwise say "No in-progress work observed" with a caveat.

**7. P2, integration blocker with sibling `51eca0f22`**

- `requestStateVariant` (`SymphonyWorkDetail.tsx:234-250`) has no `"delivering"` case. That will fail typecheck with TS2366 once the sibling commit merges.
- `ApprovalRequestHistoryList` ignores `deliveryPending`, so a delivering answer would show as "Question closed".
- **Fix:** add the case and show the sibling's delivery label.

**8. P2, minor wording**

- At this HEAD nothing writes or reads `acceptedGuidance`; only the migration 046 column exists. Every attempt, including new ones, is therefore labelled as predating accepted-guidance storage.
- Treating it as absent is correct. Neutral wording such as "No accepted brief recorded for this attempt" would be more accurate.
- Separately, a hand-typed `?tab=history&filter=attention` URL shows the attention empty-state copy on History.

## Verified as acceptable

- **Exact requests on older attempts:**
  - Attention item IDs match approval request IDs on the server.
  - Answers and decisions send `entry.runAttemptId ?? request.runAttemptId`.
  - An older attempt is loaded only on demand and never borrows the current attempt's payload.
- **Pending guards:**
  - Answer and cancel can't be sent twice at once, and a cancel failure is reported as unknown acknowledgement.
  - The dispatch guard is saved before the call is sent, and an interrupted call keeps it.
  - Stale attention turns answer and approve into `unknown`. Requests outside the board recheck that the exact request is still pending.
- **Unknown states:**
  - Counts show "—" or "N+".
  - An attempt is not promoted to current without the board's ID.
  - The run page does not treat the opened attempt as current.
- **One projection:** list rows, the detail header and the run page all use the shared projection and `workLifecyclePresentation`, and the local copy was removed.
- **Accepted guidance and history:**
  - Only the frozen snapshot is presented as accepted, and the current tracker brief is labelled separately.
  - Answered questions and approvals are labelled differently.
  - Older approved questions are mapped to answered on the server (`ApprovalRepository.ts:186-192`) and shown with no stored content.
- **Ordinary Code is unaffected:** the diff touches only Symphony files and one sidebar comment.
- **Cleanup for the coordinator:** `SymphonyAttentionList.tsx` is now unused and is not in the UI lane's paths.

## What this review covers

- It was source inspection only. I did not run tests, `vp check`, typecheck or a browser, and there is no real provider or UI evidence.
- These belong to the projection owner and are not findings here:
  - Closure, cancelled-item membership, and start-gate behaviour.
  - Reason text such as "Refresh or reconcile", which refresh can never satisfy at this HEAD.
- The refusal is held only in React state. A durable server refusal is outside this lane.
