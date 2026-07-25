# Neokod design-system pass

Source: design direction (2026-07-24).

```
- SF Pro in regular and medium, -0.15px letter spacing
- Type at 12px, 13px, 14px, and 24px
- Hierarchy with #292929, #5D5D5D, and #9E9E9E
- Icons at 14px for navigation, 20px for cards
- 8px navigation, 16px cards, rounded pill CTA radii
```

All five rules refine the existing token layer in `apps/web/src/index.css`. This is our own design decision, not an upstream port, so the local-first no-UI-port policy does not block it. Nothing here is implemented yet. This doc is the plan for review.

## Current token state (`apps/web/src/index.css`)

- Font (`:39`): `--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`. On macOS/Electron `-apple-system` already resolves to SF Pro. No letter-spacing token today.
- Type scale (`:329-333`): `--font-size-meta: 10px`, `--font-size-ui-sm: 11px`, `--font-size-ui: 12px`, `--font-size-chat: 13px`.
- Light text (`:317-319`): `--text-primary: #1a1c1f`, `--text-secondary: #5d5d5d`, `--text-tertiary: #8a8a8a`.
- Dark text (`:381-383`): primary `#ffffff`, secondary `#a8a8a8`, tertiary `#737373`.
- Radius (`:97-103`, base `:309`): base `0.625rem` (10px); `radius-md` = 8px, `radius-lg` = 10px, `radius-xl` = 14px, `radius-2xl` = 18px. No 16px step, no pill token (pills use `rounded-full` inline).
- Icons: no size tokens. Sized inline per component (`size-4` = 16px, `size-3.5` = 14px, etc.).

## Rule-by-rule mapping

### 1. Font: SF Pro regular + medium, -0.15px tracking
- Add `--tracking-tight: -0.15px` and apply `letter-spacing: var(--tracking-tight)` on `body`.
- Optionally prepend `"SF Pro Text", "SF Pro Display"` to `--font-sans` for explicit naming; `-apple-system` already covers Apple platforms so this is belt-and-suspenders.
- Weight pairing is regular (400) and medium (500). Today headers use semibold (600) (`index.css:586`, chat-markdown `h*`). Decision D3 below covers whether to soften those to 500.

### 2. Type scale 12 / 13 / 14 / 24
- The spec names four sizes. The current scale has four too (10/11/12/13) but skewed smaller and with no display size.
- Proposed mapping: raise the floor `ui-sm` 11 to 12, keep `ui` 12 and `chat` 13, add a 14px comfortable/body-large token, add a 24px display/section-heading token. `meta` 10px is the open question (Decision D1): keep it for dense metadata, or raise to 12 and drop 10/11 entirely.

### 3. Text hierarchy #292929 / #5D5D5D / #9E9E9E
- Light mode: `--text-primary` `#1a1c1f` -> `#292929` (softer black), `--text-secondary` stays `#5d5d5d` (already an exact match), `--text-tertiary` `#8a8a8a` -> `#9E9E9E` (lighter).
- Two-line change in the `:root` light block.
- Dark mode: the spec values are light-on-white, so dark stays as-is unless we want symmetric softening (Decision D2).

### 4. Icons 14px nav / 20px cards
- Add `--icon-nav: 14px` and `--icon-card: 20px`.
- Sweep navigation surfaces (Sidebar, workspace topbar, right-panel tab chips) to 14px and card surfaces to 20px. Medium effort, touches many components.

### 5. Radii: 8px nav / 16px cards / pill CTAs
- Navigation 8px maps to the existing `radius-md`.
- Cards 16px: add a `--radius-card: 16px` token (sits between `xl` 14 and `2xl` 18).
- CTAs: normalize primary action buttons to `rounded-full`.

## Decisions to confirm before implementing

- **D1 — density floor.** Does 12/13/14/24 replace the 10/11 metadata sizes (raising the smallest text to 12px, less dense but more legible), or should `meta` 10px / `ui-sm` 11px survive for dense rows (turn chips, status metadata)?
- **D2 — theme scope.** The colour values are light-mode. Apply the softening to light only, or derive matching dark-mode values? Neokod is dark-first for developers, so dark is the more-used theme.
- **D3 — emphasis weight.** Move header/emphasis weight from semibold 600 to medium 500 (softer, matches "regular and medium"), or keep 600 for headings and apply regular/medium only as the base body pairing?

## Rollout order (once decisions land)

1. Token layer in `index.css`: tracking token, type-scale tokens, softened text colours, icon-size tokens, card-radius token. Self-contained, reviewable in one diff.
2. Icon sweep: nav 14px, cards 20px.
3. Radius sweep: cards 16px, CTAs pill.
4. Weight audit per D3.
5. Visual pass across sidebar, composer, right panel, model/thread pickers.
