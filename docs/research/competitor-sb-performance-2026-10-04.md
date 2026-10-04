# Performance and product extension: S/B competitors, 2026-10-04

This extends the completed source/issue review with 18 additional concrete patterns across all eight assigned apps. It is read-only research. Every Neokod change and acceptance gate below is proposed, unimplemented and unrun. The frozen repository SHAs and original review remain authoritative; only extra files at those SHAs and five additional current issue/comment threads were read. No competitor app, provider or tracker action was executed.

Neokod already uses LegendList with structural row sharing for chat, virtualised file/model surfaces, a 25,000-entry workspace-index cap, terminal resize/subscription ownership, scoped persisted drafts and activity-notification baselines. These proposals target measured gaps in those paths. They do not reintroduce a mobile app, relay/cloud control plane or copy upstream UI. Narrow-width responsive web and desktop-native proof are separate from Android/iOS app proof. Competitor architectures may inform an independently designed Neokod surface.

The six source repositories retain their frozen licences: Omnigent and HarnessRouter Apache-2.0, OpenCodeX, bb and Pi MIT, and Paseo's root Apache-2.0 with its stated exceptions. No licence grant or private implementation is inferred for Conductor or Maestri. Consult the original source manifest before reuse; these are design comparisons, not code-copy recommendations.

## Omnigent

### O-P1: Refresh the visible session scope without reopening every page

Evidence: [web/src/hooks/useScopeCache.ts](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/web/src/hooks/useScopeCache.ts#L1); caller/ownership path: [web/src/hooks/useSidebarData.tsx](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/web/src/hooks/useSidebarData.tsx#L40).

Observed: Initial, refresh and next-page fetches have distinct ownership. Refresh waits for a pending page before choosing a capped refresh window; disabling a scope cancels its query, while re-entry joins an existing refresh. Archived snapshots are loaded when that scope is enabled.

Limit: The refresh cap does not cap all retained pages or total memory. Omnigent viewer mine/shared keys are not a reason to restore hosted authentication in Neokod.

Neokod proposal: Keep sidebar and palette query ownership scoped to the local environment/project and requested active/archive window. Refresh visible summaries before deferred history; preserve selected IDs through refresh. Relevant seams: [apps/web/src/components/CommandPalette.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/CommandPalette.tsx), [apps/web/src/components/ChatView.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatView.tsx).

Proposed acceptance: With 200 archived and 20 active threads, count cold-open/return requests and bytes separately; no unsolicited archived detail hydration. Switch scopes 100 times with delayed responses: zero old-scope results, duplicate concurrent refreshes or selected-ID losses.

### O-P2: Terminal renderer fallback with explicit teardown

Evidence: [web/src/components/blocks/TerminalSession.ts](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/web/src/components/blocks/TerminalSession.ts#L322); caller/ownership path: [web/src/components/blocks/TerminalView.tsx](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/web/src/components/blocks/TerminalView.tsx#L530).

Observed: TerminalSession loads an optional WebGL addon, disposes it on context loss and falls back when loading fails. Its dispose path releases the socket, observers, data/clipboard handlers, renderer and xterm. TerminalView owns construction.

Limit: Source comments claiming faster rendering are not measurements. GPU acceleration can cost memory and fail; disposing the UI does not prove the underlying PTY was stopped. Clipboard limits and recent-input trust checks must survive renderer changes.

Neokod proposal: Profile the existing xterm surface before considering an optional renderer. Keep one terminal owner, renderer fallback and idempotent cleanup; preserve the existing 5,000-line scrollback cap. Relevant seams: [apps/web/src/components/ThreadTerminalDrawer.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/ThreadTerminalDrawer.tsx), [apps/web/src/state/terminalSessions.ts](/Users/kamogelo/Code/t3code/apps/web/src/state/terminalSessions.ts).

Proposed acceptance: Run the same ANSI/Unicode output fixture with renderer enabled, unavailable and context-lost. Across 100 attach/detach cycles, live subscription/listener counts return to baseline; input, selection, links and final screen remain correct. Record GPU/RSS and input p95, not only FPS.

### O-P3: Notify from distinct attention transitions

Evidence: [web/src/hooks/useIdleNotifications.ts](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/web/src/hooks/useIdleNotifications.ts#L112); caller/ownership path: [web/src/shell/AppShell.tsx](https://github.com/omnigent-ai/omnigent/blob/5fae3371a7f9786b9e95ab9ea1038b6227d82872/web/src/shell/AppShell.tsx#L536). Issue context: [#6205](https://github.com/omnigent-ai/omnigent/issues/6205).

Observed: The hook tracks unread/attention baselines, pending-input and idle transitions, defers some notifications, cancels a deferred notification when activity resumes and routes clicks to a conversation. Sound deduplication is present in frozen source.

Limit: The hook’s idle body says the agent finished; idle alone cannot prove successful completion. Open issue #6205 asks for configurable event sounds, but cannot establish that this source has no sound support.

Neokod proposal: Extend the existing coordinator only with Neokod-owned event preferences and meaningful pending/input/error/settled labels. Reuse authoritative runtime projection, hydration baselines and scope identities. Relevant seams: [apps/web/src/notifications/ActivityNotificationCoordinator.tsx](/Users/kamogelo/Code/t3code/apps/web/src/notifications/ActivityNotificationCoordinator.tsx), [apps/web/src/notifications/activityNotifications.logic.ts](/Users/kamogelo/Code/t3code/apps/web/src/notifications/activityNotifications.logic.ts).

Proposed acceptance: Replay approval, input request, retry, compaction, settle, reconnect and hydration. Exactly one eligible notification per new event; zero completion notifications during retry/compaction, zero retrospective hydration alerts, correct scoped click target. Check muted, denied and browser gesture-required sound states.

## Paseo

### P-P1: Stable history windows and search anchors

Evidence: [packages/app/src/agent-stream/history-window.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/agent-stream/history-window.ts#L1), [packages/app/src/agent-stream/use-stream-history-window.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/agent-stream/use-stream-history-window.ts#L1), [packages/app/src/agent-stream/web-virtualization.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/agent-stream/web-virtualization.ts#L1); caller/ownership path: [packages/app/src/agent-stream/strategy-web.tsx](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/agent-stream/strategy-web.tsx#L274). Issue context: [#4408](https://github.com/getpaseo/paseo/issues/4408).

Observed: The history window starts with a recent slice and expands to a user-message boundary. Its hook retains an item-ID boundary, reveals local older history before fetching remote history, and resets if the boundary disappears. The web strategy virtualises older entries above a threshold and keeps the recent region mounted.

Limit: A whole user turn and recent region can still be large. Web DOM virtualization does not bound server history IO, raw retained data or native Android Fabric allocations. #4408 contains native OOM reports and user experiments, not a proven Neokod/web cause.

Neokod proposal: Preserve Neokod’s existing LegendList and structural sharing. Add bounded history acquisition and stable message/sequence anchors only where profiling shows unbounded retained history or broken search jumps. Relevant seams: [apps/web/src/components/chat/MessagesTimeline.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx), [apps/web/src/components/ChatView.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatView.tsx).

Proposed acceptance: Use 10,000 rows including one 50,000-character streamed turn. Search an unloaded message, prepend/reconnect and resize at 390px and desktop widths: exact target and viewport position survive; count mounted nodes, rows retained, response bytes and JS/native heaps separately. No claim of a native mobile fix without a native reproduction.

### P-P2: Terminal snapshot lifetime and resize claims

Evidence: [packages/app/src/terminal/runtime/workspace-terminal-session.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/terminal/runtime/workspace-terminal-session.ts#L20), [packages/app/src/terminal/runtime/terminal-stream-controller.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/terminal/runtime/terminal-stream-controller.ts#L37), [packages/app/src/components/terminal-resize-debouncer.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/components/terminal-resize-debouncer.ts#L8); caller/ownership path: [packages/app/src/terminal/hooks/use-workspace-terminal-session-retention.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/terminal/hooks/use-workspace-terminal-session-retention.ts#L7), [packages/app/src/components/terminal-emulator.tsx](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/components/terminal-emulator.tsx#L468), [packages/app/src/terminal/runtime/terminal-emulator-runtime.ts](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b12dde8b70a619483e/packages/app/src/terminal/runtime/terminal-emulator-runtime.ts#L612).

Observed: Workspace snapshots are keyed by scope/terminal, pruned against known terminal IDs and dropped at zero scope references. StreamController fences terminal ID/disposal, releases the previous subscription and distinguishes snapshot, restore and output. The resize debouncer preserves the latest dimensions while OR-ing claim flags. The emulator/runtime are the actual rendering and resize path; retention hook owns scope references.

Limit: Referenced snapshots have no demonstrated byte budget. The inspected emulator/runtime path is not proof that every platform wires the same debouncer or StreamController; those exported contracts are separately reviewed. Retention is not process shutdown.

Neokod proposal: Audit existing terminal subscription ownership and resize RAF batching before adding code. Retain only required local screen snapshots, with an explicit byte/age budget and active-session exceptions visible. Relevant seams: [apps/web/src/components/ThreadTerminalDrawer.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/ThreadTerminalDrawer.tsx), [apps/web/src/state/terminalSessions.ts](/Users/kamogelo/Code/t3code/apps/web/src/state/terminalSessions.ts).

Proposed acceptance: Across 100 scope/tab switches and 100 resize bursts, no old-terminal output appears, no subscription survives its owner, and the final dimensions and explicit claim are delivered. Pruned/released snapshot bytes return to zero; active pins are reported rather than hidden behind a count cap.

## bb

### B-P1: Evict inactive opened-thread caches

Evidence: [apps/app/src/hooks/cache-owners/thread-open-cache-owner.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/app/src/hooks/cache-owners/thread-open-cache-owner.ts#L16); caller/ownership path: [apps/app/src/hooks/queries/thread-queries.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/app/src/hooks/queries/thread-queries.ts#L981).

Observed: Opening a timeline touches an LRU-style set owned per QueryClient. It uses limits of 20 threads or 8 for a coarse pointer and removes inactive timeline/bootstrap queries; active queries survive. Open-cache GC is one hour.

Limit: Active exceptions mean this is not a hard total-memory cap. Coarse-pointer detection is an interaction hint, not a RAM measurement. Counting threads also ignores radically different transcript sizes.

Neokod proposal: Measure Neokod retained closed-thread data independently of mounted virtual rows. If needed, give transcript/detail caches one owner and evict inactive data by bytes/age as well as recency; report active pins. Relevant seams: [apps/web/src/components/chat/MessagesTimeline.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx), [apps/web/src/components/ChatView.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatView.tsx).

Proposed acceptance: Open 100 transcripts of two distinct sizes then revisit the first. Inactive retained bytes remain within a predeclared budget, active contents are not evicted, and a cache miss refetches correctly. Separate settled heap retention from DOM row counts and server snapshots.

### B-P2: Current-query search results and precise message jumps

Evidence: [apps/app/src/lib/command-palette/palette-thread-search.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/app/src/lib/command-palette/palette-thread-search.ts#L1), [apps/app/src/lib/command-palette/palette-thread-search-window.ts](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/app/src/lib/command-palette/palette-thread-search-window.ts#L1); caller/ownership path: [apps/app/src/components/commands/ThreadSearchPaletteMode.tsx](https://github.com/get-bb/bb/blob/4d15c1da0a848fa4834c1e5d0480a0891683bbe9/apps/app/src/components/commands/ThreadSearchPaletteMode.tsx#L106). Issue context: [#4413](https://github.com/get-bb/bb/issues/4413).

Observed: The palette gates responses on the current debounced query, separates title and message matches, carries source sequence anchors and windows matched text with Unicode-safe highlight boundaries. It offers recent active/archive groups before searchable input.

Limit: Text with no match is returned whole by the snippet helper; this is not a universal payload bound. #4413’s closed, unmerged prototype reports responsiveness gains but unchanged SQL cost and a cold-search regression. Some follow-up probes are explicitly agent-generated; they are not independent human reproduction.

Neokod proposal: Keep query generations, stable result IDs and message anchors. Extend filesystem acceleration at the existing index, which already caps 25,000 entries and reports truncation. If future conversation FTS blocks the server, measure SQL/IO and event-loop responsiveness before choosing a worker. Stream independently ready mention providers only where caller contracts support it. Relevant seams: [apps/web/src/components/CommandPalette.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/CommandPalette.tsx), [apps/web/src/components/CommandPalette.logic.ts](/Users/kamogelo/Code/t3code/apps/web/src/components/CommandPalette.logic.ts), [apps/web/src/lib/composerPathSearchState.ts](/Users/kamogelo/Code/t3code/apps/web/src/lib/composerPathSearchState.ts), [apps/server/src/workspace/WorkspaceSearchIndex.ts](/Users/kamogelo/Code/t3code/apps/server/src/workspace/WorkspaceSearchIndex.ts).

Proposed acceptance: On a 10,000-path workspace, issue rapidly changing queries and one 20ms/one 1,600ms provider. Zero stale selectable results; fast results publish without the slow provider. Repeat after create/rename/delete and scope changes. Record cold/warm search p95, discovery scans, FTS cost, server health latency and truncated coverage separately; a responsiveness improvement cannot excuse an unreported cold-search regression.

## Pi

### I-P1: Share model refresh while retaining caller cancellation

Evidence: [packages/coding-agent/src/modes/interactive/model-catalog-refresh.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/modes/interactive/model-catalog-refresh.ts#L46); caller/ownership path: [packages/coding-agent/src/modes/interactive/components/model-selector.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/modes/interactive/components/model-selector.ts#L192).

Observed: A WeakMap scopes one refresh to each model runtime. Callers share it, can abort their own wait independently, and abort the underlying refresh only when no waiters remain. Identity checks protect cleanup from newer requests.

Limit: This is not evidence that all remote catalogue loads are cached indefinitely or that a provider’s advertised model is installed, authenticated or executable locally.

Neokod proposal: Keep Neokod instance-scoped availability and virtualised model rows. If simultaneous settings/picker refreshes duplicate work, coalesce by provider-instance generation and preserve per-caller cancellation plus explicit unavailable/error states. Relevant seams: [apps/server/src/provider/Services/ProviderRegistry.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderRegistry.ts), [apps/web/src/components/chat/ModelPickerContent.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/ModelPickerContent.tsx).

Proposed acceptance: With 20 concurrent refresh callers for one instance, exactly one underlying refresh; aborting one caller does not abort the others. All-caller abort cancels work; an instance/config generation change rejects old results. Two instances with the same model slug remain distinct.

### I-P2: Move image work off the interactive path with an explicit fallback

Evidence: [packages/coding-agent/src/utils/image-resize.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/utils/image-resize.ts#L26), [packages/coding-agent/src/utils/image-resize-worker.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/utils/image-resize-worker.ts#L1); caller/ownership path: [packages/coding-agent/src/core/tools/read.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/core/tools/read.ts#L115), [packages/coding-agent/src/utils/image-process.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/utils/image-process.ts#L72).

Observed: The read tool invokes processImage, which invokes resizing. A worker receives a copied transferable buffer, reports message/error/exit and is terminated in finally. Bun packaging and URL worker loading have fallbacks; the last fallback runs in process.

Limit: The copy can increase peak memory; each job creates a worker and the inspected code supplies no global queue or cancellation budget. In-process fallback can block. This is source architecture, not measured throughput or a Neokod attachment defect.

Neokod proposal: Profile attachment decode/resize and large preview work at the actual current boundary. Use a bounded worker queue only for demonstrated expensive CPU work; expose failed/unsupported conversion and clean cancelled buffers instead of treating fallback as free. Relevant seams: [apps/server/src/attachmentStore.ts](/Users/kamogelo/Code/t3code/apps/server/src/attachmentStore.ts), [apps/server/src/imageMime.ts](/Users/kamogelo/Code/t3code/apps/server/src/imageMime.ts), [apps/web/src/composerDraftStore.ts](/Users/kamogelo/Code/t3code/apps/web/src/composerDraftStore.ts).

Proposed acceptance: Compare 20 matched runs with the same large JPEG/PNG and four simultaneous jobs, including worker-load failure and cancellation. Record event-loop/input p95, wall time, peak retained buffers and RSS; enforce a declared concurrency/byte budget and verify output dimensions, MIME and unchanged caller input bytes.

### I-P3: Wait for settled activity before terminal notifications

Evidence: [packages/coding-agent/examples/extensions/notify.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/examples/extensions/notify.ts#L1); caller/ownership path: [packages/coding-agent/examples/extensions/notify.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/examples/extensions/notify.ts#L1). Issue context: [#9807](https://github.com/earendil-works/pi/issues/9807).

Observed: The example extension subscribes to agent_settled rather than agent_end, because retries, compaction and follow-up work can still be pending. It sends terminal notification escape protocols or a platform-specific notification.

Limit: An example extension is not durable delivery, permission handling or an independently verified OS implementation. Do not interpolate arbitrary agent text into shell commands. #9807’s later AI-assisted benchmark points to repeated extension session projection; it does not establish a universal core-renderer bottleneck.

Neokod proposal: Use Neokod’s server-owned settled/runtime state for notifications. Measure full-history projections and third-party extension/subscriber work separately from rendering before changing LegendList or adding broad memoisation. Relevant seams: [apps/web/src/notifications/activityNotifications.logic.ts](/Users/kamogelo/Code/t3code/apps/web/src/notifications/activityNotifications.logic.ts), [apps/web/src/notifications/ActivityNotificationCoordinator.tsx](/Users/kamogelo/Code/t3code/apps/web/src/notifications/ActivityNotificationCoordinator.tsx), [apps/web/src/components/chat/MessagesTimeline.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx).

Proposed acceptance: One terminal settled notification after retry/compaction chains, none on intermediate end events. Compare identical long-history interactive fixtures with optional subscribers on/off and streaming/cache-miss states; record projection call counts and time per frame. Cached results must invalidate on actual history/model/config revisions.

## OpenCodeX

### X-P1: Defer hidden dashboard load and distinguish host visibility

Evidence: [desktop/src-tauri/src/startup.rs](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/desktop/src-tauri/src/startup.rs#L1595), [gui/src/host-visibility.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/gui/src/host-visibility.ts#L30), [gui/src/visibility-poll.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/gui/src/visibility-poll.ts#L57); caller/ownership path: [desktop/src-tauri/src/startup.rs](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/desktop/src-tauri/src/startup.rs#L1642), [desktop/src-tauri/src/window.rs](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/desktop/src-tauri/src/window.rs#L136). Issue context: [#5493](https://github.com/lidge-jun/opencodex/issues/5493).

Observed: A ready login-started hidden shell can remain on the small startup surface until open_dashboard is requested; navigation is guarded per run. Native show/hide publishes host visibility, and the web predicate combines it with document visibility. The shared poll helper stops interval timers while hidden and sends a make-up tick when visible.

Limit: Tauri details are not Electron drop-ins. immediate:true still invokes the helper callback while hidden, and async callback overlap is not prevented by this helper. #5493 remains open: owner comments report merged implementation, while attach-time/background-request measurement gates remain outstanding.

Neokod proposal: Profile Neokod’s existing desktop creation/load path (show:false already exists). Separate hidden shell bootstrap from heavy inactive UI hydration where useful; use Electron-owned visibility plus document visibility for optional presentation polling. Keep server jobs, health/reconnect and required notification observation alive. Relevant seams: [apps/desktop/src/window/DesktopWindow.ts](/Users/kamogelo/Code/t3code/apps/desktop/src/window/DesktopWindow.ts), [apps/desktop/src/app/DesktopLifecycle.ts](/Users/kamogelo/Code/t3code/apps/desktop/src/app/DesktopLifecycle.ts), [apps/web/src/notifications/ActivityNotificationCoordinator.tsx](/Users/kamogelo/Code/t3code/apps/web/src/notifications/ActivityNotificationCoordinator.tsx).

Proposed acceptance: Twenty matched cold and warm starts with 200 archived threads: measure process-ready, first actionable frame, attach time, requests and CPU. During a five-minute hidden period, presentation-only polls emit zero repeated requests; resume produces one fresh update, without duplicate timers or stopped agent/engine work. Verify actual packaged Electron platforms separately.

### X-P2: Budget owned cache bytes and preserve summary coverage

Evidence: [src/lib/app-owned-memory.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/lib/app-owned-memory.ts#L212), [src/server/management/usage-summary-cache.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/server/management/usage-summary-cache.ts#L1); caller/ownership path: [src/server/management/logs-usage-routes.ts](https://github.com/lidge-jun/opencodex/blob/06841165f884a9176d701310638b2112aca7a514/src/server/management/logs-usage-routes.ts#L242).

Observed: Registered stores expose retained/pinned/evictable bytes; budget enforcement evicts app-owned entries. Usage cache identity includes file identity, read limit, overlay version and time zone. Filtered summaries bypass the unfiltered cache; incomplete/truncated coverage is carried explicitly.

Limit: JSON byte estimates and registered stores are not a hard RSS ceiling. Snapshot failures becoming zero are a source caveat, not a pattern to copy. OpenCodeX budgets are not measured appropriate Neokod budgets; unknown memory must remain unknown.

Neokod proposal: Add byte observability only at demonstrated expensive owned caches, using existing ownership boundaries. Include scope/config/file revisions in keys, distinguish pinned bytes, unknown estimates and truncated input, and prevent filtered responses contaminating broad views. Relevant seams: [apps/web/src/components/chat/MessagesTimeline.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx), [apps/web/src/components/files/FilePreviewPanel.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/files/FilePreviewPanel.tsx), [apps/server/src/workspace/WorkspaceSearchIndex.ts](/Users/kamogelo/Code/t3code/apps/server/src/workspace/WorkspaceSearchIndex.ts).

Proposed acceptance: Open/close 100 large histories/previews and invalidate a file/config while a computation is pending. Report retained owned bytes and RSS separately; inactive entries meet a declared budget, active pins/unknown estimates are visible, stale generations never publish and truncated inputs never claim complete coverage.

## HarnessRouter

### H-P1: Expose effective model settings and partial capabilities

Evidence: [ui/src/components/HarnessSettings.tsx](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/ui/src/components/HarnessSettings.tsx#L185); caller/ownership path: [ui/src/components/HarnessSettings.tsx](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/ui/src/components/HarnessSettings.tsx#L550).

Observed: The settings surface consumes server model catalogue, runtime defaults and supported base-harness capabilities. Partially installed plugins can remain visible without presenting unavailable detail controls; empty/default choices can reflect effective server defaults.

Limit: The component proves source wiring, not successful installation or executable provider/model combinations. HarnessRouter’s supported provider set is not Neokod’s provider matrix.

Neokod proposal: Keep model ID, provider instance, configured override, effective default and reason unavailable distinct. Explain inherited defaults and expose capabilities per installed/authenticated instance; retain meaningful partial/unknown states. Relevant seams: [apps/server/src/provider/Services/ProviderRegistry.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderRegistry.ts), [apps/web/src/components/chat/ModelPickerContent.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/ModelPickerContent.tsx), [apps/web/src/providerModels.ts](/Users/kamogelo/Code/t3code/apps/web/src/providerModels.ts).

Proposed acceptance: Exercise missing CLI, unsupported option, unauthenticated instance, refresh failure and same-slug models from two instances. Displayed effective defaults match server snapshots; unsupported choices cannot be submitted; failed refresh does not silently fabricate availability.

### H-P2: Truthful stopped states and explicit preview limits

Evidence: [ui/src/lib/conversation.ts](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/ui/src/lib/conversation.ts#L420), [ui/src/components/FilePreview.tsx](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/ui/src/components/FilePreview.tsx#L55); caller/ownership path: [ui/src/components/TaskChat.tsx](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/ui/src/components/TaskChat.tsx#L600), [ui/src/components/FilePreview.tsx](https://github.com/HarnessRouter/harnessrouter/blob/2826cf633b0588fa494da20fdf2828deacfb7e79/ui/src/components/FilePreview.tsx#L1).

Observed: TaskChat labels an incomplete turn as stopped before finishing and adds only a known max-step/timeout/interruption reason. Conversation state periodically reconciles busy conversations against authoritative turns. FilePreview selects by MIME, exposes loading/error/unsupported conversion and lazily imports spreadsheet parsing.

Limit: Reconciliation intervals may overlap and retained conversation maps have no established byte bound. A code preview slices after full text download; spreadsheets parse whole buffers. The alive flag prevents some state updates but does not establish abort/buffer/object-URL cleanup for every late result. Do not present these as solved large-file performance.

Neokod proposal: Preserve unknown completion reasons and reconcile missed terminal events through existing semantic projections. Keep Neokod preview virtualization; if needed, bound transfer/decode before rendering, cancel superseded previews and show explicit unavailable/truncated states. Relevant seams: [apps/web/src/components/chat/MessagesTimeline.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx), [apps/web/src/components/files/FilePreviewPanel.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/files/FilePreviewPanel.tsx), [docs/architecture/state-and-evidence.md](/Users/kamogelo/Code/t3code/docs/architecture/state-and-evidence.md).

Proposed acceptance: Drop the terminal SSE event, delay reconciliation, then close/switch a preview during a large binary/text response. No false success or invented stop reason; at most one reconciliation in flight per scope; zero late cross-file results or object-URL leaks. Track transfer bytes, parsed cells, retained bytes and mounted rows separately.

## Conductor

### C-P1: Capability-aware agent modes and project setup

Evidence: [agent-modes](https://www.conductor.build/docs/concepts/agent-modes), [configure-your-project](https://www.conductor.build/docs/configure-your-project).

Observed: Official docs distinguish mode support by agent and model, and separate reviewed project settings from local overrides. Setup/run/archive scripts follow the project toolchain with workspace-specific ports.

Limit: No public implementation was identified. Mode support, startup cost and script behaviour were not executed here; documentation does not establish internal caching. Project instructions and scripts are not authorised to run by this research.

Neokod proposal: Use Neokod’s real instance capabilities to show applicable modes and defaults. Show the origin of repository, local and server configuration; plan workspace setup as an explicit local operation rather than silently running arbitrary imported scripts. Relevant seams: [apps/web/src/components/chat/ModelPickerContent.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/ModelPickerContent.tsx), [apps/server/src/provider/Services/ProviderRegistry.ts](/Users/kamogelo/Code/t3code/apps/server/src/provider/Services/ProviderRegistry.ts), [apps/server/src/symphony/Trackers/SettingsOverlay.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/SettingsOverlay.ts).

Proposed acceptance: A configuration-origin matrix and every locally supported provider/mode combination round-trip without hidden override changes. Unsupported modes show a reason. A 200-archived-workspace startup fixture must establish hydration/request costs locally; Conductor user complaints alone cannot identify its private startup cause.

### C-P2: Navigate review evidence and deliver results to the owning system

Evidence: [diff-viewer](https://www.conductor.build/docs/reference/diff-viewer).

Observed: Official docs describe file/commit diff navigation, line-specific feedback, review-comment handling, checks and guided pull-request creation.

Limit: This is a documented workflow, not inspected diff architecture or measured rendering performance. Neokod owns its UI. GitHub review delivery does not establish tracker mutation support elsewhere.

Neokod proposal: Create Neokod-owned navigation from work item to changed file, run/check evidence and existing delivery target. Preserve line/revision anchors and offer only adapter/SCM-supported result actions; use the seven-tracker intake below. Relevant seams: [apps/web/src/components/files/FilePreviewPanel.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/files/FilePreviewPanel.tsx), [apps/server/src/symphony/Trackers/Adapter.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Adapter.ts), [apps/server/src/symphony/Trackers/Registry.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Registry.ts).

Proposed acceptance: For each supported tracker, a result retains source identity, local run and SCM revision. Unsupported comment/status/PR actions remain explicit. A stale diff anchor never attaches feedback to a different revision; delivery has receipts or an explicit failed/unknown result, not a silent success.

## Maestri

### M-P1: Search addressable local targets with explicit platform coverage

Evidence: [batuta-search](https://www.themaestri.app/en/docs/batuta-search), [workspaces](https://www.themaestri.app/en/docs/workspaces).

Observed: Official docs describe a keyboard palette across named targets/workspaces, contextual actions and focus restoration. Workspace docs describe macOS Spotlight integration for terminal/note content, with different Windows coverage.

Limit: No public implementation source or issue tracker was identified. These pages do not establish an index algorithm, resource bound or an instant-start benchmark. OS indexing can expose sensitive local content and requires deliberate scope/opt-in rules.

Neokod proposal: Improve Neokod-owned keyboard navigation using qualified project/thread/file targets and contextual available actions. Keep history-content indexing separate from existing path search; expose indexed coverage and exclusions. Treat OS indexing as optional per-platform work, not a portable prerequisite. Relevant seams: [apps/web/src/components/CommandPalette.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/CommandPalette.tsx), [apps/server/src/workspace/WorkspaceSearchIndex.ts](/Users/kamogelo/Code/t3code/apps/server/src/workspace/WorkspaceSearchIndex.ts).

Proposed acceptance: Two identical names in different projects remain distinguishable; Escape restores prior focus; stale targets cannot receive an action. On a 10,000-entry fixture, measure ranking/search p95 and cold index cost, show truncated/unindexed coverage and verify excluded secret paths are absent. Do not claim Windows supports a macOS-only feature.

### M-P2: Preserve scoped drafts and pasted payload identity

Evidence: [prompt-composer](https://www.themaestri.app/en/docs/prompt-composer).

Observed: Official docs describe target-aware mentions, folded large-paste tokens and drafts retained across target switches. Composer input can pass through when empty for terminal interactions.

Limit: Documented folding thresholds are UI policy, not a safe storage/transport cap. No implementation, memory measurement, durable acknowledgement or provider support was independently proved.

Neokod proposal: Build on Neokod’s existing scoped persisted draft store and terminal-context placeholders. Keep folded content tied to an immutable payload identity and undo/cut behaviour; clear the correct draft only after accepted submission, with target-specific capabilities. Relevant seams: [apps/web/src/composerDraftStore.ts](/Users/kamogelo/Code/t3code/apps/web/src/composerDraftStore.ts), [apps/web/src/lib/terminalContext.ts](/Users/kamogelo/Code/t3code/apps/web/src/lib/terminalContext.ts), [apps/web/src/components/ChatView.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatView.tsx).

Proposed acceptance: Switch 100 scoped drafts, restart, paste/edit/cut/undo a large payload and fail/retry submission. No target crossover, payload loss or premature clearing. Compare retained draft/image bytes and persistence latency; keyboard approvals reach the intended terminal only when the composer contract permits them.

## Current issue evidence and proof limits

The five new raw issues and all captured comment pages are in `addendum/issue-details`, indexed by `addendum/issue-capture.json`. These supplement the original 36 selected issues; they do not change the previous whole-tracker ledger or pretend to be a refreshed census.

| App / issue     | Current thread interpretation                                                                                                                                                                                                            | What is not established                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omnigent #6205  | Open feature request for distinct sound events and preferences; frozen source already contains sound/attention handling.                                                                                                                 | No proof that current source lacks audio, and no independent reproduction of a performance fault.                                                                     |
| Paseo #4408     | Open native Android OOM reports with device/version-specific logs and later user experiments on modified builds.                                                                                                                         | No maintainer-confirmed single allocation cause, controlled universal fix or Neokod responsive-web regression.                                                        |
| bb #4413        | Open investigation with explicitly agent-generated material; prototype PR #4402 is described as closed/unmerged. Matched fixture distinguishes responsiveness gains from unchanged SQL and a cold-search regression.                     | No shipped prototype, retained original Mac benchmark, independent human reproduction of every proposed frontend race or portable production gain.                    |
| OpenCodeX #5493 | Open tracking issue. Owner comments report merged #5682 hidden-load/package work and #5742 visibility polling; frozen source independently confirms the reviewed hidden-load/visibility paths. Remaining measurement gates are explicit. | This review did not rerun packaged-shell E2E or independently inspect #5742 PR metadata; owner-reported merge state is kept separate from direct source verification. |
| Pi #9807        | Open lag report. Later AI-assisted synthetic settled-frame work attributes much measured cost to an extension's repeated history projection; a contributor asks for a no-extension control.                                              | No interactive no-extension isolation, streaming/cache-miss result or general core-renderer root cause; competitor benchmark values are not Neokod gains.             |

## Capability-aware intake and delivery beyond Jira

Neokod already registers all seven kinds below in [Registry.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Registry.ts). The current [Adapter.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/Adapter.ts) supports validation, polling, refresh, get-by-native-ID, diagnostics and secret references. All inspected profiles expose empty `agentTools`; this does not authorise or establish universal mutation support. Tracker intake, agent execution and SCM delivery are separate capabilities.

| Existing adapter                   | Intake identity and scope                                          | Preserve / validate                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `github`: GitHub Issues            | Issue number string; configured owner/repository                   | owner/repository/number; repository, label, assignee and open-state rules                                   |
| `github_projects`: GitHub Projects | Project item ID, not issue number; configured owner/project number | item_id plus issue_id/issue_number; draft/PR content excluded; closed content is not dispatchable in source |
| `linear`: Linear                   | Immutable UUID; configured project slug                            | identifier/project slug remain native references; human key is not automatically accepted by getIssue       |
| `jira`: Jira                       | Immutable issue ID after key resolution; configured project        | key remains human reference; scope/unknown blockers preserved                                               |
| `gitlab`: GitLab                   | Project-scoped IID string; configured API host/project path        | global ID/project ID/path preserved; only opened source issues dispatchable                                 |
| `azure_boards`: Azure Boards       | Work-item ID string; configured organisation/project               | revision/type/project retained; terminal process states including Removed not dispatchable in source        |
| `asana`: Asana                     | Task GID; configured project GID                                   | project membership and section GID determine scope/state; incomplete task required                          |

The Azure Boards, GitHub Projects and GitLab integration docs contain broader active/dispatchable wording than current source. Use the source conditions above for decisions, and correct that documentation in a separately authorised change. Blockers missing from an adapter are unknown/unmodelled, not inferred empty. GitHub Projects deliberately identifies the project item, so the same issue in two projects must not collapse into one intake item.

Proposed design: extend the existing registry and normalisation seam, rather than create a second tracker system. A chosen work target carries owning Neokod project/connection, tracker kind, configured host/scope, opaque native ID and native reference. A small human-reference resolver may translate a pasted Jira key, Linear key, scoped issue number or URL through the correct existing adapter. It must not guess UUIDs from display labels or accept an unscoped `#42`. Scope configuration and provider generation must be fixed for an intake attempt.

[SettingsOverlay.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Trackers/SettingsOverlay.ts) already supplies kind-specific credentials/scope, and [HandoffService.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/HandoffService.ts) owns delegation from a thread. Reuse the current repository claim/run path after normalisation. [WorkItemRepository.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Services/WorkItemRepository.ts) currently keys uniqueness by `(project_id, tracker_kind, tracker_issue_id)`; it does not independently include connection/host identity. Repointing a project's configured tracker scope therefore needs an explicit generation/scope guard or migration decision before reusing colliding IDs. That is an unresolved design constraint, not an already implemented guarantee.

Expose read/resolve, poll, queue/claim, write status, comment, link result and SCM/PR operations as explicit supported/unsupported/unknown capabilities only where demonstrated. Avoid a speculative general action bus. A Jira or Linear item can lead to a GitHub PR without making the tracker a GitHub issue. On success, preserve the source item, accepted local work/run, branch/revision, review/check evidence and delivery receipt. If a backend cannot comment, move status or create a PR, show that fact and offer the existing local/manual path; do not fabricate success from authentication or an empty tool list.

Proposed delivery acceptance uses saved/synthetic adapter fixtures, without live tracker writes: cover each of the seven kinds, two GitLab hosts/projects with the same IID, two GitHub project items referring to one issue, Jira-key/ID and Linear-key/UUID pairs, Asana membership changes, Azure process terminal states and tracker-scope changes during an intake. No cross-scope deduplication or stale publication; unsupported references/actions produce explicit reasons. The existing fenced claim path yields at most one accepted run per intended item. A failed or unknown result delivery remains failed or unknown and cannot silently move the source item.

## Measurement and completion boundaries

Before implementing any performance candidate, freeze fixture sizes, cache/concurrency budgets, platform/config versions and primary metrics in the canonical Neokod plan. The scenarios above are proposed fixtures. For a candidate, compare 20 matched cold/warm runs where applicable; record median/p95, allocations/retained bytes, requests/IO and correctness separately. A proposed decision gate is at least a 10% improvement in the declared primary cost metric, no more than 5% regression in other declared performance metrics, and zero correctness/ownership failures. If the baseline cannot support stable measurement, improve instrumentation first and leave the gain unverified. These thresholds are proposed future acceptance, not results or modifications to previous gates.

Use the smallest relevant checks after an authorised implementation. This addendum creates no application change and ran no app suite, native build, browser/runtime benchmark, provider turn or live tracker operation. JSON structure, referenced local paths and source capture hashes are the appropriate checks for this research artifact; they do not prove future product behaviour.

Evidence indexes: [structured patterns](evidence/competitor-sb-product-patterns.json), [extra frozen source captures](evidence/competitor-sb-product-source-manifest.json), [new issue/comment captures](evidence/competitor-sb-product-issue-manifest.json). Conductor and Maestri remain official-doc-only comparisons with no implementation callers or measured performance attributed to them.
