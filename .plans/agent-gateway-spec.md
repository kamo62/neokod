# neokod Agent Gateway design specification

Status: Round-3 revision applied, addressing the round-2 11-item must-change list; pending round-3 re-review  
Date: 2026-07-24  
Release impact when implemented: Minor

## 1. Overview, goals, and non-goals

### 1.1 Summary

neokod has two separate sub-agent layers. They must not be conflated:

1. **Provider-native sub-agents are the default and remain always available.** Claude Code subagents, Codex collaboration agents, and equivalent provider-owned helpers run inside their provider's own session. neokod observes their existing canonical `task.started`, `task.progress`, and `task.completed` events in the Subagents panel. They never receive or use the Agent Gateway and never call or drive neokod's mutating control plane. Phase 1 does not change this layer.
2. **The Agent Gateway is an explicit opt-in server feature and defaults off.** It is a built-in local MCP surface that lets an agent operate neokod's orchestration system to create and coordinate cross-provider tasks. When the effective `agentGateway.enabled` setting is `false`, the dedicated gateway MCP listener is not started, no gateway MCP server is injected into any provider session, and none of the seven gateway tools exist.

Enabling the Agent Gateway is a deliberate, reversible choice. In Phase 1 the setting is restart-required so provider sessions cannot retain a partially changed MCP configuration: set it to `true` and restart to enable it; set it to `false` and restart to remove it. Enabling it also means knowingly accepting the advisory trust posture and residual orchestration-sprawl risk described in §6.

When the gateway is enabled, the primary story is:

1. A user explicitly enables the Agent Gateway, restarts neokod, and starts a normal thread with one provider and model.
2. The running agent discovers the projects, provider instances, models, permissions, quotas, and concurrency limits available to it.
3. The agent creates one child task or an exact bounded batch of child tasks.
4. Each child becomes a normal neokod thread with an explicit provider instance, model, runtime mode, branch, and isolated git worktree.
5. neokod starts each provider session through the existing provider runtime.
6. The parent agent waits for one or all child tasks and reads their durable transcripts and results.
7. The user sees the child threads in normal thread navigation and sees their lifecycle in the existing Subagents panel.

This design uses the current provider, orchestration, projection, worktree, and `task.*` activity paths. It does not introduce a second task graph, provider runtime, transcript store, or remote control plane. The gateway's project, concurrency, recursion, and quota rules are advisory guardrails applied only to work created through gateway tools; each provider's own sandbox and approval mode remains the real boundary for filesystem, shell, and network actions.

### 1.2 Verified starting point

The current checkout is already close to the required injection architecture:

- `ProviderAdapterShape` defines the provider-neutral session operations, including session start, turn send, interrupt, stop, thread read, and canonical runtime events (`apps/server/src/provider/Services/ProviderAdapter.ts:45-125`).
- A `ProviderDriver` creates isolated provider instances, and each `ProviderInstance` owns its adapter and text-generation runtime (`apps/server/src/provider/ProviderDriver.ts:64-74`, `apps/server/src/provider/ProviderDriver.ts:97-156`).
- The built-in driver set is Codex, Claude, GitHub Copilot, Cursor, Grok, and OpenCode (`apps/server/src/provider/builtInDrivers.ts:23-55`).
- `ProviderService` issues a short-lived MCP credential before it starts a provider adapter and revokes it when the session stops (`apps/server/src/provider/Layers/ProviderService.ts:217-228`, `apps/server/src/provider/Layers/ProviderService.ts:592-601`, `apps/server/src/provider/Layers/ProviderService.ts:829-853`).
- The server already hosts an authenticated MCP endpoint at `/mcp` and registers the preview toolkit on it (`apps/server/src/mcp/McpHttpServer.ts:66-89`, `apps/server/src/mcp/McpHttpServer.ts:198-217`).
- Claude, Codex, Cursor, Grok, and locally spawned OpenCode sessions already receive that endpoint through provider-specific MCP configuration (`apps/server/src/provider/Layers/ClaudeAdapter.ts:3576-3614`, `apps/server/src/provider/Layers/CodexAdapter.ts:1611-1640`, `apps/server/src/provider/Layers/CursorAdapter.ts:534-558`, `apps/server/src/provider/Layers/GrokAdapter.ts:572-596`, `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1057-1072`).
- Copilot already has a fork-owned MCP resolver and passes its result through the SDK `SessionConfigBase.mcpServers` field (`apps/server/src/provider/copilot/CopilotMcpServers.ts:33-92`, `apps/server/src/provider/copilot/CopilotAdapter.ts:787-818`). It currently resolves organization presets, AI-Orch, and user settings. It does not consume the built-in per-thread neokod MCP session.

The first implementation should extend this foundation. Replacing it with a separate daemon or plugin system would duplicate working code.

### 1.3 Goals

- Let one agent fan out an exact, bounded set of real neokod tasks across explicit provider instances and models.
- Make every delegated task a first-class neokod thread with durable messages, activities, checkpoints, provider session state, and an isolated worktree.
- Preserve provenance from the child thread back to the creating thread, turn, provider instance, model, and gateway operation.
- Reuse canonical `task.started`, `task.progress`, and `task.completed` activity so the existing Subagents panel receives gateway-created task status and usage.
- Make creation retry-safe across MCP retries, provider restarts, and server crashes.
- Keep reads and waits durable by using orchestration projections rather than live adapter memory.
- Apply project, provider, model, runtime, recursion, rate, and concurrency guardrails at the gateway layer, while documenting that the shared loopback dispatch endpoint can bypass them.
- Keep the MCP transport local to the neokod process boundary and provider child processes.
- Stamp gateway provenance from trusted server context so gateway-created work is attributable in the existing Subagents surface.
- Add tools in small phases. Phase 1 contains exactly seven tools: context, catalog, single create, batch create, terminal wait, interrupt, and result read.

### 1.4 Non-goals

- No hosted, remote, mobile, or public Agent Gateway.
- No T3 Connect or other remote session transport.
- No change to provider-native sub-agents. They remain provider-owned, default-on, and observation-only from neokod's perspective.
- No gateway listener, gateway injection, or gateway tool registration while `agentGateway.enabled` is off.
- No separate scheduler, workflow language, DAG engine, or agent framework.
- No attempt to normalize every provider-native subagent feature.
- No automatic merge, commit, push, pull request, or branch integration.
- No automatic approval of child-provider permission or user-input requests.
- No project setup-script execution from gateway task creation. `runSetupScript` is outside Phase 1 because the existing path launches the configured project command in a host terminal.
- No arbitrary filesystem path supplied by an MCP caller.
- No provider selection by vague labels such as "best model." The caller must use provider instance and model identifiers returned by the catalog tool.
- No 23-tool surface in the first release.
- No gateway-specific UI redesign in Phase 1. Existing thread navigation and `task.*` Subagents rendering are the initial visibility surfaces.
- No automation scheduler in the gateway. Automation tools arrive only after neokod has a durable local automation substrate.
- No authentication retrofit on the shared HTTP or WebSocket orchestration control plane. Authenticating the local mutating control plane is possible future hardening, not Phase 1.
- No claim that gateway caps are a system security boundary. They are advisory controls for gateway-created work only.

## 2. Architecture

### 2.1 End-to-end flow

```text
Parent provider session
  -> agentGateway.enabled? (default false)
       off -> no gateway listener, injection, or tools
       on  -> injected "neokod-agent-gateway" MCP endpoint and scoped bearer
  -> Agent Gateway MCP handler
  -> advisory capability and quota check
  -> atomic durable operation and task reservation
  -> trusted gateway dispatch context
       -> thread.create
       -> GitWorkflowService.createWorktree
       -> thread.meta.update
       -> thread.turn.start
  -> ProviderCommandReactor
  -> ProviderService
  -> selected child provider adapter
  -> provider-send acceptance pins one concrete turn ID
  -> canonical ProviderRuntimeEvent ingestion
  -> child thread projection and parent task.* activities
  -> thread list, Subagents panel, wait, and read tools
```

The gateway handler calls server services directly. It does not make a WebSocket or HTTP loopback call back into neokod. Provider-native sub-agents stay on their existing adapter → `ProviderRuntimeIngestion` → `task.*` path and do not traverse any gateway component.

The Agent Gateway is not an enforcement wrapper around neokod's shared control plane. `apps/server/src/orchestration/http.ts` continues to normalize a dispatch payload and call `OrchestrationEngineService.dispatch` directly after `WslBearerAuth`; the gateway neither replaces nor authenticates that route.

### 2.2 MCP server placement

Add a dedicated, conditionally constructed Agent Gateway MCP server. Keep the existing preview MCP server and `/mcp` route in `apps/server/src/mcp/McpHttpServer.ts` unchanged.

- `apps/server/src/mcp/toolkits/agentGateway/tools.ts` contains Effect MCP tool schemas, descriptions, annotations, and bounded input/output schemas.
- `apps/server/src/mcp/toolkits/agentGateway/handlers.ts` resolves the invocation scope, requires the relevant capability, and calls the gateway service.
- `apps/server/src/mcp/AgentGateway.ts` owns operation creation, policy checks, reconciliation, waiting, transcript reads, and the scoped lifecycle worker.
- `apps/server/src/mcp/AgentGatewayMcpHttpServer.ts` owns the gateway-only `McpServer`, its loopback listener, peer guard, and `/mcp` transport.
- `apps/server/src/mcp/AgentGatewaySessionRegistry.ts` reuses the hashed, provider-scoped bearer pattern from `McpSessionRegistry` but issues credentials only while the gateway is enabled.

The current preview handlers already enforce capabilities through `requireMcpCapability` (`apps/server/src/mcp/toolkits/preview/handlers.ts:16-35`). The gateway should use that same invocation-context pattern.

At effective `enabled: false`, none of the three gateway layers above are constructed, no gateway tools are registered, and `ProviderService` has no gateway MCP config to inject. Do not register dormant tools that merely return "disabled."

### 2.3 Local transport boundary

The current preview MCP route is merged into the main HTTP route layer (`apps/server/src/server.ts:318-331`). The normal server binds `127.0.0.1`; the private WSL bearer transport may bind `0.0.0.0` (`apps/server/src/config.ts:64-74`, `apps/server/src/config.ts:185-190`). `McpSessionRegistry` rewrites a wildcard listener address to a loopback URL for child providers, although that rewrite does not prevent a remote peer from reaching the route on the wildcard listener (`apps/server/src/mcp/McpSessionRegistry.ts:63-88`).

Phase 1 leaves that preview path alone and gives the Agent Gateway its own HTTP listener. Two independent loopback checks are mandatory:

1. **Listener binding:** create the gateway listener with host exactly `127.0.0.1` and an OS-assigned port. Read the actual bound address for issued provider configs. Fail startup when the gateway is enabled and the listener cannot bind or reports a non-loopback address.
2. **Peer guard:** before bearer resolution, read `HttpServerRequest.remoteAddress` and accept only `127.0.0.1`, `::1`, or IPv4-mapped loopback. Reject a missing or non-loopback peer.

Both checks ship. There is no fallback from the dedicated listener to the shared listener and no fallback from the peer guard to bearer-only authentication. If Effect's HTTP layers cannot host the second listener, Phase 1 is blocked until that is solved; it must not silently expose the gateway on the WSL wildcard listener.

One stdio MCP process per provider session is an alternative. It adds process lifecycle and a second IPC protocol back to the server, so Phase 1 should keep the existing authenticated loopback HTTP model.

### 2.4 Session-scoped injection

`ProviderService` is the common injection lifecycle seam. It currently issues the preview credential before `adapter.startSession`, stores the MCP config in the per-thread `McpProviderSession` map, and clears it on failure or stop (`apps/server/src/provider/Layers/ProviderService.ts:217-228`, `apps/server/src/provider/Layers/ProviderService.ts:592-601`).

Extend the provider-session configuration with an optional, separately named `neokod-agent-gateway` entry. `ProviderService` requests and injects that entry only when the effective server setting is enabled. The existing `neokod` preview entry remains independent. Keep the raw gateway bearer in memory; follow `McpSessionRegistry`, which stores only a SHA-256 token hash (`apps/server/src/mcp/McpSessionRegistry.ts:90-103`, `apps/server/src/mcp/McpSessionRegistry.ts:105-137`).

The injected Authorization header is static for several providers. Silent idle expiry would leave a live provider session unable to call the gateway. Phase 1 binds gateway credential validity to the provider session lifecycle:

- Revoke immediately on stop, replacement, thread deletion, or server shutdown.
- Do not idle-expire a credential while its provider session remains active.
- Prune orphaned credentials whose provider session mapping is gone.
- Keep an absolute lifetime only when neokod can restart or reload the provider session before expiry.

Provider-specific adapters should continue translating a named built-in MCP config map into their native configuration shapes. Their shapes differ enough that a single generic SDK object would add fragile abstraction. The map is keyed by server name and always contains the `neokod` preview entry; it contains the `neokod-agent-gateway` entry only when the gateway is enabled and injected for that provider:

- Claude receives `queryOptions.mcpServers.neokod` and, when enabled, `queryOptions.mcpServers["neokod-agent-gateway"]`.
- Codex receives app-server `mcp_servers.neokod` and, when enabled, `mcp_servers["neokod-agent-gateway"]`, each with an environment variable carrying its own bearer.
- Copilot receives `SessionConfigBase.mcpServers.neokod` and, when enabled, `SessionConfigBase.mcpServers["neokod-agent-gateway"]`.
- Cursor and Grok receive one ACP HTTP MCP descriptor per entry (the gateway descriptor is deferred from Phase 1 per §7.4).
- Local OpenCode receives one `client.mcp.add` call per entry.

The existing preview server name remains `neokod`. The conditional gateway server name is reserved as `neokod-agent-gateway`. User settings and organization presets cannot replace either built-in entry.

### 2.5 Claude configuration isolation

Claude instance isolation does not block gateway injection. neokod sets `CLAUDE_CONFIG_DIR` for a configured Claude home while leaving `HOME` intact (`apps/server/src/provider/Drivers/ClaudeHome.ts:17-34`). The change is recorded in release 3.0.17 (`CHANGELOG.md:93-101`).

When enabled, the gateway entry is supplied programmatically through `ClaudeQueryOptions.mcpServers` after the isolated environment is built (`apps/server/src/provider/Layers/ClaudeAdapter.ts:3576-3614`). It does not depend on the user's global Claude plugins, global MCP files, or contents of `CLAUDE_CONFIG_DIR`. When disabled, that entry is absent.

### 2.6 Shared orchestration dispatcher

The current `thread.turn.start` bootstrap implementation lives inside the WebSocket server. It creates a thread, creates a worktree, can run the setup script, and dispatches the final turn start (`apps/server/src/ws.ts:497-701`). The HTTP orchestration dispatch path separately calls `OrchestrationEngineService.dispatch` directly after `WslBearerAuth` (`apps/server/src/orchestration/http.ts:72-87`).

Extract the reusable create-thread and prepare-worktree portion into a server-side `OrchestrationCommandDispatcher` used by:

- WebSocket `orchestration.dispatchCommand`
- Agent Gateway task creation

Do not route the HTTP orchestration dispatch endpoint through the extracted bootstrap dispatcher and do not add Agent Gateway auth or policy to it. Its existing direct dispatch behavior is part of neokod's local-first first-party control plane.

The dispatcher owns normalization-independent command execution. It delegates domain decisions and persistence to `OrchestrationEngineService` and worktree operations to `GitWorkflowService`. The gateway entry point supplies an internal trusted dispatch context containing the reserved operation/task identifiers and server-derived origin. That context is not part of `ClientOrchestrationCommand`, is not accepted from HTTP or WebSocket payloads, and is not inferred from `commandId`.

The WebSocket path keeps its existing setup-script behavior. The gateway path has no `runSetupScript` option and never calls `ProjectSetupScriptRunner`; it performs only thread creation, worktree preparation, metadata update, and turn dispatch. This is necessary because `ProjectSetupScriptRunner.runForThread` opens a host terminal and writes the configured project command to it (`apps/server/src/project/ProjectSetupScriptRunner.ts:127-164`).

The final `thread.turn.start` event is already consumed by `ProviderCommandReactor`, which resolves the child thread, ensures the selected provider session, and calls `ProviderService.sendTurn` (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:747-850`). This preserves the normal one-session-per-thread behavior.

### 2.7 First-class child tasks

Each gateway task has two linked representations:

1. A child orchestration thread is the durable execution record.
2. A `task.*` lifecycle in the parent thread is the compact delegation view.

The child thread is created through the existing `thread.create` and `thread.turn.start` contracts (`packages/contracts/src/orchestration.ts:518-532`, `packages/contracts/src/orchestration.ts:607-626`). Its `thread.created` event reaches the shell projection, which emits normal `thread-upserted` events used by thread navigation (`packages/contracts/src/orchestration.ts:425-447`).

The parent receives:

- `task.started` when the operation has reserved the child identifiers.
- `task.progress` for launch stages and selected child progress or usage.
- `task.completed` when the child settles as completed, failed, or stopped.

Provider runtime task payloads and their current projection mapping live in `packages/contracts/src/providerRuntime.ts:464-493` and `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:445-522`. `deriveSubagentCards` already groups those activities by `taskId` and reads model, type, agent, progress, usage, and result (`apps/web/src/session-logic.ts:733-822`). `SubagentsPanel` consumes that derivation directly. Provider-native events continue through this path unchanged; gateway lifecycle events join only at the shared activity-mapping boundary.

Extract the task-event-to-activity mapping into a small server helper, for example `apps/server/src/orchestration/taskActivity.ts`. `ProviderRuntimeIngestion` and `AgentGateway` must both call it. This prevents payload drift such as `detail` versus `description`.

Gateway progress should stay low volume:

- One progress event for worktree preparation.
- One for provider turn acceptance.
- Coalesced usage or summary updates when available.
- One terminal event.

The child thread remains the full event and transcript source.

### 2.8 Provenance

Every gateway-created child thread stores structured origin data:

- origin kind: `agent-gateway`
- gateway operation ID
- operation item key
- root thread ID
- parent thread ID
- creating turn ID, when a running turn is present
- creating provider instance ID
- creating parent model
- delegation depth
- creation timestamp

The origin is stamped from trusted server state: `McpInvocationContext`, the atomically reserved gateway operation/task rows, and the selected target. The MCP caller supplies task content and exact catalog IDs, but it cannot supply or override `origin`, actor kind, root/parent thread IDs, creating provider instance, or delegation depth.

The trusted gateway dispatch context carries provenance into the `thread.created` event and its projection. It also supplies an explicit `agent-gateway` actor override to event persistence. Do not infer actor kind from a `gateway:` command prefix and do not add caller-decodable origin fields to `ThreadCreateCommand` or `ThreadTurnStartBootstrapCreateThread`.

The UI can render this later as "Created by Claude Opus in Thread A" or an equivalent label. Phase 1 requires the data to be present in thread detail/shell projections and the linked `task.*` activity so work is attributable in the existing Subagents panel.

The bearer token and authorization header never enter provenance, events, tool results, or logs.

## 3. Phased tool surface

### 3.1 Naming and common behavior

Use the `neokod_` prefix. MCP clients often combine tools from several servers, so globally readable names help the agent choose correctly.

All seven tools exist only while the Agent Gateway is enabled. They return structured content and a short text rendering. Validation, gateway-scope rejection, idempotency conflicts, and missing resources return stable error codes. A child task failure is data in a successful tool result.

Every tool that addresses a task by ID (wait, read, interrupt) authorizes each `taskId` against the caller's own root delegation tree. A taskId outside that tree is rejected as unauthorized rather than acted on, so one delegation subtree cannot wait on, read, or interrupt another subtree's tasks.

Tool annotations:

- Discovery, catalog, wait, and read: `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`.
- Create and batch create: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`.
- Interrupt: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`.

### 3.2 MVP tool 1: `neokod_gateway_context`

Purpose: Tell the caller who it is, where it is running, and what the gateway permits.

Inputs:

- None.

Outputs:

- Gateway version.
- Environment ID.
- Caller thread ID, title, project ID, model selection, runtime mode, branch, and worktree presence.
- Caller provider instance ID.
- Active creating turn ID when available.
- Root thread ID and delegation depth.
- Capability names.
- Allowed project IDs.
- Allowed provider instance IDs and optional model restrictions.
- Maximum child runtime mode.
- Batch, active-task, rate, and recursion limits.
- Current active task count under the root delegation tree.

Existing source it wraps:

- `ProjectionSnapshotQuery.getThreadDetailSnapshot`, the same durable source used by the thread snapshot HTTP route and initial `orchestration.subscribeThread` frame (`apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:156-170`, `apps/server/src/orchestration/http.ts:55-70`).
- `McpInvocationContext`, which already carries environment, thread, provider session, provider instance, capabilities, and credential lifetime (`apps/server/src/mcp/McpInvocationContext.ts:10-20`).

### 3.3 MVP tool 2: `neokod_catalog_list`

Purpose: Return exact allowed projects, provider instances, models, readiness, quota information, and optional base refs needed for task creation.

Inputs:

- `projectId?: ProjectId`: limit ref discovery to one allowed project.
- `includeRefs?: boolean`: default `false`.
- `refQuery?: string`: optional bounded filter when refs are included.
- `refLimit?: number`: default `20`, maximum `100`.

Outputs:

- Allowed projects with ID, title, repository state, and default model selection.
- Provider instances with `instanceId`, driver, display name, enabled, installed, auth state, availability, models, and known usage windows.
- Agent Gateway caller support for each provider.
- Refs for the selected project when requested.
- Structured warnings for unavailable providers or known exhausted quota buckets.

Existing source it wraps:

- The shell snapshot used by `orchestration.subscribeShell`.
- `ProviderRegistry.getProviders`, whose snapshots are keyed by provider `instanceId` and include models and usage (`apps/server/src/provider/Services/ProviderRegistry.ts:22-29`, `packages/contracts/src/server.ts:155-209`).
- The same data assembled by `server.getConfig` (`apps/server/src/ws.ts:1056-1065`).
- `vcs.listRefs` through `GitWorkflowService.listRefs` (`packages/contracts/src/rpc.ts:162-164`, `apps/server/src/git/GitWorkflowService.ts:292-301`).

### 3.4 MVP tool 3: `neokod_task_create`

Purpose: Create one first-class child thread, isolated worktree, and initial provider turn.

Inputs:

- `operationKey: string`: required, 1 to 128 characters, stable across retries.
- `projectId: ProjectId`: must be in the invocation scope.
- `itemKey?: string`: defaults to `task`; 1 to 64 characters.
- `title: string`: 1 to 160 characters.
- `prompt: string`: uses the existing provider turn input limit.
- `target.providerInstanceId: ProviderInstanceId`: exact routing key.
- `target.model: string`: exact model slug returned by the catalog.
- `target.options?: ProviderOptionSelections`: validated against the target model descriptors.
- `baseRef: string`: exact ref returned by the catalog.
- `startFromOrigin?: boolean`: default `false`, allowed only when the capability policy permits networked git fetch.
- `runtimeMode?: RuntimeMode`: default `approval-required`; a value above the effective ceiling (§6.5, `min(parent runtime mode, configured maximum)`) is rejected, not clamped.
- `interactionMode?: "default" | "plan"`: default `default`.

The input never accepts `cwd`, `workspaceRoot`, `worktreePath`, an executable, environment variables, credentials, or a setup-script flag. Gateway task creation never runs `ProjectSetupScriptRunner`.

Outputs:

- Operation ID and operation state.
- Task ID.
- Child thread ID.
- Project ID.
- Provider instance ID and model.
- Runtime mode.
- Branch.
- Worktree path in trusted local output.
- Launch state: `sending`, `accepted`, `launch_failed`, or `launch_unknown`. `recovered` is not a launch state; a reconciled task being replayed reports it through the idempotency field below.
- Pinned accepted turn ID when launch state is `accepted`.
- Idempotency state: `created`, `replayed`, or `recovered`.
- Structured launch failure when applicable.

Existing command it wraps:

- `thread.turn.start` with `bootstrap.createThread` and `bootstrap.prepareWorktree` only (`packages/contracts/src/orchestration.ts:581-626`).
- The extracted create-thread/worktree portion of the current WebSocket bootstrap flow (`apps/server/src/ws.ts:497-701`).

The tool returns when the provider has returned a concrete `ProviderTurnStartResult` (`accepted`), launch has definitively failed (`launch_failed`), the launch outcome has become unknown (`launch_unknown`), or the bounded launch-observation budget elapsed while the send is still in flight (`sending`). An orchestration command receipt alone is not success. A retry with the same `operationKey` while a task is still `sending` re-attaches to the same launch rendezvous and never re-dispatches the turn. The tool does not wait for task completion.

### 3.5 MVP tool 4: `neokod_task_create_batch`

Purpose: Create an exact bounded set of tasks and launch them concurrently.

Inputs:

- `operationKey: string`: required and stable across retries.
- `tasks: TaskCreateItem[]`: 1 to the scoped batch limit, default maximum `4`.
- Every item contains a unique `itemKey` and the task fields required by `neokod_task_create`; the batch-level `operationKey` is not repeated per item.

Outputs:

- Operation ID.
- Canonical request hash.
- Aggregate state: `running`, `partial`, `failed`, or `replayed`.
- One result per input item in input order.
- Per-item task ID, child thread ID, launch state, and structured error.

Existing command it wraps:

- The same `thread.turn.start` bootstrap path as single creation.

Batch semantics:

- The submitted list is the complete batch manifest.
- A retry with the same owner and `operationKey` must have the same canonical request hash.
- A changed manifest returns `operation_key_conflict`.
- Items launch through one bounded pool. The batch launch concurrency is `min(batch size, remaining active-task headroom under the root, a fixed Phase 1 ceiling of 4)`, so a batch never exceeds the active-task reservation it already holds and never floods provider startup. Further items start as slots free.
- Each item is independently durable.
- One item failing does not cancel or delete successful siblings.
- The response preserves input order even when launches finish out of order.

### 3.6 MVP tool 5: `neokod_task_wait`

Purpose: Wait for one task or a set of tasks without polling raw provider processes.

Inputs:

- `taskIds: TaskId[]`: 1 to the scoped maximum.
- `mode?: "all" | "any"`: default `all`.
- `timeoutMs?: number`: default `60000`, minimum `0`, maximum `120000`.

Outputs:

- `conditionMet: boolean`.
- `timedOut: boolean`.
- Current state for every requested task.
- IDs of tasks that satisfied the requested condition.
- Terminal status, completion timestamp, summary, usage, child thread ID, and pinned turn state when available.
- `retryAfterMs` suggestion when still running.

Existing stream and projection it wraps:

- The pinned accepted turn ID in the durable gateway task row.
- The persisted child thread snapshot and `OrchestrationEngineService.streamDomainEvents` used by `orchestration.subscribeThread`.
- One gateway wait coordinator subscribes once, coalesces task-state notifications, and makes every multi-task waiter attach to its signal before rereading durable task state, matching the snapshot-after-subscribe lost-wakeup protection in `apps/server/src/ws.ts:967-1052`.

Semantics:

- Phase 1 supports terminal completion only. The pinned accepted turn is terminal when its durable projection is completed, interrupted, cancelled, or failed.
- "Settled" is not exposed because the current event flow has no durable quiescence barrier proving that all assistant/checkpoint writes after terminal status have landed. Add it only with a real persisted quiescence signal.
- Timeout is a normal successful result. The agent can call wait again.
- Child failure is a terminal task result. It is not an MCP protocol failure.
- Server shutdown interrupts the call. The operation and child tasks remain durable.
- All provider wait calls use the fixed 60-second default and 120-second maximum until conformance data justifies provider-specific ceilings.

The production `RuntimeReceiptBus` cannot be used as the wait source because its live layer intentionally publishes no receipts (`apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts:22-39`). Persisted projection and orchestration events are the authority.

### 3.7 MVP tool 6: `neokod_task_interrupt`

Purpose: Interrupt the provider turn pinned to a gateway-created task.

Inputs:

- `taskId: TaskId`.

Outputs:

- Task ID and child thread ID.
- Pinned accepted turn ID.
- Result: `interrupt_requested`, `already_terminal`, or `not_active`.
- Current durable task state.

Existing command and adapter operation it wraps:

- `thread.turn.interrupt`, whose contract already accepts a thread ID and optional turn ID (`packages/contracts/src/orchestration.ts:647-653`).
- `ProviderCommandReactor.processTurnInterruptRequested`, which routes to `ProviderService.interruptTurn`; the provider-neutral adapter shape already defines `interruptTurn` (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:863-884`, `apps/server/src/provider/Services/ProviderAdapter.ts:66-69`).

Semantics:

- Resolve the child thread and pinned accepted turn from the server-side task row; accept neither from the caller.
- Carry the pinned turn as `expectedActiveTurnId` on the interrupt command. Because orchestration turn IDs are not provider turn IDs, the reactor interrupts by session today (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:882-883`), so a projection pre-check alone leaves a race: a human turn starting between the check and the session interrupt would be killed. Instead, recheck `expectedActiveTurnId` as an atomic invariant at the adapter boundary, under a per-thread lock that also serializes turn starts. Read the session's current active turn inside the lock; if it no longer equals `expectedActiveTurnId`, release without interrupting and return `not_active`. Only a match proceeds to `interruptTurn`.
- This guard lives in neokod's adapter boundary, not the provider, because provider interrupt semantics differ: Copilot ignores turn IDs and Claude interrupts on mismatch, so neither can be trusted to spare a newer human turn on its own.
- Use one deterministic interrupt command ID per task. Repeated calls replay the same command receipt or return `already_terminal`.
- A `launch_unknown` task has no safely pinned turn and is not interrupted automatically; return `not_active` with the launch state.
- Test the human-turn race explicitly: a human turn that starts after the projection check but before the lock must survive, and the interrupt must report `not_active`.

### 3.8 MVP tool 7: `neokod_task_read`

Purpose: Read a bounded durable transcript and result for a gateway-created task.

Inputs:

- `taskId: TaskId`.
- `afterMessageId?: MessageId`.
- `limit?: number`: default `50`, maximum `100`.
- `includeSystemMessages?: boolean`: default `false`.

Outputs:

- Task and provenance metadata.
- Child thread ID, project, provider instance, model, branch, and terminal state.
- Ordered message records with ID, role, text, turn ID, streaming state, and timestamps.
- Attachment metadata without inline image data.
- Final result text from the terminal assistant message for the pinned accepted turn when present.
- `resultAvailable: boolean` and a bounded `retryAfterMs` suggestion when the pinned turn is terminal but its assistant/checkpoint projection has not arrived yet.
- Completion summary and usage.
- `nextAfterMessageId` when more messages exist.

Read query:

- Do not wrap `ProjectionSnapshotQuery.getThreadDetailSnapshot` (`apps/server/src/orchestration/http.ts:55-70`). It targets active threads and materializes an unbounded snapshot, so it breaks for an archived child and does not paginate, and gateway-created children can be archived while their durable transcript is still wanted.
- Use a dedicated read that queries the persisted projection tables directly, includes archived threads, filters to the pinned accepted turn ID in SQL, and paginates in SQL by `afterMessageId` and `limit`. It never materializes the whole transcript to slice it in memory.
- The initial snapshot shape of `orchestration.subscribeThread` remains the reference for the record fields (`packages/contracts/src/rpc.ts:640-648`).

The read filters by the task row's pinned accepted turn ID and never uses "latest turn" as the result selector, so a later human turn cannot change the completed gateway task's result. Because Phase 1 wait is terminal-only, read may temporarily return `resultAvailable: false`; the caller may retry without treating that as task failure. It does not call `ProviderAdapterShape.readThread`, because adapter memory is less durable and provider-specific.

### 3.9 Later tool set

Phase 2 may add:

- `neokod_task_stop`: wraps `thread.session.stop`.
- `neokod_task_queue_turn`: durably queues a new `thread.turn.start` after the active child turn settles.
- `neokod_task_steer`: sends provider-supported in-turn guidance only when adapter capabilities define exact semantics.
- `neokod_task_activity_list`: returns bounded canonical child activities.
- `neokod_task_events_list`: returns bounded orchestration or provider-runtime events with redaction.
- `neokod_gateway_diagnostics`: synthesizes operation phase, child session state, provider readiness, known quota, latest activity, checkpoint state, and cleanup warnings.
- `neokod_task_rename`: wraps `thread.meta.update`.
- `neokod_task_archive`: wraps `thread.archive`.

Phase 3 may add:

- Local automation create, list, pause, run, and delete tools after a durable automation substrate exists.
- Provider-neutral external MCP list, add, update, test, enable, disable, and remove tools.
- Secret references for external MCP credentials through `ServerSecretStore`.

Phase 2 must keep queue and steer separate. The current provider-neutral contract has a durable next-turn command and an interrupt command. It does not define a universal in-turn steering operation.

## 4. Data model and contract changes

### 4.1 New schema-only gateway contracts

Add `packages/contracts/src/agentGateway.ts` and export it from the contracts package. It should contain:

- `AgentGatewayOperationId`
- `AgentGatewayTaskId`
- `AgentGatewayOperationKey`
- `AgentGatewayTaskOrigin`
- `AgentGatewayTaskReference`
- `AgentGatewayTaskState`
- `AgentGatewayOperationState`
- MVP tool input and output schemas
- Stable gateway error code literals

Keep execution logic out of `packages/contracts`.

### 4.2 Thread origin

Extend these persisted/projection contracts with optional `origin: AgentGatewayTaskOrigin`:

- `ThreadCreatedPayload`
- `OrchestrationThread`
- `OrchestrationThreadShell`

Do not add `origin` to `ThreadCreateCommand`, `ClientThreadTurnStartCommand`, or `ThreadTurnStartBootstrapCreateThread`. Those are client-decodable command shapes (`packages/contracts/src/orchestration.ts:518-532`, `packages/contracts/src/orchestration.ts:581-645`). The engine enriches the `thread.created` event from the internal trusted gateway dispatch context after command decoding.

Persist `origin_json` on `projection_threads`. Update:

- `apps/server/src/persistence/Services/ProjectionThreads.ts`
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- the next additive migration under `apps/server/src/persistence/Migrations/`
- `apps/server/src/persistence/Migrations.ts`

Older threads decode with no origin.

### 4.3 Task lifecycle link

Extend the three canonical provider-runtime task payloads with optional fields:

- `childThreadId`
- `origin`
- `providerInstanceId` for the child target when it differs from the emitting parent

The fields are optional so existing provider emitters and fixtures remain valid (`packages/contracts/src/providerRuntime.ts:464-493`).

The gateway emits parent orchestration activities through the shared task activity mapper. It does not need to impersonate a provider runtime event. The optional canonical fields keep provider-native and gateway task links compatible at the projection boundary.

### 4.4 Event actor and metadata

Extend `OrchestrationActorKind` with `agent-gateway`. Actor inference currently recognizes caller-controlled `provider:` and `server:` command prefixes, then falls back to `client` (`apps/server/src/persistence/Layers/OrchestrationEventStore.ts:70-90`). Do not add a `gateway:` prefix branch.

Add optional fields to `OrchestrationEventMetadata`:

- `agentGatewayOperationId`
- `agentGatewayTaskId`
- `agentGatewayParentThreadId`

The current metadata schema contains provider turn, provider item, adapter, request, and ingestion identifiers (`packages/contracts/src/orchestration.ts:1010-1029`).

Add an internal-only `OrchestrationDispatchContext` parameter to `OrchestrationEngineService.dispatch`. It is carried in the in-process command envelope, never added to `OrchestrationCommand`, and is populated only by `AgentGateway` after it has loaded the reserved operation/task and `McpInvocationContext`. The engine uses it to:

- pass an explicit trusted actor override to `OrchestrationEventStore.append`;
- add gateway metadata to child creation, metadata update, turn start, and parent lifecycle events; and
- enrich the origin on both `thread.created` and any `thread.upserted` projection of the child before projection, so a re-emitted or upserted child thread keeps its gateway origin rather than reverting to `client`.

`OrchestrationEventStore.append` accepts that optional trusted actor override from the in-process engine. HTTP and WebSocket dispatch never receive the override. Deterministic command IDs remain deduplication keys only and are never authority or provenance.

### 4.5 Provider catalog capability

Add an optional Agent Gateway caller capability to `ServerProvider`:

```ts
agentGateway: {
  callerSupport: "supported" | "experimental" | "unsupported"
  reason?: string
}
```

This describes whether an agent running under that provider can call the injected gateway. It does not control whether the provider may be selected as a child target. Target readiness continues to use the existing enabled, installed, availability, auth, models, and usage fields (`packages/contracts/src/server.ts:171-208`).

### 4.6 Capability policy

Extend `McpCapability` beyond the current `preview` literal (`apps/server/src/mcp/McpInvocationContext.ts:10-20`):

- `gateway.discover`
- `gateway.read`
- `gateway.wait`
- `gateway.create`
- `gateway.control`

Add an immutable `agentGatewayPolicy` to `McpInvocationScope`:

- allowed project IDs
- allowed provider instance IDs
- optional per-provider model allowlists
- execution access level
- maximum child runtime mode
- allow remote git fetch
- maximum batch size
- maximum active tasks under the root
- maximum task creates per minute
- maximum delegation depth
- root thread ID
- current delegation depth

The gateway registry calculates this policy when it issues the credential. The handler checks it again against current project and provider state. If the server-stamped origin lookup for a child fails or is ambiguous, the issued policy fails closed to observe-only (`gateway.discover`, `gateway.read`, `gateway.wait`) and never receives `gateway.create`. These checks are mandatory for gateway calls but remain advisory at the product trust boundary because the shared loopback dispatch route does not consume this policy.

### 4.7 Server settings

Add an `agentGateway` object to `ServerSettings` and `ServerSettingsPatch` in `packages/contracts/src/settings.ts`, beside the existing server-authoritative settings (`packages/contracts/src/settings.ts:520-567`, `packages/contracts/src/settings.ts:672-702`).

This object governs only the cross-provider Agent Gateway. It does not enable, disable, configure, or authorize provider-native sub-agents; those remain available through their provider sessions and existing `task.*` observation path regardless of this setting.

Phase 1 settings:

- `enabled`
- `allowTaskCreation`
- `allowedProjectIds`, where an empty list means current project only
- `allowedProviderInstanceIds`, where an empty list means all ready local instances
- `defaultExecutionAccess`
- `maximumChildRuntimeMode`
- `allowRemoteGitFetch`
- `maximumBatchSize`
- `maximumActiveTasks`
- `maximumCreatesPerMinute`
- `maximumDelegationDepth`

Recommended defaults:

- `enabled: false`: no gateway listener, injection, credentials, or tools.
- `allowTaskCreation: false`: after enabling the gateway, creation still requires an explicit user opt-in. All seven Phase 1 tools remain in the enabled server's schema, but create handlers return `gateway_task_creation_disabled` unless the issued scope has `gateway.create`.
- Current project only.
- Isolated worktree required.
- Child runtime mode `approval-required`.
- Remote git fetch disabled.
- Batch size `4`.
- Active tasks `4` per root delegation tree.
- Create rate `10` tasks per minute per root.
- Delegation depth `1`, so a human-started root can create children and those children cannot create grandchildren.
- Full access disabled.

The setting is server-authoritative and sampled once at server startup in Phase 1. Changing it is reversible but takes effect on restart. Startup reads the effective value before building the gateway listener or issuing provider configs. This produces an exact off state instead of attempting unsafe hot removal from provider SDK sessions that may cache MCP tool definitions.

Because it is restart-scoped, the settings snapshot exposes three distinct values, not one: `configured` (the persisted setting), `effective` (the value the running server sampled at startup and is actually enforcing), and `restartRequired` (true when `configured` differs from `effective`). Clients read `effective` to know what the gateway is doing now and `restartRequired` to prompt a restart, and never assume a saved change is already live.

### 4.8 Durable operation receipt

Add two narrow SQLite tables. `agent_gateway_operations` owns request idempotency; `agent_gateway_tasks` owns one durable row per manifest item, launch state, reservation state, pinned provider turn, and terminal tracking. Orchestration remains the transcript source of truth.

Required columns:

- `operation_id` primary key
- `environment_id`
- `owner_thread_id`
- `owner_provider_instance_id`
- `owner_mcp_session_id`
- `operation_key`
- `kind`, `single` or `batch`
- `request_hash`
- `root_thread_id`
- `delegation_depth`
- `status`
- `manifest_json`
- `created_at`
- `updated_at`
- `completed_at`

Required uniqueness:

```text
(environment_id, owner_thread_id, operation_key)
```

Required `agent_gateway_tasks` columns:

- `task_id` primary key
- `operation_id`
- `item_key`
- `root_thread_id`
- `parent_thread_id`
- `child_thread_id`
- `project_id`
- `provider_instance_id`
- `model_selection_json`
- `branch`
- `intended_worktree_path`
- `launch_state`
- `provider_send_idempotency_key`
- `accepted_turn_id`
- `terminal_state`
- `result_message_id`
- `reservation_active`
- `error_json`
- `created_at`
- `updated_at`
- `completed_at`

Required uniqueness/indexing:

```text
UNIQUE(operation_id, item_key)
UNIQUE(provider_send_idempotency_key)
INDEX(root_thread_id, reservation_active, launch_state)
INDEX(child_thread_id, accepted_turn_id)
```

`manifest_json` is the immutable canonical request/result ordering record. Mutable launch and terminal fields live in task columns so concurrency limits, recovery, wait, and accepted-turn lookup do not depend on rewriting or querying a JSON blob. Full transcripts and provider events stay in orchestration storage.

Add:

- `apps/server/src/persistence/Services/AgentGatewayOperations.ts`
- `apps/server/src/persistence/Layers/AgentGatewayOperations.ts`
- a migration and repository tests

The repository exposes one atomic `reserveOperation` call covering both tables. Because neokod is one local server process, the service serializes reservation with one Effect semaphore and performs the idempotency lookup, active/rate recount, limit check, operation insert, and task-row inserts in one SQL transaction. A concurrent test must prove two different operation keys cannot jointly exceed the active-task limit.

Existing orchestration command receipts remain useful for every stable child command. They deduplicate one orchestration command by `commandId` (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:138-151`, `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts:25-62`). They prove only that neokod persisted the command's domain events; they do not prove that a provider accepted a turn.

## 5. Durability and correctness

### 5.1 Idempotent creation

The ownership key is:

```text
environment ID + owner thread ID + operation key
```

It deliberately excludes the short-lived provider session credential. A restarted provider session in the same parent thread can recover the same operation.

Creation sequence:

1. Resolve the invocation scope and current parent thread.
2. Validate the gateway's advisory project, provider instance, model, quota, runtime ceiling, recursion, and rate rules.
3. Canonicalize the caller-supplied request fields only and calculate SHA-256 over that canonical JSON. Resolve defaults separately for execution; the idempotency hash never includes server-resolved defaults, so a legitimate retry with identical caller input stays stable even when a default changes between calls.
4. Enter the repository's single reservation semaphore.
5. In one SQL transaction, read any existing operation, recount active task rows and rolling-minute creates for the root, validate the incoming task count, and insert the operation plus every task reservation.
6. Release the semaphore only after commit or rollback.
7. If an existing row has a different request hash, return `operation_key_conflict`.
8. If the hash matches, return or reconcile the stored item identifiers without consuming new reservations.
9. Generate stable command IDs from operation ID, item key, and stage.
10. Dispatch child creation stages through the shared dispatcher.
11. Compare-and-set each task phase after every durable stage.

The operation and task rows are committed before worktree creation. A retry cannot reserve a second set of children. Different operation keys cannot jointly pass the active-task limit because the count and inserts share the same process-wide critical section and SQL transaction.

### 5.2 Worktree identity and crash windows

Each item receives, all pinned durably at reservation before any filesystem side effect:

- An immutable base commit SHA resolved from `baseRef` at reservation time, so the worktree is always created from a fixed base even if the ref moves afterward.
- A stable branch name derived from the operation ID and stable item ID, with the sanitized item key used only as a readable suffix, so branch names cannot collide across items or operations.
- A stable intended path under the configured `worktreesDir`.
- The repository identity as the realpath of its git common directory, so the same repository is recognized across its own worktrees and symlinks.
- A stable child thread ID.
- A per-task worktree ownership claim in the durable operation store, shared by live create retries and the reconciliation worker so the two never race to create or remove the same worktree.

Extract the worktree path derivation used by `GitVcsDriverCore.createWorktree` so the dispatcher and VCS driver use one function. The current driver derives the path from `worktreesDir`, repository name, and sanitized branch (`apps/server/src/vcs/GitVcsDriverCore.ts:2260-2269`).

Recovery uses `git worktree list --porcelain` as the source of truth for existing worktrees, not directory presence or `status` alone:

- No registered worktree and branch absent: create the branch at the pinned base SHA and the worktree normally.
- A registered worktree at the intended path on the expected branch and repository: adopt it and continue.
- Branch present and no registered worktree: create a worktree from the existing branch.
- A registered worktree at the intended path with a different repository or branch: mark `worktree_conflict` and stop.
- A directory exists at the intended path but is not a registered worktree: do not crash and do not blindly reuse it. Mark `worktree_conflict` for operator resolution unless the ownership claim proves it is this task's own partially created worktree.
- Thread exists with worktree metadata and launch state before `sending`: resume at final turn dispatch.
- A task in `sending` without a durably pinned provider turn becomes `launch_unknown`; a command receipt does not make it safe to send again.

### 5.3 Provider launch state machine

Each task uses this explicit launch state machine:

```text
reserved
  -> preparing_worktree
  -> ready_to_send
  -> sending
       -> accepted(accepted_turn_id)
       -> launch_failed
       -> launch_unknown
accepted
  -> terminal
```

Rules:

- `reserved`, `preparing_worktree`, and `ready_to_send` are safe to reconcile with deterministic worktree and command IDs.
- Before calling the provider, compare-and-set `ready_to_send -> sending` and persist a stable random `provider_send_idempotency_key`.
- Extend `ThreadTurnStartCommand` / `ThreadTurnStartRequestedPayload` with optional `providerSendIdempotencyKey`, then map it to optional `ProviderSendTurnInput.idempotencyKey`. The gateway always supplies the stable server-generated value; normal human turns may omit it. This is correlation/idempotency data, not provenance or authority.
- `ProviderCommandReactor` already owns the real `ProviderService.sendTurn` call, but today it forks that call with `Effect.forkScoped` and keeps only a failure recovery, discarding the success result (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:840-860`). For a gateway-originated turn this is insufficient: the accepted `turnId` is thrown away, so nothing can deliver it back to the blocking create handler. The reactor must instead capture the `sendTurn` outcome for gateway turns and durably record it against the trusted gateway task row before the fiber completes: `accepted_turn_id` on success, `launch_failed` on a definitive rejection, `launch_unknown` on interruption or an ambiguous post-send error. It forwards the `providerSendIdempotencyKey`; `ProviderService` coalesces duplicate in-process sends by `(threadId, idempotencyKey)` and passes the key to the adapter/native request where supported.
- Provider acceptance occurs only when `ProviderService.sendTurn` returns `ProviderTurnStartResult` with its concrete `turnId` (`packages/contracts/src/provider.ts:67-85`, `apps/server/src/provider/Layers/ProviderService.ts:645-703`). The reactor records `accepted_turn_id` against the trusted gateway task ID, then publishes a launch-coordinator signal, before emitting the parent running lifecycle.
- The blocking create handler never observes the reactor fiber directly. It runs an `AgentGatewayLaunchCoordinator` rendezvous: after committing `sending`, it subscribes to the coordinator signal for the task, then reads the durable task row, so a result landing between the commit and the subscribe is not lost (the same subscribe-before-read ordering as the wait coordinator in §5.6). It waits only up to a bounded launch-observation budget that is strictly shorter than the provider's MCP client-call timeout, then returns the current durable launch state, which may still be `sending`. Conformance tests must confirm each provider's create-call timeout ceiling exceeds this budget.
- The external provider call and SQLite acceptance write cannot be one transaction. If the process dies, the call is interrupted, or the adapter outcome is ambiguous after entering `sending` but before durable acceptance, mark `launch_unknown`. Any post-adapter error whose acceptance status cannot be proven defaults to `launch_unknown`, never `launch_failed`.
- `launch_unknown` is never automatically resent, even when the orchestration command receipt is accepted and even when the idempotency key exists. The key prevents concurrent same-process duplicates and supports native provider dedupe where available; it does not turn an ambiguous cross-process call into proof of acceptance.
- `launch_failed` is reserved for a definitive pre-send failure or a definitive adapter rejection proving no provider turn was accepted.

The pinned `accepted_turn_id` is immutable. Terminal tracking, wait, read, and interrupt address that turn, never the child thread's mutable "latest turn." A later human turn therefore cannot replace the gateway task's result or be interrupted on its behalf.

`reservation_active` is cleared only for a definitive pre-send `launch_failed`, a pinned terminal turn, or explicit child deletion/stop observed through normal orchestration. `sending` and `launch_unknown` continue to count as active because provider acceptance may have occurred.

### 5.4 Crash recovery

`AgentGateway` starts one scoped reconciliation worker with the server:

1. Load operations in non-terminal states.
2. Compare every task row with the child thread projection, command receipts, intended worktree, and current provider session state.
3. Resume only states before `sending`.
4. For a recovered `sending` task, first attempt send-key correlation: query the child session and its durable turns for a turn carrying the task's `provider_send_idempotency_key`. If a matching accepted turn is found, pin it and mark the task `accepted`, reported through the `recovered` idempotency state. Only when no correlation exists does the task become `launch_unknown`. Never resend a `sending` or `launch_unknown` task.
5. Preserve `accepted` only when `accepted_turn_id` is already durable.
6. Rebuild missing parent `task.*` lifecycle activities with stable activity and command IDs.
7. Reread each pinned turn's durable historical projection and close operations whose pinned turns are already terminal, covering a terminal that landed before the crash or before the pin was registered.

A `launch_unknown` task keeps its active reservation with no TTL. The reservation is cleared only after a confirmed provider session stop with no active binding, observed through normal orchestration; elapsed time alone never clears it, because an ambiguous send may still have been accepted.

The worker uses the same drainable worker pattern as provider ingestion and deletion reactors. It remains one local worker. No separate scheduler process is required.

### 5.5 Parent lifecycle projection

Parent activity IDs and command IDs are deterministic per operation item and lifecycle stage. Reconciliation can append them repeatedly without producing duplicates because `thread.activity.append` flows through command receipts.

The parent task ID and child thread ID are distinct:

- Task ID groups the Subagents card.
- Child thread ID addresses the durable execution thread.

Each lifecycle payload includes both.

### 5.6 Terminal waiting without lost wakeups

Run one `AgentGatewayWaitCoordinator` for the server, not one stream subscription per task or per call. It consumes the orchestration domain stream once, updates the matching durable gateway task row when a pinned turn reaches terminal projection state, and publishes a coalesced version signal.

Close the terminal-before-pin race. When a task is first pinned with `accepted_turn_id`, the coordinator rereads that turn's durable historical projection once before relying on the live stream. The turn can reach terminal state between the provider send and the pin being registered, in which case the live stream has already passed the terminal event and only a post-pin historical reread observes it. Startup reconciliation performs the same reread so a terminal that landed before a crash is not lost.

Each multi-task wait is one coordinator waiter:

1. Validate the full requested task set and register one waiter for that set.
2. Subscribe to the coordinator's version signal.
3. Read all requested task rows in one durable query.
4. Evaluate `any` or `all`.
5. If unsatisfied, await a coalesced signal, reread the full set, and repeat until terminal or timeout.

Registering the signal before the durable read prevents lost wakeups; rereading durable rows after every coalesced signal means dropped duplicate notifications do not lose state. This follows the current subscribe-before-snapshot ordering (`apps/server/src/ws.ts:984-1003`) while avoiding N independent child subscriptions.

Phase 1 marks terminal from the pinned turn's durable projection only. It does not claim "settled": `projector.ts` can apply terminal session state before a later `thread.turn-diff-completed` writes checkpoint/assistant state (`apps/server/src/orchestration/projector.ts:466-503`, `apps/server/src/orchestration/projector.ts:541-613`). A future settled wait requires a persisted quiescence signal covering that ordering.

### 5.7 Partial failures and compensation

Batch items are independent. There is no all-or-nothing rollback.

Before a provider turn is accepted:

- If the gateway created the thread and worktree, it may compensate.
- Atomically compare-and-set only `reserved`, `preparing_worktree`, `ready_to_send`, or definitive `launch_failed` to `compensating`. A task in `sending`, `accepted`, `launch_unknown`, or terminal cannot enter compensation.
- The launch coordinator must acquire the inverse compare-and-set before provider send. Once `compensating` wins, no provider launch may start.
- Verify that the worktree is owned by the operation and is not referenced by another projected thread.
- Immediately before removal, query `ProviderSessionDirectory.getBinding(childThreadId)` and `ProviderService.listSessions()`. If a non-stopped binding, live adapter session, or active turn exists, retain the worktree and mark `cleanup_required`.
- Remove the worktree through `GitWorkflowService.removeWorktree`.
- Delete the child thread only after worktree removal succeeds.
- If removal fails, retain the child thread and worktree reference with a cleanup diagnostic.

After provider send begins:

- Never automatically delete the thread or worktree.
- Treat `launch_unknown` as possibly accepted.
- Retain failed and stopped tasks for audit and recovery.
- Let the user inspect or clean them up explicitly.

The current bootstrap cleanup deletes a newly created thread and does not remove a worktree created before a later failure (`apps/server/src/ws.ts:503-520`, `apps/server/src/ws.ts:692-699`). The current `ThreadDeletionReactor` stops providers and closes terminals without removing worktrees (`apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:39-64`). Gateway compensation must close this gap inside the shared dispatcher.

The web deletion path already checks whether a worktree is shared before offering removal (`apps/web/src/worktreeCleanup.ts:11-33`, `apps/web/src/hooks/useThreadActions.ts:186-211`). Move the pure path-sharing check to `packages/shared/src/worktreeCleanup.ts`, expose it through an explicit shared-package subpath, and use it from both the web action and gateway compensation. The durable state claim plus the live provider-session recheck is the required guard against deleting a worktree a provider is actively using.

### 5.8 Concurrent changes and deletion

- If a user interrupts the pinned child turn, wait returns `stopped` or `interrupted`.
- If a later human turn starts, the task continues to read the pinned turn and `neokod_task_interrupt` refuses to interrupt the newer one.
- If a user archives a child, the current WebSocket archive path also stops its provider session, so archival is effectively terminal for the pinned turn in Phase 1 and wait returns `stopped`. If an archive-without-stop path is added deliberately later, this rule changes with it.
- If a user deletes a child, the gateway marks it `stopped` with `child_deleted`.
- Parent archival revokes the parent MCP credential. Existing children continue as independent threads.
- Parent deletion does not cascade into child deletion.
- A provider or model becoming unavailable after reservation causes only the affected item to fail launch.

## 6. Security and permissions

### 6.1 Advisory trust boundary

The Agent Gateway does not authenticate or wrap neokod's shared mutating control plane.

`apps/server/src/orchestration/http.ts` gates snapshot and dispatch handlers only with `WslBearerAuth.authorizeHttpRequest` before directly calling the projection query or `OrchestrationEngineService.dispatch` (`apps/server/src/orchestration/http.ts:20-87`). `WslBearerAuth.authorizeBearerHeader` is intentionally a pass-through when `config.transport === "loopback"` and requires the desktop-generated bearer only for the WSL transport (`apps/server/src/transport/WslBearerAuth.ts:66-93`). The desktop and first-party local UI rely on that local-first loopback posture.

Adding blanket authentication or a gateway capability check to that shared route would alter normal non-gateway desktop, web, and WSL behavior. That blast radius is an unacceptable Phase 1 cost, so broad route authentication stays out of Phase 1. The one bounded exception is the narrow per-command hardening described below.

The dedicated gateway bearer, invocation scope, and policy checks are real checks on gateway tool calls, but they are not a comprehensive security boundary around neokod. A prompt-injected or rogue agent that its provider sandbox permits to call the raw loopback dispatch endpoint can bypass gateway project, concurrency, recursion, rate, and quota caps.

The residual risk is larger than orchestration sprawl, and describing it as "extra tasks, cost, disk, and UI noise only" would be wrong. The unauthenticated loopback plane accepts every `OrchestrationCommand`, so any local process a provider sandbox permits to reach `POST /api/orchestration/dispatch` or the WebSocket control plane can drive commands well beyond task creation: approval and user-input responses, checkpoint revert, project and thread deletion, session stop, and the WebSocket setup-script execution path.

The sharpest edge is self-approval. `approval-required` is the gateway's own default child safety posture, yet an agent that can reach the raw route can answer its own pending permission requests, and §6.2 names each provider's approval system the real action boundary while that boundary is itself operable through the open plane. This does not grant a task more filesystem, shell, or network authority than its selected provider sandbox already allows for a fresh turn, since every spawned session still runs through `ProviderCommandReactor`, `ProviderService`, and the adapter's runtime-mode mapping. It does let a local caller unblock, revert, delete, and stop existing work without the gateway's own guardrails.

Narrow Phase 1 hardening (recommended). Rather than the full authentication retrofit of the shared dispatch route, which this spec defers, capability-gate only the two commands that turn the open plane from noise into a safety bypass: approval / user-input responses and checkpoint revert. Require, for those specific commands, a credential the child provider process cannot read, so a prompt-injected agent cannot self-approve or silently roll back state through the raw route. Normal desktop, web, and WSL flows already hold that credential, so their behavior is unchanged, and the blast radius is two command handlers rather than the whole route. Broad dispatch-route authentication remains a Phase 2+ cross-product project.

Observability is the compensating control: server-stamped origin, first-class child threads, parent `task.*` cards in the existing Subagents panel, and the Phase 1 interrupt tool let the user attribute, inspect, and stop accepted runaway work. A `launch_unknown` item stays visible and consumes an active reservation until the user stops or deletes its child through the normal thread controls.

Because the entire gateway is opt-in and default-off, enabling it is knowing acceptance of this residual risk. If experience shows that risk is unacceptable, Phase 2+ may authenticate the local mutating control plane as a separate cross-product hardening project. It is explicitly outside Phase 1.

### 6.2 Real action boundary

The real boundary for what a child task can do is the provider's own sandbox and approval system:

- Codex sandbox and approval policy.
- Claude permission mode and approval handling.
- Copilot permission/approval callbacks.
- Equivalent native controls in Cursor, Grok, and OpenCode.

The gateway does not weaken, replace, or auto-approve those controls. It does not provide a shell, filesystem API, network proxy, setup-script runner, or arbitrary working-directory input. Worktree placement is a convenience/isolation guardrail, not a substitute for provider sandboxing. Full-access runtime mode means the user chose to relax the provider boundary.

### 6.3 Gateway access levels

Use three execution access levels:

1. `observe`: context, catalog, wait, and read only.
2. `isolated-worktree`: create tasks only in server-selected worktrees under allowed projects.
3. `full-access`: permit a child runtime mode of `full-access`.

Full access requires an explicit gateway setting and task request. A full-access parent does not automatically grant full-access children.

Git worktrees isolate branches and normal workspace writes. They do not contain a provider running with `danger-full-access`. Gateway context and tool descriptions must state that distinction.

### 6.4 Advisory project, provider, and path guardrails

For tasks created through gateway tools:

- Resolve a project from `projectId` through the orchestration projection.
- Reject projects outside the gateway scope.
- Read `workspaceRoot` from the server projection.
- Resolve and canonicalize the workspace root and worktree target.
- Require worktree targets under configured `worktreesDir`.
- Reject symlink or path traversal escapes.
- Never accept a caller-supplied `cwd` or worktree path.
- Use `GitWorkflowService` for fetch, ref resolution, worktree creation, status, and removal (`apps/server/src/git/GitWorkflowService.ts:292-313`).
- Reject non-git projects for Phase 1 task creation. Discovery and reads remain available.

- Require `ProviderInstanceId` because it is the existing routing key (`packages/contracts/src/orchestration.ts:49-68`).
- Verify the instance is enabled, installed, authenticated, available, and allowed.
- Require a model slug from that instance's current `ServerProvider.models`.
- Validate model options against the model capability descriptors.
- Reject a known exhausted hard quota before creating a worktree.
- Treat absent quota data as unknown, then apply gateway rate and active-task limits.

Copilot quota is a concrete concern. Release 3.1.0 added provider usage windows, and release 3.2.0 added a specific monthly-quota error directing the user to another provider (`CHANGELOG.md:8-21`). The batch result identifies quota failures per item and leaves other providers running.

These are gateway-layer input and sprawl guardrails. They do not apply to commands submitted directly to the shared orchestration endpoint.

### 6.5 Runtime and approval posture

- Default children to `approval-required`.
- Reject any task whose requested runtime mode exceeds the effective ceiling rather than silently clamping it, so a caller asking for more than it may have gets an explicit error, not a quietly downgraded task. The effective ceiling is `min(parent thread runtime mode, configured maximumChildRuntimeMode)`.
- Do not respond automatically to child approval or user-input requests.
- Wait reports `waiting-for-input` when durable pending request state exists.
- A later control capability may let the parent forward a response only after a separate design for actor consent and audit.

The current runtime modes map to provider-specific permission behavior. Claude, for example, maps full access to `bypassPermissions` and enables its dangerous bypass flag (`apps/server/src/provider/Layers/ClaudeAdapter.ts:3566-3593`). The provider permission mode remains the action boundary; the gateway ceiling only prevents gateway tools from requesting a more permissive mode.

### 6.6 Rate, concurrency, cost, and recursion guardrails

Apply these atomically in `reserveOperation` for gateway-created work:

- Maximum batch size.
- Maximum active tasks under one root delegation tree.
- Maximum task creates per rolling minute.
- Optional provider-specific active-task limits.
- Maximum delegation depth.
- Optional model allowlists or denylists.

Recommended Phase 1 limits are four active tasks, four tasks per batch, ten creates per minute, and depth one.

When the gateway is enabled, a gateway-created child may receive a scoped gateway credential because it is a normal provider session. The policy resolver reads the child's server-stamped origin:

- Below the maximum depth, it may receive `gateway.create`.
- At the maximum depth, it receives discovery, read, and wait capabilities only.
- A child can never target itself or create a cyclic parent chain.

These controls prevent accidental or cooperative fan-out through the gateway. They do not claim to constrain the raw local control plane.

### 6.7 Gateway token handling and revocation

- Generate random 256-bit bearer tokens.
- Store token hashes only.
- Bind token lifetime to the active provider session and prune orphaned credentials.
- Apply an absolute lifetime only with a provider-session reload or restart path.
- Revoke on provider session stop, thread stop, thread deletion, and server shutdown.
- Scope a token to one environment, caller thread, provider instance, root delegation tree, and immutable policy.
- Key revocation to the provider session generation, so a credential minted for an earlier session generation is rejected after a provider recovery even when the same thread ID is reused, and the recovered session receives a fresh credential. Cover the Codex bearer-environment-variable path with a test proving the old env-var bearer is rejected and the recovered session's new bearer is accepted.
- Never return the bearer through an MCP tool.
- Never place it in structured logs or orchestration metadata.

The current registry already revokes per thread and all sessions (`apps/server/src/mcp/McpSessionRegistry.ts:156-172`, `apps/server/src/provider/Layers/ProviderService.ts:1011-1034`).

The bearer authenticates one provider session to the dedicated gateway MCP listener. It is not reused for or accepted by the shared orchestration HTTP endpoint.

### 6.8 Local exposure

- Bind the gateway MCP listener only to `127.0.0.1`.
- Independently reject missing or non-loopback `HttpServerRequest.remoteAddress` before bearer resolution.
- Do not expose the gateway through the WSL wildcard listener.
- Keep bearer authentication mandatory.
- Do not add CORS.
- Do not advertise the endpoint through remote environment APIs.
- Provider child processes receive the endpoint through explicit SDK, ACP, app-server, or local OpenCode configuration.
- An external OpenCode server receives no gateway credential in Phase 1.
- Do not silently fall back to the main listener or bearer-only checks if either loopback control cannot be implemented.

## 7. Provider-agnostic injection

### 7.1 Support matrix

| Provider | Current injection mechanism | Phase 1 caller status | Required work |
|---|---|---:|---|
| Claude | Agent SDK `queryOptions.mcpServers` with HTTP headers | Supported when gateway enabled | Add conditional gateway injection and capability tests; no global plugin dependency |
| Codex | App-server MCP URL plus bearer env var | Supported when gateway enabled | Add conditional gateway tool-call, launch-key, and restart tests |
| GitHub Copilot | SDK `SessionConfigBase.mcpServers` | Supported when gateway enabled, after merge fix | Merge the reserved gateway config into `resolveCopilotMcpServers` |
| Cursor | ACP HTTP MCP descriptor with headers | Deferred from Phase 1 | Run conformance tests for tool list, call, auth, timeout, and error shapes before enabling |
| Grok | ACP HTTP MCP descriptor with headers | Deferred from Phase 1 | Run the same ACP conformance tests before enabling |
| OpenCode | `client.mcp.add` for an internally spawned server | Deferred from Phase 1 | Test add-before-session behavior and restart cleanup; keep external server unsupported |

This matrix describes a provider acting as the parent MCP caller. The gateway server is injected into no provider while disabled. When enabled in Phase 1, only Claude, Codex, and Copilot receive it. Every ready provider instance can still be a child target because child execution uses the normal provider registry and orchestration path.

### 7.2 Copilot merge rules

Extend `resolveCopilotMcpServers` to accept the built-in per-thread MCP config:

1. Copy organization presets.
2. Add AI-Orch when configured.
3. Add enabled user servers.
4. When enabled, add the reserved `neokod-agent-gateway` server last.

The final step prevents a user-defined gateway key from overriding the built-in credential or endpoint. Continue using the existing field-by-field SDK config copier because the contracts and SDK optional-property shapes differ (`apps/server/src/provider/copilot/CopilotMcpServers.ts:1-9`, `apps/server/src/provider/copilot/CopilotMcpServers.ts:33-67`).

`CopilotAdapter` should read `McpProviderSession` for the starting thread, translate it to an SDK HTTP server, and pass it into the resolver before `createSession` or `resumeSession`.

### 7.3 Claude and Codex

Claude and Codex already inject the built-in preview MCP session. Phase 1 preserves that entry and adds the separate gateway entry only when enabled:

- The same child thread receives a new credential after provider recovery.
- The old credential is rejected.
- No gateway server or tools are visible while disabled.
- When enabled, gateway tools are visible only through the separate reserved server and issued policy.
- Claude injection works with a custom `CLAUDE_CONFIG_DIR`.
- Codex does not expose the bearer in command-line arguments. The current environment-variable mechanism should remain.

### 7.4 Cursor and Grok

The code already passes a named HTTP MCP server and Authorization header into the ACP runtime (`apps/server/src/provider/Layers/CursorAdapter.ts:534-558`, `apps/server/src/provider/Layers/GrokAdapter.ts:572-596`).

Assumption: the installed ACP implementations preserve custom HTTP headers and support the MCP tool result shapes used by Effect's server. This was not verified through a live provider call during this read-only investigation. Do not inject the gateway into these providers in Phase 1; move them to supported only after real tool-list, call, auth, and bounded-wait conformance passes.

### 7.5 OpenCode

The local OpenCode adapter adds the MCP server through `client.mcp.add` before it creates the provider session. It deliberately skips injection for an externally managed OpenCode server (`apps/server/src/provider/Layers/OpenCodeAdapter.ts:1047-1072`).

Keep that boundary. Sending a bearer to an external server would move the credential outside the neokod-managed process tree.

## 8. Phased delivery plan

### 8.1 Phase 1: opt-in bounded fan-out, interrupt, wait, and results

Deliver:

- `agentGateway.enabled: false` and `allowTaskCreation: false` defaults, with restart-required effective changes.
- No listener, injection, credentials, or tools while disabled.
- Dedicated gateway-only loopback MCP listener with both exact `127.0.0.1` binding and fail-closed remote-peer guard.
- Exactly seven tools: context, catalog, single create, exact batch create, terminal wait, interrupt, and bounded read.
- Single and exact batch creation.
- Isolated worktrees.
- No gateway setup-script execution.
- Terminal-only wait for any/all, default 60 seconds and maximum 120 seconds.
- Bounded transcript/result read.
- Durable operation/task receipts, explicit launch state machine, `launch_unknown` no-resend behavior, provider-send idempotency keys, and crash reconciliation.
- Immutable accepted turn ID for wait/read/interrupt result identity.
- Atomic active/rate reservation, one coalesced durable multi-task wait coordinator, and provider-active compensation guard.
- Server-stamped thread provenance and actor kind; no caller-controlled inference.
- Parent `task.*` lifecycle.
- Advisory capability, rate, quota, runtime, and recursion policy, with the raw loopback dispatch bypass documented.
- Claude, Codex, and Copilot as verified parent callers.
- Cursor, Grok, and local OpenCode held out as parent callers until conformance passes.
- Provider-native sub-agents unchanged and always available.

Core files to add or modify:

Contracts:

- `packages/contracts/src/agentGateway.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/contracts/src/server.ts`
- `packages/contracts/src/settings.ts`
- contracts package exports and schema tests

MCP and provider session scope:

- `apps/server/src/mcp/McpInvocationContext.ts`
- `apps/server/src/mcp/McpProviderSession.ts`
- `apps/server/src/mcp/AgentGatewayMcpHttpServer.ts`
- `apps/server/src/mcp/AgentGatewaySessionRegistry.ts`
- `apps/server/src/mcp/AgentGateway.ts`
- `apps/server/src/mcp/toolkits/agentGateway/tools.ts`
- `apps/server/src/mcp/toolkits/agentGateway/handlers.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/serverSettings.ts`
- `apps/server/src/server.ts`

Shared command and task projection:

- `apps/server/src/orchestration/Services/OrchestrationCommandDispatcher.ts`
- `apps/server/src/orchestration/Layers/OrchestrationCommandDispatcher.ts`
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/orchestration/taskActivity.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`

Persistence and worktree safety:

- `apps/server/src/persistence/Services/AgentGatewayOperations.ts`
- `apps/server/src/persistence/Layers/AgentGatewayOperations.ts`
- `apps/server/src/persistence/Services/ProjectionThreads.ts`
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`
- `apps/server/src/persistence/Services/OrchestrationEventStore.ts`
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- `apps/server/src/persistence/Migrations/<next>_AgentGateway.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/git/GitWorkflowService.ts`
- `apps/server/src/vcs/GitVcsDriverCore.ts`
- `packages/shared/src/worktreeCleanup.ts`
- the explicit subpath export in `packages/shared/package.json`
- `apps/web/src/worktreeCleanup.ts` and `apps/web/src/hooks/useThreadActions.ts` for the shared-helper import only

Provider injection:

- `apps/server/src/provider/copilot/CopilotMcpServers.ts`
- `apps/server/src/provider/copilot/CopilotAdapter.ts`
- conditional injection and conformance tests for Claude, Codex, and Copilot

Web verification:

- `apps/web/src/session-logic.subagents.test.ts`
- `apps/web/src/components/SubagentsPanel.test.ts`

No Phase 1 UI behavior change is required for basic visibility. Existing task cards ignore unknown extra payload fields and already render task lifecycle. The worktree helper import is an internal refactor. A child-thread link can wait for Phase 2.

Phase 1 acceptance criteria:

- A Claude, Codex, or Copilot parent creates two tasks targeting two explicit provider instances.
- With default settings, no gateway listener is started, no provider receives `neokod-agent-gateway`, and no gateway tool is listed.
- Enabling the gateway without `allowTaskCreation` does not issue `gateway.create`.
- Both child threads appear in the shell/thread list.
- Each child uses a distinct worktree under configured `worktreesDir`.
- Parent Subagents cards show running and terminal states.
- Terminal-only `wait(all)` survives one child failure, cannot lose a wakeup, and rejects a timeout above 120 seconds.
- `read` returns the durable assistant result for the pinned turn after provider process exit and remains unchanged after a later human turn.
- `interrupt` is idempotent and refuses to interrupt a later human turn.
- Retrying create with the same operation key returns the same task and thread IDs.
- Retrying with changed input returns `operation_key_conflict`.
- A forced server restart before `sending` reconciles without duplicates.
- A forced crash after provider send begins but before durable acceptance produces `launch_unknown` and never auto-resends.
- Concurrent different operation keys cannot jointly exceed the active-task limit.
- Compensation cannot remove a worktree while its task is `sending`, `accepted`, `launch_unknown`, or reported active by `ProviderSessionDirectory` / `ProviderService`.
- A depth-one child cannot create a grandchild under the recommended policy.
- The gateway fails to start if either exact loopback binding or the peer guard is absent; a remote or missing peer address is rejected before bearer handling.
- A stopped provider session's old bearer is rejected.
- `apps/server/src/orchestration/http.ts` retains its existing `WslBearerAuth`-only behavior; tests and docs make clear that gateway caps are advisory and bypassable through that raw local route.

Required implementation gates:

- `vp check`
- `vp run typecheck`
- `vp test`
- Focused real-git integration tests for creation, compensation, and crash reconciliation
- Provider-specific MCP injection tests

### 8.2 Phase 2: control and inspection

Deliver:

- Stop.
- Durable queued follow-up turns.
- Provider-capability-gated steering.
- Bounded activity and event inspection.
- Synthesized gateway diagnostics.
- Rename and archive.
- Optional child-thread link from the existing Subagents panel.

Files likely to change:

- `packages/contracts/src/agentGateway.ts`
- `apps/server/src/mcp/toolkits/agentGateway/tools.ts`
- `apps/server/src/mcp/toolkits/agentGateway/handlers.ts`
- `apps/server/src/mcp/AgentGateway.ts`
- `apps/server/src/orchestration/Services/OrchestrationCommandDispatcher.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts` only if a provider-neutral steer capability can be defined
- `apps/server/src/provider/Layers/ProviderService.ts`
- existing process and trace diagnostic services used by `server.getProcessDiagnostics` and `server.getTraceDiagnostics`
- `apps/web/src/session-logic.ts`
- `apps/web/src/components/SubagentsPanel.tsx`

Phase 2 acceptance criteria:

- Queue survives a server restart and starts only after the active turn settles.
- Unsupported steering returns `provider_capability_unsupported`.
- Diagnostics never expose credentials, raw environment variables, or unbounded provider payloads.

### 8.3 Phase 3: external MCP and full local tool surface

Deliver:

- Provider-neutral external MCP settings and validation.
- Credential references stored through `ServerSecretStore`.
- External MCP test, enable, disable, update, and remove.
- Local automations only after their own durable substrate is approved.
- Any remaining high-value tools justified by real use.

Files likely to change:

- `packages/contracts/src/settings.ts`
- `packages/contracts/src/agentGateway.ts`
- `apps/server/src/serverSettings.ts`
- `apps/server/src/secrets/ServerSecretStore.ts`
- provider adapters that translate provider-neutral external MCP settings
- `apps/server/src/mcp/AgentGateway.ts`
- `apps/server/src/mcp/toolkits/agentGateway/*`
- automation modules defined by the separate automation design

Phase 3 acceptance criteria:

- External MCP secrets never appear in settings snapshots or gateway reads.
- Built-in `neokod` preview and `neokod-agent-gateway` entries remain reserved and cannot be replaced.
- Provider adapters apply one provider-neutral setting with tested native translations.
- Automation execution uses existing gateway operation, capability, quota, and provenance controls.

## 9. Risks, resolved decisions, and alternatives

### 9.1 Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Runaway fan-out through gateway tools | CPU, memory, disk, and cost exhaustion | Atomic gateway reservation applies batch, active-task, per-minute, provider, model, and recursion guardrails |
| Raw dispatch bypasses gateway caps | Extra tasks, cost, disk use, and UI noise | Honest advisory posture, default-off opt-in, provider sandboxes remain in force, strong Subagents visibility and user interrupt |
| Recursive gateway delegation | Exponential task growth | Persisted delegation depth, default depth one, create capability removed at the gateway ceiling |
| Model cost blow-up | Unexpected provider spend | Explicit provider and model, approval-required child default, allowlists, quota preflight, operation cost telemetry |
| Provider quota exhaustion | Partial or complete launch failure | Read `ServerProvider.usage`, fail affected items before worktree creation when exhaustion is known, return partial batch results |
| Copilot monthly quota | Tasks fail after SDK start or during a batch | Surface the existing clear quota error and suggest catalog alternatives; never retry automatically against a different provider |
| Parent MCP call timeout | Agent loses the synchronous response while children continue | Durable operation key, short create response, bounded wait, replayable read |
| Crash during worktree creation | Orphan branch, directory, or duplicate attempt | Reserve manifest first, deterministic path and branch, reconcile with git status, operation-owned compensation |
| Crash around provider send | Duplicate provider work or an untraceable result | Explicit `sending` / `accepted` / `launch_unknown` states, stable send key, immutable accepted turn ID, never auto-resend unknown |
| Concurrent reservations | Two operation keys jointly exceed the active limit | One reservation semaphore plus recount and inserts in one SQL transaction |
| Multi-task wait wakeup race | Wait sleeps past terminal state | One coalesced coordinator, subscribe before durable read, reread the full task set after every signal |
| Shared, active, or user-modified worktree cleanup | Data loss or provider failure | Durable compensation claim, shared-reference check, live provider binding/session recheck, retain on uncertainty |
| Full-access child writes outside the worktree | Wider filesystem changes | Explicit provider full-access grant, clear warning, no inheritance from parent, server-stamped audit provenance |
| Prompt injection into gateway calls | Gateway guardrail abuse or raw dispatch bypass | Default-off opt-in, immutable gateway scope for tool calls, honest residual-risk warning; do not claim the shared control plane is protected |
| Spoofed gateway attribution | Human/raw-client work appears agent-created | Trusted in-process dispatch context and operation row; never infer actor/origin from command ID or client payload |
| Provider MCP incompatibility | Tool list or calls fail under one provider | Claude/Codex/Copilot-only Phase 1 caller set; defer ACP and OpenCode until conformance passes |
| Event amplification | Large parent activity streams and noisy UI | Coalesced progress, child transcript remains in child thread, bounded diagnostics |
| Human deletes or starts another turn on a child | Wait/read/interrupt targets the wrong work | Pin the accepted turn ID; return explicit `child_deleted` or `not_active` |
| Gateway listener exposure | Gateway reachable outside loopback | Both exact `127.0.0.1` binding and fail-closed peer guard; no shared-listener fallback |

### 9.2 Resolved Phase 1 decisions

1. **Default creation authority:** explicit opt-in. The whole gateway defaults off, and `allowTaskCreation` also defaults false. There is no automatic same-project creation grant.
2. **Project scope:** current project only by default. Other projects require an explicit allowlist entry.
3. **Approval-blocked children:** they continue to count as active until terminal or explicitly interrupted/stopped. Phase 1 adds no idle auto-stop.
4. **Wait duration:** fixed default 60 seconds and maximum 120 seconds for all Phase 1 callers. Increase or specialize only after conformance data.
5. **Parent archival:** leave existing children running as independent first-class threads; revoke the archived parent's gateway credential and do not cascade.
6. **Quota thresholds:** warn for non-zero percentage thresholds; block only a known exhausted hard quota. Unknown quota remains allowed under gateway rate/active guardrails.
7. **Parent caller set:** Claude, Codex, and Copilot only. Cursor, Grok, and local OpenCode are held until their conformance tests pass in a later phase.
8. **Phase 1 UI:** existing thread navigation plus the Subagents panel and server-stamped provenance are sufficient. A direct parent/child link is deferred.

### 9.3 Assumptions requiring implementation validation

- Effect's HTTP server layering can host a second in-process listener with host `127.0.0.1` and an OS-assigned port. If it cannot, Phase 1 is blocked; do not fall back to the shared listener.
- `HttpServerRequest.remoteAddress` is populated by both vendored Node and Bun server layers (`.repos/effect-smol/packages/platform-node/src/NodeHttpIncomingMessage.ts:85-86`, `.repos/effect-smol/packages/platform-bun/src/BunHttpServer.ts:403-404`). Missing peer data fails closed in the gateway middleware.
- Cursor and Grok ACP clients preserve HTTP MCP Authorization headers.
- Local OpenCode retains the injected remote MCP server for the lifetime of the created session and cleans it up with the managed child server.
- Claude, Codex, and Copilot accept 60-second default / 120-second maximum MCP calls. Conformance tests must confirm those ceilings before release.
- Provider adapters that lack native send-idempotency support still preserve the gateway key through the shared send contract for correlation and same-process coalescing; crash ambiguity still becomes `launch_unknown`.
- The existing model option descriptors are sufficient to validate every gateway target option without provider-specific gateway branches.
- No durable local automation scheduler exists in the inspected gateway path. Phase 3 automation work needs a separate substrate decision.

### 9.4 Alternatives considered

#### External gateway daemon

An external daemon would need its own auth, environment discovery, provider registry access, persistence, and process lifecycle. It would duplicate the in-process MCP and orchestration seams. Do not use it for Phase 1.

#### One stdio gateway process per provider session

This removes the loopback listener and adds one child process plus a server IPC channel for every provider session. It increases lifecycle and crash-recovery work. Keep it as a future alternative for a provider that cannot call local HTTP MCP, not as a silent Phase 1 fallback.

#### Provider-native subagents only

Claude, Codex, and Copilot already emit native `task.*` events for their internal workers. Those provider-native workers remain default-on inside one provider thread, never use neokod's control plane, and do not become neokod threads with independent provider selection and worktrees. Preserve that layer unchanged; the default-off gateway adds cross-provider first-class tasks only when the user enables it.

#### A new orchestration engine

The current engine already provides serialized command dispatch, command receipts, durable events, projections, and domain streams (`apps/server/src/orchestration/Services/OrchestrationEngine.ts:40-58`, `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:128-231`). A new engine would split state and failure semantics. Use one narrow gateway operation receipt around the existing engine.

#### Command receipts alone

Command receipts deduplicate individual domain commands. Worktree creation occurs between commands and is outside their transaction. A multi-step operation receipt is required to reserve the full manifest, detect changed retries, and reconcile filesystem side effects.

#### Automatic provider fallback

Automatic fallback could silently change cost, model behavior, credentials, and permission characteristics. Return an explicit per-item failure and let the parent choose another exact provider and model with a new operation key.

## 10. Implementation principles

- Keep provider-native sub-agents default-on and separate from the opt-in, default-off Agent Gateway.
- Reuse existing MCP authentication/injection patterns, orchestration commands, projections, task activity, and worktree service; use a separate gateway-only listener and server entry.
- Keep provider-specific MCP translation in each adapter.
- Keep gateway scope checks and provenance stamping in trusted server code, while describing the controls as advisory because the shared local control plane remains open.
- Do not alter authentication or dispatch behavior in `apps/server/src/orchestration/http.ts` for Phase 1.
- Reserve durable identities before filesystem or provider side effects.
- Reserve active-task capacity atomically before worktree or provider side effects.
- Never auto-resend `launch_unknown`; pin the concrete accepted turn for all later operations.
- Use terminal-only waits through one durable/coalesced coordinator, capped at 60/120 seconds.
- Never compensate a worktree while provider launch or use is possible.
- Exclude `runSetupScript` from every gateway Phase 1 contract and path.
- Keep Phase 1 to exactly seven tools, including interrupt.
- Treat provider and model identifiers as exact routing data.
- Make every retry, partial failure, quota rejection, and permission denial visible in structured output.
- Stamp actor and origin server-side; command prefixes and client payloads are not provenance.
- Preserve local-first boundaries throughout.
