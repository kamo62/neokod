# Handoff

Updated: 2026-08-06 00:30 on MacBookPro

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `8ac2dde11` fix(symphony): register Phase 4-5 RPCs in WsRpcGroup; avoid eager empty-brand construction
- Pushed: local-only; 8 commits ahead of origin. Push after the next commit.
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
- `ebe81dabe` **Phase 4**: `WorkspaceOwnershipRepository` (acquire/transfer/renew/release with
  generation fencing; NULL lease = held indefinitely; release deletes the row),
  `HandoffService` (takeOver: cancel run + settle live requests + transfer ownership to work +
  park item as `blocked`; resumeAutonomous: transfer back + re-queue; delegateFromThread: create
  work item from a Work thread), WS RPCs takeOver/resumeAutonomous/delegateFromThread.
  Projection-thread binding on takeOver is not implemented (returns a generated thread id).
- `8d9fbe031` **Phase 5**: orchestrator `requestChanges` (review-ready -> changes_requested +
  event), `approveMerge` (gated on evidence assessment != failed/insufficient and no unresolved
  comments -> ready_to_merge; no auto-merge), `refreshPullRequest` (re-fetch PR via provider and
  update stored evidence), WS RPCs requestChanges/approveMerge.
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
  -> 208 files passed / 2 skipped, 1880 passed / 7 skipped.
- **Verified: `vp check --fix` passes.** 0 errors; 26 warnings, all pre-existing.
- **Verified: server typecheck clean** after the same filter as before (JSON.parse,
  preferSchemaOverJson, globalDate, OrchestratorStateRepository, WorkflowRepository.test,
  globalErrorInEffect, instanceOfSchema, deterministicKeys, LocalTransportAuth, \_\_probe,
  bin\.test, layerMergeAllWithDependencies, suggestions).
- **Verified: contracts + web typecheck clean.**
- **Unverified: live dispatch against a real Codex app-server.** Manual smoke test only.
- **Unverified: real Azure Boards / GitHub Projects credential flows.** Adapter tests use fake
  HTTP clients; no live-host smoke test has run.
- **Unverified: takeOver thread binding.** The ownership transfer + run stop are tested, but the
  Work-mode thread is not actually created server-side; the RPC returns a generated thread id.

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
2. Live smoke test: `dispatchWorkItem` against a real Codex app-server, then the full
   validation -> evidence -> PR flow on a real repository.
3. Live smoke test of the Azure Boards and GitHub Projects adapters against real hosts.
4. Review/merge pass with upstream `pingdotgg/t3code` divergence filters (AGENTS.md).
5. Deferred from Phase 4: real projection-thread binding on takeOver; Work-mode cleanup gateway
   consulting the ownership record (plan 16.0 guard lives in the repo now, not yet enforced in
   `vcs.removeWorktree`).
