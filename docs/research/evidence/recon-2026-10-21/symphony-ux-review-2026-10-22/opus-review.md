I found 12 issues worth acting on: three P1, nine P2, plus a short list of P3 polish. I reviewed source only, plus two of Sol's screenshots and his screen trace. I didn't use Chrome myself. Only `01-index.png`, `02-work-assign.png` and `workflow.txt` were in the review folder when I read it; there was no `walkthrough.txt`. The earlier `symphony-work-assignment.png` was not at the path given, so nothing below depends on it. Nothing was edited, built or launched.

Each finding says whether it is a gap in the product design or a bug in the demo. I don't count the fake fixtures or the missing backend as bugs. Where a warning is about the existing sample attempt 3 rather than a newly queued demo request, I say so.

## P1

### 1. The agent picker is not the shared model and effort control, and effort can't be chosen

- **Type:** product design gap. Supported by source and by screenshot `02`.
- **Journey:** pick a provider, model and effort for an item while a machine lacks the capability.
- **What happens:**
  - Implementer is one native `<select>` of fixed profiles, such as "DeepSeek V4.1 Flash, OpenCode (ACP), project default" (`work.js:1143-1161`).
  - Effort is read-only text, "high" or "not available" (`work.js:353-360`, `work.js:1189`). Screenshot `02` shows "Effort not available" and the implementer label cut off.
  - Options a machine can't run get a "(not on X)" suffix but stay selectable.
  - Reviewers are fixed text with no effort control (`work.js:1225-1228`).
  - The real control has provider instances with duplicate badges, per-model reasons for disabling an option, and a provider-options footer for effort (`ComposerModelTraitsControl.tsx:29-56`, `:163-171`, `ModelPickerContent.tsx:365`, `:608-626`). It also refuses to infer a replacement when the selected instance disappears (`ComposerModelTraitsControl.tsx:61-68`).
- **Impact:** a user can't set effort, can't tell two accounts or instances apart, and can pick an option that is about to block. Building from this prototype would produce a second picker that diverges from the thread one.
- **Minimum fix:** show the existing control's shape, one trigger summarised as "Model · Effort", with the instance list and model rows coming from the selected machine. Unavailable models should be disabled with a reason, not given a suffix.
- **Acceptance check:** on Work PC, DeepSeek appears disabled with the Work PC reason. Choosing Sample Mac enables it, and its effort options come from Sample Mac. Switching machines never swaps the instance for another one of the same provider type.

### 2. There is no "acknowledgement unknown" or "refused" result, and no way to reconcile

- **Type:** product design gap. Source only.
- **Journey:** you press Start and the answer is lost, or the machine refuses.
- **What happens:**
  - A receipt item can only be `accepted` or `blocked` (`work.js:314`).
  - "Blocked at preview" is shown exactly like a refusal from the machine: both say "Not started" (`work.js:1532-1541`).
  - `startDemo` cannot produce an unknown outcome (`work.js:557-613`).
- **Impact:** the settled rule that an unknown acknowledgement must not silently duplicate execution has no UI. Nothing shows what the user sees, which button is offered, or what happens on reload while an item is unknown.
- **Minimum fix:**
  - Give each receipt item three outcomes: accepted, refused with a typed reason, or unknown.
  - For an unknown item, replace Start with "Check status" on the same request key.
  - Keep the issue unselectable until it is reconciled.
  - Show "blocked at preview" separately from "refused by machine".
- **Acceptance check:** a simulated lost acknowledgement shows Unknown. Reloading keeps it Unknown. A new preview for that issue is blocked with "Waiting to confirm R-n". Reconciling resolves it to accepted or refused without creating a second receipt.

### 3. Starting the same work from two tabs accepts it twice and loses a receipt

- **Type:** demo bug. Source only.
- **Journey:** two tabs are open, or a stale tab is still open, and Start is pressed in each.
- **What happens:**
  - The duplicate check and the next receipt number both use the tab's in-memory receipts (`work.js:560`, `:576-577`, `:585`).
  - The write then replaces the whole stored list (`work.js:593-594`).
  - Receipts are only read at load (`work.js:2281`), and no code listens for storage changes from another tab.
- **Impact:** tab B accepts the same issue again as a second "R-1" and wipes out tab A's receipt. That is exactly the duplicate the design forbids, and the counterpart of plan acceptance criterion 6.
- **Minimum fix:** re-read the stored receipts inside `startDemo` before checking for duplicates and choosing the ID. Listen for storage events and mark the preview out of date when they arrive.
- **Acceptance check:** start in tab A, then start the same preview in tab B. Tab B shows "Already queued in R-1" and the stored list still contains A's receipt.

## P2

### 4. The one-click fix moves a Windows-only issue onto a Mac

- **Type:** demo logic, but it points at a missing product concept. Supported by screenshot `02`.
- **Journey:** NEO-4846 is assigned to Work PC and blocked because DeepSeek isn't enabled there.
- **What happens:**
  - The suggested fix is "Run on Sample Mac" (`work.js:387`, `:497-500`, `:1193-1199`). The fix logic never looks at `issue.prefers`.
  - The Windows requirement only shows as an info note (`work.js:495`, `work-data.js:297-300`).
  - After the fix the item reads "Ready to preview".
- **Impact:** the recommended action leads to an invalid run. This borders on P1.
- **Minimum fix:** when an issue names a required machine or platform, don't offer to move it. Offer the implementers available on that machine instead, and show the requirement as a warning.
- **Acceptance check:** blocked NEO-4846 offers no machine move, and choosing Sample Mac yourself shows a warning.

### 5. Machines disappear once you leave Work

- **Type:** product design gap. Source only.
- **Journey:** watch, retry, resume or stop runs across machines in A.
- **What happens:**
  - A's run detail lists attempt, head, base, branch, worktree and provider but no machine (`runs.js:377-387`).
  - There is no machine filter or label on rows.
  - "Request attempt 3", "Resume" and "Request stop" don't name a target (`runs.js:274-310`).
  - Workflow map and Plan and decisions never mention a machine (a grep finds none).
- **Impact:** plan 16.11 requires machine labels in A and every control to address the exact machine and attempt (criteria 7 and 9). A retry can't show where it will run.
- **Minimum fix:** add the machine chip to A's rows, A's detail and B/C's run header, and a Machine filter in A. Every action names its target, for example "Request attempt 3 on Sample Mac".
- **Acceptance check:** each run row and detail shows the machine, and the retry wording includes it.

### 6. The combined app can't actually be tried, and switching pages loses context

- **Type:** product design gap plus a demo limit. Source only.
- **Journey:** start work, then look at it in the operating view. Separately, answer a decision in A, open B, and come back.
- **What happens:**
  - Work's own run view groups by receipt, and its Summary, Execution, Plan and Evidence tabs only ever hold an empty queued request (`work.js:1757-1785`).
  - The top-nav "Runs" page doesn't show anything started in Work (`work.js:1772`).
  - The detailed content lives on separate pages, and nothing a user does there is persisted. A decision saved in A is gone after visiting B and pressing Back (`runs.js:361-362`, DESIGN.md:253).
- **Impact:**
  - Users see two different "runs" lists.
  - The tabbed A to B/C design is never shown with real content.
  - Losing a saved decision invites answering it twice.
- **Minimum fix:** in Work's run view, list the existing attempt 3 as a read-only row using the same four tabs, filled from `fixtures.js`. Production needs to decide where accepted items live (see decisions below).
- **Acceptance check:** from the Work run list, attempt 3's Execution tab shows the B content, and going back keeps the selection.

### 7. Nothing can be done with a queued request

- **Type:** product design gap. Source only.
- **Journey:** stop, rerun, resume or move a request to another machine.
- **What happens:**
  - The run header has tabs but no actions (`work.js:1729-1753`).
  - The copy says moving it "needs a new linked request after this one is closed", but nothing can close it (`work.js:1583-1585`).
  - The issue stays locked, "cannot be selected again while that request is open" (`work.js:983`), until Reset demo.
- **Impact:** an item sent to the wrong machine, or whose machine goes offline, is stuck.
- **Minimum fix:** add "Withdraw request (demo)" while queued, which records the closure and unlocks the issue. Add "Run elsewhere", disabled with the reason until the request is closed.
- **Acceptance check:** after withdrawing, the issue can be selected again, and a new request shows "follows R-1".

### 8. A conflict with existing work gives you no way to reach that work

- **Type:** product design gap. Source only.
- **Journey:** select an issue that is already being worked on.
- **What happens:**
  - NEO-4838 says "Already has accepted work on Work PC". It can still be ticked, it is blocked in preview, and nothing opens the existing work (`work-data.js:243-248`, `work.js:461`, `:805`, `:1007`, `:811-813`).
  - For NEO-4821, the warning about attempt 3 is honest and clearly labelled, so I'm not counting it as a bug (`work.js:469-473`). It has the same missing link though.
- **Impact:** the user can't get from the conflict to the work that caused it.
- **Minimum fix:** disable the checkbox and offer "Open existing run" from the row, the inspector and the preview.
- **Acceptance check:** that link reaches the existing attempt with the same item selected.

### 9. A new request quietly restarts the plan at revision 1

- **Type:** product design gap. Source only.
- **Journey:** inspect and edit the plan for NEO-4821, then start it.
- **What happens:**
  - Work shows "Plan r1, Drafted from the issue (sample)" and a different open question (`work.js:247-251`, `:1046-1047`, `work-data.js:158-174`).
  - Plan and decisions shows r5 for the same issue, with D-2 saved, D-3 open and execution approved for r5.
  - The note at `work.js:1116-1121` explains this, but a new request would run on r1.
- **Impact:** four plan revisions and the saved decisions are silently dropped. It's also unclear who wrote the "drafted" plan.
- **Minimum fix:** decide how plans carry over between attempts (see decisions). In the demo, show the latest plan as "inherited r5", or a "Start from r5 / Start fresh" choice, and give the plan's author.
- **Acceptance check:** preview shows which revision and whose plan it is pinning.

### 10. Open decisions and plan approval don't hold back Start

- **Type:** product design gap. Source only.
- **Journey:** a mix of ready and blocked items where a question is still undecided.
- **What happens:**
  - An undecided question is only a warning (`work.js:486-492`).
  - Start only checks `ready` (`work.js:572`).
  - "Plan approval before Build" is shown (`work.js:1404`, `work-data.js:124`), but there is no approve action. The only Settings and safety issue is already blocked, so that path can't be exercised.
  - Work's decision UI has one step; C has three (draft, save, execution approval).
- **Impact:** the user can't tell whether starting with an open question is safe, or where approval happens.
- **Minimum fix:** decide where approval happens (see decisions). In the demo, show undecided questions in the preview as "Needs you before Build" and carry them into the run as a Needs you item. Add an unblocked Settings and safety issue.
- **Acceptance check:** that issue's preview shows the approval gate, and the run shows Needs you.

### 11. Changes outside the browser can't be simulated

- **Type:** gap in what the demo covers. Source only.
- **Journey:** many projects or trackers, partial results, and a preview that goes stale for outside reasons.
- **What happens:**
  - There is one fixed tracker, project and scope (`work-data.js:27-36`, `work.js:700-709`).
  - There is no "load more", and no limited, failed or unavailable state, even though NEO-4851 describes exactly that case.
  - The preview only goes stale from local edits (`work.js:547-555`). An edited issue, a machine going offline or a provider disappearing never invalidates it (plan criterion 3).
- **Minimum fix:** add demo toggles: "Issue edited upstream", "Work PC went offline" and "Tracker rate-limited". The first two should make the preview stale with that reason; the third shows a partial list.
- **Acceptance check:** each toggle produces its own reason, and Start stays off.

### 12. On narrow screens the machine and issue ID disappear from the list

- **Type:** demo layout. Source only; Sol should confirm visually.
- **What happens:**
  - At 860px and below the "Run on" column is hidden (`work.css:1584-1587`).
  - At 560px and below the issue ID and batch defaults are hidden too (`work.css:1630-1633`, `:1643-1645`).
  - The inspector drawer covers the batch bar with the Preview button (`work.css:1564-1573`).
- **Impact:** machine identity must stay visible during assignment, so this breaks that rule on small screens.
- **Minimum fix:** fold the machine chip into the readiness line on narrow screens.
- **Acceptance check:** at 390px wide, every selected row names its machine.

## P3

- **Mixed clocks:** saves use the real 12-hour clock ("04:33 PM", `work.js:32`) while the sample data uses fixed 24-hour times ("Fetched 14:38"). Supported by the screen trace (lines 27 and 44).
- **Machines read as checkboxes:** the machine buttons use `aria-pressed` (`work.js:688-690`), so screen readers announce them as checkboxes, like selecting a machine (trace lines 58-66). Clicking one actually opens an info panel.
- **Replay message can't happen:** "Starting this preview again returns the same receipt" (`work.js:1490-1494`) is unreachable. Start is disabled once a receipt exists, and the draft revision changes on start.
- **Unsaved work lost silently:** unsaved draft or plan edits are lost on top-nav navigation or reload with no warning.
- **Different words for the same state:** Work's Execution tab says "Planned" (`work.js:1604`, `:1620-1622`) where A and B say "Not run".
- **Self-review:** choosing Opus as implementer only warns, even though Opus would then review its own work (`work.js:458-459`).

## What works well

- Selected-only mode is explicit. Select visible never takes unseen issues, and selected issues hidden by filters are still reported.
- Per-item overrides keep their meaning when defaults change.
- Blocked items stay visible with a reason, and the batch is honestly per-item rather than all-or-nothing.
- The preview says why it is out of date when the plan, decision or assignment changes.
- The plan pinned at acceptance is kept separate from the current plan.
- Evidence never shows green by default, and the copy states that there is no automatic fallback.
- The tracker's native issue ID is shown.
- List keyboard support and focus restoration after re-render are careful.

## What I could not verify

- How the Preview, Demo runs and narrow layouts look, apart from the two screenshots.
- Screen-reader behaviour.
- A/B/C visuals.
- How the real `ModelPickerContent` behaves inside a machine-scoped wrapper. No such scoping exists today.

## Decisions needed before production

1. **Picker data per machine:** where the picker's instance and model lists come from for each machine, and what happens to a chosen instance that doesn't exist on the newly selected machine.
2. **Reviewers:** whether they are a project default only or can be set per item, where they are edited, and how reviewer effort is set.
3. **Unknown results:** how an unknown result is shown and reconciled, and which server owns that.
4. **Where accepted items live:** in A's item list, with receipts as secondary, or in a list grouped by receipt.
5. **Plans across attempts:** whether a new attempt inherits the latest plan, and whether generating a plan with an agent is a separate, explicitly targeted action.
6. **Approval timing:** whether open decisions and plan approval are enforced at Start or at the relevant stage.
7. **After acceptance:** the rules for withdrawing, stopping and reassigning a queued or running request.
8. **Machine requirements:** whether issues or workflows can declare a required platform or capability for the machine.
9. **Time source:** which clock displayed times come from (server timestamps versus local time).
