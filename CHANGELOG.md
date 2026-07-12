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
