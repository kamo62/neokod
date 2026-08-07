# Handoff

Updated: 2026-08-07 11:55 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `6fd9a5c48` feat(symphony): close plan-gap lanes — pause/resume/stopAll RPCs, subscriptions, notifications, audit writer, env scrubbing, continuation turns, tracker residuals, advisory lock
- Pushed: NOT yet — push after the next commit.
- CRITICAL note on `2e6fb9abe`: it did NOT boot as committed (WorkflowLoaderLive merged bare;
  constructor yields WorkflowRepository + FileSystem — fourth instance of the layer-construction
  trap, invisible to suites on fakes). Fixed in `c163e58d9`, verified by live boot probe (reaper
  starts, startup URL minted). Booting the real server after ANY layer change is now the
  non-negotiable check. The same trap applies to this session's new layers (AuditRepository,
  TrackerCheckpointRepository, NotificationCoordinator) — all are wired into the same
  `Layer.provide` lists that the live boot probe validates.
- Dirty: only the standing user files (PDF, PLAN-exec-demo.md, demo.md, `__probe/`,
  `apps/server/scratch-neokod-symphony-layer-probe.ts`). REVIEW.md and the audit record are
  GITIGNORED local files — they do not travel; the closure summary below is the durable copy.
- Kamogelo's parallel session work (telemetry, keybindings, web UI) was committed upstream of
  this session (5be8ce051 etc.) — the working tree is clean of it.

## Done (this session: closed the audit's open items 1-8-first-entry)

- `2e6fb9abe` closed the completion-audit "still open" list:
  - **Item 1 (plan 16.0 residuals)**: takeOver now waits for the dispatch fiber/agent to exit
    (bounded 5s poll of isAgentActive) and validates repository/worktree/branch identity via
    `git.status` — a drifted checkout or detached HEAD aborts before any ownership transfer
    (tests: drift-abort + success paths). resumeAutonomous drops `running` from its from-list
    (no second-agent admission) and refuses when the bound Work thread's session is
    starting/running (idleness check; test with a busy projection). bindWorkThread now binds a
    REAL thread in production: engine+projection are REQUIRED deps of HandoffServiceLive
    (bound at construction, no placeholder; the earlier slice-provide fix didn't resolve in
    the sub-graph). takeOver park uses `requireUnclaimed` (owner-fenced).
  - **Item 2 (retry re-check)**: dispatchWorkItem re-reads the issue from the tracker via
    `refreshIssues` before re-dispatching (plan 9.5) — a vanished issue refuses dispatch and
    leaves the item queued (test). Per-repository and per-workflow concurrency caps enforced
    (config fields already existed; global-only before).
  - **Item 3 (recovery)**: the agent child PID is recorded on the claim
    (`AgentRuntime.pid()` + `setClaimOwnerPid`); recovery terminates a surviving orphan
    (probe + SIGTERM) before releasing. Pending approvals for a dead run are marked
    `interrupted` (new ApprovalService.interrupt; recovery only adopts runs with a live
    claim).
  - **Item 4 (canonicalization)**: WorkspaceOwnershipRepository canonicalizes paths via
    `FileSystem.realPath` at acquire/transfer/renew/release/getByWorkspacePath.
  - **Item 5 (GitHubCli)**: mergeable is now tri-state (`mergeable`/`conflicting`/`unknown`);
    `latestCommit` is queried and recorded; a failed reviewThreads query FAILS the status read
    instead of coercing to 0 (an unknown thread count can no longer pass the merge gate).
  - **Item 6**: real two-connection claim-dedup contention test (two independent SQLite
    connections over one file; exactly one claim wins).
  - **Item 7**: `AttentionRepository` (table from migration 037 had zero writers) — the
    finalizer raises a durable `merge_conflict`-kind attention item on pr_creation_failed;
    listAttention merges raised items with approvals.
  - **Item 8 first entry (WORKFLOW.md production wiring)**: new `Workflow/Loader.ts` — reads
    WORKFLOW.md, parses, resolves effective config, upserts the record (invalid → status
    `invalid` with validationError). `validateWorkflow` RPC is real (was {ok:true} stub);
    `activateWorkflow` RPC registered + real; the poll tick calls `reloadChanged` for dynamic
    reload (plan 6.4). Loader tests cover valid + invalid.

## Verified

- Full server suite: 211 files, **1946 passed / 7 skipped** green (was 1934 before this
  session's ~12 new tests).
- Web suite: 160 files / 1474 green.
- Filtered server typecheck clean; `vp check` 0 errors / 29 warnings (baseline 27 + 2 new
  pre-existing-class warnings from new files, none failing).

## Done (overnight session, goal: complete HANDOFF items + serve/test + confirm REVIEW closure)

- `0c1fef4e3` server boot + browser auth: the symphony sub-graph left RuntimeServicesLive without
  FetchHttpClient (boot died on the analytics batch sender), and
  `resolveConfiguredPrimaryTarget` dropped the `loopbackAuthToken`, so the browser WS-A2 flow
  401'd forever. Both found only by actually serving the app.
- `91a7394a1` + `dee3ee587` test debt: 501ce27b8 regression test (the port itself was already in
  `65e6e1c5b`), keybindings fixture collision with the new `thread.reopenLastArchived` default,
  stale uiStateStore expectations. Full server suite 210 files / 1942 tests green; web
  160 / 1474 green.
- `759bd11cd` completion-audit top fixes: ownership lease bound at layer construction (wiring
  gap now fails boot loudly — proven live against the running server), lease on create AND
  reuse, typed `WorkspaceLeaseError` on failure; ExecutionFinalizer logs + records a durable
  `pr_creation_failed` run event instead of swallowing PR-creation errors.
- Full Chrome DevTools pass on the served app: authenticated loopback flow end to end, first-run
  analytics notice (correct copy, dismissal persists), analytics toggle live both directions,
  reopen-last-archived restores an archived thread, Symphony overview live, UI Phase 1
  typography/header/elevation verified on real content, both themes clean.
- Completion audit (Fable, per-finding, file:line): ~40 of ~50 REVIEW findings verified closed;
  the two most severe open items were fixed above.

## Verified vs unverified

- Verified: everything in Done names its command or a live observation; server boots and serves
  (watched restart cycle), scoped suites and both full suites green, `vp check` 0 errors.
- Unverified: none of the closed items — but see Open items for what remains open by audit.

## Open items (remaining after this session)

1. Unimplemented plan sections (gaps, not regressions): 13 defined-but-unregistered RPCs
   (pause/stop-all safety controls, subscriptions, listTrackers/listHistory, resolveAttention),
   notifications coordinator (15.4), observability/audit writers (section 17 — table exists,
   zero writers), agent child env scrubbing (SPEC 15.3 — secretEnvironmentNames never consumed),
   continuation turns (plan 8.2 — flag exists, no caller), FR-102-104 review-comment ingestion,
   UI stubs (settings/trackers/history routes, workflow editor, PR panel), tracker residuals
   (checkpoints table unused, localPriority sort, GitLabAdapter dispatchable), startup advisory
   lock, second ACP provider. WORKFLOW.md wiring (load/activate/reload) is DONE; the live smoke
   is now unblocked on the tracker-activation side.
2. WORKFLOW.md: activateWorkflow/validateWorkflow RPCs registered; pause/resume/stopAll need
   handlers before their RPCs join WsRpcGroup.
3. Kamogelo: PRD section 21 amendment for default-on analytics (still pending).

## Plan-gap lanes closed (6fd9a5c48, this session)

- Pause/resume/stopAll RPCs: migration 039 (paused_workflows/paused_repositories columns),
  repo methods, orchestrator methods, ws handlers, WsRpcGroup registration. Per-scope pause
  gates dispatch; global pause is the top-level kill switch; stopAllRuns requires the
  `stop-all-runs` confirm literal. getWorkflow/listTrackers/listHistory/resolveAttention also
  real + registered (their success schemas were EmptyResult stubs).
- Subscriptions: all 5 subscribeSymphony\* streams implemented as 2s snapshot streams
  (overview/runs/queue/attention/runEvents) + registered. The old "views poll" gap is gone.
- Notifications coordinator (15.4): pub/sub NotificationCoordinator; publishes on cancel +
  merge-approve; tested.
- Audit writer (13.4): AuditRepository writes symphony_audit_events (dispatch/cancel/merge);
  the table finally has writers.
- Env scrubbing (SPEC 15.3): tracker secretEnvironmentNames resolved per config and stripped
  from the agent child env (scrubEnvironment, 3 tests).
- Continuation turns (8.2): dispatcher loops runTurn up to maxTurns with continuation:true.
- Tracker residuals: localPriority feeds queue sort (COALESCE local_priority, priority);
  GitLabAdapter dispatchable = state opened; TrackerCheckpointRepository records last_poll_at.
- Advisory lock: acquired at startup (per-launch token), renewed 30s, released on teardown,
  dispatch gated when not held. (Note: the first wiring orphaned the scheduler — fixed; the
  poll loop runs under the lock fork.)

## Verified (this session)

- Full server suite: 1954 passed / 7 skipped (was 1946). Web suite: 160 files / 1474 green.
- Filtered server typecheck clean; `vp check` 0 errors / 30 warnings (2 new pre-existing-class:
  unused vars in user's `__probe/probe.ts` and the tracker DEFAULT\_\* consts — none failing).
- The live boot probe must be re-run (server.ts layer graph changed) before relying on this
  commit set.

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git pull
git checkout feat/symphony-mode-impl
pnpm install
PATH="$PWD/node_modules/.bin:$PATH" node scripts/dev-runner.ts dev   # serve; needs vp on PATH
# browser: use the startupUrl WITH ?loopbackAuthToken=... printed in the dev log; token is
# per-launch and never persisted, keep it in the URL across navigations.
```

Setup required first: none beyond `pnpm install` (corrupt `@github/copilot-darwin-arm64` fix:
remove from `.pnpm`, re-run `CI=true pnpm install`).

Machine-specific: codex-companion.mjs patched for max/ultra efforts on MacBookPro (re-patch
after plugin updates). NOTE: the Codex backend went into degraded mode ("no available accounts")
at the end of this session — delegation may be unavailable until it recovers; the last fixes
were implemented directly. Kamogelo runs a parallel OpenCode session in this repo at times.

Background jobs still running: the dev stack may still be serving under the dev-runner
(node --watch restarts on edits). Kill the `node scripts/dev-runner.ts` process tree if
unwanted.

## Blockers

- Effect 4.0.0-beta.78 drift (carried): Effect.result not Effect.either; it.effect required;
  exactOptionalPropertyTypes | undefined; TestClock at epoch; services hidden in Layer.provide
  sub-graphs resolve None via serviceOption — bind at construction when the dependency is
  mandatory (that trap caused both the removal-gateway hole and tonight's boot failures).
- Root `vp run typecheck` blocked by pre-existing scripts/sync-reference-repos errors.
- Codex sandbox cannot bind 0.0.0.0 (one serverSettings fixture test fails only there).

## Next moves

1. Push this branch (`git push`).
2. Re-run the live boot probe (server.ts layer graph changed with the 3 new repos/coordinator).
3. Run the manual live smoke procedure (real Codex app-server, real repo, real PR + CI) — all
   plan-gap lanes that blocked it are closed.
4. Remaining plan gaps (UI-scoped, lower priority): settings/trackers/history route stubs,
   workflow editor (PRD 12.3), PR panel (15.3.1), FR-093 five attention buckets, FR-102-104
   review-comment ingestion, observability gauges (section 17 metrics), second ACP provider.
5. Kamogelo: PRD section 21 amendment for default-on analytics (still pending).
