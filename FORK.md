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

| Path                                                        | What it is                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/copilot/CopilotDriver.ts`         | `ProviderDriver` implementation. Owns the one `CopilotClient` per provider instance: constructs it, calls `client.start()`, registers `client.stop()` as a finalizer, wires the adapter/snapshot/textGeneration closures.                                                                                                                                                                                            |
| `apps/server/src/provider/copilot/CopilotAdapter.ts`        | `ProviderAdapterShape` implementation. Per-thread `CopilotSession` lifecycle, hidden `customAgents`/active-agent/fleet-mode wiring, event mapping (`assistant.message[_delta]`, `assistant.reasoning[_delta]`, `tool.execution_start/complete`, `subagent.*`, `session.idle` → `turn.completed`), `onPermissionRequest`/`onUserInputRequest` bridged into the same `Deferred`-based approval flow Claude/Cursor use. |
| `apps/server/src/provider/copilot/CopilotProvider.ts`       | Status probing (`client.getStatus()` / `client.getAuthStatus()`) and the built-in model catalog.                                                                                                                                                                                                                                                                                                                     |
| `apps/server/src/provider/copilot/CopilotMcpServers.ts`     | Fork-owned Copilot MCP settings resolver. Converts hidden provider settings into SDK `mcpServers` config and injects the configured AI-Orch MCP gateway when managed-client evidence settings are enabled.                                                                                                                                                                                                           |
| `apps/server/src/provider/copilot/ManagedClientEvidence.ts` | Pure managed-client evidence mapper for the Copilot lane. Converts selected provider runtime/domain events into AI-Orch `/v1/managed-client/evidence` payloads, hashes transcript content, sanitizes repo remotes, and caps batches at the endpoint limit.                                                                                                                                                           |
| `apps/server/src/provider/copilot/CopilotTextGeneration.ts` | Commit/PR/branch/title generation via short-lived Copilot sessions. No native structured-output flag in the SDK, so this follows the Grok/Cursor pattern: ask for JSON in the prompt, decode with `extractJsonObject` + `Schema.decodeEffect`.                                                                                                                                                                       |
| `apps/server/src/provider/copilot/CopilotEnvironment.ts`    | `baseDirectory` (`COPILOT_HOME`-equivalent) resolution + continuation-group-key helper. Mirrors `Drivers/ClaudeHome.ts`.                                                                                                                                                                                                                                                                                             |
| `apps/server/src/provider/copilot/*.test.ts`                | Unit tests for all of the above. Mock the SDK client (`createSession`/`resumeSession`/`getStatus`/`getAuthStatus`); never spawn the real CLI or hit the network.                                                                                                                                                                                                                                                     |
| `scripts/rebase-upstream.sh`                                | This fork's rebase helper (see file for usage).                                                                                                                                                                                                                                                                                                                                                                      |
| `FORK.md`                                                   | This file.                                                                                                                                                                                                                                                                                                                                                                                                           |

## Upstream files touched

| File                                                              | Nature of edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/package.json`                                        | One dependency line added: `"@github/copilot-sdk"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Pulls in the official Copilot SDK the driver wraps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm-lock.yaml`                                                  | Lockfile update from the dependency add: one new `@github/copilot-sdk` entry plus its actual transitive graph (the `@github/copilot` platform binaries, `vscode-jsonrpc`).                                                                                                                                                                                                                                                                                                                                                                                                                                              | Mechanical, but regenerate with `pnpm install --lockfile-only`, not a plain `pnpm install` — on this repo's pnpm/Node combination, a full install also re-resolves the `apps/mobile` peer graph and produces hundreds of lines of unrelated churn. After regenerating, confirm with `git diff pnpm-lock.yaml` that the change stays scoped to the Copilot SDK before committing.                                                                                                                                                                                                                                                     |
| `apps/server/src/provider/builtInDrivers.ts`                      | One import + one array entry (`CopilotDriver`) + one union member (`CopilotDriverEnv`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Registers the new driver the same way every built-in driver is registered — see the file's own docstring for the "1. implement, 2. add to array, 3. satisfy R" recipe this follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/contracts/src/settings.ts`                              | (a) New `CopilotSettings` / `CopilotSettingsPatch` schema blocks, structured identically to the existing `ClaudeSettings` block. (b) One line each registering `githubCopilot` in `ServerSettings.providers` and `ServerSettingsPatch.providers`. (c) Two one-word default flips: `GrokSettings.enabled` and `OpenCodeSettings.enabled` decoding default changed from `true` to `false`. (d) Hidden `CopilotSettings.mcpServers`, `customAgents`, `defaultAgent`, `activeAgent`, `fleetMode`, and `managedClientEvidence` schemas mirroring the Copilot SDK session config/RPC features plus AI-Orch evidence settings. | (a)/(b) follow the exact pattern every other provider (Codex/Claude/Cursor/Grok/OpenCode) already uses in this file — there is no lighter-weight way to add a provider's settings schema upstream already established. (c) is the explicit default-visibility requirement: Claude and GitHub Copilot ship enabled out of the box, Cursor (already disabled upstream)/Grok/OpenCode ship disabled. (d) lets Copilot sessions receive explicit MCP servers and custom-agent/fleet settings because the SDK does not inherit a usable T3 UI-level config automatically, and gives the future evidence forwarder a hidden settings home. |
| `packages/contracts/src/providerRuntime.ts`                       | One raw event source literal added: `"copilot.sdk.session-event"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Lets fork-owned Copilot adapter events preserve governance-grade SDK payloads for the later AI-Orch evidence forwarder without widening canonical event payloads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/contracts/src/model.ts`                                 | One `const COPILOT_DRIVER_KIND` + one entry each in `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES_BY_PROVIDER`, `PROVIDER_DISPLAY_NAMES`.                                                                                                                                                                                                                                                                                                                                                                                                                           | Same per-provider registration pattern every existing driver kind uses in this file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/settings/providerDriverMeta.ts`          | Two import additions (`CopilotSettings`, `GithubCopilotIcon`) + one new entry in `PROVIDER_CLIENT_DEFINITIONS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Makes Copilot a normal, live provider option in the settings UI — this array is what drives the whole settings panel generically (see `SettingsPanels.tsx`, which needed no edit at all because it's already generic over `DRIVER_OPTIONS`).                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/components/settings/AddProviderInstanceDialog.tsx`  | Removed the `githubCopilot` entry from `COMING_SOON_DRIVER_OPTIONS` (and the now-unused `GithubCopilotIcon` import from this file — it moved to `providerDriverMeta.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                               | Copilot was already scaffolded here as a disabled "Coming Soon" stub before this task; it's now a real option via `DRIVER_OPTIONS`, so the stub entry is redundant and would show Copilot twice.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/components/settings/ProviderInstanceCard.tsx`       | Adds a compact Copilot-only setup row inside the existing provider instance details.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Reuses the generic provider refresh path to verify Copilot auth, entitlement, and model discovery without adding a wizard or a second provider status surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/src/components/settings/SettingsPanels.tsx`             | Passes the existing provider refresh action/state into provider cards as a verify affordance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Keeps Copilot onboarding inside the existing Providers settings section and avoids a new RPC for the already-supported status probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/CommandPalette.tsx`                      | Adds root actions for opening the current thread's Terminal and Diff surfaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Makes existing workbench surfaces discoverable from the command palette before adding new slash-command plumbing or UI chrome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/src/composer-logic.ts`                                  | Extends the built-in composer slash-command union with `terminal` and `diff` while keeping standalone submit parsing limited to `/plan` and `/default`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Allows action-only slash commands in the composer menu without changing prompt submit behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/components/chat/ChatComposer.tsx`                   | Adds `/terminal` and `/diff` to the built-in slash-command menu and routes selections into the existing terminal/right-panel stores.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Makes existing workbench surfaces reachable from the composer command flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/components/chat/composerSlashCommandSearch.test.ts` | Adds regression coverage for searching the new `/terminal` and `/diff` built-ins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keeps command-menu discoverability pinned as more fork commands are added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/session-logic.ts`                                   | Includes `task.started` in the existing work log and gives started/progress task rows the in-progress tone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Makes Copilot SDK `subagent.started` events visible through the existing timeline without adding a fork-only UI surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/mobile/src/lib/threadActivity.ts`                           | Same `task.started` work-log inclusion and in-progress tone as web.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Keeps mobile feed behavior aligned with the web timeline for Copilot subagent lifecycle events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/provider/Layers/GrokProvider.test.ts`            | Updated one pre-existing test ("returns a pending snapshot by default") to assert the new disabled-by-default behavior, and added a sibling test for the explicitly-enabled case.                                                                                                                                                                                                                                                                                                                                                                                                                                       | The old test encoded the exact default this task changed; it wasn't testing something we broke, it was testing the old default value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts`        | One array literal updated: inserted `"githubCopilot"` into the expected sorted list of registered provider instance ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | This test asserts the full set of built-in driver instance ids; adding a driver means the list grows by one, alphabetically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/server/src/serverSettings.test.ts`                          | One assertion updated: an OpenCode settings-patch test now expects `enabled: false` (was `true`) because the patch under test never sets `enabled`, so the new default now flows through.                                                                                                                                                                                                                                                                                                                                                                                                                               | Same category as the `GrokProvider.test.ts` change — a test that encoded the old default value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

1. **Workspace rail and terminal discoverability.** Start here because it uses
   existing state and surfaces, gives immediate product lift, and avoids
   backend dependency. Add a compact rail near the thread header/composer with
   active provider/model, terminal toggle/running state, git/diff entry, and
   placeholder slots for goal/Fleet/governance when those states exist.
2. **Slash-command and command-palette routing.** Add `/terminal`, `/git`,
   `/diff`, `/model`, `/fleet`, `/agent`, and `/handoff` entries that mostly
   open existing surfaces. This makes the app feel Codex-like without building
   new workflows yet.
3. **Subagents right-panel surface.** Group existing `subagent.*`/task events
   into worker cards using the current work-log data. Show worker name/model,
   latest status, progress entries, and inspect/open affordances. Keep the
   generic timeline rows as fallback.
4. **Fleet Mode and Copilot agent controls.** Once the command routing exists,
   add the smallest UI for `fleetMode` and active/custom agent selection. Use a
   selector/toggle; defer full custom-agent editing and org marketplace ideas.
5. **Goal state.** Add a first-class thread goal only after the command and rail
   patterns are in place. Start with one visible goal string plus active/done
   state; do not build a planning database.
6. **Git/diff adjacency polish.** Tighten branch/diff/review access beside the
   terminal and agent workflow. Reuse existing branch toolbar, diff, and review
   surfaces.
7. **Governance/evidence surface.** Add quiet visibility for MCP attribution,
   permission decisions, and evidence-forwarding state after the server
   forwarder exists. The UI must not claim governance is active before the
   runtime path is wired.
8. **Side-by-side companion-thread mode.** Implement the Codex screenshot-level
   split only after the `Subagents` surface proves useful and the backend can
   support worker steering/composer behavior honestly.

Recommended first slice: items 1 and 2 together. They are the smallest visible
UX improvement, they reuse existing T3 systems, and they make later subagent,
Fleet, goal, and governance work easier to discover.

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
