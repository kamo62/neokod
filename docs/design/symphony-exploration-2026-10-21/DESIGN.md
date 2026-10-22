# Symphony layout exploration, 21 October 2026

Status: design prototypes with sample data. The follow-up below recommends one combined flow. These files do not implement or change the app.
Plan reference: `plan.md` sections 16.7, 16.9 and 16.10.

22 October follow-up: the owner likes all three concepts and identifies B as detail within A. Sol and onboard Opus recommend composing them into one product, with a **Work** intake before execution. The owner subsequently requested the concrete artifact. `work.html` is that combined interactive demonstration: select issues, assign target machines and implementers, review the submission, then explicitly queue demo work. A monitors runs; B is the selected run's Execution tab; C is its Plan and decisions tab, available before and during execution. The standalone A/B/C pages remain detailed examples, separate from a newly queued demo attempt. Machines shown in Work are fictional sample servers, not discovered or authenticated real devices. The canonical production technical decision, delivery gates and acceptance criteria remain in `plan.md` section 16.11.

## Work intake composition

Work follows the same system type, blue selection accent and quiet status palette as the earlier views. The issue list is the main surface; a selected-item inspector carries acceptance criteria and assignments. Machine and agent choices sit with the issue they affect. Launch preview is a separate explicit step, with blocked items kept visible. This extends the existing workbench rather than adding a dashboard of cards or a fourth product mode.

The intended interaction check is: select two visible issues; inspect acceptance criteria; set different target machines; confirm an offline or unsupported target blocks its item; save and reload the draft; preview ready work; change an assignment and confirm the old preview is invalid; preview again and queue demo work; inspect its pinned machine, agents and local receipt; move between Summary, Execution, Plan and Evidence. Saving a plan never starts work. The full workflow/plan examples must identify their original example attempt instead of presenting it as the newly queued work.

All checks in Work are simulated against fixed fixtures. No tracker, access token, provider, server admission, validation command, process launch or real queue is used. Draft persistence is browser-local and resettable. The prototype is not proof of production machine routing or OpenCode Symphony integration.

Open `index.html` in Chrome directly from disk (`file://`) or from any static server. There is no build step, dependency, font
download or network call. All interactions change in-memory demo state, which resets on reload or with **Reset demo**. Only the
light/dark preference is stored, under the `localStorage` key `neokod-symphony-proto:theme`.

## Files

| File                                                               | Purpose                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `index.html`                                                       | Concept chooser with a small wireframe and trade-offs for each layout |
| `runs.html`, `runs.css`, `runs.js`                                 | Concept A: run-first operating view                                   |
| `workflow.html`, `workflow.css`, `workflow-data.js`, `workflow.js` | Concept B: workflow map                                               |
| `planning.html`, `planning.css`, `planning-data.js`, `planning.js` | Concept C: plan and decisions workspace                               |
| `style.css`                                                        | Shared tokens and primitives (buttons, status pills, choices, toast)  |
| `shared.js`                                                        | Icons, status vocabulary, theme toggle, toast                         |
| `fixtures.js`                                                      | One shared sample world, so the three concepts show the same facts    |

## Design plan

### Subject and job

The audience is one owner running Neokod locally, supervising Symphony runs that agents execute under a workflow policy. The job
is to see what needs a human, decide it with the right evidence in view, and never be misled into thinking work is done, approved
or safe when evidence is missing. The vernacular is commits, attempts, heads, validation, review rounds and agent lineage, so
that vocabulary carries the design rather than decoration.

### Tokens

Colour follows `apps/web/src/index.css` so the prototypes stay in the Neokod family.

| Name                 | Light                      | Dark                       | Use                                         |
| -------------------- | -------------------------- | -------------------------- | ------------------------------------------- |
| Canvas               | `#ffffff`                  | `#181818`                  | Main working surface                        |
| Panel                | `#f7f7f7`                  | `#1f1f1f`                  | Sidebars, inspectors, rails                 |
| Ink                  | `#292929`                  | `#f2f2f2`                  | Primary text, primary buttons, selected tab |
| Accent (Neokod blue) | `#339cff` (text `#0b6bcb`) | `#339cff` (text `#6cb6ff`) | The one accent: selection, focus, running   |
| Attention amber      | `#f59e0b` (text `#b45309`) | `#f59e0b` (text `#fbbf24`) | Needs you only                              |
| Tracking-lost slate  | `#5b5f86`                  | `#a5a9d6`                  | Orphaned only, always dashed                |

Red, green and violet appear only as status hues (failed, host-passed at current head, merged), never as decoration.

Type uses the app's system stack (`-apple-system`, Segoe UI, Roboto) at workbench sizes: 11px meta, 12.5px interface, 13 to 14px
reading text, 17px panel titles, 22px document title. Monospace is used only for real code values (heads, branches, commands,
paths), not as a label style. Labels are sentence case; there are no all-caps eyebrows.

Layout is a dense desktop workbench: a fixed top bar, then three regions whose roles differ by concept. Content is left aligned
throughout. Radii follow hierarchy: 5 to 6px controls, 8px rows and choices, 10 to 12px for the one emphasised block per view.

### Principles

1. One semantic projection, many surfaces. Every concept reads the same fixture and the same status vocabulary.
2. Spend emphasis in one place per concept: the current-blocker block (A), the map's blocked edge and decision node (B), the
   three-step separation rail (C). Everything else stays quiet.
3. Evidence is never a default. Unknown, superseded, not run and agent-reported results never use green.
4. Actions name what they do and say what they do not do. No action silently advances a run, starts work or merges.
5. No ambient motion. Nothing pulses or ticks. The only transitions answer a user's action, and reduced motion removes them.

### Review against the brief

The first plan used a card per run in Concept A and a full-height decision drawer. Both read as the generic card-kit dashboard,
so A became a single-line list with a six-tick stage strip, and the decision moved inline into the current-blocker block. An
early idea to give Concept C a serif document face was dropped: plans already render in the app's sans stack, and a serif would
have made C look like a different product rather than a different structure. Stage headers in B first used tracked capitals,
which were replaced with numbered sentence-case names, because stages really are an ordered sequence.

## The three information architectures

### A. Runs (`runs.html`)

```
┌ top bar ──────────────────────────────────────────────────────────────┐
│ Project   │ Search · Active/History/All · status chips  │ Selected run │
│ Workflows │ ┌ Needs you (pinned, ignores filters) ──────┐│ ID, title    │
│  All   3  │ │ ! NEO-4821 Decision needed …             ││ ┌ Current ──┐│
│  Core  2  │ │ ◌ NEO-4790 Tracking lost …               ││ │ blocker   ││
│  …        │ └──────────────────────────────────────────┘│ │ next step ││
│           │ Active                                      │ │ action    ││
│ Keyboard  │ ! NEO-4821 Preserve queued…  ▮▮▮▯▯▯  14:26 │ └───────────┘│
│           │ ○ NEO-4807 Retry provider…   ▮▯▮▯▯▯  14:02 │ Root task    │
│           │ …                                           │ Attempt/head │
│           │                                             │ Validation…  │
└───────────┴─────────────────────────────────────────────┴──────────────┘
```

The list is primary. Rows are one line plus a status sub-line, not cards. Needs you is pinned above the list and is never hidden
by workflow, status or search filters. The side panel leads with the current blocker and the next meaningful action, then root
task, exact attempt and head, validation with heads, review findings, agents and recent events.

### B. Workflow map (`workflow.html`)

```
┌ top bar ───────────────────────────────────────────────────────────────┐
│ [NEO-4821 ▾] Attempt 3 of 4 · Head 7f3a9c2 · 6 stages, 5 agents  [Needs you 4] [Fold] − 100% + Fit │
├ 1 Intake │ 2 Design      │ 3 Build                 │ 4 Integrate │ 5 Review   │ 6 PR ─┬ Inspector ┐
│          │   ╭ sent back ╮│ ┌ Package A ──────────┐ │             │            │       │ kind      │
│ [Issue]──│─[Arch]──[Critic]─│ Impl → Tests → Critic │─┐           │            │       │ title     │
│          │               │ └─────────────────────┘ │ ├[Integrate]─│[R1]┄[R2]┄┄│[PR]┄[Merge]│ evidence │
│          │               │ ┌ Package B ──────────┐ │ │ unit ✓     │ │     ┊    │       │ agent     │
│          │               │ │ Impl → Tester┄Critic│─┘ │ integ ✗    │ │ [Escalate]│      │ links     │
│          │               │ └──┬──────────────────┘   │            │ │          │       │ lineage   │
│          │               │  [D-3 ?]  ◄────── repair round 1 of 2 ───┘          │       │           │
├──────────┴───────────────┴─────────────────────────┴─────────────┴────────────┴───────┴───────────┤
│ Stage stepper 1–6 · legend                                                                         │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The map is the canvas for one work item. Stage bands are columns; steps are nodes inside them. Two bounded packages each have an
implementer, a test step and a critic; they converge at Integrate. Review is bounded at two rounds with an explicit Escalate gate,
and the human merge gate is a distinct double-outlined node. Other runs are reached through a collapsed switcher and a Needs you
popover, not a board.

### C. Plan and decisions (`planning.html`)

```
┌ top bar ──────────────────────────────────────────────────────────────────┐
│ [Plan] [Decisions 1] [Evidence]          Plan r5 · Execution approved r5 │
├ Outline ───┬ Workspace ───────────────────────────────────┬ Run rail ─────┤
│ Plan       │ Canonical plan, r5               [Edit plan] │ NEO-4821      │
│  Goal      │ # Preserve queued sends…                     │ Waiting on D-3│
│  Lifecycle │ ## Send lifecycle  … [D-2 saved]             │ Stages        │
│  …         │ ┌ diagram: Queued→Sending→Ack               │ Agents (tree) │
│ Decisions  │ │          ↓ Delivery unknown → D-3 open     │ Approvals     │
│  D-3 open  │ └                                            │  Plan exec    │
│ Revisions  │ - Delivery unknown … [D-3 open]              │  Resume B     │
│  r5 current│ ## Work packages … [C1] [E-2]                │  Merge locked │
└────────────┴──────────────────────────────────────────────┴───────────────┘
Decisions tab: list | detail with (1) Draft answer → (2) Saved decision → (3) Execution approval, then history
```

The plan document is the centre. Decisions are a separate view with their own lifecycle. A compact rail keeps the run, stages,
agent tree and approval state in view so this never becomes a plain text screen.

## Differences and trade-offs

|                        | A. Runs                                         | B. Workflow map                                                       | C. Plan and decisions                         |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Primary object         | Many runs                                       | One run's execution graph                                             | One work item's intent                        |
| Main question answered | What needs me now?                              | Where is this run stuck and why?                                      | What did we decide, and what is approved?     |
| Attention              | Pinned strip above list                         | Popover plus amber node and edge                                      | Open decision count, inline chips             |
| Agent lineage          | Tree in the detail panel                        | Badges on nodes, tree in inspector                                    | Tree in the rail, linked to results           |
| Evidence               | Validation and review snippets                  | Per-step evidence in inspector                                        | Evidence tab with "used by" links             |
| Cost                   | Fast to scan, weak on structure                 | Strong on structure, weak at scale                                    | Strong on provenance, weak on live operations |
| Implementation risk    | Lowest; close to current Running and run detail | Highest; needs authoritative stage and step projections (D-1/D-3/D-4) | Medium; needs durable decision records (16.9) |

Recommendation for discussion, not a selection: A is the strongest candidate default because it scales to many runs and keeps
Attention honest. B works best as the detail view reached from a run in A, because a map per run reads clearly but cannot carry
an overview. C fits as the plan surface attached to a work item rather than a top-level mode. If only one primary layout is
built, A carries the least risk and the most daily value. The owner decides; nothing here deletes or replaces the board.

## Interaction guide

All three pages: the top bar has links between concepts, the sample-data notice, Reset demo and a light/dark toggle. Tab order
follows reading order. Focus is a 2px blue outline.

**A. Runs**

- `/` focuses search; `Esc` clears it. Search matches issue, title, branch, head and workflow.
- Active, History and All change scope. Status chips filter (All, Needs you, Running, Paused, Failed, Tracking lost, Queued) and
  show counts. Workflows in the sidebar filter too.
- The run list is a listbox: `↑`, `↓`, `Home`, `End` move selection; `Enter` opens the panel on narrow screens.
- NEO-4821: choose an option for D-3, optionally add a note, then **Save decision**. The item moves to Resolved in this session;
  the other three Needs you items stay. **Resume package B** is a separate request and the run stays paused. **Reopen decision**
  restores your answer as a draft.
- NEO-4790: **Request stop** records a request; it stays Tracking lost with frozen elapsed time until an exit would be observed.
- NEO-4785: **Review retry** shows the repeated-failure warning before **Request attempt 3**. Attention stays open.
- NEO-4776: **Record merge approval** records approval in the prototype only; nothing merges.
- NEO-4799: **Resume** records a request; still paused.
- Below 900px the sidebar becomes a row of workflow buttons and the panel opens over the list with **Back to runs**.

**B. Workflow map**

- Click a node, or `Tab` into the map and use the arrow keys to move to the nearest step in that direction. `Home` and `End`
  jump to the first and last step. `Enter` moves focus into the inspector.
- `+`, `−`, `0` and `F` zoom in, zoom out, reset to 100% and fit. Toolbar buttons do the same. Drag the background to pan.
- **Fold packages** collapses both packages into one Build step; the inspector's **Show packages** expands it again.
- The stage stepper selects each stage's main step. Inspector links move to parent, child and sibling steps; the agent tree
  selects each agent's main step.
- Select Decision D-3 to answer it in the inspector. Saving changes the decision node and the blocked edge only; package B stays
  paused and nothing advances. **Request resume** is separate.
- The run switcher and Needs you popover change runs. Only NEO-4821 has a detailed map; other runs show their stage outline and
  say so.

**C. Plan and decisions**

- Tabs: Plan, Decisions, Evidence. Arrow keys move between tabs.
- **Edit plan** opens the Markdown source. **Save as r6** creates a revision, says no work started, and marks the r5 execution
  approval as superseded. **Discard** leaves r5 unchanged. Remove the "Send lifecycle" heading to see D-2 and D-3 become
  unresolved anchors.
- Revisions r4 and r5 can be viewed read-only; **Restore as a draft** copies r4 into the editor without saving. r1 to r3 are
  listed as not in the sample.
- Decisions: for D-3, choose an option, **Save draft** (not a decision), then **Save decision**. Step 3, Execution approval,
  unlocks only after saving, and **Approve resume** needs the scope check. If the plan approval is superseded, approve the new
  revision in the rail first. **Reopen decision** keeps the previous answer and supersedes an existing resume approval. D-2 shows
  a reopen-and-resave history. D-0 shows an anchor that no longer exists.
- Chips in the plan navigate: decision chips open the decision, agent chips and rail agents open that agent's result, evidence
  chips open the Evidence tab with the item highlighted. "Used by" links go back to decisions and plan sections.
- The inline lifecycle diagram's branch after Delivery unknown follows the saved D-3 answer; the plan text does not change
  unless you edit it.

## Fixture and status semantics

One fictional world in `fixtures.js`: project Neokod, workflow Core reliability, NEO-4821 "Preserve queued sends across
reconnects", attempt 3 of 4, head `7f3a9c2`, base `e19c4d0`. Earlier head `3b18e40`. Five agents in that run: root R, managed
children C1 and C2 (implementers) and C3 (critic and reviewer), and N1, an observed native tester started by C2. Provider names
are real product names used as sample labels; model names are labelled "Sample model".

| Status        | Glyph and treatment        | Meaning                                                                          |
| ------------- | -------------------------- | -------------------------------------------------------------------------------- |
| Needs you     | Amber triangle             | A human must act (decision, merge approval)                                      |
| Running       | Blue ring                  | Current evidence says work is running; elapsed would tick in the product         |
| Paused        | Two bars, neutral          | Stopped by a human or waiting for a separate resume                              |
| Queued        | Hollow circle              | Waiting for a slot                                                               |
| Failed        | Red cross                  | Authoritative failure                                                            |
| Tracking lost | Dashed slate ring          | Parent tracking ended; may still run. Elapsed says "Last observed" and is frozen |
| Unknown       | Dashed question mark, grey | Evidence cannot establish the state, including agent self-reports                |
| Not run       | Hollow circle, grey        | Has not happened                                                                 |
| Superseded    | Struck circle, struck text | Was valid for an earlier head or revision                                        |
| Passed        | Green check                | Only for host checks at the current head on a clean tree                         |
| Done          | Neutral check              | A step completed; not a validation claim                                         |
| Sent back     | Return arrow               | A critic or review returned work                                                 |
| Merged        | Violet                     | History only                                                                     |

Unknown cost is always "Not reported", never zero. No totals are shown. Elapsed time is static text: terminal times are frozen,
the running row shows a start time, orphaned rows show the last observation.

## Limits

- Original A/B/C authoring did not include rendering. Sol inspected the new Work desktop layout in Chrome on 22 October
  and exercised selection, per-item machine override, unsupported-provider blocking, draft save, preview, partial demo Start,
  Execution detail and receipt restoration after reload. Narrow-screen behaviour, screen readers and full A/B/C visual
  acceptance remain outstanding. No build or real execution was run.
- All actions are local demo state. No tracker, server, provider or agent is contacted, and no action proves a server feature
  exists.
- Times like "Saved at 14:31" come from a demo clock that advances one minute per recorded action. They are local interaction
  times, not server timestamps.
- Only NEO-4821 has a detailed workflow map and plan. Other runs in B show a stage outline.
- Concept C does not simulate a stale save conflict, multi-user editing or a durable decision store. The plan editor is raw
  Markdown in a textarea.
- The three pages keep separate state. Answering D-3 in one concept does not change the others.
- Keyboard support is designed but untested with a screen reader.
- Wireframes on the index page are schematic and not to scale.
