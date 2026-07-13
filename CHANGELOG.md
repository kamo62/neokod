## 2.0.0 - 2026-07-13 (Major)

Release impact: Major because this removes product surfaces, remote connection transports, and their package, build, and release contracts.

- Removed the React Native mobile app and the marketing site as part of the local-first carve-out.
- Removed SSH backend connections, Tailscale integration, LAN/manual endpoint advertising, and public server host selection.
- Constrained the desktop primary, standalone server, and development web server to `127.0.0.1`.
- Cut native desktop and standalone `t3 serve` over to direct unauthenticated loopback HTTP and WebSocket transport, removing browser cookies, pairing, sessions, scopes, DPoP, and auth administration.
- Retained a narrow fail-closed desktop-managed WSL exception: its internal wildcard bind requires the private `wsl-bearer` discriminator, direct bearer validation on sensitive HTTP, and a short-lived single-use WebSocket ticket.
- Purged retired remote targets, profiles, credentials, DPoP tokens, and saved-environment secrets into the empty schema-v2 connection catalog.
- Removed the hosted Cloudflare/Postgres/APNs relay infrastructure and the server's outbound mobile-activity publisher while retaining local browser notifications.
- Removed relay-only workspace, release-smoke, Alchemy reference-sync, and `@effect/sql-pg` configuration.
- Removed the hosted application, pairing UI, identity-provider integration, remote connection client/contracts, and their desktop preload, CSP, build, CI, configuration, and documentation surfaces.
- Relocated the reusable server secret store and asset-token cryptography outside the deleted auth control plane.
- Made the normal local shell, both toast providers, activity and slow-RPC coordinators, tracing, event routing, and provider-update notifications unconditional.
- Restored the browser crypto service required to generate local project and thread command IDs after the remote client removal.
- Renamed the surviving workspace packages into the `@neokod/*` namespace while retaining the public `t3` server package and CLI name.

## 1.1.0 - 2026-07-12 (Minor)

Release impact: Minor because this adds selectable Neokod icon variants and packages the assets without breaking existing settings or release contracts.

- Added Aurora, Prism, and Signal icon variants to desktop resources and web previews.
- Added a persisted desktop app-icon preference with Prism as the legacy/default choice.
- Applied the selected mark to the macOS Dock and live Linux/Windows app windows.
- Replaced the production macOS, Windows, Linux, iOS, web favicon, and logo assets with the Neokod prism mark.

## 1.0.2 - 2026-07-12 (Patch)

Release impact: Patch because this replaces inherited T3 production artwork with Neokod branding without changing runtime contracts.

- Replaced the production macOS, Windows, Linux, iOS, web favicon, and logo assets with the Neokod prism mark.

## 1.0.1 - 2026-07-12 (Patch)

Release impact: Patch because this fixes the hosted release publish job without changing the app or updater contract.

- Installed workspace dependencies in the publish job before merging macOS updater manifests.

## 1.0.0 - 2026-07-12 (Major)

Release impact: Major because Neokod now has an independent application identity, storage root, update feed, and release pipeline that are intentionally incompatible with upstream T3 Code installs.

- Renamed the desktop and web product to Neokod with the `com.kamo62.neokod` application ID, `neokod` URL schemes, and isolated Neokod storage paths.
- Replaced the upstream unified release workflow with a private GitHub-hosted macOS and Windows pipeline while retaining stable and nightly version/tag behavior.
- Removed Blacksmith, T3 Connect relay deployment, Clerk/Cloudflare release configuration, npm publishing, Vercel deployment, Discord announcement, and inactive mobile workflow requirements.
- Kept the release-aware upstream rebase helper usable from the new repository's `main` branch.
- Added narrow Effect diagnostic annotations for the inherited Copilot device-flow boundary so Linux-hosted release typechecks match its tested runtime behavior.
- Fixed the Windows release dependency so its Linux WSL helper runs after manual dispatches.
- Stabilized the real-process ProviderRegistry reprobe test by yielding to Node's event loop while waiting for missing-command failures on hosted Linux runners.
- Added release documentation and regression coverage for Neokod product, protocol, updater, and nightly metadata.

## 0.0.31 - 2026-07-11 (Minor)

Release impact: Minor because it adds in-app GitHub sign-in, a Mission Control overview, and a governance chip alongside demo hardening; additive contracts only.

- Added in-app GitHub device login for Copilot: a "Sign in with GitHub" dialog on the provider card (RFC 8628 code flow, live status, entitlement verification via provider refresh, sign-out), token stored server-side in the secret store and never sent to the client.
- Added Mission Control (`/mission` and command palette): a cross-project overview of agent work with running-first ordering, goals, branches, and live worker counts.
- Added a read-only governance chip to the thread workspace rail showing AI-Orch evidence recording and MCP gateway configuration.
- Kept completed subagents with progress or summaries visible until locally hidden (persisted per environment and thread), and labeled local hide controls honestly.
- Added a workspace empty state for the Files panel and improved Copilot fleet streaming and unsupported-SDK guidance.

## 0.0.30 - 2026-07-07 (Major)

Release impact: Major because native mobile is removed from active product paths and cloud surfaces are hidden by default.

- Removed native mobile from active workspace/build paths for the OMApp fork.
- Hid visible T3 Cloud / T3 Connect surfaces behind a default-off OMApp cloud flag.
- Renamed visible product copy, titles, menus, and release language toward OMApp while keeping internal package names and storage keys unchanged.
- Updated the upstream rebase script to support explicit targets, repo-local `vp` checks, and no automatic pushes.
- Fixed Claude Task plan updates so deleting the final task emits an empty plan and clears the sidebar.
- Fixed Codex child-thread item completions so the Subagents panel receives durable worker progress rows instead of showing empty running cards.
- Added regression coverage for Codex child-thread progress mapping and Claude Task plan clearing.
