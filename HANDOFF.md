# Handoff

Updated: 2026-08-06 23:20 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `78c70e301` feat(analytics): add settings.analytics route file missed from the feature commit
- Pushed: yes, up to date with origin
- Dirty: only the standing user files (`Neokod Symphony Mode Product Requirements.pdf`,
  `PLAN-exec-demo.md`, `demo.md`, `apps/server/src/__probe/`). Never stage these.

## Done

Three workstreams landed today, two writers (this session + a parallel OpenCode session run by
Kamogelo — coordinate via REVIEW.md, not by guessing). The 22:45 handoff's note about a
`mod+shift+t` keybindings collision is resolved; the full web suite is green post-merge of both
lanes.

**Symphony review fixes (OpenCode lane).** Two review passes (Opus + sol high, both in REVIEW.md)
found 8 P0 / 16+ P1. A 14-item fix checklist landed in `38df58a20`, `8168d7582`, `6639737c8`; a
Fable status review of those fixes (REVIEW.md, "Fix-lane status review") sent three items back
(pr-bodies dir never created, ownership repo not exposed to the server runtime, reviewThreads
query with empty owner/name) plus residuals; `764d7c43b` claims to close all send-backs and
residuals (terminal-guarded updateStatus, legality table, cancel race).

**Upstream reconciliation (both lanes).** Two independent judges (Fable + sol, RECONCILE.md) ruled
on upstream overlap; final adjudication in the same file. All four consensus Area B ports landed:
`e05bbc9ac` (376c149ea), `0a0eca202` (9a0a07167), `62d2a27d9` (2d31cb022 server), `6f1c978ab`
(0ad91b6e7). Area A port `501ce27b8` (stale active turn on live session.state.changed) NOT yet
done. KiroCrew pattern notes (finalization checkpoints, headless deny-by-default, failure lessons)
are at the end of RECONCILE.md.

**Analytics + UI Phase 1 (this session).** `f77184008` + `78c70e301`: PostHog opt-out gating every
capture path, BYO key/host (evidence-card wins), fail-closed on unreadable/invalid settings,
first-run disclosure (product decisions 2026-08-06: default-on + notice; PRD section 21 amendment
still pending on Kamogelo). Fable-reviewed (2 P1 / 5 P2, all resolved or signed off).
`b96d688b9`: UI Phase 1 items 1-9 per REVIEW-UI.md final plan. `dee3ee587`: stale uiStateStore
test expectations (operatingMode/viewSnapshotsByMode from earlier symphony commits).
`0424a4510`: REVIEW-UI.md + RECONCILE.md committed.

## Verified vs unverified

- Verified: analytics scoped server tests 82/82, contracts settings 25/25 —
  `cd apps/server && ../../node_modules/.bin/vp test run src/telemetry/AnalyticsService.test.ts
src/provider/copilot/PostHogSink.test.ts src/provider/copilot/ManagedClientEvidenceTestConnection.test.ts
src/provider/copilot/ManagedClientEvidenceForwarder.test.ts src/serverSettings.test.ts`.
- Verified: full web suite 160 files / 1474 tests green (includes keybindings.test.ts); web +
  shared typecheck clean; `vp check` 0 errors / 27 pre-existing warnings.
- Unverified: UI Phase 1 visually. Typecheck and tests only prove it compiles. Needs the running
  app and human eyes (chat prose 16px, header overflow menu, neutral fills, static Ultrathink,
  shadows, undo-archive toast, mod+shift+t).
- Unverified: `764d7c43b` actually closes the three send-backs. The Fable status review predates
  it. Re-verify item 1 (pr-bodies dir created + write failure fails create), item 2 (ownership
  repo resolvable from server runtime, lease actually recorded), item 11 (reviewThreads query
  carries real owner/name) before calling the checklist done.
- Unverified: full server suite after today's symphony commits (only affected files were run).
  ~4 min: `cd apps/server && ../../node_modules/.bin/vp test run`.
- Unverified: first-run notice persistence in a real browser profile (flag logic unit-tested only).
- Unverified: live smoke procedure (real Codex app-server, real repo/PR/CI) — see the procedure in
  git history of this file (`git show 74998e41b:HANDOFF.md`).

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git pull
git checkout feat/symphony-mode-impl
pnpm install
cd apps/server && ../../node_modules/.bin/vp test run   # full-suite check first
```

Setup required first: none beyond `pnpm install` (corrupt `@github/copilot-darwin-arm64` fix:
remove from `.pnpm`, re-run `CI=true pnpm install`).

Machine-specific: the Codex plugin script
`~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs` is patched locally
on MacBookPro (VALID_REASONING_EFFORTS now includes "max"/"ultra", ~line 71). The codex binary
supports them; the plugin allowlist is stale. Re-patch after any plugin update, and patch other
machines before running luna at max. Kamogelo runs a parallel OpenCode session in this repo —
check for its processes before assuming exclusive tree access.

Background jobs still running: none.

## Blockers

- Effect 4.0.0-beta.78 drift (carried): `Effect.result` not `Effect.either`; `it.effect` or tests
  silently skip; `exactOptionalPropertyTypes` needs `| undefined`; TestClock at epoch.
- Codex sandbox cannot bind 0.0.0.0: one serverSettings HTTP-fixture test fails inside Codex jobs
  only; it passes in a real shell. Do not chase it.
- Root `vp run typecheck` blocked by pre-existing `scripts/sync-reference-repos*` errors,
  unrelated to today's work.

## Next moves

1. Visual sign-off of UI Phase 1 in the running app; iterate, then decide Phase 2.
2. Re-verify the three send-backs in `764d7c43b` (see Unverified).
3. Full server suite re-run before any merge.
4. Port 501ce27b8 (the one remaining consensus reconciliation item).
5. Live smoke procedure once send-backs re-verify clean.
6. Kamogelo: PRD section 21 amendment for default-on analytics.
