# Handoff

Updated: 2026-08-07 22:52 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `d8f4ab769` chore: enforce a legacy-branding allowlist and document retained T3Code surfaces
- Pushed: local-only at write time, 6 commits ahead of `origin/feat/symphony-mode-impl`; push
  runs immediately after this file is committed. `origin` and `neokod` both point at
  kamo62/neokod; the old kamo62/t3code repo is deleted.
- Dirty (this machine only, intentionally uncommitted): `.kiro/` (Kiro settings),
  `Neokod Symphony Mode Product Requirements.pdf` (NOW CARRIES the page-47 amendment, see #109),
  `PLAN-exec-demo.md`, `SYMPHONY_EVIDENCE.md` (stale agent evidence, claims predate final state),
  `demo.md`, `apps/server/scratch-neokod-symphony-layer-probe.ts` (intentionally stale, see
  Blockers), `apps/server/src/__probe/`.

## Done

Issues #102-#109 batch, implemented by a Kiro Crew lane (`kiro-cli acp --agent kirocrew`
running against this tree), reviewed and verified by Fable, committed in 6 commits:

- `9956b6192` formatRelativeDuration in packages/shared with tests (closes #104 on merge).
- `00dd0390f` SMOKE.md describing the Symphony live smoke (closes #103).
- `686c2aadf` Work mode renamed to Code with subtitles; internal ids unchanged (closes #106).
- `775aecc6d` WORKFLOW contract on the first agent turn (workspace/branch constraints,
  autonomy, effective approval policy + sandbox, validation commands, SYMPHONY_EVIDENCE.md
  requirement; front matter never enters the prompt; continuation turns never re-send) +
  annotated starter template with active/terminal states (closes #102, #105).
- `37a36a589` Per-role model reviewers (#108): `review.agents` + `review.require`
  (all-approve/any-approve/advisory) in WORKFLOW.md; provider-neutral generateCodeReview on all
  six providers; SymphonyModelReviewer with fail-closed aggregation (blocking finding forces
  request_changes, reviewer failure counts against all-approve); finalizer persists
  evidence.modelReview + model_review_completed event, downgrades ready_for_review to
  ready_with_warnings, never upgrades; approveMerge requires passing aggregate under the
  CURRENT requirement + exact CURRENT model set + review.headSha == PR latestCommit; PR panel
  mirrors the same gate with per-reviewer chips. Also in this commit: tracker sync can no
  longer overwrite in-flight lifecycles (upsert CASE guard), and retries re-read the issue
  from the tracker (plan 9.5, audit item 2) instead of dispatching a fabricated snapshot.
- `d8f4ab769` #107 groundwork: docs/reference/legacy-t3code-compatibility.md (every retained
  compat surface + retirement rules), scripts/check-legacy-branding.mjs + root
  `check:legacy-branding` (allowlist scanner over apps/packages/scripts/docs), composer editor
  namespace renamed to neokod, sync-reference-repos test expects the symphony repo.

#109: the PRD PDF itself now carries a page-47 amendment superseding section 21's opt-in
sentence with default-on + first-run disclosure; privacy sentence retained verbatim.
UNCOMMITTED (the PDF is a standing untracked file) and pending Kamogelo's review; backup of
the pre-amendment PDF at /tmp/neokod-symphony-prd-before-section-21-amendment.pdf (lost on
reboot — copy it somewhere durable if the amendment is rejected).

Issue hygiene: all nine issues (#101-#109) are still OPEN on kamo62/neokod. #103-#106, #102,
#108 close automatically when this branch merges (commit messages carry Closes). #107 is
partially done (guard + doc + cosmetic renames; the remaining ~T3CODE\_ env triage is now
enumerable via the checker's allowlist). #101 (Kiro epic) and #109 (issue closure itself)
remain open.

## Verified vs unverified

- Verified: server suite green — `vp test run` in apps/server: 212 files / 1994 passed,
  2 files / 7 tests skipped (22:43, pre-commit tree fingerprint ddc6e6ce0845).
- Verified: web suite green — `vp test run` in apps/web: 165 files / 1504 passed (22:46).
- Verified: live boot clean — real dev server (`dev-runner.ts dev`) logged
  provider.session.reaper.started with zero Service-not-found (22:47); this is the
  authoritative layer probe for the SymphonyModelReviewerLive wiring.
- Verified: server typecheck 0 errors in all touched files (tsgo, filtered per the known-debt
  rule); legacy-branding checker passes.
- Verified (by the Kiro lane, evidence in its report): repo-wide vp test 515 files / 4609
  passed; web production build; vp pack; production boot smoke HTTP 200; Chromium
  verdict-strip interaction 1/1 with screenshots at /tmp/neokod-model-review-rest.png and
  /tmp/neokod-model-review-expanded.png (lost on reboot).
- Unverified: the live end-to-end Symphony smoke (real tracker issue -> workspace -> agent ->
  validation -> PR on kamo62/neokod). Needs a disposable labelled issue + a WORKFLOW.md in a
  target repo; SMOKE.md defines the pass criteria. This remains the next session's opener.
- Unverified: model review against a real provider (all ModelReviewer coverage uses fakes;
  the first live run will exercise generateCodeReview for real).

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git pull
git checkout feat/symphony-mode-impl
pnpm install
PATH="$PWD/node_modules/.bin:$PATH" NEOKOD_NO_BROWSER=true node scripts/dev-runner.ts dev
# browser: use the ?loopbackAuthToken=... from the dev log; server 13773, web 5733
```

Setup required first: none beyond pnpm install (if it fails on a corrupt
@github/copilot-darwin-arm64, rm its .pnpm entry and rerun with CI=true).
Machine-specific: codex-companion.mjs patched for max/ultra efforts (re-patch after plugin
updates). A persistent Kiro Crew agent (`kiro-cli acp --agent kirocrew`, sidecar
`kiro-cli-chat`) may still be running against this tree — check `pgrep -f "kiro-cli acp"`
BEFORE editing or committing; it survives CMUX kills and writes directly to the working tree.
Background jobs still running: the kiro-cli pair (idle since ~22:25); no monitors.

## Blockers

- Live smoke is user-gated: needs a seeded disposable issue with the `symphony` label on the
  target repo and permission to push/PR from a run.
- The scratch layer probe (apps/server/scratch-neokod-symphony-layer-probe.ts) is intentionally
  stale: it does not provide ProviderInstanceRegistry/ReviewService, which the model reviewer
  now requires, so it reports Service-not-found. The REAL composed server boots clean (verified
  above). Either resync the probe's dependency graph or rely on the dev-server boot as the
  layer check.
- Root `vp run typecheck` still stops on pre-existing debt outside touched files
  (Orchestrator/**, Persistence/**, Trackers/\*_, bin.test.ts, sync-reference-repos strictness);
  `vp check` fails only on `.kiro/settings/_.json` (untracked, preserve). Judge touched files
  only.
- Effect 4.0.0-beta.78 layer trap still applies: ALWAYS live-boot after any layer change;
  suites stay green while the composed graph dies.
