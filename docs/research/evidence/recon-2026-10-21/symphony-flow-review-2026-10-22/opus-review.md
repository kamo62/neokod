# Onboard Claude consultation, 22 October 2026

Independent read-only reviewer output. Sol adjudication is in the linked flow report; this transcript is preserved as returned, including findings later narrowed or superseded by fresh evidence.

I reviewed this read-only on the frozen branch `feat/symphony-ux-fixes` @ `d89c4f3`. I made no edits and ran no builds, tests, agents or servers. No live core app was available, so nothing below proves how the installed app behaves.

## (a) Findings

### Confirmed defects in the frozen prototype fixes

The lock-based receipt fix (UX-01) holds. The re-check inside the lock uses fresh storage (`work.js:1835-1920`). The remaining problems are about which surface owns what and which status is shown.

| #   | Sev      | Finding                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                  | What the user sees                                                                                                                                                    |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | P2       | There are two detail views for one request, and the actions only exist in the one that is not the main view. Work has its own "Saved demo requests" list with four tabs and the Withdraw/Check status buttons. Runs shows the same receipt read-only and tells the user to go back to Work. This contradicts the UX-05 and UX-03 acceptance claims.                               | `work.js:3939-4009`, `4291-4321`; `runs.js:3-4`, `165-168`, `912-914`                                                                     | Runs shows "Acknowledgement unknown" under Needs you. The user opens it, finds no way to check status, and has to follow "Open the secondary receipt detail in Work". |
| F2  | P2       | The request status is worked out twice, and the two versions disagree. This breaks principle 2 of state-and-evidence. Withdrawal requested shows as Paused. Work-accepted shows as Queued while NEO-4838 shows as Accepted, so the "Accepted, not running" filter misses the user's own requests. Blocked at preview shows as refused, which undoes the UX-02 separation in Runs. | `work.js:3787-3850` vs `shared.js:655-673`; `runs.js:18`, `336-341`                                                                       | The user filters "Accepted, not running" right after Start and sees only the sample record.                                                                           |
| F3  | P2       | Unknown states are described as not running. Lost acknowledgement or unknown closure means the target may be executing, so this breaks principle 4.                                                                                                                                                                                                                               | `shared.js:663` "Closure unknown (demo), not running"; `work.js:3813` "Nothing is running"; `work.js:4100-4107` stages show "not started" | After a lost acknowledgement, the operator assumes the machine is idle and changes the repo or reassigns the work by hand.                                            |
| F4  | P2       | Items that were blocked at preview become permanent rows under Active in Runs. Closed and refused requests never move to History.                                                                                                                                                                                                                                                 | `runs.js:196-211` keeps every receipt item with `history:false`; capture 22 shows 3 of 6 rows are NEO-4846 items that were never sent     | This is the main source of the "busy Runs" complaint.                                                                                                                 |
| F5  | P2       | Needs you is inconsistent between the two surfaces. A request only appears in Runs' Needs you when its status is unknown. An open blocking gate or a withdrawal request shows "Needs you" in Work's detail but not in Runs.                                                                                                                                                       | `runs.js:139-151`, `233-234` vs `work.js:3894-3925`                                                                                       | The UX-07 claim "a blocking question appears in Needs you" is only true on the secondary surface.                                                                     |
| F6  | P2       | Preview does not pin the workflow or the permissions. The receipt stores the workflow name only, with no digest. The permissions table is global and is not recorded in the receipt.                                                                                                                                                                                              | `work.js:1698`, `1873-1907`, `3704-3709`                                                                                                  | If WORKFLOW permissions change after preview, the old preview stays valid.                                                                                            |
| F7  | P3       | The request key is a 32-bit FNV hash of the preview content, and a matching key is treated as a replay without comparing the payload. This is fine for a demo, but production must not copy it (plan 16.11 AC2 requires a conflict when the payload changes).                                                                                                                     | `work.js:71-78`, `1744`, `1849-1864`                                                                                                      | None in the demo.                                                                                                                                                     |
| F8  | P3       | The Runs row puts the effort in the model field and the profile ID in the provider field. The detail view uses the correct pinned model.                                                                                                                                                                                                                                          | `runs.js:134-135` vs `698`                                                                                                                | Any surface that reuses `row.model` shows the wrong value.                                                                                                            |
| F9  | P3       | The "other scope" tag is hard-coded to one fixture scope, so after switching scope every row is tagged "other scope".                                                                                                                                                                                                                                                             | `work.js:2405`                                                                                                                            | Minor.                                                                                                                                                                |
| F10 | P3       | When no rows match, the receipt read-error banner is overwritten.                                                                                                                                                                                                                                                                                                                 | `runs.js:534-537`                                                                                                                         | The storage error is hidden.                                                                                                                                          |
| F11 | P3       | A request with unknown acknowledgement cannot be withdrawn, because withdrawal requires an accepted item.                                                                                                                                                                                                                                                                         | `work.js:1249`                                                                                                                            | Production needs a reconciled "cancel this request key" path.                                                                                                         |
| F12 | Evidence | Capture 22 shows the receipt chip overlapping the machine chip. The fix (shorter receipt badge) exists only in source and was never rendered.                                                                                                                                                                                                                                     | `runs.js:498-499`; evidence README row 21-22                                                                                              | Machine identity in Runs rows is unverified visually.                                                                                                                 |

### Confirmed issues in the core app (current dev source, which PR150 does not change)

| #   | Sev       | Finding                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                           |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| C1  | P2        | When dispatch fails at the transport level, the board shows "The request failed. Try again." The approve-merge buttons do the same. That treats a lost acknowledgement as a failure, and with no request key the UI cannot reconcile. The server's `already_running` refusal limits duplicates on one server only. | `SymphonyProjectView.tsx:100-127`; `PullRequestPanel.tsx:486`, `501`                                                               |
| C2  | P2        | Dispatch reports success once the work is forked. A later dispatcher failure only writes a log line. I did not trace whether the item state is updated anywhere else, so treat this as a possible "accepted but not running, and nobody is told" path.                                                             | `SymphonyOrchestratorLive.ts:1786-1830`                                                                                            |
| C3  | Known gap | The plan 16.11 gaps are all still present. Dispatch input is `workItemId` only. Views go through the primary environment only. The runtime launches Codex only. The production board is still a 5-column Kanban. The run prompt has no input for a plan or for operator instructions.                              | `contracts/src/symphony.ts:1189-1191`; `AgentRuntime.ts:18-26,168-203`; `SymphonyProjectView.tsx:146`; `Prompt.ts:115-126,164-208` |

### Risks in the proposed redesign (not bugs yet)

- **Merging two data sources in one list.** Tracker issues are fetched, possibly partial and possibly stale. Server attempts are authoritative. One list can make them look equally complete.
- **A modal would hide context.** It would cover the list while the user is assigning or writing a prompt.
- **Overlapping filters.** "Needs your attention" overlaps every lifecycle stage.
- **Plan generation is execution.** Generating a plan inside setup uses a provider and reads the repo.
- **Inherited custom prompts can go stale** when the issue changes.

## (b) Recommended Work journey

Make one Symphony page called **Work**. Runs stops being a separate top-level page.

1. **Scope bar** (this replaces the sidebar, comment 1)
   - One compact picker for Connection, Scope and Repository, with the coverage pill and fetch time always visible.
   - Connection and scope IDs and the revision go into a "Source details" popover.
   - Start mode is removed. Selected only is the fixed behaviour. Automatic belongs in project Settings and shows as a banner when it is on.
   - Machines are reduced to a "2 of 3 machines online" chip that links to Settings, Connections. Machine status appears where it matters: in the machine picker during setup and in the machine filter.
   - The keyboard legend moves behind `?`.
2. **Segments and filters**
   - Single-select segment: **Not started | In progress | Finished**.
   - A **Needs you** strip is pinned above the list in every segment and ignores filters.
   - Workflow, label, machine and search go into one filter menu.
   - "In progress" covers everything from the moment a request is sent until a positive terminal outcome. That includes accepted but not running, acknowledgement unknown, withdrawal requested, closure unknown and tracking lost, because the reservation is still held.
   - "Not started" shows only loaded tracker items, with a coverage line. "In progress" comes from the server and is complete (or shows an explicit count if paged). "Finished" is server-paginated history.
3. **Rows.** Keep the compact Runs row the owner likes: issue, title, status, stage strip, machine chip, elapsed or last observed. A Not started row shows readiness instead of the stage strip. Each issue gets one row showing its latest attempt as "attempt n of m"; retries and linked reassignments are listed in the detail.
4. **Detail drawer** (comment 2)
   - Not open by default. It opens when the user activates a title or presses Enter, and closes with Esc.
   - It does not block the list. Arrow keys keep moving and the drawer follows. On a narrow screen it becomes full screen.
   - Not started items show the issue, acceptance criteria and earlier requests. Items in progress or finished show Summary, Execution (B), Plan and decisions (C) and Evidence.
   - The URL encodes the item, attempt and tab. Execution can expand to a full page for the graph.
5. **Set up run** (comment 3)
   - Ticking items shows a batch bar with "Set up run". That opens a wide side sheet, or a `/work/setup` route.
   - Defaults sit at the top. One row per item shows machine and repository, implementer, reviewers, plan source and a prompt badge.
   - Expanding a row shows the plan and prompt editors next to the issue text.
   - The last step in the same sheet is **Review and start**: the full pinned summary, then a confirm.
   - After Start, results are shown per item, the sheet closes and the rows move to In progress. Unknown items land in Needs you.

**Where modals fit.** Use a modal only for short confirmations: Start, Withdraw, Reset, and "already recorded elsewhere". I disagree with using a modal for issue detail or setup. Setup contains several items, nested model pickers and long plan text, and the user needs to see the list and the issue while working. A modal blocks all of that and one Esc can lose work. If the owner still wants a modal, it should be a large dialog that autosaves the draft and where Esc never discards anything.

## (c) Custom prompt contract

- **Record.** `OperatorInstruction { itemId (canonical tracker identity), level: item | batch default | project template, text, revision, digest, author, savedAt (server time in production), basedOnIssueRevision }`. A separate optional reviewer instruction uses the same shape.
- **Precedence, highest first:**
  1. Host and runner policy: sandbox, approval, branch rules, no merge. Cannot be overridden.
  2. The WORKFLOW.md contract: validation and autonomy. Cannot be overridden.
  3. The approved plan revision.
  4. The per-item instruction.
  5. The batch default, inherited until the user edits the item. After an edit the item keeps its own copy, the same way model defaults work.
  6. Tracker description and acceptance criteria, quoted as data and never treated as instructions.
- **Conflicts.** The UI warns on phrases like "skip tests", "merge" or "push to main". The server enforces layers 1 and 2 whatever the text says.
- **Provenance.** Review shows "Exact prompt", with each section labelled by its source. The receipt stores the digest of the assembled prompt plus each layer's revision and digest. Reviewers see the implementer's instruction as context.
- **What invalidates a preview or approval.** A change to the instruction text, its inheritance, the plan, the issue revision, the workflow digest, the target or the providers. After acceptance, an edit creates revision n+1 for the next attempt only. Guidance during a run is a separate, audited "Send guidance" action, and only where the runtime supports it.
- **Safety.** Scan the text for token-shaped strings and never store credentials in it.
- **Backend work needed.** Add plan and instruction fields with digests to `RunPromptInput` and to the attempt snapshot.

## (d) Acceptance criteria

1. **Sidebar (comment 1).** At 1280 px and at 390 px, Work has no persistent sidebar. Scope, repository, coverage and fetch time stay visible above the list. IDs, the machine list and keyboard help are one interaction away. No select is truncated so far that the scope can't be identified.
2. **Detail on demand (comment 2).**
   - The detail drawer is closed on load and when nothing is focused.
   - Opening it keeps the list scrolled and interactive.
   - Esc returns focus to the row.
   - Assignment can only be edited in setup, in one place.
3. **Per-item prompts (comment 2).**
   - Each selected item can hold its own instruction.
   - Review shows the assembled prompt and where each part came from.
   - Editing an instruction invalidates the preview.
   - An accepted attempt keeps its pinned digest.
4. **Planning inside setup (comment 3).**
   - Plan source can be chosen per item: latest rN, write now, or generate.
   - Generate is a separate operation with its own pinned target and receipt. It returns a draft revision and never starts implementation.
   - Saving a plan never starts work.
   - Review and Start are in the same sheet.
   - Plan text reaches the run prompt.
5. **One page with segments (comment 4).**
   - Runs is not a separate page.
   - Each item belongs to exactly one segment.
   - Needs you can include items from any segment and ignores filters.
   - Unknown, accepted but not running, and tracking lost are all In progress.
   - Blocked at preview never creates a row outside Not started.
   - Each segment states its own data source and coverage.
6. **One state model.**
   - A single projection drives every pill, filter and Needs you entry.
   - The Accepted filter includes requests made from Work.
   - Unknown states never claim "not running".
   - Every action addresses the displayed machine ID and attempt, from any surface.
7. **Retained requirements.** Selected only. Exact instance, model and effort pins for the DeepSeek/OpenCode implementer and the Sol and Opus reviewers, each with a reason when unavailable. No silent fallback to another target. Unknown keeps the reservation. Preview pins the issue revision, plan and prompt digests, machine ID, repository and base, workflow digest, providers and efforts, and permissions.

## (e) Core-app coverage

- **PR150 scope.** It changes only `docs/design` and evidence files (source manifest; plan 16.12 says apps and packages are unchanged). There is no changed core code to review.
- **Examined.** Symphony dispatch and global controls, the PR panel, the dispatch contract, AgentRuntime, the orchestrator's launch path, and `Prompt.ts`.
- **Not examined in this pass.** Home, chat and composer, provider selection at runtime, terminal, editor and save, Git, worktrees and checkpoints, Settings, connections and auth. For those I am relying on earlier Sol and Opus reports and the 16.12 merge record, and they stay unapproved.
- **Live evidence still missing.** No runtime was running on ports 6953 or 14993 (per the 18:58 UTC check recorded in plan 16.13 and the evidence README). There is no installed-app walkthrough, no fresh logs, and no real provider, machine, tracker or fault testing.
- **Stale handoff.** `HANDOFF.md` is dated 9 October and does not reflect the state in 16.12.
- **Not approved.** This review does not approve the whole app.

## (f) Should PR150 be merged now?

Not as it stands. It is low risk because it touches only documentation and the design artifact, and its recorded gates passed (`vp check` with 0 errors and 66 warnings; typecheck passed). The problem is that `FIXES-2026-10-22.md` marks UX-02, -03, -05 and -07 as "Corrected", and F1 to F5 contradict that. The owner's four comments also replace most of the Work and Runs layout.

My recommendation:

1. Change the docs only, marking those four findings as "partially corrected, see the Opus review of 22 October" and listing F1 to F6.
2. Then merge it into `dev` as a historical prototype.
3. Don't treat it as acceptance, and don't start production UI from it. Build the layout in (b) first.
