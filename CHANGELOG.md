## 3.5.9 - 2026-07-30 (Patch)

Release impact: Patch because this corrects an error message and repairs npm publishing, with no contract, schema or storage changes.

- Starting a turn in a project whose folder has been moved or deleted now says so and names the folder, instead of reporting a provider spawn failure. Spawning into a missing directory fails the same way a missing CLI does, so the old message sent you to reinstall an agent that was never the problem.
- Releases reach npm again. Publishing the GitHub release from the release workflow never triggered the npm publish, because GitHub does not start a workflow from an event raised with its own token, so 3.5.4 through 3.5.8 were tagged and released while npm stayed on 3.5.3. The release now dispatches the publish explicitly, and the publish builds from the released tag rather than whatever the default branch has moved on to.

## 3.5.8 - 2026-07-30 (Patch)

Release impact: Patch because both fixes correct behaviour within existing contracts, with no schema, event or storage changes.

- OpenCode no longer fails the first turn on a slower machine with "Timed out waiting for OpenCode server start". Starting the OpenCode server is a cold process start, and it was allowed 5 seconds, the shortest budget of any provider step and the only one covering a spawn rather than a query to something already running. It now gets 15 seconds, and `NEOKOD_OPENCODE_SERVER_TIMEOUT_MS` raises it further on hosts that need longer. The message now names both that variable and the option of running `opencode serve` yourself and setting the server URL in settings.
- OpenCode failures now carry their reason when they appear as the cause of another error. They previously printed as a bare `OpenCodeRuntimeError:` with no text, so a stack trace showed the failure without saying what it was.

## 3.5.7 - 2026-07-30 (Patch)

Release impact: Patch because this makes the existing OpenCode model picker respect configured provider filters without changing public contracts.

- OpenCode provider `whitelist` and `blacklist` settings now filter Neokod's model picker just as they filter `opencode models`. Successful non-empty provider refreshes also replace removed models instead of retaining them from the previous cache.

## 3.5.6 - 2026-07-30 (Patch)

Release impact: Patch because this corrects existing navigation, model-label, and theme behavior without changing public contracts.

- Restored Home and Mission Control for completed work. Settled turns are intentionally cleared from the active-turn projection, so both surfaces now use the surviving user-activity timestamp and Mission Control stays mounted across every sidebar route.
- Restored subtle hover and selection colors by mapping the shared accent token to the existing surface-hover palette instead of the brand action color.
- Showed provider model display names in thread surfaces instead of raw slugs, and described browser-origin connections accurately in Settings.

## 3.5.5 - 2026-07-30 (Patch)

Release impact: Patch because these fixes correct behaviour within existing contracts, with no schema, event or storage changes.

- A thread could stay stuck as running with a Stop button that did nothing. The session held on to a turn that had already finished, so there was no live turn left for Stop to act on. Startup now releases a session whose active turn has already ended. A thread that recovered no longer keeps showing an error banner from an earlier failure.
- New threads no longer start on the branch and worktree of whichever thread you happened to be viewing. Opening a thread that ran on a feature branch and then starting a new one silently pinned the new thread to that branch, with nothing on screen saying so. Settings carried over from a draft you are still composing are unaffected.

## 3.5.4 - 2026-07-30 (Patch)

Release impact: Patch because this restores the documented self-hosted web connection without changing server or provider contracts.

- Fixed `neokod serve` behind a same-origin reverse proxy. The web client rejected every non-loopback browser origin before opening its WebSocket, so the shell loaded at a public hostname but settings changes and provider activation never reached the server. Explicit configured remote endpoints and desktop transport checks remain rejected as before.

## 3.5.3 - 2026-07-28 (Patch)

Release impact: Patch because this corrects a Claude context-meter reading with no contract or storage changes.

- The context meter no longer climbs back to its pre-compaction level after a `/compact`. Claude reports tokens processed across the whole session, which only tracks the live context while nothing has been discarded from it, so the meter dropped correctly at the compaction and then the next progress update pushed it straight back up. It typically showed as the meter going red, correcting to grey, then returning to red minutes later with no new context. The meter now measures growth from the compaction point, so it reflects what is actually in the context window.

## 3.5.2 - 2026-07-27 (Patch)

Release impact: Patch because this settles provider turns left running after a restart without changing public contracts.

- A turn could stay stuck as running forever after a restart, with nothing able to settle it. Provider lifecycle events arrive on a live stream that is never replayed, so if a provider exited while the server was down, the event that settles the turn never arrived. Startup now makes one reconciliation pass and settles such a turn as interrupted, keeping the provider's error message only when it belongs to that exact turn. A turn whose provider is still running is left alone.

## 3.5.1 - 2026-07-27 (Patch)

Release impact: Patch because this makes deletion cleanup idempotent and bulk-delete reporting accurate, with no contract changes.

- Deleting several threads at once no longer stops at the first one whose worktree is already gone. The rest are now processed, and the result names how many succeeded plus each thread that failed and why. Previously the loop aborted on the first failure, after that thread had already been deleted, so it was unclear what had actually happened.
- Removing a worktree that is already gone now succeeds instead of erroring, since the intended end state already holds. A genuine failure, such as a locked worktree, still fails, and the reported detail now includes Git's own message rather than a bare "git worktree remove failed".

## 3.5.0 - 2026-07-26 (Minor)

Release impact: Minor because this adds a backward-compatible projected shell field and sidebar state.

- Added a quiet sidebar badge showing how many sub-agent workers are currently running for each thread.

## 3.4.1 - 2026-07-26 (Patch)

Release impact: Patch because this surfaces failures that were previously silent and clears stale request state, with no contract changes.

- Stopping a turn no longer looks successful when the provider refuses the interrupt. The failure was written to the server log and nowhere else, so the button appeared to work while the turn kept running. It now appears in the thread as a failed-interrupt activity.
- Cleared pending OpenCode approvals and questions when a session errors. They were only ever cleared by a reply, so an approval could sit in the UI forever with nothing able to resolve it, and a later reply would be sent into a dead session.

## 3.4.0 - 2026-07-26 (Minor)

Release impact: Minor because this adds an opt-in runtime mode and a new provider contract value, leaving the default mode and every existing mode's behavior unchanged.

- Added the opt-in Auto runtime mode. Codex routes its approvals to the AI reviewer. Copilot, Cursor, Grok and OpenCode have no AI-review concept, so Auto keeps their existing user-approval behavior.
- Auto is not offered for Claude yet. Upstream #4495 has Claude turns failing immediately under the matching permission mode, so the option is hidden while Claude is selected, and a thread already set to Auto prompts for approval instead of running with full access.
- Codex thread starts now always state the approvals reviewer. Leaving it unset carried over the thread's previous reviewer, which left AI review active on resume after switching away from Auto.
- Added forward-compatible decoding for persisted runtime modes. A mode this build does not recognize decodes to `approval-required` (least privilege), never `full-access`, across the contracts layer and the persisted thread and session projections. This keeps a build from failing at startup on a value written by a newer one, and keeps a future Codex mode from reaching the adapter as full access.
- Applied the same least-privilege fallback to the composer's saved per-thread mode overrides. An unrecognized override used to fall through to the thread's own mode, which can be more permissive than the one that was picked.
- Rolling back below 3.4.0 after using Auto is unsupported. 3.3.0 decodes persisted runtime modes strictly and can still fail at startup.
- The fallback is applied once and kept. If a build projects a thread whose mode it does not recognize, that thread stays on `approval-required` after upgrading again, because replay resumes from the stored cursor instead of re-reading the original event. Re-select the mode on the thread to restore it.

## 3.3.0 - 2026-07-26 (Minor)

Release impact: Minor because this adds Claude model discovery and a new model, and widens the provider usage contract in a backward-compatible way (integer quota counts still decode), with no breaking changes.

- Added Claude Opus 5, with reasoning effort, fast mode, and a context window that defaults to 1M. It appears once Claude Code v2.1.219 or newer is installed, and the bare `opus` alias now resolves to it.
- Claude now reads its model list from the CLI itself rather than a hardcoded catalog, so newly released models appear without waiting for a Neokod update. The built-in list remains the fallback for older Claude Code builds and before the first successful probe.
- Recognized Amazon Bedrock as a valid Claude sign-in. Bedrock-backed Claude previously showed as unauthenticated, and the capability probe timed out before Bedrock finished starting, which left the provider unselectable in the model picker.
- Fixed Copilot usage disappearing when an allowance was reported as a fraction. Premium interactions are billed with multipliers, so a fractional count is normal, and rejecting it discarded the whole usage panel rather than just that value.
- Raised muted text contrast in both themes to meet WCAG AA. Timestamps, metadata, and other secondary labels were below the readable-contrast floor on both the light and dark canvases.
- Showed fast mode as a lightning bolt in the traits control rather than spelling out "Fast" or "Normal", freeing space in a control that already truncates. Fast mode on its own still reads as text, since a bare bolt would be ambiguous.

## 3.2.2 - 2026-07-25 (Patch)

Release impact: Patch because this is a rendering optimization plus documentation accuracy fixes, with no contract changes.

- Stopped the thread run banner from querying git status for threads whose banner is hidden. The banner's run summary is resolved first, and the changed-files query only runs when the banner is actually shown.
- Fixed documentation references: the architecture overview's WebSocket-contract citation pointed at the wrong source file, and the Effect function checklist's links resolved relative to its own directory instead of the repository root.
- Narrowed the upstream-sync exclusion in `AGENTS.md` to hosted and remote server management, so local `neokod serve` ports are no longer wrongly excluded.

## 3.2.1 - 2026-07-24 (Patch)

Release impact: Patch because this refreshes the vendored Codex app-server protocol bindings and adds a backward-compatible runtime compatibility warning, with no provider contract changes.

- Regenerated the Codex app-server protocol bindings against the `rust-v0.145.0` release, pinned to the release commit rather than a mid-cycle commit. This picks up methods added since the previous pin: workspace messages, usage-limit reset-credit consumption, thread environment connect/disconnect, the `writes` approval mode, and fork-through-turn.
- Warned when the runtime Codex CLI is older than the supported protocol target (read from the app-server handshake), without blocking the provider.

## 3.2.0 - 2026-07-24 (Minor)

Release impact: Minor because this adds UI observability and surfaces, reusing existing `task.*` runtime events and provider error payloads, with no storage or contract breaking changes.

- Added per-agent observability to the Subagents cards: live elapsed time, current activity, token/AIU usage when the provider reports it, and result summaries. Copilot worker usage is attributed through the existing `task.*` activity path, and terminal cards no longer show a stale live activity.
- Added a plan progress indicator to the thread run banner: a completed/total fraction and a thin progress bar, so a plan with untouched steps no longer reads as stuck.
- Surfaced provider error messages in the transcript instead of a blank "No input or output provided" row. GitHub Copilot monthly-quota errors now show a clear message directing you to another provider until the quota resets.
- Stopped the model, branch, and new-thread pickers from fading and clipping their first and last rows: the scroll-edge mask was removed from those picker lists (shared scroll surfaces keep it), and the existing scrollbar indicates overflow.

## 3.1.0 - 2026-07-23 (Minor)

Release impact: Minor because this adds an optional `usage` field to the provider snapshot contract (backward compatible; older clients omit and ignore it) plus new server read behavior, with no breaking changes.

- Surfaced GitHub Copilot usage and quota on the provider snapshot. The Copilot provider probe now reads account quota from the SDK's `account.getQuota` RPC during its existing five-minute status refresh and attaches per-bucket usage windows (premium interactions, chat, completions) with used, entitlement, remaining percentage, overage, and reset date. Quota is fetched only for authenticated users, is bounded by the same probe timeout as the model lookup, and any failure or malformed value leaves provider health unchanged with usage simply absent.

## 3.0.27 - 2026-07-19 (Patch)

Release impact: Patch because this removes a duplicate control without changing behavior or contracts.

- Removed the redundant Stop button from the thread run banner. The composer's Stop control (the send button while a turn is running) is now the single place to stop a run; the run banner keeps showing the working status and elapsed time.

## 3.0.26 - 2026-07-19 (Patch)

Release impact: Patch because this fixes responsive layout without changing UI behavior or contracts.

- Reserved flex space for composer controls, changed-files header actions, and sidebar pin actions so narrow panes do not overlap or clip text and controls.

## 3.0.25 - 2026-07-19 (Patch)

Release impact: Patch because this changes only how an interrupted turn settles, with no storage or contract changes.

- Fixed the Stop button appearing to do nothing while background workers were still running. Stop now settles the turn to interrupted the moment you press it and hands control back, instead of waiting for a final result that the running workers hold back, and it tells the runtime to abort the work. Settling no longer issues a usage query that could itself hang on a stalled stream. The session stays open so your next message continues normally, system and telemetry events keep flowing, and late output from the stopped turn is drained quietly so it cannot reopen the turn as Working. A stopped turn's final usage is still counted.

## 3.0.24 - 2026-07-19 (Patch)

Release impact: Patch because this restyles existing surfaces without changing storage or server contracts.

- Neutralized the theme surfaces to true grey in both light and dark, replacing the blue-biased greys, and gave My Work rows two lines so the project name sits under the thread title instead of being cut off.
- Rendered the Subagents panel's tool rows in the same verb-first style as the main transcript: a tool icon with a cleaned label, dropping the redundant tool-name subtext line.

## 3.0.23 - 2026-07-19 (Patch)

Release impact: Patch because this fixes provider environment import and background-task log noise without changing storage or server contracts.

- Imported the user's shell-exported provider keys (CODEX_LB_API_KEY, CODEX_LB_BASE_URL, OPENAI_API_KEY, OPENAI_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL) into the spawned provider process, so a Codex proxy configured in the shell is picked up without also adding it to each provider in Settings.
- Stopped the work log from filling with red unknown-system-message rows for background-task updates. Task lifecycle changes now settle the matching worker or update its progress only when there is text to show, and empty backgrounding or timing updates are no longer surfaced as warnings.

## 3.0.22 - 2026-07-19 (Minor)

Release impact: Minor because this adds UI surfaces and restyles the app without changing storage or server contracts.

- Retuned the default theme to a Codex-style palette and system fonts, light and dark: white/#181818 canvases, #339cff accent, the Codex diff and skill colors, and cool-biased neutrals, replacing the previous warm greys and the bundled DM Sans.
- Rendered agent tool calls as readable verb-first rows — a tool icon, a verb, and the file or command target ("Ran git diff", "Read spec.py", "Edited src/spec.py") with running/done/failed status and the raw command still available on expand, and the current tool now shows in the run banner. Commands read the real command from the tool input, and the running indicator shows for active tools.
- Added a My Work cross-project inbox above the project tree: Active, Needs you, and Recent threads from every project, with collapse, per-item dismiss (off your radar, not deleted), a per-group clear, and undo. A dismissed thread reappears when it finishes, needs input, or starts new work.

## 3.0.21 - 2026-07-19 (Patch)

Release impact: Patch because this changes only how the macOS build is signed and distributed, not the application or its update contracts.

- Signed and notarized the macOS build with a Developer ID certificate under the hardened runtime. Auto-update (Squirrel.Mac) and Gatekeeper reject the previous ad-hoc signature, so installing a downloaded update silently kept the old version; signed builds now install and relaunch on the new version.

## 3.0.20 - 2026-07-19 (Patch)

Release impact: Patch because this fixes the packaged Copilot runtime launch without changing contracts.

- The packaged app now spawns the bundled native Copilot runtime directly instead of letting the SDK re-enter the Neokod server binary as its node executable.

## 3.0.19 - 2026-07-18 (Minor)

Release impact: Minor because this adds backward-compatible UI surfaces and navigation behavior without changing storage or server contracts.

- Made the project tree the default sidebar view with persistent New thread, Search, Home, and Mission Control actions; existing installs migrate off the old flat-threads default once, and explicit choices persist afterwards.
- Replaced the empty no-thread pane with a Home dashboard grouping Running, Needs attention, Plan ready, and Recent threads.
- Added a thread run banner below the chat header with the goal, plan step progress, elapsed time, status, Open plan, and Stop, collapsing to a compact summary when the run completes.
- Combined model and reasoning-effort selection into one visible composer control with a live summary label.
- Added a unified Environment right-panel with branch and base, change stats, ahead/behind, and contextual commit, push, pull-request, and compare actions over the existing VCS state.

## 3.0.18 - 2026-07-18 (Patch)

Release impact: Patch because this clarifies an incompatible Copilot runtime and exposes the existing provider failure without changing any contracts.

- Explain that a custom runtime must support the Copilot SDK's headless stdio flags and direct users to the bundled runtime when it does not.
- Show a Copilot driver creation error after GitHub sign-in instead of stale disabled status.
- Gave slow-starting source-control CLIs a real discovery probe budget: Azure DevOps probes now allow 20s, so an installed `az` no longer reads as missing.

## 3.0.17 - 2026-07-18 (Patch)

Release impact: Patch because these are backward-compatible fixes ported from upstream T3 Code.

- Skipped undecodable provider runtime rows when listing sessions.
- Fixed an image-upload stack overflow in command dispatch.
- Improved Git diagnostics outside repositories and made selected commit paths literal.
- Threaded the working directory through the Claude capability probe and isolated Claude instances via CLAUDE_CONFIG_DIR instead of HOME.
- Shared MCP OAuth locks across Codex shadow homes and fixed dropped events during the initial thread snapshot.

## 3.0.16 - 2026-07-18 (Patch)

Release impact: Patch because this refines source-control discovery presentation and probing without changing public contracts.

- Split the Source Control settings empty state: a waiting-for-environment notice now appears when no environment is connected, and "Nothing detected yet" only when a scan genuinely returned zero items.
- Extended Azure DevOps discovery to verify the azure-devops CLI extension; a missing extension reports an unverified state with the install command, and unrelated az failures no longer downgrade an authenticated user.

## 3.0.15 - 2026-07-18 (Patch)

Release impact: Patch because this only changes user-visible branding text and badge visibility; no stored data or cross-version contracts are affected.

- Replaced the sidebar's old T3 glyph wordmark with a styled "Neokod" text wordmark.
- Stable packaged builds no longer show a stage badge and display the bare name "Neokod" instead of "Neokod (Alpha)"; Dev and Nightly badges are unchanged.
- Updated the static web page title and the desktop launcher's fallback title to match.
- Made `stageLabel` nullable on the desktop branding contract (`DesktopAppBranding`/`DesktopAppStageLabel`) so stable builds can represent "no stage" instead of a placeholder value.

## 3.0.14 - 2026-07-18 (Patch)

Release impact: Patch because providers now require explicit enablement before probing or configuration, without changing provider contracts.

- Defaulted Codex, Claude, and Copilot provider drivers off alongside the existing opt-in providers.
- Clarified disabled provider cards and restored the provider update-check preference with other settings defaults.

## 3.0.13 - 2026-07-18 (Patch)

Release impact: Patch because desktop updates now consistently use the supported stable feed without changing application APIs.

- Removed the selectable nightly update track and migrates legacy persisted nightly settings to stable on load.
- Forced updater checks to the latest stable feed with prerelease and downgrade installs disabled.
- Added sanitized update-feed failures that identify the feed and HTTP status without exposing credentials.

## 3.0.12 - 2026-07-18 (Patch)

Release impact: Patch because this recovers safely from obsolete or unreadable local connection-catalog data without changing public contracts.

- Fixed packaged desktop startup when a legacy encrypted connection catalog cannot be decrypted. Both the desktop catalog store and web storage layer now fail open to the canonical empty catalog, allowing the local primary environment and its providers to register.

## 3.0.11 - 2026-07-18 (Patch)

Release impact: Patch because this fixes packaged desktop startup without changing any contracts.

- Fixed the packaged desktop app rendering a black screen. The `neokod`/`neokod-dev` schemes were never registered as privileged (standard, secure, fetch, CORS, streaming), so the renderer origin was opaque and the CSP's `'self'` directives blocked every script and stylesheet. Upstream inherited this registration as a side effect of `@clerk/electron`, which the local-first carve-out removed; the desktop now registers its own scheme privileges at main-process module load, before Electron's ready event.

## 3.0.10 - 2026-07-15 (Patch)

Release impact: Patch because these are backward-compatible fixes ported from upstream T3 Code.

- Switched missing project favicons to a client-side fallback: the server marks the missing-favicon asset with a dedicated filename instead of serving a placeholder SVG, and the client renders the folder icon when it sees that marker.
- Fixed the truncated chat error alert layout.
- Labeled the Max and Ultra reasoning efforts in the Codex provider.

## 3.0.9 - 2026-07-14 (Patch)

Release impact: Patch because this changes only how the release pipeline is triggered and versioned, not the published application or its update contracts.

- Made every push to `main` publish a normal release at the top `CHANGELOG.md` version, skipping when that version already has a release. Removed the per-commit nightly build and the version-tag trigger; nightly prereleases are now on-demand only via a manual dispatch with `channel=nightly`.

## 3.0.8 - 2026-07-14 (Patch)

Release impact: Patch because this changes only when the release pipeline runs, not the published application or its update contracts.

- Changed nightly releases to build on every push to `main` (including merged pull requests) instead of a daily schedule, so a release reflects the current committed state. Stable releases still come from `vX.Y.Z` tag pushes.

## 3.0.7 - 2026-07-14 (Patch)

Release impact: Patch because this changes only the release pipeline's internal artifact handling, not the published application or its update contracts.

- Reworked the nightly and stable release workflow to publish desktop binaries straight to the GitHub Release instead of staging ~2 GB of GitHub Actions artifacts per run, which had exhausted the Actions storage quota. Builds now upload to a draft release, and a finalize step merges the macOS arm64 and x64 auto-updater manifests (for both the latest and nightly channels) before publishing. Slowed the nightly schedule to once daily and capped the remaining small cross-job prebuild artifact at one day.

## 3.0.6 - 2026-07-14 (Patch)

Release impact: Patch because this adds test infrastructure without changing runtime contracts.

- Added the M2 stage 2 codec-first MSW WebSocket browser harness: an in-browser mock that decodes/encodes every frame through the real WsRpcGroup RPC codec (unknown or malformed client traffic fails the test), a controllable in-memory environment server with fixtures, a leak-asserting reset/teardown (zero open WebSocket clients and zero RPC subscriptions), and a first real-runtime browser test that drives RpcSessionFactory end to end. Exposed the RPC session layer for the harness.

## 3.0.5 - 2026-07-14 (Patch)

Release impact: Patch because this adds test-only coverage without changing runtime contracts.

- Added RPC/socket codec contract tests (M2 stage 1) pinning the WsRpcGroup wire protocol: per-direction request/response schemas, exact request envelopes with headers and trace fields, Ping/Pong liveness, forward-compatible handling of unknown envelopes, and malformed-frame rejection.

## 3.0.4 - 2026-07-14 (Patch)

Release impact: Patch because this adds a deterministic asset-maintenance script without changing runtime contracts.

- Added the scripted Neokod regeneration path for all development and nightly blueprint PNG and ICO assets.

## 3.0.3 - 2026-07-13 (Patch)

Release impact: Patch because this restores reliable server regression coverage without changing public contracts.

- Corrected renamed Bitbucket and GitHub pull-request fixtures so their derived repository identities match their configured remotes.
- Ensured provider-instance settings watching subscribes before the hydration layer accepts updates, so a changed Codex binary path always triggers a fresh probe.

## 3.0.2 - 2026-07-13 (Patch)

Release impact: Patch because this corrects Stage 4 desktop identity and CORS regression coverage without changing public contracts.

- Fixed the desktop launcher identity test to load under an explicit development environment and assert the Neokod development protocol.
- Added CORS coverage for Neokod desktop renderer origins and rejection of legacy T3 origins during credentialed development requests.
- Finalized desktop metadata around the existing Neokod application identity, renderer protocols, staged publisher data, WSL prebuild marker, and Neokod-named production icon assets.

## 3.0.1 - 2026-07-13 (Patch)

Release impact: Patch because this corrects environment precedence and reserved script variables without changing public contracts.

- Fixed OTLP bootstrap precedence and legacy compatibility coverage across server, desktop, build, launcher, and dev-runner boundaries.
- Preserved identical reserved Neokod and legacy project-script environment values when scripts add custom variables.
- Completed the internal Neokod service-key migration and removed obsolete pairing-token startup coverage.
- Restored legacy VCS and browser-state reads while retaining Neokod as the write target.
- Corrected T3 Code provenance and neutralized non-upstream test identities.

## 3.0.0 - 2026-07-13 (Major)

Release impact: Major because the home/state and environment contracts now use Neokod names, with one-release legacy reads for existing installs and scripts.

- Added `NEOKOD_*` environment variables with `T3CODE_*` read fallback through 3.0.0; new names take precedence.
- Migrated the default state root from `~/.t3` to `~/.neokod` by atomic rename when only the legacy directory exists, falling back safely for that launch if migration fails.
- Hardened bootstrap, desktop, dev-runner, launcher, and terminal compatibility so new env names win, legacy names fall back safely, and legacy values do not leak into child or WSL processes.
- Moved project VCS configuration to `.neokod/vcs.json` with legacy `.t3code/vcs.json` read fallback.
- Project setup scripts now emit both `NEOKOD_PROJECT_ROOT`/`NEOKOD_WORKTREE_PATH` and legacy names for the transition.
- Renamed the published package and executable from `t3` to `neokod`; use `npx neokod@latest` or `neokod serve`. The `t3` package and bin have no compatibility alias.
- Renamed active product copy, local descriptor/checkpoint/MCP identities, browser persistence keys, preview CSS variables, and lint plugin namespace to Neokod.
- Added one-release browser storage migration from `t3code:`/`t3code.` keys; retained only the documented upstream, legacy, legal, and Grok OAuth exceptions.

## 2.1.0 - 2026-07-13 (Minor)

Release impact: Minor because the cumulative redesign adds backward-compatible sidebar tabs and local pinned-thread preferences.

- Added a static semantic light/dark token foundation for surfaces, text, lines, focus, brand, and state aliases.
- Bridged the semantic palette through existing Tailwind and shadcn variables, including sidebar roles, without changing theme ownership.
- Added the fixed UI, metadata, chat, compact-row, and surface-header scale for later visual passes.
- Added persisted Threads/Workspace sidebar selection and scoped local pinned-thread preferences.
- Added the atom-backed flat Threads view with live-only Pinned rows, shared thread actions, and keyboard-visible ordering.
- Restyled the persisted right-panel surfaces with one compact token-based tab, header, divider, and panel-toolbar chrome.
- Applied the fixed shell typography and density scale to sidebar rows, workspace headers, status rails, and branch/panel controls.
- Applied the token-based conversation type scale, compact transcript/composer spacing, neutral control surfaces, and restrained non-semantic color usage.

## 2.0.0 - 2026-07-13 (Major)

Release impact: Major because this removes product surfaces, remote connection transports, and their package, build, and release contracts.

- Removed the React Native mobile app and the marketing site as part of the local-first carve-out.
- Removed SSH backend connections, Tailscale integration, LAN/manual endpoint advertising, and public server host selection.
- Constrained the desktop primary, standalone server, and development web server to `127.0.0.1`.
- Cut native desktop and the legacy standalone `t3 serve` command over to direct unauthenticated loopback HTTP and WebSocket transport, removing browser cookies, pairing, sessions, scopes, DPoP, and auth administration.
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

Release impact: Patch because this replaces inherited upstream T3 production artwork with Neokod branding without changing runtime contracts.

- Replaced the production macOS, Windows, Linux, iOS, web favicon, and logo assets with the Neokod prism mark.

## 1.0.1 - 2026-07-12 (Patch)

Release impact: Patch because this fixes the hosted release publish job without changing the app or updater contract.

- Installed workspace dependencies in the publish job before merging macOS updater manifests.

## 1.0.0 - 2026-07-12 (Major)

Release impact: Major because Neokod now has an independent application identity, storage root, update feed, and release pipeline that are intentionally incompatible with upstream T3 Code installs.

- Renamed the desktop and web product to Neokod with the `com.kamo62.neokod` application ID, `neokod` URL schemes, and isolated Neokod storage paths.
- Replaced the upstream unified release workflow with a private GitHub-hosted macOS and Windows pipeline while retaining stable and nightly version/tag behavior.
- Removed Blacksmith, former upstream T3 Connect relay deployment, Clerk/Cloudflare release configuration, npm publishing, Vercel deployment, Discord announcement, and inactive mobile workflow requirements.
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
- Hid visible former upstream T3 Cloud / T3 Connect surfaces behind a default-off OMApp cloud flag.
- Renamed visible product copy, titles, menus, and release language toward OMApp while keeping internal package names and storage keys unchanged.
- Updated the upstream rebase script to support explicit targets, repo-local `vp` checks, and no automatic pushes.
- Fixed Claude Task plan updates so deleting the final task emits an empty plan and clears the sidebar.
- Fixed Codex child-thread item completions so the Subagents panel receives durable worker progress rows instead of showing empty running cards.
- Added regression coverage for Codex child-thread progress mapping and Claude Task plan clearing.
