# Neokod Completion Notifications and Blocking Browser Tests — v2

## Overview

This plan delivers two independently reviewable workstreams without changing Neokod's architectural direction:

- **Workstream A** adds browser completion, failure, approval, input, and terminal-subprocess notifications.
- **Workstream B** adds a deterministic Chromium component-test lane that is blocking in CI.

Neokod remains the source of truth. Keep effect-atom state, `packages/client-runtime`, server-side orchestration, the existing Effect RPC/WebSocket contracts, and the TanStack `/_chat/$environmentId/$threadId` route (navigated as `"/$environmentId/$threadId"` because `_chat` is pathless). Synara is only a mechanics reference. Do not import its Zustand state, `/$threadId` route, `nativeApi`/Electron bridge, protocol compatibility layer, or non-blocking Linux policy.

The work is split into six independently green branches/milestones. No implementer owns both workstreams as one unbroken change. One integration owner exclusively owns `pnpm-lock.yaml`, `apps/web/vite.config.ts`, and `.github/workflows/ci.yml`.

### Settled product and reliability decisions

1. **Agent completion/failure identity.** Use existing `session.activeTurnId` and `latestTurn.turnId`; inspect raw `session.status` and `latestTurn.state`, not only the awareness projection. Identified occurrences are exactly-once for the renderer lifetime, including reconnect/replay and completion from an attention phase or a coalesced render. First-load history is baseline-only. A no-checkpoint turn is exact if its `activeTurnId` was observed before settlement. A `starting -> ready` episode with no turn ID and no `latestTurn` is unidentifiable and intentionally emits nothing rather than using `updatedAt` as a false identity.
2. **Approval/input identity.** Choose **best-effort booleans with tombstones and connection-generation baselining**, not an additive contract change. `OrchestrationThreadShell` exposes only booleans, so exact occurrence delivery cannot be promised across reconnect. This is the smallest honest implementation. If exact attention delivery becomes a product requirement, add stable approval/input activity IDs later as an isolated additive contract-and-server milestone.
3. **Coalescing.** Observation, buffering, channel attempt, and settlement are distinct states. Buffering never marks an occurrence delivered. Failure has highest priority. Every non-winning occurrence remains queued and is delivered/settled once after the winner flushes.
4. **Hydration.** Arm independently per environment from catalog readiness, supervisor `generation`, and `environmentShell.stateValueAtom(environmentId).status`. Cached/synchronizing and first-live snapshots are baselines. Known active turn IDs survive reconnect so an identified agent turn may settle after reconnect; unknown historical terminal states and boolean attention do not alert.
5. **Terminal reconnect policy.** Baseline terminal metadata on every supervisor generation. This intentionally silences reconnect snapshots and may miss subprocesses that finish while disconnected; it avoids false completion alerts from an unsequenced snapshot stream.
6. **Delivery fallback.** Hidden fallbacks are held by the coordinator until focus, then revalidated. Toasts use both `timeout: 0` and `data.dismissAfterVisibleMs`. A thrown `new Notification(...)` or permission race is a failed channel attempt and falls back to the focus-timed toast.
7. **Browser boundary.** Use a narrower production routed-provider boundary consumed by both `AppRoot` and tests. Do not pretend `AppAtomRegistryProvider` injects a connection; it only provides the registry. The real connection runtime runs behind mocked external HTTP/WebSocket boundaries.
8. **Initial browser gate.** `ComposerCommandMenu` is the first blocking test. Full `ChatView` and real LegendList are excluded from M1. Integrated tests retain real browser timers; only fixed fixture dates and targeted `Date.now`, UUID, and RNG stubs are allowed.

## Workstream A — Completion and attention notifications

### Objective

Add opt-out web alerts for agent completion/failure, approval/input attention, and terminal subprocess completion. Suppress a visible focused target, preserve environment-qualified routing, avoid hydration/replay floods, and keep behavior correct if Clerk, cloud, relay, or mobile are later removed.

The guarantee is explicit:

| Kind | Identity | Semantics |
|---|---|---|
| Agent completion | `environmentId + threadId + turnId`, from completed `latestTurn.turnId` or retained `session.activeTurnId` | Exactly once per renderer lifetime when a stable turn ID is observable; historical first-load snapshots are silent |
| Agent failure | Same stable turn ID, derived from raw `session.status === "error"` or `latestTurn.state === "error"` | Exactly once per renderer lifetime when identified; an ID-less live error edge is best-effort only |
| Approval/input | Scoped thread + supervisor generation + local rising-edge ordinal; boolean tombstone retained | Best-effort within one live generation; pending requests present at reconnect are baseline-only and may be missed |
| Terminal subprocess completion | Scoped terminal + supervisor generation + locally observed running episode | Best-effort within one live generation; reconnect snapshots are baseline-only and offline completions are intentionally missed |

“Exactly once” does not mean persistence across a full browser restart. A restart baselines the current state and never replays historical notifications.

### Current-state findings (verified)

- `packages/contracts/src/orchestration.ts` defines `OrchestrationThreadShell` with `latestTurn`, `session`, `hasPendingApprovals`, `hasPendingUserInput`, and `updatedAt`. `OrchestrationSession.activeTurnId` and `OrchestrationLatestTurn.turnId` are the only stable agent-turn identities in this shell. Approval/input are booleans only.
- `packages/shared/src/agentAwareness.ts` makes `projectThreadAwareness(...)` a **current priority projection**: approval, input, failure, starting, running, completion. It is useful for labels and priority, not an occurrence stream. Its priority can hide raw failure while a pending flag remains true.
- `packages/client-runtime/src/state/shell.ts` exposes per-environment `empty | cached | synchronizing | live` state and resumes `subscribeShell` from a cached/HTTP sequence. `packages/client-runtime/src/state/connections.ts` exposes catalog `isReady`, and the supervisor state in `packages/client-runtime/src/connection/model.ts` includes `generation`.
- `packages/client-runtime/src/state/threadShell.ts` flattens current thread shells across whatever environments presently have data. Therefore `useThreadShells()` alone cannot provide an all-environment hydration boundary.
- `apps/web/src/state/shell.ts` exports `environmentShell`; `apps/web/src/connection/catalog.ts` exports `environmentCatalog`. These are the correct effect-atom sources for per-environment arming.
- `apps/server/src/relay/AgentAwarenessRelay.ts` excludes `updatedAt` from meaningful publish identity and confirms first-observed completion after five seconds because a new session boots ready. Web must not call this relay, but must preserve the no-ready-at-birth intent.
- `packages/contracts/src/terminal.ts` defines unsequenced terminal snapshot/upsert/remove metadata. `packages/client-runtime/src/state/terminal.ts` reconstructs metadata from an empty list for each stream; reconnect cannot distinguish offline completion from snapshot replay.
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` owns the routed chat. `apps/web/src/threadRoutes.ts` supplies `buildThreadRouteParams(...)` and scoped resolution.
- `apps/web/src/components/ui/toast.logic.ts` hides a toast carrying `data.threadRef` unless that exact thread is active. Off-thread activity notifications must therefore be generic stacked toasts with an Open action after coordinator suppression.
- `apps/web/src/components/ui/toast.tsx` has separate stacked and anchored managers plus a module-level visible-timeout map. Existing focus-timed callers use `timeout: 0` together with `dismissAfterVisibleMs`.
- `apps/web/src/hooks/useSettings.ts` client settings hydration only tracks local settings persistence. It does **not** mean catalog, connection, shell, or environment hydration.
- `packages/contracts/src/settings.ts` owns `ClientSettingsSchema`, `DEFAULT_CLIENT_SETTINGS`, and `ClientSettingsPatch`; a notification preference is local-only and additive.
- `apps/web/src/routes/__root.tsx` renders the authenticated/hosted-static app inside both toast providers. Mounting there covers primary, saved, and cloud environments without depending on Clerk or relay state.
- Current releasable package versions are `1.1.0`, `CHANGELOG.md` starts at `1.1.0`, and `scripts/update-release-package-versions.ts` synchronizes the four release packages. Re-read these at release time.

### Design & approach

#### A1. Pure occurrence reducer

Create `apps/web/src/notifications/activityNotifications.logic.ts` with no React, browser, or atom imports. Export:

- `ActivityNotificationKind`
- `ActivityOccurrence`
- `EnvironmentActivityInput`
- `ActivityObservationState`
- `reduceEnvironmentActivityObservation(state, input)`
- `activityOccurrenceKey(occurrence)`
- `enqueueActivityOccurrences(state, occurrences)`
- `flushNextActivityOccurrence(state, nowMs)`

State is keyed by `scopedThreadKey(...)` and supervisor generation. For each thread retain:

- `lastObservedActiveTurnId`
- `lastObservedLatestTurnId`
- delivered completion/failure turn IDs
- previous raw session/turn terminal state
- approval/input booleans, local rising-edge counters, and a disappearance tombstone
- whether this is the environment's first-ever baseline or a reconnect baseline

Rules:

1. While catalog is not ready, or shell is `empty`, `cached`, or `synchronizing`, consume the snapshot as baseline and emit nothing.
2. On the first `live` snapshot for an environment/generation, baseline pending booleans, unknown completed/error turns, and terminal metadata. Retain a known active turn from the preceding generation; if that exact ID is now completed/error, it may settle once.
3. Record any non-null `session.activeTurnId` immediately, independent of awareness phase.
4. Emit completion when a new terminal `latestTurn.turnId` is observed after arming, even if React never rendered running, or when a retained active turn settles to ready/idle with no `latestTurn`. Permit settlement from approval/input. Never use `thread.updatedAt` or `completedAt` as identity.
5. Derive failure directly from raw session/latest-turn state. Pending approval/input cannot hide it. Prefer current `latestTurn.turnId`, then current/retained active ID. An ID-less raw live transition may produce one generation-local best-effort failure, clearly typed as such.
6. Approval/input emit only on `false -> true` within an armed live generation. Retain tombstones across disappearance for 10 minutes, capped with the observation LRU at 512 scopes. Re-add with the same pending flag—even with changed `updatedAt`—does not emit. A new connection generation baselines the first value.
7. A new thread born ready, a title-only `updatedAt` change, and `starting -> ready` without any turn ID produce no completion. A short no-checkpoint turn with an observed `activeTurnId` produces one.
8. Maintain a 512-entry insertion-ordered delivered-key LRU. This bounds renderer-lifetime replay dedupe without inventing persistent notification history.

Use `projectThreadAwareness(...)` only to supply familiar headline/detail text after the raw occurrence has been identified. Do not let its priority decide whether failure/completion exists.

#### A2. Lossless coalescing

Keep a per-scoped-thread FIFO of occurrences and a 250 ms flush timer. Priority for choosing the next winner is:

`agent failure > approval > input > agent completion > terminal completion`.

Entering the queue is observation, not delivery. After the winner is delivered or intentionally suppressed, remove only that occurrence (or the explicitly aggregated terminal IDs), mark it settled, and schedule the next queued occurrence. Approval followed by failure or completion within 250 ms therefore yields two notifications in priority order, once each. Simultaneous terminal completions for the same thread may be combined, but every underlying occurrence key remains pending until the combined toast/system notification is successfully created or intentionally suppressed.

If notifications are disabled, continue reducing, deduping, queueing, and immediately settling occurrences as “suppressed-disabled”; re-enabling never releases stale work.

#### A3. Per-environment sources and reconnect policy

`ActivityNotificationCoordinator` enumerates environments only after `useEnvironments().isReady`. Render one `EnvironmentActivitySource` per catalog entry; hooks are never called in a loop.

Each source reads:

- `environmentCatalog.stateAtom(environmentId)` for supervisor phase/generation
- `environmentShell.stateValueAtom(environmentId)` for shell status/snapshot
- `terminalEnvironment.metadata(...)` through `useEnvironmentQuery(...)`

The source passes raw data into the reducer even while the setting is disabled. Each environment arms independently. Saved/cloud environments that appear later baseline independently and cannot notify from cached history.

Terminal metadata is baseline-only on every generation. A `true -> false` running edge alerts only inside an already armed generation. Tradeoff: offline subprocess completions are intentionally silent.

#### A4. Channel coordinator and focus-time fallback

Create `apps/web/src/notifications/browserNotification.ts` with:

- `readBrowserNotificationCapability()`
- `requestBrowserNotificationPermission()`
- `showBrowserActivityNotification()` returning `shown | unsupported | insecure | not-granted | construction-failed`

Only the explicit settings button requests permission. Guard SSR, insecure contexts, API absence, permission races, and constructor throws.

For each flushed occurrence:

1. If disabled, settle as suppressed.
2. If the target route is active and `document.visibilityState === "visible"` and `document.hasFocus()`, settle as suppressed-target.
3. If visible/focused on another route, add one generic stacked toast with project/environment/thread context and an Open action. Do not set `data.threadRef`.
4. If hidden/blurred and permission is granted, attempt one native `Notification` with scoped tag and `silent: true`. Constructor success is delivery; constructor failure or permission change falls through.
5. Otherwise place the occurrence in the coordinator's focus queue. On `focus`/`visibilitychange`, re-read the route, setting, visibility, and target. Suppress if the target is now active; otherwise add a generic stacked toast with `timeout: 0` and `data.dismissAfterVisibleMs`.

Both system click and toast Open use:

```ts
navigate({
  to: "/$environmentId/$threadId",
  params: buildThreadRouteParams(ref),
})
```

System click prevents default, focuses the window, closes the system notification, then navigates. OS/browser DND is authoritative and unobservable; do not claim otherwise and add no sound/vibration.

#### A5. Settings, mount, and motion

Add `webActivityNotificationsEnabled` with decoding default `true` to `ClientSettingsSchema` and optional patch field to `ClientSettingsPatch`. Add it to General settings dirty/reset accounting.

`GeneralSettingsPanel` gets:

- “Task activity notifications” switch controlling both channels.
- A separate system-notification capability/status row and “Enable system notifications” button.
- Honest `unsupported`, `insecure`, `default`, `granted`, and `denied` copy. Denied still uses in-app fallback.

Mount `ActivityNotificationCoordinator` once inside `ToastProvider` and `AnchoredToastProvider` in the already-authenticated-or-hosted-static branch of `apps/web/src/routes/__root.tsx`, not behind primary authentication alone.

Activity notifications use only stacked toasts. Add `motion-reduce:transition-none` to the normal stacked `Toast.Root` and `Toast.Content`; do not claim anchored toasts changed. Browser acceptance checks computed transition duration on an activity stacked toast under reduced motion.

### Task breakdown

1. **Reducer and semantic tests — M4 owner.**
   - Add `apps/web/src/notifications/activityNotifications.logic.ts` with the functions/state above.
   - Add `apps/web/src/notifications/activityNotifications.logic.test.ts` with typed `OrchestrationThreadShell` and `TerminalSummary` builders.
   - Reuse `scopedThreadKey`, `scopeThreadRef`, and awareness copy helpers; add no new dependency or shared package abstraction.
2. **Native Notification wrapper — M5 owner.**
   - Add `apps/web/src/notifications/browserNotification.ts` and `.test.ts`.
   - Test capability states, explicit permission, permission race, and constructor throw.
3. **Coordinator and sources — M5 owner.**
   - Add `apps/web/src/notifications/ActivityNotificationCoordinator.tsx`.
   - Implement `EnvironmentActivitySource`, `useDocumentAttentionState`, `isTargetThreadVisibleAndFocused`, `deliverActivityOccurrence`, `flushFocusFallbacks`, and `openActivityNotificationTarget`.
   - Use `environmentCatalog.stateAtom`, `environmentShell.stateValueAtom`, and `terminalEnvironment.metadata`; do not open a socket directly.
4. **Settings and permission UX — M5 owner.**
   - Edit `packages/contracts/src/settings.ts` schema/default/patch.
   - Edit `apps/web/src/components/settings/SettingsPanels.tsx` in `GeneralSettingsPanel` and `useSettingsRestore`.
5. **Mount/toast motion — M5 owner.**
   - Edit `apps/web/src/routes/__root.tsx` to mount the coordinator for both authenticated and hosted-static shells.
   - Edit only stacked transitions in `apps/web/src/components/ui/toast.tsx`.
6. **Integrated notification cases — M6 owner.**
   - Add `apps/web/src/notifications/ActivityNotificationCoordinator.browser.tsx` using the M2 harness.
   - Cover cross-environment arming, route/focus channels, constructor fallback, replay, and setting changes.
7. **Release bookkeeping — M6 integration owner.**
   - Re-read live versions and `CHANGELOG.md`.
   - For a combined release, use one Minor entry and `scripts/update-release-package-versions.ts`; currently expected `1.1.0 -> 1.2.0`.
   - Do not apply the notification Minor version during the browser-foundation-only branch. If browser foundation is actually released separately, follow repository policy with its own Patch release, then rebase the later Minor version.

### Dependencies/config

- No package, environment variable, service worker, relay call, Electron IPC, endpoint, provider SPI, or orchestration contract change.
- One local-only additive setting in `packages/contracts/src/settings.ts`.
- Approval/input stable IDs are deliberately not added in this release.
- The coordinator depends on catalog/client-runtime/router/toast boundaries, so removing Clerk/cloud/mobile later does not require redesign. Primary-only local operation remains supported.

### Test plan

#### ACCEPTANCE CRITERIA

- [ ] First cached and first-live snapshot is silent per environment, including staggered primary/saved/cloud registration.
- [ ] A new identified completed turn alerts once even when running never rendered or the previous rendered phase was approval/input/completed.
- [ ] A known active no-checkpoint turn settling to ready/idle alerts once; ready-at-birth, title updates, and ID-less `starting -> ready` do not.
- [ ] Raw failure alerts once even with stale approval/input flags still true.
- [ ] Approval/input are labeled best-effort; same pending flag after disappearance/re-add or reconnect does not duplicate.
- [ ] Approval followed by failure and approval followed by completion inside 250 ms deliver both meaningful occurrences once, failure first.
- [ ] Setting off still consumes transitions; turning it on does not release stale notifications.
- [ ] Terminal `true -> false` alerts once only inside one armed generation; reconnect snapshots are silent.
- [ ] Focused visible target uses no channel; an off-thread foreground target uses one generic navigable toast.
- [ ] Background/granted uses one system notification; constructor failure/permission race falls back.
- [ ] Focus fallback uses `timeout: 0` plus `dismissAfterVisibleMs` and re-checks target/setting before showing.
- [ ] System/toast click routes with the exact environment/thread; identical IDs in two environments remain distinct.
- [ ] System permission is requested only from the explicit button; notifications are silent and DND copy is honest.
- [ ] Reduced motion removes transition duration only for the activity stacked-toast path claimed here.
- [ ] `vp check`, `vp run typecheck`, `vp test`, and M6 browser tests pass.

| ID | Scenario | Setup | Expected | Type |
|---|---|---|---|---|
| A-U01 | Per-environment hydration | Primary live, saved cached, cloud added later | Each first-live snapshot is silent; later live edge alerts only in its environment | unit |
| A-U02 | Coalesced render completion | Previous turn completed; next render already contains a different completed `latestTurn.turnId` | One completion for the new turn | unit |
| A-U03 | Attention settlement | Active turn enters approval/input then completes | One attention and one completion, each once | unit |
| A-U04 | No-checkpoint identity | Observe running `activeTurnId`, then ready with no latestTurn | One completion keyed by retained turn ID | unit |
| A-U05 | No identity | New ready thread; title update; starting without ID to ready | No completion | unit |
| A-U06 | Raw failure priority | Pending approval remains true while session/latest turn errors | Failure emitted immediately and first | unit |
| A-U07 | Lossless coalescing | Approval then failure; approval then completion inside 250 ms | Winner then queued occurrence; none erased/duplicated | unit |
| A-U08 | Tombstone | Pending approval disappears/reappears with changed `updatedAt` in same generation | No duplicate | unit |
| A-U09 | Reconnect attention | New generation begins with pending input | Baseline only; documented possible miss | unit |
| A-U10 | Disabled observation | Disable, transition/settle, enable | No stale delivery; next fresh occurrence alerts | unit |
| A-U11 | Terminal reconnect policy | Running before disconnect, idle first snapshot after reconnect | No alert; fresh same-generation true-to-false alerts | unit |
| A-U12 | LRU bound/scope collision | >512 occurrences; same IDs in environments A/B | Bound holds; scopes remain independent | unit |
| A-U13 | Notification wrapper | Missing API, insecure, denied, permission race, constructor throw | Typed result; no uncaught error | unit |
| A-B01 | Active target suppression | Target route visible/focused | No toast or native Notification | browser |
| A-B02 | Foreground off-thread | Different thread visible/focused | One generic toast; Open routes exactly | browser |
| A-B03 | Background native | Hidden/granted; click mock notification | One silent scoped native alert; focus/close/navigate | browser |
| A-B04 | Construction fallback | Granted but constructor throws | Focus-timed toast is queued and later shown | browser |
| A-B05 | Hidden timeout/recheck | Stay hidden past default timeout, navigate to target, focus | No expired toast and no now-irrelevant toast | browser |
| A-B06 | Reduced motion | Reduced-motion context; activity stacked toast | Root/content computed transition duration is zero | browser |
| A-M01 | Permission UX | Exercise supported/denied browsers manually | No automatic prompt; honest fallback/status copy | manual |

### Risks

| Risk | Mitigation |
|---|---|
| “Exactly once” is overclaimed | Guarantee only identified turn occurrences for renderer lifetime; explicitly label ID-less and boolean sources best-effort |
| Projection hides failure | Detect raw state first; use awareness only for copy |
| Batched React render skips running | Compare turn IDs, not phase edges |
| Coalescer loses terminal state | Pending queue and delivered ledger are separate; remove only after channel success/intentional suppression |
| Late environment floods | Per-environment shell/generation baseline |
| Reconnect duplicates boolean attention | First-generation observation is baseline; retain same-generation tombstones |
| Offline terminal completion is missed | Explicit chosen policy and test; prefer silence over false replay |
| Fallback expires or becomes irrelevant | Coordinator focus queue, `timeout: 0`, visible timer, target recheck |
| Future local-only cleanup | No Clerk/relay/mobile dependency; hosted/cloud sources disappear naturally with catalog entries |

### Effort/parallelization

Estimate **7–10 engineering days** for A: reducer/tests 3–4, wrapper/settings/coordinator/mount 3–4, browser/release 1–2. M4 may run in a separate worktree while M2/M3 proceeds because it owns only notification logic/tests. M5 rebases onto M4 and the browser foundation but does not touch lockfile/Vite/CI. M6 integrates both streams.

Deferrable without weakening the stated release: exact approval/input IDs, persistent cross-restart notification history, terminal offline completion, and exact ID-less no-checkpoint completion. Do not silently upgrade the guarantee without a contract/source that supplies identity.

## Workstream B — Blocking real-browser component-test lane

### Objective

Add a deterministic Chromium-backed Vitest Browser project to the existing Vite+ configuration and a separate blocking Ubuntu CI job. Prove the smallest leaf interaction first, then the real Effect RPC/environment harness, routed render, reconnect, and worktree bootstrap.

### Current-state findings (verified)

- `apps/web/vite.config.ts` uses Vite+ `defineConfig`/`defineProject` and currently defines only `unit` for `src/**/*.test.{ts,tsx}`.
- `apps/web/package.json` keeps `test` unit-only. The root package declares `pnpm@11.10.0`, while repo commands use Vite+ (`vp`); do not migrate to Synara's Bun/Turbo setup.
- Installed `vite-plus@0.2.2` bundles Vitest and `@vitest/browser` `4.1.9` and requires the optional peer `@vitest/browser-playwright@4.1.9` exactly. Its exports include `vite-plus/test/browser-playwright` and `vite-plus/test/browser/context`.
- Only Playwright `1.58.2` and `vitest-browser-react` `2.1.0` were reference-tested in Synara. Synara actually resolved Vitest/provider `4.1.0`, not `4.1.9`; provider `4.1.9` is required here by installed Vite+.
- `msw@2.12.11` and `apps/web/public/mockServiceWorker.js` already exist. No browser-mode WS harness exists.
- `packages/client-runtime/src/rpc/session.test.ts` already proves real `WsRpcGroup` Request/Exit JSON through `RpcSessionFactory`. `effect/unstable/rpc/RpcMessage` also defines Ping/Pong, Chunk, Ack, Interrupt, and Eof control frames.
- `packages/client-runtime/src/rpc/session.ts` opens the socket and immediately invokes `server.getConfig` before a session is ready.
- `packages/client-runtime/src/state/shellSnapshotHttp.ts` and `threadSnapshotHttp.ts` load `/api/orchestration/shell` and `/api/orchestration/threads/:threadId`; shell/thread WS subscriptions then resume with `afterSequence`.
- `apps/web/src/AppRoot.tsx` mounts `AppAtomRegistryProvider`, router, preview hosts, and Electron browser host. `AppAtomRegistryProvider` in `apps/web/src/rpc/atomRegistry.ts` only provides a registry and has no prepared-connection injection.
- `apps/web/src/routes/__root.tsx` runs `resolveInitialServerAuthGateState()` before rendering. The real platform reads `/.well-known/t3/environment`, registers the primary target, loads local persistence/settings, starts a connection, and subscribes to config/lifecycle/shell data.
- `apps/web/src/components/chat/ComposerCommandMenu.tsx` is a bounded accessible leaf. It is the first blocking gate.
- `apps/web/src/components/ChatView.tsx` uses rAF, real timeouts, many environment atoms, and real LegendList. Global fake timers would stall the behavior being tested.
- Neokod uses `@legendapp/list@3.2.0`. Semantic row visibility is still geometry-sensitive on Linux, so LegendList is not an initial blocking requirement.
- `.github/workflows/ci.yml` has separate 10-minute check/test jobs. Browser dependency installation plus Chromium must not be added to the existing test job.
- Module-lifetime state includes two toast managers/timers, auth/descriptor/local API/settings caches, persisted Zustand stores, localStorage, IndexedDB connection storage, and effect-atom subscriptions. Serial files alone do not reset these.

### Design & approach

#### B1. Dependency/config spike and first gate

Add exact dev dependencies to `apps/web/package.json`:

- `@vitest/browser-playwright@4.1.9`
- `playwright@1.58.2`
- `vitest-browser-react@2.1.0`

Playwright/helper versions are Synara references only; the provider pin comes from Neokod's Vite+ peer requirement.

Before building any harness, the integration owner uses a clean disposable worktree/clone with no `node_modules`:

```sh
vp install --frozen-lockfile
vp run --filter @t3tools/web test:browser:install
vp run --filter @t3tools/web test:browser -- ComposerCommandMenu.browser.tsx
```

This clean frozen install and one real Chromium launch is a blocking compatibility gate. If it fails, stop and resolve the dependency/toolchain issue before M2.

Keep the browser project inline in `apps/web/vite.config.ts`; do not add `playwright.config.ts`, `@playwright/test`, or a standalone Vitest config. Keep `test` unit-only and add `test:browser` plus `test:browser:install` scripts.

Required configuration shape:

```ts
browser: {
  enabled: true,
  headless: true,
  instances: [{ browser: "chromium" }],
  viewport: { width: 1280, height: 900 },
  provider: playwright({
    contextOptions: {
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce",
    },
  }),
}
```

Use `extends: true`, project name `browser`, include `src/**/*.browser.{ts,tsx}`, `fileParallelism: false` initially, and 30-second test/hook timeouts. Bootstrap assertions verify viewport, DPR, locale, timezone-derived fixture output, color scheme, and reduced motion.

#### B2. Bootstrap dependency map for a full routed render

M2 must implement and document every dependency below before unknown traffic is fatal:

| Stage | Real code path | Harness responsibility |
|---|---|---|
| Route/auth gate | `routes/__root.tsx` → `resolveInitialServerAuthGateState()` → `GET /api/auth/session` | Return authenticated session; reset auth cache before/after |
| Primary descriptor | `connection/platform.ts` → `fetchRemoteEnvironmentDescriptor()` → `GET /.well-known/t3/environment` | Return fixed environment ID/label matching fixtures; reset descriptor cache |
| Registration/target | `PlatformConnectionSource` → `PrimaryConnectionRegistration` | Let the real platform register from the descriptor; do not inject through `AppAtomRegistryProvider` |
| Local persistence/settings | `connection/storage.ts`, `clientPersistenceStorage.ts`, `useSettings.ts`, `localApi.ts` | Start with empty IndexedDB/catalog/cache and deterministic client settings; expose browser LocalApi, no Electron bridge |
| Initial connection | `connection/runtime.ts`/supervisor/session | Intercept the actual `/ws`; track connection generation and open clients |
| Initial config | `rpc/session.ts` → `server.getConfig` | Reply with typed fixed `ServerConfig` before ready |
| Lifecycle/config/provider/settings | `state/server.ts` → `subscribeServerLifecycle` and `subscribeServerConfig` | Emit typed lifecycle welcome and config snapshot; provider/settings updates remain events on config stream |
| Shell HTTP/stream | `shellSnapshotHttp.ts` + `subscribeShell({afterSequence})` | Return cold shell snapshot, then sequenced stream/resume frames |
| Thread HTTP/stream | `threadSnapshotHttp.ts` + `subscribeThread({threadId, afterSequence})` | Return detail snapshot and sequenced updates for the routed thread |
| Routed UI | real route tree at `/$environmentId/$threadId` | Wait for title/transcript/composer/ready roles or text, never a sleep |
| Teardown | registry/runtime, MSW WS, stores/caches/globals | Unmount first, dispose, close/assert zero subscriptions, then clear state |

Use a **narrower production boundary**, not a test connection factory: extract `RoutedAppRoot` (name may be `AppRouterRoot`) in `apps/web/src/AppRoot.tsx` so production `AppRoot` and tests both consume the same `AppAtomRegistryProvider + RouterProvider` boundary. Production keeps `PreviewAutomationHosts` and `ElectronBrowserHost`; routed browser tests omit only those host-only siblings. The route tree, auth gate, platform registration, client-runtime, settings, HTTP, and Effect socket remain real.

#### B3. Codec-first MSW WebSocket mock

Before `ws.link(...)`, extend `packages/client-runtime/src/rpc/session.test.ts` (or add adjacent `protocolFrames.test.ts`) to drive the actual `RpcSessionFactory`/`makeWsRpcProtocolClient(WsRpcGroup)` through its test WebSocket. Cover:

- client Request encoding with tag/payload/headers
- Ping and server Pong
- streamed Chunk decoding and terminal Exit
- Ack/Interrupt/Eof control behavior where the real client emits it
- typed failure Exit and malformed/unknown frame rejection

Only after those tests pass, add:

- `apps/web/src/test/browser/effectRpcWebSocketMock.ts`
- `apps/web/src/test/browser/mockEnvironmentServer.ts`

Use the verified Effect `RpcMessage` envelopes and Neokod `WsRpcGroup` method tags. `mockEnvironmentServer` handles legitimate Ping/Pong/Ack/Interrupt/Eof controls, records requests/commands/subscriptions, emits Chunk/Exit, exposes `disconnect()`/`acceptReconnect()`, and fails genuinely unknown RPC tags or unhandled HTTP—not valid Effect control traffic. Do not copy Synara's payload flattening or native API architecture.

#### B4. One authoritative reset

Add `apps/web/src/test/browser/reset.ts` exporting only `resetBrowserAppHarness()`. Every integrated test registers its unmount/server handles with it. Reset order is fixed:

1. Unmount React and await browser-render cleanup.
2. Dispose the app registry/runtime via `resetAppAtomRegistryForTests()` and confirm effect subscriptions released.
3. Close both toast managers, clear their visible-timeout map through one test reset exported by `toast.tsx`, and cancel coordinator/coalescing/fallback timers.
4. Close MSW WebSocket clients/streams and assert the server reports zero open clients and zero active RPC subscriptions.
5. Reset `__resetServerAuthBootstrapForTests`, primary descriptor bootstrap, desktop-primary auth, `__resetLocalApiForTests`, and client settings hydration.
6. Reset Zustand state with `store.setState(store.getInitialState(), true)` for composer draft, right panel, terminal UI, diff panel, subagent UI, UI state, thread selection, browser pointer/surface, mission control, and workspace rail; call `.persist.clearStorage()` on the five persisted stores.
7. Clear `localStorage`, `sessionStorage`, and delete the `t3code:connection-runtime` IndexedDB database after connections close.
8. Restore patched `document.visibilityState`, `document.hasFocus`, `window.focus`, `Date.now`, UUID/RNG, Notification, ResizeObserver, and IntersectionObserver.
9. Assert again that no WebSocket client/subscription or toast timer remains.

Add an isolation test that runs the same routed case twice in one file and also from two files without relying on module reload. Keep `fileParallelism: false` until this passes; serial execution is scheduling, not cleanup.

#### B5. Timer/layout policy

- Integrated browser tests use real `setTimeout`, rAF, retry sleeps, and ResizeObserver scheduling.
- Fixtures contain fixed ISO timestamps. Stub only `Date.now`, `crypto.randomUUID`, and application RNG where a deterministic payload requires it; restore each stub in reset.
- Use roles/text/state/recorded payloads and condition polling. No arbitrary sleeps, screenshots, exact pixels, frame counts, or synthetic row boxes in blocking tests.
- M1 contains only `ComposerCommandMenu` keyboard/click behavior.
- M2 may add one basic full routed `ChatView` render only after the harness/reset itself passes three consecutive local and three consecutive Ubuntu runs.
- M3 adds reconnect/worktree cases. Real LegendList live-edge/layout characterization remains deferred until it independently passes stock Ubuntu Chromium three times; it is not required for this release.

#### B6. Separate blocking CI job

Add `browser_test` to `.github/workflows/ci.yml`:

- `runs-on: ubuntu-24.04`
- `timeout-minutes: 20`
- setup Vite+ with frozen install behavior
- cache `~/.cache/ms-playwright` keyed by OS plus `pnpm-lock.yaml`
- run Chromium-only install with `DEBIAN_FRONTEND=noninteractive`
- run only `vp run --filter @t3tools/web test:browser`
- no `continue-on-error`, retries, or geometry exceptions

OS packages installed by `--with-deps` are not assumed cached. Record cold install+launch time and steady browser-suite time from Ubuntu. Do not assert a sub-five-minute target until measurements prove it. Keep existing 10-minute unit `test` job unchanged.

### Task breakdown

1. **Dependencies/project/leaf/CI — M1 integration owner.**
   - Edit `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/vite.config.ts`, `.github/workflows/ci.yml`, and `docs/operations/ci.md`.
   - Add `apps/web/src/test/browser/setup.ts` with context assertions and CSS import.
   - Add `apps/web/src/components/chat/ComposerCommandMenu.browser.tsx` for query/highlight/Enter/click/callback behavior.
   - Run the clean frozen install and Chromium launch before declaring the dependency set viable.
2. **RPC codec tests — first part of M2.**
   - Extend `packages/client-runtime/src/rpc/session.test.ts` or add `packages/client-runtime/src/rpc/protocolFrames.test.ts` using the real `WsRpcGroup` client.
   - Do not start the MSW WS mock until this gate is green.
3. **Fixtures/server/reset/render — M2 harness owner.**
   - Add `apps/web/src/test/browser/fixtures.ts`, `effectRpcWebSocketMock.ts`, `mockEnvironmentServer.ts`, `reset.ts`, and `render.tsx`.
   - Edit `apps/web/src/AppRoot.tsx` only for the shared narrower routed production boundary.
   - Add the minimal toast reset seam in `apps/web/src/components/ui/toast.tsx`.
   - Implement the bootstrap dependency table literally and fail unknown traffic.
4. **Basic routed render/isolation — second part of M2.**
   - Add `apps/web/src/components/ChatView.browser.tsx` with one fixed routed render and repeat-without-module-reload isolation case.
   - Do not add reconnect, worktree, or LegendList behavior yet.
5. **Reconnect/worktree — M3 owner.**
   - Extend `ChatView.browser.tsx` for forced WS close, one replacement generation, exact `afterSequence`, and return to live.
   - Record one `thread.turn.start` for draft first send with `bootstrap.createThread`, optional `prepareWorktree`, and `runSetupScript: true`; emit matching server state and assert draft promotion without route loss.
   - Never run Git, provider processes, or filesystem mutations.
6. **Notification browser/release — M6 integration owner.**
   - Add A's browser cases only after M2/M3 are green.
   - Run full blocking browser suite three consecutive times locally and on Ubuntu before release.

### Dependencies/config

- Exact dev pins: provider `4.1.9`, Playwright `1.58.2`, browser React helper `2.1.0`.
- No direct `vitest`, `@vitest/browser`, `@playwright/test`, Jest DOM, new MSW, standalone server, or second Vite config.
- Unit script remains browser-free.
- Browser job is separate and blocking with a 20-minute cold timeout and browser binary cache.
- `contextOptions` owns DPR/locale/timezone/color/reduced motion; viewport remains in Vitest browser config.

### Test plan

#### ACCEPTANCE CRITERIA

- [ ] Clean `vp install --frozen-lockfile` resolves exact peers and launches one Chromium leaf test.
- [ ] Unit and browser file selection do not cross-load; unit tests require no Chromium.
- [ ] Context assertions prove 1280×900, DPR 1, en-US, UTC, light, and reduced motion.
- [ ] ComposerCommandMenu is the first and only M1 browser gate.
- [ ] Real `WsRpcGroup` client tests cover Request/Ping/Pong/Chunk/Exit and legitimate control frames before MSW WS exists.
- [ ] Bootstrap map covers auth, descriptor, registration, persistence/settings, initial config, lifecycle/config, shell/thread HTTP and streams.
- [ ] `AppAtomRegistryProvider` is described and used only as a registry provider; no imaginary connection prop exists.
- [ ] Unhandled HTTP/RPC fails, while valid Effect controls do not.
- [ ] Authoritative reset unmounts/disposes/closes/clears/restores and asserts zero open WS subscriptions.
- [ ] Same routed case passes twice in one file and across two files without module reload.
- [ ] Integrated tests keep real browser timers and use only targeted Date/UUID/RNG stubs.
- [ ] Basic routed ChatView, reconnect/resume, and worktree bootstrap/promotion pass without Git/provider execution.
- [ ] Real LegendList is not part of M1 or this release gate unless it first passes three stock Ubuntu runs independently.
- [ ] Separate browser CI job is blocking, has 20-minute timeout and binary cache, and does not overload the existing unit job.
- [ ] Every new blocking browser case set passes three consecutive local and three consecutive Ubuntu runs before merge.
- [ ] `vp check`, `vp run typecheck`, `vp test`, `vp run --filter @t3tools/web test:browser`, and `vp run build` pass at final integration.

| ID | Scenario | Setup | Expected | Type |
|---|---|---|---|---|
| B-G01 | Clean dependency gate | Fresh worktree, frozen lockfile, Chromium install | Install and one leaf launch pass | gate |
| B-U01 | Project selection | Unit/browser include patterns | No cross-loading | unit |
| B-U02 | Codec request/keepalive | Real WsRpcGroup client sends Request/Ping; server sends Pong | Exact verified envelopes and continued connection | unit |
| B-U03 | Codec stream/controls | Server Chunk/Exit; client cancel/ack/eof paths | Typed values/exit and legitimate controls handled | unit |
| B-U04 | Unknown/malformed frame | Invalid tag/envelope | Deterministic failure, not silent ignore | unit |
| B-B01 | Context invariants | Browser setup | Viewport/DPR/locale/UTC/light/reduced motion match | browser |
| B-B02 | Menu keyboard | Fixed slash items; arrows/Enter | One canonical selection | browser |
| B-B03 | Menu click | Click accessible item | One callback and expected highlight/menu state | browser |
| B-B04 | Routed bootstrap | Full bootstrap map; exact route | Title/transcript/composer/ready visible | browser |
| B-B05 | Reset isolation | Run B-B04 twice and from second file | Same result; no stale stores/toasts/subscriptions | browser |
| B-B06 | Reconnect resume | Close at N; accept one new generation; emit N+1 | One replacement; one subscribeShell resume after N; live UI | browser |
| B-B07 | Worktree first send | Draft + base branch + fixed RNG | One correct turn-start bootstrap; no Git/process | browser |
| B-B08 | Draft promotion | Emit matching shell/detail update | Draft finalizes; scoped route remains | browser |
| B-CI01 | Blocking proof | Intentionally fail leaf on temporary branch | Browser job fails workflow | manual |
| B-CI02 | Repeatability | Unchanged suite | Three local and three Ubuntu passes, no retries | manual |
| B-CI03 | Timing record | Cold cache and warm binary cache | Measured timings recorded; both inside 20 minutes | manual |

### Risks

| Risk | Mitigation |
|---|---|
| Peer/runtime skew | Clean frozen install and one launch before harness work; provider matches Vite+ exactly |
| Harness duplicates architecture | Real route/platform/client-runtime; mocks only external HTTP/WS boundary |
| Unknown traffic is hidden | Fatal unhandled policy after full bootstrap map; valid Effect controls explicitly recognized |
| Fake timers deadlock runtime/layout | Real integrated timers; targeted deterministic stubs only |
| Serial tests leak state | One reset plus repeated-case proof and zero-subscription assertion |
| Linux geometry flakes | Menu first; no LegendList gate until independent Ubuntu proof |
| CI cold install exceeds old budget | Separate 20-minute job and browser binary cache; record cold/steady timings |
| Combined PR is unreviewable | Six green branches and one config/lockfile/CI owner |

### Effort/parallelization

Estimate **8–12 engineering days** for B: M1 2–3, M2 3–5, M3 2–3, M6 browser integration support 1. The bootstrap/reset work—not leaf tests—is the dominant uncertainty. Re-estimate after the clean Chromium gate and the first routed harness pass.

The initial release can defer real LegendList layout characterization and multi-browser/visual coverage. Reconnect/worktree and notification browser cases are not deferred in the six-milestone scope.

## Sequencing / milestones

Total estimate: **15–22 engineering days**. With two implementers in separate worktrees and serialized integration, elapsed time may be lower, but review/CI gates remain sequential.

For every milestone, run `vp check`, `vp run typecheck`, and relevant tests. Browser milestones must pass the new case set **three consecutive times locally and three consecutive times on Ubuntu** before merge. M1's very first compatibility gate is the clean frozen install plus one Chromium launch; the three-pass gate follows once the leaf test is stable.

1. **M1 — Browser dependencies/config + ComposerCommandMenu leaf + blocking CI (independent branch/worktree).**
   - Exclusive owner of `pnpm-lock.yaml`, `apps/web/vite.config.ts`, `.github/workflows/ci.yml`, and browser scripts/docs.
   - Exit: clean frozen install, one Chromium launch, leaf keyboard/click test, separate blocking CI, then 3 local + 3 Ubuntu passes.
   - Explicitly no MSW environment harness, full ChatView, LegendList, notifications, reconnect, or worktree.
2. **M2 — RPC codec + environment/MSW harness + one basic routed render (branch based on M1).**
   - Codec tests land before WS mock. Implement bootstrap map, narrower production routed boundary, authoritative reset, fatal unknown traffic, and one basic ChatView render.
   - Exit: reset isolation proof, zero open subscriptions, 3 local + 3 Ubuntu passes.
3. **M3 — Reconnect/worktree cases (branch based on M2).**
   - Own only harness extensions and integrated ChatView cases; no lockfile/Vite/CI edits.
   - Exit: one connection replacement/resume, one correct server-side worktree bootstrap/promotion, 3 local + 3 Ubuntu passes.
4. **M4 — Pure notification occurrence reducer/tests (parallel independent worktree).**
   - May start after v2 approval and run alongside M2/M3. Own only pure notification logic/tests.
   - Exit: exact-vs-best-effort semantics, lossless coalescing, per-environment/generation baselines, raw failure, reconnect policies, and all A unit cases green.
5. **M5 — Notification wrapper/settings/coordinator/mount (branch based on M4, rebased over M2).**
   - Own contracts settings, SettingsPanels, root mount, stacked-toast motion/reset seam, wrapper/coordinator. No lockfile/Vite/CI edits.
   - Exit: `vp check`, typecheck, full unit suite, manual permission/focus smoke; setting-off consumes state and constructor failure falls back.
6. **M6 — Notification browser cases + release (integration branch based on M3 + M5).**
   - Integration owner resolves shared web/root/toast changes, adds notification browser cases, updates changelog/version files, and runs the final suite.
   - Exit: 3 local + 3 Ubuntu browser passes, blocking-failure proof, final build, Minor release bookkeeping (or live-version-adjusted equivalent), and command-by-command handoff.

No branch other than M1/M6 edits lockfile, Vite browser config, or CI. If parallel work is used, it must use separate worktrees/branches; M6 is the only convergence point.

## Combined risks

| Risk | Impact | Gate |
|---|---|---|
| Notification semantics depend on render timing | Missed/duplicate alerts | Stable turn identities and raw state; coalesced-render tests |
| Environment replay looks fresh | Flood after saved/cloud/reconnect | Per-environment shell status + generation baseline |
| Browser harness bootstraps an unreal app | False green | Explicit dependency map and real routed production boundary |
| Reset misses module state | Order-dependent failures | One reset, twice-in-file/two-file proof, zero WS/toast assertions |
| Browser lane is nominally blocking but unreliable | CI ignored or bypassed | Menu-first gate, separate job, no `continue-on-error`, 3x Ubuntu rule |
| Workstreams collide | Large unbisectable change | Six green branches and exclusive configuration owner |
| Release metadata races live version | Wrong package/changelog version | Re-read live state at M6 and use sync script |

## Changes from v1 / how each red-team finding is resolved

- **F1:** Replaces awareness phase-edge completion with retained `activeTurnId`/`latestTurn.turnId` occurrence state; completion can settle from attention or appear in a coalesced completed render.
- **F2:** Separates observed, queued, attempted, delivered, and settled states; non-winners remain queued and failure has highest priority.
- **F3:** Detects failure from raw session/latest-turn state even while approval/input flags remain true; awareness is copy/priority projection only.
- **F4:** Arms and baselines per environment using catalog readiness, supervisor generation, and each shell's status/snapshot; settings hydration is separate.
- **F5:** Retains same-generation tombstones through disappearance/re-add, baselines new generations, ignores `updatedAt` as identity, and labels approval/input best-effort.
- **F6:** Requires `timeout: 0` plus visible dismiss timing; constructor/permission failures fall back; target/setting is rechecked at focus.
- **F7:** Adds the complete routed bootstrap dependency map and a narrower production routed-provider boundary using the real connection runtime.
- **F8:** Defines one authoritative unmount/dispose/toast/cache/store/storage/global reset and proves zero WS subscriptions across repeated cases.
- **S1:** Requires a proven turn ID, never `updatedAt`; covers ready-at-birth, title update, observed no-checkpoint turn, and ID-less starting-to-ready.
- **S2:** Chooses silent per-generation terminal reconnect baseline and explicitly accepts missed offline subprocess completions.
- **S3:** Keeps real integrated browser timers; only targeted Date/UUID/RNG inputs are deterministic.
- **S4:** Makes ComposerCommandMenu first; excludes LegendList from M1 and the release gate until independent repeated Ubuntu proof.
- **S5:** States Synara only reference-tested Playwright 1.58.2/helper 2.1.0; Neokod provider 4.1.9 comes from Vite+ 0.2.2; adds frozen-install/launch gate.
- **S6:** Shows the exact `playwright({ contextOptions: ... })` shape, keeps viewport in browser config, and asserts every invariant.
- **S7:** Adds a separate blocking 20-minute browser job with binary cache and measured cold/steady timing; existing 10-minute unit job stays unchanged.
- **S8:** Always consumes/dedupes while disabled and revalidates hidden fallback at focus; includes off-transition-on and hidden-navigate-focus tests.
- **S9:** Scopes reduced-motion acceptance to activity stacked toasts and changes/tests their normal root/content only.
- **S10:** Uses six consistent milestones, a 3-local/3-Ubuntu gate for each browser set, and a 15–22 engineer-day estimate with explicit deferrals.
- **S11:** Requires separate branches/worktrees and a single lockfile/Vite/CI owner; no one implements both streams as one pass.
- **N1:** Corrects semantics: awareness is a priority projection, `AppAtomRegistryProvider` injects no connection, and client-settings hydration is not environment hydration.
- **N2:** Retains live-version re-read and combined Minor bookkeeping; the browser-only branch does not prematurely apply the notification Minor bump.
- **N3:** Tests Ping/Pong/Request/Chunk/Exit/control frames through Neokod's real `WsRpcGroup` client before implementing the MSW `ws.link` mock.

## Out-of-scope

- Zustand/EventRouter migration, Synara route shape, Synara Electron/native bridge, or a second protocol layer.
- Removing Clerk, cloud, relay, hosted-static, desktop, or mobile as part of either workstream.
- Additive approval/input occurrence IDs in this release; revisit only if best-effort is unacceptable.
- Persistent notification inbox/history, cross-browser-restart exactly-once delivery, service-worker push, relay publishing, quiet hours, per-project rules, sound, vibration, or OS DND detection.
- PTY prompt parsing or terminal attention; only observed subprocess completion is covered.
- Exact notification for an agent episode that never exposes `activeTurnId` or `latestTurn.turnId`.
- Alerting terminal subprocess completion that occurs while disconnected under the chosen reconnect policy.
- Real LegendList geometry as an initial blocking gate, screenshots, visual diffs, exact pixels, or animation frame assertions.
- Standalone Playwright E2E, `@playwright/test`, multiple browsers, real Git worktrees, provider processes, cloud/relay calls, or filesystem mutation in component tests.
- Broad root/router/state refactors, a generic dependency-injection framework, or unrelated CI/release cleanup.
