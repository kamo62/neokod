# Handoff

Updated: 2026-08-06 12:10 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `3f2e8dbdc` feat(symphony): Phase 5 completion — GitHub PR status enrichment and host-backed merge gates
- Pushed: local-only; 11 commits ahead of origin. Push after the next commit.
- Dirty: `Neokod Symphony Mode Product Requirements.pdf`, `PLAN-exec-demo.md`, `demo.md`,
  `apps/server/src/__probe/probe.ts` (user files, never stage). Everything else is committed.

## Done

Phase 3, 4, 5 and 6 all landed in committed, tested slices. Full server suite: 208 files passed /
2 skipped, 1880 tests passed / 7 skipped (~160-220s). `vp check` 0 errors / 26 warnings.
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

## Verified vs unverified

- **Verified: full server suite green.** `cd apps/server && ../../node_modules/.bin/vp test run`
  -> 208 files passed / 2 skipped, 1892 passed / 7 skipped.
- **Verified: `vp check --fix` passes.** 0 errors; 27 warnings, all pre-existing.
- **Verified: server typecheck clean** after the same filter as before (JSON.parse,
  preferSchemaOverJson, globalDate, OrchestratorStateRepository, WorkflowRepository.test,
  globalErrorInEffect, instanceOfSchema, deterministicKeys, LocalTransportAuth, \_\_probe,
  bin\.test, layerMergeAllWithDependencies, suggestions).
- **Verified: contracts + web typecheck clean.**
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
- **Known beta quirks** (from earlier phases): `it.effect` required (plain `it` silently skips);
  `exactOptionalPropertyTypes` needs explicit `| undefined`; http body fakes must handle both
  `Uint8Array` and `{body: Uint8Array}` request shapes.

## Next moves

1. Push this branch (`git push -u origin feat/symphony-mode-impl`).
2. Run the manual live smoke procedure above (real Codex app-server, real repo, real PR + CI).
3. Review/merge pass with upstream `pingdotgg/t3code` divergence filters (AGENTS.md).
4. Optional Phase 5 follow-up: enrichment for GitLab, Bitbucket and Azure DevOps hosts
   (currently null; merge readiness caps at `ready_for_review` for them).
