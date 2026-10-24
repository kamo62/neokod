# Outcome source review

Verdict: FIX

Frozen HEAD: `3b467710945af04549fcf477d4b5fc6c9573d675` (`feat/neokod-turn-outcomes`), compared with `1eee19299`. Working tree was clean. Read-only source review; no tests or runtime actions performed. The reported 194 tests, check and typecheck are implementer evidence, not rerun evidence from this review.

The optional known-only contract, explicit target requirement in the decider, exhaustive typed runtime mapping, shared policy module, and direct ready-plus-interrupted projection are consistent with the root correction. Explicit null outcome is rejected, while nullable completion timestamps retain their existing meaning. Delayed explicit old-target outcomes correctly preserve a newer active session in the tested ready/null-active shape and only settle their historical SQL row. Three late-event gaps remain.

## 1. Late messages can reopen a confirmed terminal client turn

`packages/client-runtime/src/state/threadReducer.ts:248-254` chooses `running` whenever `settlesTurn` is false, even when `existingSettled` is true. Start from the new regression's authoritative `interrupted` turn with session `ready`, then append a same-turn assistant message with `streaming: true`: the client changes latestTurn to running. SQL preserves the existing terminal state, and the server pure projector only updates message data, so the projections disagree. The new regression covers a late non-streaming final message, not this case.

Required correction: preserve confirmed terminal outcome/time on late same-turn streaming messages as well as final messages, while retaining the explicitly allowed provisional Stop/resumed-stream behaviour. Add a focused extension to the existing sequence regression. This is not the deferred case where Stop intent is followed by actual successful completion; this sequence starts with an explicit provider outcome.

## 2. Late running updates still reopen the session and visible lifecycle

`packages/shared/src/orchestrationTurnOutcome.ts:114-115` accepts every session update without an explicit outcome. Therefore the new late-running regressions preserve only latestTurn: all three adapters still assign session `running`, activeTurnId to the already terminal turn. See client reducer `:300-310,370`, server pure projector `:452-460,482`, and SQL session upsert in `ProjectionPipeline.ts:1054-1076`. `apps/web/src/components/threadLifecycle.logic.ts:33-39` treats session running as working regardless of terminal latestTurn. The current tests assert turn state/time but omit session readiness and lifecycle.

A subsequent same-turn non-streaming final message now also hits issue 1 because `sessionRunsTurn` is true. Required correction: a late running update for an already confirmed terminal identity must preserve ready/session identity as well as terminal turn state, consistently in all three projections. Keep actual new turn IDs admissible and do not confuse provisional Stop presentation with provider-confirmed closure. Extend existing late-running tests to assert session status/active ID and the following message result.

## 3. Late old checkpoints can replace the SQL latest-turn pointer

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:807-818` unconditionally sets `projection_threads.latest_turn_id` to a checkpoint's turn. Sequence: old turn A interrupted; new turn B running; late checkpoint for A. The explicit old-outcome guard does not protect this separate event, so a reload selects A as latest while B remains the active session. The pure projector newly protects a different running latest turn (`projector.ts:608-619`), and the client protects any different latest turn (`threadReducer.ts:457-459`), so SQL diverges. Further, once B is terminal, the pure projector's running-only guard also allows A to replace B, whereas the client still preserves B.

Required correction: late checkpoint metadata for A must not replace a newer latest turn B, whether B is running or settled. Apply the same identity policy to the SQL pointer and pure/client projections. Preserve checkpoint metadata and historical A row updates. Extend the existing old-target/late-checkpoint regression to check the actual snapshot latest ID and session, then repeat after B settles.

## Accepted boundaries and remaining limitations

- Durable unknown outcome/provenance is explicitly deferred by root. The known-only schema is honest about that boundary. No null-outcome persistence proof is claimed.
- The resolver intentionally allows completed -> interrupted/error correction, blocks conflicting non-completed terminal outcomes, and permits repeated same interrupted/error outcomes to rewrite completion time. This is an asymmetric severity/precedence policy, not strict first-terminal evidence or immutable first-authoritative timing. Duplicate same-outcome events with different times are not covered by a durable provenance model.
- `ProjectionTurnSettlements.ts:44` is first-write-wins. Correcting an inferred completion updates the turn row/time but does not update an existing settlement outbox time or retract an already published notification. The implementer states this accurately; the new count assertion proves one row, not equality with corrected authoritative time. This accepted limitation must remain explicit.
- A confirmed completed outcome after an inferred completed state returns no update from the resolver, so it preserves the inferred time. Do not claim every authoritative completion time is installed by this patch.
- The previously disclosed optimistic Stop followed by actual success without intervening evidence remains outside the bounded provenance design. Parent/child Stop policy and unconfirmed process closure remain unchanged.
- No live provider, browser, installed desktop or restart acceptance is established by this source review.

Model route: requested Sol 6.1/high; tool metadata does not expose a verifiable serving model/effort. No replacement route was launched.
