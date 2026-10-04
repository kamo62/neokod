# A-tier performance, product and delivery addendum

This adds 19 finite patterns across all seven apps to the completed source/current-issue review. It reuses the frozen archives and adds 12 issue/comment captures plus current Traycer PR2214 metadata. No competitor or Neokod application was executed, built or modified; no installs, commits or tracker mutations occurred. The performance gates below are proposed measurements and acceptance fixtures, not results or existing requirements. Source, issue and release captures are non-atomic.

Neokod already virtualises the timeline with LegendList, caches settled highlight HTML with a 500-entry/50 MiB budget, uses a 2–6 diff-worker pool and a native per-root FileFinder index with 25,000-entry cap/15-minute idle TTL. Reuse those facilities and measure their actual costs before adding caches, schedulers or workers. Source constants constrain only the representation they account for; they do not establish process RSS, frame rate or input latency.

UI patterns are inspiration for deliberate Neokod-owned components. No upstream UI is to be ported. Remote/hosted/relay/mobile infrastructure stays excluded. Superset’s actual licence is ELv2; direct code reuse requires a separate licence decision. CodexHost is LGPL-3.0. Traycer’s private execution Host remains unavailable.

## OnOrca

Frozen source: [stablyai/orca at 3cc5e1dac659ffd163b81b28261cd843261f4ca5](https://github.com/stablyai/orca/commit/3cc5e1dac659ffd163b81b28261cd843261f4ca5); licence MIT.

### A01: Bound terminal output by consumer credit and queued bytes

Adapt the local flow-control contract.

The multiplex frame sender checks both stream and total outstanding byte windows before sending; source-range admission can reject unverifiable output. Accepted frames advance both counters. When credit is exhausted, output enters a pending queue. Shared defaults set a 512 KiB initial stream window, 2 MiB initial total window, 2 MiB/8 MiB maxima, 256 KiB pending-output cap and 48 KiB chunks. These are explicit budgets rather than an assumption that WebSocket writes drain promptly.

This path is capability-negotiated: ackOutput=false bypasses credit checks. Source-range accounting is another negotiated feature. Sender credit alone does not prove renderer parsing, transport buffering or upstream PTY retention is bounded. Adapt the contract to Neokod’s local terminal; remote/relay infrastructure is excluded. [stablyai/orca #24123](https://github.com/stablyai/orca/issues/24123) is an unconfirmed report of 230 terminal records, 235 tabs, 10,000-line scrollback and image decoding trouble in v1.4.217 on macOS 26.3.2 arm64; it does not establish credit-control failure.

Evidence class: Source constants and admission checks only; no throughput benchmark or local replay was run.

Proposed Neokod acceptance: Proposed fixture: 16 local producers, one consumer stalled for 10 seconds, UTF-8 and split ANSI sequences. Instrument pending bytes, outstanding credits and process RSS; assert every configured bound, correct ordered output or an explicit replay/gap outcome, and no silent drop. Record input p95/p99 and renderer parse-task duration while unstalled; do not count a successful socket send as consumption.

Pinned source and caller: [src/shared/terminal-multiplex-flow-control.ts:1](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/shared/terminal-multiplex-flow-control.ts#L1), [src/main/runtime/rpc/methods/terminal/terminal-multiplex-stream-initialization.ts:28](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/main/runtime/rpc/methods/terminal/terminal-multiplex-stream-initialization.ts#L28), [src/main/runtime/rpc/methods/terminal/terminal-multiplex-frame-delivery.ts:87](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/main/runtime/rpc/methods/terminal/terminal-multiplex-frame-delivery.ts#L87), [src/main/runtime/rpc/methods/terminal/terminal-multiplex-flow-control.ts:203](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/main/runtime/rpc/methods/terminal/terminal-multiplex-flow-control.ts#L203).

Neokod module match: [apps/server/src/terminal/Manager.ts:421](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:421), [apps/web/src/components/ThreadTerminalDrawer.tsx:392](/Users/kamogelo/Code/t3code/apps/web/src/components/ThreadTerminalDrawer.tsx:392).

### A02: Treat scrollback depth, retained bytes and hidden-pane resources separately

Adapt retention policy; investigate resource ownership before adding eviction.

One shared policy normalises live terminal scrollback to 1,000–50,000 rows, default 5,000, and defines a pending-output character cap with a 2 Mi-character floor and 120 characters per configured row. Default terminal options consume that policy; hidden-view reconstruction resolves snapshot rows through the same module so changing tabs does not silently shorten history.

The 17.5/37.5/75 million-byte constants are legacy byte-to-row migration buckets, not current heap caps. Character accounting does not include xterm cells, WebGL textures, Wasm image decoders or every hidden view. [stablyai/orca #24123](https://github.com/stablyai/orca/issues/24123) includes a reporter decoder experiment failing at the 124th decoder in the bundled runtime, while system Node 22 survived 328. That supports a resource-budget acceptance case, not a proven root cause of all reported 635.8% renderer CPU. This source does not prove a complete lazy-image-addon policy.

Evidence class: Source retention bounds; reported CPU and decoder experiment are user evidence, unverified here.

Proposed Neokod acceptance: Proposed fixture: 250 historical terminal records, 100 tab switches and a single very long line. Count live xterm/WebGL/image-addon instances separately from retained text bytes. After repeated switches, resources must return to the declared active-plus-retained budget without losing configured scrollback. Neokod already retains at most 128 inactive server sessions and uses 5,000-line renderer scrollback; line counts must be supplemented by byte and addon-memory measurements.

Pinned source and caller: [src/shared/terminal-scrollback-policy.ts:1](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/shared/terminal-scrollback-policy.ts#L1), [src/renderer/src/lib/pane-manager/pane-terminal-options.ts:31](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/renderer/src/lib/pane-manager/pane-terminal-options.ts#L31), [src/renderer/src/components/terminal-pane/terminal-hidden-restore-scrollback.ts:6](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/renderer/src/components/terminal-pane/terminal-hidden-restore-scrollback.ts#L6).

Neokod module match: [apps/server/src/terminal/Manager.ts:81](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:81), [apps/server/src/terminal/Manager.ts:855](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:855), [apps/web/src/components/ThreadTerminalDrawer.tsx:392](/Users/kamogelo/Code/t3code/apps/web/src/components/ThreadTerminalDrawer.tsx:392).

### A03: Track task freshness independently of worktree links and limit tracker requests

Adapt onto Neokod’s existing delivery adapters.

Linear lookup chooses configured workspace clients, acquires a shared four-request permit, releases it in finally and maps the provider issue with workspace attribution. Explicit-workspace authentication failure is distinguished from trying additional clients. This is a useful identity and concurrency boundary for resolving ordinary-chat delivery requests.

The simple FIFO permit queue has no abort handling or bounded waiting queue in this file and is Linear-specific; it is not a cross-provider rate-limit policy. [stablyai/orca #24247](https://github.com/stablyai/orca/issues/24247) reports v1.4.205 on macOS 26.5.1 showing old task status for 30 minutes or until restart even though a CLI lookup returned fresh Done/updatedAt. Correct linking therefore does not establish live status freshness; no maintainer-confirmed reproduction or fix was captured.

Evidence class: Four concurrent requests is a source limit, not measured tracker latency. Staleness duration is a reporter observation.

Proposed Neokod acceptance: Resolve Linear, GitHub Issues/Projects and Azure Boards through TrackerAdapterRegistry.resolve and the existing configured connection. Test identical display keys in two scopes, token failure, cancellation of queued work, pagination and 429/backoff. Record snapshot fetchedAt/sourceUpdatedAt and prove post-change readback from the same connection; never infer external Done from an agent message or a worktree link.

Pinned source and caller: [src/main/linear/linear-request-concurrency.ts:1](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/main/linear/linear-request-concurrency.ts#L1), [src/main/linear/linear-issue-lookups.ts:33](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/main/linear/linear-issue-lookups.ts#L33), [src/main/linear/client.ts:1](https://github.com/stablyai/orca/blob/3cc5e1dac659ffd163b81b28261cd843261f4ca5/src/main/linear/client.ts#L1).

Neokod module match: [apps/server/src/symphony/Trackers/Registry.ts:72](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Registry.ts:72), [apps/server/src/symphony/Trackers/Adapter.ts:1](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Adapter.ts:1).

New current issue coverage:

| Issue                                                                                                                                                                                   | Current state / updated UTC | Reported version / platform  | Evidence boundary                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [#24123: [Bug]: Opening a workspace with many historical terminals causes high renderer CPU and unhandled Sixel/Wasm allocation failure](https://github.com/stablyai/orca/issues/24123) | open; 2026-09-30T10:48:18Z  | v1.4.217; macOS 26.3.2 arm64 | Unconfirmed detailed user report; no comments; decoder experiment and CPU attribution are separate observations. |
| [#24247: [Bug]: Tasks page keeps a Linear issue's old status after it changes in Linear (e.g. In Review shown after Done)](https://github.com/stablyai/orca/issues/24247)               | open; 2026-10-01T00:31:37Z  | v1.4.205; macOS 26.5.1       | User report plus fresh CLI read; no captured maintainer confirmation/fix.                                        |

## Agent Orchestrator

Frozen source: [Untrivial-ai/agent-orchestrator at b2461dc5955bb11b4ee1213871e6a2157e68da0e](https://github.com/Untrivial-ai/agent-orchestrator/commit/b2461dc5955bb11b4ee1213871e6a2157e68da0e); licence Apache-2.0.

### A04: Coalesce terminal replay while bounding each parser task

Adapt the replay contract, not its pane chrome.

useTerminalSession owns attach/reconnect and gathers the initial replay behind a cover with 60 ms quiet and 750 ms cap timers. A 1 MiB duplicate buffer cap is separate from a 256 KiB xterm write-batch cap. Batches yield between writes and reveal only after parser callbacks; late replay has its own settling interval. Hidden panes continue receiving output and recovery but do not send resize or user input. XtermTerminal supplies the write callback.

A cover can hide intermediate replay paints, but it cannot make an unbounded parser task responsive. Normal live output, server retention and xterm internals require their own bounds. Transport recovery must not create a replacement agent merely because the frontend remounts. [Untrivial-ai/agent-orchestrator #4608](https://github.com/Untrivial-ai/agent-orchestrator/issues/4608) concerns startup process retention rather than direct proof of replay performance.

Evidence class: The hook comment claims a 1,000-line replay formerly painted 25 intermediate frames at 16 ms and one write parsed in about 2 ms. This is an author example, not a benchmark reproduced here; the actual code additionally bounds parser batches.

Proposed Neokod acceptance: Replay a fixed 1 MiB ANSI/Unicode fixture while typing and resizing. Assert parser writes do not exceed the selected batch size, output order and cursor state are preserved, teardown flushes or explicitly cancels pending replay, and reconnect does not spawn a second provider. Record input latency and peak duplicate-buffer bytes before/after using the same xterm and machine.

Pinned source and caller: [frontend/src/renderer/hooks/useTerminalSession.ts:133](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/frontend/src/renderer/hooks/useTerminalSession.ts#L133), [frontend/src/renderer/hooks/useTerminalSession.ts:478](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/frontend/src/renderer/hooks/useTerminalSession.ts#L478), [frontend/src/renderer/components/XtermTerminal.tsx:1654](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/frontend/src/renderer/components/XtermTerminal.tsx#L1654).

Neokod module match: [apps/web/src/components/ThreadTerminalDrawer.tsx:392](/Users/kamogelo/Code/t3code/apps/web/src/components/ThreadTerminalDrawer.tsx:392), [apps/server/src/terminal/Manager.ts:2135](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:2135).

### A05: Serve durable metadata before slow runtime restoration, with bounded recovery

Adapt startup ordering and measure process-retention policy separately.

Daemon startup performs ReconcileStartupSafety before accepting input, then runs ReconcileBackground after its listener is live. Safety reconstructs fences around interrupted operations. Background work lists durable sessions, reconciles live runtimes, reaps leaks and restores shutdown-saved sessions. A configurable ReconcileWorkers bound exists for live recovery. This separates usable persisted project/session metadata from slower worktree and agent recovery.

This is not a fully lazy restart: RestoreAll still walks shutdown-saved sessions and relaunches those with restore markers. [Untrivial-ai/agent-orchestrator #4608](https://github.com/Untrivial-ai/agent-orchestrator/issues/4608) analysed 14 non-terminated Chat sessions in a 0.12.10 nightly on macOS: 13 Codex app-server processes at a burst and roughly 1.15 GiB physical app-tree memory after settling. The issue’s 2.42 GB Activity Monitor attribution is explicitly low-confidence and must not be reported as daemon RSS. The frozen code is later and already has the safety/background split; no evidence captured proves the historical process-memory report fixed.

Evidence class: Startup ordering is source-verified; process counts and memory are reporter measurements, not a run of the frozen SHA.

Proposed Neokod acceptance: Proposed fixture: 100 persisted idle chats, five interrupted operations and one surviving child process. Measure time to metadata-ready separately from runtime-ready. Require zero automatic idle provider launches unless the declared policy requires them; if restoration is required, assert its concurrency bound. Do not expose a writable session until its safety fence is resolved. Record child count and RSS plateau after recovery, not just the parent daemon.

Pinned source and caller: [backend/internal/daemon/daemon.go:756](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/daemon/daemon.go#L756), [backend/internal/daemon/daemon.go:983](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/daemon/daemon.go#L983), [backend/internal/session_manager/manager.go:3394](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/session_manager/manager.go#L3394), [backend/internal/session_manager/manager.go:3600](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/session_manager/manager.go#L3600), [backend/internal/session_manager/manager.go:779](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/session_manager/manager.go#L779).

Neokod module match: [apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:1](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:1), [apps/server/src/terminal/Manager.ts:1184](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:1184).

### A06: Use a narrow delivery-read port and keep PR review policy provider-aware

Reuse Neokod’s richer registry rather than build a Jira-only path.

AO defines Get/List/Preflight as a read-only Tracker port with normalised issue state. A multi-tracker adapter routes by provider key and rejects unknown providers. Daemon wiring registers GitHub and GitLab. Credentials are preflighted by the chosen adapter, and richer provider metadata is deliberately outside the normalised read port.

This source does not demonstrate Linear, Jira, GitHub Projects or Azure DevOps support; IntakeFields explicitly treats Linear/Jira as later scope. [Untrivial-ai/agent-orchestrator #6108](https://github.com/Untrivial-ai/agent-orchestrator/issues/6108) reports GitHub work remaining InReview after merge in 0.13.1 on Ubuntu 26.04.1. A collaborator could not reproduce it; the reporter later mentioned multiple GitHub accounts and unresolved PRs. Do not generalise it into a confirmed transition bug or close an item when any one PR merges.

Evidence class: Architectural source path plus unresolved user report; no polling-cost or transition-latency benchmark.

Proposed Neokod acceptance: For each of Neokod’s seven adapter kinds, test canonical issue reads and configured review/merge policy independently. A multiple-account fixture must use the intended connection and repository. One merged PR among several required PRs must not finish work early. Optional external writes need explicit operation capability, permission and readback; read/probe success does not imply mutation support.

Pinned source and caller: [backend/internal/ports/tracker.go:9](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/ports/tracker.go#L9), [backend/internal/adapters/tracker/multi/tracker.go:1](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/adapters/tracker/multi/tracker.go#L1), [backend/internal/daemon/tracker_wiring.go:99](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/backend/internal/daemon/tracker_wiring.go#L99), [frontend/src/renderer/components/IntakeFields.tsx:26](https://github.com/Untrivial-ai/agent-orchestrator/blob/b2461dc5955bb11b4ee1213871e6a2157e68da0e/frontend/src/renderer/components/IntakeFields.tsx#L26).

Neokod module match: [apps/server/src/symphony/Trackers/Registry.ts:72](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Registry.ts:72), [apps/server/src/symphony/Trackers/Adapter.ts:1](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Adapter.ts:1).

New current issue coverage:

| Issue                                                                                                                                                        | Current state / updated UTC | Reported version / platform                         | Evidence boundary                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#4608: bug(chat): eager startup restore causes resource spike and severe desktop lag](https://github.com/Untrivial-ai/agent-orchestrator/issues/4608)       | open; 2026-10-01T14:03:09Z  | 0.12.10-nightly.202608280852; macOS Darwin 27 arm64 | User profiling; collaborator discussion. 2.42 GB parent attribution explicitly low-confidence; frozen later startup split is not proven runtime fix. |
| [#6108: [Bug]: Despite merging all the PRs, the GitHub task is still marked as ‘in review’.](https://github.com/Untrivial-ai/agent-orchestrator/issues/6108) | open; 2026-10-02T11:06:21Z  | 0.13.1; Ubuntu 26.04.1 deb                          | Collaborator could not reproduce; multiple-account/unresolved-PR conditions mentioned by reporter.                                                   |

## CodexHost

Frozen source: [BytePioneer-AI/codex-host at 49d8b1c6a3d70ca9ea2024d688e68847e66dd163](https://github.com/BytePioneer-AI/codex-host/commit/49d8b1c6a3d70ca9ea2024d688e68847e66dd163); licence LGPL-3.0.

### A07: Expose history summaries and stable cursors, but bound storage work too

Adapt the response contract; do not copy its in-memory cost model.

External history supports notLoaded/summary/full item views, stable ID cursors, forward/backward traversal, a default page of 25 and maximum 100. app-server-host selects listExternalTurns or listExternalItems for the public method. Invalid cursors and limits produce explicit request errors rather than silently returning an arbitrary subset.

The caller first materialises external history turns. Item listing flattens all turn items and can reverse/filter full arrays before applying the limit. A 100-item response is therefore not proof of bounded backend CPU or memory. History consistency under concurrent append, rewinds and deleted anchors needs its own contract. No newly captured current issue directly corroborates this performance path.

Evidence class: Page limits are source facts; no large-history timings were measured.

Proposed Neokod acceptance: Use a 10,000-turn fixture, then append/rewind while walking both directions. Require no missing/duplicate IDs under the documented snapshot policy and bounded page payload. Instrument SQL rows read, allocation and projection work, not only response size. Reuse Neokod’s page-bounded event/snapshot paths; introduce storage pagination only where the caller still loads a full transcript.

Pinned source and caller: [packages/host-runtime/src/external-thread-history.ts:3](https://github.com/BytePioneer-AI/codex-host/blob/49d8b1c6a3d70ca9ea2024d688e68847e66dd163/packages/host-runtime/src/external-thread-history.ts#L3), [packages/host-runtime/src/external-thread-history.ts:96](https://github.com/BytePioneer-AI/codex-host/blob/49d8b1c6a3d70ca9ea2024d688e68847e66dd163/packages/host-runtime/src/external-thread-history.ts#L96), [packages/host-runtime/src/app-server-host.ts:4225](https://github.com/BytePioneer-AI/codex-host/blob/49d8b1c6a3d70ca9ea2024d688e68847e66dd163/packages/host-runtime/src/app-server-host.ts#L4225).

Neokod module match: [apps/server/src/orchestration/Services/OrchestrationEngine.ts:26](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Services/OrchestrationEngine.ts:26), [apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:1](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:1), [apps/web/src/components/chat/MessagesTimeline.tsx:485](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx:485).

### A08: Show draft capabilities without starting a provider process

Adapt provenance-labelled metadata reads; keep packaging as a separate gate.

A draft command catalog starts from adapter static commands, then inspects already loaded sessions matching harness and resolved workspace, and finally falls back to the last live catalog cache. The cache has at most 64 harness/workspace entries and ignores catalogs with no additional live commands. Inspection does not launch a new process simply to populate a menu.

The cache is memory-only and keyed by harness plus resolved cwd, not account, executable revision or configuration generation. Refresh occurs when another live session reports a catalog; lookup itself does not establish current availability. Label cached/static capabilities and invalidate on changed provider identity. LGPL-3.0 conditions apply to direct reuse. [BytePioneer-AI/codex-host #310](https://github.com/BytePioneer-AI/codex-host/issues/310) is a separate Windows 11 v0.9.0 report of Defender quarantining codexhost.exe after install/update. It does not corroborate catalog speed or establish the binary benign.

Evidence class: Source process-avoidance path and cache count; no measured startup reduction. Packaging report is unconfirmed.

Proposed Neokod acceptance: Open 100 draft chats and capability menus with providers configured but idle: require zero provider launches caused by inspection, and label static/cached/live provenance. Changing account, binary or workspace configuration must invalidate or mark stale the previous cache. Separately validate signed release/update artefact identity, expected launch-path existence and actionable integrity errors using Neokod’s existing updater; never prescribe antivirus exclusions as the fix.

Pinned source and caller: [packages/host-runtime/src/live-command-catalog-cache.ts:5](https://github.com/BytePioneer-AI/codex-host/blob/49d8b1c6a3d70ca9ea2024d688e68847e66dd163/packages/host-runtime/src/live-command-catalog-cache.ts#L5), [packages/host-runtime/src/app-server-host.ts:3347](https://github.com/BytePioneer-AI/codex-host/blob/49d8b1c6a3d70ca9ea2024d688e68847e66dd163/packages/host-runtime/src/app-server-host.ts#L3347), [packages/host-runtime/src/app-server-host.ts:3350](https://github.com/BytePioneer-AI/codex-host/blob/49d8b1c6a3d70ca9ea2024d688e68847e66dd163/packages/host-runtime/src/app-server-host.ts#L3350).

Neokod module match: [apps/desktop/src/updates/DesktopUpdates.ts:1](/Users/kamogelo/Code/t3code/apps/desktop/src/updates/DesktopUpdates.ts:1), [apps/desktop/src/main.ts:1](/Users/kamogelo/Code/t3code/apps/desktop/src/main.ts:1).

New current issue coverage:

| Issue                                                                                                                                                                                  | Current state / updated UTC | Reported version / platform               | Evidence boundary                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| [#310: [Suggestion] Sign Windows executables (Authenticode) — Defender false positive (Wacapew.A!ml) breaks startup on 0.9.0](https://github.com/BytePioneer-AI/codex-host/issues/310) | open; 2026-09-25T03:04:08Z  | v0.9.0; Windows 11 Home China build 26200 | Defender quarantine report; no comments; benign false-positive claim not established. |

## Hermes

Frozen source: [NousResearch/hermes-agent at 64ad33e32dadbdb462468c7384aa38e5c99a1b7a](https://github.com/NousResearch/hermes-agent/commit/64ad33e32dadbdb462468c7384aa38e5c99a1b7a); licence MIT.

### A09: Restore idle background throttling after active work settles

Evaluate against Neokod’s desktop policy and server-owned work projection.

Hermes registers every chat window with one stream-throttle controller. Merged renderer active-work reports disable Chromium background throttling while any turn is in flight; a 5-second trailing delay restores default throttling after work stops. A native-Wayland fullscreen exception is explicitly platform-gated. The same merged signal feeds keep-awake policy.

One active turn unthrottles the entire chat-window fleet, so inactive windows can still consume resources. Renderer reports must clear on reload/crash; they are not authoritative evidence that backend work finished. Preserve server-owned unknown/busy state in Neokod. [NousResearch/hermes-agent #131998](https://github.com/NousResearch/hermes-agent/issues/131998) describes an idle long-history freeze, so this throttling controller must not be presented as its fix.

Evidence class: A source comment reports roughly 20% CPU for an idle hidden Hermes window before the policy change. No independent benchmark artefact or measurement of the frozen source was run.

Proposed Neokod acceptance: Measure foreground/hidden/minimised CPU and wake-ups with 20 idle chats, then one active stream and final flush. Assert the idle policy returns after its declared trailing interval, no final output or notification is stranded, and crashed-window activity is cleared. Record OS/Electron/Wayland backend and battery mode; keep suspend/resume time separate from event-loop stall timing.

Pinned source and caller: [apps/desktop/electron/stream-throttle.ts:1](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/apps/desktop/electron/stream-throttle.ts#L1), [apps/desktop/electron/main.ts:18156](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/apps/desktop/electron/main.ts#L18156).

Neokod module match: [apps/desktop/src/main.ts:1](/Users/kamogelo/Code/t3code/apps/desktop/src/main.ts:1), [apps/web/src/notifications/ActivityNotificationCoordinator.tsx:315](/Users/kamogelo/Code/t3code/apps/web/src/notifications/ActivityNotificationCoordinator.tsx:315).

### A10: Search canonical history with bounded indexed projections and explicit source scope

Adapt query/projection behaviour without hiding child workstreams.

Search selects small hit projections rather than complete conversations, adds direct session-ID lookup, deduplicates lineage roots and runs database search off the asyncio event loop. Search supports source inclusion/exclusion, roles and session time bounds. FTS reads have a canonical-row fallback for stale/corrupt indexes and a bounded unindexed-gap supplement during rebuild; oversized tool bodies use bounded indexing and explicit full-body tool search.

Fallback LIKE scans can be materially slower. The gap supplement only tops up an underfilled result page and does not prove globally correct rank merging for every partially rebuilt index. Offset pagination and lineage overfetch are not an exhaustive stable-cursor history walk. [NousResearch/hermes-agent #108003](https://github.com/NousResearch/hermes-agent/issues/108003) reports A2A/cron cluttering recents; comments show existing exclusion controls and another hard-excluded ACP source. This is a scope/visibility contract problem as well as indexing, not a reason to hide all agent children.

Evidence class: Source routing and bounds only; 35%/66% A2A proportions and a second 227/628 report are user dataset observations, not general product benchmarks.

Proposed Neokod acceptance: Test 100,000 message rows with Latin/CJK, oversized tool results, archived/rewound records, parent/child lineage and an interrupted rebuild. Verify result scope and deliberate discoverability of nested workstreams, IDs and snippets, while measuring first-page p95 and loop lag separately. Make recents, search and unread counters consume one explicit inclusion policy; preserve unknown last-active evidence.

Pinned source and caller: [hermes_state_search.py:1062](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/hermes_state_search.py#L1062), [hermes_state_search.py:1145](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/hermes_state_search.py#L1145), [hermes_cli/web_routers/sessions.py:395](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/hermes_cli/web_routers/sessions.py#L395).

Neokod module match: [apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:1](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:1), [apps/web/src/components/chat/MessagesTimeline.tsx:196](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx:196).

### A11: Coalesce layout measurement and gate CSS writes on actual changes

Build within Neokod-owned composer and timeline components.

One shared ResizeObserver groups entries by handler, rather than constructing one observer per bubble/hook. The composer observes only relevant size changes, tracks emptiness/newline edges rather than every keystroke and buckets height CSS variables to 8 pixels. Cleanup removes each observed element when its last handler leaves.

Batching observers does not eliminate all read/write layout feedback. [NousResearch/hermes-agent #131998](https://github.com/NousResearch/hermes-agent/issues/131998) reports a 55-second, 5,474-notification ResizeObserver storm in packaged Windows v0.21.5+3828.g801a902 with 1,465 messages/2.08 million characters, despite the reporter’s build containing the earlier #100215 guard. No minimal reproduction or maintainer confirmation was captured. The reporter explicitly corrected a second apparent freeze to Windows Modern Standby; do not combine sleep gaps with the observer storm.

Evidence class: Source comment gives an author sash-drag profile: five session tiles/about 100 bubbles, 2,600 callbacks over 40 pointer moves and 977 ms script time before shared batching. This is author evidence, not our run or proof of the later issue fixed.

Proposed Neokod acceptance: Use a 1,500-message idle history and a streaming history, resize/sash-drag at normal and fractional zoom, and type a long wrapped draft. Count observer delivery, handler calls, style/layout writes and long tasks. Assert no self-sustaining observer loop after input ends, bounded mounted rows and stable scroll anchoring. Measure the existing LegendList path before adding a new observer abstraction.

Pinned source and caller: [apps/desktop/src/hooks/use-resize-observer.ts:22](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/apps/desktop/src/hooks/use-resize-observer.ts#L22), [apps/desktop/src/app/chat/composer/hooks/use-composer-metrics.ts:53](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/apps/desktop/src/app/chat/composer/hooks/use-composer-metrics.ts#L53), [apps/desktop/src/app/chat/composer/hooks/use-composer-metrics.ts:130](https://github.com/NousResearch/hermes-agent/blob/64ad33e32dadbdb462468c7384aa38e5c99a1b7a/apps/desktop/src/app/chat/composer/hooks/use-composer-metrics.ts#L130).

Neokod module match: [apps/web/src/components/chat/ChatComposer.tsx:1](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/ChatComposer.tsx:1), [apps/web/src/components/chat/MessagesTimeline.tsx:485](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx:485).

New current issue coverage:

| Issue                                                                                                                                                                                                                             | Current state / updated UTC | Reported version / platform                                        | Evidence boundary                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#108003: Desktop sidebar recents + session search should be able to exclude A2A sessions](https://github.com/NousResearch/hermes-agent/issues/108003)                                                                            | open; 2026-10-03T19:45:27Z  | Desktop v2026.9.24 plus about 2,091 commits in comment; macOS      | Feature/visibility report with another user dataset; existing backend source filters do not prove complete desktop controls.                                                                    |
| [#131998: [Bug]: Desktop window completely dead for 55s — 5,474 "ResizeObserver loop" notifications at a constant 100/s on a long session (reproduces after #100215)](https://github.com/NousResearch/hermes-agent/issues/131998) | open; 2026-10-03T04:00:34Z  | v0.21.5+3828.g801a902; Windows 11; Electron 40.10.2; Python 3.14.7 | Detailed reported logs; no comments/minimal reproduction; earlier observer guard present according to reporter, later fix not established. Second event explicitly corrected to Modern Standby. |

## Superset

Frozen source: [superset-sh/superset at c711aa02da3f5625a49c58ec4035eea57b87df0a](https://github.com/superset-sh/superset/commit/c711aa02da3f5625a49c58ec4035eea57b87df0a); licence Elastic License 2.0 (ELv2).

### A12: Bound filesystem fan-out and attach work, while keeping watcher ownership stable

Independently build the relevant backend behaviour; ELv2 reuse is conditional.

FsWatcherManager shares an attach per root, bounds remembered file paths to 10,000 and buffered events to 30,000, drains chunks of 500 with 200 ms pacing and limits concurrent nested-repository scans to four with a 3-second scan deadline. Overflow recovery uses paced rescans and generation checks. Host WatchAttachGuard serialises attaches per resolved root and backs off failed native attachments from 30 seconds to 30 minutes. Single-visible-file watches coalesce change notifications and reattach only when an atomic replacement changes the inode.

Directory-path hints are uncapped and stated to be small; that assumption must be tested on generated directory trees. Last-listener release immediately disposes a recursive watcher, so repeated subscription changes can cause new scans. [superset-sh/superset #7877](https://github.com/superset-sh/superset/issues/7877) reports v1.30.2 Linux with about 23,300 inotify watches per worktree and burst recrawls after switches/hover; the sole automated github-actions bot comment is code triage, not human runtime reproduction. Earlier #7860/#7865 cost/thread changes do not by themselves solve ownership churn.

Evidence class: Source budgets; 377,000 watch-related calls and filesystem counts are reporter measurements. No watcher benchmark was run here.

Proposed Neokod acceptance: Use a 25,000-file/5,000-directory repository, ten roots, 100 focus switches, branch checkout and event overflow. Count attaches, full scans, native handles, queued events and per-root fairness. Ordinary focus changes should not recreate the root watcher; final owner disposal must release handles. Assert explicit overflow recovery without stale descendant search results and maximum scan concurrency. Apply the same scheduling scrutiny to GitManager status/fetch work, with local status and remote calls measured separately.

Pinned source and caller: [packages/workspace-fs/src/watch.ts:33](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/packages/workspace-fs/src/watch.ts#L33), [packages/workspace-fs/src/watch.ts:345](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/packages/workspace-fs/src/watch.ts#L345), [packages/host-service/src/runtime/filesystem/watch-attach-guard.ts:1](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/packages/host-service/src/runtime/filesystem/watch-attach-guard.ts#L1), [packages/host-service/src/runtime/filesystem/filesystem.ts:40](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/packages/host-service/src/runtime/filesystem/filesystem.ts#L40), [packages/workspace-fs/src/watch-file.ts:1](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/packages/workspace-fs/src/watch-file.ts#L1), [packages/host-service/src/events/event-bus.ts:591](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/packages/host-service/src/events/event-bus.ts#L591).

Neokod module match: [apps/server/src/workspace/WorkspaceSearchIndex.ts:15](/Users/kamogelo/Code/t3code/apps/server/src/workspace/WorkspaceSearchIndex.ts:15), [apps/server/src/git/GitManager.ts:1](/Users/kamogelo/Code/t3code/apps/server/src/git/GitManager.ts:1).

### A13: Render only visible file-diff sections and estimate variable height

Neokod-owned design inspiration; measure the existing diff workers first.

VirtualizedFileList uses a measured variable-height virtualizer over changed files, estimated heights that account for collapsed files, and overscan of one. InfiniteScrollView’s ordered sections and commit section supply file/category/worktree context; only virtual items instantiate FileDiffSection. This bounds mounted diff sections rather than rendering every changed file at once.

This does not prove per-file diff parsing, source fetches or hidden editor instances are bounded. A giant visible diff can still be expensive. Superset uses ELv2; do not copy UI components or assume permissive redistribution. No new selected issue directly verifies this renderer’s throughput.

Evidence class: Source mount policy, not a measured FPS result.

Proposed Neokod acceptance: Load 2,000 changed files plus one 100,000-line file. Measure mounted diff sections, worker queue length, tokenisation work, heap and input/scroll latency. Assert mounted work follows the viewport budget; expanding a huge file must remain cancellable and show a deliberate plain/limited view when beyond the configured budget. Neokod already has a 2–6 worker pool, 240 AST cache entries and a 1,000-character tokenised-line limit; verify and tune those existing facilities rather than introduce another pool.

Pinned source and caller: [apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/VirtualizedFileList/VirtualizedFileList.tsx:23](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/VirtualizedFileList/VirtualizedFileList.tsx#L23), [apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/InfiniteScrollView/hooks/useOrderedSections/useOrderedSections.tsx:70](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/InfiniteScrollView/hooks/useOrderedSections/useOrderedSections.tsx#L70), [apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/InfiniteScrollView/components/CommitSection/CommitSection.tsx:56](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/InfiniteScrollView/components/CommitSection/CommitSection.tsx#L56).

Neokod module match: [apps/web/src/components/DiffWorkerPoolProvider.tsx:48](/Users/kamogelo/Code/t3code/apps/web/src/components/DiffWorkerPoolProvider.tsx:48), [apps/web/src/components/DiffPanel.tsx:1](/Users/kamogelo/Code/t3code/apps/web/src/components/DiffPanel.tsx:1).

### A14: Keep native tasks usable independently of external delivery connections

Build deliberately in Neokod’s ordinary chat and Symphony board.

At the frozen SHA, TasksView explicitly selects tasks, linear and issues source tabs. Native tasks render BoardContent/TableContent independently of the LinearIssuesContent tab; search uses a deferred query and URL/store synchronisation cancels pending navigation when filters change. This separates internal work from connection-specific data and keeps filter changes from snapping input to stale route state.

[superset-sh/superset #7892](https://github.com/superset-sh/superset/issues/7892) is still open and reports no-Linear users seeing a connection CTA despite CLI-visible tasks. Its automated bot cites an older isLinearConnected gate. That gate is absent in our frozen TasksView; the report is historical/unconfirmed for this SHA, and changed source does not establish a shipped fix or close the issue. Hosted authentication/OAuth/trpc infrastructure is excluded. External issue support shown here is not evidence of GitHub Projects or Azure Boards adapters.

Evidence class: Source behaviour and version boundary only; no typing latency or runtime task visibility test was executed.

Proposed Neokod acceptance: With no tracker connected, ordinary chat, nested workstreams and native work remain usable. Connect any one of Neokod’s seven adapter kinds without hiding the others’ local work. Debounced search/filter navigation must reject stale responses after scope changes. Repeat identical display IDs across scopes and ensure selection, board status and notifications all use canonical identity. Existing Symphony review/merge policy remains authoritative.

Pinned source and caller: [apps/desktop/src/renderer/routes/\_authenticated/\_dashboard/tasks/components/TasksView/TasksView.tsx:78](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/apps/desktop/src/renderer/routes/_authenticated/_dashboard/tasks/components/TasksView/TasksView.tsx#L78), [apps/desktop/src/renderer/routes/\_authenticated/\_dashboard/tasks/components/TasksView/TasksView.tsx:324](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/apps/desktop/src/renderer/routes/_authenticated/_dashboard/tasks/components/TasksView/TasksView.tsx#L324), [apps/desktop/src/renderer/routes/\_authenticated/\_dashboard/tasks/components/TasksView/TasksView.tsx:357](https://github.com/superset-sh/superset/blob/c711aa02da3f5625a49c58ec4035eea57b87df0a/apps/desktop/src/renderer/routes/_authenticated/_dashboard/tasks/components/TasksView/TasksView.tsx#L357).

Neokod module match: [apps/server/src/symphony/Trackers/Registry.ts:72](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Registry.ts:72), [apps/server/src/symphony/HandoffService.ts:490](/Users/kamogelo/Code/t3code/apps/server/src/symphony/HandoffService.ts:490).

New current issue coverage:

| Issue                                                                                                                                                                              | Current state / updated UTC | Reported version / platform                                  | Evidence boundary                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#7877: [perf] Linux: every workspace switch and sidebar hover re-crawls the whole worktree (bursts to 377k inotify watches)](https://github.com/superset-sh/superset/issues/7877) | open; 2026-09-26T12:10:40Z  | v1.30.2; Linux; issue main SHA 2370f60d                      | Reported watcher counts/churn; only github-actions[bot] source triage, not human runtime reproduction; current source still releases last listener immediately. |
| [#7892: Tasks view hides native tasks when Linear is not connected](https://github.com/superset-sh/superset/issues/7892)                                                           | open; 2026-09-27T20:50:38Z  | Issue cites previous TasksView source; frozen c711aa differs | Historical report still open; automated bot source triage. Claimed isLinearConnected gate is absent in frozen source; no shipped fix claim.                     |

## Oh My Pi

Frozen source: [can1357/oh-my-pi at 6d8552d7f9df1852826923f07f0eed4fe29511f3](https://github.com/can1357/oh-my-pi/commit/6d8552d7f9df1852826923f07f0eed4fe29511f3); licence MIT.

### A15: Cache reusable filesystem walks by full semantics and invalidate mutations

Compare with the existing Neokod index before adapting a cache.

The native walker cache keys root plus full walk options, stores owned entry vectors before caller-specific filtering and permits sharing only for native local filesystems. Defaults are one-second TTL, 200 ms empty-result recheck, 16 entries and 64 MiB estimated payload. Cache hits clone outside the mutex; cancellation is checked before/after, and generation fencing prevents scans started before invalidation from reinserting stale data. Autocomplete opts in; write/delete/rename helpers invalidate paths, with both rename sides covered.

The payload estimate excludes some heap overhead and caller clones. TTL expiry is lazy, not a background eviction guarantee. Provider-backed filesystems bypass this cache, and grep is deliberately uncached. Direct native astEdit does not call the JavaScript invalidation helpers; its host must invalidate successfully written native paths. Do not cache a search result under only a cwd when ignore/symlink/metadata semantics differ. No new issue establishes this cache’s speed or stale-result correctness; [can1357/oh-my-pi #12423](https://github.com/can1357/oh-my-pi/issues/12423) concerns TUI input/scroll latency.

Evidence class: Source limits and architecture document; suggested benchmark commands in docs were not executed. This remains an unmeasured opportunity for Neokod.

Proposed Neokod acceptance: Neokod already owns a per-root native FileFinder index with 25,000-entry limit and 15-minute idle TTL. First instrument repeated autocomplete/index requests rather than add a second cache. Test changing ignore files, symlink roots, write/delete/rename during an in-flight scan and an empty directory gaining its first file. Require no stale generation admitted, matching cached/uncached answers, bounded queue/concurrency and measured total heap including clones.

Pinned source and caller: [docs/fs-scan-cache-architecture.md:1](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/docs/fs-scan-cache-architecture.md#L1), [crates/pi-walker/src/cache.rs:119](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/crates/pi-walker/src/cache.rs#L119), [crates/pi-walker/src/cache.rs:428](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/crates/pi-walker/src/cache.rs#L428), [packages/tui/src/autocomplete.ts:36](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/packages/tui/src/autocomplete.ts#L36), [packages/coding-agent/src/tools/fs-cache-invalidation.ts:1](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/packages/coding-agent/src/tools/fs-cache-invalidation.ts#L1).

Neokod module match: [apps/server/src/workspace/WorkspaceSearchIndex.ts:15](/Users/kamogelo/Code/t3code/apps/server/src/workspace/WorkspaceSearchIndex.ts:15).

### A16: Pace differential rendering from measured frame cost and output backlog

Adapt budgeting ideas to web/terminal rendering, not TUI appearance.

The ordinary TUI scheduler combines a 30 FPS minimum cadence with an adaptive floor derived from twice the previous frame cost, capped to avoid a single spike locking the interface. Input grace participates in the delay; native frames use terminal credit pacing instead. Frames compose a bounded viewport and record cost on every execution path. Forced startup rendering is a deliberate separate path.

This is not a promise of 60 FPS, nor a replacement for reducing expensive per-frame work. Different provider/terminal protocols can have different paint acknowledgement semantics. [can1357/oh-my-pi #12423](https://github.com/can1357/oh-my-pi/issues/12423) is a v18.2.5 Windows 11/Bun 1.3/VS Code 1.121 report of typing lag and stutter after about 30 turns. The reporter’s near-60-FPS expectation is a target, not a measured benchmark. Frozen later source is not proof of a confirmed fix.

Evidence class: Cadence and feedback formula are source facts; neither before/after FPS nor input latency was measured.

Proposed Neokod acceptance: Capture input-to-paint p95/p99, long-task time, frame cost and queued output in a fixed 30/300/3,000-turn fixture with a noisy background stream. Coalesce low-priority progress updates under pressure while keeping input and authoritative completion/cancel events responsive and ordered. Publish the chosen duty-cycle/latency targets before tuning. Current evidence does not justify adding OMP’s Rust/TUI renderer to Neokod.

Pinned source and caller: [packages/tui/src/tui.ts:892](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/packages/tui/src/tui.ts#L892), [packages/tui/src/tui.ts:2525](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/packages/tui/src/tui.ts#L2525), [packages/tui/src/tui.ts:2629](https://github.com/can1357/oh-my-pi/blob/6d8552d7f9df1852826923f07f0eed4fe29511f3/packages/tui/src/tui.ts#L2629).

Neokod module match: [apps/web/src/components/chat/MessagesTimeline.tsx:196](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx:196), [apps/web/src/components/ThreadTerminalDrawer.tsx:392](/Users/kamogelo/Code/t3code/apps/web/src/components/ThreadTerminalDrawer.tsx:392).

New current issue coverage:

| Issue                                                                                                                                          | Current state / updated UTC | Reported version / platform                     | Evidence boundary                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#12423: TUI: Severe typing lag and scrolling stutter in long sessions on Windows (v18.2.5)](https://github.com/can1357/oh-my-pi/issues/12423) | open; 2026-09-30T21:05:03Z  | v18.2.5; Windows 11 x64; Bun 1.3; VS Code 1.121 | Unconfirmed typing/scroll report after 30+ turns; desired near-60 FPS is not measured FPS; later source cadence is 30 FPS for ordinary row renderer. |

## Traycer

Frozen source: [traycerai/traycer at 745704377226b576d92b80ba421466e5c7a71fa9](https://github.com/traycerai/traycer/commit/745704377226b576d92b80ba421466e5c7a71fa9); licence MIT.

### A17: Size highlight caches by retained representation and stop expensive oversized blocks

Validate Neokod’s existing cache; private Host performance remains unknown.

The public GUI has one theme-aware Shiki engine and caches settled React highlight trees keyed by theme/language/content fingerprint. Its MRU cache estimates ten bytes per generated HTML character and enforces a 128 MiB estimated budget. Oversized entries are excluded and blocks over 100,000 source characters fall back to plain display. Engine-load failure clears the in-flight latch so a later attempt can retry.

The estimate is not a measured process-heap cap; React trees differ materially from strings. Highlighting is synchronous on the caller path and the first uncached large block can still block. Streaming intermediates should not enter the settled cache. Public source does not expose the private execution Host’s storage/indexing or scheduling. No newly selected issue directly establishes highlight-cache performance.

Evidence class: Source estimated budget and cutoff; comments about earlier retained memory are author observations, not reproduced heap profiles.

Proposed Neokod acceptance: Neokod already caches highlighted HTML with a 500-entry/50 MiB budget and avoids settled-cache writes for streaming blocks. Replay fixed small/large code blocks across theme changes and 100 history switches; measure actual heap after GC, cache estimates and first-uncached long tasks. Assert oversized/streaming policy and cache-key theme correctness, and reuse the existing highlighter/diff workers when profiling shows blocking.

Pinned source and caller: [clients/gui-app/src/markdown/shiki-highlight-cache.ts:42](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/markdown/shiki-highlight-cache.ts#L42), [clients/gui-app/src/markdown/traycer-streaming-highlighter.ts:106](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/markdown/traycer-streaming-highlighter.ts#L106), [clients/gui-app/src/markdown/shiki-highlighter.ts:12](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/markdown/shiki-highlighter.ts#L12).

Neokod module match: [apps/web/src/components/ChatMarkdown.tsx:122](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatMarkdown.tsx:122), [apps/web/src/components/ChatMarkdown.tsx:647](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatMarkdown.tsx:647).

### A18: Make bulk selection semantics explicit across history pages

Build selection correctness with cancellation and a bounded operation.

The frozen History panel has independently paginated data, next-page loading and local selection. selectAllVisible sets IDs from selectableItemIds rather than collecting every server page. Delete eligibility and worktree-sweep eligibility are distinct, so a selected history item is not automatically a deletable or locally owned workspace.

[traycerai/traycer #1950](https://github.com/traycerai/traycer/issues/1950) reports Select All selecting only loaded history. The linked PR #2214 proposes walking all matching pages while preserving eligibility and cancelling on query/identity/refresh/unmount. Its current capture is open and unmerged, updated 2026-09-28; the author’s 202 affected tests and an action_required CI gate are not a passed CI result. A fetch-all fix can itself be unbounded; do not port it mechanically. Private Host deletion semantics remain unavailable.

Evidence class: Source selection behaviour and current PR metadata; no performance measurements or deletion were run.

Proposed Neokod acceptance: Define the action as either “select loaded” or “select all matching” in Neokod-owned design. For 10,000 history items across pages, change query/account while selection loads and inject a page failure. Require no stale-scope IDs, duplicate IDs, silently partial “all” result or destructive work before a concrete target set is resolved. Measure pages/bytes/time and support cancellation; server-side bounded bulk operations may be better than loading every body.

Pinned source and caller: [clients/gui-app/src/components/epics/epics-list-panel.tsx:371](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/components/epics/epics-list-panel.tsx#L371), [clients/gui-app/src/components/epics/epics-list-panel.tsx:593](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/components/epics/epics-list-panel.tsx#L593), [clients/gui-app/src/components/epics/epics-list-panel.tsx:627](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/components/epics/epics-list-panel.tsx#L627), [clients/gui-app/src/hooks/home/use-history-query.ts:1](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/hooks/home/use-history-query.ts#L1).

Neokod module match: [apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:87](/Users/kamogelo/Code/t3code/apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:87).

### A19: Separate notification delivery receipts from unresolved work

Adapt bounded dedupe and identity fencing; do not infer server resolution.

Public client display receipts scope delivery to user, notification ID and updatedAt, retain at most 512 notification IDs/eight versions, and increment a user generation when cleared so stale in-flight delivery can be rejected. NotificationEmissionController records a foreground display receipt and merges displayed state. Completion receipts have separate occurrence/host identities and bounded retention.

Display/seen receipts are local suppression evidence, not authoritative resolution of a human-needed event. localStorage scans and synchronous writes have cost and failure modes. [traycerai/traycer #2029](https://github.com/traycerai/traycer/issues/2029) reports a browser.human.needed row remaining unresolved after lane deletion, with read/cleared markers insufficient to clear the badge. User SQL analysis and a second user/agent verification are not maintainer runtime reproduction. The relevant private Host deletion/resolution implementation cannot be inspected; no fix is established.

Evidence class: Source receipt caps and unresolved user report; no notification throughput or private Host query timing was measured.

Proposed Neokod acceptance: Reuse ActivityNotificationCoordinator and Symphony NotificationCoordinator with canonical operation/occurrence IDs. Replay duplicate and newer-version completion events, reload, clear receipts, switch identity and delete a child lane while a genuine parent interview remains pending. Require one user-visible delivery per occurrence, no stale-identity delivery, and correct unresolved-work count from the server projection. A read badge must never complete work or silently resolve an approval.

Pinned source and caller: [clients/gui-app/src/lib/notifications/app-local-display-receipts.ts:7](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/lib/notifications/app-local-display-receipts.ts#L7), [clients/gui-app/src/components/layout/bridges/notification-emission-controller.tsx:40](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/components/layout/bridges/notification-emission-controller.tsx#L40), [clients/gui-app/src/lib/notifications/app-local-completion-receipts.ts:1](https://github.com/traycerai/traycer/blob/745704377226b576d92b80ba421466e5c7a71fa9/clients/gui-app/src/lib/notifications/app-local-completion-receipts.ts#L1).

Neokod module match: [apps/web/src/notifications/ActivityNotificationCoordinator.tsx:315](/Users/kamogelo/Code/t3code/apps/web/src/notifications/ActivityNotificationCoordinator.tsx:315), [apps/server/src/symphony/NotificationCoordinator.ts:1](/Users/kamogelo/Code/t3code/apps/server/src/symphony/NotificationCoordinator.ts:1).

New current issue coverage:

| Issue                                                                                                                                                                          | Current state / updated UTC | Reported version / platform       | Evidence boundary                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [#1950: “Select All” on History page only selects loaded items](https://github.com/traycerai/traycer/issues/1950)                                                              | open; 2026-09-27T22:52:08Z  | No exact release version captured | User report corroborated by frozen selectAllVisible path. PR2214 remains open/unmerged; author test count is not passed CI. |
| [#2029: browser.human.needed notification survives lane deletion — permanent 'Task waiting for your approval' badge on epic](https://github.com/traycerai/traycer/issues/2029) | open; 2026-09-20T19:45:16Z  | No exact release version captured | User local SQL investigation and follow-up; private Host resolution code unavailable; no maintainer-confirmed fix.          |

## General work-delivery integration

Neokod already registers GitHub Issues, Jira, Linear, GitLab, Asana, Azure Boards and GitHub Projects. Use that configured registry for ordinary-chat work delivery, for example “Send Linear ENG-123 to Symphony”, “Send Azure Boards item 456 to Symphony” or “Send this GitHub Projects item to Symphony”. AO’s small read port and OnOrca’s workspace-attributed lookup are useful boundaries; they do not justify another delivery framework or a Jira-only implementation.

Resolve a configured connection/scope and an opaque provider item ID server-side before submission. Preserve the original human message ID/text, source thread, canonical item identity, claim/idempotency key and eventual result link. Project display keys and URLs are locators, not globally unique IDs. Existing HandoffService currently creates manual work IDs; the completed source review already identifies its ordinary-chat canonicalisation/idempotency gap. This addendum does not repeat that audit or implement a repair.

Represent adapter availability, identity, snapshot freshness and operation capability separately. Listing/reading/probing credentials is not permission to create a ticket, post a comment, change board status or merge a PR. GitHub Projects field/status mutations, Azure Boards work-item patch semantics and Linear workflow states differ and should remain inside provider adapters. Honour configured Symphony review/merge policy; multiple linked PRs and multiple accounts are explicit cases. Refresh provider state after an authorised write and show unknown/stale evidence honestly.

Proposed delivery acceptance is a finite matrix of the seven registered kinds: same visible key in two scopes; opaque ID normalisation; lost/duplicate pagination; cancelled queued reads; 429/backoff; stale credential generation; unavailable optional mutation; duplicate ordinary-chat submission; restart before/after durable acceptance; provider change after claim. Verify exactly one canonical work item and result link, stable workspace ownership, correct board projection and no external operation outside the declared capability/permission. Test with deterministic adapter fixtures first; no authenticated tracker operation was performed in this research.

Competitor delivery coverage is intentionally uneven: OnOrca has Linear plus other tracker-specific modules covered in the original review; AO wiring here is GitHub/GitLab and explicitly leaves Linear/Jira intake for later; Superset frozen UI has native/Linear/issues surfaces but hosted OAuth/trpc is excluded. CodexHost, Hermes, Oh My Pi and the available public Traycer source do not establish a general Linear/GitHub Projects/Azure DevOps work-delivery adapter equivalent in the reviewed paths. AI Azure OpenAI or GitLab Duo providers are not Azure Boards or GitLab work-tracker support. These are evidence gaps, not a reason to narrow Neokod’s existing seven-kind scope.

## Measurement and delivery boundary

Freeze each future fixture, OS/runtime version, machine, dataset size and budgets before comparison. Report p95/p99 input and first-page latency, long tasks, CPU/wake-ups, actual process-tree RSS/heap, buffer bytes, live terminal addons, watcher handles, full scans, worker queue depth and provider process count. Use one quiet baseline and one sustained background-work case. Source timers and limits, author profiles and user issue measurements remain separate evidence classes.

The addendum’s proposed fixtures cover all requested areas: frontend/desktop/terminal rendering (A01/A04/A09/A11/A13/A16/A17), memory (A02/A05/A07/A15/A17), large histories/search/indexing (A07/A10/A15/A18), filesystem/git scheduling (A12/A15), startup/packaging (A05/A08), notifications/workspace UX (A14/A18/A19), and general delivery adapters (A03/A06/A14 plus the matrix above). No implementation, performance result, native continuity, packaged-release fix or private-Host guarantee is claimed.

Raw bodies/comments and their capture intervals are preserved in addendum-issues/. Every cited frozen and local source file has a content hash in [structured evidence](evidence/competitor-a-product-patterns.json). PR2214 is open/unmerged in its separate metadata capture. Full initial issue coverage and Synara independent validation remain in their completed canonical files; neither was repeated.
