# Handoff

Updated: 2026-08-05 12:30 on Kamogelos-MBP

## State

- Branch: `feat/symphony-mode-impl`
- HEAD: `8833ed5f2` feat(symphony): wire Phase 2 dispatch (claim -> workspace -> run turn)
- Pushed: branch is local-only, no upstream tracking branch; 5 commits ahead of `9a8b222fa`
  (Phase 1 completion handoff). Push after the next commit.
- Dirty: `Neokod Symphony Mode Product Requirements.pdf`, `PLAN-exec-demo.md`, `demo.md` (user
  files, never stage). Everything else is committed.

## Done

- `8833ed5f2` **Phase 2 dispatch spine**: `Dispatcher.ts` claim -> workspace -> run attempt ->
  agent turn (prepare/read-only mode produces a plan, marks `ready_for_review`, releases the
  claim on failure); `cancelRun` interrupts the active agent, settles live requests, records
  durable `user_cancelled`. `SymphonyOrchestrator` + live impl gained `dispatchWorkItem` /
  `cancelRun`; WS RPCs (`WsSymphonyDispatchWorkItemRpc`, `WsSymphonyCancelRunRpc`) and ws.ts
  handlers; client-runtime `dispatchWorkItem`/`cancelRun` atoms. Dispatch gated: observe autonomy
  never dispatches.
- **Orchestrator read APIs** (`SymphonyOrchestratorLive.ts`): `listRuns` (newest-first + latest
  event type), `getRun` (attempt + timeline + approvals, nullable via `WsSymphonyGetRunRpc`
  `NullOr(RunDetailsSchema)`), `listAttention` (pending approvals -> attention items via
  `approvalToAttentionItem`). `SymphonyLayer.ts` orchestrator chain now provides
  `RunAttemptRepositoryLive`, `RunEventRepositoryLive`, `ApprovalServiceLive` (+
  `ApprovalRepositoryLive` + `LiveRequestsLive`).
- **Web slice**: `SymphonyAttentionView` (approve/reject via `symphonyEnvironment.approve` /
  `reject`), `SymphonyRunningView` (run list + Cancel), `SymphonyRunDetailView` (status,
  attempts, approvals, timeline via `getRun`); routes `symphony.attention.tsx`,
  `symphony.running.tsx`, `symphony.$runId.tsx` rewired; `SymphonyQueueView` gained a Dispatch
  button (disabled when blocked/excluded). Client atoms `getRun` + `attention` queries,
  `approve`/`reject` commands.
- **Dispatcher tests** (`Dispatcher.test.ts`): real SQLite repos + fake WorkspaceManager + fake
  AgentRuntimeFactory. Covers prepare happy path (attempt `succeeded`, item `ready_for_review`,
  event sequence issue_claimed/workspace_created/plan_produced), failed turn (attempt `failed`,
  claim released -> `queued`), and cancel (durable `user_cancelled`, event appended, claim stays
  held until lease reconciliation — documented behaviour).
- Earlier on branch: Phase 1 gap fixes `963e10143` (Jira tracker, queue overrides, workflows
  route) + Phase 1 handoff `9a8b222fa`; upstream ports `cc72fc4f9` and earlier.

## Verified vs unverified

- **Verified: full server test suite green.** `cd apps/server && ../../node_modules/.bin/vp test run -- src/`
  -> 1751 passed / 7 skipped (194 files). Includes new Dispatcher (3) and orchestrator read-API
  (4) tests.
- **Verified: web typecheck clean.** `cd apps/web && ../../node_modules/.bin/tsgo --noEmit` -> 0 errors.
- **Verified: client-runtime + contracts typecheck clean.**
- **Verified: server typecheck clean** after filtering pre-existing noise (JSON.parse,
  preferSchemaOverJson, globalDate, OrchestratorStateRepository, WorkflowRepository.test,
  globalErrorInEffect, instanceOfSchema, deterministicKeys, LocalTransportAuth).
- **Verified: `vp check --fix` passes.** 0 errors; only pre-existing warnings.
- **Unverified: `vp run typecheck`** still fails 2 packages — `@neokod/scripts`
  (sync-reference-repos) and `effect-codex-app-server` (exit 137). Both pre-existing on a clean
  checkout of `9a8b222fa`; unrelated to this work.
- **Unverified: live dispatch against a real Codex app-server.** Manual smoke test only.
- **Unverified: WS RPC API test** for dispatch/cancel/getRun/listAttention over the wire.

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
  use `Effect.forkScoped` + `Fiber.join(fiber)` + `Effect.catch`. `it.effect` runs on a
  TestClock, so `Effect.sleep`/`Effect.timeout` never fire without `TestClock.adjust`.
- **Cancel path leaves the claim held** (`preparing`) until lease expiry/reconciliation —
  documented in Dispatcher tests; `markFailed` is not reached on interruption because
  interruption bypasses typed errors. Confirm reconciliation picks this up before Phase 3.
- **Known beta quirks**: `it.effect(...)` required (plain `it` silently skips); use
  `Effect.orElseSucceed` over catch+succeed; `exactOptionalPropertyTypes` needs explicit
  `| undefined` in param/struct types; registering an RPC without a ws.ts handler silently
  degrades the group's requirements to `any` (TS377030 cascade).

## Next moves (Phase 3)

1. Push this branch (`git push -u origin feat/symphony-mode-impl`).
2. Queue reconcile/lease-expiry path: confirm `stalled` / `canceled_by_reconciliation` statuses
   release claims (plan 8.3.1).
3. WS RPC API tests for dispatch/cancel/getRun/listAttention over the RPC layer.
4. Live smoke test of `dispatchWorkItem` against a real Codex app-server.
5. Attention UX: wire command approvals surfaced from live agents; then review/merge phase.
