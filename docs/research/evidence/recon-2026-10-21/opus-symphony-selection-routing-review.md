# Symphony work selection, agents and machine routing: Opus consultation

22 October 2026. Design and source review only. Onboard Claude tried first and completed both turns; no fallback used. Actual metadata: `claude-opus-5-5`, provider `firstParty`, requested effort `high`, session `fe3e673e-5418-42b0-8506-89749a24ecce`. Read-only tools on first turn; tools disabled on follow-up. No builds, source implementation, tracker mutations or execution dispatch.

Canonical decision and acceptance criteria: `plan.md` section 16.11.

## Main Sol disposition

Accept the combined Work → Runs (A) → per-item Execution (B), Plan and decisions (C) navigation; per-item target and implementer with project reviewer defaults; selected-only dispatch; typed refusal and authoritative preview/receipt; target identity pinned per attempt. Keep the owner's DeepSeek via OpenCode ACP and Sol/Opus requirement. Unsupported capabilities remain blocked, not substituted with Codex.

The first reply's cross-server preflight was insufficient. Sol identified the check-then-start race; Opus accepted a durable scope dispatch authority in the follow-up. A tracker label alone is not atomic exclusion. Client controls alone cannot enforce scheduler ownership: participating servers must enforce the configured authority. Guarantees cover participating configured servers, not unknown independent pollers.

Do not adopt an abandon-and-release path while old work may survive. Abandoning tracking does not free an issue for another machine. Require positive refusal/terminal-and-closure evidence before reassignment, or a separately proven fencing mechanism. No automatic lease expiry or failover permits duplicate execution. Budgets are not represented as enforced gates without enforcement evidence.

## Initial Opus review

Sol, here is my critique and the decision I would put to the owner. I worked read-only and ran nothing. Every claim below comes from reading source or plan text, so none of it is runtime proof.

## Decision for the owner

Yes, B is a detailed view of A. A, B and C are levels of one product and the user should not have to choose between them. None of the three answers the owner's question, though: how to choose which issues get worked on, which agents work on them, and on which machine. That needs a fourth surface, **Work**, which comes before any run exists. Sol is right to add it.

## Navigation and user journey

Symphony gets two top-level places plus a run detail.

1. **Work** (intake and batch). Pick a Symphony project. Each project lives on one server, so it carries a machine badge, for example "Mac" or "Work PC". The issue list comes from that server's tracker read. It shows the source server, when it was fetched, "N of M" and whether the list is partial. Select issues by their tracker ID (for example #123), read the acceptance criteria in a side panel, then press "Add to batch".
2. **Batch draft.** One row per issue with three columns: Run on (server and project), Implementer (provider instance and model) and preflight status. The batch default applies to every row and can be overridden per row. Saving the draft changes nothing on any server.
3. **Preview.** Each target server does a dry run and returns the resolved plan:
   - issue to workflow revision
   - repository and base on that machine
   - implementer, permissions and approval policy
   - a concurrency slot now or queued
   - validation commands and push, PR and merge gates
   - a duplicate check against other servers

   Anything unsupported or unavailable blocks that row with a reason. Nothing falls back silently.

4. **Start** sends one submission per server, each with an idempotency key. Each row shows accepted, refused (with the reason) or unknown (the acknowledgement was lost).
5. **Runs** (concept A). This becomes the default once anything is running. It is one list across all enabled servers with a machine column. Rows from an offline server show "last observed" instead of "running". Opening a run gives tabs for Summary, Execution (B), Evidence and later Plan (C).

## How much to assign, and where I disagree with Sol

- **Roles.** Cut the first release down to the implementer per item: provider instance plus model, with effort only where the provider supports it. Reviewers stay at project level. Today's contracts hold one `agentProvider` and `agentModel` per project (`symphony.ts:675-678`), reviewers are plain strings (`:677`), and there is no effort or budget field. Reusable role templates and cross-machine reviewers come later. Cross-machine reviewers need explicit evidence transport, as Sol says.
- **Budget.** Do not show budget as a gate. Nothing enforces it. Preview should show only the gates the server actually applies.
- **Where the draft lives.** Keep the draft on the client, like composer drafts. It spans servers and changes nothing. Authority starts at submission. Replay should reuse W6's request-key rule: the same key and payload returns the existing item, and a different payload under the same key is a conflict.
- **Moving work to another machine.** Defer it. The worktree is local to a machine (`symphony.md:81-89`). For now, moving means cancel, then submit again on the other machine, linked to the earlier attempt. Prior work only carries over if the branch was pushed. There is no live migration.
- **Manual selection versus automatic policy.** Each Symphony project gets a mode: "Selected only" (the default) or "Automatic". The server has no "Selected only" mode today, so this needs a server change (gap 4 below). A selected issue then launches only through Start.

## Gaps and contradictions in the source

1. **Symphony has no idea of a machine.** No Symphony contract carries an environment ID, and every Symphony view reads `usePrimaryEnvironmentId` (`SymphonyProjectView.tsx:25,92,316`, `SymphonyProjectsView.tsx:277`). That leaves W5 slice 4 and B2, B3 and B3b unbuilt.
2. **Agents cannot be chosen per item.** `SymphonyDispatchWorkItemInput` carries only `workItemId` (`symphony.ts:1157`). The dispatcher always uses `config.agentProvider` and `config.agentModel` (`Dispatcher.ts:265,360`), and `WorkItem.provider` (`symphony.ts:475`) is ignored at dispatch.
3. **The preferred implementer is not available to Symphony.** The UI says "Symphony execution currently requires an enabled Codex provider" (`SymphonyProjectView.tsx:249`). DeepSeek through OpenCode ACP is still a parity spike (O2, `plan.md:1707`) with no adapter enablement. The UI must not offer it until O2 and O3 are reviewed.
4. **There is no manual-only mode.**
   - An `observe` workflow refuses explicit dispatch too (`SymphonyOrchestratorLive.ts:1481-1488`).
   - In an active workflow, `launchNextQueuedWork` launches any queued item (`:1629-1645`).

   So today the only choices are "nothing runs" and "every queued item runs".

5. **Refusals are silent.** `prepareDispatch` returns `null` on about a dozen branches, and the RPC returns void (`:1647-1648`). The current "Run now" button cannot say why nothing happened.
6. **Duplicate-claim protection stops at one database.** The advisory lock and the fenced SQL claim (`symphony.md:62-74`) only guard one server's database. Two machines polling the same GitHub scope can both run the same issue.
7. **Tracker coverage cannot be claimed complete.** The GitHub list has a truncation and pagination defect (W8, `plan.md:815`), and B-2 is only a staged data foundation (`plan.md:1709`). The intake list cannot say "all issues".
8. **The board is still the shipped UI.** The current Symphony view is board-first, with a "Run now" button (`SymphonyProjectView.tsx:158`). That layout is paused by section 16.10, so Work and Runs replace it rather than extend it.

## Smallest honest first delivery

This comes after the core gates. Product UI is not authorised yet.

- **S1, server, single machine.**
  - Add the "Selected only" mode.
  - Return a typed refusal reason from dispatch.
  - Add a preflight RPC that changes nothing.
  - Store a per-item implementer snapshot that the dispatcher honours and that is recorded on the attempt.
  - Make Start reject a stale preview using the project revision and issue `updatedAt`.
  - Make submission replay idempotent.
- **S2, web, primary machine only.** Work intake, batch draft, Preview and Start, Runs (A) and the run detail Summary tab.
- **S3, after W5 B2, B3, B3b and slice 4.**
  - Choose a machine per item.
  - Show runs from all servers in one list.
  - Add a duplicate preflight across servers that blocks when it cannot check. If a server holding the same tracker scope is offline, Start is blocked with "cannot verify".

**Later:**

- B, the Execution map (needs D-1, D-3 and D-4).
- C, the Plan tab (needs section 16.9).
- OpenCode ACP as an implementer.
- Reviewers on other providers, and cross-machine reviewers with evidence transport.
- A claim written back to the tracker as the real cross-machine guard (W8).
- Moving work between machines with handoff.
- Team and iteration filters, and saved policy templates.

## Acceptance criteria

1. In "Selected only", with 10 eligible issues and 2 selected, a 30-minute soak creates exactly 2 attempts and none for unselected IDs.
2. Every refused Start or dispatch returns one reason from a closed set, and the UI shows it. Each `prepareDispatch` branch has a test, and there are no silent no-ops.
3. If the project revision or the issue's `updatedAt` changes between Preview and Start, Start returns `stale_preview` and launches nothing.
4. Replaying a submission with the same key, including across a server restart, returns the same work item and attempt and starts no second attempt.
5. The attempt records environment, provider instance, model and (where supported) effort, all equal to the preview.
6. A disabled, offline or auth-failed target, or a provider that is missing or unauthenticated, blocks that row with its reason. There is no fallback to another machine or provider. Each case has a test.
7. If an issue is active on server A, Start for the same tracker ID on server B is blocked. If A is offline, Start on B is also blocked, with "cannot verify".
8. The intake list shows the source server, fetch time, count and a partial flag. When the adapter truncates, the UI never says "all".
9. In the Runs list across two servers, every row carries its machine label, and rows from an offline server show the last observed time.
10. No API changes the machine or implementer of an existing attempt. Reassigning creates a new linked attempt that is visible from both sides.
11. A batch spanning two servers sends exactly one submission per server. When one row is refused, the accepted rows keep running and the refused rows stay in draft with their reason.

## What we agree on and what is still open

Sol and I agree on:

- A, B and C fit together as one product.
- A Work intake surface is needed.
- Each item is pinned to one machine.
- Submissions go to each target machine separately.
- A blocking preview comes before Start.
- Start is a separate action.
- The machine and implementer of an attempt never change.
- No issue launches unless it was selected.
- Nothing falls back silently.

Where I changed Sol's direction:

- Agent assignment is cut down to the implementer per item.
- Budget does not appear as a gate.
- The batch draft stays on the client.
- Moving work between machines is deferred.
- "Selected only" and typed refusals are named as server work that must come first.
- DeepSeek through OpenCode ACP is not available as a Symphony implementer yet, and the UI must say so.

Questions for the owner:

1. Should "Automatic" be allowed on more than one server for the same tracker scope? I recommend no, unless the projects use separate required labels so they cannot pick up the same issues.
2. When a peer server is offline, should Start fail closed, or proceed after an explicit acknowledgement? I recommend failing closed.
3. Should a claim written back to the tracker (assignee or label) become the real cross-machine guard once W8 proves write-back?
4. Should the first release wait for OpenCode ACP as an implementer, or ship with Codex only?

## Sol follow-up and Opus resolution

Sol challenged the duplicate-preflight race and a Codex-only interpretation of the requested implementer. The follow-up response supersedes those parts of the initial review; the main disposition above resolves the remaining safety qualification.

## 1. Cross-server dispatch authority: confirmed, with three additions

You are right. A duplicate preflight is a check-then-start race, and I was wrong to present it as a guard. A tracker label or assignee is not an atomic claim either. One owner-controlled Neokod server acting as dispatch authority for each canonical tracker scope is the minimum design we can defend. It reuses W6's unique request key, its accept-once-or-conflict replay rule and today's fenced claim. It adds no second scheduler.

My additions:

- **Reservation record.** One durable row, unique on scope plus tracker issue ID. It holds the target environment, the submission key and the generation. The target accepts execution only for a matching reservation and its current generation. The authority rejects late results that carry an older generation. Local execution on the authority goes through the same admission.
- **Releasing a reservation.** It is never released on expiry. A target that cannot be reached keeps the reservation, and the authority retries the same key against the same target. Release happens only on positive evidence: the target refused, or the target reports a terminal state with no surviving process. The owner can also abandon a reservation explicitly, in a recorded step that warns old work may still be running. This owner release is my addition. If you want no release path at all, say so.
- **No atomic batch across machines.** A batch is a grouping on the client only. Each item gets its own durable receipt: accepted, refused or unknown.

Until this slice passes race and restart tests, only disjoint scopes are allowed, with one execution server per scope. Within one server, the existing advisory lock and fenced claim are enough. We do not claim that routing items of one project to several machines is safe.

**Automatic mode.** Automatic runs only on the authority for its scope, and in the first slice the authority is also the execution server. A server does not know about servers it has never been told of, so this cannot be enforced against them. A client can enforce it across its saved servers: if two saved servers report the same canonical scope, it refuses to enable Automatic on the second one and shows the conflict.

**Offline handling:**

- **Authority offline.** No new admissions for that scope; Start fails closed. Work already accepted keeps running on its targets and reports back once the authority returns. The Work screen says "Authority offline, last seen <time>".
- **Target offline.** The reservation stays held and its rows show unknown with the last-seen time. Nothing is reassigned.

## 2. Implementer and plan access: confirmed

- **Owner-facing flow.** The implementer is DeepSeek V4.1 Flash through OpenCode ACP, and the reviewers are Sol and Opus. The owner is not asked about Codex again.
- **What may be claimed now.** The current runtime fixture may prove the transport, but requested Symphony stays incomplete until the real OpenCode ACP adapter and provider integration (O3 and enablement) is reviewed. The O2 spike alone is not enough.
- **Showing what is not ready.** The design keeps role templates and the execution map. Any choice whose capability is not yet verified is shown disabled with its reason. Review currently stores reviewers as plain strings (`symphony.ts:677`), so making Sol and Opus selectable reviewers needs real review-provider plumbing.
- **C is a work-item tab.** It is available from the draft stage, for plan decisions before Start, and stays available during the run. Durable decisions depend on the 16.9 decision records.

## Recommended order (no dates)

1. Finish the current core lanes and gates.
2. Build the W6 admission foundation on one server:
   - idempotent submission
   - typed refusals
   - "Selected only" as the default
   - a preflight that changes nothing
   - a stale-preview check
   - a per-item implementer snapshot recorded on the attempt
3. Integrate the OpenCode ACP Symphony adapter, plus review-provider plumbing for Sol and Opus. This gets a separate review and a live proof.
4. Build the web surfaces against the primary server:
   - Work intake, batch draft, Preview and Start
   - Runs (A) and run Summary
   - Plan and decisions (C) from the draft stage onward, once the 16.9 decision records exist
5. Build W5 B1 to B3b and slice 4 (saved machines, Symphony views per machine), limited to one execution server per scope.
6. Build the scope dispatch-authority slice, with race and restart tests. Only then route items of one scope to different machines.
7. Build the execution map (B), using D-1, D-3 and D-4. Add role templates, cross-machine reviewers with evidence transport, and reassignment with checkpoint handoff.

This ordering is a plan only. It enables no dispatch and starts no UI work.
