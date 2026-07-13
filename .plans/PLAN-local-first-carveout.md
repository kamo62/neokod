# Neokod local-first carve-out and package-namespace rename — v2

## Overview

This plan converts the live `feat/agent-notifications` tree at `1ce70b1aa` into a same-machine product, removes the mobile, marketing, cloud, relay, SSH, Tailscale, LAN, hosted-pairing, and general auth/session control planes, retains a narrow bearer boundary only for WSL, and finally renames the surviving workspace scope from `@t3tools/*` to `@neokod/*`.

The target access matrix is final:

| Runtime | Bind / endpoint | Stage 5 authentication |
| --- | --- | --- |
| Desktop primary | `127.0.0.1` | None |
| Standalone locally served web/server | `127.0.0.1` | None |
| Desktop WSL backend | `0.0.0.0` inside WSL; desktop-advertised WSL address | WSL-only bearer for HTTP plus a short-lived bearer-authorized WebSocket ticket |
| LAN/manual host, SSH, Tailscale, hosted web, relay | Removed | Not applicable |

The resulting product keeps `apps/desktop`, `apps/server`, and `apps/web`; Codex, Claude, Cursor, OpenCode, and Copilot; local projects/git/worktrees/diffs/terminal/preview/assets; and the local browser notification path. `ActivityNotificationCoordinator` depends on the pure `packages/shared/src/agentAwareness.ts`, not `apps/server/src/relay/AgentAwarenessRelay.ts`. It also keeps `ServerSecretStore` semantics for Copilot's GitHub token, server-setting secrets, and signed asset URLs, but relocates that generic service out of `apps/server/src/auth/`.

The complete carve-out and scope rename are a **SemVer major release: `2.0.0`**. Stage 1 adds `## 2.0.0 - 2026-07-13 (Major)` to `CHANGELOG.md`, explains the breaking contract/package/runtime removals, and sets the four canonical versions named by `scripts/update-release-package-versions.ts`: `apps/server/package.json`, `apps/desktop/package.json`, `apps/web/package.json`, and `packages/contracts/package.json`. Later stages append bullets to that same heading.

### Non-negotiable safety boundary

No unauthenticated server may bind to a non-loopback address. Stages must remain ordered: Stage 2 removes public host selection, LAN, SSH, and Tailscale before Stage 5 removes loopback auth. The sole wildcard listener is the WSL child. Server startup must fail closed when `host` is non-loopback unless the internal desktop bootstrap explicitly selects `wsl-bearer` and supplies its bearer secret. That secret is not accepted from CLI flags, public environment variables, persisted connection targets, or Vite configuration.

Stage 5 removes Clerk, browser cookies, pairing links, OAuth token exchange, persisted sessions, scopes, DPoP, auth-access RPCs, and `ServerConfig.auth` from the loopback path. It does **not** make WSL anonymous. The retained WSL primitive is a transport boundary, not the old session control plane: one desktop-generated credential, direct bearer validation on WSL API requests, and short-lived WebSocket tickets issued only after that bearer is verified.

### Certification environment

The host currently exposes repo-local Vite+ `vp v0.2.2`, but the reproducible certification environment is `.devcontainer/devcontainer.json` with the locked workspace installed. Run every stage's focused filter checks there, then the required whole-repo gates:

```sh
vp run typecheck
vp check
```

Use the repository's declared package manager (`pnpm@11.10.0`, through `vp install`) to regenerate `pnpm-lock.yaml`; never hand-edit it. Stage-specific tests/builds below are additive. `vp run lint:mobile` stops applying after Stage 1 because native mobile code no longer exists.

## Footprint inventory

### Auth, pairing, and WSL

- `apps/server/src/auth/` has 16 files: session/pairing/policy/DPoP/HTTP code plus the generic `ServerSecretStore.ts` and mixed `utils.ts` helpers.
- Server authorization crosses `apps/server/src/ws.ts` (`RPC_REQUIRED_SCOPE`, authenticated wrappers, WS tickets, auth-access stream), `apps/server/src/auth/http.ts`, `apps/server/src/http.ts`, `apps/server/src/orchestration/http.ts`, `apps/server/src/persistence/{AuthSessions,AuthPairingLinks}.ts`, and CLI/startup code.
- Contract surface spans `packages/contracts/src/{auth,baseSchemas,environmentHttp,rpc,server,desktopBootstrap,ipc}.ts`. In particular, `packages/contracts/src/server.ts` imports `ServerAuthDescriptor` and exposes `ServerConfig.auth`, while `apps/server/src/ws.ts` calls `serverAuth.getDescriptor()`.
- Hosted and local pairing are interleaved in `apps/web/src/components/auth/PairingRouteSurface.tsx`, `apps/web/src/routes/pair.tsx`, `apps/web/src/hostedPairing.ts`, and `apps/web/src/connection/onboarding.ts`. Those files must leave together, not across stages.
- WSL currently gets `desktopBootstrapToken` from `apps/desktop/src/backend/DesktopBackendConfiguration.ts`, binds `0.0.0.0`, and is registered by `apps/web/src/connection/platform.ts` as a bearer target. The primary-only `getLocalEnvironmentBearerToken` bridge crosses `apps/desktop/src/{preload.ts,ipc/channels.ts,ipc/DesktopIpcHandlers.ts,ipc/methods/window.ts}`, `packages/contracts/src/ipc.ts`, and `apps/web/src/environments/primary/desktopAuth.ts`; it is not the WSL bootstrap-list path.
- `ServerSecretStore` consumers that survive cloud/relay deletion are `apps/server/src/{server.ts,serverSettings.ts}`, `apps/server/src/provider/copilot/GithubDeviceLogin.ts`, `apps/server/src/assets/AssetAccess.ts`, and their tests. `AssetAccess.ts` also consumes four functions from `apps/server/src/auth/utils.ts`.

### Cloud, relay, and client-runtime relay state

- Direct cloud surfaces are `apps/web/src/cloud/`, `apps/web/src/components/cloud/`, `apps/server/src/cloud/`, Clerk providers/build config, hosted-static routing, Vercel config, and cloud/relay environment variables.
- Hosted relay infrastructure is `infra/relay/`; mobile activity publishing is `apps/server/src/relay/AgentAwarenessRelay.ts`.
- The full client-runtime cluster is larger than `packages/client-runtime/src/relay/`: `authorization/service.ts`, `authorization/tokenStore.ts`, `state/environmentHttpAuth.ts`, `state/shellSnapshotHttp.ts`, `state/threadSnapshotHttp.ts`, `platform/storageDocument.ts`, `state/relayDiscovery.ts`, `state/connections.ts`/`removeRelayEnvironments`, connection model/catalog/registry/resolver/supervisor code, and relay subpath exports in `packages/client-runtime/package.json`.
- Legacy server DPoP imports `packages/shared/src/dpop.ts`, which imports `dpopCommon.ts` and `relaySigning.ts`; `dpop.ts` uses `@noble/curves` and `@noble/hashes`. Those files, exports, dependencies, and tests remain until the legacy auth replacement occurs inside Stage 5.
- `apps/server/src/auth/http.ts` calls `traceAuthenticatedRelayRequest`/`traceRelayRequest` from `apps/server/src/cloud/traceRelayRequest.ts`; Stage 4 must remove those calls before deleting the cloud helper.

### Mobile and marketing

- `apps/mobile/` is already excluded by `pnpm-workspace.yaml`; its scripts, patches, release-smoke entries, lint debt rows, and stale docs can be deleted without changing the active runtime.
- `apps/marketing/` is not part of the local application. Its external wiring is the three root scripts in `package.json`, `scripts/release-smoke.ts`, its `@t3tools/marketing` package/filter, and `apps/marketing/vercel.ts`/`@vercel/config`. It is deleted in Stage 1 and never enters the namespace rename.

### Remote access and configured endpoints

- SSH/Tailscale/LAN behavior spans `packages/{ssh,tailscale}`, desktop exposure/network/SSH services and IPC, web connection settings/state, `packages/contracts/src/remoteAccess.ts`, `packages/shared/src/advertisedEndpoint.ts`, server host/Tailscale config, and connection-runtime target types.
- `apps/desktop/src/window/DesktopWindow.test.ts` still layers `DesktopServerExposure`; `apps/desktop/src/updates/DesktopUpdates.test.ts` still provides `setServerExposureMode` and `setTailscaleServe`. They must migrate in Stage 2 with production consumers.
- `apps/web/src/environments/primary/target.ts` accepts arbitrary `VITE_HTTP_URL`/`VITE_WS_URL`; `apps/web/src/environments/primary/bootstrap.test.ts` explicitly accepts `remote.example.com`. The final exception is not a Vite URL: only a desktop-bridge bootstrap identified as WSL and carrying the WSL bearer may use a non-loopback endpoint.
- `apps/desktop/src/app/DesktopConnectionCatalogStore.ts` migrates relay, SSH, and arbitrary bearer records; `packages/client-runtime/src/platform/storageDocument.ts` persists those targets/credentials plus DPoP tokens. These must be rewritten before their active contract types are removed.

### Build, CI, CSP, docs, and namespace

- `.github/workflows/ci.yml` asserts that the preload contains `__clerk_internal_electron_passkeys`; that assertion must leave with Clerk.
- `apps/desktop/src/electron/ElectronProtocol.ts` and its test retain Clerk/Cloudflare origins, `frame-src`, and scheme-wide relay/remote CSP allowances.
- Relay/mobile documentation residue exists in `docs/README.md`, `docs/architecture/connection-runtime.md`, `docs/operations/relay-observability.md`, `oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.ts`, and `.macroscope/check-run-agents/effect-service-conventions.md`. Stage-specific docs are enumerated below.
- The final rename must cover surviving manifests/imports/tests/Effect service identifiers/config/scripts/workflows/docs. `apps/server/package.json` is named `t3` but its internal dependency keys `@t3tools/contracts`, `@t3tools/shared`, and `@t3tools/web` still require renaming; `@t3tools/tailscale` must already be absent.

## Keep vs remove

| Area | Decision | Boundary |
| --- | --- | --- |
| Desktop primary and standalone local server/web | Keep | Bind only `127.0.0.1`; no auth/session gate after Stage 5. |
| WSL backend | Keep | Preserve `0.0.0.0` bind and WSL address; retain only the WSL bearer + WS-ticket transport boundary. |
| Codex, Claude, Cursor, OpenCode, Copilot | Keep | Remove auth wrappers, not provider/domain RPCs. |
| Git/worktrees/diffs/terminal/preview/assets | Keep | Signed asset capability remains separate from user/session auth. |
| Toasts and local activity notifications | Keep | Mount unconditionally in the normal root shell after Stage 5. |
| `packages/shared/src/agentAwareness.ts` | Keep | Pure local projection, unrelated to relay publishing. |
| `ServerSecretStore` | Keep and relocate | Required by Copilot, settings, and assets. |
| Applied auth migrations 020/021/022/031/032 | Keep immutable | Leave historical tables inert; never rewrite applied migration history. |
| Mobile and mobile-only tooling/patches | Remove in Stage 1 | Already outside the active workspace. |
| Marketing and its root/Vercel/build wiring | Remove in Stage 1 | Final user decision; excluded from Stage 6. |
| SSH, Tailscale, LAN/manual hosts | Remove in Stage 2 | No non-WSL remote access survives. |
| Relay infrastructure and mobile publisher | Remove in Stage 3 | Local notifications remain. |
| Cloud, hosted-static/pairing, Clerk, relay clients/contracts | Remove in Stage 4 | Preserve only temporary local auth until Stage 5. |
| Browser pairing, cookies, sessions, scopes, DPoP, auth admin/CLI | Remove in Stage 5 | WSL uses the separate minimal bearer transport boundary. |
| `.repos/alchemy-effect/` | Keep read-only | Stop syncing it after relay removal; AGENTS.md forbids editing vendored repos. |
| Server package/bin `t3` and surviving local `T3CODE_*` names | Keep | The requested rename is workspace scope only; remove only cloud/auth/remote variables. |

## Staged plan

### Stage 1 — Establish 2.0.0; delete mobile and marketing

**Outcome:** remove two isolated product leaves before touching active transport code and establish the single major-release changelog/version boundary.

**Delete:**

- Entire `apps/mobile/` and `apps/marketing/` (including `apps/marketing/vercel.ts`).
- `scripts/mobile-native-static-check.ts` and `.test.ts`.
- The nine unreferenced mobile-only patches for `@expo/metro-config`, `@legendapp/list`, `@react-native-menu/menu`, `@react-navigation/native-stack`, `expo-modules-jsi`, `react-native-gesture-handler`, `react-native-keyboard-controller`, `react-native-nitro-modules`, and `react-native-screens`. Keep the Effect Vitest, Effect, FFF, and Pierre Diffs patches still declared in `patchedDependencies`.

**Modify:**

- `package.json`: remove `dev:marketing`, `start:marketing`, and `build:marketing`. The existing generic `apps/*` build filter needs no replacement.
- `scripts/release-smoke.ts`: remove mobile/native-module and `apps/marketing/package.json` expectations.
- `pnpm-workspace.yaml`: remove the dead `!apps/mobile` exclusion/comments, mobile-only Clerk/Expo catalog/override/patch entries, and no longer referenced patches. The `apps/*` glob naturally stops seeing both deleted apps.
- `vite.config.ts`, `.cursor/rules/cursor-cloud.mdc`, and `oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.ts`: remove mobile exclusions/guidance/debt rows.
- `docs/README.md`: remove the already-broken `docs/mobile/app.md` link. Update mobile/marketing statements in `README.md`, `FORK.md`, `HANDOFF.md`, `docs/architecture/{overview,connection-runtime}.md`, `docs/reference/workspace-layout.md`, and release docs only where the deleted products are described.
- `CHANGELOG.md` and the four canonical version manifests: establish `2.0.0` as described above.
- Regenerate `pnpm-lock.yaml`; `@vercel/config` remains temporarily because `apps/web/vercel.ts` still uses it until Stage 4.

**Verify:**

```sh
test ! -d apps/mobile
test ! -d apps/marketing
! rg -n 'apps/marketing|@t3tools/marketing|dev:marketing|start:marketing|build:marketing' package.json scripts pnpm-workspace.yaml
vp install --lockfile-only
vp run --filter @t3tools/scripts typecheck
vp run --filter @t3tools/scripts test
vp run typecheck
vp check
```

### Stage 2 — Remove SSH/Tailscale/LAN and enforce loopback except authenticated WSL

**Outcome:** every non-WSL server path becomes loopback-only while the existing auth stack still protects WSL. This is the security prerequisite for Stage 5.

**Delete:**

- Entire `packages/ssh/`, `packages/tailscale/`, and `apps/desktop/src/ssh/`.
- Desktop SSH IPC/services/tests; `apps/desktop/src/backend/{tailscaleEndpointProvider,DesktopNetworkInterfaces}.ts` and tests; `apps/desktop/src/ipc/methods/serverExposure.ts`; remote SSH/password UI/state.
- `packages/contracts/src/remoteAccess.ts`, `packages/shared/src/advertisedEndpoint.ts`, and remote-access docs `docs/architecture/remote.md`/`docs/user/remote-access.md`. Keep `packages/client-runtime/src/environment/endpoint.ts`: move its small `normalizeHttpBaseUrl`/`deriveWsBaseUrl` functions local before deleting the shared re-export because descriptor, snapshot, and temporary auth callers still need `environmentEndpointUrl`.
- Do **not** delete `apps/web/src/connection/onboarding.ts`, `packages/client-runtime/src/connection/onboarding.ts`, `apps/web/src/components/auth/PairingRouteSurface.tsx`, `apps/web/src/routes/pair.tsx`, or `apps/web/src/hostedPairing.ts`; Stage 4 removes that whole hosted-pairing cluster atomically.

**Create/extract:**

- Move only the WSL Node PATH/version-manager script from `packages/ssh/src/tunnel.ts` into `apps/desktop/src/wsl/wslNodeEnvironment.ts` with its focused test; rename it `buildWslNodeEnvScript`.
- Replace remote-heavy `DesktopServerExposure` with `apps/desktop/src/backend/DesktopLocalServer.ts`: primary/standalone bind `127.0.0.1`; no mode, interface scan, manual endpoint, or Tailscale state. Preserve an explicit WSL configuration branch whose bind is `0.0.0.0` and whose legacy credential remains mandatory until Stage 5.

**Modify:**

- Remove SSH/Tailscale dependencies from desktop/server manifests and their package exports; regenerate the lockfile.
- Migrate production and test consumers to `DesktopLocalServer`: `apps/desktop/src/{main.ts,app/DesktopApp.ts}`, backend manager/configuration, WSL backend, settings, IPC/preload, plus the easily missed `window/DesktopWindow.test.ts` and `updates/DesktopUpdates.test.ts`. Remove every `setServerExposureMode`/`setTailscaleServe` stub.
- Remove SSH/exposure/Tailscale fields and methods from `packages/contracts/src/{ipc,desktopBootstrap}.ts`, client-runtime connection model/catalog/registry/resolver/presentation, `ConnectionsSettings.tsx`, `uiStateStore.ts`, and desktop settings. Decode old settings tolerantly but never write remote exposure fields again.
- Remove public `--host`, `T3CODE_HOST`, Tailscale flags/env, LAN connection strings, and interface selection from server CLI/config/startup. Constrain the Vite development server's `HOST`/host setting to loopback too. Only the desktop's private bootstrap may ask for the WSL wildcard bind.
- In `apps/web/src/environments/primary/target.ts`, reject non-loopback `VITE_HTTP_URL` and `VITE_WS_URL`, non-loopback browser window origins, mismatched HTTP/WS hosts, credentials, and unsupported protocols. Update `apps/web/src/environments/primary/bootstrap.test.ts` so `remote.example.com`, LAN IPs, wildcard hosts, and a remotely hosted window origin fail; keep `localhost`, `127.0.0.1`, and `::1` cases.
- Add the proven WSL exception separately: only `window.desktopBridge.getLocalEnvironmentBootstraps()` entries with an explicit authenticated-WSL discriminator/credential, a non-null `runningDistro`, and matching HTTP/WS WSL origins may be non-loopback. Accept `wsl:*` secondary ids and the `primary` id only in WSL-only mode. Vite config can never invoke this exception. Test accepted parallel-WSL and WSL-only entries plus rejected forged/non-desktop entries.
- Update `docs/architecture/connection-runtime.md`, `docs/integrations/source-control-providers.md`, `docs/reference/scripts.md`, `FORK.md`, `HANDOFF.md`, and `CHANGELOG.md` for loopback plus authenticated WSL only.

**Verify:**

```sh
! rg -n 'DesktopServerExposure|setServerExposureMode|setTailscaleServe' apps/desktop/src/window/DesktopWindow.test.ts apps/desktop/src/updates/DesktopUpdates.test.ts
! rg -n '@t3tools/(ssh|tailscale)|T3CODE_TAILSCALE|network-accessible' apps packages scripts package.json
vp install --lockfile-only
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/shared typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter @t3tools/desktop typecheck
vp run --filter @t3tools/web typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/scripts typecheck
vp run typecheck
vp check
vp test
```

Runtime checks must inspect listening sockets: primary desktop and `t3 serve` listen only on `127.0.0.1`; WSL still listens on `0.0.0.0`, accepts its authenticated path, and rejects unauthenticated API/WS access.

### Stage 3 — Remove relay infrastructure and mobile publishing

**Outcome:** delete hosted deployment/push producers without touching local notification projection or the DPoP files still used by legacy server auth.

**Delete:**

- Entire `infra/relay/`.
- `apps/server/src/relay/AgentAwarenessRelay.ts` and `.test.ts`.
- `docs/operations/relay-observability.md`.

**Modify:**

- Remove the relay layer/publish calls from `apps/server/src/server.ts`, `apps/server/src/orchestration/Layers/OrchestrationReactor.ts` and test, and `apps/server/integration/OrchestrationEngineHarness.integration.ts`.
- Remove the `infra/*` workspace glob, now-unused `@effect/sql-pg`, relay release-smoke entry, Alchemy reference registration in `scripts/lib/reference-repos.ts`/test, `.alchemy` ignores/config, and the relay/Alchemy instruction in `AGENTS.md`. Do not edit `.repos/alchemy-effect/`.
- Remove `AgentAwarenessRelay.test.ts` from `oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.ts` and relay examples from `.macroscope/check-run-agents/effect-service-conventions.md`.
- Update `docs/architecture/{overview,connection-runtime}.md`, `FORK.md`, `HANDOFF.md`, and `CHANGELOG.md`; state that `packages/shared/src/agentAwareness.ts` and local browser notifications remain.
- Keep `packages/contracts/src/relay.ts`, client relay code, and shared relay/auth utilities for the still-present cloud client until Stage 4. In particular keep `packages/shared/src/{dpop,dpopCommon,relaySigning}.ts`, their tests/exports, and `@noble/*` through Stage 4 and into Stage 5.

**Verify:**

```sh
test ! -d infra/relay
! rg -n 'AgentAwarenessRelay|infra/relay' apps/server oxlint-plugin-t3code docs .macroscope scripts pnpm-workspace.yaml
vp install --lockfile-only
vp run --filter t3 typecheck
vp run --filter @t3tools/scripts typecheck
vp run typecheck
vp check
vp test
```

Also run the orchestration reactor/harness tests and `apps/web/src/notifications/activityNotifications.logic.test.ts` plus `packages/shared/src/agentAwareness.test.ts`.

### Stage 4 — Remove cloud, hosted pairing/static, Clerk, and relay clients/contracts

**Outcome:** remove the complete T3 Connect/hosted vertical slice while retaining only a temporary local session bootstrap until Stage 5. The `/pair` UI is removed atomically here, so this stage also provides a small temporary automatic local bootstrap path for fresh desktop/standalone startup.

**Delete atomically:**

- `apps/web/src/cloud/`, `apps/web/src/components/cloud/`, `apps/web/src/components/clerk/`, `apps/server/src/cloud/`, and `apps/server/src/cli/connect.ts`/test.
- `apps/desktop/src/app/DesktopClerk.ts`/test.
- Hosted/local pairing surface cluster: `apps/web/src/components/auth/PairingRouteSurface.tsx`, `apps/web/src/routes/pair.tsx`, `apps/web/src/hostedPairing.ts`/test, `apps/web/src/connection/onboarding.ts`, `packages/client-runtime/src/connection/onboarding.ts`/test, and settings `pairingUrls.ts`/test. Regenerate `apps/web/src/routeTree.gen.ts`; never hand-edit it.
- `apps/web/vercel.ts`, `scripts/apply-web-brand-assets.ts` if no remaining caller, and `docs/cloud/`.
- Entire `packages/client-runtime/src/relay/`, `packages/contracts/src/{relay,relayClient}.ts` and relay tests, and relay-only shared modules/tests (`relayAuth`, `relayClient`, `relayJwt`, `relayTracing`, `relayUrl`).
- `packages/client-runtime/src/authorization/tokenStore.ts`, `state/relayDiscovery.ts`, and the `./relay`/`./state/relay` subpath exports in `packages/client-runtime/package.json`.
- Do **not** delete shared `dpop.ts`, `dpopCommon.ts`, `relaySigning.ts`, their tests/exports, or `@noble/*`; `apps/server/src/auth/dpop.ts` still imports them until Stage 5.

**Modify hosted-pairing transition:**

- Change `apps/server/src/startupAccess.ts` to print/open a temporary `/?token=...` local URL instead of `/pair?...`.
- Change `apps/web/src/environments/primary/auth.ts` and `routes/__root.tsx` so the Stage 4-only gate automatically consumes either the desktop bootstrap credential or that startup URL token, strips it, and establishes the existing cookie session. If neither is present, fail with an actionable local-startup error; never redirect to deleted `/pair`.
- Remove `/pair` redirects/context from `_chat.tsx`, `settings.tsx`, and root routing while still requiring the temporary authenticated result before mounting the shell. Stage 5 deletes this automatic session bootstrap entirely. Verify a clean desktop launch and a fresh `t3 serve` browser launch, not only an already-cookie-authenticated browser.

**Modify full relay/Clerk cluster:**

- `apps/web/src/main.tsx`, root/settings/chat surfaces, branding, state, and runtime: remove Clerk providers, cloud dialogs, hosted-static bootstrap, relay discovery/wakeups/tracing, mobile-client and cloud controls. Keep local primary and WSL UI.
- In `packages/client-runtime/src/authorization/service.ts`, remove `authorizeDpop`, relay endpoint/token-store/signer dependencies, and leave bearer authorization only. Prune `authorization/remote.ts` to bearer exchange/ticket helpers temporarily required by legacy WSL auth.
- In `state/environmentHttpAuth.ts`, remove `ManagedRelayDpopSigner` and the DPoP branch; emit either bearer headers or no headers. Remove signer dependencies/comments from `state/shellSnapshotHttp.ts` and `state/threadSnapshotHttp.ts`.
- Rewrite `platform/storageDocument.ts`/tests to drop relay targets and `remoteDpopTokens` while temporarily retaining only bearer data needed before Stage 5. Remove `removeRelayEnvironments` from `state/connections.ts`, connection registry/tests, and callers.
- Update the connection model/catalog/registry/resolver/supervisor/presentation and tests to remove relay kinds, credentials-changed relay behavior, cloud capabilities, and relay errors.
- Remove relay/connect endpoints and exports from `packages/contracts/src/{environmentHttp,rpc,index}.ts` and `packages/contracts/package.json`; keep legacy local auth contract members until Stage 5.
- Remove cloud/relay layers/RPC handlers from `apps/server/src/{server,ws,http}.ts`. Before deleting `apps/server/src/cloud/traceRelayRequest.ts`, remove `traceAuthenticatedRelayRequest`/`traceRelayRequest` imports and calls from `apps/server/src/auth/http.ts` and `apps/server/src/http.ts`; ordinary Effect spans remain.
- Remove Clerk/passkey code from desktop preload/app/build scripts/Vite configs/manifests, web config/manifest/env types, public-config scripts, `.env.example`, and `pnpm-workspace.yaml`; remove Vercel config after both marketing and web consumers are gone. Regenerate the lockfile.
- `.github/workflows/ci.yml`: delete the `__clerk_internal_electron_passkeys` grep; retain/replace it only with a generic assertion that the preload build exists and imports successfully.
- `apps/desktop/src/electron/ElectronProtocol.ts`/test: remove `clerkFrontendApiHostname`, Clerk/Cloudflare challenge script origins, challenge `frame-src`, and relay/remote commentary. Build CSP from `'self'`, the actual target/backend origins, loopback origins, and explicit desktop-provided WSL origins only; no Clerk/Cloudflare residue and no arbitrary HTTPS/WSS remote allowance.
- Update `docs/README.md`, `docs/architecture/connection-runtime.md`, `docs/operations/{release,observability}.md`, `docs/reference/{scripts,workspace-layout}.md`, `FORK.md`, `HANDOFF.md`, and `CHANGELOG.md` for removal of cloud/hosted/relay/Clerk.

**Verify:**

```sh
! rg -n 'HostedPairingRouteSurface|PairingRouteSurface|readHostedPairingRequest|connectPairing|/pair' apps/web/src apps/server/src/startupAccess.ts packages/client-runtime/src
! rg -n 'traceAuthenticatedRelayRequest|traceRelayRequest' apps/server/src/auth apps/server/src/http.ts
! rg -n '__clerk_internal_electron_passkeys' .github/workflows/ci.yml
! rg -n 'clerkFrontendApiHostname|challenges\.cloudflare\.com' apps/desktop/src/electron
! rg -n 'ManagedRelayDpopSigner|removeRelayEnvironments|remoteDpopTokens' packages/client-runtime/src
rg -n '@t3tools/shared/(dpop|dpopCommon|relaySigning)|@noble/(curves|hashes)' apps/server/src/auth packages/shared pnpm-workspace.yaml
vp install --lockfile-only
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/shared typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter @t3tools/desktop typecheck
vp run --filter @t3tools/web build
vp run --filter @t3tools/web typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/scripts typecheck
vp run typecheck
vp check
vp test
vp run build
```

### Stage 5 — Remove loopback auth/session control plane; retain WSL-only bearer

**Outcome:** primary desktop and standalone local web use direct unauthenticated loopback HTTP/WS. WSL stays on `0.0.0.0` behind a narrowly named bearer transport boundary. No general remote target, persisted bearer environment, Clerk/session/pairing/scope/DPoP control plane remains.

#### Exact WSL primitives retained

1. **Private desktop bootstrap secret:** `DesktopBackendConfiguration.ts` generates a 192-bit random token only for WSL. Rename `desktopBootstrapToken` to `wslBearerToken`; primary loopback bootstrap carries no secret. `packages/contracts/src/desktopBootstrap.ts` keeps only the optional/internal WSL field and a transport discriminator.
2. **Desktop topology delivery:** keep `getLocalEnvironmentBootstraps` in `packages/contracts/src/ipc.ts`, `apps/desktop/src/ipc/methods/window.ts`, and `preload.ts`. Its discriminated entries are `loopback` (no token, loopback URL required) or `wsl-bearer` (token and non-null `runningDistro` required, matching WSL HTTP/WS origins). A WSL entry is either a `wsl:*` secondary or `primary` when WSL-only mode owns the primary slot. This is the only renderer credential path.
3. **WSL server middleware:** add a small `apps/server/src/transport/WslBearerAuth.ts` service enabled only by the private WSL bootstrap. It uses constant-time comparison for `Authorization: Bearer ...`, guards WSL environment/orchestration HTTP APIs, and fails startup if a wildcard/non-loopback host lacks this mode/token. Static app files remain loadable; sensitive API routes do not.
4. **WebSocket adapter:** keep a WSL-only `POST /api/wsl-auth/websocket-ticket` protected by the bearer. Issue short-lived, opaque, single-use in-memory tickets and consume one during WSL `/ws` upgrade. Never put the long-lived bearer in a WebSocket URL. Loopback `/ws` upgrades directly and does not expose this endpoint.
5. **Client preparation:** retain a specifically named in-memory `WslConnectionTarget`/registration and bearer request/ticket helper in client-runtime. It receives the token from current desktop topology, attaches bearer headers to WSL HTTP/snapshot calls, and obtains the WSL WS ticket. It is never persisted and cannot be constructed from Vite URLs or legacy catalog records.

Nothing else is retained: no browser cookie, pairing grant, OAuth exchange, access-token session, session DB, revocation/admin UI, scopes, DPoP proof, auth descriptor, primary bearer IPC, or generic bearer target. DPoP is not a WSL bearer primitive.

#### Compile-safe order inside Stage 5

**1. Rewrite consumers and persistence before deleting types:**

- Rewrite `apps/web/src/connection/platform.ts` first: a native primary registration becomes direct loopback; a WSL-only `primary` and parallel `wsl:*` registrations both use the explicit WSL target and original desktop token directly, with no scopes/OAuth exchange/registration abstraction. Remove `ClientPresentation`, `PrimaryEnvironmentAuth`, generic `BearerConnectionTarget`, and saved remote registration logic only after callers compile.
- Rewrite `packages/client-runtime/src/platform/storageDocument.ts` to schema v2 with no targets/profiles/credentials/DPoP tokens. It may decode v1 only to normalize to empty v2. Dynamic primary/WSL registrations remain in memory.
- Rewrite `apps/desktop/src/app/DesktopConnectionCatalogStore.ts` before removing relay/SSH/bearer contract classes: migrate any legacy relay, SSH, or arbitrary bearer catalog to empty v2, delete legacy `DesktopSavedEnvironments` secrets, and atomically persist the empty document. Tests must prove that `remote.example.com`, relay, SSH, credentials, and DPoP tokens are discarded rather than rehydrated. Keep the cleanup decoder for the 2.0.0 upgrade; it is not an active remote feature.
- Then remove obsolete target/profile/credential/registration types from client-runtime connection model/catalog/registry/resolver/presentation and their tests. Keep only direct loopback and non-persisted WSL target forms.
- Finish the URL boundary in `apps/web/src/environments/primary/target.ts`: configured Vite targets remain loopback-only; the non-loopback branch accepts only the discriminated desktop WSL bootstrap and requires its bearer. Tests cover forged ids, missing token, mismatched origins, and a valid WSL entry.

**2. Replace server auth and contracts atomically:**

- Add the WSL bearer/ticket service and client helper/tests first. Wire `apps/server/src/http.ts`, `orchestration/http.ts`, and `ws.ts` by runtime mode: loopback calls the APIs/RPC group directly; WSL applies the narrow bearer/ticket gate. Remove `RPC_REQUIRED_SCOPE`, `AuthenticatedSession`, `authorizeEffect`/`authorizeStream`, cookies, DPoP checks, generic WS tickets, and `subscribeAuthAccess` while preserving ordinary instrumentation and all domain RPCs.
- Remove `ServerAuthDescriptor` and auth schemas from `packages/contracts/src/auth.ts`; remove `ServerConfig.auth` and its import from `packages/contracts/src/server.ts`; remove `serverAuth.getDescriptor()` and returned `auth` from `apps/server/src/ws.ts` in the same change. Update all config fixtures/assertions together.
- Remove auth middleware/groups/errors from `packages/contracts/src/environmentHttp.ts`, auth errors/RPCs from `rpc.ts`, `AuthSessionId` from `baseSchemas.ts`, and generic auth exports. Keep only a tiny WSL ticket request/result schema if the typed HTTP client requires it; name it WSL-specific and do not put it in `auth.ts`.
- Rename the private desktop bootstrap fields/types in `packages/contracts/src/{desktopBootstrap,ipc}.ts`, desktop backend configuration/manager, server config/CLI bootstrap decoder, and tests. No public CLI/env can set WSL bearer mode.

**3. Remove primary bearer IPC while preserving WSL topology:**

- Delete `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts`/test.
- Delete `GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL` from `apps/desktop/src/ipc/channels.ts`, its method/handler in `ipc/methods/window.ts` and `ipc/DesktopIpcHandlers.ts`, the `preload.ts` bridge method, `DesktopBridge.getLocalEnvironmentBearerToken`, `apps/web/src/environments/primary/desktopAuth.ts`/test, and all fixtures.
- Keep only `getLocalEnvironmentBootstraps`, whose WSL variant carries the WSL token. Tests must prove loopback entries never include a credential and WSL entries always do.

**4. Relocate generic secrets/crypto, then delete legacy auth:**

- Move `apps/server/src/auth/ServerSecretStore.ts`/test to `apps/server/src/secrets/ServerSecretStore.ts`/test and update `server.ts`, `serverSettings.ts`, `provider/copilot/GithubDeviceLogin.ts`, `assets/AssetAccess.ts`, plus `server.test.ts`, `bin.test.ts`, `serverSettings.test.ts`, `provider/copilot/GithubDeviceLogin.test.ts`, and `assets/AssetAccess.test.ts`.
- Move reusable encoding/HMAC/constant-time helpers from `apps/server/src/auth/utils.ts` to a neutral server crypto module used by asset tokens and, if needed, the WSL ticket implementation. Do not couple WSL transport to `assets/`.
- Require these searches to return zero before deleting `apps/server/src/auth/`:

```sh
! rg -n 'auth/ServerSecretStore|auth/utils' apps/server/src
! rg -n 'ServerSecretStore|base64UrlEncode|base64UrlDecodeUtf8|signPayload|timingSafeEqual' apps/server/src/auth
```

- Delete legacy `EnvironmentAuth*`, `PairingGrantStore*`, `SessionStore*`, `dpop*`, `auth/http.ts`, `persistence/{AuthSessions,AuthPairingLinks}.ts`, auth aliases/correlations from `persistence/Errors.ts` and `RepositoryErrorCorrelation.test.ts`, `cli/auth.ts`, `cliAuthFormat.ts`/test, and auth branches in `bin.ts`, `cli/project.ts`, `startupAccess.ts`, `serverRuntimeStartup.ts`, and their tests. Remove web auth state/bootstrap/pairing URL code, client-runtime generic session/OAuth authorization, and shared `oauthScope`/`remote`/`qrCode` after zero callers.
- Keep historical migrations 020/021/022/031/032 registered and immutable. No runtime repository reads their tables.
- DPoP ordering: only after `apps/server/src/auth/dpop.ts` and all DPoP consumers are gone, delete `packages/shared/src/{dpop,dpopCommon,relaySigning}.ts`, their tests/exports, and `@noble/curves`/`@noble/hashes`. This is the final Stage 5 substep, not a Stage 4 deletion.

**5. Make the local shell unconditional:**

- In `apps/web/src/routes/__root.tsx`, remove auth `beforeLoad`, auth route context, unauthenticated branches, and the temporary Stage 4 bootstrap. Render the normal `CommandPalette` + `AppSidebarLayout` directly.
- Always wrap that shell with `ToastProvider` and `AnchoredToastProvider`; always mount `SlowRpcRequestToastCoordinator`, `ActivityNotificationCoordinator`, renamed `TracingBootstrap`, `EventRouter`, and `ProviderUpdateLaunchNotification`. Keep `RootRouteErrorView` as the only alternative.
- Remove auth guards/context from `_chat.tsx`, `_chat.index.tsx`, and `settings.tsx`; remove access/pairing/session settings. Rewrite environment HTTP test fixtures for direct loopback plus explicit WSL bearer.
- Update `docs/architecture/{overview,connection-runtime,runtime-modes}.md`, `docs/reference/{encyclopedia,scripts,workspace-layout}.md`, `README.md`, `FORK.md`, `HANDOFF.md`, and `CHANGELOG.md` with the exact access matrix and WSL bearer boundary.

**Verify:**

```sh
test ! -d apps/server/src/auth
! rg -n 'auth/ServerSecretStore|auth/utils|getLocalEnvironmentBearerToken|GET_LOCAL_ENVIRONMENT_BEARER_TOKEN' apps packages
! rg -n 'ServerAuthDescriptor|serverAuth\.getDescriptor|RPC_REQUIRED_SCOPE|subscribeAuthAccess|AuthSessionId' apps packages
! rg -n 'dpop|Dpop|DPoP|@noble/(curves|hashes)' apps packages pnpm-workspace.yaml
! rg -n 'RelayConnectionTarget|SshConnectionTarget|BearerConnectionTarget|remoteDpopTokens' apps/desktop/src/app packages/client-runtime/src
vp install --lockfile-only
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/shared typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/desktop typecheck
vp run --filter @t3tools/web build
vp run --filter @t3tools/web typecheck
vp run typecheck
vp check
vp test
vp run build
```

Runtime certification must prove all of the following:

1. Desktop primary and `t3 serve` listen only on `127.0.0.1` and open without `/pair`, cookies, bearer, or WS ticket.
2. WSL listens on `0.0.0.0`; sensitive HTTP returns 401 for missing/wrong bearer and succeeds for the desktop-provided bearer; WS rejects absent/invalid/expired/reused tickets and succeeds with a fresh ticket.
3. A non-loopback server without the private WSL discriminator/token refuses startup; arbitrary Vite/persisted endpoints cannot invoke the WSL exception.
4. Providers, git/worktrees/diffs/branches, terminal, preview, and signed assets work in loopback and WSL modes.
5. Both toast providers and both coordinators are mounted, and a background completion still produces its notification/toast.

### Stage 6 — Rename the surviving package namespace to `@neokod/*`

**Outcome:** rename only the packages/files that survived Stages 1–5. Marketing, mobile, relay, SSH, Tailscale, cloud, and legacy auth are already absent.

**Rename manifests/dependencies:**

- Root package to `@neokod/monorepo`; desktop/web/client-runtime/contracts/shared/scripts/oxlint package names to their `@neokod/*` equivalents.
- `apps/server/package.json` keeps package/bin name `t3`, but rename its surviving dependency keys to `@neokod/contracts`, `@neokod/shared`, and `@neokod/web`. Assert that `@t3tools/tailscale` is absent.
- Rename all other surviving internal dependency keys. There is no marketing package/filter to rename.
- Regenerate `pnpm-lock.yaml`; do not text-replace it.

**Rename source/config/workflows/docs:**

- Replace every surviving old-scope import/type import/dynamic import/test mock/Effect `Context.Service` identifier with `@neokod/*` across desktop, server, web, client-runtime, contracts, shared, scripts, and oxlint.
- Update `apps/desktop/vite.config.ts` bundling prefix, `apps/server/vite.config.ts` external prefix and `@neokod/web#build`, root Vite lint messages, scripts/filter tests, `.github/workflows/{ci,release}.yml`, and release tooling.
- Update `AGENTS.md`, `FORK.md`, `HANDOFF.md`, surviving docs, `.macroscope/check-run-agents/effect-service-conventions.md`, and `.plans/PLAN-notifications-and-browser-tests.md` examples. Keep filesystem paths such as `./oxlint-plugin-t3code/index.ts`, `apps/web/public`, workspace globs/catalog, and tsconfig `~/*` unchanged because they are not package specifiers.
- Leave server bin `t3`, local compatibility env/storage names, and the `oxlint-plugin-t3code` directory/plugin id unchanged unless separately authorized.

**Verify:**

```sh
vp install --lockfile-only
vp run --filter @neokod/contracts typecheck
vp run --filter @neokod/shared typecheck
vp run --filter @neokod/client-runtime typecheck
vp run --filter @neokod/desktop typecheck
vp run --filter @neokod/web typecheck
vp run --filter @neokod/scripts typecheck
vp run --filter t3 typecheck
vp run typecheck
vp check
vp test
vp run build
```

Generate the implementation file set after Stage 5 with `git grep -l '@t3tools'`. The final active-tree gate is:

```sh
git grep -n '@t3tools' -- ':!.plans/PLAN-local-first-carveout.md'
```

Expected exit status is 1 with no output. This plan is the one tracked historical exception because it documents pre-rename filters/specifiers. A broad `rg` may additionally report the pre-existing untracked `demo.md`; do not modify it. `PLAN-exec-demo.md` currently has no old-scope hit.

## Risks

| Risk | Severity | Mitigation / proof |
| --- | --- | --- |
| Unauthenticated non-loopback listener | Critical | Stage 2 first; Stage 5 startup invariant rejects non-loopback without private WSL bearer mode; inspect sockets. |
| WSL accidentally becomes anonymous | Critical | Retain WSL bearer HTTP check and short-lived WS ticket; negative runtime tests are mandatory. |
| WSL bearer leaks into loopback/general config | Critical | Generate only for WSL, deliver only via desktop topology, no CLI/env/Vite/persistence input, discriminated contracts. |
| Pair route deleted before a fresh local session can start | High | Stage 4 atomically replaces it with temporary automatic desktop/startup-token bootstrap; test clean launches; Stage 5 removes the temporary gate. |
| DPoP dependency deleted while server auth still imports it | High | Keep shared DPoP/signing/`@noble/*` through Stage 4; delete only at final Stage 5 zero-hit gate. |
| Toasts/notifications disappear with auth branch | High | Stage 5 makes the complete normal shell/provider/coordinator tree unconditional and runtime-tests a completion. |
| Secret-store relocation breaks Copilot/settings/assets | High | Relocate before deleting auth, update every listed source/test, enforce zero old imports. |
| Legacy remote catalog resurrects external targets | High | Schema-v2 empty migration and secret purge happen before deleting old target types; WSL is topology-only/in-memory. |
| CSP or configured URL keeps a remote escape hatch | High | Host validation plus explicit WSL discriminator; CSP uses actual local/WSL origins; reject arbitrary HTTPS/WSS. |
| Contract/RPC removal breaks retained domain behavior | High | Rewrite consumers before types, typecheck each package in dependency order, run retained feature integration tests. |
| Historical DB chain breaks | High | Keep applied auth migrations immutable and inert. |
| Namespace rename is partial | High | Rename server dependency keys too, regenerate lock, scoped zero-hit gate, full build/test. |
| Clerk removal damages ordinary signing | Medium | Remove only Clerk/passkey entitlements/native code; retain normal signing/notarization/updater checks. |
| User-owned dirty files are changed | High | Limit work to planned files per stage; never touch pre-existing `PLAN-exec-demo.md`/`demo.md` unless separately requested. |

## Changes from v1 / red-team resolution map

| Finding | v2 resolution |
| --- | --- |
| Pairing deletion split across Stages 2/4 | Stage 2 explicitly retains onboarding; Stage 4 atomically removes `PairingRouteSurface.tsx`, `routes/pair.tsx`, `hostedPairing.ts`, onboarding, and route-tree entries, with a temporary fresh-start bootstrap. |
| Exposure service left in desktop tests | Stage 2 names `window/DesktopWindow.test.ts` and `updates/DesktopUpdates.test.ts` and zero-checks their old symbols. |
| DPoP ordering break | Shared DPoP/common/signing, tests, exports, and `@noble/*` survive Stage 4; final Stage 5 removes them only after legacy auth has zero consumers. |
| Relay tracing imported by auth | Stage 4 removes both tracing hooks from `auth/http.ts` and `http.ts` before deleting the cloud helper. |
| Client-runtime relay cluster incomplete | Stage 4 enumerates authorization service/token store, HTTP/snapshot state, storage document, discovery, connections command, connection graph, and package exports; authorization becomes bearer-only. |
| CI requires Clerk preload symbol | Stage 4 deletes/replaces the exact CI grep. |
| `ServerConfig.auth` survives | Stage 5 removes `ServerAuthDescriptor`, contract field, `ws.ts` producer, fixtures, and assertions atomically. |
| Core transport/persistence consumers missed | Stage 5 orders `connection/platform.ts`, `storageDocument.ts`, `DesktopConnectionCatalogStore.ts`, target validation, and persisted-record purge before old type deletion. |
| Desktop bearer IPC survives | Stage 5 removes the primary-only channel/handler/preload/bridge/tests while retaining only the WSL token in discriminated bootstrap topology. |
| Secret-store relocation under-enumerated | Stage 5 lists server/settings/Copilot/assets plus tests and requires zero `auth/ServerSecretStore`/`auth/utils` hits before deleting the directory. |
| Server dependency keys not renamed | Stage 6 explicitly renames server's contracts/shared/web keys and asserts Tailscale is gone while keeping package/bin `t3`. |
| Arbitrary configured/persisted endpoints | Stages 2/5 reject non-loopback Vite targets, purge legacy targets, and allow non-loopback only for proven desktop WSL topology with bearer. |
| Clerk CSP residue | Stage 4 removes Clerk/Cloudflare fields/origins/frame allowance and replaces remote scheme allowances with actual local/WSL origins. |
| Relay lint/docs residue | Stage 3 names the oxlint baseline, relay observability doc, and Macroscope exception; every stage enumerates related docs. |
| Marketing ambiguity | Final decision applied: app, Vercel file/dependency, root scripts/filters, smoke entry, and lock importer leave in Stage 1. |
| WSL decision gate | Removed: WSL is kept on `0.0.0.0` with the exact minimal bearer/WS-ticket primitives specified in Stage 5. |
| Old-scope zero-hit wording | Stage 6 excludes this historical plan explicitly and separately records the user-owned untracked `demo.md` hit. |
