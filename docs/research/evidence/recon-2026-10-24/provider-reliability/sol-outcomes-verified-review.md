# Verified outcome source review

Verdict: FIX

Frozen HEAD: `9874ed3953f84922307eb55915a7d28267a79ff2`, branch `feat/neokod-turn-outcomes`. Working tree clean when inspected. Compared the correction with `3b467710945af04549fcf477d4b5fc6c9573d675` and read the requested reconciliation answer and Opus review. No source edits, tests or runtime actions performed. The reported 197 passing tests/check/typecheck remain implementer evidence.

## Verified corrections

- Late same-turn streaming and final messages retain terminal outcome/time while the session no longer runs the turn. The client still allows output to resume a provisional Stop while the session runs that identity.
- A late running update for the currently latest, confirmed terminal identity leaves its session ready and does not reopen the turn. SQL, pure and client now call the shared session guard with turn evidence. The extended tests assert session status and following messages rather than only latest-turn state.
- Old checkpoints retain newer latest-turn identity both while the newer turn runs and after it settles. SQL, pure and client use the shared pointer rule, while historical checkpoint metadata continues to update.
- Provisional Stop is distinguished using the existing running session identity. Explicit completed/interrupted outcomes are evaluated against a running identity, use the first authoritative time, and failed Stop can resume. The three new client regressions cover those exact cases.
- Outcome corrections and repeated terminal outcomes retain the first settled timestamp, including null, in all three projections. SQL passes that same time to the first-write-wins settlement repository. The updated regression checks turn/outbox equality and reprojects on bootstrap. This closes the earlier timestamp disagreement without inventing durable provenance.

## Remaining fix: apply rejected running updates consistently to all SQL projections

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1071-1081` rejects a late running update for an already terminal identity, but only skips `applyThreadSessionsProjection`. The independently run thread and turn projectors still apply the rejected event:

1. Turn A is confirmed interrupted; new turn B is running and is the latest active identity.
2. A delayed legacy `thread.session-set` arrives with `status: running`, `activeTurnId: A`, no explicit outcome.
3. SQL finds historical terminal A and the session guard correctly rejects the update, leaving session B running.
4. `applyThreadTurnsProjection` nevertheless enters the running branch and marks every other running row completed (`:1218-1244`), including B, recording a false B settlement.
5. `applyThreadsProjection` unconditionally changes the latest pointer to A (`:792-803`). The result is a running B session with B durably completed and A selected as latest.

Each projector runs for the event (`:1860-1863`); returning from the session projector does not skip the others. This is the remaining part of the same late-running identity invariant, not an unknown-provenance request. SQL already has sufficient terminal evidence to reject A. The implementer's disclosed historical-evidence limitation in pure/client does not explain these SQL mutations after SQL itself rejected the event.

Required bounded correction: apply the running-event admissibility result consistently before any latest-pointer, supersession, turn upsert, pending-start consumption or settlement side effect. Preserve independent per-projector bootstrap behaviour, rather than relying solely on another projector's live execution order. Keep legitimate unseen new turn IDs admissible. Extend the existing A/B SQL regression with this delayed running-A event and assert B's state, session, latest pointer, pending start and absence of a false B settlement. No new storage is required.

## Accepted limits

- Known-only optional outcome and legacy omission remain the approved contract; durable unknown outcome and durable authority provenance are deferred.
- Immutable first-settlement time is now the policy. A later outcome correction changes the state but does not move/retract the recorded settlement time or already published notification.
- Non-completed conflicting terminal states retain the existing precedence policy; this is not a new universal first-provider-result history.
- Pure/client historical identity evidence after latest advances remains limited as disclosed. This review does not claim that historical late-running case is fixed there.
- Source review and implementer checks do not establish live provider, browser, installed desktop or restart acceptance.
