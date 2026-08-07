# Handoff

Updated: 2026-08-07 18:20 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `acd4d07eb` refactor(web): remove Mission Control; relocate shared dashboard selectors
- Tracked tree: CLEAN. Only standing user files untracked (PDF, PLAN-exec-demo.md, demo.md,
  \_\_probe/, scratch-neokod-symphony-layer-probe.ts).

## CRITICAL — git remote is misconfigured (fix first next session)

- `origin` points at **kamo62/t3code** (a leftover from the unfinished fork/rename). EVERY push
  this session went there. origin/t3code is current at `acd4d07eb`.
- `neokod` remote = **kamo62/neokod** (the canonical repo) is ~60 commits BEHIND at `8833ed5f2` —
  none of this session's work is on it.
- The `git push neokod feat/symphony-mode-impl` is BLOCKED by the Claude Code permission
  classifier (pushing to a non-tracked remote is gated). Kamogelo must either run it himself
  (`! git push neokod feat/symphony-mode-impl`) or add a Bash permission rule.
- Sequence to fix: (1) push branch to neokod, (2) `git remote set-url origin <neokod url>` +
  `git branch --set-upstream-to=neokod/feat/symphony-mode-impl`, (3) verify neokod at
  `acd4d07eb`, (4) ONLY THEN delete kamo62/t3code (Kamogelo wants it gone; hold until neokod is
  confirmed — it is currently the only remote with the work).
- Stray issue already cleaned: closed kamo62/t3code#1 and removed its `symphony` label. The live
  smoke will seed a fresh issue on kamo62/neokod.

## This session's commits (all pushed to origin/t3code, verified)

- `26b8f41d3` create-workflow affordance (symphony.createWorkflow RPC, path-validated, atomic
  create, settings dialog with starter template). Boot-probe clean, 12 new server tests.
- `0234f7c6a` Claude model version shown in the picker (Sonnet claude-sonnet-5) + Neokod splash
  and favicons replacing the old blueprint/T3 art from assets/prod.
- `acd4d07eb` Mission Control removed entirely (overlay, store, palette entry, composer action,
  root mount, tests); shared dashboard selectors relocated to threadDashboard.logic.ts so Home +
  My Work keep working. Zero mission-control refs remain in apps/web/src.
- Batch verified independently: web 163 files / 1501 tests green, live boot probe clean
  (reaper.started, no Service-not-found), vp check 0 errors.
- Also this session: reverted crash-corrupted apps/server/src/provider/Layers/ClaudeProvider.ts
  (a CMUX crash left a half-deleted parseClaudeSupportedModels; the model-version feature it was
  attempting is done cleanly in the web layer instead).

## NEXT SESSION LEAD TASK — remove all "T3Code" references (except LICENSE)

Kamogelo wants every T3Code reference gone from the codebase except the license. This is a
53-file refactor and is NOT a blind find-replace — several `t3code` refs are LOAD-BEARING
backward-compat that a sweep would break:

- **localStorage migration**: `LocalStorage.ts` reads legacy `t3code.` keys and rewrites to
  `neokod.` (`key.replace(/^neokod\./, "t3code...")`). Preserve the migration path; do not delete.
- **`t3code://` URL scheme** (~13 refs): OS-registered deep-link scheme. `neokod://app` is only
  partially migrated. Renaming needs coordinated desktop scheme registration + migration, not a
  string swap.
- **`T3CODE_` env vars** (~87 refs): mixed — some are intentional compat fallbacks, some dead
  leftovers. Triage individually. (Note: the T3CODE*POSTHOG*\* fallbacks were already removed
  earlier because they pointed at upstream's analytics.)
- Safe/cosmetic refs (comments, display strings, docs, non-compat) can be renamed freely.
  Do it as a careful lane with `vp check` + web/server typecheck + a LIVE BOOT PROBE after each
  group. Grep target: `grep -rIi "t3code\|t3tools" apps packages scripts docs` (exclude LICENSE,
  node_modules).

## Other open UI/product items

- Rename mode "Work" → "Code" in the switcher + the "Back to Work" row → "Back to Code", with
  subtitles: Code = "Working directly with your code", Symphony = "Agent-led development".
  Lives in Sidebar.tsx (SidebarBrand OPERATING_MODES + SymphonySidebarNav back row). Small; was
  deferred only because lanes were editing Sidebar.tsx concurrently — tree is clean now.
- Per-role agents in WORKFLOW.md (BIG, Kamogelo wants it): today only ONE impl agent via
  `agent.model`. No reviewer-agent config, no multi-agent review fan-out; `modelReview` evidence
  slot exists but is always null. Proposed schema: a `review.agents: [gpt-5.6-sol, claude-fable-5]`
  block + `review.require: all-approve|any-approve|advisory`, orchestrator runs reviewers after
  implementation and writes modelReview, merge gate consults verdicts. New lane: schema +
  orchestrator + evidence wiring + UI.
- Live Symphony smoke: everything it needs now exists (WORKFLOW.md load/activate, create-workflow
  UI, tracker adapters). Needs a seeded issue on kamo62/neokod with the `symphony` label + a
  WORKFLOW.md pointing at it. User-gated on repo access.
- PRD section 21 amendment for default-on analytics (Kamogelo).

## Reference apps (running for design comparison)

- local-studio: `cd <scratch>/local-studio/frontend && npx next dev -p 3199` (deps installed
  across frontend/controller/shared/services with --legacy-peer-deps).
- diri: built from source via cargo; runs natively. Screen capture blocked pending Screen
  Recording permission for the terminal.

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git checkout feat/symphony-mode-impl
pnpm install
# FIRST: fix the remote (see CRITICAL section) so work lands on kamo62/neokod
PATH="$PWD/node_modules/.bin:$PATH" NEOKOD_NO_BROWSER=true node scripts/dev-runner.ts dev
# browser: use the ?loopbackAuthToken=... from the dev log; server listens on 13773, web on 5733
```

Machine-specific: codex-companion.mjs patched for max/ultra efforts (re-patch after plugin
updates). CMUX has crashed repeatedly this session — commit early and often; verify tree
integrity (typecheck + boot probe) after any crash before trusting uncommitted work.

## Blockers

- `git push neokod` blocked by permission classifier — needs user or a Bash permission rule.
- Effect 4.0.0-beta.78 layer-construction trap: services yielded at construction must be provided
  in the SymphonyLayer.ts sub-graphs or the real server dies at boot while suites stay green.
  ALWAYS live-boot-probe after any layer change.
- Root `vp run typecheck` has pre-existing debt outside touched files (Orchestrator/**,
  Persistence/**, Trackers/\*\*, bin.test.ts); judge only touched-file diagnostics.
