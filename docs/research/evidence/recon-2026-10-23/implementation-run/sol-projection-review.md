# Independent Sol projection review

What this change does: Adds one pure Work projection for lifecycle, attention, attempts, actions and collection filters, with React query adapters. It correctly separates item lifecycle from attempt outcome and retains observed attention on older attempts.

Verdict: Fix 1–4 before acceptance. Fix or remove the unused exact-run adapter in 5 before wiring it. No source edits were made by this review.

Reviewed source: `c1fb42238ea347bad6e4c15d5f41a896b1b3e4b9`, against `0b5ccd78e`. The committed change is three new files, 2,682 lines. I rechecked the final amendment from `5f11644d2`; its only delta is the equivalent `pendingDispatch` object construction. Final lane checkout was clean.

SHA-256 of committed files:

| File                                      | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/src/symphonyWork.logic.ts`      | `a700bc8cb28f73f6a51905bd4c5ed7af2567b7fd93d4795b0951bef7592a4bef` |
| `apps/web/src/state/symphonyWork.ts`      | `1dbdd394fd5e8df9ead5b888904f0f1c32e8c9ee6163de49bcf79c771e0f8360` |
| `apps/web/src/symphonyWork.logic.test.ts` | `8a6da2fb0736b25f366c9a951861193abe6ba3bfcea693acf41b87ce04c40029` |

## Must fix

1. **[P2] A failed refresh becomes fresh-looking known evidence** (`state/symphonyWork.ts:97–102`, `symphonyWork.logic.ts:402–411`, `resolveLifecycle`, `projectAttention`, collection return).

   The hook deliberately preserves cached data with `stale: true`. `useEnvironmentQuery` can return that data together with an error because Effect's `AsyncResult.value` returns `previousSuccess` on failure. The pure projection never exposes or acts on `stale`; it returns lifecycle/runs/attention evidence as `known`, and current-looking counts and available actions. Collection construction also strips the board's stale flag when making each card's evidence. A previously clear attention response followed by a failed read therefore looks the same as the earlier successful response, and stale lifecycle can still authorise Run again. Only the board error leaves the project hook; cached run/attention errors disappear entirely.

   Fix: retain freshness and the failed-read reason in projection output, including per-item board evidence. Keep last-known rows visible, but preserve unresolved current ownership/action state until the relevant read succeeds. A bounded regression should cover success followed by failure with cached data, rather than only a failure with no data.

2. **[P2] Missing earlier-attempt evidence still produces an available retry and no observed ownership** (`symphonyWork.logic.ts:736–789`, `1125–1144`).

   Concrete input: a known `failed` card plus unavailable runs and unavailable attention. `buildAttempts` produces an empty history with unknown coverage, but `startAction` only blocks positively observed work/requests and returns `run_again: available`; ownership becomes `none_observed`. The same happens when the bounded project-run window omits the relevant earlier attempt. The output retains generic coverage uncertainty, but its actual ownership/action decision treats absence as sufficient. This fails the lane requirement to preserve unknown earlier ownership. I have not claimed a live duplicate dispatch; this is a source-level semantic and admission-affordance defect.

   Fix: derive action availability and ownership from affirmative ownership/closure evidence, carrying unknown through failed/incomplete reads. If the current server queries cannot establish that evidence, request the smallest authoritative read/contract addition from the coordinator instead of treating the capped absence as clearance. Add one focused missing-earlier-evidence case. Do not require a new general state machine.

3. **[P2] A recoverable refusal permanently disables Run in the same view** (`symphonyWork.logic.ts:395–398`, `775–780`; pending Work UI `SymphonyWorkView.tsx:318–347`).

   `paused`, `not_leader`, `no_workflow`, `observe_only` and `excluded` are treated as permanently non-retryable client facts. Example: queued item → Run → server replies `paused` → operator resumes dispatch → fresh board still says queued. The projection continues returning blocked solely because the old refusal remains. The pending UI clears that refusal only after a successful dispatch, but the blocked action cannot send that dispatch. Refresh/reconcile does not clear or supersede it.

   Fix: preserve the last refusal as history/explanation, not an unbounded current-policy latch. Re-evaluate against current authoritative policy, or offer an explicit retry/recheck path after the refused command; server policy remains the final gate. Reuse `dispatchRefusalMessage` for human wording instead of adding another refusal interpretation.

4. **[P2] The positive-refusal test does not cover the real refused-admission lifecycle** (`symphonyWork.logic.ts:613–645`; test lines 350–373; server `SymphonyOrchestratorLive.ts:1642–1662`).

   The only refusal projected as Not started is one whose durable lifecycle was already `draft`/`ineligible`. The server refuses those before reaching concurrency checks, so the new `draft + concurrency_cap` test is not the real path. A real explicit retry from failed/cancelled first transitions the item to queued, then can be refused by pause/cap/workflow checks. The new projection unconditionally calls that queued item In progress and the test explicitly locks in this result. This contradicts plan 16.16's accepted requirement, “A refused admission leaves its story Not started with a reason”. It also means the pending UI has no refusal explanation for retryable queued refusals: row notes only read lifecycle detail when Not started, and the enabled action reason says it can start now.

   Fix: model the positively refused command/admission separately from an already accepted queued admission, and use that fact for Not started plus the reason without overwriting known active/unresolved ownership. If the coordinator decides existing server queued semantics make the requirement impossible, resolve that contract mismatch explicitly; do not close it with the unreachable fixture. Use the real failed → queued → refused path as the regression.

## Should fix

5. **[P2] The exact-run hook promotes a historical run to current** (`state/symphonyWork.ts:271–283`).

   `getRun(oldRunId)` reads that exact attempt and the current durable work item. It does not report the latest attempt ID (`SymphonyOrchestratorLive.ts:1318–1357`). The adapter nevertheless sets `currentRunAttemptId` to the opened attempt. Once an item has attempts 1 and 2, opening attempt 1 reports it as `isCurrent` and `attempts.currentState: known`, with its provider/model as the current attempt. The collection adapter instead uses the authoritative board latest ID. This creates competing semantics at the proposed list/detail boundary.

   Fix: leave current identity unknown without a board/latest-attempt observation, and represent the viewed attempt as history or explicitly viewed scope. The hook currently has no production or pending Work UI caller, so deleting this premature adapter is also a valid smaller fix until it is needed. No new query framework is required.

6. **[P3] Group run and attention inputs once for the collection** (`symphonyWork.logic.ts:1002–1049`, `projectAttention`, collection card map).

   Every card scans the entire project run list and scans all attention twice. At the actual documented caps, 5,000 cards × (1,000 runs + two passes over up to 2,000 attention entries) is about 25 million input visits whenever the two-second board snapshot changes. The payload is already bounded, so a per-work-item map built once in the collection is a simpler bounded improvement; pass only each item's facts into the same pure item projector. This is source complexity evidence, not a measured runtime slowdown, and does not justify a benchmark campaign.

## Contract and caller trace

- Read README, AGENTS, state-and-evidence architecture, plan 16.15–16.17 and linked scope/acceptance passages. Did not use another reviewer's findings.
- Traced `subscribeProjectBoard` → `getProjectBoard` → `listForBoard`/latest IDs → `projectBoardFromWorkItems`. Board truncation is a real server fact. Its existing column mapping is not a substitute for the new owner-approved Work filter semantics.
- Traced project `listRuns`: newest 1,000 attempts before filtering; per-item failures can become null and attempt reads can become `[]`. Traced `listAttention`: capped pending/open collections; failures become `[]`; project filtering performs further item reads. The lane is right to keep those coverage states unknown, and its older observed attempts/requests are retained rather than replaced by the latest attempt.
- Traced `getRun`: exact attempt plus current item; pending approval-derived attention only, not an authoritative latest/current-attempt or complete item-attention read.
- Existing production project actions still use `boardCard.logic.ts`; run detail still uses `ACTIVE_RUN_STATUSES` and raw request modes. The lane adds the shared projection but does not itself migrate these callers. The path names `SymphonyOverviewView.logic.ts`/`SymphonyRunningView.logic.ts` in its allowlist do not exist in this production checkout.
- Source-inspected pending Work UI at `/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code`. Its imports and property use match the new collection API by inspection; no compiler proof was produced. It consumes the collection hook, not the exact-run hook. Its drawer continues to label raw card lifecycle and use raw request modes, so the list/detail single-semantics acceptance needs integration review. It also discards count-state metadata and does not display `attentionOutsideBoard`; these are presentation-owner integration observations, not new source edits requested from the projection owner.

Not checked: no tests, builds, installs, browser execution, live provider/tracker work or fault injection were run, as instructed. Existing test files were read, not executed. No `vp check`/typecheck result is asserted by this review. This report is source evidence against the pinned commit, not runtime or visual acceptance.
