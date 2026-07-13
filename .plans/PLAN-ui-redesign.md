# Neokod web UI redesign plan

Status: planning only  
Scope: `apps/web`, plus the repository changelog/version metadata required by `AGENTS.md`  
Target: a restrained, native-tooling UI inspired by Synara without importing Synara's state, routes, or product model

## Verdict

This is safe to build as five cumulative, independently shippable stages. Neokod already has the hard part of the requested right-side experience: `RightPanelTabs.tsx`, `rightPanelStore.ts`, and `ChatView.tsx` already host Browser, Terminal, Diff, Files, Plan, and Subagents in one resizable tabbed panel. That stage is a chrome cleanup, not a panel rewrite.

The sidebar is the only stage that adds UI behavior. Its authoritative project/thread data must continue to come from the effect-atom selectors in `apps/web/src/state/entities.ts`; only the selected sidebar view and scoped pinned-thread keys belong in the existing persisted `uiStateStore.ts` UI layer.

## Boundaries that do not move

- Keep the TanStack route contract and route file intact: `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` remains `createFileRoute("/_chat/$environmentId/$threadId")`, and navigation continues through `threadRoutes.ts` helpers.
- Keep `useProjects()`, `useThreadShells()`, `useThreadShell()`, and other effect-atom selectors authoritative. Do not copy Synara's Zustand entity store or React Query layer.
- Keep server orchestration, contracts, session handling, terminal resources, preview resources, and diff resources unchanged.
- Keep `ActivityNotificationCoordinator` mounted unconditionally in `apps/web/src/routes/__root.tsx`. The visual shell must not move or conditionally mount it.
- Keep `MissionControlHost`, provider-update notifications, both toast providers, event routing, and slow-RPC coordination mounted where they are.
- Preserve light, dark, and system behavior in `hooks/useTheme.ts`, including Electron theme synchronization and browser `theme-color` updates.
- Preserve every existing right-panel kind. The visual target emphasizes Diff/Terminal/Browser, but Files, Plan, and Subagents must receive the same chrome and remain reachable.
- Do not edit `.repos/` or the Synara scratchpad. They are references only.
- Avoid information-architecture, server, schema, or route changes beyond the local sidebar presentation/pinning preference described below.

## Grounded comparison

### Theme and tokens

Neokod today:

- `apps/web/src/index.css` has a Tailwind v4 `@theme inline` bridge and the conventional shadcn variables (`--background`, `--card`, `--muted`, `--accent`, `--border`, state colors), but shell surfaces and text tiers are mostly expressed through repeated opacity utilities.
- Light mode is predominantly white with `#339cff`; dark mode is predominantly `#181818`. `--app-chrome-background` is the only shell-specific surface alias.
- `apps/web/src/hooks/useTheme.ts` already correctly owns `light | dark | system`, storage, media-query changes, Electron bridge updates, transition suppression, and browser chrome color. It does not need to become a theme-pack runtime.
- `apps/web/src/main.tsx` loads bundled DM Sans and JetBrains Mono. These produce deterministic desktop builds and should stay.

Synara reference:

- `theme/theme.logic.ts` derives a large Codex-style graph of `--color-background-*`, `--color-text-*`, border, button, diff, terminal, and font variables, then aliases those back to shadcn/Tailwind tokens in `buildThemeCssVariables()`.
- `index.css` exposes sidebar tokens through Tailwind, uses one `--app-surface-divider` for related chrome lines, and defines explicit UI/density/font variables.
- `hooks/useTheme.ts` writes the generated variables inline, while `ThemePackEditor.tsx` edits surface, ink, accent, semantic colors, contrast, and fonts with import/export support.
- The useful idea is semantic roles with stable aliases. The 1,374-line theme derivation engine and 682-line editor are not required for this redesign.

Translation for Neokod:

- Add a compact static semantic layer in `index.css`, then alias the current shadcn variables to it so existing components improve without a mass rewrite.
- Keep the current theme hook and bundled fonts. Do not add runtime token generation, import/export, contrast sliders, or user-authored theme packs.

### Sidebar

Neokod today:

- `components/AppSidebarLayout.tsx` owns the resizable 16rem/off-canvas shell, desktop traffic-light inset, keyboard toggle, and minimum main-content width.
- `components/Sidebar.tsx` reads `useProjects()` and `useThreadShells()`, constructs cross-environment logical project groups, and renders one nested Projects tree. It already preserves thread keyboard jumps, multi-select, inline rename, archive/delete, unread/status/PR/terminal indicators, project drag ordering, grouping, and preview limits.
- `components/Sidebar.logic.ts` contains the existing pure ordering/status helpers and is the correct home for new pinned/recent derivation.
- `uiStateStore.ts` already persists UI-only project expansion/order and scoped thread visit state. It is the right owner for a selected sidebar view and scoped pinned-thread keys; provider/server state is not.
- The generic sidebar primitive already provides 28px `sm` rows, but `Sidebar.tsx` mixes uppercase 10px headings, 12px rows, larger default primitive styles, and repeated muted-opacity choices.

Synara reference:

- `components/Sidebar.tsx` places a compact segmented picker above the content, then mounts a keyed view surface.
- Its Threads surface starts with a dedicated Pinned block, followed by a clear section header and dense rows. Pin/unpin is available from the row action/context-menu flow.
- `sidebarRowStyles.ts` centralizes a 1.75rem row height, 12px UI labels, 11px secondary labels, 0.5rem gaps, and subdued inactive/section tones.
- `index.css` supplies the recessed segmented track and raised selected thumb. The underlying entity data remains Synara-specific and must not be copied.

Translation for Neokod:

- Use two tabs: **Threads** and **Workspace**.
- Threads is a flat cross-project working set: Pinned first, then unpinned active threads sorted by the user's existing thread sort preference. Each flat row retains its project/environment context and all existing thread actions.
- Workspace is the current Projects hierarchy, unchanged in behavior: logical grouping, expansion, drag order, per-project thread previews, project settings, and add/new actions remain here.
- “Workspace” is only the label for the existing project/worktree browser. Do not create Synara-style workspace pages, a `workspaceStore`, routes, or terminal-workspace entities.

### Right panel

Neokod today:

- `rightPanelStore.ts` already persists per-scoped-thread tab order, active surface, visibility, Browser preview ids, terminal groups, file tabs, and singleton Diff/Plan/Subagents/Files surfaces.
- `components/RightPanelTabs.tsx` already renders a single resizable panel with closable tabs, middle-click/context-menu closing, add menu, active-tab scrolling, desktop title-bar ownership, mobile sheet support, and resource-aware Browser/Terminal labels.
- `components/ChatView.tsx` lazily renders the active panel and deliberately keeps terminal resources mounted. It also retains the existing bottom terminal drawer independently.
- `DiffPanelShell.tsx`, `preview/PreviewPanelShell.tsx`, and panel-mode `ThreadTerminalDrawer.tsx` own pane-local headers and borders that currently do not share one exact visual rhythm.

Synara reference:

- `components/chat/RightDock.tsx` uses a 46px shared chrome row, one divider token, flat `SurfaceTabChip` controls, a compact add menu, collapse control, and a single resizable right edge.
- `chat/chatHeaderControls.tsx` centralizes the 28px chip/icon footprints and active/hover tones.
- Synara's `rightDockStore` and route-level pane renderer solve the same visual problem with different resource/state mechanics. They are not needed in Neokod.

Translation for Neokod:

- Restyle `RightPanelTabs` and pane-local subheaders around shared height/divider/control tokens.
- Do not replace `rightPanelStore`, change surface ids, remount terminals/previews, or port `RightDock.tsx`.

### Typography and density

Neokod today:

- The global UI family is bundled DM Sans; code and terminal surfaces use bundled JetBrains Mono.
- The main workspace header is 52px. The transcript and markdown body are generally Tailwind `text-sm`/14px with `leading-relaxed`; panel tabs are also `text-sm`.
- Conversation content is constrained to `max-w-3xl`, while composer and timeline spacing are spread across `ChatView.tsx`, `MessagesTimeline.tsx`, `ChatMarkdown.tsx`, and `chat/ChatComposer.tsx`.

Synara reference:

- The default chrome scale is 12px UI, 11px small UI, 10px metadata, 12px chat, and 28px sidebar rows, with a 46px surface header.
- `useAppTypography.ts` and `useAppDensity.ts` expose many user-configurable variables. The visible cleanliness comes from consistent roles, not from the settings machinery itself.

Translation for Neokod:

- Add a small fixed type/density scale in Stage 1, then consume it in shell and conversation stages.
- Keep DM Sans and JetBrains Mono. Do not add Synara's declared-but-unimported Inter package or build a font/density settings UI.

## Stage 1 — Semantic design-token foundation

### Objective

Create a calm light/dark semantic token layer that existing Tailwind classes can consume immediately, without changing `useTheme` ownership or adding dependencies.

### Current-state findings

- `index.css` already has the correct Tailwind v4 alias seam, but most roles stop at generic shadcn variables and repeated opacity utilities.
- `useTheme.ts` already handles preference persistence, system changes, browser chrome, transition suppression, and Electron synchronization; replacing it would add risk without helping the requested default look.
- Sidebar utilities reference `--color-sidebar-*` roles that are not explicitly bridged alongside the other colors in the current `@theme inline` block.

### Design

Define these roles in `:root`, with dark counterparts under the existing `@variant dark` block:

- Surfaces: `--surface-canvas`, `--surface-sidebar`, `--surface-panel`, `--surface-elevated`, `--surface-control`, `--surface-hover`, `--surface-selected`.
- Text: `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-inverse`.
- Lines/focus: `--line-subtle`, `--line-default`, `--line-strong`, `--focus-ring`, `--surface-divider`.
- Brand/state: `--brand`, `--brand-foreground`, and the existing info/success/warning/destructive pairs.
- Density/type: `--font-size-ui` (12px), `--font-size-ui-sm` (11px), `--font-size-meta` (10px), `--font-size-chat` (13px), `--line-height-chat` (1.55), `--row-height-compact` (1.75rem), and `--surface-header-height` (46px).

Use near-neutral surfaces with small luminance steps. Keep blue for focus, links, and primary actions rather than general selection backgrounds. Preserve meaningful state colors, but render passive metadata through text/surface roles instead of ad hoc blue/amber/green.

Alias the existing variables rather than removing them:

- `--background` -> canvas, `--card` -> panel, `--popover` -> elevated.
- `--foreground`/`--card-foreground` -> primary text; `--muted-foreground` -> secondary text.
- `--secondary`/`--muted` -> control; `--accent` -> hover; selected rows get the explicit selected surface.
- `--border` -> default line; `--input` -> strong/control line; `--ring` -> focus.
- Add the missing Tailwind v4 sidebar mappings (`--color-sidebar`, `--color-sidebar-foreground`, `--color-sidebar-accent`, `--color-sidebar-accent-foreground`, `--color-sidebar-border`, `--color-sidebar-ring`).
- Make `.surface-subheader`, the workspace header, sidebar surface, and right-panel seam read from the semantic variables.

The default palette should be recorded as literal light/dark values in one block, not computed in TypeScript. Use `color-mix()` only for translucent hover/selected variants where the source role remains obvious.

### Tasks and exact files

1. Edit `apps/web/src/index.css`:
   - Add the semantic roles and dark values.
   - Wire them through `@theme inline` and the existing shadcn aliases.
   - Replace `--app-chrome-background` and divider/scrollbar/diff bridges with semantic sources where applicable.
   - Add the fixed type/density variables, but do not apply the final density pass yet.
2. Edit `apps/web/src/hooks/useTheme.test.ts` only if assertions currently depend on literal old canvas colors; retain all behavioral tests for storage/system/Electron/browser-chrome sync.
3. Start the cumulative `2.1.0` changelog entry in `CHANGELOG.md` and classify the redesign as Minor because the later sidebar stage adds backward-compatible pinned/tab behavior.
4. Update the repository's synchronized canonical version files to `2.1.0`: `apps/web/package.json`, `apps/server/package.json`, `apps/desktop/package.json`, and `packages/contracts/package.json`. Later stages append bullets to the same changelog entry rather than bumping again.

### Dependencies

None. In particular, do not add `react-colorful` or `tw-animate-css`.

### Acceptance criteria

- Light, dark, and system themes still switch without a transition flash.
- Browser theme color and Electron theme preference continue to follow the resolved canvas.
- Existing buttons, cards, popovers, sidebar rows, composer, diff, terminal, and preview remain readable before later component-specific passes.
- Focus rings and state colors retain their meaning; normal selected/hovered chrome is neutral.
- Text and non-text contrast meet WCAG AA where applicable; focus and control boundaries remain visible in both themes.
- No route, atom, store, notification, orchestration, or resource-lifecycle code changes.

### Verification

- `vp test run --project unit apps/web/src/hooks/useTheme.test.ts`
- `vp check`
- `vp run typecheck`
- Run `vp dev`; inspect the root shell, settings, a populated conversation, Diff, Terminal, and Browser in light/dark/system at 1440px and 1024px widths.
- In Electron, verify the title bar/traffic-light area and browser chrome color match the shell after a live theme switch.

### Risks and containment

- `index.css` is global, so a bad alias can affect settings and dialogs. Keep old public variable names as aliases and compare representative surfaces before component edits.
- The current `#339cff` white-on-blue primary pairing is weak for small controls. Choose the brand/foreground pair together and test it; do not preserve a failing pair for visual continuity.
- Avoid Synara's translucent macOS material logic in this stage. It adds platform-specific blur/compositing risk and is not required for the clean hierarchy.

## Stage 2 — Sidebar Threads / Workspace split and Pinned section

### Objective

Introduce the requested sidebar hierarchy using Neokod's existing effect-atom data and UI preference store, while preserving every existing project/thread action and route.

### Current-state findings

- `Sidebar.tsx` already obtains all live entities through `useProjects()` and `useThreadShells()` and scopes identities with `scopedThreadKey()`/`scopeThreadRef()`.
- The existing flat `SidebarThreadRow` contains status, unread, PR, terminal, rename, selection, archive, context-menu, and navigation behavior. A second simplified row would drift and is not acceptable.
- Thread context actions currently live inside `SidebarProjectItem`; they need to be shared by the project tree and flat Threads view rather than duplicated.
- `uiStateStore.ts` persists UI-only state and already uses scoped thread keys for visit markers.

### Design

- Add an accessible two-option segmented tablist directly below `SidebarChromeHeader`: Threads and Workspace. Use buttons with `role="tab"`, `aria-selected`, keyboard Left/Right/Home/End handling, and a neutral selected thumb. CSS transitions must honor reduced motion.
- Default new and legacy installs to Threads. Persist the last selected view in `uiStateStore.ts` so reloads do not surprise the user.
- Persist `pinnedThreadKeys: string[]` in the same UI store. Values are `scopedThreadKey()` results, not raw `ThreadId`, so identical ids in different environments cannot collide.
- Add Pin/Unpin to the existing thread context menu and a hover/focus pin affordance. Pinning only changes local UI preference; it does not mutate an orchestration thread or server contract.
- Threads view:
  - Keep Search and New thread actions.
  - Render Pinned only when at least one live, unarchived pinned shell exists.
  - Render the remaining unarchived shells under Threads using the existing selected sort order and existing row component.
  - Show a compact project label (and environment label where needed) so flat rows remain unambiguous.
  - Keep keyboard jump order equal to visible row order, including pinned rows once and no duplicates.
- Workspace view:
  - Render the existing Projects tree and all current project controls unchanged.
  - Keep add project, sorting, logical grouping, drag ordering, expansion, thread preview counts, and per-project new-thread behavior.
- When a pinned thread is archived/deleted or temporarily absent, omit it from the rendered Pinned section. Do not eagerly prune pins while an environment is disconnected; remove a key on explicit delete/unpin and tolerate a small stale preference entry.

### Tasks and exact files

1. Edit `apps/web/src/uiStateStore.ts`:
   - Extend persisted/UI state with `sidebarView` and `pinnedThreadKeys`.
   - Sanitize legacy/malformed values during `parsePersistedState()`.
   - Add minimal `setSidebarView()` and `togglePinnedThread()` actions.
   - Persist both fields under the existing storage key; no new store or storage namespace.
2. Edit `apps/web/src/uiStateStore.test.ts`:
   - Cover legacy defaults, malformed-value sanitization, scoped pin ordering/deduplication, toggle behavior, and round-trip persistence.
3. Edit `apps/web/src/components/Sidebar.logic.ts`:
   - Add pure helpers that derive live pinned and unpinned flat rows from atom-sourced shells and scoped pinned keys.
   - Reuse `sortThreads`/existing timestamp rules; do not create a second sort model.
   - Add a helper for the visible flat row order used by keyboard jumps/prewarm.
4. Edit `apps/web/src/components/Sidebar.logic.test.ts`:
   - Cover no duplication, archived/missing pinned shells, environment-scoped keys, selected sort order, and visible keyboard order.
5. Edit `apps/web/src/components/Sidebar.tsx`:
   - Add the segmented tablist and two keyed content surfaces.
   - Lift the existing thread row action callbacks just high enough for both views to share `SidebarThreadRow`; do not fork rename/archive/delete/menu logic.
   - Add project/environment context to flat thread rows without triggering detail subscriptions.
   - Keep `useProjects()`/`useThreadShells()` as the only entity sources.
   - Update prewarm/jump derivation to the visible view only.
6. Edit `apps/web/src/components/ui/sidebar.tsx` only for reusable compact row/section styling that cannot be expressed at the feature level; do not change resize/off-canvas behavior.
7. Append the sidebar/pinning bullets to the `2.1.0` entry in `CHANGELOG.md`.

### Dependencies

None. Reuse React, the existing sidebar primitives, `uiStateStore`, and existing context-menu bridge.

### Acceptance criteria

- Threads and Workspace are keyboard- and pointer-operable and persist across reload.
- Pinned shows only live unarchived pinned threads, in stable pin order, with no duplicate in the Threads list.
- Raw thread ids from different environments never collide.
- Threads view is atom-backed and updates when shells arrive/change; it does not subscribe each row to full streaming thread details.
- Workspace retains project grouping, expand/collapse, drag sorting, preview limits, and add/new actions.
- Rename, archive, delete, unread, multi-select, PR, preview/port, context menu, and keyboard jump behavior work from both row locations.
- Navigating still targets `/_chat/$environmentId/$threadId` through the existing route helpers.
- Settings sidebar behavior remains unchanged.
- `ActivityNotificationCoordinator` remains mounted in `__root.tsx` and notification clicks still open the intended scoped thread.

### Verification

- `vp test run --project unit apps/web/src/components/Sidebar.logic.test.ts apps/web/src/uiStateStore.test.ts apps/web/src/components/ui/sidebar.test.tsx`
- `vp check`
- `vp run typecheck`
- Visual/manual matrix in `vp dev`:
  - Empty, one-project, many-project, grouped cross-environment, archived-thread, and disconnected-environment states.
  - Pin/unpin, reload persistence, delete a pinned thread, and switch routes while each tab is selected.
  - Keyboard tab switching, thread jumps, multi-select, rename, context menus, focus rings, and mobile off-canvas sidebar.
  - Confirm pinned/running/attention/unread rows remain distinguishable without relying on color alone.

### Risks and containment

- `Sidebar.tsx` is large and behavior-dense. Reuse `SidebarThreadRow` and move existing callbacks; do not create a second row implementation.
- A flat list can cause more row subscriptions than collapsed project previews. Keep the user's existing preview count as a cap for the unpinned Threads section, add the existing show-more affordance, and only prewarm the existing bounded limit.
- Persisting raw ids would cross environments. Scoped keys are mandatory and covered by tests.
- Do not copy Synara's optimistic server pin mutation or `isPinned` entity fields; Neokod pinning is intentionally local UI metadata.

## Stage 3 — Unified right-panel chrome

### Objective

Make the existing right panel read as one coherent Diff/Terminal/Browser workspace with compact, consistent tabs, headers, dividers, and controls.

### Current-state findings

- `RightPanelTabs.tsx` is already the unified shell. Rebuilding it from Synara would regress Neokod's per-thread persistence, browser-resource reconciliation, terminal grouping, file tabs, plan/subagent surfaces, mobile sheet, and context-menu behavior.
- The top bar uses the 52px workspace height and 14px tab labels; pane-local headers use `surface-subheader` (40px) or hardcoded 52px, so the visual rhythm varies.
- `PreviewPanelShell.tsx` already owns resize persistence and the maximized state. `DiffPanelShell.tsx` and panel-mode `ThreadTerminalDrawer.tsx` already support embedded use.

### Design

- Use the Stage 1 `--surface-header-height` (46px) and `--surface-divider` for the right-panel tab bar and related pane-local headers.
- Render tabs as flat 28px chips with 11px labels, 14px icons, neutral hover, and neutral selected fill. Preserve pending-file indication and show close affordance on hover/focus.
- Keep one add button/menu at the trailing edge and keep all availability/disabled reasons.
- Keep the existing collapse/maximize/layout controls and Electron window-control gutter.
- Use the same horizontal padding, icon-button footprint, text tiers, and divider token in Diff header, Browser chrome, Files header, Plan/Subagents headers, and terminal panel controls.
- Keep resource content edge-to-edge; use a single outer left divider and avoid nested panel borders/shadows.
- Do not add animation beyond existing color/opacity transitions. Respect reduced motion.

### Tasks and exact files

1. Edit `apps/web/src/components/RightPanelTabs.tsx`:
   - Apply the compact shared tab/header roles.
   - Preserve all activation, close, middle-click, context-menu, active-tab scroll, add-menu, mobile, title-bar, and empty-state behavior.
   - Add explicit tablist/tab semantics if absent without changing state ownership.
2. Edit `apps/web/src/components/preview/PreviewPanelShell.tsx`:
   - Point the outer seam/background at semantic panel/divider tokens.
   - Preserve resize bounds, stored width, maximized behavior, and drag handle.
3. Edit `apps/web/src/components/DiffPanelShell.tsx`:
   - Remove the hardcoded 52px/header-border divergence and use the shared header/divider roles for embedded and standalone modes.
4. Edit `apps/web/src/components/ThreadTerminalDrawer.tsx`:
   - In `mode="panel"` only, align toolbar/button/border chrome with the shared right-panel roles.
   - Leave drawer sizing, xterm lifecycle, split behavior, history, focus, and terminal session ownership unchanged.
5. Edit these pane-local visual owners only where needed to eliminate mismatched headers: `apps/web/src/components/preview/PreviewChromeRow.tsx`, `apps/web/src/components/files/FilePreviewPanel.tsx`, `apps/web/src/components/PlanSidebar.tsx`, and `apps/web/src/components/SubagentsPanel.tsx`.
6. Edit `apps/web/src/index.css` for the shared panel tab/header component classes and divider mapping.
7. Append the right-panel chrome bullet to the `2.1.0` entry in `CHANGELOG.md`.

Do not edit `rightPanelStore.ts` or `ChatView.tsx` unless a visual wrapper class cannot be passed through the existing component boundary. Any such exception must be class-only and must not change selectors, surface order, mounting, effects, or callbacks.

### Dependencies

None. Do not port Synara's `RightDock.tsx`, `rightDockStore`, icon library, or pane-activation layer.

### Acceptance criteria

- Browser, Terminal, Diff, Files, Plan, Subagents, and file tabs share one compact chrome system.
- Switching tabs does not recreate browser sessions or terminal sessions; background terminals remain mounted exactly as before.
- Tab order, active surface, close/close-others/close-right/close-all, middle-click, pending-file indicator, add menu, and persisted width still work.
- Browser remains correctly disabled outside supported desktop runtime; Diff/Files retain their repository/workspace gates.
- Inline, maximized, and mobile sheet variants render without double borders or title-bar collisions.
- Terminal drawer mode below chat remains visually and behaviorally unchanged except where it deliberately consumes global semantic colors.

### Verification

- `vp test run --project unit apps/web/src/rightPanelStore.test.ts apps/web/src/components/ThreadTerminalDrawer.test.ts apps/web/src/components/preview/previewViewportReadiness.test.ts`
- `vp check`
- `vp run typecheck`
- Visual/manual matrix in `vp dev` and Electron:
  - Open Diff, multiple terminals, multiple browser tabs, Files/file, Plan, and Subagents; switch, reorder where supported, close, and reopen.
  - Resize, maximize/restore, collapse/reopen, and reload a thread with persisted surfaces.
  - Verify active/inactive/pending/focus states in light/dark and at 1024px/1440px; verify mobile sheet separately.
  - Run terminal output and browser navigation while each surface is backgrounded, then return and confirm continuity.

### Risks and containment

- Terminal/browser remounts are a correctness regression, not a visual bug. Avoid render/state changes and explicitly test continuity.
- Electron title-bar geometry uses WCO variables. Keep current gutter calculations and validate macOS/Windows chrome before changing padding.
- Pane-local components have standalone/sidebar modes. Scope compact right-panel overrides to embedded/panel modes where necessary.

## Stage 4 — Shell typography and spacing

### Objective

Apply the fixed Stage 1 type/density roles to the sidebar, workspace header, and shell controls so the app feels tighter before touching the conversation hot path.

### Current-state findings

- `index.css` and `main.tsx` already provide deterministic DM Sans/JetBrains Mono families, so the inconsistency is scale, weight, spacing, and color hierarchy rather than missing fonts.
- The workspace header is 52px, while sidebar `sm` rows are 28px and local feature classes alternate among 10px, 12px, and 14px with unrelated opacity values.
- `ChatHeader.tsx`, `ThreadWorkspaceRail.tsx`, and `BranchToolbar.tsx` contain fork-critical controls that must fit through consistent sizing/truncation rather than being hidden.

### Design

- Keep bundled DM Sans for UI and JetBrains Mono for code/terminal. The Synara package's unused Inter dependency is not part of the look worth copying.
- Set shell/header rows to 46px, primary UI labels to 12px, secondary controls to 11px, metadata to 10px, and sidebar rows to 28px.
- Replace uppercase/high-tracking section labels with quiet sentence-case 12px labels, matching Synara's Pinned/Projects/Workspace hierarchy.
- Use weight and text tiers before color. Reserve medium weight for active/title/action emphasis; normal rows stay regular.
- Keep pointer-coarse hit targets and all focus-visible treatment even when visual footprints shrink.
- Keep sidebar width/resizing behavior; only adjust its default width if the new flat row metadata demonstrably clips at the current 16rem.

### Tasks and exact files

1. Edit `apps/web/src/index.css`:
   - Apply the fixed type/density roles to the body and shared shell/header helpers.
   - Keep code/terminal stacks separate.
2. Edit `apps/web/src/components/ui/sidebar.tsx`:
   - Normalize `sm` row height, radius, gap, label size, section header, focus, selected, and hover roles.
   - Preserve coarse-pointer target expansion, resizing, mobile sheet, and off-canvas motion.
3. Edit `apps/web/src/components/Sidebar.tsx`:
   - Replace local uppercase/tracking/opacity variants with the shared section and row roles.
   - Tighten primary actions, footer, search, project headers, flat thread metadata, and Pinned spacing.
4. Edit `apps/web/src/components/chat/ChatHeader.tsx` and `apps/web/src/components/chat/ThreadWorkspaceRail.tsx`:
   - Align title, project metadata, model/goal/governance/status chips, and layout controls to the compact scale without removing any Neokod feature.
5. Edit `apps/web/src/components/BranchToolbar.tsx` and `apps/web/src/components/chat/PanelLayoutControls.tsx` for the same control height/text tiers.
6. Edit `apps/web/src/components/AppSidebarLayout.tsx` only if the visually validated default sidebar width changes; preserve its min-width and main-content constraints.
7. Append the shell typography/density bullet to the `2.1.0` entry in `CHANGELOG.md`.

### Dependencies

None. Keep `@fontsource-variable/dm-sans` and `@fontsource/jetbrains-mono`; do not add font packages.

### Acceptance criteria

- Sidebar, chat header, right-panel header, and branch toolbar share one clear vertical rhythm.
- Pinned/Threads/Workspace labels are sentence case, readable, and subordinate to rows without low-contrast text.
- Long project/thread/model/branch titles truncate without moving controls or clipping focus rings.
- All keyboard focus, 44px coarse-pointer target expansion, desktop drag regions, and mobile sidebar behavior remain intact.
- Goal, fleet, MCP, governance, notification status, environment, PR, terminal, and unread cues remain visible and semantically distinguishable.

### Verification

- `vp test run --project unit apps/web/src/components/ui/sidebar.test.tsx apps/web/src/components/chat/ChatHeader.test.ts apps/web/src/components/chat/ThreadWorkspaceRail.test.ts`
- `vp check`
- `vp run typecheck`
- Visual checks at 390px, 768px, 1024px, and 1440px in both themes, including long names, many status chips, WCO/title-bar mode, sidebar collapse/resize, settings sidebar, and 200% browser zoom.
- Keyboard-only pass through sidebar tabs/rows, header controls, panel controls, and branch toolbar.

### Risks and containment

- A global font-size change can clip Base UI controls. Apply role variables at shell owners first instead of changing Tailwind's base `text-sm` globally.
- Dense chrome can reduce hit areas. Separate visual size from pointer-coarse hit target and keep accessible names/tooltips.
- The header has fork-owned controls. Tighten and overflow-test them; do not hide features to make the layout fit.

## Stage 5 — Conversation typography, spacing, and calm color pass

### Objective

Finish the redesign across the transcript and composer after the shell is stable, with no behavior/state changes.

### Current-state findings

- `MessagesTimeline.tsx` is the virtualized hot path and already has scroll anchoring tests. It uses 14px relaxed body copy, 12px tool rows, 10–11px metadata, 80% user bubbles, and `max-w-3xl` content.
- `ChatMarkdown.tsx` owns markdown, code blocks, tables, raw-HTML sanitization, links, and copy affordances. Its sanitizer boundary must remain unchanged.
- `ChatView.tsx` measures the composer overlay and passes its height to the transcript. Spacing changes can affect last-row visibility and scroll anchoring even when they look CSS-only.
- `chat/ChatComposer.tsx` contains approval/input/plan/follow-up modes as well as normal prompt controls; all variants must retain the same shell.

### Design

- Use 13px/1.55 for conversation prose, 12px/1.5 for code, 11px for tool/activity rows, and 10px for timestamps/meta. Keep code legible rather than shrinking it to match chrome.
- Keep the current readable `max-w-3xl` measure unless screenshots show a concrete issue; Synara's cleanliness does not require narrowing the transcript.
- Make assistant prose primary text, reasoning/tool metadata secondary, timestamps tertiary, and selected/attention/error states semantic. Remove decorative color where label/icon/border already conveys state.
- Tighten vertical gaps between related activity rows while retaining separation between user turns and assistant responses.
- Use a restrained neutral user bubble/control surface, modest radius, and subtle boundary. Do not turn every message into a card.
- Tighten composer padding and footer spacing around the existing measured overlay; do not change prompt/editor behavior, approval flow, slash commands, attachments, plan flow, or branch toolbar ownership.
- Preserve markdown sanitization, diff add/remove semantics, link affordance, code contrast, and reduced-motion behavior.

### Tasks and exact files

1. Edit `apps/web/src/components/chat/MessagesTimeline.tsx`:
   - Apply chat/meta/tool type roles and consistent vertical spacing.
   - Calm user/assistant/tool/reasoning surface colors without changing timeline entry structure or callbacks.
2. Edit `apps/web/src/components/ChatMarkdown.tsx`:
   - Align prose, headings, lists, blockquotes, tables, inline code, and fenced code with the type/text/surface roles.
   - Do not change the remark/rehype pipeline or sanitizer schema.
3. Edit `apps/web/src/components/chat/ChatComposer.tsx` and `apps/web/src/components/ComposerPromptEditor.tsx`:
   - Tighten the shared composer surface, editor inset, banners, and footer controls using Stage 1 roles.
   - Preserve every composer state and coarse-pointer target.
4. Edit `apps/web/src/components/ChatView.tsx` only for conversation wrapper/composer-overlay spacing classes. Do not change selectors, effects, state, routes, panel mounting, notification mounting, or orchestration callbacks.
5. Edit `apps/web/src/index.css` for shared markdown/code/composer variables and existing `.chat-composer-*`/diff theme bridges.
6. Append the conversation polish bullet to the `2.1.0` entry in `CHANGELOG.md` and finalize the release-impact explanation.

### Dependencies

None. Do not add Synara's math, PDF, animation, xterm addon, or theme-editor dependencies as part of a visual redesign.

### Acceptance criteria

- A long mixed conversation has a clear hierarchy between user prompt, assistant response, reasoning, tools, task groups, timestamps, and status/error rows in both themes.
- Markdown headings/lists/tables/quotes/links and long fenced code remain readable and horizontally safe.
- Composer normal, running, queued, approval, user-input, plan follow-up, attachment, terminal-context, and error states share one stable footprint.
- No last-message occlusion, scroll jump, broken live-follow, or virtualization churn appears after spacing changes.
- Diff addition/removal colors, warning/error/success states, links, and focus rings retain semantic contrast; ordinary chrome stays neutral.
- Route, effect-atom, notification, right-panel, terminal, preview, and server orchestration behavior is unchanged.

### Verification

- `vp test run --project unit apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/components/chat/timelineScrollAnchoring.test.tsx apps/web/src/components/chat/ChatHeader.test.ts apps/web/src/composer-logic.test.ts`
- `vp check`
- `vp run typecheck`
- Visual/manual scenarios in both themes and at 390px/768px/1024px/1440px:
  - Empty/new thread, short exchange, long markdown, wide code/table, images/attachments, many tool calls, plan, approval, user-input request, queued follow-up, streaming response, and error banners.
  - Scroll away and return to live edge; send while near bottom; resize sidebar/right panel while streaming; switch threads and return.
  - Browser zoom 80%, 100%, 125%, and 200%; reduced-motion enabled; keyboard-only composer flow.
- Capture before/after screenshots for shell, Threads/Pinned, Workspace tree, Diff, Terminal, Browser, and long conversation in light/dark.

### Risks and containment

- `MessagesTimeline` and composer measurements are performance/correctness sensitive. Keep changes class-only, run existing anchoring tests, and manually verify streaming/live-follow.
- Smaller type can harm readability. Keep prose at 13px minimum with 1.55 line height and do not shrink code below 12px.
- Do not copy Synara's markdown pipeline: Neokod's `rehypeRaw` plus `rehypeSanitize` boundary remains mandatory.

## Synara items deliberately not copied

- **Zustand/React Query entity architecture:** Neokod keeps effect-atom/client-runtime state. Zustand remains limited to existing UI/resource stores.
- **ThemePackEditor and 1,374-line token generator:** useful for a future customization product, unnecessary for a calmer default theme. Reconsider only when users explicitly need import/export, per-theme fonts, contrast controls, or custom semantic colors.
- **`react-colorful`:** only needed by the skipped theme editor.
- **`tw-animate-css`:** declared but unused in Synara; do not add dead dependency weight.
- **Inter/font dependency changes:** Synara declares Inter but does not import it in `main.tsx`. Keep Neokod's deterministic DM Sans/JetBrains Mono setup.
- **Synara workspace pages/store/routes:** Neokod's Workspace tab is a view of existing projects/worktrees, not a new product entity.
- **`RightDock.tsx`/`rightDockStore`:** Neokod already has the equivalent resource-aware shell and stronger surface coverage.
- **Translucent macOS theme material:** blur/vibrancy is optional decoration with platform/GPU risk; the clean hierarchy must work with opaque semantic surfaces first.
- **`cmdk`, extra icon libraries, xterm addon stack, math/PDF, Kanban, profile/share, World Cup, and other novelty/product features:** outside this visual redesign and called out as low-value or unrelated in the prior assessment.
- **Synara markdown pipeline:** never replace Neokod's sanitizer boundary.

## Cumulative delivery and release discipline

- Land stages in order. Each stage must leave the repo shippable; later stages may depend on earlier tokens but may not leave placeholder classes or dead scaffolding.
- Keep each stage in its own reviewable commit/PR slice with screenshots for the visual delta.
- Stage 1 opens `2.1.0 (Minor)` and updates the four synchronized version files. Every later stage appends its own changelog bullet before the code slice is considered complete.
- If a stage is intentionally released alone from a different branch, recalculate SemVer from that branch instead of blindly retaining this cumulative version plan.
- At the end of every stage, required gates are `vp check` and `vp run typecheck`; the focused tests and visual matrix above are additional stage-specific proof.
- Before final merge, run the union of focused tests, then a full `vp test`, `vp check`, `vp run typecheck`, and `vp run build` for the web/desktop packaging path used by the release.

## Final definition of done

- Neokod presents a calm neutral light/dark shell with consistent semantic tokens.
- Sidebar exposes Threads and Workspace tabs, with a persistent scoped Pinned section and no loss of existing project/thread operations.
- Right-side Diff/Terminal/Browser and all other existing surfaces share one compact tab/header system without resource remounts.
- Shell and conversation typography/spacing are visibly tighter, accessible, and stable under streaming, resizing, mobile sheets, and Electron title bars.
- `/_chat/$environmentId/$threadId`, effect-atom state, local notifications, provider/server orchestration, and all existing panel resources remain intact.
- `CHANGELOG.md` and synchronized canonical versions record a Minor `2.1.0` release.
- All focused tests, `vp test`, `vp check`, `vp run typecheck`, build verification, and the light/dark visual matrix pass.
