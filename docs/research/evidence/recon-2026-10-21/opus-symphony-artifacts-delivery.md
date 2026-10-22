Context is read. Now I'll write the shared fixture data first, since all three concepts should project the same facts.Two writes with no content have failed, so I'll write in smaller files and check after each one.Next is shared.js, which holds the icons, theme, notice, toast and status helpers.Now style.css, with the tokens and shared primitives only. Each page's layout CSS will live in its own file.The shared tokens are written. Next is Concept A: runs.html first, then its CSS and JS.Next is runs.js, which handles state, filtering, the listbox keyboard model and the per-run actions.Concept A is written. I need a small fix to style.css first: the observed-native tag has no border, so its dashed style doesn't show.Before Concept B, I'm exporting the raw icon bodies so the SVG map can draw status icons inline.That edit dropped the `pill` export. Restoring it:The export is fixed. Now Concept B, starting with workflow.html:Next, workflow.css:Next is the map data for Concept B: layouts, step details, edges and agents.Now workflow.js, which handles rendering, selection, keyboard movement, zoom and pan, popovers and the decision panel.Wrapping the hash updates so a file:// restriction can't break the page:The inspector note says C3 appears on four steps, but the data has three in the expanded view and two when folded. I'll compute it instead:Concept B is done. Now Concept C, starting with its static shell:Next is planning-data.js, with the plan revisions, decisions and evidence:Next, planning.css:Now planning.js, which handles the document render, editing, revisions, decisions with the separation rail, evidence and the rail.Removing the beforeunload guard so Chrome's native leave-page dialog can't appear during review:Next is index.html, the concise concept chooser with a small wireframe for each layout:Last file: DESIGN.md.I've built the index page, the three concept pages and DESIGN.md in `docs/design/symphony-exploration-2026-10-21/`, but I have not opened any of them. I only had file read and write access here, so nothing was rendered, run or checked in a browser. Layout, SVG label collisions, dark-mode contrast, narrow widths and whether the JavaScript runs without errors all need Sol's check in Chrome.

All pages work offline from `file://`, with no build, CDN or font downloads. Every action changes in-memory demo state only, and **Reset demo** clears it. The only thing saved between visits is the light/dark choice, under the key `neokod-symphony-proto:theme`. No file outside that folder was touched.

## Files created

| File                                                               | Purpose                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `index.html`                                                       | Concept chooser: a small wireframe per concept with what it is good and weak at                                          |
| `runs.html`, `runs.css`, `runs.js`                                 | Concept A: runs                                                                                                          |
| `workflow.html`, `workflow.css`, `workflow-data.js`, `workflow.js` | Concept B: workflow map                                                                                                  |
| `planning.html`, `planning.css`, `planning-data.js`, `planning.js` | Concept C: plan and decisions                                                                                            |
| `style.css`, `shared.js`                                           | Colours and spacing from `index.css`, icons, status labels, theme toggle, toast messages                                 |
| `fixtures.js`                                                      | One shared sample dataset (NEO-4821, attempt 3, head `7f3a9c2`, decision D-3), so all three concepts show the same facts |
| `DESIGN.md`                                                        | Colours and type, layout sketches, trade-offs, interaction guide, status meanings, limits                                |

## How the concepts differ

- **A. Runs:** a one-line run list with a six-tick stage strip per row. "Needs you" is pinned above it and no filter can hide it. The side panel leads with the current blocker and next action, then the task, attempt and head, validation, review, agents and recent events.
- **B. Workflow map:** six stage columns for one work item. It has two package lanes, a "sent back" loop in design, a repair loop to package B and a two-round review with an Escalate step. The human merge gate has a double outline. An inspector shows evidence, agent and lineage, and other runs are reached through a small switcher and a "Needs you" popover.
- **C. Plan and decisions:** an editable plan with revisions, an inline send-lifecycle diagram and a Decisions view. That view keeps draft answer, saved decision and execution approval as three separate steps. A side rail shows stages, the agent tree and approvals.

**Recommendation, not a selection:** A as the daily default, B as the detail view opened from a run, and C attached to a work item rather than as its own top-level mode. If only one is built, A has the least risk and the most daily use. The owner decides.

## Checklist for Sol's Chrome review

1. **Index:** the three wireframes and links work, and the theme toggle still applies after moving between pages.
2. **Status rules, all pages:** unknown, superseded and not-run results never show green. Cost reads "Not reported". Tracking-lost items say "Last observed" with frozen times. The "Design prototype · Sample data" notice is visible.
3. **A, filters and keyboard:**
   - `/` focuses search, and the arrow keys move through the run list.
   - Status chips, the Active/History/All switch and the workflow filter all change the list.
   - "Needs you" stays visible under every filter.
4. **A, the decision:** save D-3. It should move to "Resolved in this session" while the other three items stay. Resume and Reopen should each be separate steps.
5. **A, other runs:** NEO-4790's stop request keeps it marked "Tracking lost". NEO-4785 asks for confirmation before a retry. NEO-4776's merge approval does not merge anything.
6. **A, narrow screens:** below 900px the sidebar becomes a row of buttons and the run panel opens over the list with a "Back to runs" button.
7. **B, readability:** at the default zoom, check edge labels and package labels for overlap, especially "Repair round 1 of 2" and "Asked 14:26".
8. **B, controls:**
   - Clicking a step and using the arrow keys both select steps.
   - Enter moves focus into the inspector.
   - `+`, `−`, `0` and `F` match the zoom buttons, and dragging the background pans.
   - Fold packages and Show packages work.
   - The stage stepper, the switcher and the "Needs you" popover respond.
   - Other runs show only a stage outline and say so.
9. **B, the decision:** saving D-3 in the inspector changes the decision step and its edge only. Package B stays paused and nothing moves forward on its own.
10. **C, plan editing:**
    - Edit the plan and save it as r6. The r5 execution approval should then show as superseded.
    - Deleting the "## Send lifecycle" heading should make D-2 and D-3 show as unresolved.
    - Viewing r4 and "Restore as a draft" work, without saving anything.
11. **C, decisions:**
    - Save draft, then Save decision.
    - Step 3 should unlock only after saving, and approval should need the scope checkbox.
    - Reopen should keep the previous answer and supersede any approval already given.
12. **C, navigation:**
    - Decision, agent and evidence chips navigate to the right place, and "Used by" links go back.
    - The diagram's branch after "Delivery unknown" follows the saved answer, while the plan text stays unchanged.
13. **Dark mode, reduced motion and focus outlines** on all four pages.

Main still owns plan.md updates, commits and integration. No app code was implemented.
