Verdict: request changes. One P1 and six P2 blockers remain, assuming the supplied dependencies are integrated. No P0 found.

Reviewed `bbe352a84d216a16e5e9f71c5d923e496f80c317` against `0b5ccd78e6448bba891cb393e0563fb869751894`, using projection API `c1fb42238ea347bad6e4c15d5f41a896b1b3e4b9` and feedback contracts/components at `a609a2c0a29fbdc5239e71012c276e730b9a6392` / `b6ff215adcd4f7fd013533802d31a5244027bd45`.

1. P1: live questions cannot be answered after feedback integration.  
   [Drawer callsite](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkDetail.tsx:191) and [run-page callsite](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyRunDetailView.tsx:189) omit both `questionPayload` and `runAttemptId`. The dependency renders an unavailable message when the payload is absent. Every live question therefore loses its answer form. Match each attention entry to its durable `ApprovalRequest`, fetch that request’s exact attempt where necessary, and pass its structured payload and attempt identity. Attribute older requests to their actual attempt/provider rather than the selected current run.

2. P2: known attempts disappear behind the recent-run cap.  
   [SymphonyWorkView.tsx:300](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkView.tsx:300) fetches detail only through `attempts.current`. Production run summaries are globally capped before project filtering. When a board card supplies `latestRunAttemptId` but its summary falls outside that window, the projection correctly leaves `current` unknown; this UI consequently disables the exact-detail query. Execution then incorrectly says no attempt is recorded. Use the authoritative card attempt ID for an on-demand exact fetch while preserving unknown summary coverage.

3. P2: outside-board attention is counted but unreachable.  
   [SymphonyWorkView.tsx:179](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkView.tsx:179) reduces `attentionOutsideBoard` to prose. Neither the attention filter nor History inserts those items, and the previous project Attention tab has been removed. A request attached to an omitted item cannot be inspected or resolved through this screen. Make the scoped notice open the supplied exact requests/attempts without inventing board rows.

4. P2: the drawer discards shared action semantics.  
   [SymphonyWorkView.tsx:326](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkView.tsx:326) consumes only `start` and `run_again`; projected `cancel`, `answer`, `approve` and `reject` actions are discarded. The drawer reconstructs request controls independently, and cancellation requires navigating to a separate page with its own active-status rule. Pass the projected action set into detail and wire available actions using their exact identities and states.

5. P2: unknown attention becomes an affirmative empty claim.  
   [SymphonyWorkView.tsx:218](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkView.tsx:218) says “Nothing needs you” and “There is no open question or approval” whenever the filtered rows are empty. This also occurs while attention is unknown or unavailable. A coverage footnote does not make that claim accurate. Select empty-state copy from evidence and coverage; reserve confirmed-empty wording for exhaustive successful reads.

6. P2: Plan misrepresents mutable tracker content as accepted input.  
   [SymphonyWorkDetail.tsx:243](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkDetail.tsx:243) reads `details.workItem`, then calls it the accepted brief. Production polling updates that item’s objective, description and acceptance criteria, including during existing runs. A later tracker edit therefore appears to rewrite the accepted brief. Render `runAttempt.acceptedGuidance` when available, including its provenance and policy; label legacy absence explicitly and distinguish current tracker text.

7. P2: Activity omits durable answer and note history.  
   [SymphonyWorkDetail.tsx:225](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkDetail.tsx:225) renders pending attention and timeline events but never the decided `approvalRequests`. After refresh, submitted answers and history-only notes disappear from the drawer despite being supplied by the feedback contract. Render the durable history through `approvalRequestHistory`, preserving answered/approved distinctions, redaction and unconfirmed provider receipt.

Source inspection supports All current as the default, overlapping attention membership, detail mounted on demand, visible project repository/server context and continued Codex-only execution gating. It does not establish visual calmness or working provider/model-effort support.

No files changed. No builds, installs, tests or browser execution were performed. Required checks, visual acceptance and live Codex continuation remain unverified. The projection files are absent from this UI commit itself, so this is a dependency-aware source review, not verification of an integrated runtime.
