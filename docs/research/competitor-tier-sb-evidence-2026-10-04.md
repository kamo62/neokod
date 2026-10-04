# S and B tier source and current-issue investigation

Captured on 2026-10-04 UTC. Investigation lane: `/tmp/neokod-competitors-20261004/tier-sb-sol`. Scope: all eight requested applications. Read Neokod README, architecture/state-and-evidence/Symphony/runtime and Jira docs before comparing current callers. Source and issue snapshots are separately timed; no atomic snapshot or runtime reproduction is claimed.

The useful direction is ordinary-chat managed children with durable command/result identity and explicit ownership, layered onto Neokod’s existing provider, event and Symphony repositories. Cross-provider transport translation is separate. Optional “Send Jira ABC-123 to Symphony” must resolve through the configured server connection and preserve board/review policy, rather than requiring a mode switch.

## Coverage and decisions

| Application   | Evidence                                                     | Licence metadata                                | Decision                                                                                |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Omnigent      | Pinned public implementation + selected current issues       | Apache-2.0                                      | Adapt result recovery and descendant ownership; build stricter terminal evidence.       |
| Paseo         | Pinned public implementation + selected current issues       | Apache-2.0 in LICENSE; GitHub Other/NOASSERTION | Adapt ordinary-chat controls, scoped creation and stream barriers.                      |
| OpenCodeX     | Pinned public implementation + selected current issues       | MIT                                             | Conditional adapter lessons; reject treating an API proxy as orchestration.             |
| bb            | Pinned public implementation + selected current issues       | MIT                                             | Adapt explicit capabilities, delivery identity and sibling-aware recovery.              |
| Pi            | Pinned public implementation + selected current issues       | MIT                                             | Adapt semantic queue/context handling; reject core security and scheduler assumptions.  |
| HarnessRouter | Pinned public implementation + selected current issues       | Apache-2.0                                      | Conditional task API concepts; reject observe/fail-open ownership and false durability. |
| Conductor     | Official docs + public release issues; no implementation     | not established                                 | Official behaviour inspiration only; no implementation port.                            |
| Maestri       | Official docs/changelog; no public source/tracker identified | not established                                 | Official behaviour inspiration only; conditional CoW, reject focus-dependent delivery.  |

Licences above are factual capture metadata, not a legal assessment. Retain applicable notices when adapting code. Conductor’s release repository and Maestri behaviour docs do not establish an implementation reuse grant. No prior Luna partial lane was found; raw evidence here was independently captured and reviewed.

## Existing Neokod coverage

[`ProviderService`](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderService.ts) already exposes capabilities; [`ProviderCommandReactor`](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) checks model/instance/runtime/cwd when reusing a session and respects session model-switch capability. [`RuntimeItemProjection`](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/RuntimeItemProjection.ts) gives provider facts priority and preserves orphaned runtime items when closure is not guaranteed. [`OrchestrationEngine`](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts) persists command receipts transactionally.

Symphony already has durable runtime claims in [`WorkItemRepository`](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts), generation-fenced paths in [`WorkspaceOwnershipRepository`](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Layers/WorkspaceOwnershipRepository.ts) and stop/verify/bind/park/transfer handling in [`HandoffService`](/Users/kamogelo/Code/t3code/apps/server/src/symphony/HandoffService.ts). [`JiraAdapter`](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/JiraAdapter.ts) and [`JiraApiClient`](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/JiraApiClient.ts) retain configured credentials server-side and native issue identity. Reuse these callers. A normal-chat managed-child control plane and tracker command resolver still require explicit design; documentation direction does not prove they exist.

[`agentAwareness`](/Users/kamogelo/Code/t3code/packages/shared/src/agentAwareness.ts) and [`SubagentsPanel.logic`](/Users/kamogelo/Code/t3code/apps/web/src/components/SubagentsPanel.logic.ts) provide current presentation foundations. Root owns the screenshot concept and final integrated UI recommendation. Upstream UI code, hosted pairing/relay/cloud/mobile/auth control planes remain excluded.

## Omnigent

Adapt result recovery and descendant ownership; build stricter terminal evidence.

### Recover child results with durable identity

Subagent recovery rereads server children and reconstructs terminal results using dispatch IDs and delivery markers. Recovery is single-flight per parent, retries failed reads and retains undelivered results when an inbox disappears. The application caller creates the recovery service in runner/app.py. This is a useful separation of durable result facts from an ephemeral delivery channel. Evidence: [omnigent/runner/subagent_work.py](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/omnigent/runner/subagent_work.py), [omnigent/runner/subagent_recovery.py](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/omnigent/runner/subagent_recovery.py).

Decision: adapt. Match: [OrchestrationEngine.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts). Neokod already persists command receipts in engine transactions. Extend that receipt discipline to child commands, result acknowledgements and a server-owned parent result inbox. An in-memory task map or inbox is insufficient by itself. Gates: G2 G9.

### Fence stale terminal callbacks

mark_subagent_work_terminal uses only_if_work_id to stop an old timer finalising a newer dispatch. It allows a late failure to replace a previously delivered completion and redelivers the correction. Its own comments admit a false-idle early-completion window; borrowing only the dedupe key would preserve that defect. Evidence: [omnigent/runner/subagent_work.py](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/omnigent/runner/subagent_work.py).

Decision: adapt/build. Match: [RuntimeItemProjection.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/RuntimeItemProjection.ts). Use Neokod event identities and provider terminal evidence. Preserve correction provenance, but do not publish completion from an idle heuristic. Neokod orphaned items already express missing closure evidence. Gates: G2 G3.

### Recover descendants under an ownership check

Child recovery waits for parent readiness, skips intentional stop/archive/closure and native mirrors, checks other runner ownership, rereads under a lock and uses compare-and-set runner replacement. This prevents a restart sweep blindly stealing live descendants. Evidence: [omnigent/server/child_session_recovery.py](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/omnigent/server/child_session_recovery.py).

Decision: adapt. Match: [WorkspaceOwnershipRepository.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Layers/WorkspaceOwnershipRepository.ts). Retain Neokod generation fencing and durable runtime-owner lease identities. A process-local lock alone cannot establish cross-process ownership. Apply the same discipline to managed child sessions, without importing hosted runner control planes. Gates: G4 G6 G12.

Current selected issues (all open at capture; state/update/version/platform and comment/PR evidence are retained in [selected issue evidence](evidence/competitor-selected-issues.json)):

- [#8874: \[Bug\] codex-native sub-agent reported finished ~1 s after turn/start (false idle from thread/resume); real result is lost](https://github.com/omnigent-ai/omnigent/issues/8874) [user report]. False idle just after thread/resume publishes completion before the real result; reporter supplied timing/logs. Current work-registry code documents a correction window, not prevention. Gate: G2 G3.
- [#5376: \[Bug\] Child session workspace is not propagated through sub-agent dispatch](https://github.com/omnigent-ai/omnigent/issues/5376) [user report]. Child workspace not propagated by dispatch; automated triage is not maintainer confirmation. Gate: G1 G4.
- [#6607: Guardrails policy that can return DENY breaks sys_session_send with "requires parent session inbox"](https://github.com/omnigent-ai/omnigent/issues/6607) [user report]. A policy that can deny triggers a parent-inbox requirement even when its evaluated verdict allows. No independent runtime reproduction. Gate: G5.
- [#7841: \[Bug\] Codex native startup cannot recover an orphaned backfill lease, even with the 60s readiness fix](https://github.com/omnigent-ai/omnigent/issues/7841) [user report]. Orphaned native backfill lease cannot be reclaimed. Earlier readiness timeout change does not establish lease recovery. Gate: G6 G12.
- [#8210: \[Bug\] Native web re-send can paste twice after a server restart (no durable stable_id → item mapping)](https://github.com/omnigent-ai/omnigent/issues/8210) [user report]. In-memory stable_id mapping disappears on server restart and can paste twice; source-oriented report, no executed reproduction here. Gate: G2.

## Paseo

Adapt ordinary-chat controls, scoped creation and stream barriers.

### Keep cross-provider orchestration in ordinary chat

Official orchestration docs distinguish managed Paseo children, which are full sessions, from provider-native subagents, which are timeline observations. createAgentCommand creates a persisted session and resolves caller-scoped parent information; independently read initial prompt before finish-watcher registration, which supports the fast-child race report. Evidence: [public-docs/orchestration.md](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/public-docs/orchestration.md), [packages/server/src/server/agent/create-agent/create.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/server/src/server/agent/create-agent/create.ts).

Decision: adapt/build. Match: [ProviderService.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderService.ts). Reuse provider capability and session contracts for governed create/send/stop/wait controls. Persist the parent relation before provider execution, register the result recipient first and expose unavailable capabilities explicitly. Normal chat remains the entry point; Symphony stays an optional workstream. Gates: G1 G2 G5 G9 G10.

### Coalesce live deltas, flush semantic barriers

handleStreamEvent coalesces adjacent live deltas and flushes them before terminal/barrier processing. History replay does not restamp timestamps and already-finalised turn handling is guarded. The captured coalescing tests were read, not run; throughput has not been measured here. Evidence: [packages/server/src/server/agent/agent-manager.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/server/src/server/agent/agent-manager.ts), [packages/server/src/server/agent/agent-stream-coalescer.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/server/src/server/agent/agent-stream-coalescer.ts).

Decision: adapt. Match: [ProviderCommandReactor.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts). Measure the actual Neokod provider ingestion path before choosing limits. Coalesce display traffic after durable semantic events are accepted; approval/tool/terminal events must keep ordering and identity. Gates: G3 G7.

### Restore a workspace before resuming its agent

session.ts calls inspect/restore. The recovery service distinguishes unavailable reasons, reuses surviving archived placement or recreates recorded worktree branch/root, maps nested cwd and rolls back failures. An external-change-request gate blocks automatic workspace setup until trusted. Evidence: [packages/server/src/server/session/workspace-recovery/workspace-recovery-service.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/server/src/server/session/workspace-recovery/workspace-recovery-service.ts), [packages/server/src/server/session.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/server/src/server/session.ts).

Decision: adapt/conditional. Match: [HandoffService.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/HandoffService.ts). Neokod already verifies the worktree/branch and stops the former worker before ownership transfer. Reuse that path for ordinary chat handoff; add trust gating only where an external change request can supply executable setup content. Do not import remote/mobile orchestration. Gates: G4 G5 G10.

Current selected issues (all open at capture; state/update/version/platform and comment/PR evidence are retained in [selected issue evidence](evidence/competitor-selected-issues.json)):

- [#5928: bug: create_agent notifyOnFinish can miss very fast child completion before watcher registration](https://github.com/getpaseo/paseo/issues/5928) [user report]. Finish watcher registered after initial prompt. Independently read current create.ts and confirmed ordering. Two proposed fix PRs remain open, not merged. Linked fixes: [PR 5929](https://github.com/getpaseo/paseo/pull/5929) (open, unmerged), [PR 6008](https://github.com/getpaseo/paseo/pull/6008) (open, unmerged). Gate: G2.
- [#5884: bug: Paseo MCP create_agent Loses ParentAgentId](https://github.com/getpaseo/paseo/issues/5884) [user report]. Parent missing in MCP create_agent report is contested: latest contributor could not reproduce with agent-scoped injected MCP on main; manually configured top-level MCP has no caller by design. Current source resolves injected caller parent. Gate: G1.
- [#4538: bug(codex): completed collaboration items stay "N running" after parent is idle (0.8.0-beta.1)](https://github.com/getpaseo/paseo/issues/4538) [user report]. Completed native collaboration history still shows N running. Fix PR 5314 open. Parent idle alone must not terminalise every native child. Linked fixes: [PR 5314](https://github.com/getpaseo/paseo/pull/5314) (open, unmerged). Gate: G3.
- [#5963: OpenCode: sending an agent message fails with UND_ERR_HEADERS_TIMEOUT after exactly 300s (#5674 fix does not cover the send-message path)](https://github.com/getpaseo/paseo/issues/5963) [user report]. 300 s send-path headers timeout reported. Latest contributor Linux/OpenCode 1.18.32 test on main did not reproduce at 356 s; cannot-reproduce label, open. Retain platform/version specificity. Gate: G6 G11.
- [#3095: bug: large Codex histories block cold-load and make --tail time out](https://github.com/getpaseo/paseo/issues/3095) [user report]. Cold --tail 10 reads full 137/248 MiB histories and times out; report supplies data sizes, not a Neokod benchmark. Gate: G7.

## OpenCodeX

Conditional adapter lessons; reject treating an API proxy as orchestration.

### Fence retries at execution uncertainty

fetchWithTransientRetry counts physical sends once across reset/transient layers, preserves non-replayable responses, honours caller-bounded Retry-After and aborts waits. Core combo failure logic preserves execution uncertainty. In failover.ts, cancellation, origin/cyber hard refusals and non-replayable codes stop target hopping; context overflow hopping is permitted only on zero-output failure. Evidence: [src/lib/upstream-retry.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/lib/upstream-retry.ts), [src/server/responses/core-combo-failure.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/server/responses/core-combo-failure.ts).

Decision: conditional. Match: [ProviderCommandReactor.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts). Useful if a Neokod provider adapter gains controlled retry/failover. It does not justify switching to a second coding agent after a possibly executed turn. Existing model/runtime/cwd session-reuse logic is the relevant caller and must remain authoritative. Gates: G6 G11.

### Bound retained stream memory and preserve terminal reasons

The adapter queue limits event count, total retained strings and one retained event, coalesces adjacent deltas, refunds charges on dequeue and admits a terminal overflow error. It bypasses retention charging for direct delivery to waiting readers; the downstream consumer therefore needs its own per-event bound. Object traversal is depth/node bounded and can undercount pathological nested payloads. Preflight retains a replayUnsafe latch even if older heartbeats are evicted. Evidence: [src/adapters/run-turn-queue.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/adapters/run-turn-queue.ts), [src/server/responses/core-combo.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/server/responses/core-combo.ts).

Decision: adapt/conditional. Match: [RuntimeItemProjection.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/RuntimeItemProjection.ts). Adopt explicit budgets and semantic barriers at Neokod stream boundaries, with measurements to select local defaults. Keep durable event projection separate from display coalescing. A budget over one queue does not prove total-process memory boundedness. Gates: G7 G11.

### Diagnose provider shapes without retaining values

Malformed tool-call diagnostics report reason, structural types and an allowlist of field shapes; arguments and credential values are omitted. Stream null continuation fields are treated as absent consistently with accumulation, while buffered calls require a dispatchable name. This avoids a diagnostic inventing a compatibility failure or leaking content. Evidence: [src/adapters/openai-chat/tool-call-validation.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/adapters/openai-chat/tool-call-validation.ts).

Decision: adapt. Match: [ProviderAdapter.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderAdapter.ts). Use adapter-specific validation before durable call history is accepted. Do not copy endpoint translation, account pools or custom model grammar into ordinary-chat orchestration. MultiAgentMode settings describe a Codex surface and do not establish a provider-neutral managed-child control plane. Gates: G8 G11.

Current selected issues (all open at capture; state/update/version/platform and comment/PR evidence are retained in [selected issue evidence](evidence/competitor-selected-issues.json)):

- [#6529: \[Bug\]: a process without config.json silently rewrites the Codex catalog to native-only models](https://github.com/lidge-jun/opencodex/issues/6529) [user report]. Absent config becomes defaults and rewrites routed model catalogue to native-only; deterministic source-oriented report, no comments. Gate: G11 G12.
- [#6456: \[Compatibility\]: Qwen3.6-27B emits numeric diff headers inside Codex apply_patch; supported editing path?](https://github.com/lidge-jun/opencodex/issues/6456) [user report]. Numeric patch hunk headers fail. Owner says route is unverified and direct controls also fail, so this does not isolate a proxy defect or establish a supported editing path. Gate: G8 G11.
- [#6314: \[Bug\]: Intermittent spend-ledger storage safety refusal on macOS with native Codex traffic, including HTTP-only](https://github.com/lidge-jun/opencodex/issues/6314) [maintainer-confirmed]. Owner confirms hard-link safety guard and no linking path in source, not the external actor. Later Google Drive information suggests sync involvement but root cause is unproven. Do not weaken the guard. Gate: G12.
- [#3375: \[Feature\]: complete the OAuth account-pool lifecycle — session affinity, 401/403 rotation, pool health, and stable reset-credit identity](https://github.com/lidge-jun/opencodex/issues/3375) [feature request]. Account-pool lifecycle epic is partly implemented: CLI truthful inert thresholds PR3797, pause PR6106, narrow Antigravity 401 PR6132 merged. Generic affinity/403/selector consumption remain open; neither all missing nor fully fixed. Linked fixes: [PR 3797](https://github.com/lidge-jun/opencodex/pull/3797) (merged), [PR 6106](https://github.com/lidge-jun/opencodex/pull/6106) (merged), [PR 6132](https://github.com/lidge-jun/opencodex/pull/6132) (merged). Gate: G5 G11.
- [#4761: codex-restart quits the desktop shell where upstream restarts only the app-server, discarding unsaved client state](https://github.com/lidge-jun/opencodex/issues/4761) [fixed-but-open]. Whole desktop restart discards drafts/pending client state; owner confirms scope. Warning merged, provider-only restart not established by that fix. Linked fixes: [PR 5682](https://github.com/lidge-jun/opencodex/pull/5682) (merged). Gate: G6.

## bb

Adapt explicit capabilities, delivery identity and sibling-aware recovery.

### Use verified capabilities rather than provider guesses

The runtime bridge receives plugin-delivered verified artifact capabilities and semantic deltas, rejects missing thread identity and rejects invalid release/forget resume operations. Runtime recovery checks all sibling hosted threads for active turns, in-flight operations and background work before restarting a shared artifact process. Evidence: [packages/agent-runtime/README.md](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/packages/agent-runtime/README.md), [packages/agent-runtime/src/runtime.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/packages/agent-runtime/src/runtime.ts).

Decision: adapt. Match: [ProviderService.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderService.ts). Neokod already exposes getCapabilities and confirmed/uncertain/failed stop outcomes. Extend its adapter contract only for demonstrated child control dependencies; defer restart when siblings or pending interactions may be harmed. Do not add bb plugin/host/connect infrastructure. Gates: G1 G5 G6.

### Reject workspace paths owned by another project

suppliedWorkspacePathRefusal rejects foreign-project managed paths and unrecorded paths under managed storage. Directory creation and environment placement call the helper before accepting supplied paths. This is an admission check, not a substitute for durable exclusive ownership. Evidence: [apps/server/src/services/threads/workspace-path-claims.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/server/src/services/threads/workspace-path-claims.ts), [apps/server/src/services/threads/thread-environment-directory.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/server/src/services/threads/thread-environment-directory.ts).

Decision: adapt. Match: [WorkspaceOwnershipRepository.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Layers/WorkspaceOwnershipRepository.ts). Reapply path admission against Neokod repository/worktree identities, then retain generation-fenced ownership. Shared review/test checkout must be explicit and writable child tasks require a clear owner. Gates: G4.

### Persist queue claims and preserve initiator provenance

Queue operations use transactional claims and distinguish sender from requestedBy. Claimed rows are excluded from the normal queue list; the issue review shows why a durable visible delivery receipt is still needed. Child terminal notices format excerpts but omit user-vs-parent turn initiator, consistent with the source/storage-confirmed report. Evidence: [packages/db/src/data/queued-thread-messages.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/packages/db/src/data/queued-thread-messages.ts), [apps/server/src/services/threads/child-thread-notifications.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/server/src/services/threads/child-thread-notifications.ts).

Decision: adapt/build. Match: [OrchestrationEngine.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts). Persist acceptance, claim, delivery and acknowledgement alongside canonical command/event identities. Attribute parent/child chat updates to the actual turn initiator and cover aggregate versus individual completions; do not dedupe on text or timestamps. Gates: G1 G2.

### Clamp permissions to the effective host ceiling

The helper intersects supported provider modes with a host maximum and refuses when no valid mode exists. Missing host/default policy can resolve to full authority in this source; that default is unsuitable for Neokod unknown evidence. Current stale-ACP and auto-ask reports also show that startup clamping alone is insufficient. Evidence: [apps/server/src/services/hosts/permission-ceiling.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/server/src/services/hosts/permission-ceiling.ts).

Decision: adapt; reject default. Match: [ProviderCommandReactor.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts). Check current policy at every queued delivery/steer, restart only if provider capability requires it and preserve pending approvals. Unknown capability must not widen authority. Gates: G5 G6.

Current selected issues (all open at capture; state/update/version/platform and comment/PR evidence are retained in [selected issue evidence](evidence/competitor-selected-issues.json)):

- [#4797: ACP sessions retain stale permissions on follow-ups and queued steers](https://github.com/get-bb/bb/issues/4797) [user report]. ACP permissions persist after tightening on follow-ups/steers. PR4795 closed without merge; reporter tests are not ours. Linked fixes: [PR 4795](https://github.com/get-bb/bb/pull/4795) (closed, unmerged). Gate: G5.
- [#3050: Deduplicate covered child completions and explicit/automatic result delivery](https://github.com/get-bb/bb/issues/3050) [feature request]. Maintainer/contributor consolidation requests authoritative completion identity and aggregate coverage to prevent explicit/automatic duplicates. Some linked content is explicitly agent generated. Gate: G2 G1.
- [#1706: queued thread messages can silently vanish: reported accepted, never delivered, no longer queued](https://github.com/get-bb/bb/issues/1706) [maintainer-confirmed]. Maintainer partially reproduced visibility/recovery gap: claims hide queued rows, sending has no receipt and orphan sweep is five minutes. No permanent-drop path was established, despite issue title. Gate: G2.
- [#2190: SQLite db silently reverted to a 2-week-old state while the server was running (post-Aug-9 projects/threads lost; auto-update in progress)](https://github.com/get-bb/bb/issues/2190) [maintainer-confirmed]. Partially reproduced DB state loss, exact original actor unknown and update correlation not causality. Later plugin report attributes WAL loss to two SQLite implementations in one process; not proof of universal bb core cause. Gate: G12.
- [#4424: Parent thread notices do not say who initiated a child thread's turn](https://github.com/get-bb/bb/issues/4424) [maintainer-confirmed]. Maintainer reproduced absent user-vs-parent turn initiator in source/storage without real agents. Fork change is not a main fix. Current notice formatter lacks that identity. Gate: G1 G2.
- [#4521: claude-code provider auto-approves permissions.ask rules and hook "ask" decisions (no pending interaction)](https://github.com/get-bb/bb/issues/4521) [user report]. permissions.ask and hook ask automatically approved with no pending interaction, reported. No maintainer runtime confirmation read. Gate: G5.

## Pi

Adapt semantic queue/context handling; reject core security and scheduler assumptions.

### Keep session facts separate from selected branch context

Session entries use IDs and parent IDs; model, thinking, compaction and context edits are distinct facts and projection follows a selected leaf. Loading repairs a truncated tail and skips malformed lines; it still reconstructs in-memory history. This provides inspectable branch semantics but is not proof of bounded loading, complete history or Neokod lifecycle truth. Evidence: [packages/coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/core/session-manager.ts).

Decision: adapt/conditional. Match: [RuntimeItemProjection.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/RuntimeItemProjection.ts). Retain typed facts and explicit context lineage. Malformed or absent history must remain visible as a gap rather than silently pretending nothing happened. No append-only JSONL migration is needed solely for this pattern. Gates: G3 G7 G8.

### Separate steering from follow-up and compaction

The loop awaits its semantic event sink, polls steering before tool/assistant work and processes follow-ups after natural completion. prepareNextTurn can compact then repoll steering, so messages arriving during preparation are not overlooked. Core queues are not proof of durable command receipts; manual compaction rejects prompt during compaction. Evidence: [packages/agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/agent/src/agent-loop.ts), [packages/coding-agent/src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/core/agent-session.ts).

Decision: adapt. Match: [ProviderCommandReactor.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts). Name queue semantics in contracts, preserve accepted messages during compaction and use server-owned receipts. Provider-native steer capability is separate from replacing a running turn. Gates: G2 G8.

### Bound optional child processes and validate waits

The example extension supports single/parallel/chain subprocesses, eight tasks/four concurrent by default, isolated context, output truncation and project-agent trust. It is not a built-in governed multi-agent scheduler. Durable scheduler validates self/owner/existence and owned-only failFast waits, but an arbitrary dependency graph cycle check was not found, matching the current mutual-wait report. Evidence: [packages/coding-agent/examples/extensions/subagent/index.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/examples/extensions/subagent/index.ts), [packages/durable/src/harness/scheduler.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/src/harness/scheduler.ts).

Decision: conditional/build. Match: [ProviderService.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderService.ts). Borrow finite bounds and explicit trust; build a durable managed-child graph with cycle rejection and confirmed cancellation. Pi core intentionally omits built-in permissions and cannot supply Neokod admission guarantees. Gates: G5 G8 G9.

Current selected issues (all open at capture; state/update/version/platform and comment/PR evidence are retained in [selected issue evidence](evidence/competitor-selected-issues.json)):

- [#10411: pi-durable: wait cycles deadlock instead of being rejected](https://github.com/earendil-works/pi/issues/10411) [user report]. Mutual allSettled waits deadlock across reopen. AI-assisted author report is not maintainer confirmation. Independently read scheduler: self/owner checks exist, arbitrary dependency graph cycle check not found. Gate: G9.
- [#9986: Aborting during tool execution leaves unanswered tool calls in the session](https://github.com/earendil-works/pi/issues/9986) [user report]. Abort during tool batch leaves unanswered call history. Separate started/uncertain/unstarted tools; linked fork implementation was not treated as merged fix. Gate: G8.
- [#10299: openai-completions: empty tool call from OpenRouter/GLM permanently wedges the session (repro + fix for #4854)](https://github.com/earendil-works/pi/issues/10299) [user report]. Empty tool call can poison future requests. Rare frequency claim belongs to reporter; no benchmark or independent execution. Gate: G8.
- [#10287: `getContextUsage()` massively overestimates context after retryable network error](https://github.com/earendil-works/pi/issues/10287) [user report]. Zero-usage failed assistant invalidates context anchor and overestimates context. Contributor fork patches are not main fixes; diagnostic values are user reports. Gate: G8.
- [#8301: Can't interleave compaction requests with prompts in prompt queue](https://github.com/earendil-works/pi/issues/8301) [feature request]. Queue task/compact/task desired; member reopened because they also want it. Current manual compaction rejects prompt while compacting; queue semantics remain a design choice. Gate: G8.

## HarnessRouter

Conditional task API concepts; reject observe/fail-open ownership and false durability.

### Reserve request identity before execution

Turn admission hashes semantic payload excluding stream/idempotency key, reserves the key before starting, rejects mismatched repeats and replays a recorded response. This is task/harness-level admission rather than a model endpoint proxy. Trace cursor durability follows flush. Protocol documents are a draft and show date drift between current README and connection examples. Evidence: [gateway/app.py](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/gateway/app.py), [gateway/control_store.py](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/gateway/control_store.py).

Decision: adapt/conditional. Match: [OrchestrationEngine.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts). Use Neokod persisted commands and canonical IDs rather than introducing UHP/Cosmos compatibility. Keep child request hashing and replay semantics typed and versioned if needed. Gates: G2 G11.

### Use local CAS, enforce admission failure

SQLite backing uses BEGIN IMMEDIATE and etag compare-and-set with explicit TTL deletion. However control_store lease_admit defaults to observe and storage errors return a non-rejected fence 0, explicitly permitting work without exclusive ownership. The code is not a correctness template in that configuration. Evidence: [gateway/control_sqlite.py](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/gateway/control_sqlite.py), [gateway/control_store.py](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/gateway/control_store.py).

Decision: adapt CAS; reject admission. Match: [WorkItemRepository.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts). Neokod already persists owner token/generation/PID/start/lease and workspace generations. Reuse those repositories and fail admission closed on unknown ownership; do not clone a second store abstraction. Gates: G4 G12.

### Capture between-turn edits for recovery, surface failed capture

RunnerWorkspaceFiles writes live files then stores a path-keyed between-turn copy. Captured tests exercise copy and traversal rejection. But \_capture returns without a blob or logs and swallows capture failure; write still returns success. Read exceptions become None. Those paths do not prove recoverable edits or distinguish unavailable from absent. Evidence: [gateway/backing.py](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/gateway/backing.py), [gateway/tests/test_workspace_write_durability.py](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/gateway/tests/test_workspace_write_durability.py).

Decision: conditional; reject success claim. Match: [HandoffService.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/HandoffService.ts). If Neokod supports recovery copies for ordinary-chat edits, define live-write success separately from durable capture success and surface degraded recovery. Keep local filesystem/worktree authority; no cloud blob dependency is justified. Gates: G4 G12.

Current selected issues (all open at capture; state/update/version/platform and comment/PR evidence are retained in [selected issue evidence](evidence/competitor-selected-issues.json)):

- [#375: goose: after a turn on an OpenAI-shape connection, the next turn on an Anthropic-native connection calls api.openai.com with no key](https://github.com/HarnessRouter/harnessrouter/issues/375) [maintainer-confirmed]. Collaborator reports provider switch resumes against old OpenAI endpoint with no key. This is collaborator test evidence, not ours. Gate: G11.
- [#374: hermes on a custom Anthropic-format connection fails: No usable credentials found for provider 'openai-api'](https://github.com/HarnessRouter/harnessrouter/issues/374) [maintainer-confirmed]. Collaborator reports custom Anthropic connection routed as openai-api with unusable credentials. Gate: G11.
- [#202: Codex backend on a custom Responses endpoint: `apply_patch_tool_type` is not settable, `namespace`/`web_search` tools are sent by default, and the runner stream has no `output_text.delta`](https://github.com/HarnessRouter/harnessrouter/issues/202) [fixed-but-open]. PR346 merged addresses shell editing instructions/apply-patch slice. Default namespace/web_search tool compatibility and absent output_text.delta remain open, not blanket fixed. Linked fixes: [PR 346](https://github.com/HarnessRouter/harnessrouter/pull/346) (merged). Gate: G8 G11.
- [#207: 5/6 backends fail trivial task on fresh self-host (1/6 serve)](https://github.com/HarnessRouter/harnessrouter/issues/207) [fixed-but-open]. User five of six backends failed near 322.7 s. Maintainer added structured error details and requested retest; this fixes diagnostics slice, not all backend runtime failures. Gate: G6 G11.
- [#25: Should HarnessRouter support persistent harness runtimes instead of spawning a CLI process per turn?](https://github.com/HarnessRouter/harnessrouter/issues/25) [feature request]. Collaborator explains cancellation/process-UID wall and capability negotiation trade-off. No comparative performance measurement establishes a winner. Gate: G6 G5.

## Conductor

Official behaviour inspiration only; no implementation port.

### Choose task workspace and shared checkout deliberately

Official workspaces/parallel-agent docs describe git worktrees/task branches, terminals/diffs/review and .context notes. Independently landable work belongs in separate workspaces; agents reviewing/testing the same branch can share a checkout with explicit collision risk. The current product also advertises cloud/multiplayer; its local docs remain available. Local agents run with operator/provider permissions, and worktree isolation is not a security sandbox. Evidence: [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents), [workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches), [permissions](https://www.conductor.build/docs/reference/security-and-permissions).

Decision: adapt behaviour; reject cloud. Match: [HandoffService.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/HandoffService.ts). Use the existing local handoff and ownership path for an ordinary chat task. Preserve board/review policy and distinguish branch isolation from permission admission. The release repository has changelog/issues only, so no private process/cache implementation or licence grant is inferred. Gates: G1 G4 G5 G10.

### Preserve waiting questions and background outcomes

Public release issues report idle sweeps/restarts losing pending questions or autonomous background work. These are user observations on named older releases, with no maintainer comments in the selected capture. They suggest tests, not confirmation that current Conductor always behaves this way. Evidence: [issue 27](https://github.com/meltylabs/conductor-releases/issues/27), [issue 21](https://github.com/meltylabs/conductor-releases/issues/21).

Decision: build acceptance coverage. Match: [RuntimeItemProjection.ts](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/RuntimeItemProjection.ts). Render pending interactions from durable correlated identity. If the provider exits, show that loss explicitly and provide supported recovery without inventing a runnable approval or replaying unknown work. Gates: G3 G6 G7.

Current selected issues (all open at capture; state/update/version/platform and comment/PR evidence are retained in [selected issue evidence](evidence/competitor-selected-issues.json)):

- [#29: 0.83.0: window renders black for 8-13s on every activation - archived workspaces re-hydrated on the main thread (migration 128 backfill + stale DEPRECATED_archived)](https://github.com/meltylabs/conductor-releases/issues/29) [user report]. Activation takes reported 8–13 s. Reporter infers archived hydration/keychain main-thread cause from opaque binary; private implementation not verified. Gate: G7.
- [#27: AskUserQuestion becomes an unanswerable "AWAITING RESPONSE" zombie: 30-min idle sweep kills the agent process under a pending question](https://github.com/meltylabs/conductor-releases/issues/27) [user report]. Pending AskUserQuestion survives visually after 30 min idle sweep kills process, leaving unanswerable waiting state. No maintainer comments at capture. Gate: G3 G6.
- [#25: Claude Code slash commands are silently swallowed on a session's first message — the injected &lt;system_instruction&gt; block displaces them off offset 0](https://github.com/meltylabs/conductor-releases/issues/25) [user report]. First-message slash command displaced by injected system instruction, with local CLI control reported. No private-source verification. Gate: G11.
- [#24: Bug: OpenCode not usable due to broken permissions request flow](https://github.com/meltylabs/conductor-releases/issues/24) [user report]. Permission notification without an approval card blocks chat. Attached private logs not downloaded; report only. Gate: G5.
- [#21: Background tasks + scheduled wakeups die on session restart with no notification or resume — overnight autonomous runs silently stall](https://github.com/meltylabs/conductor-releases/issues/21) [user report]. Session restart silently loses background tasks and scheduled wakeups in overnight run. Reported duration is not benchmark evidence. Gate: G3 G6.

## Maestri

Official behaviour inspiration only; conditional CoW, reject focus-dependent delivery.

### Make peer routing explicit and context scoped

Official connections docs expose cross-provider skills/CLI messaging and explicit connected peers; cross-workspace names are qualified. However the receiving agent must remain unselected: focusing it stops monitoring and the waiting sender never receives its reply according to the docs. That documented behaviour is unsuitable for a durable parent/child result protocol. Evidence: [connections](https://www.themaestri.app/en/docs/connections), [floors](https://www.themaestri.app/en/docs/floors), [changelog](https://www.themaestri.app/en/changelog).

Decision: adapt identity; reject delivery. Match: [ProviderService.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderService.ts). Persist routing and result receipts on the server. Human focus, window state and stream subscription cannot determine whether a parent receives a result. Notes/progress from agents remain attributed reports, not authoritative runtime state. Gates: G1 G2 G3 G9.

### Separate floor creation from platform acceleration

Official floors docs use git worktrees by default; optional copy-on-write clones can include untracked dependencies/settings/current edits, skip build caches and fall back to ordinary checkout on Windows. PR floors use a read-only copy; git host CLI/auth remain operator supplied. Changelog reports fixes for cloned-floor target cwd, prompt submission, stale git locks and unsafe symlinks/FIFOs. These are vendor-reported fixes, not independently reproduced GitHub issues. Evidence: [connections](https://www.themaestri.app/en/docs/connections), [floors](https://www.themaestri.app/en/docs/floors), [changelog](https://www.themaestri.app/en/changelog).

Decision: conditional. Match: [WorkspaceOwnershipRepository.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Layers/WorkspaceOwnershipRepository.ts). A CoW acceleration option needs measured platform support, exact copy exclusions and explicit secret/.env handling; no performance claim is established. Always validate repository/cwd/path ownership before launch, and never clear an active git lock. Canvas/Swift/remote feature adoption is outside scope. Gates: G4 G5 G7 G12.

Current GitHub issue coverage: public tracker not identified after official site/docs and targeted identity search. Do not replace this gap with similarly named Maestro/RunMaestro projects or vendor changelog entries carrying invented issue IDs.

## Finite acceptance gates

These are proposed checks for the Neokod work plan, not checks executed in this read-only lane. Use recorded provider/tracker fixtures and the smallest existing test boundaries before any optional local integration test.

- G1: Managed child creation from ordinary chat records parent, child, initiator, provider instance, role and workspace before execution. Provider-native observations stay distinguishable. Injected child tools preserve caller identity; top-level tools never invent one.

- G2: Persist command/request/result IDs and acceptance, claim and delivery receipts. Kill after acceptance, after claim, after provider send and before parent acknowledgement. Restart/replay each fixture: no duplicate provider send without replay evidence, no duplicate parent result, and every accepted item is delivered, explicitly failed or visibly uncertain. Register completion before starting a fast child.

- G3: Replay false idle, delayed terminal, disconnect, cancellation, failed restart and stale native-child histories through the shared projection. Idle/prompt focus/provider disconnection alone never proves completion. Authoritative terminal events and times remain server owned; stale or missing evidence remains unknown/orphaned.

- G4: Test parent checkout, separate worktree, nested cwd and invalid/foreign/deleted workspaces. A claimed path has one generation-fenced owner. Handoff waits for the old owner to stop; stale owners cannot mutate or release the new claim. Restore validates repository, branch and nested cwd before any provider starts.

- G5: At initial send, queued follow-up and steer, recompute the effective permission ceiling from provider capabilities and current local policy. Tightening takes effect before delivery; ask stays pending until a correlated human decision; missing capability or decision never expands authority. Existing sandbox/workflow guardrails remain effective.

- G6: Restart only the necessary provider/process scope. Busy sibling threads, pending questions, approvals and background work prevent destructive automatic recovery. Preserve drafts, receipts and pending interaction identity. Distinguish confirmed stop, uncertain stop and failure; never auto-replay an operation that may have run.

- G7: Use deterministic stalled-consumer and fast-producer fixtures: enforce configured event count and retained-payload limits, coalesce adjacent deltas without crossing semantic boundaries, flush before terminal/approval/tool barriers and retain an explicit terminal error. Large-history tail/page queries read bounded data. Measure Neokod before selecting defaults or claiming speed.

- G8: Cancel before, during and after a tool batch; reject malformed tool calls before persistent provider history is poisoned. Preserve executed/uncertain/never-started distinctions and valid call/result relationships. Context usage anchors survive retryable zero-usage errors as stale/unknown evidence. Queue compaction without silently replacing pending user work.

- G9: Governed managed-child waits reject self/ancestor/dependency cycles, bound depth and concurrency and prevent scheduler-wide deadlock. Abort releases ownership only on confirmed exit; parent result delivery is independent of focused UI, network reconnect or window lifecycle.

- G10: Resolve Send Jira ABC-123 to Symphony through the configured server-side connection into connection scope plus canonical native issue ID. Repeated commands share an idempotent claim and durable source/result links. Transfer workspace ownership explicitly; preserve Symphony board/review policy. Agents never receive tracker credentials and no mode switch is required.

- G11: Provider switches classify lifecycle/model/endpoint capabilities explicitly. Cancellation, hard policy refusal, visible output, tool emission and unknown execution block automatic retry or provider hopping. Count physical sends once across retry layers and honour bounded Retry-After. Test switching across supported formats with recorded fixtures.

- G12: Storage failure is visible. Inject DB/lease/artifact-write failures and external path changes: a failed claim cannot admit work, a failed recovery capture cannot claim durability, one runtime owns each live SQLite DB/WAL, and backups/checkpoints are recoverable. Do not weaken path, hard-link or symlink guards to make a test pass.

## Verification and gaps

Read selected implementations, documentation, issue bodies, all retrieved selected-issue comment pages and the linked PR metadata. Captured source tests were inspected but not executed. Paseo fast-child fix PRs 5929/6008 and native-child fix PR5314 remained open and unmerged; bb4795 was closed without merge; OpenCodeX3797/5682/6106/6132 and HarnessRouter346 were merged, with their limited scopes recorded.

No competitor execution, benchmark, package install, actual agent turn, authenticated tracker action, application edit, commit or publication occurred. No Neokod source changes were made, so repository build/typecheck checks were not invoked by this lane; root owns any required integrated checks. Existing dirty Symphony work and report/plan paths were preserved. Conductor source was not identified; direct HTTP docs capture returned 403 but official pages were read with the web tool. Maestri official raw HTML was retained; public code and GitHub tracker were not identified. Omnigent Polly agent.yaml path returned 404 and is not implementation evidence.

Raw source/head/tree/licence evidence is listed in [source manifest](evidence/competitor-source-manifests.json); issue raw bodies/comments and linked fix metadata are listed in [selected issue evidence](evidence/competitor-selected-issues.json). Open issues and unmerged PRs may change after capture. Issue reports indicate acceptance-test scenarios and do not establish universal defects, product rankings or runtime correctness.
