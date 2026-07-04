# FORK.md

Conflict map for this fork (branch `org/copilot-claude`) against upstream
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). Read this before
resolving a rebase conflict — every upstream file this fork touches is
listed below with the exact nature of the edit and why it exists, so you
can tell "upstream moved this line" apart from "the fork's edit needs to be
reapplied."

`scripts/rebase-upstream.sh` cross-references conflicting files against this
table automatically. Keep it in sync whenever a fork change touches a new
upstream file — a stale manifest is worse than no manifest.

## How to read this

- **Fork-owned** — new files/directories upstream doesn't know about. These
  never conflict on rebase (upstream can't move lines in a file it doesn't
  have); they're listed for completeness, not as a conflict risk.
- **Upstream files touched** — existing upstream files with fork edits.
  Each row states the edit's shape (mechanical/one-line vs. a larger block)
  so a conflict resolution can distinguish "reapply this exact block" from
  "re-verify this whole file still makes sense."

## Fork-owned (new files, zero conflict risk)

All GitHub Copilot driver internals live in one directory:

| Path                                                                      | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/copilot/CopilotDriver.ts`                       | `ProviderDriver` implementation. Owns the one `CopilotClient` per provider instance: constructs it, calls `client.start()`, registers `client.stop()` as a finalizer, wires the adapter/snapshot/textGeneration closures.                                                                                                                                                                                                                                                                                                                                                           |
| `apps/server/src/provider/copilot/CopilotAdapter.ts`                      | `ProviderAdapterShape` implementation. Per-thread `CopilotSession` lifecycle, hidden `customAgents`/active-agent/fleet-mode wiring, event mapping (`assistant.message[_delta]`, `assistant.reasoning[_delta]`, `tool.execution_start/complete`, `subagent.*`, `session.idle` → `turn.completed`), `onPermissionRequest`/`onUserInputRequest` bridged into the same `Deferred`-based approval flow Claude/Cursor use.                                                                                                                                                                |
| `apps/server/src/provider/copilot/CopilotProvider.ts`                     | Status probing (`client.getStatus()` / `client.getAuthStatus()`) and the built-in model catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/server/src/provider/copilot/CopilotMcpServers.ts`                   | Fork-owned Copilot MCP settings resolver. Converts hidden provider settings into SDK `mcpServers` config and injects the configured AI-Orch MCP gateway when `gatewayEnabled` is set (decoupled from the `enabled` recording flag). Also drops per-server `enabled: false` entries before building the SDK config.                                                                                                                                                                                                                                                                  |
| `apps/server/src/provider/copilot/ManagedClientEvidence.ts`               | Pure managed-client evidence mapper for the Copilot lane. Converts selected provider runtime/domain events into AI-Orch `/v1/managed-client/evidence` payloads, hashes transcript content, sanitizes repo remotes, and caps batches at the endpoint limit.                                                                                                                                                                                                                                                                                                                          |
| `apps/server/src/provider/copilot/ManagedClientEvidenceForwarder.ts`      | Runtime managed-client evidence forwarder. Reacts to hidden Copilot governance settings, subscribes to provider runtime and orchestration domain streams, batches mapped evidence with bounded sliding-queue semantics, and POSTs to AI-Orch with retry backoff.                                                                                                                                                                                                                                                                                                                    |
| `apps/server/src/provider/copilot/ManagedClientEvidenceTestConnection.ts` | One-shot governance connectivity check served by `server.testManagedClientEvidenceConnection`. Builds a synthetic `session_start`/`session_end` pair via `makeManagedClientEvidenceBatch`, POSTs it with the same request shape the forwarder uses, and returns a typed `{ ok, status, message }` result (never the credential) instead of retrying.                                                                                                                                                                                                                                |
| `apps/server/src/provider/copilot/CopilotTextGeneration.ts`               | Commit/PR/branch/title generation via short-lived Copilot sessions. No native structured-output flag in the SDK, so this follows the Grok/Cursor pattern: ask for JSON in the prompt, decode with `extractJsonObject` + `Schema.decodeEffect`.                                                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/provider/copilot/CopilotEnvironment.ts`                  | `baseDirectory` (`COPILOT_HOME`-equivalent) resolution + continuation-group-key helper. Mirrors `Drivers/ClaudeHome.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/server/src/provider/copilot/*.test.ts`                              | Unit tests for all of the above. Mock the SDK client (`createSession`/`resumeSession`/`getStatus`/`getAuthStatus`); never spawn the real CLI or hit the network.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/components/chat/ThreadWorkspaceRail.tsx`                    | Fork-owned compact "workspace rail" for the thread header. Icon-first, dense control row that surfaces at-a-glance thread state (active model, live terminal-running indicator, Copilot fleet chip when enabled) and quick actions (open terminal, open diff) by reusing existing stores/surfaces only — owns no terminal, panel, or picker. Exports a pure `resolveThreadWorkspaceRailView` (the "only real state, no dead slots" rule's runnable check). New file in a shared directory: zero file-level conflict risk; the ChatHeader import/mount is the only conflict surface. |
| `apps/web/src/components/chat/ThreadWorkspaceRail.test.ts`                | Unit checks for `resolveThreadWorkspaceRailView` (model label passthrough, terminal indicator gating, diff-requires-workspace, fleet chip only when enabled).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/src/components/SubagentsPanel.tsx`                              | Read-only right-panel surface (modeled on `PlanSidebar`) rendering sub-agent worker cards grouped from a thread's `activities` by `taskId`. Reachable via `/subagents` and the command palette. Uses the pure `deriveSubagentCards` helper added to `session-logic.ts`.                                                                                                                                                                                                                                                                                                             |
| `apps/web/src/session-logic.subagents.test.ts`                            | Unit checks for `deriveSubagentCards` (grouping `task.*` activities by `taskId`; status/summary/elapsed derivation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/web/src/components/chat/CopilotThreadControls.tsx`                  | Fork-owned compact rail popover toggling Copilot `fleetMode` and selecting `activeAgent` from existing `customAgents`. Reuses `useUpdateEnvironmentSettings` → `settings.providers` (the governance write precedent); no new RPC/contract. Renders only when Copilot is enabled. Exports pure `buildAgentOptions`.                                                                                                                                                                                                                                                                  |
| `apps/web/src/components/chat/CopilotThreadControls.test.ts`              | Unit checks for `buildAgentOptions` (default option + custom-agent mapping).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/components/chat/GoalChip.tsx`                               | Fork-owned compact thread-goal affordance near the title: shows/edits a goal string + active/done status, persisted via the existing `thread.meta.update` command. Exports pure `goalDraftToPatch`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/chat/GoalChip.test.ts`                           | Unit checks for `goalDraftToPatch` (trim; whitespace clears to null; status passthrough).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/workspaceRailUiStore.ts`                                    | Tiny thread-scoped Zustand store (mirroring `rightPanelStore`) carrying per-thread, per-popover "open" nonces so `/goal` and `/fleet` can ask `GoalChip` / `CopilotThreadControls` to open. No durable state. Exports pure `bumpOpenNonce`.                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/workspaceRailUiStore.test.ts`                               | Unit checks for `bumpOpenNonce` (nonce init/increment; per-thread/per-popover independence).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/components/chat/CopilotMcpControls.tsx`                     | Fork-owned `/mcp` rail popover listing Copilot MCP servers with per-server enable/disable `Switch`es (writes the `enabled` flag through `settings.providers`), plus read-only rows for the auto-injected `t3-code`/`ai-orch` servers. Opens on the `workspaceRailUiStore` "mcp" signal. Only rendered when the thread's active provider resolves to Copilot; on a non-Copilot thread `/mcp` shows an info toast pointing to that agent's own MCP config. Exports pure `isMcpServerEnabled`/`toggleCopilotMcpServerEnabled`/`describeMcpServer`/`threadUsesCopilot`.                 |
| `apps/web/src/components/chat/CopilotMcpControls.test.ts`                 | Unit checks for the MCP enable/toggle/describe helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/persistence/Migrations/033_ProjectionThreadsGoal.ts`     | Additive, idempotent migration adding nullable `goal` and `goal_status` (default `'active'`) columns to `projection_threads`. Guarded by `PRAGMA table_info` so re-runs are safe.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scripts/rebase-upstream.sh`                                              | This fork's rebase helper (see file for usage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `FORK.md`                                                                 | This file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Upstream files touched

| File                                                                       | Nature of edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/package.json`                                                 | One dependency line added: `"@github/copilot-sdk"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Pulls in the official Copilot SDK the driver wraps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm-lock.yaml`                                                           | Lockfile update from the dependency add: one new `@github/copilot-sdk` entry plus its actual transitive graph (the `@github/copilot` platform binaries, `vscode-jsonrpc`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Mechanical, but regenerate with `pnpm install --lockfile-only`, not a plain `pnpm install` — on this repo's pnpm/Node combination, a full install also re-resolves the `apps/mobile` peer graph and produces hundreds of lines of unrelated churn. After regenerating, confirm with `git diff pnpm-lock.yaml` that the change stays scoped to the Copilot SDK before committing.                                                                                                                                                                                                                                                     |
| `apps/server/src/provider/builtInDrivers.ts`                               | One import + one array entry (`CopilotDriver`) + one union member (`CopilotDriverEnv`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Registers the new driver the same way every built-in driver is registered — see the file's own docstring for the "1. implement, 2. add to array, 3. satisfy R" recipe this follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/contracts/src/settings.ts`                                       | (a) New `CopilotSettings` / `CopilotSettingsPatch` schema blocks, structured identically to the existing `ClaudeSettings` block. (b) One line each registering `githubCopilot` in `ServerSettings.providers` and `ServerSettingsPatch.providers`. (c) Two one-word default flips: `GrokSettings.enabled` and `OpenCodeSettings.enabled` decoding default changed from `true` to `false`. (d) Hidden `CopilotSettings.mcpServers`, `customAgents`, `defaultAgent`, `activeAgent`, `fleetMode`, and `managedClientEvidence` schemas mirroring the Copilot SDK session config/RPC features plus AI-Orch evidence settings, plus an optional per-server `enabled` flag on `CopilotMcpServers` for the `/mcp` enable/disable UI (never forwarded to the SDK), and a `gatewayEnabled` flag on `CopilotManagedClientEvidenceSettings` decoupling active gateway routing from passive evidence recording. | (a)/(b) follow the exact pattern every other provider (Codex/Claude/Cursor/Grok/OpenCode) already uses in this file — there is no lighter-weight way to add a provider's settings schema upstream already established. (c) is the explicit default-visibility requirement: Claude and GitHub Copilot ship enabled out of the box, Cursor (already disabled upstream)/Grok/OpenCode ship disabled. (d) lets Copilot sessions receive explicit MCP servers and custom-agent/fleet settings because the SDK does not inherit a usable T3 UI-level config automatically, and gives the future evidence forwarder a hidden settings home. |
| `packages/contracts/src/providerRuntime.ts`                                | One raw event source literal added: `"copilot.sdk.session-event"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Lets fork-owned Copilot adapter events preserve governance-grade SDK payloads for the later AI-Orch evidence forwarder without widening canonical event payloads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/contracts/src/model.ts`                                          | One `const COPILOT_DRIVER_KIND` + one entry each in `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES_BY_PROVIDER`, `PROVIDER_DISPLAY_NAMES`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Same per-provider registration pattern every existing driver kind uses in this file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/settings/providerDriverMeta.ts`                   | Two import additions (`CopilotSettings`, `GithubCopilotIcon`) + one new entry in `PROVIDER_CLIENT_DEFINITIONS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Makes Copilot a normal, live provider option in the settings UI — this array is what drives the whole settings panel generically (see `SettingsPanels.tsx`, which needed no edit at all because it's already generic over `DRIVER_OPTIONS`).                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/components/settings/AddProviderInstanceDialog.tsx`           | Removed the `githubCopilot` entry from `COMING_SOON_DRIVER_OPTIONS` (and the now-unused `GithubCopilotIcon` import from this file — it moved to `providerDriverMeta.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Copilot was already scaffolded here as a disabled "Coming Soon" stub before this task; it's now a real option via `DRIVER_OPTIONS`, so the stub entry is redundant and would show Copilot twice.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/components/settings/ProviderInstanceCard.tsx`                | Adds a compact Copilot-only setup row inside the existing provider instance details, an "MCP servers" JSON editor (validated against the `CopilotMcpServers` schema; exports pure `parseCopilotMcpServersDraft`/`formatCopilotMcpServersForEditor`), plus a Copilot-only "Governance (AI-Orch)" section (enabled switch, a separate "Route MCP through gateway" (`gatewayEnabled`) switch, governance URL, masked `air_` credential, test-connection button with inline result, and a commented `GOVERNANCE_SSO_ENROLMENT_URL` seam for the future browser SSO enrolment flow).                                                                                                                                                                                                                                                                                                                   | Reuses the generic provider refresh path to verify Copilot auth, entitlement, and model discovery without adding a wizard or a second provider status surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/src/components/settings/SettingsPanels.tsx`                      | Passes the existing provider refresh action/state into provider cards as a verify affordance, and plumbs the hidden `managedClientEvidence` settings + the `mcpServers` JSON editor + the `server.testManagedClientEvidenceConnection` RPC command into the Copilot card (settings patched through `settings.providers`, mirroring `resetDefaultInstance`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keeps Copilot onboarding inside the existing Providers settings section and avoids a new RPC for the already-supported status probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/CommandPalette.tsx`                               | Adds thread-scoped root actions for opening the Terminal and Diff surfaces, plus (workspace-rail slice) opening the Files, Plan, and Subagents surfaces, a "Switch model" action that calls `composerHandleRef.current?.openModelPicker()` (safe null no-op), and an "Open MCP servers" action that requests the `/mcp` rail popover. Icons imported directly from `lucide-react`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Makes existing workbench surfaces discoverable from the command palette before adding new UI chrome. All actions route to surfaces/pickers that already exist; none are phantom.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/composer-logic.ts`                                           | Extends the built-in composer slash-command union with `terminal`, `diff`, `files`, `subagents`, `goal`, `fleet`, and `mcp`, and adds a pure `resolveSlashCommandAction(command)` → `SlashCommandAction` mapper. Standalone submit parsing stays limited to `/plan` and `/default`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Allows action-only slash commands in the composer menu without changing prompt submit behavior, and moves the command→effect mapping into one pure, unit-tested function instead of inline component logic.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/composer-logic.test.ts`                                      | Adds a `resolveSlashCommandAction` describe block covering every built-in command (model/terminal/diff/files/subagents/plan/default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The runnable check behind the extracted routing helper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/components/chat/ChatComposer.tsx`                            | Adds `/terminal`, `/diff`, `/files`, `/subagents`, `/goal`, `/fleet`, and `/mcp` to the built-in slash-command menu; the selection handler now dispatches on `resolveSlashCommandAction(...)` into the existing model-picker/terminal/right-panel/interaction-mode stores. Text-insertion branches (path/provider-slash-command/skill) are untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Makes existing workbench surfaces reachable from the composer command flow, with routing behavior centralized in the pure helper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/components/chat/ChatHeader.tsx`                              | One import + one mount: renders `<ThreadWorkspaceRail>` as the first child of the existing `data-chat-header-actions` cluster, passing the env/thread/project values ChatHeader already receives. No new props, no reformatting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Mounts the fork-owned workspace rail beside the existing header actions (ProjectScripts/OpenIn/GitActions) without restructuring the header.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/components/chat/composerSlashCommandSearch.test.ts`          | Adds regression coverage for searching the new `/terminal`, `/diff`, `/files`, `/subagents`, `/goal`, `/fleet`, and `/mcp` built-ins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keeps command-menu discoverability pinned as more fork commands are added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/session-logic.ts`                                            | Includes `task.started` in the existing work log and gives started/progress task rows the in-progress tone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Makes Copilot SDK `subagent.started` events visible through the existing timeline without adding a fork-only UI surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/mobile/src/lib/threadActivity.ts`                                    | Same `task.started` work-log inclusion and in-progress tone as web.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Keeps mobile feed behavior aligned with the web timeline for Copilot subagent lifecycle events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/provider/Layers/GrokProvider.test.ts`                     | Updated one pre-existing test ("returns a pending snapshot by default") to assert the new disabled-by-default behavior, and added a sibling test for the explicitly-enabled case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The old test encoded the exact default this task changed; it wasn't testing something we broke, it was testing the old default value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts`                 | One array literal updated: inserted `"githubCopilot"` into the expected sorted list of registered provider instance ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | This test asserts the full set of built-in driver instance ids; adding a driver means the list grows by one, alphabetically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/server/src/serverSettings.test.ts`                                   | One assertion updated: an OpenCode settings-patch test now expects `enabled: false` (was `true`) because the patch under test never sets `enabled`, so the new default now flows through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Same category as the `GrokProvider.test.ts` change — a test that encoded the old default value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/server.ts`                                                | One import + one `ReactorLayerLive` entry for `ManagedClientEvidenceForwarderLive()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Starts the fork-owned evidence forwarder beside the existing provider/orchestration reactors without restructuring server composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/contracts/src/rpc.ts`                                            | One `WS_METHODS` entry, one `Rpc.make` block (`WsServerTestManagedClientEvidenceConnectionRpc`), one `WsRpcGroup` registration, one import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Exposes the fork-owned governance test-connection action through the same RPC registration pattern every existing server method uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/contracts/src/server.ts`                                         | One appended schema block: `CopilotManagedClientEvidenceTestConnectionResult` (`ok`/`status`/`message`; never the credential).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Typed result contract for the governance test-connection RPC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/server/src/ws.ts`                                                    | One import, one `RPC_REQUIRED_SCOPE` entry (operate scope), one RPC handler delegating to the fork-owned `testManagedClientEvidenceConnection` with the saved settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Serves the governance test-connection RPC using the established observe/scope wrapper; all logic stays in the fork-owned module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/client-runtime/src/state/server.ts`                              | One `createEnvironmentRpcCommand` entry (`testManagedClientEvidenceConnection`, single-flight per environment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Client command atom for the governance test-connection button, matching the file's existing per-method command pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/contracts/src/orchestration.ts` (goal)                           | Adds optional `goal`/`goalStatus` to `OrchestrationThread` + `OrchestrationThreadShell`, and to `ThreadMetaUpdateCommand` + `ThreadMetaUpdatedPayload`. Modeled on the existing `branch`/`worktreePath` optional metadata fields; `Schema.optional` (not `withDecodingDefault`) keeps them absent-able so existing thread literals/fixtures need no change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/server/src/orchestration/decider.ts` (goal)                          | One pass-through pair in the `thread.meta.update` command→event mapping (`goal`/`goalStatus` when present), mirroring the `branch`/`worktreePath` lines beside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/server/src/orchestration/projector.ts` (goal)                        | Same pass-through pair in the `thread.meta-updated` read-model apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (goal)        | Sets `goal: null`/`goalStatus: "active"` on the `thread.created` projection row and applies goal/goalStatus on `thread.meta-updated` upsert.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (goal)   | Adds `goal`/`goal_status` to the four full-thread-row `SELECT`s and maps them into the thread snapshots. Required because the row schema carries the columns — omitting them from the SELECTs would be a runtime decode failure typecheck can't catch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/server/src/persistence/Services/ProjectionThreads.ts` (goal)         | Adds required `goal`/`goalStatus` to the `ProjectionThread` row schema (the DB always has the columns post-migration).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/server/src/persistence/Layers/ProjectionThreads.ts` (goal)           | Adds `goal`/`goal_status` to the upsert INSERT/UPDATE and to the getById/list `SELECT`s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/server/src/persistence/Migrations.ts` (goal)                         | One import + one registry entry for migration `033_ProjectionThreadsGoal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/server/src/server.test.ts` / `ProjectionRepositories.test.ts` (goal) | Thread-row fixtures set `goal: null`/`goalStatus: "active"` where the row schema requires them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/client-runtime/src/state/threadReducer.ts` (goal)                | Applies `goal`/`goalStatus` in the client `thread.meta-updated` reducer, mirroring `branch`/`worktreePath`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/src/rightPanelStore.ts` (subagents)                              | Adds a `"subagents"` singleton right-panel kind (union member, `RIGHT_PANEL_KINDS`, `singletonSurface` case), exactly like the existing `"plan"` kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/components/RightPanelTabs.tsx` (subagents)                   | `surfaceTitle`/`SurfaceIcon` cases for `"subagents"` (Bot icon), matching the `"plan"` pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/web/src/components/ChatView.tsx` (subagents)                         | One import + one `rightPanelContent` branch rendering `<SubagentsPanel activities={threadActivities} …>`, mirroring the `plan` branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/session-logic.ts` (subagents)                                | Adds the pure `deriveSubagentCards` helper beside the existing work-log derivations; groups `task.*` activities by `taskId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/components/chat/ChatHeader.tsx` (goal)                       | Adds one `<GoalChip>` mount beside the thread title (in addition to the earlier `<ThreadWorkspaceRail>` mount).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/web/src/rpc/requestLatencyState.ts`                                  | Raises the client slow-RPC-ack **warning** threshold `SLOW_RPC_ACK_THRESHOLD_MS` from 15s to 30s. Warning-only (the "some requests are slow" toast); never aborts a request. Heavier ops like `vcs.refreshStatus` fan out to several git commands (incl. a remote refresh) and can legitimately exceed 15s on large repos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/components/DiffPanel.tsx`                                    | Strengthens the diff add/remove **row background** intensity (`--diffs-bg-{addition,deletion}-*-override`): added rows went from ~8% to ~18% `--success`, changed-token emphasis to ~38%, deletions mirrored with `--destructive`. Theme-token based, so light/dark both adapt. Purely presentational; the pierre/diffs render model is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Product UI backlog and reference notes

This fork should stay operationally dense: agent work, terminal, git, model/goal controls, and subagent activity should be reachable without hunting through separate surfaces. Keep this section as investigation guidance; do not treat it as implemented state.

### References checked

- [`getpaseo/paseo`](https://github.com/getpaseo/paseo): daemon + desktop/mobile/web/CLI model for orchestrating multiple agents. Useful product ideas: cross-device control, CLI parity (`paseo run`, `ls`, `attach`, `send`), worktree-aware launches, and slash-command skills such as `/paseo-handoff`, `/paseo-loop`, `/paseo-advisor`, `/paseo-committee`.
- [`wygoralves/panes`](https://github.com/wygoralves/panes): Tauri panel for agents, terminal, and git. Useful product ideas: terminal as a first-class workspace surface, git operations beside the agent, xterm.js + pty terminal stack, and terminal-origin notifications for Codex/Claude/OSC events.
- Codex desktop app: composer `/` commands act as fast entry points for task modes such as goals, models, plugins/tools, and subagent-style work. Treat this as the target interaction feel: command-first, discoverable, and keyboardable.

### Current T3 Code baseline

- T3 already has a terminal implementation: `apps/web/src/components/ThreadTerminalDrawer.tsx`, `apps/web/src/terminalUiStateStore.ts`, `packages/contracts/src/terminal.ts`, and IPC terminal methods in `packages/contracts/src/ipc.ts`. It supports xterm.js, terminal sessions, splits/new/close keybindings, terminal context chips, and right-panel terminal surfaces.
- The terminal gap is product fit, not total absence: it is too easy to miss compared with Codex/Panes because it is not presented as a primary workspace pane with obvious agent/git adjacency.
- T3 already has a command palette and composer slash-command menu (`CommandPalette.tsx`, `ComposerCommandMenu.tsx`), plus model-picker keybindings. The gap is that fork-specific controls (goals, active model/provider, Copilot custom agents, Fleet Mode, terminal, git/diff, and governance status) are not consolidated into one command-first workflow.

### Actual application UX target

The target experience is a dense coding-agent workspace: chat stays central,
but the user should always know what is running, what model/agent is active,
what branch/diff they are changing, and where to open terminal/subagent work.
Avoid landing-page composition, decorative panels, and hidden "advanced" power
that makes the user discover features by accident.

#### Primary thread screen

- The first viewport should read as **Chat + Workbench**, not chat alone.
  Thread content remains the main column; operational controls sit close to the
  thread title and composer.
- The thread header or a compact workspace rail should show, without opening a
  menu: active provider/model, active goal/status, branch/diff state, terminal
  running state, Fleet Mode/subagent state, and governance/evidence state when
  configured.
- Controls should be icon-first with tooltips and short labels only where
  needed. Keep them small enough for repeated daily use; do not add large cards
  above the conversation.
- Running state should be obvious: stop button, active model, live terminal
  indicator, and active subagent/Fleet status should not compete with one
  another or appear in unrelated corners.
- Empty thread state should immediately offer the useful work surfaces: prompt
  composer, model/provider picker, terminal, git/diff, and optional goal. Do
  not route users through onboarding copy once a project is already selected.

#### Composer UX

- The composer is the command center. Users should learn one habit: type `/`
  to start an action.
- `/model` opens the existing model/provider picker. `/goal` creates or edits
  the thread goal. `/terminal` opens or focuses the terminal. `/fleet` toggles
  or starts Fleet Mode. `/agent` selects the active Copilot custom agent.
  `/mcp` opens MCP/server attribution or settings. `/git` and `/diff` open the
  repo work surfaces. `/review` starts the review-oriented flow. `/handoff`
  creates a handoff summary.
- Slash commands should open existing UI surfaces where possible. They do not
  need bespoke inline mini-apps in v1.
- The composer should keep terminal context insertion discoverable: selected
  terminal output, command failures, and file/path links should be easy to add
  to the prompt.
- Model/agent/Fleet controls should stay near the composer submit controls so
  the user sees execution mode before sending, like Codex desktop.

#### Right panel UX

- The right panel should become the workbench, with a stable set of tabs:
  `Terminal`, `Diff`, `Files`, `Preview`, `Subagents`, and later `Governance`.
- The panel should preserve existing surfaces first. Reuse `RightPanelTabs`,
  preview/file/diff surfaces, and `ThreadTerminalDrawer`; do not create parallel
  systems for terminal, git, files, or preview.
- Opening an item from chat, slash commands, terminal links, or git actions
  should route into the same right-panel state model. The user should not care
  whether an action began in the composer, command palette, sidebar, terminal,
  or message body.
- If the right panel is closed and a user invokes `/terminal`, `/diff`,
  `/subagents`, or clicks a terminal/git/file affordance, the right panel should
  open directly to the requested surface.
- Maximize/split behavior should remain explicit. Avoid automatically stealing
  the chat column unless the user has chosen a side-by-side companion thread.

#### Sidebar UX

- The sidebar should show compact activity, not only navigation. A thread row
  should signal running agent work, terminal process running, open PR/change
  request, worktree, and child/companion task where available.
- Companion/subagent tasks should visually read as related to the parent
  thread. The Codex screenshot shows this as a child-ish companion task in the
  sidebar; T3 can start with a nested/linked row or a clear badge on the parent.
- Search and command palette should remain the fast cross-project route. Do not
  duplicate a second project launcher inside the thread UI.

#### Visual density and ergonomics

- The app should feel closer to Codex/Panes than a generic SaaS dashboard:
  compact controls, predictable tabs, direct actions, no marketing hero layout,
  no oversized cards for core workflow, and minimal vertical dead space in
  thread header/composer/right panel.
- Use existing icon/button patterns and tooltips. Add labels only when an icon
  would be ambiguous or when the state value matters, such as model name or
  branch name.
- Keep status in one glanceable band instead of scattering it across sidebar,
  composer, and panel headers.
- Mobile can lag desktop for this fork UI pass. Keep mobile event feed parity
  for subagent rows, but do not force the full workbench layout onto mobile
  until the desktop interaction has settled.

### Codex sub-agent view target

- The Codex screenshot target is a split companion-thread workspace, not only a timeline row: the main thread remains on the left while a sub-agent/companion thread runs beside it with its own header, progress stream, composer, model picker, stop control, and worker identity tabs such as `Sartre`, `Erdos`, and `Linnaeus`.
- T3's current fork behavior only makes Copilot `subagent.*` events visible through generic task/work-log rows. That is the correct fallback, but it does not yet match the Codex experience where sub-agent work is navigable, steerable, and visually parallel to the parent thread.
- The first UI pass should reuse right-panel/surface plumbing for a `Subagents` surface that groups worker events by stable `agentId`/`toolCallId`. A later pass can promote a worker into a side-by-side companion thread once direct steering/composer support exists.
- 2026-07-04 update: the per-provider event surface was verified and a full implementation plan was written and Codex-reviewed; see "Sub-agent panel + in-app GitHub device login: implementation plan" below for the capability matrix and slices.

### Terminal target

- The target is not "add terminal"; the terminal already exists. The target is "make terminal impossible to miss": visible Terminal entry near the thread header/composer, right-panel tab access, command-palette actions, and running-terminal state visible beside the thread.
- Preserve the current terminal implementation (`ThreadTerminalDrawer`, right-panel terminal surfaces, xterm.js, splits/new/close, terminal context chips). Do not create another terminal component or session model.
- Terminal should sit beside agent and git work like Panes: a user should be able to read agent output, run commands, inspect diffs, and feed terminal context back into the composer without changing mental modes.

### Command and slash target

- Codex desktop's `/` behavior is the interaction model: quick, keyboardable entry points for goal/model/tool/workflow actions from the composer.
- T3 already has two relevant surfaces: `CommandPalette.tsx` for global actions and `ComposerCommandMenu.tsx` for composer `/` entries. Use those before adding new chrome.
- Initial fork commands should be `/goal`, `/model`, `/terminal`, `/fleet`, `/agent`, `/mcp`, `/git`, `/diff`, `/review`, and `/handoff`. Commands may open existing UI instead of implementing new flows inline.

### Goals, models, and agent controls target

- Goals should become a first-class thread state similar to Codex goals: visible near the thread title, startable from `/goal`, and clear about active/inactive/completed state. Do not invent a complex project-management layer.
- Model/provider controls should stay compact and reuse the existing model picker. The fork-specific gap is surfacing active provider/model beside Fleet Mode and active Copilot agent, not building another picker.
- Copilot `customAgents`, `defaultAgent`, `activeAgent`, and `fleetMode` already exist in hidden settings/backend wiring. The UI target is a small selector/toggle path first, with JSON/org-preset editing deferred until the settings model is stable.

### Git and diff target

- Git/diff should be adjacent to agent and terminal work, not buried as a separate afterthought. Panes' useful lesson is the panel composition: agent, terminal, and git are one workflow.
- Reuse existing T3 git/diff surfaces and branch toolbar controls. The fork backlog is to add command-palette and `/` routes into those surfaces and show branch/diff status in the compact workspace rail.
- Do not add a second git client UI unless the existing diff/branch/review surfaces cannot host the needed action.

### Governance and evidence target

- Governance status should be visible but quiet: current evidence-forwarding state, MCP gateway/source attribution, and permission/approval state should be inspectable from the workspace rail or a right-panel surface.
- `ProviderService.ts` and the AI-Orch evidence forwarder are still separate work. UI should not imply governance is fully wired until that runtime path exists.
- Prefer raw-event/source attribution already added for Copilot over broad canonical event changes; the UI can inspect fork-owned metadata first.

### To investigate

- Whether the existing right-panel terminal should become the default visible “workspace” surface for desktop threads, or whether the chat layout should add a persistent bottom/side terminal lane. Prefer reusing `ThreadTerminalDrawer.tsx` and `RightPanelTabs.tsx`; do not build a second terminal.
- Whether composer `/` should expose fork actions directly: `/goal`, `/model`, `/terminal`, `/fleet`, `/agent`, `/mcp`, `/git`, `/diff`, `/review`, `/handoff`. Prefer registering these through the existing composer command menu/provider slash-command path.
- Whether Copilot `customAgents` should be edited through hidden JSON only, a small command-palette form, or an org-managed preset list. Do not build a full agent marketplace until org presets and AI-Orch governance need it.
- Whether a sub-agent worker should stay inside a right-panel `Subagents` surface, open as a full side-by-side companion thread, or support both modes with the same underlying surface state.
- Whether terminal-origin notifications should be adopted from Panes' pattern: launch terminals with a session env, bridge Codex/Claude notifications back to the owning T3 terminal, and dedupe replayed OSC notifications.
- Whether a compact “workspace rail” should replace scattered controls: active provider/model, runtime mode, goal, terminal status, git branch/diff, preview/files, subagent/fleet activity, governance state.

### To do

- Make terminal discoverability tighter: surface a visible Terminal tab/action in the first viewport of thread work, preserve existing split/new/close behavior, and show running terminal state near the thread title/sidebar.
- Add command-first shortcuts for fork workflows using existing command surfaces before adding new chrome. Initial commands should cover model/provider switch, terminal open/new/split, Fleet Mode toggle/start, Copilot active agent, and goal/status entry points.
- Promote subagent lifecycle from generic work-log rows into a compact worker strip or grouped activity section once backend events carry stable `agentId`/`toolCallId` correlation. Keep the existing work-log fallback.
- Add a `Subagents` right-panel surface before building a full companion-thread UI. It should show worker identity/model, latest status, progress entries, and open/stop/inspect actions using existing surfaces where possible.
- Add a side-by-side companion-thread mode only after the `Subagents` surface proves useful and the backend can support direct steering of a worker without pretending every event stream is independently controllable.
- Put git/diff actions beside agent and terminal work. Panes' lesson is that git is part of the agent loop, not a separate afterthought.
- Keep UI density closer to Codex/Panes than a marketing layout: smaller controls, fewer decorative cards, direct action buttons/icons, and less vertical dead space in thread headers/composer/right panel.

### Suggested implementation order

1. **Workspace rail and terminal discoverability.** ✅ LANDED. Fork-owned
   `ThreadWorkspaceRail.tsx` mounted in `ChatHeader.tsx` shows the active model
   (click opens the model picker), a live terminal-running indicator, and
   open-terminal / open-diff actions, plus a Copilot fleet chip shown only when
   `fleetMode` is enabled. It reuses existing stores (`terminalUiStateStore`,
   `rightPanelStore`, `state/terminalSessions`, `useEnvironmentSettings`) — no
   new terminal/panel/picker. Per YAGNI, the goal/governance "placeholder
   slots" were intentionally NOT added as dead chrome; they arrive with items
   5/7 when their state is real. Fleet is the only forward-looking indicator
   and it is gated on real settings.
2. **Slash-command and command-palette routing.** ✅ FIRST PASS LANDED. Added
   the `/files` composer slash command and command-palette actions for Open
   Files, Open Plan, and Switch Model, all routing to existing surfaces.
   Composer routing was refactored into the pure, tested
   `resolveSlashCommandAction`. `/git`, `/fleet`, `/agent`, `/goal`, and
   `/handoff` were deliberately deferred, not stubbed: `/git` would duplicate
   `/diff` (there is no separate git panel kind), and the others have no
   backing surface yet — they belong to items 3/4/5. Add them when their
   targets exist.
3. **Subagents right-panel surface.** ✅ LANDED. `SubagentsPanel.tsx` renders
   worker cards grouped from a thread's `activities` by `taskId` (pure
   `deriveSubagentCards`), reachable via `/subagents` and the command palette,
   reusing the singleton right-panel plumbing. Generic timeline rows remain the
   fallback. Note: Copilot only emits `task.started`/`task.completed` (no
   `task.progress`, no distinct `agentId`), so cards key on `taskId` derived
   from `toolCallId`; a richer progress stream arrives if a provider emits it.
4. **Fleet Mode and Copilot agent controls.** ✅ LANDED (selector/toggle).
   `CopilotThreadControls.tsx` in the rail toggles `fleetMode` and selects
   `activeAgent` from existing `customAgents`, via the existing
   `settings.providers` write path. Deferred as planned: custom-agent authoring
   (still `settings.json`) and org-preset marketplace. The `/fleet` composer
   command opens these controls (no-op when Copilot is disabled).
5. **Goal state.** ✅ LANDED (minimal). Optional `goal`/`goalStatus` on the
   thread contract, persisted through the existing `thread.meta.update`
   event-sourced command (+ migration `033`); `GoalChip.tsx` shows/edits it
   near the thread title with active/done status. No planning database. The
   `/goal` composer command opens the editor (via `workspaceRailUiStore`).
6. **Git/diff adjacency polish.** Tighten branch/diff/review access beside the
   terminal and agent workflow. Reuse existing branch toolbar, diff, and review
   surfaces.
7. **Governance/evidence surface.** Add quiet visibility for MCP attribution,
   permission decisions, and evidence-forwarding state after the server
   forwarder exists. The UI must not claim governance is active before the
   runtime path is wired.
8. **Side-by-side companion-thread mode.** Implement the Codex screenshot-level
   split only after the `Subagents` surface proves useful and the backend can
   support worker steering/composer behavior honestly. A detailed,
   Codex-reviewed plan for the whole path (worker identity on `task.*`,
   per-provider attribution, worker-tabbed panel, steering last) now exists:
   see "Sub-agent panel + in-app GitHub device login: implementation plan"
   below. The panel slices (A1-A5 there) are the current top product priority
   and supersede this item's ordering; only the steering/companion slice (A6)
   remains gated.

Recommended first slice: items 1 and 2 together. ✅ Done. Items 3–5 also landed
(subagents surface, fleet/agent controls, goal state). Items 6–8 remain, plus the
new "Platform & integration backlog" section below (MCP registry, provider-neutral
MCP injection, shared secret storage, Jira/Rovo, Codex SDK, AI-Orch SSO, APM skills),
plus the "Sub-agent panel + in-app GitHub device login" implementation plan section.

## Platform & integration backlog (designed this session, NOT built)

Design decisions and research from the MCP/Jira/Codex/auth discussions. Nothing
here is implemented; it's captured so the design isn't lost. Guiding constraint:
**the org fronts MCP through a Foundry MCP gateway**, so do NOT build a heavy
client-side MCP catalog — the client should stay thin (enable + credential) and
lean on the gateway.

### MCP registry / per-user enrollment (future)

- **Shape:** a new **"MCP" settings tab** (sibling to Providers): rows for org-allowed
  MCP servers, each with an enable toggle + an `apiKey`/credential field, opt-in per
  user. One enrollment should apply across all the user's agents.
- **Don't overbuild:** the org's Foundry MCP gateway is the allowlist + broker. The
  client tab likely just enables an entry and stores the user's key; the gateway
  handles fan-out/governance. Avoid duplicating a catalog/marketplace client-side.
- **Existing seam:** `resolveCopilotMcpServers` already merges an (empty)
  `COPILOT_ORG_MCP_PRESETS` map — that's the org-catalog seam, currently Copilot-only.

### Provider-neutral MCP injection (future — the real lift)

- Today T3-level MCP config lives under `githubCopilot` and only the Copilot adapter
  injects it (plus the per-session `t3-code` server every adapter injects). To make
  "enroll once → works in Codex/Claude/Copilot," lift MCP config to a **top-level,
  provider-neutral** settings block and have **every adapter inject** enrolled servers:
  Codex via `--config mcp_servers.X`, Claude via its `mcpServers` option, ACP
  (Cursor/Grok) via its `mcpServers` array. Each adapter already proves it can inject
  one server (`t3-code`); generalize that.

### Secret storage — solve once (future, HIGH priority)

- The "keep the secret out of `settings.json` plaintext" problem has now appeared
  **three times**: the governance `air_` credential, the Jira/Rovo token, and MCP
  enrollment keys. All currently would land in `settings.json`.
- **Decision:** route all of these through `apps/server/src/auth/ServerSecretStore`
  (already used for relay/cloud creds + the env signing keypair). Do this once, as a
  shared "provider/MCP secret" path, before adding more credential fields.

### Jira / Atlassian Rovo MCP (research — verified against Atlassian docs)

- **Official Rovo Remote MCP:** GA, cloud-hosted at `https://mcp.atlassian.com/v1/mcp`
  (use `/v1/mcp` or `/v1/mcp/authv2`; `/v1/sse` is retired after 2026-06-30). Covers
  Jira/Confluence/Compass/JSM, respects the user's existing Atlassian permissions,
  admin-governed + audited.
- **Auth modes (all fit our `http` MCP schema of `url` + `headers`):**
  - Personal API token — `Authorization: Basic base64(email:token)` (the "user's own
    key, own permissions" mode).
  - Service account key — `Authorization: Bearer <key>` (admin-managed; ideal to route
    via the Foundry/AI-Orch gateway).
  - OAuth 2.1 (3LO + dynamic client registration) — most secure/full tool set, but needs
    a real OAuth flow the static-header SDK config can't do alone. Defer unless per-user
    browser consent is required.
- **Credit economics (corrects the "free 1M tokens" premise):** some Rovo MCP tools bill
  ≥1 Rovo credit/call; raw issue fetches still cost the _coding agent's_ tokens to read.
  The real offload is Rovo **summarize** tools — Rovo condenses server-side (cheap Rovo
  credits), the agent ingests a small summary (saves expensive agent tokens). Design the
  prompt convention around summarize, not raw dumps.
- **Works today (Copilot only):** pasting a Rovo `http` server + Basic/Bearer header into
  the `/mcp` JSON editor already works — no new code. The dream prompt ("check Rovo for my
  pending Jira tasks, check Confluence for details") works once attached; `@Rovo` is UX sugar.
- **First slice when built:** a one-click "Add Atlassian Rovo" preset (pick auth mode →
  store key in `ServerSecretStore` → inject the `mcp.atlassian.com/v1/mcp` entry).

### Codex SDK (research — decision: do NOT migrate)

- The TS `@openai/codex-sdk` is a thin `codex exec --experimental-json` wrapper: no
  interactive approvals/user-input, no streaming reasoning/output deltas, no live token
  usage, no `listModels`/skills. It is **strictly less capable** than the fork's current
  Codex app-server integration (`CodexSessionRuntime.ts`), which already maps the full
  rich surface. Migrating would be a downgrade.
- The only real win (drop the separate CLI install) is achievable **without** the SDK:
  bundle `@openai/codex` (+ platform optional deps) and point `binaryPath` at the vendored
  binary. Gateway routing (analogous to Claude's `ANTHROPIC_BASE_URL`) is available on the
  existing app-server path via `--config openai_base_url=<gateway>` + `CODEX_API_KEY`.

### AI-Orch domain SSO → long-term token (research + design; blocked on ai-orch)

- Goal: domain-account SSO mints a developer-scoped `air_` credential instead of manual
  paste. **The mint half exists on neither side** except the inert
  `GOVERNANCE_SSO_ENROLMENT_URL = null` seam in `ProviderInstanceCard.tsx`; all new logic
  (OIDC RP, token minting, token→identity mapping, lifecycle/revocation) lives in the
  **ai-orch** repo (not readable from here; branch `feat/governed-client-onboarding`).
- **t3code side (small, when ai-orch is ready):** flip the seam to the enrol URL, wire
  "Enrol via SSO" to capture the token (loopback + PKCE, mirroring the existing pairing
  flow), and store it in `ServerSecretStore` (not settings.json). Reuse the existing
  `apps/server/src/auth/` stack (JWT issue/verify, DPoP, secret store, revocable pairing).
- **Security bar:** short-TTL + refresh over long-lived tokens; DPoP-bind if possible;
  developer-scoped; per-developer revocation. Don't advertise governance as active in the
  UI before the ai-orch path is proven.

### APM (skills distribution layer) — parked

- This is the **deferred distribution/auto-update layer** that sits _on top of_ the Skills
  tab (see "Skills — top-level Skills tab" below); it is not a competing skills design.
  The user-facing surface is settled there; this entry is only about org-wide package
  management once the tab exists.
- Exploring [Microsoft APM](https://microsoft.github.io/apm/) (agent package manager for
  skills/prompts/MCP) for **auto-updating org skills with team-level customization**. Wanted
  model: layered precedence (org base → team override → user override), rolling vs. pinned
  channels, notify-on-update (don't silently break workflows). Reuse the existing provider
  skill infra (`searchProviderSkills`, `$skill` mentions, Codex `skills/list`) rather than a
  parallel system; deliver the org registry via the Foundry/AI-Orch gateway like the MCP
  catalog. No spec yet. Rule: surface now, manage files next, distribute later.

### Governance mode: recorder vs. gateway — ✅ IMPLEMENTED (decoupled)

- **Done this session.** `CopilotManagedClientEvidenceSettings` now has two independent flags:
  `enabled` (passive evidence **recording** — the v1 role, fail-open) and `gatewayEnabled`
  (active **gateway** routing — default off). `resolveCopilotMcpServers`'s AI-Orch MCP gateway
  injection is now gated on `gatewayEnabled`, not `enabled`, so turning on recording no longer
  pulls the gateway into the request path. The governance settings UI has a second "Route MCP
  through gateway" switch. Both roles share `governanceUrl`/`credential`.
- Files: `packages/contracts/src/settings.ts` (schema + patch + default), `CopilotMcpServers.ts`
  (gate on `gatewayEnabled`), `ProviderInstanceCard.tsx` (second Switch), + test updates.
- Future: when model routing (not just MCP) is added through ai-orch, gate it on the same
  `gatewayEnabled` flag.

### Skills — top-level "Skills" tab, Kiro-style (design; NOT built)

- **Correct mental model:** a skill is just a scoped `.md` file. The user-facing surface is
  **provider-neutral file management**, not a hidden per-provider SDK setting. Mirror Kiro's
  "Agent Steering & Skills": a top-level **Skills** settings tab (sibling to Providers / Source
  Control / Connections) with **Workspace** and **Global** scope, exactly like steering files.
- **Storage:** a T3-owned skills folder per scope — Global under `~/.t3/skills/` and Workspace
  under `.t3/skills/` (reuse the `AGENTS.md`/steering convention already in the repo rather than
  inventing a new location). Each skill is a single `.md` (optional YAML frontmatter
  `name`/`description`).
- **Skills tab does:** list skills per scope, import/create a `.md`, enable/disable per scope.
  Same architecture as the MCP registry surface (`CopilotMcpControls` pattern) — one neutral
  store, provider adapters consume it.
- **Provider-neutral injection (the mechanism, not the surface):** Copilot consumes the folder
  via `skillDirectories`/`disabledSkills` on `client.createSession` (mirrors how
  `mcpServers`/`customAgents` are wired in `CopilotAdapter.ts`); Codex/Claude consume the same
  files through their own skill mechanisms. The tab writes files; each adapter points its
  provider at the right folder.
- **Near-term surfacing:** T3 already fetches provider-native skills (Codex `skills/list`,
  `searchProviderSkills`, the `$skill` composer mention). A `/skills` picker (same pattern as
  `/mcp` / `/subagents`) surfaces those with scope + descriptions and routes into the existing
  `$skill` insertion. Provider-managed create/install skills (e.g. Codex "Skill Creator") are
  surfaced/triggered, not rebuilt.
- **Deferred:** cross-harness distribution + auto-update (the APM layer) is parked. Rule:
  **surface now, manage files next, distribute later.**

## Sub-agent panel + in-app GitHub device login: implementation plan (Codex-reviewed 2026-07-04, NOT built)

Two workstreams, planned in detail and peer-reviewed by Codex on 2026-07-04.
Nothing in this section is implemented yet. The sub-agent panel is the user's
top product priority: the target is the Codex-desktop companion-pane
experience (named worker tabs such as `Sartre`/`Erdos`/`Linnaeus`, each with
its own narrative progress stream, model label, status/elapsed, and, where the
backend honestly supports it, a stop control and composer), instead of today's
flat tool rows in the chat timeline.

### Verified per-provider capability matrix (2026-07-04, evidence in-tree)

| Provider | Worker identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Per-worker progress stream                                                                                                                                                                                                                                                              | Worker model                                                                | Steering                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot  | SDK emits it; adapter drops it. Every SDK session event carries an optional `agentId` ("Sub-agent instance identifier", ~50 event types, `@github/copilot-sdk` `dist/generated/session-events.d.ts:4611-4615`); `SubagentStartedData` (`:4641-4662`) carries `agentDescription`/`agentDisplayName`/`agentName`/`model?`/`toolCallId`. `CopilotAdapter.ts` maps `subagent.started/completed/failed` to `task.started/completed` keyed on `toolCallId` (`:873-936`) and never reads `agentId`.                                                                                                                                                                                                                    | SDK emits it; adapter flattens it. The adapter already sets `includeSubAgentStreamingEvents: true` (`CopilotAdapter.ts:616`), so `agentId`-tagged assistant/reasoning/tool deltas are arriving today and being merged into the main thread unattributed. No `task.progress` is emitted. | SDK yes (`model?` on started/completed, `:4657`/`:4712`); adapter drops it. | None per worker. `session.send`/`sendAndWait` are whole-session (`dist/session.d.ts:96-128`); fleet is `fleet.start({prompt})`, session-level. |
| Claude   | Partial. CLI system messages `task_started/task_progress/task_notification` map to `task.started/progress/completed` with `taskId`/`description`/`task_type` (`apps/server/src/provider/Layers/ClaudeAdapter.ts:2668-2718`). Nested subagent content is unattributed: `parent_tool_use_id` is treated as a noise key (`:1274`) and nested deltas are consumed for token usage only (`:2080-2082`).                                                                                                                                                                                                                                                                                                              | Partial today (progress summaries + `lastToolName` already flow); nested assistant/tool content flattened.                                                                                                                                                                              | No. Only the subagent `task_type` is known.                                 | None. The CLI exposes no channel to a running subagent.                                                                                        |
| Codex    | Protocol yes; fork hides it. Collab/review workers surface as opaque `item.*` rows (`CodexAdapter.ts` `mapItemLifecycle :451-487`, canonical types `collab_agent_tool_call`/`review_entered`/`review_exited`); no `task.*` at all. The app-server schema's `CollabAgentToolCallThreadItem` (`packages/effect-codex-app-server/src/_generated/schema.gen.ts:18820-18865`) carries `id`, `model?`, `prompt?`, `receiverThreadIds` (the spawned worker thread), `senderThreadId`, `status`, `tool` (`spawnAgent`/`sendInput`/`resumeAgent`/`wait`/`closeAgent`), and an `agentsStates` map. `CodexSessionRuntime.ts` deliberately flattens child threads into the parent turn (`collabReceiverTurns`, `:588-608`). | Protocol yes (each worker is its own thread); currently merged into the parent turn, raw item kept only in `payload.data` (`CodexAdapter.ts:484`).                                                                                                                                      | Protocol yes (`model?` `:18824`); not extracted.                            | Protocol yes (`sendInput`/`resumeAgent` to `receiverThreadIds`); not wired in t3code.                                                          |

Canonical gap underneath all three: `TaskStartedPayload`/`TaskProgressPayload`/
`TaskCompletedPayload` (`packages/contracts/src/providerRuntime.ts:463-485`)
carry no `agentId`/`model`/`parentToolCallId`, and `deriveSubagentCards`
(`apps/web/src/session-logic.ts`) stuffs `taskType` into its `model` slot
because nothing better exists.

### Workstream A: sub-agent panel

**Slice A1: contracts + ingestion carry worker identity.**

- `packages/contracts/src/providerRuntime.ts`: add `Schema.optional` fields to
  the three task payloads. `TaskStartedPayload` gains `agentId`
  (provider-stable worker instance id), `model` (worker model slug when the
  provider knows it), and `parentToolCallId` (the tool call that spawned the
  worker). `TaskProgressPayload` and `TaskCompletedPayload` gain `agentId`.
  All optional and absent-able, exactly like the `goal`/`goalStatus`
  precedent, so no existing fixture changes.
- Codex review catch, MUST land in the same slice: the server-side
  provider-runtime ingestion copies task payload fields through an explicit
  whitelist (currently `taskId`/`taskType`/`description`/`summary`/
  `lastToolName`/`usage`); grep `ProviderRuntimeIngestion` and extend that
  copy with the three new fields, otherwise they are silently dropped before
  they ever reach a stored activity and the panel sees nothing.
- Tests: contracts decode round-trip for the new optional fields; an ingestion
  test proving `agentId`/`model`/`parentToolCallId` survive into the stored
  activity payload.
- FORK.md rows to add on landing: extend the existing `providerRuntime.ts`
  row; add a row for the ingestion file touched.

**Slice A2: Copilot adapter per-worker attribution (biggest visible win).**

- In `CopilotAdapter.ts`, build an `agentId -> toolCallId` correlation map,
  populated at `subagent.started` (the one event carrying both), cleaned up at
  `subagent.completed`/`failed`. This join is mandatory: in-flight SDK events
  are tagged with `agentId` only, while the fork keys `taskId` on
  `toolCallId`; without the map, progress events cannot join their card.
- `subagent.started` -> `task.started` gains `agentId`, `model` (stop dropping
  it), `parentToolCallId: toolCallId`. `description` stays
  `agentDisplayName`, `taskType` stays `agentName`.
- `agentId`-tagged events -> `task.progress` for the mapped `taskId`, coalesced
  STRICTLY at message-completion and tool boundaries: a completed
  `assistant.message` produces one progress entry (summary truncated to a
  short line), `tool.execution_start`/`complete` update `lastToolName` and may
  produce one entry, streaming deltas produce NOTHING. Cadence is a
  correctness constraint, not a polish item: every `task.progress` becomes a
  durable projection row, so per-token emission would be a storage bug.
- `subagent.completed`/`failed` -> `task.completed` gains `agentId` (the
  `durationMs`/`totalTokens`/`totalToolCalls` usage mapping already exists).
- Events tagged with an unknown `agentId` (no `subagent.started` seen, e.g.
  after a resume) are ignored for task purposes, never crash the mapping.
- Tests: fixtures with `agentId`-tagged assistant/tool events proving
  correlation, cadence (deltas emit no progress), model passthrough, and
  unknown-agentId tolerance.

**Slice A3: panel upgrade to worker tabs.**

- `apps/web/src/session-logic.ts` `deriveSubagentCards`: read the real
  `payload.model` into the card's `model`, move `taskType` to a new `kind`
  field (UI falls back to showing `kind` when `model` is absent, which is the
  Claude case), and carry `agentId`.
- `SubagentsPanel.tsx`: add a worker tab strip inside the existing singleton
  surface (Codex-desktop look). Selected worker view: header with name, model
  (or kind), status icon, elapsed time; below it a scrolling, auto-following
  stream of that worker's progress entries. No selection shows the existing
  card list. Pure helpers (tab derivation, selection state) exported and
  unit-tested.
- Explicitly NO `rightPanelStore` changes in this slice. Codex review
  concurred: parameterized per-worker surfaces only pay off once steering and
  per-worker composer state exist (slice A6); until then the tab strip inside
  the singleton is strictly simpler.
- Mobile: unchanged (event-feed parity only, per the existing rule).

After A3 the Copilot experience matches the Codex-desktop screenshot minus the
composer. Ship and evaluate before continuing.

**Slice A4: Codex adapter emits task.\* from collab items.**

- Map `collab_agent_tool_call` item lifecycle into `task.*`: a `spawnAgent`
  item produces `task.started` per receiver (worker identity =
  `receiverThreadId`, with the collab item `id` kept in the payload as a
  fallback reference; Codex review could not confirm receiver ids survive a
  resume, so the fallback is documented, not optional), `model` from the item,
  `description` from prompt/tool. `agentsStates` transitions produce
  `task.progress`; terminal item status / `closeAgent` / `review_exited`
  produce `task.completed`. Review workers (`review_entered`/`review_exited`,
  `subAgentReview` thread source) get the same treatment.
- The existing `item.*` emission stays untouched (chat timeline fallback
  unchanged); this slice only ADDS `task.*`.
- Tests from recorded collab/review item fixtures.

**Slice A5: Claude adapter attribution via parent_tool_use_id.**

- Step zero is a correlation check with a live fixture: establish whether the
  CLI's `task_started.task_id` equals the spawning `Task` `tool_use` id. If
  yes, the join is direct; if not, correlate through the first nested event's
  `parent_tool_use_id` after a spawn.
- Stop treating `parent_tool_use_id` as a noise key; nested assistant/tool
  events carrying it produce `task.progress` for the correlated task, with
  the same message-completion/tool-boundary coalescing rule as A2.
- No per-worker model exists for Claude; the panel shows `kind`
  (the subagent `task_type`) instead. No steering.
- Tests from recorded stream-json fixtures.

**Slice A6 (deferred until A1-A5 are proven): steering.**

- A provider capability flag (adapter-declared, e.g.
  `supportsWorkerSteering`) gates the per-worker composer and stop control;
  the UI never renders steering affordances a backend cannot honor.
- Codex first: `sendInput`/`resumeAgent` to `receiverThreadIds` through a new
  fork-owned RPC; design the RPC when this slice starts. Copilot remains
  session-level (steer via the main composer). Claude has no channel.
- This is the old backlog item 8 (side-by-side companion mode) and stays last.

### Workstream B: in-app GitHub device login (no CLI ritual, no VS Code requirement)

Verified constraints (see HANDOFF "GitHub device-code login" for the full SDK
evidence): the SDK bundles the whole runtime, so there is no install step to
remove, only the missing token; the client has no login RPC; the two sanctioned
auth inputs are `CopilotClientOptions.gitHubToken` (env passthrough, priority)
and `useLoggedInUser` (default true; reads a prior `copilot login` store or gh
CLI auth). VS Code's own GitHub session is not readable and the bundled CLI
does not read the legacy `hosts.json`/`apps.json`, so VS Code reuse is
indirect only (devs with gh CLI auth work with zero setup).

**Slice B1: entitlement spike (hard gate for B2/B3).**

- Choose the OAuth client id: the public Copilot device-flow client id that
  editor integrations use, or an org-registered GitHub App. The bundled CLI's
  own id is compiled into its native binary and was not extractable.
- Prove the id end to end manually: `POST https://github.com/login/device/code`
  -> user completes at github.com/login/device -> poll
  `POST https://github.com/login/oauth/access_token`
  (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) -> construct
  `new CopilotClient({ gitHubToken })` and require `getAuthStatus()` to report
  authenticated. Codex review emphasis: flow completion alone proves nothing;
  a token can pass GitHub auth and still fail Copilot entitlement or org SSO
  checks, so `getAuthStatus()` is the acceptance test.
- Output: the chosen client id and a written entitlement proof. B2/B3 do not
  start until this passes.

**Slice B2: server module, RPCs, driver injection.**

- New fork-owned `apps/server/src/provider/copilot/GithubDeviceLogin.ts`:
  - `start`: requests the device code, returns
    `{ flowId, userCode, verificationUri, expiresInSeconds, intervalSeconds }`.
  - A background Effect poll fiber per flow honoring `authorization_pending`
    (keep polling at `interval`), `slow_down` (increase the interval per RFC
    8628), `expired_token` (terminal: expired), `access_denied` (terminal:
    denied); supports cancellation; one active flow per environment.
  - On success, persists the token via the existing
    `apps/server/src/auth/ServerSecretStore.ts` (confirmed present; already
    holds relay/cloud creds and the env signing keypair) under a per-environment
    key such as `copilot.githubToken`. NO settings.json fallback (Codex review:
    do not add one unless the store demonstrably fails on a target runtime).
  - Status is exposed by `flowId`: `pending | success | expired | denied |
error`, never the token.
- RPC registration, exactly the `testManagedClientEvidenceConnection` pattern:
  `packages/contracts/src/rpc.ts` (WS_METHODS entries, `Rpc.make` blocks,
  `WsRpcGroup` registration) for `copilotDeviceLoginStart` and
  `copilotDeviceLoginStatus` (plus `copilotSignOut` deleting the secret);
  `packages/contracts/src/server.ts` result schemas (code/URI/status only,
  never the token); `apps/server/src/ws.ts` operate-scope handlers delegating
  to the fork-owned module; `packages/client-runtime/src/state/server.ts`
  command atoms.
- `CopilotDriver.ts`: at client construction, read the stored token; when
  present pass `gitHubToken`; when absent change nothing (the
  `useLoggedInUser` default keeps gh CLI auth and prior `copilot login`
  working with zero setup). After a successful login or sign-out, restart the
  provider client through the existing provider refresh path so the change
  takes effect.
- Tests: mocked-fetch state machine (pending -> slow_down -> success; expiry;
  denied), secret-store round trip, RPC handlers, and an assertion that no
  status payload ever contains the token.

**Slice B3: the sign-in modal.**

- The static Copilot setup row in `ProviderInstanceCard.tsx` (~line 907)
  gains a "Sign in with GitHub" button opening a dialog: the user code large
  and copyable, an "Open github.com/login/device" button, live status from
  polling the status RPC at `intervalSeconds`, an expiry countdown with a
  retry action, and distinct denied/error states. Success triggers the
  existing provider refresh so `getAuthStatus()` confirms (shows `login` and
  auth type). A sign-out affordance calls `copilotSignOut` and refreshes.
  The token is never rendered anywhere.
- Pure status-mapping helpers exported and unit-tested, matching the
  fork's pure-helper convention for every new component.

### Order, delegation, verification

- Commit sequence: A1 -> A2 -> A3 (Copilot end to end, evaluate), then A4,
  A5, then B2 -> B3 (B1 is a manual spike and can run in parallel with the
  A slices), A6 last and only after A1-A5 prove out.
- Every slice is one logical commit; FORK.md rows land in the same commit as
  the shared-file edits they describe; typecheck + targeted suites per slice;
  full `vp test` before each workstream's final commit.
- Execution per the orchestration workflow: adapter/server shaping first-hand,
  mechanical test scaffolding and fixtures delegated (Codex, fast-worker).

### Codex review notes incorporated (2026-07-04)

- A1 was underspecified without the ingestion whitelist extension; fixed above.
- The `agentId -> toolCallId` join in A2 is mandatory, not an optimization.
- `task.progress` cadence is a storage-correctness constraint (durable
  projection rows), fine at message/tool boundaries, a bug per token.
- Tab strip inside the existing singleton beats parameterized per-worker
  surfaces until steering state exists.
- Codex `receiverThreadId` stability across resume is unverified; keep the
  collab item id as fallback identity.
- B1 must prove entitlement via `getAuthStatus()`, not flow completion.
- Use `ServerSecretStore` outright; no hidden-settings token fallback.

## Rebase-resilience notes

- Every genuinely new capability (driver internals) lives in
  `apps/server/src/provider/copilot/` — a directory upstream will never
  create, so it can never conflict.
- Every upstream file touched follows the same "one import + one
  registration entry" shape that upstream itself uses when it adds a new
  built-in provider — a future upstream PR adding, say, a Gemini driver
  will touch the _same_ handful of files in the _same_ mechanical way,
  which is the best case for a rebase (small, line-level conflicts you can
  resolve by keeping both entries, not a structural one).
- `ProviderService.ts` and orchestration ingestion were deliberately left
  untouched by this task (a governance forwarder lands there separately).
- Run `scripts/rebase-upstream.sh` for the actual rebase; it fetches
  upstream, picks the latest non-nightly release tag (falling back to
  `upstream/main`), rebases, and cross-references any conflicting files
  against the table above.
