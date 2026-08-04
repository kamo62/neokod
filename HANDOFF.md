# Handoff

Updated: 2026-08-04 21:45 on MacBookPro

This file was 1730 lines of dated session journals. That history is preserved in git at `5b19398a3`
and earlier. It is now a current-state resume document, regenerated rather than appended to.

## State
- Branch: `feat/symphony-mode-impl`
- HEAD: `cc72fc4f9` fix(contracts): port ForwardCompatibleArray helper and remaining call sites
- Pushed: **local-only, no upstream tracking branch.** Nothing on this branch exists off this machine.
- Dirty: the Symphony implementation is **uncommitted** — `apps/server/src/symphony/`,
  `apps/web/src/routes/symphony*.tsx`, `apps/web/src/components/symphony/`,
  `packages/contracts/src/symphony.ts`, the four `03[5-8]_Symphony*` migrations, and the transport
  security work (`LocalTransportAuth.ts`, `WslBearerAuth.ts`, `cli/config.ts`, `server.ts`, `ws.ts`).
  **None of it travels until committed.**

## Done

- `8e49a9017` **Telemetry no longer reports to upstream.** The PostHog key defaulted to
  `phc_XOWci4oZ…`, byte-identical to `upstream/main`'s. Now points at Neokod's own EU project, all
  `T3CODE_*` fallbacks removed, and `NEOKOD_TELEMETRY_ENABLED` defaults to `false` per PRD 21.
  Same commit adds a 4-day supply-chain cooldown (`pnpm-workspace.yaml` minutes, `bunfig.toml`
  seconds — the units differ).
- `1e70b9c62` upstream **#3978** duty-cycled status animations + noise overlay off the fixed layer.
- `879842845` upstream **#5319** strip replayable terminal queries from history.
- `d5030c84e` upstream **#5073** Cursor todo title fallback.
- `ae263a231` upstream **#5326** tooltip z-index.
- `f6c4a4934` upstream **#5327** forward-compatible `ServerProviders` decoding.
- `cc72fc4f9` ported the `ForwardCompatibleArray` helper #5327 depends on (it had never been
  ported, so contracts threw `ReferenceError` at runtime) and applied it at the three remaining
  upstream sites: `ServerConfigIssues`, `availableEditors`, `ResolvedKeybindingsConfig`.
- Earlier: plan revisions 1 and 2 (`7c19cdf42`, `a3ddac870`), PR panel spec (`f4ef86515`),
  open decision 13 resolved (`f8dce36ee`), `.repos/symphony` vendored (`a84cd5d84`).

## Verified vs unverified

- **Verified: telemetry severed.** `grep` for the upstream key returns nothing in source; confirmed
  identical to `upstream/main:…/AnalyticsService.ts:33` via `git cat-file`. Tests 4/4 pass.
- **Verified: no live T3 endpoint** anywhere in the codebase. The ~50 remaining `T3CODE_*` names are
  local env aliases and `t3code:` localStorage prefixes with no network path.
- **Verified: web and contracts typecheck clean.** `vp run --filter @neokod/web typecheck` and
  `--filter @neokod/contracts typecheck` → 0 errors each.
- **Verified: contracts tests pass.** 14/14 across `server.test.ts` + `keybindings.test.ts`.
- **Verified: Symphony tests pass.** `vp test run src/symphony/` → 17 files, 114 tests, all green.
- **Verified: no exposure to the Aug 2026 keyv/cacheable compromise.** Lockfile and on-disk scan
  clean; zero `preinstall` hooks in any installed package.
- **Verified: nothing dispatches at Observe autonomy.** `SymphonyLayerObserve` wires only
  repositories, registry, enablement, approvals. `Workspaces/` and `Runner/` exist but are not
  imported by the layer and are unreachable from the orchestrator.
- **Unverified: `apps/server` typecheck.** It fails — 24 errors, 22 inside `src/symphony/`, all
  from this repo's Effect lint rules (`preferSchemaOverJson`, `globalDate`,
  `globalErrorInEffectFailure`). Plus 2 pre-existing outside Symphony.
- **Unverified: Symphony runtime behaviour.** Nothing executed end to end; no workflow activated,
  no issue polled against a real tracker.

## Phase 1 status: NOT complete

Assessed against plan section 18. The core read path is genuinely wired end to end
(poll → normalize → eligibility → project → persist → RPC → client atom → Queue/Overview views)
and the "nothing is dispatched" criterion holds cleanly. Four gaps remain:

1. **WS-F1..F5 — 1 of 5 adapters.** Only GitHub exists. Plan 5.0.1 deliberately widened scope to
   all five (GitHub, Jira, Linear, GitLab, Asana) because Jira is the operator's real tracker.
   Zero tracker profile docs exist under `docs/integrations/`, including for GitHub.
2. **WS-G queue overrides (FR-022) unwired.** `WorkItemRepository.writeOverrides` exists but is
   called from nowhere; the RPCs are defined in contracts but absent from `WsRpcGroup`, have no
   `ws.ts` handler, no client atom, and no UI control. Tracker checkpoints have no code at all.
3. **WS-H workflow visualisation missing.** `apps/web/src/routes/symphony.workflows.tsx` renders a
   static empty state and never calls `listWorkflows`, even though that RPC is fully wired
   server-side and the client atom exists.
4. **Typecheck gate not met.** 22 Symphony errors; plan section 18 requires green typecheck before
   a workstream is promoted.

**Correctness bug blocking the exit criterion**, `apps/server/src/symphony/Orchestrator/Projection.ts:53-65`:
four exclusive `if (…) return {…}` branches where they must accumulate. Any issue with a
non-null `description` — nearly every GitHub issue — silently drops `baseBranch`, `priority`, and
`blocked` from the projected work item. Since the Queue view renders priority and blocked status,
"eligible work appears accurately" is not currently true. Fix by folding the four conditions into
one accumulated object.

## Upstream: revisit later

**Correction worth carrying:** an earlier sync check in this session used `git log --all`, which
matches `upstream/main` itself and produced false PRESENT results. The accurate method is subject
matching against `git log HEAD` only. Re-checked that way, **this fork is not closely tracking
upstream** — of 14 recent PRs sampled, only #5147 has a matching subject in HEAD's history.

Not applied, worth evaluating:

| PR | Note |
|---|---|
| **#5331** Upgrade Effect to beta.103 | +383/−597. Do **after** `apps/server` typecheck is green, not before — Symphony is heavily Effect-based and stacking two failure sources will be miserable to debug. |
| **#5322** protect held Ctrl/Cmd+W | **Not cherry-pickable.** The fork's `ThreadTerminalDrawer.tsx` has no `handleBeforeKey` and diverges ~150 lines. Manual port: add `apps/web/src/lib/terminalCloseShortcut.ts`, the `DesktopWindow.ts` guard, and a call site. Matters more once agent runs are long-lived. |
| **#5314** blink the terminal cursor | **N/A.** Conflicts because the fork deleted `apps/web/src/terminal/ghostty/`. There is no ghostty renderer here to fix. |
| **#5075** scrub AppImage XDG vars | Linux-only, conflicts in `terminal/Manager.ts`. Low value here. |
| **#5190** fold legacy models into menus | Not applied. The fork lacks `isLegacy` in contracts entirely. An imported test for it was removed in `cc72fc4f9`. |
| #5008, #5038, #4971, #5055, #5025, #5027, #5095, #5217, #5181 | All MISSING under the corrected check, despite an earlier claim otherwise. Re-evaluate individually. |
| #5176, #5310, #5309, #5307 | orchestration-v2 / chat-V2 work. May not apply; the fork has its own orchestration lineage. |
| #4959 search by conversation content, #4967 screenshot compression | Feature-sized, not yet assessed. |

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git checkout feat/symphony-mode-impl
pnpm install
cd apps/server && pnpm exec vp run typecheck
```

Setup required first: none beyond `pnpm install`. If it fails on a corrupt
`@github/copilot-darwin-arm64`, remove that entry from `.pnpm` and re-run with `CI=true pnpm install`.

Machine-specific: branch is local-only on MacBookPro. Push before working elsewhere.

Background jobs still running: none.

## Blockers

- **Branch local-only, Symphony work uncommitted.** Unblocked by committing in logical units and
  `git push -u`.
- **`apps/server` typecheck fails (24 errors).** Unblocked by switching Symphony persistence to
  `Schema.fromJsonString` / `Schema.toCodecJson` and Effect `DateTime`, and adding
  `@effect-expect-leaking HttpServerRequest` to `LocalTransportAuth`.
- **Three Symphony RPC schemas are copy-paste wrong** and would ship broken once registered:
  `getRun` returns `SymphonyRunEventsStreamEvent` (`rpc.ts:738`), `delegateFromThread` takes
  `SymphonyGetOverviewInput` with no `threadId` (`rpc.ts:893`), `activateWorkflow` returns a
  work-item id (`rpc.ts:774`).
- **No mode switch in the app chrome.** `Sidebar.tsx` has zero Symphony references, so FR-003's
  view-state restore is unreachable. Kamogelo said he would build parts of the shell himself —
  confirm ownership before an agent touches those files.

## Open decisions

- **What implementation runs on.** Luna is ruled out. Nothing has replaced it.
- **Whether to strip the ~50 `T3CODE_*` local env aliases and `t3code:` localStorage prefixes.**
  Cosmetic rebrand debt with no data path, but removing them breaks existing installs' stored state
  and anyone's exported env vars. Needs a migration, not a find-and-replace.
- **Revision 3 of the Symphony plan is unspent** (of 3 allowed). Held for after real code
  contradicts the plan.

## Review artefacts

`REVIEW.md` at the repo root holds the full Symphony review with a coverage section and a
CORRECTIONS section. It is **gitignored via `.git/info/exclude` and does not travel.**

Caveat recorded there and worth repeating: the review ran against a moving tree. Every blocker it
originally recorded had been fixed by session end, some minutes after being written. Re-verify any
finding before acting on it.

## Fork discipline (non-negotiable)

New code in fork-owned directories/files only; edits to shared upstream files must
be one import + one registration/mount entry wherever possible; never reformat
upstream code; update `FORK.md` for every shared file touched; lockfile changes via
`pnpm install --lockfile-only`; rebase with
`scripts/rebase-upstream.sh` per upstream release. Commit in logical units; never
push to upstream. Upstream remote fetch works but push is disabled
(`DISABLED_NO_PUSH`); add the org's internal remote as `origin` when it exists.

## Telemetry policy (changed 2026-08-04)

Opt-in (`NEOKOD_TELEMETRY_ENABLED` defaults `false`), Neokod's own PostHog project on the EU cloud,
no `T3CODE_*` fallbacks. Turning it on by default would need an opt-out surface first, because
PRD 21 requires opt-in and no such UI exists.

## Cross-repo dependency / risk

The AI-Orch receiving endpoint (v0 schema incl. `permission_decision`, Claude
backend switch, version bumps to v0.23.0-beta) is implemented but UNCOMMITTED in
/Users/kamogelo/Code/ai-orch on branch `feat/governed-client-onboarding`, awaiting
the owner's review. The governance forwarder here cannot be validated end to end
until that lands; do not describe governance as fully wired in the UI before then.
Remaining ai-orch backlog: browser SSO enrolment flow for credentials, Foundry
Anthropic translation adapter, MCP gateway tool annotations + W3C trace context,
enterprise working set (SSO/RBAC + KMS, Postgres/HA, OTel).

## Verification commands

- All packages: `vp check` and `vp run typecheck`.
- Web only: `node_modules/.bin/vp run --filter @neokod/web typecheck`; tests via `vp test run <path>` from `apps/web`.
- Server (package name `neokod`): `node_modules/.bin/vp run --filter neokod typecheck`; Symphony suite `vp test run src/symphony/` from `apps/server`.
- Contracts: `@neokod/contracts` typecheck + tests.
- Supply chain: `pnpm install` enforces a 4-day minimum release age (`pnpm-workspace.yaml`,
  minutes) and `bunfig.toml` mirrors it (seconds). Units differ between the two tools.
