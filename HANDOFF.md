# Handoff

Updated: 2026-08-05 15:10 on Kamogelos-MBP

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `a29195c79` feat(symphony): Phase 2 completion + Linear/GitLab/Asana trackers with profile docs
- Pushed: branch is local-only, no upstream tracking branch; 6 commits ahead of `9a8b222fa`.
  Push after the next commit.
- Dirty: `Neokod Symphony Mode Product Requirements.pdf`, `PLAN-exec-demo.md`, `demo.md`,
  `apps/server/src/__probe/` (user files, never stage). Everything else is committed.

## Done

- `a29195c79` **Phase 2 completion + Phase 1 tracker debt**:
  - **Reconciliation** (`Orchestrator/Reconciler.ts`): terminal-claim release + stale claims
    moved to `stalled`; reconciler tests green. Lease expiry integrated into
    `SymphonyOrchestratorLive`; `ApprovalService.expire` rewrite + orchestrator
    `sweepExpiredApprovals`; `WorkItemRepository` conflict key `(tracker_kind, tracker_issue_id)`.
  - **WS RPC API tests** (`ws-symphony.test.ts`): dispatch/cancel/getRun/listAttention over the
    wire via `makeSymphonyRpcHandlers()` in `ws.ts`; Dispatcher tests extended with `queued`
    cancel asserts.
  - **Linear adapter** (`Trackers/LinearApiClient.ts` + `LinearAdapter.ts` + 13 tests): GraphQL,
    cursor pagination 50/page, ID refresh in 50-ID batches returned in requested order, `blocks`
    blocker extraction from `inverseRelations`, viewer query for `assignee: "me"`, secrets =
    LINEAR_API_KEY + `$VAR`.
  - **GitLab adapter** (`Trackers/GitLabApiClient.ts` + `GitLabAdapter.ts` + 13 tests): REST API
    v4, `PRIVATE-TOKEN` header, iid-as-id (`GL-<iid>`), nativeRef `{id, iid, project_id,
project_path}`, states restricted to opened/closed, 404 omission on refresh, env fallbacks
    `GITLAB_API_URL` / `GITLAB_PROJECT_PATH` / `GITLAB_PAT`.
  - **Asana adapter** (`Trackers/AsanaApiClient.ts` + `AsanaAdapter.ts` + 13 tests): Bearer auth,
    project GID scope, section name = state, `dispatchable = completed === false && resource_subtype
!== "section"`, offset pagination, active/terminal optional (null -> all states), 404 +
    outside-project omission on refresh.
  - **Registry** now maps all five kinds: github, jira, linear, gitlab, asana.
  - **Profile docs**: `docs/integrations/symphony-linear.md`, `symphony-gitlab.md`,
    `symphony-asana.md` (mirror `symphony-jira.md`).
- Earlier on branch: `2508a98e9` handoff, `bb8116d70` Phase 2 dispatch spine + web slice,
  `963e10143` Phase 1 gap fixes, `9a8b222fa` Phase 1 handoff, upstream ports.

## Verified vs unverified

- **Verified: full server test suite green.** `cd apps/server && ../../node_modules/.bin/vp test
run -- src/` -> 1799 passed / 7 skipped (197 files), ~165s. Includes Reconciler (2),
  ws-symphony (13), Dispatcher (3), orchestrator read-API (4) tests.
- **Verified: isolated adapter test files pass.** Direct vitest binary run on each of
  LinearAdapter.test.ts / GitLabAdapter.test.ts / AsanaAdapter.test.ts -> 13 passed each in
  ~600ms. (Note: `vp test run -- <file>` runs the whole suite, not one file.)
- **Verified: server typecheck clean** after filtering pre-existing noise (JSON.parse,
  preferSchemaOverJson, globalDate, OrchestratorStateRepository, WorkflowRepository.test,
  globalErrorInEffect, instanceOfSchema, deterministicKeys, LocalTransportAuth, \_\_probe,
  bin\.test).
- **Verified: `vp check --fix` passes.** 0 errors; only pre-existing warnings (27).
- **Unverified: `vp run typecheck`** still fails 2 packages — `@neokod/scripts`
  (sync-reference-repos) and `effect-codex-app-server` (exit 137). Both pre-existing.
- **Unverified: live dispatch against a real Codex app-server.** Manual smoke test only.

## Resume

```bash
cd /Users/kamogelo/Code/t3code
git pull
git checkout feat/symphony-mode-impl
pnpm install
```

Setup required first: none beyond `pnpm install`. If it fails on a corrupt
`@github/copilot-darwin-arm64`, remove that entry from `.pnpm` and re-run with `CI=true pnpm install`.

Machine-specific: branch is local-only on Kamogelos-MBP. Push before working elsewhere.

Background jobs still running: none.

## Blockers

- **Effect 4.0.0-beta.78 API drift**: `Effect.fork`/`fiber.join`/`Effect.catchAll` do not exist;
  use `Effect.forkScoped` + `Fiber.join(fiber)` + `Effect.catch`. `Effect.either` is v3 — use
  `Effect.result` (Result `Success` carries `.success`, `Failure` carries `.failure`).
  `Schema.decodeUnknownEffect` returns an Effect — chain `.pipe(Effect.mapError(...))`;
  nullable fields use `Schema.NullOr`. `it.effect` runs on a TestClock, so
  `Effect.sleep`/`Effect.timeout` never fire without `TestClock.adjust`.
- **Test-fake URL params**: `HttpClientRequest.setUrlParam` stores params in `request.urlParams`,
  NOT `request.url`. Fakes must read `UrlParams.getAll(request.urlParams, key)[0]`
  (`UrlParams.getFirst` returns an Option). Missing this caused an infinite pagination loop ->
  vitest worker OOM at 4GB heap in the GitLab test fake; fixed. Real code was correct.
- **Cancel path leaves the claim held** (`preparing`) until lease expiry/reconciliation —
  documented in Dispatcher tests; `markFailed` is not reached on interruption because
  interruption bypasses typed errors. Reconciliation picks this up (verified in Reconciler tests).
- **Known beta quirks**: `it.effect(...)` required (plain `it` silently skips); use
  `Effect.orElseSucceed` over catch+succeed; `exactOptionalPropertyTypes` needs explicit
  `| undefined` in param/struct types; registering an RPC without a ws.ts handler silently
  degrades the group's requirements to `any` (TS377030 cascade).

## Next moves

1. Push this branch (`git push -u origin feat/symphony-mode-impl`).
2. Phase 2 → review/merge with upstream `pingdotgg/t3code` divergence check (local-first filters
   from AGENTS.md).
3. Live smoke test of `dispatchWorkItem` against a real Codex app-server (manual).
4. Attention UX: wire command approvals surfaced from live agents.
5. Plan Phases 3-6 (profile/execution depth) with Kamogelo.
