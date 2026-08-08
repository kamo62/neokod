# UI/UX comparison review: diri and local-studio vs Neokod

Date: 2026-08-06
Scope: read-only review of two open-source coding-agent apps against our web UI in `apps/web/src`.

Repos reviewed (cloned to scratchpad):

- `cristicretu/diri` — native macOS orchestrator for coding agents. Rust + GPUI app (`diri/crates/`) with a Swift daemon. Not a web UI, so the comparison is about design language and motion engineering rather than transferable CSS.
- `sybil-solutions/local-studio` — local-first workstation for self-hosted LLMs. Next.js 16 + React 19 + Tailwind v4 frontend in `frontend/src`, plus an Electron shell. Architecturally the closest peer to us, and the one the user prefers. Its README credits T3 Code (our upstream) as inspiration, so several surfaces are recognisably parallel implementations of the same idea.

---

## 1. Overall design language and polish

### local-studio

The whole app is driven from one file, `frontend/src/app/styles/globals/tokens.css` (805 lines), whose header states the rule plainly: "Every component reads from these CSS variables; no hardcoded colors, radii, or row heights live in component files."

The visual language is a warm neutral gray ramp over a unified canvas. One surface colour for window, rail and panels, separated by translucent hairline borders; elevated grays for cards and popovers; white-overlay hover and active states; a single saturated blue accent. Status hues (green, orange, red) are the only other chroma.

Two details make it feel considered rather than merely tidy:

- Borders are foreground mixes, not fixed grays: `--color-border: #1a1c1f14` in light, `#ffffff14` in dark, with `-light` at 5% and `-heavy` at 16%. Because they are translucent they sit correctly on any surface underneath.
- Dark mode deliberately removes chrome that light mode needs. `--color-popover-border: transparent` with the comment "Codex dropdowns float on shadow alone — no hairline", and `--color-input-border: transparent` with "Dark inputs are filled surfaces with no resting outline". That is a real design decision, not a token copied across both themes.

The composer is the centrepiece and gets the most attention. `frontend/src/features/agent/ui/agent-composer-frame.tsx` renders a floating pill: `rounded-[var(--composer-radius)]` (25px), `shadow-[var(--composer-elevation)]`, `backdrop-blur-lg`, and `[corner-shape:superellipse(1.5)]` for true squircle corners. It is centred at `max-w-[calc(var(--composer-w)*0.9)]`.

Chat typography is explicitly cloned from a reference. `frontend/src/app/styles/globals/chat.css` comments say "Codex desktop v26.7, exact: the ChatGPT text-md ladder — 16px system UI with 24px leading (1.5) for chat prose AND the composer (one shared chat ladder)" and "Codex sets headings barely above body size and leans on weight, not scale". Headings therefore differ by weight, not size, which keeps long agent output calm.

### diri

diri ships a dedicated design-system crate, `diri/crates/diri-ui/`, with `tokens.rs`, `components.rs`, `status.rs`, `brand.rs`, `icon.rs`, and an `examples/gallery.rs` that renders every token and component state on one screen.

`tokens.rs` is a named-constant system with no magic numbers anywhere downstream: `Radius::{CHIP 5, BADGE 6, ROW 7, CARD 10, PANEL 12}`, a seven-role `Typo` ramp (`META`/`SECTION_HEADER`/`ROW`/`ROW_EMPHASIZED`/`TITLE`/`DISPLAY_TITLE`/`META_MONO`), `Fill::{HOVER_OPACITY 0.06, MULTI_SELECTED_OPACITY 0.08, SELECTED_OPACITY 0.10}`, and a `Metrics` block covering toolbar heights and the macOS traffic-light lane.

The most distinctive idea is contrast compensation for translucent materials. `SemanticColors::sidebar()` raises secondary and tertiary alpha (0.60 to 0.70, 0.30 to 0.44) with the comment: "Sidebar materials sit over live desktop content, so stock label opacities lose more perceived contrast than they do on an opaque surface." There is a unit test asserting sidebar tones stay firmer than base tones.

### Ours

Our token layer in `/Users/kamogelo/Code/t3code/apps/web/src/index.css` is genuinely good and in places ahead of both. We run a semantic ramp (`--surface-canvas/sidebar/panel/elevated/control/hover/selected`, `--text-primary/secondary/tertiary`, `--line-subtle/default/strong`) that maps onto shadcn names, and we document accessibility decisions inline:

> Darkened from the #9e9e9e design value, which is 2.68:1 on the white canvas and below the WCAG AA 4.5:1 floor for normal text. #767676 is the lightest value that clears it (4.54:1)

Neither diri nor local-studio verifies contrast ratios anywhere. We also ship a grain texture with a documented performance rationale (baked into each surface rather than a fixed overlay, to avoid forcing the compositor to re-blend every frame), and Window Controls Overlay support via a `wco` custom variant.

Where we fall behind is discipline at the component layer. Our tokens are strong but components bypass them. `apps/web/src/components/NoActiveThreadState.tsx` writes `text-emerald-600 dark:text-emerald-300`, `text-amber-600 dark:text-amber-300`, `text-violet-600 dark:text-violet-300` for its four dashboard groups, hand-rolling a light/dark pair for each. We already have `--success`, `--warning` and `--info` that resolve per theme. Eighteen component files do this; local-studio's equivalent is `text-(--ui-success)`, one token, no dark: variant needed.

Raw Tailwind palette classes across component trees:

|                       | files with raw palette classes | occurrences | .tsx files |
| --------------------- | ------------------------------ | ----------- | ---------- |
| Ours (`components/`)  | 18                             | 58          | 174        |
| local-studio (`src/`) | —                              | 33          | 211        |

Hardcoded hex is not really a problem for us: 225 occurrences, but 211 of them are in `chat/PierreEntryIcon.tsx`, `JetBrainsIcons.tsx` and `Icons.tsx`, which are brand SVGs and legitimately literal.

---

## 2. Layout and navigation model

### local-studio

Four top-level surfaces, deliberately few: Status (`/`), Automations, Configure, Usage. Defined as a plain array in `frontend/src/features/shell/left-sidebar-nav.tsx`.

The interesting decision is documented in that file:

> Sessions has no nav row: the Search command palette is the session list.

And in `left-sidebar-desktop.tsx`:

> Search is an icon here rather than a row of its own: it reclaims a full row for the content the sidebar actually exists to list.

So the sidebar is four nav rows plus "New task" plus the projects tree, with back/forward history steppers and a search icon in a 46px toolbar strip. Collapsed width is 44px, expanded is user-resizable from a 275px default.

The workbench itself (`frontend/src/features/agent/ui/pane-grid.tsx`) is a recursive binary split tree. `Layout` is `leaf | split`, `SplitNode` renders `a`, a 1px draggable separator, then `b`, sized by percentage. You drag a session row onto a pane: dropping on the centre opens a tab, dropping on one of four 24px edge strips splits the pane in that direction. The edge targets are only mounted while a drag is actually in flight, tracked by a `useSyncExternalStore` subscription on document `dragstart`/`dragend`/`drop`, with the reason commented: otherwise the invisible top strip steals clicks from the pane header's "..." menu.

### diri

Three-column shell: sidebar, terminal card, inspector. The panels flank a workbench card and both animate the seam width rather than transforming the panel, because the card is a flex sibling that has to follow. Command palette (`palette.rs`), quick open (`quick_open.rs`) and a session switcher (`switcher.rs`) are separate surfaces. Sessions are grouped into pinned and per-project sections with an archived row, and ⌘1 through ⌘8 address the first eight rows while ⌘9 always jumps to the last.

### Ours

We are considerably broader: two top-level product areas (`_chat` and `symphony`) plus a settings area, with 11 symphony routes (`index`, `queue`, `running`, `attention`, `reviews`, `history`, `trackers`, `workflows`, `settings`, `$runId`) and 8 settings routes. That breadth is a product decision, not a UI defect, but it does mean our sidebar carries more than local-studio's does.

Our right panel is a tab set (`RightPanelTabs.tsx`, `rightPanelStore.ts` at 23KB) rather than a splittable grid. We have no arbitrary pane splitting and no drag-to-split. Our sidebar resize (`components/ui/sidebar.tsx`) does correctly suppress transitions during drag by setting `transition-duration: 0ms` on the affected elements and removing it on release, which is the same technique local-studio uses via `resizing ? "" : "transition-[width] duration-150 ease-out"`.

---

## 3. Component quality and consistency

local-studio's shared kit is `frontend/src/ui/` — 43 files, most between 600 bytes and 5KB, one concern each: `button`, `card`, `checkbox`, `drawer`, `input`, `list`, `menu`, `modal`, `page`, `page-state`, `progress-bar`, `segmented-control`, `select`, `slider`, `spinner`, `stat`, `status`, `tabs`, `textarea`. The two largest are `huggingface-model-card.tsx` (11KB) and `list.tsx` (7KB).

Two structural pieces are worth calling out:

- `ui/page.tsx` exports `AppPage`, `PageContainer` (four named widths), `PageHeader` (eyebrow / title / description / status / actions) and `TabbedPage`. Every page composes from these, so page-level rhythm is identical app-wide without anyone re-deciding padding.
- `ui/list.tsx` exports `ListRow` with a `settings` and a `resource` variant, plus `RowValue`, `RowFacts`, `RowDetailLine`, `KeyValueRow`. `features/settings/settings-ui.tsx` then re-exports `SettingsRow` as a thin wrapper over `ListRow`. One row primitive serves settings, resource lists and fact tables.

There is also a CI gate: `npm run check:ui-structure` runs `node ../scripts/project.mjs validate-ui`, which walks `src/`, enforces layering rules (retired feature dirs, shared-layer allowlists, primitive purity) and exits non-zero with `rule` plus `detail` per finding. `AGENTS.md` states the rule for contributors: "use the shared UI kit and design tokens".

Our `components/ui/` is 46 files and broadly comparable in coverage, and in several places richer (we have `autocomplete`, `combobox`, `command`, `input-group`, `number-field`, `toggle-group`, `alert-dialog` which local-studio lacks). Our problem is above the primitives. `Sidebar.tsx` is 155KB, `ChatView.tsx` is 202KB, `CommandPalette.tsx` is 68KB, `ThreadTerminalDrawer.tsx` is 56KB, `toast.tsx` is 32KB. local-studio's largest UI file is `chat-pane.tsx` at 829 lines. Its `pane-grid.tsx` is 334 lines; our nearest equivalent responsibilities are spread across `RightPanelTabs.tsx`, `rightPanelStore.ts` and parts of `ChatView.tsx`.

We also have no page-shell primitive. Each settings route and each symphony view re-derives its own container padding and header treatment.

---

## 4. Theming (light and dark)

local-studio is the clear leader here, and not by a small margin.

The master-knob idea is the core of it. `tokens.css` defines a handful of root values and derives everything else with `calc()`:

```css
--ui-scale: 1; /* master text-size multiplier */
--radius-base: 10px; /* master corner radius */
--space-base: 4px;
--leading: 1.5;
```

The type ramp is `--fs-2xs` through `--fs-display`, each `calc(Npx * var(--ui-scale))`. The radius ramp is `--rad-2xs` through `--rad-4xl`, each a multiple of `--radius-base`. Both are then re-exported into Tailwind through `@theme inline`, so `text-sm` and `rounded-lg` read the themed ramp rather than Tailwind defaults. Components write `text-[length:var(--fs-md)]`, never `text-[13px]`.

That plumbing pays off in `frontend/src/features/settings/appearance-settings.tsx`, which is the most complete appearance surface of the three apps. It offers:

- Light / Dark / System segmented control
- A theme library of 12 themes, grouped, searchable, with colour swatches per theme
- A live theme editor: colour pickers for accent, background, foreground, surface, plus an "Advanced tokens" group for `dim`, `border`, `hl1`, `hl2`, `hl3`, `err`, persisted to `localStorage` and applied via `applyTokensToDocument`
- Sliders for UI scale (0.8 to 1.3), corner radius (0 to 16px), UI font size, chat text size, chat line height, chat column width, plus a bubble-tone colour picker

`frontend/src/lib/theme-runtime.ts` derives the whole `--ui-*` overlay set from any custom theme's `bg` by measuring its lightness and picking an ink colour, so a user-authored accent still gets correct hover, active, border and rail values without the user setting them.

Ours: two themes, light and dark, no scale knob, no radius knob, no user-facing appearance surface. Grepping `apps/` for `ui-scale`, `uiScale`, `textSize`, `fontScale` or `setZoomFactor` returns nothing in the app chrome; the only `zoomFactor` hits are in `browser/browserViewportLayout.ts` and `previewStateStore.ts`, which control the embedded browser preview, not our own UI. Our font sizes are fixed pixel tokens (`--font-size-ui: 12px`, `--font-size-meta: 10px`, and so on), and many components bypass even those with `text-[11px]` / `text-[13px]` literals, for example throughout `components/settings/settingsLayout.tsx`.

diri reads the system appearance via `Appearance::from_window` and offers no in-app theme choice at all.

---

## 5. Micro-interactions and animation

### diri (the strongest of the three)

`diri/crates/diri-app/src/seam.rs` (167 lines including tests) is the best piece of motion engineering in either repo. The sidebar and inspector open/close is a critically damped spring step response, normalised to span exactly 0 to 1:

```rust
fn spring_settle(delta: f32) -> f32 {
    const STIFFNESS: f32 = 7.0;
    let remaining = |t: f32| (1.0 + STIFFNESS * t) * (-STIFFNESS * t).exp();
    // The raw response is still ~0.7% short at t = 1. Divide that out, or the
    // slide ends on a visible one-frame snap onto the settled width.
    (1.0 - remaining(delta)) / (1.0 - remaining(1.0))
}
```

Every decision is justified and tested. Overshoot is rejected explicitly because the seam pushes the terminal card, so a bounce "would drag the whole workbench back and forth rather than reading as elasticity on one small control". The slide reads its destination back from the settled layout every frame rather than capturing it, so dragging the seam mid-slide retargets instead of snapping. And `toggle_has_settled` drops toggles arriving mid-slide rather than queueing or reversing them, because ⌘B autorepeats every ~30ms and a half-played slide flipping direction "reads as a stutter rather than as a panel". Tests cover monotonicity, front-loading (`spring_settle(0.5) > 0.8`), retargeting, and autorepeat.

`diri-ui/tokens.rs` names its curves: `Motion::{SNAP, POP, SETTLE, FOOTER_PIN}` as `Spring { response, damping_fraction }` pairs, plus `ROW_SELECT: 0.16`, `OVERLAY_FADE: 0.12`, `SEAM_SLIDE_MS: 260`.

`status.rs` is also worth noting. Every status glyph derives its animation phase from one absolute wall-clock sample (`wall_clock_seconds()`), so independently mounted glyphs stay phase-synchronised with no shared state. And there is a test that reads its own source file to assert the glyphs never spawn frame tasks or periodic timers:

```rust
assert!(!source.contains(&window_task), "status glyph rendering must stay event-driven");
```

### local-studio

Named motion tokens in `tokens.css`:

```css
--cubic-enter: cubic-bezier(0.19, 1, 0.22, 1);
--ease-enter-snappy: cubic-bezier(0.23, 1, 0.32, 1);
--duration-basic: 0.15s;
--duration-relaxed: 0.3s;
```

`styles/globals/animations.css` holds a small named keyframe library: `fade-in`, `slide-up`, `pulse-soft`, `bounce`, `slide-in-left/right`, `message-appear` (`translateY(12px) scale(0.98)` over 0.35s on `cubic-bezier(0.22, 1, 0.36, 1)`), `subtle-glow`, `blink`.

Interaction feedback is consistent because it lives in the primitives: `ui/button.tsx` has `active:scale-[0.98]` on every button and transitions only the properties that change (`transition-[transform,color,background-color,border-color,opacity]`). `ui/page.tsx`'s `RefreshIconButton` uses `active:translate-y-px`. Focus is uniformly `focus-visible:ring-2 focus-visible:ring-(--ui-accent)/35`.

### Ours

We have no named easing or duration tokens at all. Grepping `index.css` for `ease-`, `duration-` or `cubic-bezier` outside keyframes returns nothing, so every component picks its own. Distribution of transition declarations across `components/`:

| declaration                              | count |
| ---------------------------------------- | ----- |
| `transition-colors`                      | 60    |
| `transition-opacity`                     | 32    |
| `transition-transform`                   | 15    |
| `transition-all`                         | 11    |
| everything else (bespoke property lists) | ~20   |

Eleven `transition-all` uses are a performance and consistency smell. Durations are ad-hoc: `duration-150`, `duration-200 ease-linear`, and a 250ms constant in `AnimatedHeight.tsx`.

Two things we do well: `AnimatedHeight.tsx` is a careful measured-height transition with a timeout fallback and double-rAF settling, and our `@theme inline` keyframes are duty-cycled for compositor cost, with the reasoning written down:

> Duty-cycled indicator animations: long opacity holds with short stepped ramps, so the compositor only produces frames while the value changes (~20% of the cycle) instead of every vsync.

That is the same class of thinking as diri's "status glyphs must stay event-driven" test. We also respect `prefers-reduced-motion` globally, which local-studio does not.

---

## 6. Empty, loading and error states

Ours is the strongest of the three here, and should be kept.

`components/ui/empty.tsx` gives us `Empty` / `EmptyHeader` / `EmptyMedia` / `EmptyTitle` / `EmptyDescription` / `EmptyContent`, and the `icon` media variant renders three stacked cards (two rotated ±10° and scaled to 0.84 behind the real one) with a theme-aware inner hairline. `components/symphony/SymphonyEmptyState.tsx` is a nine-line wrapper over it, so all six symphony views get an identical treatment for free. We also ship `Skeleton` and it is actually used across `DiffPanelShell`, `SourceControlSettings` and all five symphony views.

local-studio's `frontend/src/ui/page-state.tsx` is 43 lines and handles only two cases: initial loading renders a pulsing `Activity` icon, and error-with-no-data renders the message plus a "Retry" button. Everything else returns `null`. Empty states are ad-hoc per surface (`EmptySafeNotice` in `ui/list.tsx` is just a padded muted paragraph). It has no skeleton component.

diri has `sidebar/view.rs::empty_state()` as a single bespoke function.

The one thing local-studio does better is that its error state always pairs the message with a retry action wired to the same `onLoad` the page uses. Our empty states carry no recovery affordance by default.

---

## 7. Information density

Density is where local-studio is most explicit, and it writes its reasoning into the tokens:

```css
--sidebar-row-height: 30px;
/* Rows sat at a 30px pitch against a 30px height, i.e. touching, with no gap
   anywhere in the sidebar. That reads as a wall of text rather than a list.
   Costs 2px per row and no change to the row itself. */
--sidebar-row-gap: 2px;
```

Also `--row-h: 36px`, `--row-h-sm: 28px`, `--h-toolbar: 46px`, `--h-toolbar-sm: 36px`, `--h-toolbar-pane: 40px`, `--ui-control-h: 28px`. Base type is 14px with an 11/12/13/14/16/18/20/24/28/36 ramp.

diri: `Metrics::ROW_HEIGHT = 28.0`, `TITLE_BAR = 42.0`, `TOOLBAR_CONTROL_SIZE = 26.0`, body text at 13px, meta at 11px.

Ours: `--font-size-ui: 12px`, `--font-size-ui-sm: 11px`, `--font-size-meta: 10px`, `--font-size-chat: 13px`, `--row-height-compact: 1.75rem` (28px), `--surface-header-height: 46px`. We are the densest of the three at the base UI size (12px vs local-studio's 14px), which suits a tool with our surface count. Our toolbar height matches local-studio's exactly at 46px, and our compact row matches diri's 28px.

The gap is that we define `--row-height-compact` but do not have named tokens for the other row and control heights, so component authors write `h-7`, `h-8`, `size-5` inline and the rhythm drifts.

---

## 8. Prioritized pull-in list

Weighted toward local-studio. Effort estimates assume one focused session for "small", a day or two for "medium", more than that for "large".

### P1 — high value, low risk

1. **Master-knob token derivation (`--ui-scale`, `--radius-base`).** Add the two knobs to `:root` in `apps/web/src/index.css`, convert `--font-size-*` to `calc(Npx * var(--ui-scale))`, and add a `--rad-*` ramp derived from `--radius-base`. Re-export both through our existing `@theme inline` block so `text-*` and `rounded-*` read them. Lands in `apps/web/src/index.css` only; nothing downstream has to change on day one.
   Effort: **small**. Source: local-studio `tokens.css:20-26, 636-660, 729-771`.

2. **Named motion tokens.** Add `--ease-enter`, `--ease-enter-snappy`, `--duration-basic`, `--duration-relaxed` to `apps/web/src/index.css`, then replace the 11 `transition-all` uses and the ad-hoc `duration-*` values across `components/` with them. Kills the largest consistency gap we have.
   Effort: **small** for the tokens, **medium** for the sweep. Source: local-studio `tokens.css:671-676`.

3. **Retire the raw Tailwind palette classes.** Replace `text-emerald-600 dark:text-emerald-300` and friends with our existing `text-success` / `text-warning` / `text-info` across the 18 files that use them, starting with `components/NoActiveThreadState.tsx`, `components/MissionControl.tsx`, `components/ThreadStatusIndicators.tsx` and `components/symphony/SymphonyRunDetailView.tsx`. Halves the dark-mode surface area those files carry.
   Effort: **medium**. Source: local-studio `ui/status.tsx` tone maps.

4. **Retry affordance on error states.** Extend `components/ui/empty.tsx` with an `EmptyActions` slot, and give our data-backed views an error variant that pairs the message with the same reload the view already owns. We have the better empty-state component; it just lacks recovery.
   Effort: **small**. Source: local-studio `ui/page-state.tsx`.

### P2 — meaningful, more work

5. **A page-shell primitive.** Add `PageContainer` / `PageHeader` (eyebrow, title, description, status, actions) with named widths to `components/ui/`, then adopt it across the 8 settings routes and 11 symphony routes so page rhythm stops being re-derived per file. Also removes the `text-[11px]` / `text-[13px]` literals in `components/settings/settingsLayout.tsx` in favour of the ramp.
   Effort: **medium**. Source: local-studio `ui/page.tsx`.

6. **Appearance settings surface.** A new `settings.appearance` route plus `components/settings/AppearanceSettings.tsx`, offering light/dark/system, a UI-scale slider, a corner-radius slider, and chat text size / line height / column width. Depends on item 1 landing first. This is the single most visible user-facing win in the list, and it is exactly the surface local-studio invested the most in.
   Effort: **medium** once item 1 exists. Source: local-studio `features/settings/appearance-settings.tsx`.

7. **Named density tokens.** Add `--row-h`, `--row-h-sm`, `--h-toolbar-sm`, `--control-h` alongside our existing `--row-height-compact` and `--surface-header-height`, and adopt them where components currently write `h-7` / `h-8` inline.
   Effort: **small** for tokens, **medium** for adoption. Source: local-studio `tokens.css:598-616`.

8. **Uniform interaction feedback in the primitives.** Put `active:scale-[0.98]` (or `active:translate-y-px` for icon buttons) and a single `focus-visible:ring-2 focus-visible:ring-ring` treatment into `components/ui/button.tsx` so every button in the app inherits it, rather than each caller deciding.
   Effort: **small**. Source: local-studio `ui/button.tsx:40`.

### P3 — worth considering, larger or more speculative

9. **A `validate-ui` CI gate.** A script that walks `apps/web/src`, fails on raw Tailwind palette classes and bare `text-[Npx]` literals outside the icon files, and enforces that `components/ui/` primitives import nothing from feature dirs. This is what keeps local-studio's discipline from decaying; without it, items 3 and 7 will regress.
   Effort: **medium**. Source: local-studio `scripts/project.mjs` (`validate-ui-structure`), wired as `npm run check:ui-structure`.

10. **Spring-settled panel transitions.** Port diri's `spring_settle` curve and mid-flight retarget behaviour to our sidebar and right panel. In CSS terms this is a `cubic-bezier` approximation of the critically damped step response plus a toggle guard so a held shortcut cannot outrun the slide. Lands in `components/ui/sidebar.tsx` and `rightPanelStore.ts`.
    Effort: **medium**. Source: diri `crates/diri-app/src/seam.rs`.

11. **Composer as a floating pill.** Move from our flat panel-background bar to local-studio's elevated rounded composer (`--composer-radius: 25px`, a soft elevation shadow, `corner-shape: superellipse(1.5)`). Note our current flat treatment is a documented decision in `index.css` ("The composer separates from the canvas by its panel background shift and a subtle border in the component; no drop shadow"), so this is a deliberate reversal rather than a fix, and should be a design call, not a drive-by change.
    Effort: **medium**. Source: local-studio `features/agent/ui/agent-composer-frame.tsx:174`.

12. **Drag-to-split pane grid.** A recursive `leaf | split` layout with drag-a-session-onto-an-edge splitting, replacing or augmenting our right-panel tab model. Genuinely nice, and the implementation is only ~330 lines, but it is a product decision about how our workspace works, not a polish item.
    Effort: **large**. Source: local-studio `features/agent/ui/pane-grid.tsx`.

13. **A component gallery route.** diri's `diri-ui/examples/gallery.rs` renders every token and every component state on one screen. A dev-only `/gallery` route would make token changes reviewable at a glance and catch dark-mode regressions before they ship.
    Effort: **medium**. Source: diri `crates/diri-ui/examples/gallery.rs`.

---

## 9. Where our approach is already better and should be kept

1. **Verified accessibility.** We are the only one of the three that checks contrast ratios and writes the finding into the token file (`--text-tertiary` tuned to 4.54:1 light and 5.14:1 dark). Neither diri nor local-studio does this anywhere. local-studio's `--color-foreground-subtlest: #ffffff80` is 50% white on `#181818`, which will not clear AA.

2. **Empty and loading states.** `components/ui/empty.tsx` with its stacked-card `icon` media variant, plus a real `Skeleton` used consistently across the symphony views, is well ahead of local-studio's 43-line `page-state.tsx` and ad-hoc muted paragraphs.

3. **Reduced-motion support.** We honour `prefers-reduced-motion` globally in `index.css` and use `motion-reduce:transition-none` at call sites. local-studio has no reduced-motion handling at all.

4. **Compositor-aware animation.** Our duty-cycled `status-pulse` and `status-ping` keyframes, and the decision to bake the grain into each surface rather than use a fixed overlay, are documented performance wins neither peer has.

5. **Desktop chrome integration.** Window Controls Overlay support via the `wco` custom variant and the `--workspace-titlebar-*` geometry tokens is more thorough than local-studio's Electron shell handling.

6. **Per-row settings reset.** `SettingResetButton` in `components/settings/settingsLayout.tsx` gives every setting its own tooltipped "Reset to default" affordance. local-studio only offers a group-level reset in the theme editor.

7. **Richer primitive coverage.** `autocomplete`, `combobox`, `command`, `input-group`, `number-field`, `toggle-group` and `alert-dialog` have no local-studio equivalent.

8. **Inner-hairline elevation technique.** Our `before:shadow-[0_1px_--theme(--color-black/4%)]` / `dark:before:shadow-[0_-1px_--theme(--color-white/6%)]` pattern on cards produces a directional top-light hairline that reads better than local-studio's flat `--elev-hairline` ring. Keep it.

---

## Appendix: key files

**local-studio** (scratchpad clone):

- `frontend/src/app/styles/globals/tokens.css` — the whole design system
- `frontend/src/app/styles/globals/chat.css` — chat typography ladder
- `frontend/src/app/styles/globals/animations.css` — named keyframes
- `frontend/src/ui/` — 43-file shared primitive kit
- `frontend/src/ui/page.tsx`, `ui/list.tsx`, `ui/status.tsx`, `ui/button.tsx`
- `frontend/src/features/shell/left-sidebar-desktop.tsx`, `left-sidebar-nav.tsx`
- `frontend/src/features/agent/ui/pane-grid.tsx`, `agent-composer-frame.tsx`
- `frontend/src/features/settings/appearance-settings.tsx`, `settings-ui.tsx`
- `frontend/src/lib/theme-runtime.ts`
- `scripts/project.mjs` (`validate-ui-structure`)

**diri** (scratchpad clone):

- `diri/crates/diri-ui/src/tokens.rs` — named constants, springs, metrics
- `diri/crates/diri-ui/src/components.rs` — `FloatingSurface`, `HairlineDivider`
- `diri/crates/diri-ui/src/status.rs` — phase-synchronised status glyphs
- `diri/crates/diri-ui/examples/gallery.rs` — component gallery
- `diri/crates/diri-app/src/seam.rs` — spring-settled panel motion

**Ours**:

- `/Users/kamogelo/Code/t3code/apps/web/src/index.css`
- `/Users/kamogelo/Code/t3code/apps/web/src/components/ui/` (46 files)
- `/Users/kamogelo/Code/t3code/apps/web/src/components/ui/empty.tsx`
- `/Users/kamogelo/Code/t3code/apps/web/src/components/ui/sidebar.tsx`
- `/Users/kamogelo/Code/t3code/apps/web/src/components/Sidebar.tsx` (155KB)
- `/Users/kamogelo/Code/t3code/apps/web/src/components/NoActiveThreadState.tsx`
- `/Users/kamogelo/Code/t3code/apps/web/src/components/AnimatedHeight.tsx`
- `/Users/kamogelo/Code/t3code/apps/web/src/components/settings/settingsLayout.tsx`
- `/Users/kamogelo/Code/t3code/apps/web/src/components/symphony/SymphonyEmptyState.tsx`

# Critique of the report above (Codex gpt-5.6-sol, high) — 2026-08-06

1. Per pull-in item verdict

Path key: `N` = `/Users/kamogelo/Code/t3code`; `LS` = `/private/tmp/claude-501/-Users-kamogelo-Code-t3code/337914ad-ff46-417b-ac2c-896415f3933c/scratchpad/local-studio`; `D` = `/private/tmp/claude-501/-Users-kamogelo-Code-t3code/337914ad-ff46-417b-ac2c-896415f3933c/scratchpad/diri/diri`.

- 1. Partial: `--ui-scale` fits the Tailwind-v4 CSS-first setup, but Neokod already derives every standard radius from the master `--radius`, and remapping standard `text-*`/`rounded-*` utilities affects existing consumers rather than being consequence-free (`N/apps/web/package.json:49-64`; `N/apps/web/src/index.css:37-111,352-384`).
- 2. Partial: named motion tokens are useful, but replacing every duration is a regression-prone sweep; start with actual `transition-all` offenders and preserve the global reduced-motion contract (`N/apps/web/src/components/ui/sidebar.tsx:597`; `N/apps/web/src/index.css:1099-1119`).
- 3. Partial: semantic cleanup is worthwhile, but merged, closed and running-terminal states are not interchangeable with success/warning/info, and `text-success` is only about 3.36:1 on white (`N/apps/web/src/components/ThreadStatusIndicators.tsx:43-65,85-95`; `N/apps/web/src/index.css:411-416`).
- 4. Partial: retry actions are high-leverage, but `EmptyContent` already accepts buttons, so adding `EmptyActions` is unnecessary abstraction (`N/apps/web/src/components/ui/empty.tsx:101-114`; `N/apps/web/src/routes/symphony.workflows.tsx:60-76`).
- 5. Partial: Symphony routes do duplicate header rhythm, but settings already shares `SettingsSection`, `SettingsRow` and `SettingsPageContainer`; consolidate only the remaining Symphony duplication (`N/apps/web/src/components/settings/settingsLayout.tsx:18-96,122-135`; `N/apps/web/src/routes/symphony.reviews.tsx:62-75`).
- 6. Partial: chat size, line-height and column-width controls are valuable, but Light/Dark/System already exists and should be extended in General settings instead of adding a new route; radius and arbitrary theme editing are lower-value risk (`N/apps/web/src/components/settings/SettingsPanels.tsx:514-548`; `LS/frontend/src/features/settings/appearance-settings.tsx:354-457`).
- 7. Disagree: `h-7`/`h-8` already form a centralized sizing vocabulary in primitives, so aliases add indirection unless Neokod first commits to a user-selectable density mode (`N/apps/web/src/components/ui/button.tsx:18-30`; `N/apps/web/src/index.css:388-389`).
- 8. Disagree: Button already supplies a uniform focus ring and pressed-state feedback; global scaling is a stylistic reversal with reduced-motion implications, not a missing primitive behavior (`N/apps/web/src/components/ui/button.tsx:10-45`).
- 9. Partial: primitive import-boundary enforcement could help, but Local Studio’s validator checks architecture, not raw palettes or pixel literals, and its tokens explicitly permit palette utilities for some roles (`LS/scripts/project.mjs:2060-2106`; `LS/frontend/src/app/styles/globals/tokens.css:76-80`).
- 10. Disagree: Diri’s retargeting is stateful and recalculates the destination per frame, which a CSS cubic-bezier cannot reproduce; this is substantially more than a sidebar/store token change (`D/crates/diri-app/src/seam.rs:17-73,136-165`).
- 11. Disagree: Neokod’s composer is already centered with nested 20px/18px radii, and adding elevation reverses its documented quiet-surface decision rather than fixing a deficiency (`N/apps/web/src/components/chat/ChatComposer.tsx:2145-2171`).
- 12. Partial: multi-session panes may be valuable, but the 330-line renderer excludes layout ownership, persistence and desktop-chrome integration, so this remains a large product decision (`LS/frontend/src/features/agent/ui/pane-grid.tsx:42-80,167-213,277-333`; `N/apps/web/src/components/RightPanelTabs.tsx:371-382`).
- 13. Partial: a gallery can assist manual token review when theme work is active, but without snapshots it does not itself catch regressions before shipping (`D/crates/diri-ui/examples/gallery.rs:15-44`).

2. Corrections

- “No user-facing appearance surface” is false: General settings already exposes persisted System/Light/Dark selection (`N/apps/web/src/components/settings/SettingsPanels.tsx:514-548`; `N/apps/web/src/hooks/useTheme.ts:181-225`).
- “No page-shell primitive” is overstated: settings already has shared section, row and page-container primitives; only Symphony remains inconsistent (`N/apps/web/src/components/settings/settingsLayout.tsx:18-96,122-135`).
- “Flat panel-background bar” is false: the current composer is an inset rounded surface with `max-w-3xl`, 20px outer radius and 18px inner radius (`N/apps/web/src/components/chat/ChatComposer.tsx:2145-2171`).
- Local Studio’s “no hardcoded colors/radii” claim describes intent, not reality: its tokens permit raw palettes and its composer uses raw amber utilities (`LS/frontend/src/app/styles/globals/tokens.css:1-5,76-80`; `LS/frontend/src/features/agent/ui/agent-composer-frame.tsx:188-200`).
- “Headings differ by weight, not size” is false: Local Studio uses 20px h1, 18px h2 and 16px h3/h4 over 16px body text (`LS/frontend/src/app/styles/globals/chat.css:51-64,125-159`).
- “Local Studio has no reduced-motion handling” is false: it disables chat shimmer/activity and PWA panel animations under `prefers-reduced-motion`, although its coverage is targeted rather than global (`LS/frontend/src/app/styles/globals/chat.css:437-441,554-560`; `LS/frontend/src/app/styles/globals/pwa.css:176-181`).
- The `#ffffff80` contrast claim is wrong: composited over `#181818` it is approximately 5.28:1, above the 4.5:1 normal-text threshold (`LS/frontend/src/app/styles/globals/tokens.css:351-352,456-458`).
- “Every status glyph derives its animation phase” is false for current Diri rendering: `StatusGlyph` is explicitly static and does not use `AnimationPhase` during render (`D/crates/diri-ui/src/status.rs:44-84,141-147`).
- The proposed CI rule is not “what keeps Local Studio’s token discipline”: its validator enforces directory/import layering only (`LS/scripts/project.mjs:2060-2106`).
- “Nine-line `SymphonyEmptyState` used by all six views” is overstated: the wrapper is 25 lines, and Workflows builds its own empty-state composition (`N/apps/web/src/components/symphony/SymphonyEmptyState.tsx:1-25`; `N/apps/web/src/routes/symphony.workflows.tsx:73-89`).
- “Neither peer verifies contrast ratios anywhere” could not be verified as a repository-wide negative; the opened Diri test checks relative opacity, while Local Studio’s runtime uses a lightness heuristic rather than WCAG ratios (`D/crates/diri-ui/src/tokens.rs:343-351`; `LS/frontend/src/lib/theme-runtime.ts:20-57`).

3. Missed items

Worth stealing:

- Preserve stale data during refresh failures, following Local Studio’s `error && !data` distinction instead of replacing useful content with an error state (`LS/frontend/src/ui/page-state.tsx:14-38`).
- Elevate chat readability controls separately from global UI scaling; Local Studio separates chat size, leading and width, while Neokod already has dedicated chat tokens ready to drive (`LS/frontend/src/features/settings/appearance-settings.tsx:398-457`; `N/apps/web/src/index.css:75-76,378-384`).
- Steal Diri’s repeated-shortcut suppression before its spring curve; Neokod’s panel toggle paths currently lack the `event.repeat` guard already used elsewhere in its sidebar (`D/crates/diri-app/src/seam.rs:17-25`; `N/apps/web/src/components/AppSidebarLayout.tsx:23-35`; `N/apps/web/src/components/Sidebar.tsx:3865-3871`).

Risks:

- Contrast: mechanically changing raw status text to `text-success` would reduce light-theme contrast to about 3.36:1; use the darker `success-foreground` or define role-specific tokens (`N/apps/web/src/index.css:411-416`).
- Taxonomy: purple merged and teal running-terminal states carry information not represented by the current three positive semantic colors (`N/apps/web/src/components/ThreadStatusIndicators.tsx:43-65,85-95`).
- Radius: a zero-radius setting does not fit Neokod’s subtractive ramp because `--radius-sm/md` would become negative; the derivation needs clamping or redesign first (`LS/frontend/src/features/settings/appearance-settings.tsx:377-395`; `N/apps/web/src/index.css:104-110`).
- Theme editing: Local Studio classifies themes using simple HSL/hex lightness and fixed overlays, not contrast validation, so copying its live editor would weaken Neokod’s contrast-verified token discipline (`LS/frontend/src/lib/theme-runtime.ts:20-57`; `N/apps/web/src/index.css:364-368,437-440`).
- Persistence: Local Studio’s saved UI controls apply during store rehydration rather than its prepaint bootstrap, indicating a potential default-scale flash if copied literally; this was not runtime-verified (`LS/frontend/src/lib/theme-runtime.ts:135-160`; `LS/frontend/src/store.ts:158-163`; `LS/frontend/src/app/layout.tsx:39-76`).
- Reduced motion: collapsing transition duration does not neutralize active transforms, so imported button scaling or panel springs need explicit motion-reduce behavior (`N/apps/web/src/index.css:1099-1119`).
- WCO: global scaling, pane grids and animated panels must preserve environment-derived titlebar insets, right-panel padding and drag/no-drag geometry (`N/apps/web/src/index.css:7-35`; `N/apps/web/src/components/RightPanelTabs.tsx:376-382`; `N/apps/web/src/rightPanelLayout.ts:1-3`).

4. Your own top-3 recommendation ordering

1. Error/retry behavior with stale-data preservation: it improves recovery during server/provider failures without requiring a new component abstraction (`N/apps/web/src/components/ui/empty.tsx:101-114`; `LS/frontend/src/ui/page-state.tsx:14-38`).
1. Targeted status-taxonomy and contrast cleanup: centralize genuine roles while preserving merged/terminal distinctions and avoiding the proposed contrast regression (`N/apps/web/src/components/ThreadStatusIndicators.tsx:43-65,85-95`; `N/apps/web/src/index.css:411-416`).
1. Chat typography and column-width controls in existing General settings: this directly improves long coding-agent conversations while deferring global radius, custom-theme and WCO risk (`N/apps/web/src/components/settings/SettingsPanels.tsx:514-548`; `N/apps/web/src/index.css:378-384`).

# Pull-in deep dive (Fable) — 2026-08-06

Scope: second pass, going past the token comparison and critique above, which I treat as settled. This pass covers the sources of the "sharper and more professional" impression that the earlier sections did not reach, plus product behavior: interaction patterns, keyboard model, command surfaces, notifications, perceived latency, and architecture. Items 1 to 13 of the earlier pull-in list and the critique's three "missed items" are not repeated here.

Path key: `N` = `/Users/kamogelo/Code/t3code`; `LS` = scratchpad `local-studio`; `D` = scratchpad `diri/diri`. I also read diri's rendered screenshot (`diri/docs/images/diri.png`), which confirms the token-level reading below.

---

## 1. Sharpness gap: root causes the earlier review missed

### RC1. Our reading surface is set at chrome scale

This is the largest single factor and it is not a token-discipline issue; it is a scale decision.

Neokod renders agent prose at 13px: `--font-size-chat: 13px` (`N/apps/web/src/index.css:381`), applied with `line-height: 1.55` in `.chat-markdown` (`index.css:616-623`). The heading ladder above that body is 20/18/16/14px (`index.css:654-670`), so h1 sits at 1.54x body. local-studio's chat ladder is 16px body at 1.5 leading, weight 400, with headings at 20/18/16px weight 600 and `-0.01em` tracking, so h1 sits at 1.25x body (`LS/frontend/src/app/styles/globals/chat.css:43-64,125-159`). Same h1 size, very different result: their agent output reads as a calm document; ours reads as a shrunken web article, because the heading ramp was tuned for a larger body than the one under it.

Our 12px UI chrome is a defensible density call (section 7 above covers it). The error is that the conversation, the surface a user reads for hours, rides the same compact scale as the chrome. local-studio explicitly splits the two: a 14px UI ramp and a separate 16px chat ladder with its own tokens.

Three rendering details compound it:

- local-studio sets `-webkit-font-smoothing: antialiased` on the body (`LS/.../base.css:26-28`). Neokod sets no font smoothing anywhere (`grep` of `index.css` and `index.html`), so dark-theme text renders heavier than the same font in local-studio.
- Neokod applies `letter-spacing: var(--tracking-tight)` (-0.15px, `index.css:385`) to the entire body including chat prose (`index.css:164-169`). local-studio zeroes tracking in chat (`chat.css:64`) and diri uses `.SystemUIFont` precisely to keep native optical sizing and spacing (`D/crates/diri-app/src/fonts.rs:1-7`).
- local-studio gives chat ink its own value, 85% foreground, with the sampled reference documented (`chat.css:62-63`). Our chat uses full `--text-primary`, so long output has slightly higher contrast than intended for sustained reading.

### RC2. Chroma leaks into our interaction layer; both peers keep it neutral

Every hover and selection in Neokod is brand-blue tinted at the token level: `--surface-hover: color-mix(in srgb, var(--brand) 6%, var(--surface-panel))` and `--surface-selected` at 12% brand in light (`index.css:360-361`), 14% and 22% in dark (`index.css:433-434`). `--accent` and `--sidebar-accent` map onto these (`index.css:404,421`), so the shadcn hover convention inherits the tint app-wide.

Both peers do the opposite. diri has exactly one interaction fill scale, foreground at 6% hover, 8% multi-selected, 10% selected, enforced by a shared `RowFill` component with a unit test on the values (`D/crates/diri-ui/src/tokens.rs:224-251`, `components.rs:10-28,119-127`). local-studio uses white/foreground overlay hovers and reserves its blue for the accent role. The diri screenshot confirms the effect: the entire surface is neutral, and the only chroma on screen is status information (working glyphs, diff gutters, risk labels).

On top of the token tint, our components drift. Distribution of hover fills across `N/apps/web/src/components`:

| class                                                                                   | count    |
| --------------------------------------------------------------------------------------- | -------- |
| `hover:bg-accent`                                                                       | 33       |
| `hover:bg-transparent`                                                                  | 10       |
| `hover:bg-sidebar-accent` / `hover:bg-muted`                                            | 7 each   |
| `hover:bg-surface-hover` / `hover:bg-muted/50`                                          | 6 each   |
| `hover:bg-accent/70,/60,/50,/40`                                                        | 16 total |
| 15 further one-off values (`muted/55,/40,/34,/20,/15`, `white/10`, `input/64,/48`, ...) | 20       |

25 distinct hover treatments against diri's one. The user cannot name this, but they feel it: every peer row darkens by the same amount everywhere; ours brightens by a slightly different amount, in a slightly different hue, per surface.

### RC3. We have no elevation vocabulary

Neokod defines zero `--shadow-*` tokens (`grep` of `index.css`), so all 65 shadow uses in components (`shadow-xs` 25, `shadow-sm` 17, `shadow-lg` 15, `shadow-md` 4, `shadow-2xl` 3, `shadow-xl` 1) resolve to stock Tailwind values that nobody chose.

local-studio defines a tuned ramp once, then remaps Tailwind onto it so every call site inherits it silently: `--elev-hairline: 0px 0px 0px 0.5px #0000001a` plus five low-alpha drop shadows, re-exported as `--shadow-sm` through `--shadow-2xl` (`LS/.../tokens.css:662-669,758-764`). diri goes further and has exactly one floating recipe for every menu, popover, and palette: `FloatingSurface` with a 0 14px 32px shadow at 0.32 alpha, a 1px inset top-light, a hairline stroke, and a 160ms opacity-only entry fade from 0.76 (`D/crates/diri-ui/src/components.rs:31-80`). One recipe means every overlay in the app looks and enters identically; the restraint (no scale, no translate) is what makes it read native.

### RC4. Icon optical sizing is tokenized by peers, ad hoc for us

diri's entire icon system is one 24x24 family drawn with a 1.75pt rounded stroke, and four optical sizes, COMPACT 14 / REGULAR 16 / LARGE 20 / DISPLAY 28, with a snapping function that maps arbitrary legacy sizes onto the scale (`D/crates/diri-ui/src/icon.rs:7-46`). Icon weight therefore never varies row to row.

Neokod defines `--icon-nav: 14px` and `--icon-card: 20px` (`index.css:386-387`) and then components ignore them: 527 inline icon sizes across seven values (`size-3.5` x169, `size-3` x142, `size-4` x103, `size-5` x64, `size-4.5` x36, `size-6` x10, `size-2.5` x3). Lucide's fixed 2px stroke at seven different rendered sizes produces seven apparent weights. Snapping to three or four named sizes is a mechanical sweep with a visible alignment payoff.

### RC5. Perceived latency: the peers pre-warm and coalesce

- local-studio snapshots the last 24 sessions' transcripts into localStorage (200 messages / 512KB per session, tool text capped at 16KB, attachment bodies stripped, LRU eviction, quota-failure fallback) so a session paints instantly on reopen before any live state arrives (`LS/.../workspace/transcript-cache.ts:12-15,112-175`). There is even a main-thread perf note about sizing each message once instead of re-stringifying per trim iteration (`:75-80`).
- Streaming token deltas are coalesced per animation frame per session: same-kind deltas concatenate, a kind switch flushes first to preserve order, and the commit callback runs once per frame (`LS/.../runtime/effect-coalescer.ts:1-11,123-159`). Chat streaming cost is bounded at one React commit per frame regardless of token rate.
- diri warms its quick-open index at launch from a disk cache with a background rescan behind it, with the intent stated in the comment: "the first ⌘P of a session never waits on `read_dir`" (`D/crates/diri-app/src/navigation.rs:139-144`).

Neokod's virtualized timeline (LegendList in `ChatView.tsx`) is solid, but I found no transcript snapshot for cold paint and no frame-clock coalescing in `apps/web` or `packages/client-runtime/src/state` (the batching in `runtime.ts:221-230` is command batching). If the server already throttles event cadence, the coalescer item drops; measure before building.

### RC6. Their motion carries meaning; ours is uniform

Beyond the missing motion tokens (settled above), diri scales attention animation by risk: status pings run at a 1.8s period normally and 1.2s when the pending permission is classified risky (`D/crates/diri-ui/src/tokens.rs:306-307`), fed by a first-match risk classifier over the prompt text, destructive > network > file-write > neutral (`D/crates/diri-engine/src/status/risk.rs:10-44`). A destructive `rm -rf` approval literally pulses faster than a file write. Animation as information, applied in exactly one place, is the opposite of decorative motion, and it suits our approval flow directly.

### Summary of the gap

Our token file is competitive (the sections above establish that). The sharpness deficit lives in four places the tokens do not reach: the chat scale decision, the tinted and inconsistent interaction fills, the unowned elevation and icon-weight vocabularies, and cold-path latency. All four are invisible in a token diff and obvious on screen.

---

## 2. New pull-in list (beyond sections above)

Ranked by payoff per effort. Effort: small = one focused session, medium = a day or two, large = more.

### Tier 1: small effort, app-wide payoff

**P1. Chat reading ladder.** Raise `--font-size-chat` to 15 or 16px at 1.5 leading, retune chat headings to a weight-led 20/18/16px over that body, zero letter-spacing inside `.chat-markdown`, introduce a chat ink token at ~88% foreground, and set `-webkit-font-smoothing: antialiased` on the body. Lands entirely in `N/apps/web/src/index.css:378-385,616-674`. This is the correct default underneath the chat-size settings the critique already recommends (its item 3); the setting should tune a good default, and today the default is the problem. Source: `LS/chat.css:43-64,125-159`. Effort: **small**. Payoff: the app's primary surface stops reading as caption text; largest single visual win available.

**P2. Neutral interaction fills.** Redefine `--surface-hover` and `--surface-selected` as foreground mixes (about 5 to 6% hover, 10 to 12% selected), keeping `--brand` for primary buttons, links, focus, and text selection. `--accent` and `--sidebar-accent` inherit automatically, so this is a one-file change with app-wide effect; the 25-variant hover drift can then be burned down opportunistically toward `hover:bg-accent`. Source: `D/tokens.rs:224-251` plus `components.rs` `RowFill`. Lands: `N/index.css:360-361,433-434`. Effort: **small** (tokens), incremental (drift cleanup). Risk: the sidebar selected state may need the stronger 12% step plus full-alpha text, which is exactly diri's Selected text tone (`tokens.rs:153-160`).

**P3. Elevation ramp.** Define `--shadow-2xs` through `--shadow-2xl` in our `@theme` block as a tuned low-alpha ramp plus a hairline-ring token, mirroring `LS/tokens.css:662-669,758-764`. All 65 existing `shadow-*` call sites re-read the new values with zero call-site edits. Use diri's `FloatingSurface` numbers as the popover/menu reference (deep soft shadow + inset top-light). Effort: **small**. Payoff: every overlay and card in the app sharpens at once.

**P4. Icon size snapping.** Adopt three named icon sizes (14/16/20, matching our existing `--icon-nav`/`--icon-card` plus one middle step) and sweep the seven inline values onto them, following diri's `IconSize::from_legacy_points` mapping (`D/icon.rs:24-40`). Effort: **small-medium** (mechanical sweep of 527 sites, most within a few files). Payoff: uniform apparent icon weight; rows stop shimmering between densities.

**P5. Risk-tiered approval prompts.** Port the 40-line classifier (`D/status/risk.rs:10-44`): destructive / network / file-write / neutral, first match wins, case-insensitive. Style the approval UI border and the notification urgency by tier, and shorten the attention pulse for destructive (our duty-cycled `status-pulse` keyframes make this a parameter change). Lands: approval prompt component plus `N/apps/web/src/notifications/activityNotifications.logic.ts`. Effort: **small**. Payoff: dangerous approvals stop looking identical to routine ones; a genuine safety and trust feature.

**P6. Composer history recall.** Up-arrow in an empty composer steps through the last five user messages, preserving the in-progress draft under the cursor (`LS/.../composer-history.ts`, 41 lines including the cursor model). Lands: `ComposerPromptEditor` keydown path. Effort: **small**. Payoff: constant small friction removed for heavy users.

### Tier 2: medium effort, product-level payoff

**P7. Queued follow-ups with promote-to-steer.** Neokod hard-disables send while a turn runs (`N/components/chat/ChatComposer.tsx:1215,1778` gate on `phase === "running"`), so users wait or press stop before typing the next instruction. local-studio accepts messages during a run into an editable stack above the composer; each row can be edited in place, removed, or promoted to a "steer" that is delivered at the next turn boundary, and queued items dispatch only when the run would otherwise stop, never between tool calls (`LS/.../queued-message-stack.tsx:16-21` states the semantics). Lands: `ChatComposer` plus a queue in the thread store; delivery depends on what the SDK permits mid-turn, so scope the dispatch half first. Effort: **medium-large**. Payoff: the single biggest ergonomic gap between us and every polished agent app; users never sit idle behind a running turn.

**P8. Actionable notifications plus status chimes.** Our activity pipeline already classifies approval-needed / input-needed / completed / failed with coalescing, LRU, and tombstones (`N/notifications/activityNotifications.logic.ts:11-20`), but it renders only plain browser notifications. diri attaches Approve and Deny actions that answer the prompt without focusing the window, with per-agent answer keystrokes resolved from provider metadata and a safe default of omitting the button when unverified (`D/notifications.rs:205-269`). It also plays distinct synthesized chimes for needs-input versus done (two-strike bell synthesis, `D/sounds.rs:27-60`), suppresses banners only when that session is focused and the app active, and threads notifications per session (`notifications.rs:281-330`). Lands: `apps/desktop` main-process notifier (macOS notification actions require main-process delivery) plus `ActivityNotificationCoordinator.tsx`; synthesize chimes with Web Audio in the renderer. Effort: **medium**. Payoff: supervising a fleet without focusing the window, which is Neokod's core story.

**P9. MRU thread switcher (held Ctrl-Tab).** We already ship `thread.jump.1-9` and `thread.previous/next` commands (`N/packages/contracts/src/keybindings.ts:10-43`). The missing piece is recency order plus the transient overlay: open on Ctrl-Tab, cycle while held, commit on release or Return, Escape cancels, all stray keys swallowed while open. diri's state machine is 160 GPUI-free lines that port to TypeScript nearly 1:1 (`D/switcher.rs:46-165`). Lands: small store + overlay component, wired through our existing keybinding infra. Effort: **medium**. Payoff: the fastest multi-thread loop in the app, and it composes with Symphony's many-threads model.

**P10. Command palette actions layer.** Our ⌘K palette is navigation and project management only (projects, threads, sources, environments, clone; `N/components/CommandPalette.tsx`, no action commands found). Both peers treat the palette as the app's verb surface with keyword synonyms per command: diri ships New Terminal, Quick Open, Session Overview, per-project spawn, migrate-to-host, Toggle Sidebar, Settings, Check for Updates, each with keywords like "hide show panel" (`D/palette.rs:70-206`); local-studio gives every destination a keyword string (`LS/.../sessions-command.tsx:27-59`). Lands: a commands group in `CommandPalette.tsx` invoking existing actions. Effort: **small-medium**. Payoff: discoverability for everything we already can do.

**P11. Transcript snapshot for instant cold paint.** Persist a bounded, sanitized tail per thread locally and paint it on app relaunch or first thread open before live state arrives, then reconcile. Copy local-studio's caps and eviction wholesale (`transcript-cache.ts`); they encode real failure modes (quota fallback, attachment stripping, per-message sizing). Lands: the thread hydration path in `apps/web`. Effort: **medium**. Caveat: measure our current cold-open first; with server-side persistence the win may concentrate on app relaunch.

**P12. Composer status strip.** A one-line mono strip at the composer: home-relative cwd, branch (with an init-git affordance when absent), a click-to-open-diff `+adds -dels` readout, and the context meter (`LS/.../agent-composer-status-bar.tsx`). We have `ContextWindowMeter` and `BranchToolbar` already; this consolidates the always-relevant signals at the point of typing. Effort: **small-medium**. Payoff: glanceable session state without leaving the composer.

**P13. Frame-coalesced streaming.** If profiling shows per-event commits during streaming, port the coalescer semantics: merge same-kind deltas per session per frame, flush on kind switch to preserve order, cancel cleanly on epoch reset (`LS/.../effect-coalescer.ts`). Lands: wherever `apps/web` applies provider message events. Effort: **medium**. Payoff: streaming stays smooth under fast models and many parallel threads; verify need first.

### Tier 3: larger or optional

**P14. Quick Panel global composer.** A frameless, transparent, always-on-top panel window on a global shortcut: compact "home" size for dispatching a prompt, growing to a persisted thread size when a conversation starts, Escape dismisses, `type: "panel"` on macOS, positioned on the display under the cursor (`LS/frontend/desktop/logic/quick-panel-window.ts`, 170 lines of Electron; the renderer side is just a `/quick` route reusing the workspace in compact mode, `LS/frontend/src/app/quick/page.tsx`). Lands: `apps/desktop` window management plus a compact route in `apps/web`. Effort: **large**. Payoff: dispatch to the fleet from anywhere in the OS; a flagship demo feature, and the Electron half is smaller than it sounds.

**P15. Viewport-derived overlay geometry.** diri's palette computes its top inset, width, and list height from the live viewport with documented clamps, so a short window compresses the list before it ever overflows and a tall window grows it to 640px max (`D/navigation.rs:29-68`). Our palette and pickers use fixed heights. Effort: **small**, folded into any palette work.

**P16. Session cost in the chrome.** diri parses provider transcripts locally, prices them, and pins the running total in the sidebar footer ("Local agents $276" in the screenshot; `D/crates/diri-app/src/usage/` with parser, pricing, watcher). We already planned Copilot quota surfacing through `ServerProvider.usage`; the pull-in is the placement: a small always-visible footer readout beats a buried settings page. Effort: **medium** given the existing plan.

### Architectural observations worth keeping (no immediate action)

- diri's `StatusReducer` funnels every status signal (hooks, screen scrapes, PTY activity, exits, ticks) through one pure, clock-injected reducer with anti-flicker debounce: three idle confirmations at 100ms, a strong-signal shortcut, 3s startup grace, per-source authority per agent (`D/status/mod.rs:28-63`). Our equivalent logic exists distributed across `activityNotifications.logic.ts` and thread state; the reducer's testability trick (caller passes `now`) is the part to remember if that area ever gets reworked. We already model unseen completion in the sidebar (`N/components/Sidebar.logic.test.ts:717`), so diri's `DoneUnseen` concept is covered.
- local-studio hides sidebar scrollbars at rest and reveals a slim overlay thumb on container hover with `scrollbar-gutter: stable` (`LS/base.css:171-192`). We style scrollbars per surface already; the rest-hidden treatment is a cheap polish item to fold into any sidebar work.

---

## 3. What NOT to copy

1. **local-studio's live theme editor and 12-theme library.** Its runtime classifies themes by a hex-lightness heuristic with fixed overlays (`LS/lib/theme-runtime.ts:20-57`), which would dilute our verified-contrast token discipline. The critique above reached the same verdict; nothing in this pass changes it.
2. **Per-agent brand colors as row tint.** diri paints Claude clay, Gemini blue, Codex teal into working glyphs and overprints (`D/tokens.rs:196-222`). It suits a single-purpose orchestrator; for us it would reintroduce exactly the chroma noise RC2 removes. Keep provider identity in icons.
3. **afplay temp-file playback** (`D/sounds.rs:126-173`). Copy the synthesis constants; play through Web Audio in the renderer instead of shelling out per chime.
4. **Post-hydration application of persisted UI scale.** local-studio applies stored scale during store rehydration, risking a default-scale flash (the critique's persistence risk). Any appearance work of ours must apply persisted values in the pre-paint bootstrap.
5. **Translucent window materials.** diri's 0.89-alpha sidebar over live desktop content is native GPUI vibrancy with contrast compensation. Electron's vibrancy APIs are inconsistent across macOS versions and would fight our WCO titlebar geometry.
6. **`corner-shape: superellipse` squircles** (`LS/agent-composer-frame.tsx`). Still a bleeding-edge CSS feature; our composer treatment question was settled in the critique anyway.
7. **local-studio's PWA/mobile layer and model-management surfaces** (HuggingFace cards, GPU dashboards, kittylitter pairing). Different product; no Neokod equivalent to land them in.
8. **diri's dictation-free minimalism as a reason to add dictation.** local-studio's Web Speech dictation button is a nice-to-have that depends on Chromium speech services being available in Electron; park it.

---

## 4. Ranked shortlist

| #   | Item                                 | Effort       | Why it wins                            |
| --- | ------------------------------------ | ------------ | -------------------------------------- |
| 1   | P1 chat reading ladder               | small        | Largest visible surface, one file      |
| 2   | P2 neutral interaction fills         | small        | Kills the app-wide blue cast, one file |
| 3   | P3 elevation ramp                    | small        | 65 call sites sharpen with zero edits  |
| 4   | P7 queued follow-ups + steer         | medium-large | Removes the wait-for-turn dead time    |
| 5   | P8 actionable notifications + chimes | medium       | Fleet supervision without focus        |
| 6   | P9 MRU thread switcher               | medium       | Fastest thread loop; infra exists      |
| 7   | P5 risk-tiered approvals             | small        | Safety signal, 40-line port            |
| 8   | P10 palette actions layer            | small-medium | Discoverability of existing verbs      |
| 9   | P4 icon size snapping                | small-medium | Uniform icon weight                    |
| 10  | P12 composer status strip            | small-medium | Glanceable state at point of typing    |
| 11  | P11 transcript cold-paint cache      | medium       | Instant relaunch; measure first        |
| 12  | P6 composer history recall           | small        | Cheap daily friction removal           |
| 13  | P14 quick panel                      | large        | Flagship, after the fundamentals       |

## Appendix: new key files consulted this pass

diri: `crates/diri-app/src/notifications.rs`, `sounds.rs`, `switcher.rs`, `navigation.rs`, `history.rs`, `worktrees.rs`, `sidebar/state.rs`, `fonts.rs`, `macos/sf_symbols.rs`; `crates/diri-ui/src/icon.rs`, `components.rs`, `tokens.rs` (Ink/Fill/Motion/MemoryFormat); `crates/diri-engine/src/status/mod.rs`, `status/risk.rs`; `docs/images/diri.png`.

local-studio: `frontend/src/features/agent/ui/queued-message-stack.tsx`, `composer-history.ts`, `sessions-command.tsx`, `agent-composer-status-bar.tsx`, `timeline/activity-grouping.ts`; `features/agent/workspace/session-drafts.ts`, `transcript-cache.ts`; `features/agent/runtime/effect-coalescer.ts`, `prompt-stream.ts`; `features/shell/use-app-update.ts`; `hooks/realtime-status-store.ts`; `app/styles/globals/base.css`, `chat.css`, `tokens.css` (elevation ramp); `desktop/logic/quick-panel-window.ts`; `app/quick/page.tsx`.

Neokod: `apps/web/src/index.css`, `components/chat/ChatComposer.tsx`, `components/chat/MessagesTimeline.tsx`, `components/ChatView.tsx`, `components/CommandPalette.tsx`, `notifications/activityNotifications.logic.ts`, `notifications/browserNotification.ts`, `keybindings.ts`, `composerDraftStore.ts`, `pendingUserInput.ts`, `packages/contracts/src/keybindings.ts`, `packages/client-runtime/src/state/runtime.ts`, `components/Sidebar.logic.test.ts`.

# Final UI plan (orchestrator synthesis) — 2026-08-06

Synthesis of the four passes above (Opus comparison, sol critique, Fable deep dive, sol deep dive).
Items appear here only if at least two passes support them or one pass found them with file-level
evidence and no pass objected. Detailed rationale lives in the sections above.

## Phase 1 — small changes, highest visible payoff

1. Chat reading ladder: 15-16px prose with weight-led headings, zeroed tracking, antialiasing.
   Chrome stays 12px. (index.css; both deep dives, top item.)
2. Chat header budget: title + inline rename stay, secondary actions (scripts, Open In, Git)
   collapse into one overflow menu. (ChatHeader.tsx; sol deep dive #1.)
3. Neutral interaction fills: hover/selected via fg-mix, not brand-blue mix; chroma reserved for
   status and accent moments. (index.css tokens; Fable deep dive #2, sol value-structure diagnosis.)
4. Motion budget: Ultrathink becomes a static accent, drop composer hover scaling, one pulse
   source max; keep the reduced-motion contract. (index.css, ComposerPrimaryActions; both.)
5. Owned elevation ramp overriding shadow-\* in @theme; all 65 call sites sharpen without edits.
   (Fable deep dive #3.)
6. Named motion tokens, then sweep the 11 transition-all uses. (Both, plus original report #2.)
7. Error states: preserve stale data on refresh failure (error && !data distinction) and add retry
   through the existing EmptyContent button slot; no new abstraction. (sol critique top pick.)
8. Preload right-panel modules on pointerenter/focus intent. (sol deep dive #5.)
9. Undo-archive toast + reopen-last-thread shortcut on the existing unarchive path. (sol #4.)

## Phase 2 — medium, sequenced after Phase 1

10. Chat text size / line height / column width controls in General settings, driving the
    existing chat tokens. No new Appearance route yet. (sol critique #3.)
11. Queued follow-ups with promote-to-steer; composer stops hard-disabling send during a run.
    (Fable deep dive #4; the largest ergonomic gap vs peer apps.)
12. MRU Ctrl-Tab transient thread switcher on the existing jump infra. (Both deep dives.)
13. Frame-coalesced streaming: apply events in order, publish to React at most once per frame.
    Profile first. (Both deep dives.)
14. Renderer crash self-recovery: reload-once guard + hashed-chunk recovery beside the existing
    detection in DesktopWindow.ts. (sol deep dive #3.)
15. Status taxonomy and contrast cleanup: centralize genuine success/warning/info roles, keep the
    merged/terminal distinct hues, use success-foreground on light theme (3.36:1 trap). (sol
    critique #2 with its corrections.)

## Phase 3 — larger, deliberate design calls

16. Master-knob token derivation (--ui-scale, clamped --radius-base for the subtractive ramp),
    then an Appearance route. Blocked on 1 and 15 landing first.
17. Page-shell consolidation for the symphony routes (settings already has one; only symphony
    duplicates header rhythm).
18. Packaged desktop performance gate in CI per diri's PERF.md model (idle CPU, memory ceilings,
    resize churn).

## Do not do

Floating composer (reverses documented quiet-surface decision), live theme editor, per-agent row
chroma, vibrancy materials, superellipse corners, replacing the keybinding engine / LegendList
timeline / warm snapshots, weakening contrast-verified tokens, localStorage transcript cache,
literal one-resident-surface preview limit.
