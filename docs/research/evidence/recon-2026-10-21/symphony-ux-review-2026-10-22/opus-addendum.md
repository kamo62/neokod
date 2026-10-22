The 17 captures (01 to 17, there is no 18 to 20) and `walkthrough.txt` confirm most of my source findings and add three things the source alone didn't show. The biggest additions: the narrow screen loses more than I predicted, and C's execution approval check leaves out the machine. Your five corrections are applied below, and #9 drops from the findings list to an open decision.

What each kind of evidence proves: I reviewed source and Sol's static captures only. I did not use Chrome or run any code. The duplicate-start bug (#3) is still source-only; a two-tab state simulation could prove it deterministically, but I have not run one. No tracker, provider, machine or build behaviour is claimed anywhere.

## Findings the captures confirm

- **#1, picker and effort.** Screenshot 02 shows the implementer select cut off and "Effort: not available". Screenshot 04 and the trace show effort only as text ("effort high") and the reviewers as fixed text. There is no control for effort, provider instance or reviewer anywhere in the flow.
- **#2, unknown or refused results.** The receipt in 13 can only show "Queued (demo)" or "Not started". Nothing represents an unknown or refused acknowledgement.
- **#5, machines missing outside Work.** A's rows and sidebar in 05 have no machine. A's detail in the trace lists Provider and Worktree but no Machine (walkthrough 362-370, 624-632). New evidence: C's execution approval scope check reads "plan r5, attempt 3, head 7f3a9c2, decision D-3" with no target machine (walkthrough 1513-1530). An approval should name the machine it applies to.
- **#6, the combined app isn't demonstrable.** After R-1 was started in Work, A in 05 shows no trace of it, matching the "not added to the Runs page" copy in 13. The rich content still lives on separate pages; the Work request tabs (13 to 16) are honest but empty.
- **#7, no actions after acceptance.** The request headers in 13 and 14 have tabs and a "Pinned to" label but no withdraw, stop or reassign action.
- **#12, narrow screens.** 17 at about 390px is worse than the source suggested:
  - The top bar is cut off: "Reset de…" is truncated, and the page links and theme toggle are not visible.
  - The project strip scrolls sideways, so "Selected onl…" is cut and the Machines list is off-screen.
  - Issue IDs and the "Run on" machine are hidden, so NEO-4821 shows "Queued (demo)" with no machine at all.
  - Step 3 of the flow bar is cut off.
- **P3, clocks.** 13 mixes the real clock ("Accepted 04:34 PM") with sample times ("edited 13:40", "checked 14:36").
- **P3, accessibility.** The trace shows aria-pressed controls announced as checkboxes in three places: Work's machine buttons, A's workflow filters, and every node on B's map (walkthrough 712-770). Screen-reader users hear map steps as checkboxes.

## Revised findings

**#3, duplicate Start across tabs (demo bug, source only).** My earlier fix was wrong: re-reading storage and listening for storage events does not make the race safe.

- Minimum prototype fix:
  - Run the whole read, check, allocate-ID and write sequence inside one Web Locks lock (`navigator.locks.request("neokod-work-receipts", …)`).
  - Allocate receipt IDs that cannot collide, not "highest so far plus one".
  - Where Web Locks is unavailable (for example on `file://`), make Start read-only in that tab.
- Acceptance: a deterministic two-state simulation starting the same preview twice produces one accepted item and keeps the first receipt.
- Production stays as plan 16.11 says: a server-owned scope authority. Client locks are only a UX guard.

**#4, the one-click fix discards a stated preference (now P2 UX plus a product decision).** `issue.prefers` is a preference, and path normalisation checks on macOS are not inherently invalid.

- The gap is how the fix is presented. While NEO-4846 is blocked on Work PC, the preference is not shown at all, because the note only appears once the item is off the preferred machine. The block text and the fix button in 02 and 04 then recommend Sample Mac without saying this overrides the preference.
- There is also no way to express a hard required capability.
- Fix:
  - Show the preference in the blocked state.
  - Label the button "Run on Sample Mac (not the preferred Work PC)".
  - List implementers available on the preferred machine first.
  - Decide on a separate required-capability policy.

**#8, existing-work dead end (now NEO-4838 only).** NEO-4821 already links to attempt 3. NEO-4838 shows "Already has accepted work on Work PC" with an enabled checkbox and no link (02, 03, 17). Fix: disable the checkbox and offer "Open existing run".

**#9, plan inheritance (moved to open decisions).** Work clearly explains that a new demo plan is separate from attempt 3 (15). Whether a new attempt inherits the latest plan is an unresolved product decision, not silent data loss.

**#10, open questions at Start (reframed).** Admitting work at Intake and pausing before Build is legitimate, so Start approval and stage approval should stay distinct.

- The gap is that a question has no blocking or advisory class and no visible hold:
  - In 04, NEO-4830 is "Ready" with only a warning, and nothing says which stage would wait.
  - In 14, the Execution tab shows Design and Build as plain "Planned".
  - In 15, the pinned plan says nothing about the question that was undecided at acceptance.
- Fix:
  - Mark each question as blocking or advisory, and name its gate (for example "Holds Build").
  - Preview shows "Admits to Intake, Build held until answered".
  - The accepted request shows the held stage and a Needs you item.

## New P3 from the captures

- **Who does PR.** In 14, the PR stage says "Who: You" while its permission says "Pushes the branch and opens a PR". B shows Open PR as its own step and the human merge as a separate gate. Clarify whether the person or the system opens the PR.
- **Blocked receipt line.** In 13 the blocked NEO-4846 receipt line has no "Change in Work" action, although the preview has one.

## Highest-value minimum corrections, in order

1. Put the receipt critical section under one Web Locks lock with non-colliding IDs and a read-only fallback. Add a simulated "acknowledgement unknown" outcome with "Check status" that refuses a second Start.
2. Show the machine on A's rows and detail, add a machine filter, and add the machine to C's approval scope and to every action label.
3. Give each open question a blocking or advisory class and a named gate. Show the held stage in Preview, in the Execution tab and as a Needs you item.
4. Replace the implementer select with the shared model and effort control, filled from the target machine, with disabled reasons instead of selectable suffixes.
5. Show the preference while NEO-4846 is blocked and make the fix say what it overrides.
6. On narrow screens, keep the machine chip and issue ID on rows and move the page links and Reset into an overflow menu.
7. Give NEO-4838 an "Open existing run" link, and add "Withdraw request (demo)" for queued requests.

## Decisions added or changed

- Plan inheritance across attempts (moved here from #9).
- How questions are classified as blocking or advisory, and which stage each one holds.
- A required-capability policy that stays separate from preferences.
- Whether execution approval is scoped to a machine.
