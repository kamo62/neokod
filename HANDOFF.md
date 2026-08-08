# Handoff

Updated: 2026-08-08 09:55 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `21d3eab10` fix(settings): tracker toggles were silently dropped by the settings patch
  schema (the fix behind the Tracking page bug; verified live in the browser).
- **PR #110 MERGED to main 2026-08-08 07:51Z** (merge commit, history preserved). Issues
  #102-#106 and #108 auto-closed. Remaining open: #101 (Kiro epic), #107 (T3Code residue),
  #109 (PRD amendment, user), #111-#113 (subagent-panel fixes from the design review;
  #113 carries the `smoke` label as the designated live-smoke target).
- The KIRO LANE IS ACTIVE again as of ~09:50 writing provider files (ClaudeDriver,
  CodexDriver, contracts/providerInstance, .plans/README.md) — likely #101 phase 1. Its work
  is uncommitted; do not switch branches or start dev servers in this tree until it settles
  (20+ min quiet).
- Next after settle: live Symphony smoke against issue #113 (WORKFLOW.md with
  required_labels [symphony, smoke], tracker settings now functional after 21d3eab10).
- Dirty (this machine only, intentionally uncommitted): `.kiro/` (Kiro settings),
  `Neokod Symphony Mode Product Requirements.pdf` (carries the page-47 #109 amendment, pending
  Kamogelo's review; pre-amendment backup at
  /tmp/neokod-symphony-prd-before-section-21-amendment.pdf, lost on reboot),
  `PLAN-exec-demo.md`, `SYMPHONY_EVIDENCE.md` (stale), `demo.md`,
  `apps/server/scratch-neokod-symphony-layer-probe.ts` (intentionally stale, see Blockers),
  `apps/server/src/__probe/`.

## Done since the 2026-08-07 milestone

- `13dd68d7e` ACP upgraded v0.11.3 -> stable schema-v1.20.0 (Kiro-lane work, Fable-verified):
  262 schemas regenerated deterministically (SHA-256-matched repeat run); standard
  elicitation/create+complete and session/set_mode; session/set_model retained as explicit
  Grok/Cursor compat extension; model discovery via the typed `model` session config option.
  Groundwork for #101.
- `e36e5d438` SDK updates taken ahead of cooldown with Kamogelo's explicit approval:
  claude-agent-sdk 0.3.226, copilot-sdk 1.0.9 (+ @github/copilot 1.0.78), opencode 1.18.15.
  Version-pinned exemptions in minimumReleaseAgeExclude (plus a name-pattern for the
  claude-agent-sdk-\* platform binaries — pnpm rejects pattern+version combined; REMOVE the
  whole block once 0.3.226 clears cooldown ~2026-08-12). fetchTimeout 600000 /
  networkConcurrency 4 added: SDK platform tarballs exceed the 60s default on slow links.
- Yesterday's milestone (7 commits, `9956b6192`..`a11f328ff`): issues #102-#106 + #108 + #107
  groundwork; see PR #110's description for the full inventory.
- Kiro research (in `.kiro` crew workspace, cycle_004): recommendation is Kiro as a third ACP
  provider (Cursor/Grok recipe) with Crew held out of managed sessions until stop semantics,
  workspace containment, and permission routing exist. Fable gap review delivered in-session.
- Codebase audit research artifact ("neokod-codebase-audit-performance-and-competitor-research"):
  doc cleanup + benchmark-harness-first modernization plan. Fable assessment: sound method;
  its HANDOFF/PLAN/REVIEW-UI archive recommendations conflict with the working-file workflow
  and should be rejected; ci.md fix and benchmark harness are the actionable subset and good
  smoke seeds.

## Verified vs unverified

- Verified: effect-acp 30/30; ACP+Grok/Cursor providers 88 passed / 6 skipped; full provider +
  textGeneration suites on the NEW SDKs 718 passed / 6 skipped (09:22); live dev boot clean
  (reaper.started, no Service-not-found) after both the ACP migration and the SDK bump;
  server typecheck 0 errors in touched areas; legacy-branding checker passes.
- Verified (Kiro lane, its own report): repo-wide 515 files / 4609 tests; server bundle +
  serve smoke HTTP 200; desktop build + desktop smoke; release:smoke (under Node 26.5.0,
  outside the supported ^24.13.1 — engine-exact rerun still environment-gated).
- Unverified: live end-to-end Symphony smoke (needs a disposable `symphony`-labelled issue and
  push/PR permission; SMOKE.md defines pass criteria); generateCodeReview against a real
  provider; Copilot/OpenCode/Claude SDK behavior under real provider sessions (suites and boot
  are green; no live turn was run on the new SDKs yet).

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git pull
git checkout feat/symphony-mode-impl
pnpm install
PATH="$PWD/node_modules/.bin:$PATH" NEOKOD_NO_BROWSER=true node scripts/dev-runner.ts dev
# browser: use the ?loopbackAuthToken=... from the dev log; server 13773, web 5733
```

Setup required first: none beyond pnpm install.
Machine-specific: codex-companion.mjs patched for max/ultra efforts (re-patch after plugin
updates). A persistent Kiro Crew agent (`kiro-cli acp --agent kirocrew` + `kiro-cli-chat`)
runs against this tree and survives CMUX kills — check `pgrep -f "kiro-cli acp"` and recent
mtimes BEFORE editing or committing; 20+ minutes of quiet tree is the settle signal.
Background jobs still running: the kiro-cli pair (idle since ~08:31).

## Blockers

- Live smoke is user-gated (disposable issue + push/PR permission). Suggested seeds: the
  audit's docs/operations/ci.md correction, session-expired surface, tracker checkpoint
  cursor persistence — small, real, and CodeRabbit will review the resulting small PRs.
- Merge decision on PR #110 is Kamogelo's; merging first keeps the smoke agent's base
  (main) carrying the WORKFLOW contract and reviewer pipeline it exercises.
- The scratch layer probe is intentionally stale (no ProviderInstanceRegistry/ReviewService);
  the real dev-server boot is the authoritative layer check.
- Root `vp run typecheck` has pre-existing debt outside touched files; `vp check` fails only
  on `.kiro/settings/*.json` (untracked, preserve). Judge touched files only.
- Effect 4.0.0-beta.78 layer trap: ALWAYS live-boot after any layer change.
