I'll read the handoff material before acknowledging.Received. I read `plan.md` 16.4 to 16.7 and revision 4 of `docs/research/feature-verdicts-2026-10-04.md`. I have not edited files, run checks, committed, published, deployed or started any slice.

## Order I have been given

1. **Core Phase 1D first**: U-04, S-01, S-02, U-06, U-07, U-11, X-9, X-10, X-11, on their existing cards. Verified-hold cards need evidence, not invented edits.
2. **Then Phase 1E**: X-3, X-4, X-5, X-6, 2.2, 2.3, X-7, X-14, preserving card order where callers overlap.
3. **Only after the core exit gate**: W6-C1, then C2, then C3, strictly ordered. C5 UI logic may run in parallel after C1 in disjoint `apps/web` files; `ws.ts` registration waits for X-2 and U-02b to be committed. C4 to C6 follow.
4. Symphony stages, bounded review and lineage per 16.7 (B-1 to B-10, H-0 to H-6b, D-1 to D-6). Mobile, saved machines and fleet telemetry stay behind the core, thread and Symphony gates, with token-gated owner-direct connections and a pinned target.

Ordinary-chat delegation is agent-initiated through a scoped MCP catalogue (`child_capabilities`, `child_start`, `child_status`, `child_stop`, later `child_answer`). No Delegate button or mode switch.

## Key acceptance gates

- **Core**: section 14.2 plus focused regressions and root `vp check`, `vp lint`, `vp run typecheck` on Node 24. The 32-card history and the six-card batch do not count as completion of all 55 cards.
- **Outstanding on the six-card batch**: U-02b's independent re-review is still a delivery gate and must not be reported as passed; panel close/reopen during an in-flight save sits outside the remount fix; U-03 has no live Git-driver or UI proof; no batch commit exists.
- **W6**: C1 is a foundation commit and does not count as the feature. The feature may only be claimed after C3 closure, stop and restart tests pass, and one live OpenCode run is observed with a durable result. Queue behind the parent turn, never steer. Depth 1, caps 3 per parent and 6 per environment, isolated worktree from the parent HEAD, `launch_unknown`/`orphaned` retained rather than erased, restart reconcile never auto-launches, results pinned and UTF-8 capped at 16,000 bytes, held delivery with an explicit Deliver results after a stopped or interrupted parent.
- **Symphony**: evidence carries exact head SHA and clean-tree flag; unknown CI is not clear; superseded results are marked; at most two repair rounds then escalation; stage nodes are not agents; only authoritative managed-child IDs feed lineage; full proof uses a disposable repository and one live provider/tracker fixture.
- **Release**: scoped independent review, required root gates, runtime and visual evidence, card-boundary commits, and canonical changelog/version policy before any authorised PR.

## One contradiction worth flagging

Inside 16.6, the tool contract says "C2 must include working `child_stop` before exposing `child_start`", but the slice table lists `child_stop` in **W6-C4** and C2's acceptance already covers stop before and after launch plus delete-with-unconfirmed-stop. Read literally, C2 cannot expose `child_start` without part of C4. I will treat the design paragraph and C2 acceptance as authoritative (minimum safe stop in C2, enriched stop in C4) and confirm that reading before C2 work begins.

Minor documentation defect, not an ordering issue: `docs/research/feature-verdicts-2026-10-04.md` line 3 says revision 4 is the latest follow-up while line 5 still reads "Current revision: 2".

No execution has started. I will wait for the instruction that opens the first slice.

Main integration note: the stale revision metadata and C4 stop wording identified in this acknowledgement were corrected. The subsequent owner instruction enables parallel core lanes and dev review without builds; plan 16.8 supersedes earlier build/publication sequencing.
