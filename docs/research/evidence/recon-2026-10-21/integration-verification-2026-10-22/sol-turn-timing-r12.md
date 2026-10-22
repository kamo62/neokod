# Sol review: turn-timing-r12 (work/turn-timing-evidence @ ed5f7fa0d)

## Verdict: ACCEPT

## Findings

No actionable P0–P2 defects found in the full diff `2745226f2..work/turn-timing-evidence`. The turn-timing follow-up is complete at source level.

## Card acceptance

Assessed against the timing follow-up to cards 2.3/X-7 and the existing plan’s recovery requirements, not as a fresh acceptance of unrelated work already integrated into dev.

| Acceptance criterion                                                                                            | Status | Evidence                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settlement completion is server-owned; interrupt and stop requests do not supply settlement evidence.           | met    | `ProjectionPipeline.ts:1393–1398` leaves interrupt requests unsettled. `threadReducer.ts:345–370` stores the server settlement and leaves stop requests unchanged. Focused regressions pass.               |
| Each settled turn retains its own completion, including explicit unknown, after another turn starts.            | met    | Snapshot queries expose terminal turn rows; the client stores `thread.turn-settled` values verbatim. Reducer, synchronisation and timeline tests cover known and null completions across subsequent turns. |
| Missing completion remains unknown rather than falling back to messages, activities or synthetic closure times. | met    | `MessagesTimeline.logic.ts:393–404` uses only the supplied settlement record. `ChatView.tsx:1432–1442` no longer substitutes latest-turn timing. Missing-evidence regressions pass.                        |

| Terminal elapsed time freezes; late checkpoints cannot
rewrite settled completion. | met | `ProjectionPipeline.ts:1422–1455` and `threadReducer.ts:418–435` preserve existing terminal timing. Timeline and run-summary regressions cover both known and unknown completion. |
| Settlement publication survives a crash between durable closure and event publication without duplicating settlement. | met | Turn projection and outbox writes share a transaction. `TurnSettlementReactor` drains unpublished rows at startup and uses deterministic command identities. Real-engine tests cover publication, startup recovery and restart deduplication. |
| Startup subscription readiness precedes settlement reconciliation. | met | `TurnSettlementReactor.ts:133–156` acquires the domain-event subscription before draining the outbox, then consumes that acquired subscription. |
| Legacy request-derived completions are cleared without borrowing another turn’s closure. | met | Migration 044 replaces matching interrupt-request timestamps with `NULL`. Migration tests cover later session closure, absent closure, supersession and unaffected legitimate completion. |
| Legacy interrupted turns with running sessions are recovered without inventing completion. | met | `ProviderSessionReconciler.ts:187–225` requires a matching binding and no live session, then repairs the session with `lastObservedAt: null`. Planner and migration/reconciler regressions pass. |
| A second crash after binding settlement preserves the host-loss warning or exact current-turn binding error. | met | `ProviderSessionReconciler.ts:200–214` reuses persisted stop-outcome helpers, gives the exact binding error precedence and keeps completion explicitly null. The round-12 regression covers these alternatives. |
| Pre-settlement client caches cannot restore inferred completion timestamps. | met | Thread cache schema version 3 rejects older entries. Storage and synchronisation tests cover rejection and authoritative snapshot replacement. |
| Contracts remain schema-only. | met | `packages/contracts/src/orchestration.ts` adds schemas and evidence documentation; runtime publication and storage logic remain outside contracts. |
| Rendered browser behaviour and real hard-crash recovery are demonstrated. | unverifiable | This review ran automated checks only. No browser, desktop app or live provider was launched. |

## Notes for integrator

- Reviewed the exact diff against `2745226f2`, which is also the current dev head and merge base. The checkout remained clean.
- The checkpoint lane’s `admittedWorkspacePath` propagation remains intact in pending-start adoption and turn upserts. Migration 043 remains registered before the new migration 044.
- Preserve the settlement reactor wiring, WebSocket detail-event classification, contract additions and cache-schema bump together. Integrating only the renderer changes would omit the authoritative live settlement path.
- Verification passed using the installed tool through `pnpm exec`:
  - `vp check`: zero errors, 42 warnings.
  - `vp run typecheck`: all ten package tasks passed.
  - Focused server, client-runtime and web tests: **186 tests passed across 11 files**.
  - `git diff --check 2745226f2 work/turn-timing-evidence`: passed.
- No files were edited. No builds, commits, publishing or deployment were performed.
