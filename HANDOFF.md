# Handoff

Updated: 2026-08-06 18:20 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `38df58a20` fix(symphony): address REVIEW.md P0/P1 findings — cancel fiber, FR-095 gates, removal gateway, PR body file, evidence rules
- Pushed: local-only; 12 commits ahead of origin. Push after the next commit.
- Dirty: `Neokod Symphony Mode Product Requirements.pdf`, `PLAN-exec-demo.md`, `demo.md`,
  `apps/server/src/__probe/probe.ts` (user files, never stage). Also dirty (NOT mine, do not
  commit): `apps/server/src/provider/copilot/*`, `apps/server/src/telemetry/*`,
  `apps/server/src/serverSettings.test.ts` — Kamogelo's in-progress telemetry session, which
  currently breaks the `bin.ts` typecheck (ServerSettingsService leak).

## Done

Phase 3, 4, 5 and 6 all landed in committed, tested slices, and the REVIEW.md Phase 3-6 findings
(35 total: 8 P0, 16 P1, 11 P2) are addressed. Full server suite: 208 files passed / 2 skipped,
1905 tests passed / 7 skipped (~180s). `vp check` 0 errors / 27 warnings (baseline).
Filtered server typecheck clean (same noise filter as before).

- `8d7e24c22` **Phase 3 WS-L**: `Validation/Runner.ts` (runs `validation.required` via
  ProcessRunner in the workspace, exit 0 = passed, output to `<logs>/symphony/<runId>/validation/`),
  `Evidence/Service.ts` (bundle: changed files from base..head diff, commits, validation results,
  SYMPHONY_EVIDENCE.md parse with no generated fallback, assessment rules), `Evidence/PullRequest.ts`
  (orchestrator-owned PR creation through SourceControlProvider — never a hard-coded CLI; branch
  push + body file + create + lookup), `Runner/ExecutionFinalizer.ts` (validation -> PR ->
  `ready_for_review`; failure -> `retry_scheduled`), `EvidenceRepository` (symphony_evidence table,
  migration 036 already existed), `symphonyLogsDir` in ServerConfig.
- `28c9d4fe7` **Phase 3 WS-M**: `Orchestrator/Retry.ts` (retry classes + exponential backoff
  `min(10s*2^(n-1), maxRetryBackoffMs)`), `Orchestrator/Recovery.ts` (startup: mark interrupted,
  release stale claims, re-schedule retryable), retry sweep in the orchestrator tick, dispatcher
  releases failures to `retry_scheduled` with attempt sequencing.
- `2469fe13f` **Phase 3 WS-N**: reviews route (ready_for_review/validation_failed runs) + evidence
  panel on run detail (assessment, changed files, validation, PR link).
- `ebe81dabe` **Phase 4 (part 1)**: `WorkspaceOwnershipRepository` (acquire/transfer/renew/release
  with generation fencing; NULL lease = held indefinitely; release deletes the row),
  `HandoffService` (takeOver: cancel run + settle live requests + transfer ownership to work +
  park item as `blocked`; resumeAutonomous: transfer back + re-queue; delegateFromThread: create
  work item from a Work thread), WS RPCs takeOver/resumeAutonomous/delegateFromThread.
- `f49bdca61` **Phase 4 (part 2, definition of done)**: `WorkspaceRemovalGuard` — the shared
  removal gateway from plan 16.0. `GitWorkflowService.removeWorktree` (the generic Work-mode
  `vcs.removeWorktree` RPC) refuses removal of a workspace held by a live Symphony lease unless
  `force`; `WorkspaceManager.removeWorkspace` refuses removal of a Work-held lease; both consult
  the guard via `serviceOption` so Work mode alone (no Symphony layer) is unaffected. `takeOver`
  now binds a **real Work thread**: resolves/creates the project for the workspace root and
  dispatches `project.create` + `thread.create` with `worktreePath` + derived branch, reusing a
  caller-provided thread id when given.
- `8d9fbe031` **Phase 5 (part 1)**: orchestrator `requestChanges` (review-ready ->
  changes_requested + event), `approveMerge` (gated on evidence assessment -> ready_to_merge; no
  auto-merge), `refreshPullRequest` (re-fetch PR via provider and update stored evidence), WS RPCs
  requestChanges/approveMerge.
- `3f2e8dbdc` **Phase 5 (part 2, host enrichment)**: `ChangeRequestStatus` contract
  (`ciStatus`/`reviewState`/`mergeable`/`unresolvedComments`/`latestCommit`); new
  `SourceControlProvider.getChangeRequestStatus` (GitHub implemented via
  `gh pr view --json mergeable,statusCheckRollup,reviews,reviewDecision,comments`; GitLab,
  Bitbucket, Azure DevOps and the unsupported fallback return null — plan 10.1 sequences GitHub
  first). `PullRequestService.refresh` carries the enriched fields into `PullRequestEvidence`;
  `approveMerge` gates on failed CI, changes_requested, non-mergeable and unresolved comments.
  Hosts without enrichment cap honestly at `ready_for_review` (FR-095).
- `e937593fe` **Phase 6**: `AzureBoardsApiClient`/`AzureBoardsAdapter` (WIQL query + batch fetch,
  PAT via Basic auth, kind `azure_boards`, AB-<id>) and
  `GitHubProjectsApiClient`/`GitHubProjectsAdapter` (Projects v2 GraphQL, kind `github_projects`,
  opaque id = project item id, GH-<issue number>, status field = state). Both registered in
  `TrackerRegistryGitHubLive`, TrackerKindSchema extended to 7 kinds, profile docs
  `docs/integrations/symphony-azure-boards.md` + `symphony-github-projects.md`.
- `8ac2dde11` **Fix**: the new RPCs were missing from `WsRpcGroup` in contracts, which made
  `RpcServer.toHttpEffectWebsocket` reject the handler map and every WS upgrade return 500
  (44 server.test.ts failures). Registered the 5 RPCs; also replaced an eager
  `WorkItemId.make("")` fallback (throws on empty) with `WorkItemId.make("none")`.
- `38df58a20` **REVIEW.md Phase 3-6 findings** (35 total: 8 P0, 16 P1, 11 P2), the three named
  clusters closed:
  - **Removal gateway now works on every path**: `WorkspaceManagerLive` resolves the guard per
    call (was construction-time None, disarming the Symphony arm); `removeWorkspace` gained an
    error channel (blocked removal propagates as `WorkspaceRemovalBlocked`); the guard no longer
    treats `force` as an ownership override (Work thread deletion sends git-force, not
    ownership-force); guard fails closed on ownership-table read errors.
  - **Cancellation stops a run**: `cancelRun` interrupts the dispatch fiber (tracked in
    `activeAgents` alongside the agent); the completed branch refuses to finalize/PR when the
    attempt is already terminal; `markFailed` derives retryability from the recorded status
    (user_cancelled/tracker_cancelled never retried); `updateStatus` still guards terminal
    transitions via the new `from`-restricted transition.
  - **approveMerge inverts FR-095 fixed**: positive assertions only — requires non-null PR,
    `ciStatus === "success"`, present non-changes-requested reviewState, `mergeable === true`,
    zero unresolved comments. A run with no PR or no host enrichment stays `ready_for_review`.
    The test that encoded the old violation was replaced with correct FR-095 tests.
  - **PR creation works in production**: `PullRequestServiceLive` writes the body file via
    FileSystem; the Dispatcher resolves the body dir (symphony logs dir via serviceOption, temp
    dir fallback). `create` returns `null` when the PR cannot be located (was a fabricated
    number:0 that passed merge gating). `refresh` queries all states so merged/closed PRs
    reflect.
  - **Evidence rules (suite 7)**: `skipped` validation degrades to failed; an empty
    `SYMPHONY_EVIDENCE.md` is `insufficient`, not `ready_for_review`.
  - **Lifecycle legality (suite 6)**: `WorkItemRepository.transition` gained a `from` source
    restriction; takeover park and resume re-queue are source-restricted and their results
    checked. Test file added.
  - **Other**: `lifecycleForRun` checks the work item first (review lifecycle visible in lists);
    `RunSummary` carries `overallAssessment` (reviews badge no longer fabricated); overview
    counters live (running/needsAttention/readyForReview/retrying/failedToday); Recovery
    releases Symphony workspace leases; GitHubCli status decode via Schema.fromJsonString (no
    defect escape) + unresolved review threads from GraphQL `reviewThreads` (was always 0);
    ExecutionFinalizer writes the terminal status once after the verdict; Azure Boards batch
    fetch chunks at 200 + credential probe hits the project resource; GitHub Projects nested
    page sizes 100; both new adapters derive `dispatchable` from the record; takeOver parks
    before ownership transfer and validates caller threadIds against the projection;
    resumeAutonomous picks the matching workspace record and preserves the thread binding;
    delegateFromThread validates the source thread and carries relevantFiles; Symphony RPC
    action fallbacks fail with `symphony_unavailable` instead of reporting success when the
    layer is absent; retry-sweep dispatches run in per-tick scopes; dispatch honours global
    pause, exclusion and the global concurrency cap.

## Verified vs unverified

- **Verified: full server suite green.** `cd apps/server && ../../node_modules/.bin/vp test run`
  -> 208 files passed / 2 skipped, 1905 passed / 7 skipped.
- **Verified: `vp check --fix` passes.** 0 errors; 27 warnings, all pre-existing.
- **Verified: server typecheck clean** after the same filter as before (JSON.parse,
  preferSchemaOverJson, globalDate, OrchestratorStateRepository, WorkflowRepository.test,
  globalErrorInEffect, instanceOfSchema, deterministicKeys, LocalTransportAuth, \_\_probe,
  bin\.test, layerMergeAllWithDependencies, suggestions).
- **Verified: contracts + web typecheck clean.**
- **Note: the unfiltered `bin.ts` typecheck is currently red** because of Kamogelo's uncommitted
  copilot/telemetry session (ServerSettingsService leak into the launch boundary) — NOT the
  Symphony work. Stash those files to verify.
- **Unverified: live dispatch against a real Codex app-server.** Manual smoke test only (procedure
  below).
- **Unverified: real Azure Boards / GitHub Projects credential flows.** Adapter tests use fake
  HTTP clients; no live-host smoke test has run.
- **Unverified: GitHub enrichment against a real PR.** `gh pr view --json` parsing is unit-tested;
  no real-repo run has executed the enriched `refreshPullRequest` + `approveMerge` path.

### Manual live smoke procedure (Phase 3-6 exit check)

1. `cd apps/server && ../../node_modules/.bin/vp dev` (or `neokod serve`) with a real repo open.
2. Add a `WORKFLOW.md` in that repo with `tracker.kind: memory` or a real tracker, autonomy
   `execute`, `validation.required` set, and an active issue.
3. From the web UI (Symphony mode): verify the queue shows the issue, Dispatch it, watch the run
   through `streaming_turn`, then confirm the evidence panel + PR link after completion.
4. Test `requestChanges` and `approveMerge` on the review-ready run; for a GitHub repo with a
   real PR + CI, verify the enriched gates (failed CI blocks `ready_to_merge`).
5. Test takeOver: from a running run, confirm the Work thread appears bound to the same
   workspace (files/terminal), then `resumeAutonomous` returns the item to the queue.
6. Real-host tracker probes: configure an Azure Boards workflow and a GitHub Projects v2
   workflow; confirm the queue populates from each.

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git pull
git checkout feat/symphony-mode-impl
pnpm install
```

Setup required first: none beyond `pnpm install`. If it fails on a corrupt
`@github/copilot-darwin-arm64`, remove that entry from `.pnpm` and re-run with `CI=true pnpm install`.

Machine-specific: branch is local-only on MacBookPro. Push before working elsewhere.

Background jobs still running: none.

## Blockers

- **Effect 4.0.0-beta.78 API drift**: `Effect.either` is v3 — use `Effect.result` (Result `Success`
  carries `.success`, `Failure` carries `.failure`). `Effect.orElseSucceed` takes a thunk.
  `Schema.decodeUnknownEffect` returns an Effect; hoist to module scope (lint). `it.effect` runs
  on a TestClock (epoch start) — lease/backoff tests must use 1969/2099-style dates.
- **WS RPC registration**: any handler added to `makeSymphonyRpcHandlers()` must have its RPC in
  `WsRpcGroup` (packages/contracts/src/rpc.ts), or every WS upgrade fails with 500. Eager brand
  construction in handler fallbacks (`WorkItemId.make("")`) throws at group build — use a valid
  literal or `Effect.sync`.
- **WorkItem evidence**: the work item row hardcodes `evidence: null`; evidence lives in
  `EvidenceRepository` (symphony_evidence). getRun merges it; approveMerge reads it there.
- **sql.in inside a template**: `sql.in("col", values)` produces a quoted fragment that fails
  nested inside another `sql\`...\``expression on SQLite — build it as a standalone fragment
(the`from`restriction in WorkItemRepository uses`sql.literal` for the IN list).
- **Known beta quirks** (from earlier phases): `it.effect` required (plain `it` silently skips);
  `exactOptionalPropertyTypes` needs explicit `| undefined`; http body fakes must handle both
  `Uint8Array` and `{body: Uint8Array}` request shapes.

## Next moves

1. Push this branch (`git push -u origin feat/symphony-mode-impl`).
2. Run the manual live smoke procedure above (real Codex app-server, real repo, real PR + CI) —
   now expected to pass step 3 (PR creation) for the first time.
3. Review/merge pass with upstream `pingdotgg/t3code` divergence filters (AGENTS.md).
4. Optional Phase 5 follow-up: enrichment for GitLab, Bitbucket and Azure DevOps hosts
   (currently null; merge readiness caps at `ready_for_review` for them).
5. Kamogelo: land the uncommitted copilot/telemetry session (fixes the `bin.ts` typecheck leak).
