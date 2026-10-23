**Verdict: request changes.** There are two P1 and three P2 defects, all in introduced production code.

- **Reviewed:** HEAD `c1fb42238ea347bad6e4c15d5f41a896b1b3e4b9` on `feat/neokod-projection`. It was clean per your statement and the session git snapshot; I couldn't re-check status because commands were off-limits. I read the diff files in the worktree, not the `/tmp` JSON snapshot.
- **What I read:** AGENTS, `state-and-evidence.md`, plan.md §16.15–16.17, `REVIEW-FLOW-2026-10-22.md`, the contracts, and the server paths that produce the board, runs, attention, run detail, dispatch and cancel data.
- **Limits:** this is source evidence only. No live provider, runtime or browser behaviour is proven.
- **Callers:** the hooks currently have no production caller (only the tests use the logic). Every defect is latent until the Work UI lane wires in, but that lane is required to consume this API.
- **Scope:** all three files are inside the lane allowlist. No Code-child or Symphony substitution, no secrets, and no accepted-guidance or provenance claims: `observedTarget` is correctly scoped as `current_observation`.

## P1

**P1-1: a requested Stop is shown as a finished stop and Run again is offered.**

- **Trigger:** the user cancels a running attempt. `Dispatcher.ts:661-673` writes `user_cancelled` and moves the item to `cancelled` _before_ interrupting the fiber or agent (`:684-685`). Process exit is never confirmed.
- **Path:**
  - `symphonyWork.logic.ts:389` maps `user_cancelled` and `tracker_cancelled` to outcome `stopped`.
  - `:1142` sets ownership to `none_observed`.
  - `:789` makes Run again `available` with the reason "The previous attempt ended".
  - `:1185` sets `all: false`, so the item drops into History only.
- **Impact:** the UI would show Stopped and enable Run again while the old agent may still be writing the workspace. The server accepts an explicit retry of a cancelled item at once (`SymphonyOrchestratorLive.ts:1646-1656`). This breaks the confirmed-Stop and unknown-ownership requirements.
- **Fix:**
  - Treat cancel statuses as `stop_requested` (closure unknown) unless the input carries positive closure evidence. Add that as an optional input the Recovery lane can feed later.
  - Without closure evidence: ownership `unknown`, Run again `unknown` with a reason naming the missing exit confirmation, and keep the item visible in All or attention.
  - Add tests for this.

**P1-2: stale evidence is dropped, so failed reads look fresh.**

- **Trigger:** the runs query (30 s refresh) or attention query (15 s refresh) fails after an earlier success. `AsyncResult.value` returns the previous success, so `data` is set and `error` is set.
- **Path:**
  - `state/symphonyWork.ts:101` sets `stale: true`.
  - The logic ignores `stale` everywhere: `evidenceStatus` (`:402`) reports `known`, and the item and collection `evidence`, `counts` and actions don't change.
  - The hook returns only the board error (`:227`).
  - The run hook (`:269-283`) marks attention stale but never marks `workItem` or `runs` stale.
- **Impact:** answer, approve and start actions are offered for requests that may already be resolved. New attention never appears. Nothing signals the failure. The docs require keeping freshness metadata, not a fresh-looking value, and the hook's own comment ("a failed read is never flattened") is false from the second failure onward.
- **Fix:**
  - Carry staleness into the output: a `stale` evidence status, or a freshness field with a reason on item and collection evidence.
  - Downgrade actions that depend on a stale source to `unknown`.
  - Expose per-source errors from both hooks and mark every stale source in the run hook.
  - Add tests.

## P2

**P2-1: Start fails open when runs or attention evidence is missing.**

- **Trigger:** `runs` or `attention` is `unavailable` or `unknown`, for example on a first-load error.
- **Path:** `startAction` (`:718`) only blocks on positive `needs_attention` (`:748`) or a positive active or older outstanding attempt.
- **Impact:** Start or Run again shows `available` when the evidence its own blocking rules depend on was never read.
- **Fix:** when either source isn't `known`, return `unknown` and name the missing source. Known data whose completeness is unreported can still pass, since production never reports run completeness; say so in the reason.

**P2-2: the run-detail hook marks the viewed attempt as the item's current attempt.**

- **Trigger:** opening run detail for an older attempt when a newer one exists.
- **Path:** `state/symphonyWork.ts:278` sets `currentRunAttemptId: details.runAttempt.id`. That produces `isCurrent`, `currentState: "known"` and `observedTarget.source: "current_attempt"`.
- **Impact:** it labels a historical attempt as current, against REVIEW-FLOW acceptance 7. It also contradicts the hook's own doc comment.
- **Fix:** pass the viewed attempt as a separate "focus" identity and leave current unknown unless an authoritative latest-attempt ID (such as the board's `latestRunAttemptId`) is loaded.

**P2-3: an unconfirmed dispatch and tracking loss are hidden by the filters.**

- **Trigger:**
  - A pending dispatch with unknown acknowledgement on a failed or cancelled item (Run again sent, acknowledgement lost).
  - Or a terminal item whose attempt is still active (`active_attempt_after_terminal_lifecycle`).
- **Path:** membership (`:1184-1190`) uses lifecycle and attention items only. The pending dispatch and the contradictions never feed into membership or the attention counts.
- **Impact:** the item sits only in History, with no attention badge. REVIEW-FLOW §18-19 requires unresolved acknowledgement to count as In progress and needing attention, and tracking loss to appear in attention.
- **Fix:** when a pending dispatch or an ownership-type contradiction exists, set `inProgress` or `needsAttention` (or a counted reconciliation flag) and keep the item in All. Add tests.

## P3 (non-blocking)

- An open informational attention item blocks Start but produces no action. For example, the "PR creation failed" item (`ExecutionFinalizer.ts:292`) offers re-dispatch, take-over and abandon, so the item can reach a dead end once its lifecycle allows a re-run.
- Board cards don't include `excluded`, so an excluded queued item shows Start `available` with "server can start this admitted item now". The server then refuses.
- The bounded-board message mentions only finished items, but `truncated` also fires when the active cap is hit. The column `totalCount` is ignored.
- The run-attempt-to-attention map and `projectRunAttemptIds` don't apply the project-mismatch filter.
- `getRun` returning `null` (not found, or a read failure the server hides) gives `work: null` with no reason. That's an existing server conflation, but the hook passes it through without saying so.

Any code change to fix these needs a fresh recheck at the new SHA.
