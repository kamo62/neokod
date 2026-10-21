Now Harp source: vertical_tabs.rs, telemetry.rs, tests, README, limit-rings.md, releases.# Opus 5.5 review: Harp design and dev source at `2f70e8bf2`

The design review and the source review are both complete, read-only. I found no new P0 to P2 source defects at `2f70e8bf2`, only two P3 items. I recommend 12 own-component design changes, deferring the limit rings and the tmux/terminal shell.

## 0. Identity and boundaries

- **Model:** this session is `github-copilot/claude-opus-5.5` in OpenCode. I can't see the effort setting from inside the session, so "high" rests on how the session was launched.
- **Nothing written:** no files, builds, tests, installs, app launches, commits, pushes, subagents or messages.
- **One external read:** I fetched two public OpenCode v1.19.3 source files (`session/prompt.ts`, `session/run-state.ts`) to check a protocol ordering claim. Nothing was posted or sent.
- **Pending fixes:** the dev branch head moved to `b22dd935d` while I was reviewing. It adds the three pending fixes: the guarded finalizer, the bounded probes and the locked maintenance recheck. I did not review those commits. The files I cite are identical at `2f70e8bf2` and `b22dd935d`; I confirmed this with `git diff --quiet`.
- **Images not inspected:** the light Harp variants and the working-rings GIF are not in the local folder, so I couldn't inspect them.
- **Three kinds of evidence, kept separate below:**
  - **Image judgement:** what the screenshots show.
  - **Source proof:** what the code does when read statically.
  - **Absent runtime evidence:** nothing was run in either Harp or Neokod.

## 1. Harp design review

### 1a. Image judgement (screenshots only)

**Harp `hero-dark`, `sidebar-dark`, `limit-rings-dark`:**

- **Layout:** two panes. The sidebar is about 18% of the window.
- **Groups:** quiet grey headings with a muted count ("Launch 4"). An orange "1 needs you" sits on the right edge of the same line.
- **Rows:** title on the left; time and one 15 px glyph aligned on the right. There are no other per-row icons. The selected row has a lighter rounded surface. Row spacing is generous.
- **Glyphs:**
  - Working: a spinning arc.
  - Needs you: an orange target.
  - Unread done: a filled tick with a bold title.
  - Read done: a bare grey tick.
  - Set aside: a moon with a dimmed title.
  - Background work still running: a small grey dot on the tick (`stripe-webhooks`).
- **Main pane header:** "landing-hero ~/code/launchpad" and "Working · 1m".
- **Limit rings:** two footer rings, "Claude" and "Codex". The hover card reads "5 hours 84% · resets 3:12 PM" and "Week 27% · resets Sat". It shows no observation time. The Claude ring looks dimmer than Codex, but I can't tell from the picture whether that means stale.

**Owner image 1 (stage graph):**

- Ticket → Architect → Critic, with a revise arc labelled "approved in round 3" and a "9/10" score.
- Then two packages, each with an Implementer and a Tester under a critic, feeding Integrate (unit, integration, end-to-end).
- A Review hub with facets: Alignment, Codex second model, Correctness, Testing, Production, Architecture, Security, and "Fix, then review again".
- Merge has "PR ready" and "CI green" checkboxes, and a human makes the final merge.
- A stage stepper runs along the bottom. The Pause/Restart/0.5x/1x/2x controls show it is an animated demo.

**Owner image 2 (repair loop):** generate → self-verify → second agent reviews → automated checks → "All clear?". Yes leads to Ship. "No, resolvable" loops back to generate. "No, novel issue" goes to human review, then back to generate.

**Owner image 3 (agent tree):**

- Header: "7 agents · 2 running · 1 needs you · 1 failed · $1.31". The top-right figure is $1.31.
- Each node shows its model, its state and "$cost · elapsed".
- The orchestrator node also shows $1.31, while the six children only add up to $0.84. The orchestrator figure is therefore an unlabelled total, not its own cost.

### 1b. What Harp's code actually does (source proof, pinned `bad92b3`)

- **Status ranking:** needs you, then working, then done, then pending, then shell or idle (`vertical_tabs.rs:9185-9193`).
- **Set aside hides "needs you":** both `tab_status` and `row_status` check the inactive flag before any blocked status (`:9222`, `:9241`). A set-aside tab therefore stops counting towards "needs you". **Do not copy this.**
- **Failure looks like success:** Error and Cancelled map to Done (`:9177-9179`), so a failed run shows the same tick as a successful one. **Reject this.**
- **Hidden panes don't count:** the attention check only looks at visible panes (`tab_needs_attention`, `:1279-1290`).
- **Row time is not elapsed time:** it is the time since the last status change (`relative_time`, `:9256-9277`). "Working · 1m" in the card means the status changed a minute ago, not that the agent has worked for a minute.
- **Limit rings:**
  - A window whose reset time has passed is hidden.
  - A missing window is drawn dashed.
  - A reading older than 15 minutes is shown as stale, with no numbers.
  - Percentages are rounded down; the 80% "hot" threshold uses the exact value (`:11158-11241`).
  - Harp edits `~/.claude/settings.json` to capture Claude's numbers (README). **Reject that for Neokod.**
- **Keyboard:** I found no keyboard path for group headers; they are mouse-only (`:3559-3577`).
- **Scope of the 0.1.3 "needs you that stays" fix:** it lives in the CLI agent session model, which is not in the pinned files I had. I can only confirm it from the release notes.

### 1c. Neokod today (source proof)

- **Stable order already:** thread order uses the time of the latest user message (`threadSort.ts:57-67`), so streamed status changes do not reorder rows.
- **One lifecycle function:** `deriveThreadLifecycle` puts awaiting approval or input first.
- **No "needs you" count on project headers:** a project header shows only the single highest-priority dot, and only while the project is collapsed (`Sidebar.tsx:2373-2393`).
- **Archived threads drop out:** the project status ignores archived threads (`Sidebar.tsx:1351-1357`).
- **Unknown status is invisible:** an `unknown` lifecycle renders no pill (`Sidebar.logic.ts:557`).
- **Never-visited threads never show "Completed":** `hasUnseenCompletion` returns false when there is no last-visit time (`Sidebar.logic.ts:218-227`). Server-created threads, such as Symphony runs and the planned W6 children, will therefore never show an unread completion.
- **Dismissing can hide a new approval:** My Work's dismiss signature records only pending-approval and pending-input flags (`SidebarMyWork.logic.ts:10-20`). A second approval on the same turn produces the same signature, so it stays hidden.
- **Subagent timing is already right:** `SubagentsPanel.logic.ts` already has the correct live / exact / last-observed / unknown timing.
- **Reduced motion is handled:** a global stylesheet rule stops looping animations (`index.css:1167`).
- **Symphony Attention view:** approve and reject are fire-and-forget (`void`). When a refresh fails but older data exists, the older data is shown with no freshness marker. This is existing main code, not part of the dev diff.

### 1d. Accept / adapt / defer

| Pattern                                          | Verdict                                                                | Neokod target                                                                                                                                                  | State and evidence contract                                                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calm rows: title, time, one status glyph at rest | Adapt                                                                  | `Sidebar.tsx` thread row (around lines 700-960)                                                                                                                | Show secondary icons (PR, worktree, ports, pin, archive) on hover or focus, or in the tooltip, never by default. Presentation only.                                                                                     |
| Stable row positions                             | Accept current behaviour                                               | `threadSort.ts`                                                                                                                                                | Order changes only on a user message or a manual reorder. Add one pure test: a status-only change keeps the order.                                                                                                      |
| Group count "N need you"                         | Adapt                                                                  | New pure counter beside `resolveProjectStatusIndicator` in `Sidebar.logic.ts`; render on the project header in both states, and as the collapsed-sidebar badge | Count threads whose lifecycle is awaiting. Include archived and hidden-overflow threads. If the shell data is unavailable, show "–", never 0.                                                                           |
| Needs-you stays until resolved                   | Accept the intent; avoid Harp's override                               | `deriveThreadLifecycle`, `SidebarMyWork.logic.ts`                                                                                                              | Nothing the user does to set a thread aside (archive, dismiss, collapse) may hide unresolved approval or input. The My Work dismissal key must include the pending request IDs.                                         |
| Unread, done and set-aside kept separate         | Adapt                                                                  | `hasUnseenCompletion`, `ThreadStatusIndicators.tsx`                                                                                                            | Unread is local presentation metadata. Missing last-visit time means unread, not seen. Failed and stopped always show. Defer a new "inactive" axis; archive covers it for now.                                          |
| Distinct glyph shapes, not colour alone          | Adapt                                                                  | `ThreadStatusLabel` compact mode (currently a 9 px dot)                                                                                                        | One glyph per lifecycle phase, plus a muted "unknown" glyph only when a session exists but the state is unknown.                                                                                                        |
| Time semantics                                   | Adapt                                                                  | Sidebar row time, W6-C5 rows, D-5 lineage                                                                                                                      | One meaning per surface, named in the tooltip ("Last message 4m ago"). Lineage rows reuse the `SubagentsPanel.logic` timing: ticks while active, frozen when terminal, "last observed" when orphaned, "–" when unknown. |
| Limit rings                                      | Defer until a per-window allowance projection exists (plan section 12) | Later: provider footer. Now: `providerStatus.ts`                                                                                                               | Show provider, window, known reset and observation age. A passed reset hides that window. Unknown is a dashed track, not 0%. No reading of credentials or settings files.                                               |
| Group header keyboard access                     | Neokod already ahead                                                   | Existing project-button and row key handlers                                                                                                                   | The count is text with an accessible name. Status updates never move focus or change tab order.                                                                                                                         |
| Reduced motion                                   | Accept current behaviour                                               | `index.css`                                                                                                                                                    | With motion reduced, Working and Connecting still differ by label.                                                                                                                                                      |
| Symphony Attention                               | Adapt the same calm grouping                                           | `SymphonyAttentionView.tsx`                                                                                                                                    | Group items by project or run with the same count. Await the approve/reject result and keep failures visible. Stale data carries an "observed at" marker.                                                               |
| Agent-tree header counts (image 3)               | Adapt for D-5 / W6-C5                                                  | New managed-children section, not `SubagentsPanel`                                                                                                             | Counts come from authoritative child states. Cost shows "not reported". No totals while any part is unknown; label own versus total cost.                                                                               |
| Stage graph and repair loop (images 1-2)         | Adapt per plan 16.7                                                    | D-1/D-3/D-4 views                                                                                                                                              | Stage nodes are not counted as agents. Scores and "round N" appear only from recorded evidence. Replay and speed controls are dropped.                                                                                  |
| Terminal/tmux continuity; Warp cloud             | Defer / reject                                                         | n/a                                                                                                                                                            | Out of local-first scope now.                                                                                                                                                                                           |

### 1e. Visual acceptance criteria

Check these through Computer Use against these screenshots, at sidebar widths of 220, 280 and 360 px, in light and dark themes:

1. With 3 projects × 6 threads, the resting rows show only the title, time and one glyph.
2. Streaming in another thread does not move any row and does not change keyboard focus.
3. An approval pending in a collapsed project, in an archived thread or in a hidden overflow row still counts in "N need you".
4. A dismissed My Work item reappears when a new approval arrives on the same turn.
5. Another child completing does not clear a pending approval or input, either in the count or on its row.
6. A failed row never shows the completed glyph. A never-visited thread that completes shows as unread.
7. A session with unknown lifecycle shows the unknown glyph. A brand-new thread shows none.
8. Every glyph and count has an accessible name. Text contrast is at least 4.5:1 and glyph contrast at least 3:1. With reduced motion on, the states are still distinguishable.
9. At 220 px the title truncates first; the count, time and glyph stay visible, with no horizontal scroll.
10. A limit display whose reset time has passed no longer says "Resets <time>". Every limit shows when it was observed.
11. A lineage row's elapsed time freezes on terminal, reads "last observed" when orphaned, and shows cost as "not reported" with no totals.

## 2. Dev source review: `2f70e8bf2` against `main f2ad1498d`

**Covered:** the unreviewed deltas `fec38aa0c` (idle-first Stop), `2f70e8bf2` (late abort attribution) and the non-pending parts of `e5be6846d`, with their callers. I also spot-checked the U-03 review roots, the X-3 web limit card and the server wiring. I did not repeat findings Sol has already closed.

**No new P0 to P2 defects found.**

- **Late abort attribution:** the stuck-mark scenario I checked does not happen on v1.19.3. Cancelling a session that is not running still publishes `idle` (`run-state.ts` cancel: `if (!existing) status.set(idle)`), so a terminal echo always arrives. The worker's stated limit remains: an external abort of the new turn before its first event looks the same as the old echo. Versions of 1.x older than 1.19.3 were not checked.
- **Idle-first Stop:** pending-request closure is routed once through `settleInterruptedTurn`. No defect found.

### Remaining P3 items

1. **Stale usage-limit card**
   - **Where:** `apps/web/src/components/settings/providerStatus.ts:60-72`.
   - **Trigger:** a Claude limit with a known reset time. The reset time passes before the next server refresh (`ClaudeDriver.ts:71`, every 5 minutes).
   - **Impact:**
     - For up to 5 minutes, the card says "Usage limit reached. Resets <past time>". `observedAt` and the window name are never shown, which is stale data without freshness metadata (state-and-evidence).
     - The limit check also comes before the `unauthenticated` check (line 80), so a revoked login reads as a usage limit.
2. **Review preview scans every project and thread on each call**
   - **Where:** `apps/server/src/review/ReviewService.ts:64-90` and `:107`.
   - **Trigger:** any diff preview whose `cwd` lies outside `config.cwd` and `worktreesDir`.
   - **Impact:**
     - Every preview reads all projects, then every thread row project by project, one query at a time, then resolves every root path sequentially. Cost grows with total thread count on every call.
     - One unreadable root (EACCES) fails every preview outside the server workspace.

**Excluded as pending (not approval candidates):** the Effect spawner automatic finalizer, the command-time maintenance check inside the queue lock, and the bounded OpenCode version probes. One input for whoever closes the maintenance item: an unknown probe result still lets the legacy updater run, which state-and-evidence would treat as fail-open for a destructive action.

## 3. Evidence not available

- No Harp or Neokod runtime run, no rendered UI, no live provider turn.
- Harp's light images and GIFs, and its 0.1.3 session-model code, were not available.
- The image judgements above come from static images only.
- No completed approval of the dev branch is implied. The P3s and the three pending items still need a narrow closure.
