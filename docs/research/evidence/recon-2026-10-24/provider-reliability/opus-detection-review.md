**Verdict: ACCEPT.** I found no blockers.

**What I reviewed.** Frozen worktree `/Users/kamogelo/.codex/worktrees/neokod-provider-detection/t3code`, branch `feat/neokod-provider-subscriptions`, HEAD **`baa09848a78bac0c9a3b2c3675087ca10a88fbda`**. It is one commit on base `1eee1929961e4659c70e968961cc82f90c355023`, changes 15 files, and the tree is clean. I read README, AGENTS, plan 16.19 (lane table and correction checkpoint), the Sol review, the Opus design report, and the correction prompt and answer. I traced the vendored Effect code and the installed `@opencode-ai/sdk@1.18.15`. I made no edits and ran no tests, builds or other commands that change anything. I'm running as `claude-opus-5-5`, but I can't confirm the effort level from inside the session, so that is part of your receipt check.

## Accepted findings

**1. Subscriptions are acquired up front, before refresh and snapshot**

- `ProviderRegistry.ts:695`, `keybindings.ts:653` and `serverSettings.ts:1125` each run `PubSub.subscribe` and then build `Stream.fromSubscription`. Per vendored `PubSub.ts:1130-1141`, the subscription is registered before the effect returns. This matches the existing `ProviderInstanceRegistry.subscribeChanges` pattern.
- All three PubSubs are unbounded, so nothing published during the snapshot is dropped.
- `subscribeServerConfigStream` (`ws.ts:1436-1450`) acquires all three subscriptions, then forks `refresh`, then reads `loadSnapshot`. The production caller (`ws.ts:2905-2922`) passes the real `subscribeChanges` effects. The yield-based helper is completely gone.
- The production paths implementing the interface are just the three layers plus `ServerSettings` `makeTest`, which returns an empty stream. Typecheck forces any new implementation to supply the field.

**2. Missed status updates are closed**

- Any publish after acquisition is buffered in the subscription and shows up after the snapshot, still going through the 200 ms provider debounce.
- A publish before acquisition is already in the state the snapshot reads afterwards (`loadServerConfig` reads `getProviders`, `getSettings` and `loadConfigState`).
- Providers, settings and keybindings each send their full state, so an update that is both in the snapshot and replayed after it does no harm.

**3. Scope cleanup and failure propagation work**

- `observeRpcStreamEffect` uses `Stream.unwrap`. Per `Channel.ts:6627-6640` that provides the stream's own scope, so the subscriptions and the forked refresh live as long as the RPC stream and are released when it closes.
- If the snapshot fails, the effect fails and the same scope releases the subscriptions.
- The live stream is now returned directly via `Stream.concat`, with no forked queue in between. A producer defect therefore reaches the RPC caller and its metrics, which fixes Sol's second finding.

**4. Settings secrets stay redacted**

- `materializeSettingsChange` (`serverSettings.ts:1085-1099`) behaves exactly like the old inline pipeline: same materialisation chain, same fallback to unmaterialised settings on `ServerSettingsError`, then `resolveTextGenerationProvider`. Both `streamChanges` and `subscribeChanges` use it.
- The WS live path still applies `redactServerSettingsForClient` before anything reaches the client (`ws.ts:1416`). The snapshot path is unchanged (`ws.ts:1866`).

**5. Wrapped SDK HTTP errors are classified correctly**

- `readHttpStatus` handles the real SDK wrapper shape, `new Error(message, { cause: { body, status } })` in `error-interceptor.js:26-35`.
- It also works when the SDK error arrives wrapped once more, still within its depth limit of 2.
- It reads only the number. The nested body, which can echo credentials, is never serialised.
- Path through the code: `runOpenCodeSdk` → `OpenCodeRuntimeError.detail` → `OpenCodeProbeError.detail` → `formatOpenCodeProbeError`. The ` (status=401)` suffix now reaches the existing substring check.
- The non-Error branch only switched to `readHttpStatus`. Its output is unchanged, and a test pins it.

**6. Tests are adequate**

- Regression 1 uses the real nested merge-and-debounce code (`acquireServerConfigUpdates`). It publishes provider-ready immediately after subscribing and before the snapshot, publishes keybindings and settings while the snapshot is held, and checks that the snapshot comes first and all three updates follow.
- Regression 2 checks that a defect propagates and that the stream finaliser runs.
- I relied on `detection-correction-answer.md` for the pass counts (40+2+21+27 tests, typecheck and check); I did not rerun them.

**7. Mock changes are fine.** The `server.test.ts` changes affect only the default mocks and the two `subscribeServerConfig` overrides. The five extra mock files add one type-only field each, matching what you authorised.

## Non-blocking notes on this change

- Regression 1 injects its own acquisition effects rather than the real `ProviderRegistryLive` or `ServerSettings` `subscribeChanges`. Those implementations are thin enough that reading them is enough to verify them. Still, nothing stops a future implementation that subscribes lazily, apart from the doc comment.
- The mocks in `ProviderRegistry.test.ts`, `ManagedClientEvidenceForwarder.test.ts` and `AnalyticsService.test.ts` back `streamChanges` with a real PubSub but give `subscribeChanges` an empty stream. That's acceptable now because those consumers use `streamChanges`. A future test that uses `subscribeChanges` would silently receive no events.

## Preexisting or out of scope (not blockers)

- **Fragile 401/403 check.** `OpenCodeProvider.ts:88-91` classifies by substring. SDK messages built by `describe()` include the request URL, so a port or path containing "401"/"403" could be wrongly reported as an authentication rejection. Passing the status as a field would fix it, but needs `OpenCodeProvider.ts`, which is outside this lane.
- **Non-Error diagnostics.** That branch still serialises `error`/`data`/`body` into the detail text.
- **Other lazy consumers.** `providerUpdateSettings.ts:41`, `ManagedClientEvidenceForwarder.ts:273` and `AnalyticsService.ts:440` still use lazy `streamChanges` and could have the same gap at startup.
- **Slow clients.** Each connection's subscription buffer is unbounded, as it was before.
- **Not established here.** No live desktop, browser, OpenCode server or pending-picker reproduction was done.

I couldn't save this as the plan-file artefact because this session has no write tool, so this message is the whole review.
