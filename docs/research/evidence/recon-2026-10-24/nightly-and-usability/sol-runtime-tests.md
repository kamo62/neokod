# Detailed Symphony and normal-thread orchestration validation

672 tests passed across 42 focused existing files. No test failed. This is source-level unit/integration evidence against clean accepted candidate `85a4acfe5a35e04467758be7b95bde2e3491aadf`, not installed-app, live-provider, production-tracker, or managed-child proof. No repository source was edited. The only authored code is the separately requested temporary live-feedback probe correction, prepared but not executed by this agent.

## Source and scope

Checkout: `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code`; tree `5f991f7d70adbcdb26b7a2cd4db6bd3aff8b437a`. README, AGENTS, `docs/architecture/state-and-evidence.md`, Symphony architecture, plan 14.2 and 16.15–16.17, linked source-gate receipts and package scripts were inspected. Original `/Users/kamogelo/Code/t3code` was not modified. Tests ran on existing Node 24.22.1 and root Vite+ 4.1.9, without install/build/package/deploy, Playwright, real provider execution, production writes, or extra process signal experiments. Fixtures use in-memory SQLite, injected services, disposable directories and owned mock subprocesses. MCP HTTP tests start their own scoped loopback test server.

## What normal-thread orchestration actually does

The production interactive path is WebSocket command dispatch in `apps/server/src/ws.ts` into `orchestration/Layers/OrchestrationEngine.ts`. A single command queue processes envelopes, checks aggregate/command identities, persists events, receipts and projections transactionally, and streams domain events. `ProviderCommandReactor.ts` maps turn commands into provider sessions and `ProviderService.sendTurn`, carrying the selected provider/model and explicit runtime mode. `ProviderService.ts` routes to each provider adapter, retains persisted resume bindings, and fences starts/sends while a stop is unconfirmed.

`ProviderRuntimeIngestion.ts` turns canonical provider events into durable runtime-item and thread state. `RuntimeItemProjection.ts` distinguishes turn, session and potentially surviving detached activity. It preserves orphan uncertainty and lets authoritative late terminal evidence override synthetic closure. `TurnSettlementReactor.ts` publishes a durable outbox with deterministic thread/turn command IDs, including startup replay without duplicate settlement.

The provider-native Subagents panel is observability. Codex adapter maps receiver-keyed collab spawn/close and child-thread completion; Claude maps task lifecycle and ignores untyped background snapshots; Copilot maps SDK subagent lifecycle and separates child progress/output from the main result. Those cards do not create app-owned child threads or enforce managed-child admission. The native behaviours tested here use fake provider events; they establish adapter mapping, not provider parity or live dispatch.

`mcp/McpInvocationContext.ts` has exactly the `preview` capability today. `McpSessionRegistry.ts` creates a provider-scoped credential with environment/thread/provider-instance identity, a generated credential-session ID, hash storage and expiry/revocation. `McpHttpServer.ts` registers only preview toolkits. This is existing preview authority, not W6 active-parent-turn delegation authority. The planned delegation contracts, managed-child persistence/service/toolkit, result mailbox and observer are absent from the current production paths.

## Coverage matrix

| Area                                               | Cases exercised or matching evidence reused                                                                                                                                                                                                   | Evidence and limit                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Command identity and atomic state                  | Duplicate thread refusal; same-command replay; cross-aggregate command conflict; invariant rejection; atomic rollback; recovery after append/projection failure; queue survives storage error; event ordering/subscription lifetime           | New thread-orchestration batch, 189 tests/11 files overall                                                           |
| Parent/native-child lifecycle                      | Native task identity, progress and terminal mapping; detached activity becomes orphaned; late provider terminal fact supersedes synthetic uncertainty; no old-session closure; startup runtime-item reconciliation; durable settlement replay | New thread + provider batches; no app-managed child admission exists                                                 |
| Runtime/session recovery                           | Persisted resume bindings; stale session recovery; stop fences retained across failed/unconfirmed stop; provider instance mismatch/disabled target refusal; OpenCode interrupt/error/idle/late-abort races                                    | New provider batch, 219 tests/5 files                                                                                |
| Native subagent attribution                        | Codex receiver-keyed workers and child-thread result/plan updates; Claude task progress and ignored background snapshots; Copilot worker usage/result ownership and idle cleanup                                                              | New provider batch; fake runtime/SDK event fixtures only                                                             |
| MCP identity and protocol                          | Scoped capability refusal; token hash/revocation/idle expiry; bound endpoint selection; authenticated request context; DELETE session termination; notification 202 normalisation                                                             | New thread batch; isolated loopback HTTP and fake broker                                                             |
| Client lifecycle and results                       | Approval/input precedence; active turn without session; unknown evidence; terminal/orphaned elapsed freezing; task result summaries; per-environment/thread hidden cards; recovery/action effects                                             | New web batches, 91 tests/8 files; no rendered UI proof                                                              |
| Notifications                                      | Completion/failure edges; cached/reconnecting baselines; replacement epochs; same-ID scope isolation; duplicate suppression; in-flight/disabled occurrence handling                                                                           | New web notification logic, mocked browser Notification API; no OS delivery proof                                    |
| Symphony real-client composition                   | Failed fake Codex turn never finalises/opens PR; cancel interrupts and stays cancelled; JSONL fake peer EOF/exit/request behaviour                                                                                                            | New RunnerFlow/FakeCodexPeer batch; real client, fake peer, no coding agent process                                  |
| Workflow/tracker/queue                             | Parser/config validation; eligibility/state/label/pause/claim decisions; retry backoff and non-retryable cancellation; memory-adapter selective refresh; project-board lifecycle/coverage; advisory lock owner renewal/release                | New Symphony batch, 121 tests/15 files overall                                                                       |
| Validation/evidence/publication                    | Nonzero/spawn failure/timeout never passes; validation output retention; missing/insufficient/failed host evidence; PR formatting/provider abstraction/identity                                                                               | New Symphony batch, injected command/git/source-control implementations; no npm/cargo command or real push/PR occurs |
| Polling, leadership, queue fairness                | Workflow cadence; observe never dispatches; refresh refuses closed/removed-label items; retry does not block tick; one launch per tick; follower lock expiry/recovery; demotion/reacquisition                                                 | Reused unchanged `SymphonyOrchestratorLive.test.ts` in prior accepted source receipts                                |
| Merge gate                                         | Positive fresh host-enriched CI/review/mergeability/comment evidence; failed/unknown evidence refusal; qualified PR/repository identity; merged/closed sweep idempotence                                                                      | Reused unchanged orchestrator suite; mocked host/source-control only                                                 |
| Finalizer/current permission and process ownership | Accepted guidance target/policy pins; unsupported push/PR approval gates fail closed; recovery claim/lease retention and generation/PID protections                                                                                           | Reused initial 535 plus affected 163 evidence after final platform correction; no repeat signal experiment           |
| JSON-RPC boundary                                  | Typed and raw request modes, raw consumer approval, no auto-reply, stderr drain, EOF/termination, correlated errors, safe structural diagnostics                                                                                              | New protocol batch, 52 tests/3 files; disposable mock peer processes only                                            |

## Commands and outcomes

Every command used `PATH=/tmp/neokod-core-symphony-2026-10-21/node-v24.22.1-darwin-arm64/bin:<checkout>/node_modules/.bin:$PATH`. Full commands, cwd, counts, log paths and SHA-256 hashes are in `sol-runtime-tests.json`. Logs are raw Vite+ output; no full-suite run is claimed.

### thread-orchestration

Cwd: `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code/apps/server`. Exit 0; 11 files and 189 tests passed. Log: `/tmp/neokod-nightly-audit-2026-10-24/thread-orchestration-tests.log`.

```sh
vp test run src/orchestration/Layers/OrchestrationEngine.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts src/orchestration/Layers/TurnSettlementReactor.test.ts src/orchestration/Layers/ProjectionPipeline.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/RuntimeItemProjection.test.ts src/orchestration/decider.runtimeItems.test.ts src/orchestration/commandInvariants.test.ts src/mcp/McpSessionRegistry.test.ts src/mcp/McpInvocationContext.test.ts src/mcp/McpHttpServer.test.ts
```

### symphony-expanded

Cwd: `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code/apps/server`. Exit 0; 15 files and 121 tests passed. Log: `/tmp/neokod-nightly-audit-2026-10-24/symphony-expanded-tests.log`.

```sh
vp test run src/symphony/Runner/RunnerFlow.test.ts src/symphony/Runner/testkit/FakeCodexPeer.test.ts src/symphony/Validation/Runner.test.ts src/symphony/Orchestrator/Eligibility.test.ts src/symphony/Orchestrator/Retry.test.ts src/symphony/Orchestrator/Projection.test.ts src/symphony/Orchestrator/ProjectBoard.test.ts src/symphony/NotificationCoordinator.test.ts src/symphony/Trackers/Registry.test.ts src/symphony/Trackers/SettingsOverlay.test.ts src/symphony/Persistence/Layers/OrchestratorStateRepository.test.ts src/symphony/Workflow/Config.test.ts src/symphony/Workflow/Parser.test.ts src/symphony/Evidence/Service.test.ts src/symphony/Evidence/PullRequest.test.ts
```

### provider-orchestration

Cwd: `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code/apps/server`. Exit 0; 5 files and 219 tests passed. Log: `/tmp/neokod-nightly-audit-2026-10-24/provider-orchestration-tests.log`.

```sh
vp test run src/provider/Layers/ProviderService.test.ts src/provider/Layers/CodexAdapter.test.ts src/provider/Layers/ClaudeAdapter.test.ts src/provider/Layers/OpenCodeAdapter.test.ts src/provider/copilot/CopilotAdapter.test.ts
```

### web-orchestration

Cwd: `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code/apps/web`. Exit 0; 6 files and 59 tests passed. Log: `/tmp/neokod-nightly-audit-2026-10-24/web-orchestration-tests.log`.

```sh
vp test run --project unit src/session-logic.subagents.test.ts src/subagentUiStore.test.ts src/notifications/activityNotifications.logic.test.ts src/notifications/browserNotification.test.ts src/orchestrationRecovery.test.ts src/orchestrationEventEffects.test.ts
```

### protocol-orchestration

Cwd: `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code`. Exit 0; 3 files and 52 tests passed. Log: `/tmp/neokod-nightly-audit-2026-10-24/protocol-orchestration-tests.log`.

```sh
vp test run packages/contracts/src/orchestration.test.ts packages/effect-codex-app-server/src/client.test.ts packages/effect-codex-app-server/src/protocol.test.ts
```

### web-lifecycle

Cwd: `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code/apps/web`. Exit 0; 2 files and 32 tests passed. Log: `/tmp/neokod-nightly-audit-2026-10-24/web-lifecycle-tests.log`.

```sh
vp test run --project unit src/components/SubagentsPanel.test.ts src/components/threadLifecycle.logic.test.ts
```

## Reused verification and formal gates

`git diff 14df4db59 HEAD` contains plan/evidence documentation only. A scoped comparison of apps, packages, scripts, package.json, lockfile and Vite config confirms matching source/toolchain for prior required gates. Reuse `composition-final-checks.json`: root `vp check` passed with 0 errors/54 warnings, recursive `vp run typecheck` passed all 10 packages, and affected 4-file/163-test checks passed after the platform correction. `composition-initial-checks.json` provides the initial 20-file/359-server + 5-file/104-web + 2-file/72-shared/contracts tests, 535 combined; unchanged paths are reused instead of repeating the same suite. The 535 and 163 counts overlap and must not be added as unique tests. New 672 results are a separate focused expansion and are not a full-suite claim.

Formal plan 14.2 still requires all criteria on a main build: full checks/suites, fake client approve/reject/cancel/failure/exhaustion/restart, transport and file-boundary runtime probes, dirty-worktree deletion confirmation, real provider/process/server recovery and owner-host/Tailscale/reverse-proxy/throwaway-tracker-to-PR proof. This focused validation does not close it.

W6-C1 contracts/persistence and C2 managed admission/launch/stop remain not implemented and gated behind that formal exit. C3 immutable result/wake/restart requires C2 and one observed live OpenCode child returning durably to the normal parent. C4 feedback, C5 managed-child detail/tree and C6 providers depend on those foundations. There is no executable managed-child lifecycle to exercise for idempotent admission, depth/caps, original-turn/roster pinning, durable wake, stale child answer, parent deletion stop or managed provider parity. Existing native subagent tests must not be used to mark those gates passed. W5 target routing and provider-neutral Symphony roles remain separate gates.

## Concrete temporary live-probe defects and correction

The old attempt requested one no-options question. The installed Codex 0.163.0 binary contains `request_user_input requires non-empty options for every question`, alongside the two-to-three-choice/native Other instruction. The app-server wire contract can carry omitted/null/empty options; that does not mean the model tool can originate them. This supports correcting the fixture requirement, but does not prove that it was the sole reason the old model emitted no tool call. The old no-question run remains a failed acceptance attempt, not an application bug.

The fixture also fed the successful original value from `Effect.timeout` into `Option.match`, which expects an Option. Current vendored Effect documents `timeout` as original-value-or-failure and `timeoutOption` as Some/None. That explains the metadata `sessionId` undefined crash without blaming the production feedback path.

The requested corrected copy is in `live-proof/`, with complete diff and receipts. It targets the clean accepted source; pins codex_default/codex/prepare/gpt-6.1-sol; asks two valid two-option questions; submits one option and one exact custom Other answer; checks exact question IDs independently of order; uses `timeoutOption`; retains same-turn continuation, unrelated hold, persisted answered/delivery-unknown history, no Resume, session identity and isolated-auth/owned-child cleanup. Preparation passed ten assertions with zero blockers. No live call was executed by this agent. No-options support remains contract/test-only. Original fixture and prior failed receipts were preserved.

No failing application regression was reproduced by these 672 focused checks. No production approval, dispatch, tracker update, Git publication, installation, build, deployment or unrelated process signal occurred.
