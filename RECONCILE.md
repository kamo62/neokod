# Upstream reconciliation — 2026-08-06

Branch judged: `feat/symphony-mode-impl` (HEAD `5978342a5`), committed state only. Upstream ref:
`upstream/main` (`e4abc31f1`). Fork point: `3201e00ad` (2026-07-09). None of the twelve upstream
commits under review is an ancestor of our branch. All diffs below were read from the actual Git
objects, not commit messages.

## Judge 1: Fable analysis

### Area A: thread settling and turn lifecycle

#### 1. What upstream actually does

Upstream's "settled" work is two unrelated mechanisms that happen to share a word.

The first is a thread-list lifecycle. `32c6012da` introduces a server-backed settled state:
`settled_override` and `settled_at` columns on `projection_threads` (migration
`033_ProjectionThreadsSettled.ts`), new `thread.settle` / `thread.unsettle` commands with decider
guards (an active session, a pending approval or user-input request, or a queued turn start rejects
the settle; real activity such as a user message or session start auto-unsettles), and a large
SidebarV2 plus mobile UI that renders active rows above a settled tail. The three follow-ups are
policy churn inside `packages/client-runtime/src/state/threadSettled.ts`:

- `193e3c62e` adds `CHANGE_REQUEST_SETTLE_IDLE_MS` (1 hour): a merged or closed PR settles the
  thread only after it has been idle that long, so follow-up conversation stays visible.
- `9cf9fc9c5` deletes that idle guard five days later: a merged or closed PR settles immediately.
- `491219bf1` adds the inverse rule: an open PR blocks the inactivity auto-settle path entirely,
  because review can take days and hiding the thread would bury work waiting on it.

Net end state of `effectiveSettled`: activity blockers first, explicit user override next, then
merged or closed PR settles immediately, open PR pins the thread active, and only then does the
inactivity window apply.

The second mechanism is a turn-lifecycle correctness fix. `501ce27b8` changes
`ProviderRuntimeIngestion.ts`: when a `session.state.changed` event moves the session to a status
other than `starting` or `running`, `nextActiveTurnId` is forced to `null` instead of being carried
forward. Before the fix, only `turn.completed` and `session.exited` cleared the active turn, so a
session that went idle, stopped or errored via a state-change event kept a stale `activeTurnId` and
the projected thread read as running forever.

For completeness on the Stop path itself: upstream's `interruptTurn` (current `upstream/main`
ClaudeAdapter, introduced in `a2ca89aa1`) does not settle the turn locally. It stops every live
subagent task via the SDK's `query.stopTask` (feature-detected, 3 s per-task and 10 s total
timeouts, best-effort) and then calls `query.interrupt()`, relying on the SDK to emit the aborted
result that settles the turn. It attacks the root cause (subagents holding the parent result and
burning tokens) and accepts the risk that a wedged stream still delays settlement.

#### 2. What ours actually does

Our fork has no settled lifecycle at all. `threadSettled.ts` does not exist; there is no
`settled_override` column, no `thread.settle` command, and thread-list organization uses the
archive model (`packages/client-runtime/src/state/archivedThreads.ts`). Grep for
`settledOverride|thread.settle|autoSettleAfterDays` over committed server and package code returns
nothing.

Our turn-lifecycle work is four commits, all shipped:

- PR #31 (`76bd86fd9` + review-hardening `40e028003`, `0166b336a`, merged as `da8916ae4`,
  release 3.0.25): Stop settles the active turn locally and immediately in
  `apps/server/src/provider/Layers/ClaudeAdapter.ts`. `interruptTurn` captures the active turn
  before any await, adds it to `interruptedTurnIds`, calls `completeTurn("interrupted")` with
  `queryContextUsage: false` (the review-found F2 fix: a live `getContextUsage` control request on a
  wedged stream would have hung Stop, reintroducing the original bug), then forwards
  `query.interrupt()`. A drain choke suppresses a stopped turn's late chatter while no real turn is
  active, absorbing late results for usage accounting keyed on turn identity, and suppresses only
  `system/status` frames (the F4 over-correction fix) so telemetry still flows. Ten lifecycle tests
  cover out-of-order, never-arriving and re-entry cases.
- `814408bc9` (PR #56): startup reconciliation pass. A projected running turn is settled only when
  the projection and session agree on the active turn id, no live provider session exists, and a
  durable binding for that provider is stopped or errored. Settlement goes through the
  `thread.session.set` domain command, never a direct projection write. Startup-only by design.
- `a709bb58b` (PR #69): the reverse shape. A session still marked running whose `active_turn_id`
  points at an already-terminal turn is released at startup, mapping the turn's terminal state onto
  the session; `lastError` follows the live-ingestion rule (`ready` clears it, other terminal
  states keep it).
- `44b52b32c` (PR #95): OpenCode settles the turn when retries hit a terminal credential failure.

What ours does not have: any handling of the live (non-restart) stale-turn case that `501ce27b8`
fixes. Our `ProviderRuntimeIngestion.ts:1293-1298` is byte-for-byte the pre-fix upstream code: a
`session.state.changed` to a terminal or idle status carries the stale `activeTurnId` forward, and
our reconcilers only run at startup. Ours also does not stop subagent tasks on interrupt; the local
settle fixes the UI immediately, but a runaway fleet keeps executing and burning tokens until the
SDK interrupt propagates.

#### 3. Which is better

Split judgment, because the two sides solved different problems.

On the settled lifecycle (thread-list): not applicable to us, and porting it would be wrong. It is
inseparable from SidebarV2 and the mobile home screen, which AGENTS.md filter 1 excludes; our
archive model covers the same user need; and the three `threadSettled.ts` commits patch a file we
do not have. The policy churn itself (idle guard added, deleted, replaced with an open-PR pin
inside eight days) is also a sign this surface has not stabilized upstream.

On turn settlement: ours is better on correctness and restart safety for the failure mode that
actually bit us. Upstream still has no local settle on Stop; a wedged stream upstream delays
settlement until `stopTask` plus `interrupt()` shake a result loose, whereas our drain settles the
UI synchronously and treats any late result as reconciliation. Our startup reconcilers
(`814408bc9`, `a709bb58b`) cover restart shapes upstream addressed separately (their #4561/#4713,
which we ported by intent already). But upstream holds two pieces we genuinely lack:

- `501ce27b8` closes the live stale-turn gap our startup-only reconcilers deliberately left open.
  It is small, mechanism-correct, and lands in a shared file at a byte-identical pre-fix region.
- The `stopTask` fleet-stop from `a2ca89aa1` is the root-cause complement to our local settle: our
  installed SDK (0.3.220, `sdk.d.ts:2562`) exposes `stopTask`, and stopping live tasks before the
  interrupt is what actually ends token burn during a runaway fleet.

#### 4. Verdict

Hybrid, weighted heavily to ours.

- Keep ours: PR #31 drain architecture, both startup reconcilers, OpenCode settlement.
- Cherry-pick upstream: `501ce27b8` (single commit, apply as-is modulo rebrand).
- Port by intent, optional but recommended: the bounded `stopTask` fleet-stop block from
  `a2ca89aa1`'s `interruptTurn` into our `interruptTurn`, placed before the local settle and
  interrupt forward. Do not take the rest of `a2ca89aa1` (large subagent-observability feature; we
  built our own in A1/PR #32). This requires adding live-task-id tracking to our session context
  (we already receive `task_id` on system task messages at ClaudeAdapter.ts:2821-2891).
- Do not port: `32c6012da`, `9cf9fc9c5`, `491219bf1`, `193e3c62e` (settled lifecycle; UI-coupled,
  archive model already covers it, target file absent).

#### 5. Reconciliation steps and conflict points

1. `git cherry-pick -n 501ce27b8`, then fix the import-free diff by hand if needed. Expected
   conflicts: none in the code hunk (our region matches the pre-image exactly; our file's drift
   since fork is elsewhere, e.g. subagent identity in A1). The test-file hunk may need context
   adjustment. Rebrand touchpoints: none in this diff.
2. Re-run the existing ingestion tests plus the new `sessionStatusAllowsActiveTurn` cases. Verify
   interplay with `814408bc9`: after the port, the startup planner's "projected running turn +
   running session" conjunction sees fewer stale shapes, which is strictly less work for it; no
   behavioral conflict, both paths dispatch through domain commands.
3. If taking the fleet-stop: add `liveTaskIds: Set<string>` to the Claude session context,
   populate from task started/completed system messages, and insert the bounded `stopTask` loop at
   the top of `interruptTurn` guarded by `context.query.stopTask !== undefined`. Add a test with a
   never-resolving `stopTask` promise proving the local settle still happens within the timeout
   budget (same discipline as T8).
4. REVIEW.md collision check: none. The P0/P1 Symphony findings live in `symphony/`,
   `sourceControl/GitHubCli.ts` and the removal gateway; Area A's changes touch
   `orchestration/Layers/ProviderRuntimeIngestion.ts` and `provider/Layers/ClaudeAdapter.ts` only.
   Per the stop-settles memory, any change to stop-lifecycle code should go through the sol+opus
   review gate before merge; that applies to step 3 in particular.

### Area B: PR linking, branch drift, worktree naming and PR status

#### 1. What upstream actually does

Five distinct mechanisms, all in files our fork shares nearly verbatim (our `GitManager.ts`,
`gitHubPullRequests.ts`, `VcsStatusBroadcaster.ts` and `CheckpointReactor.ts` have only rebrand
commits since the fork point).

- `376c149ea` (stabilize PR status lookups): wraps GitManager's per-status-poll PR lookup in a
  cache (2 min success TTL, 20 s failure TTL, capacity 2048) keyed by
  `[cwd, branch, upstreamRef, epoch]`, where git actions and explicit refreshes bump the epoch to
  bypass it. Adds a sticky last-known-PR fallback per `(cwd, branch)`: a transient lookup failure
  (rate limit, network blip) returns the previous answer instead of clearing the badge, validated
  against head identity so a branch retargeted to another remote or fork cannot inherit the old
  badge (normalized remote URL first, tracked-branch remote name second). Hardens
  `gitHubPullRequests.ts` decoding: `headRepository.nameWithOwner` and `headRepositoryOwner.login`
  become optional with reconstruction from `owner/name`, because gh < 2.47 omits `nameWithOwner`
  and the strict decode silently dropped every PR in the list. `VcsStatusBroadcaster.refreshStatus`
  switches to full `invalidateStatus` so an explicit refresh also bypasses the PR cache.
  `ensureRemote` reuses the shared `normalizeGitRemoteUrl`.
- `9a0a07167` (sticky fallback fix): both sides of the remote-URL comparison (and of the
  remoteName comparison) must be resolved before a mismatch counts as real, because
  `readConfigValueNullable` swallows config-read failures into `null`; without this, every hiccup
  resolving the current remote URL dropped a known PR badge.
- `2d31cb022` (branch drift, server part): rewrites `matchesBranchHeadContext` so head-repository
  and owner equality checks apply in all cases rather than only the cross-repository branch, and
  exports it for tests. The bulk of the commit is web UI (drift banners, ThreadStatusIndicators,
  BranchToolbar), excluded by AGENTS.md.
- `0ad91b6e7` (follow branch drift): after turn completion, `CheckpointReactor` now keeps the
  local-status result and runs `followWorktreeBranchDrift`: if the thread has a dedicated worktree
  (`thread.worktreePath === cwd`, not shared with any other thread), the checked-out branch is
  real (not detached HEAD, not a temporary worktree branch on either side), and it differs from
  the recorded branch, the thread's branch is updated via `thread.meta.update` with
  `expectedBranch` as a compare-and-swap. This repairs the case where an agent or user runs
  `git checkout` inside the worktree and the stale recorded branch silently orphans the thread's
  PR association.
- `571a8b44b` (worktree branch naming): widens `TEMP_WORKTREE_BRANCH_PATTERN` to also accept the
  RFC 4122 v4 UUID shape old mobile builds generated, and normalizes `randomHex` output to exactly
  8 lowercase hex chars.
- `edc503a7a` (PR detection without HOME): `hydratePosixHome` in `os-jank.ts` fills `HOME` from
  `NodeOS.userInfo().homedir` so gh-based PR detection works under systemd-style environments.
- `38a6e3ce6` (ref refresh resource storms): a large `GitVcsDriverCore` rework: repository-paths
  and refs-snapshot caches keyed by git common dir, coalesced refreshes, exponential backoff on
  background fetch failures (30 s base to 15 min max, replacing a flat 5 s cooldown), worktree
  branch-path parsing, plus client-runtime epoch invalidation (`vcsRefInvalidation.ts`) and web
  branch pagination.

#### 2. What ours actually does

Two parallel PR paths.

Work mode uses fork-point GitManager: `findLatestPr` runs uncached on every remote status read (a
gh invocation per poll), any failure maps to `null` via `Effect.orElseSucceed` (a transient error
clears the PR badge outright), the pre-fix `matchesBranchHeadContext`, and the strict
`nameWithOwner: Schema.String` decode (a gh < 2.47 or a null-field payload fails the whole list
decode). Nothing follows branch drift; `CheckpointReactor` discards the local-status result.

Symphony owns a separate evidence path (`apps/server/src/symphony/Evidence/PullRequest.ts`):
`create` pushes the branch, writes a deterministic PR body file, calls
`provider.createChangeRequest` with `--body-file`, then identifies the PR by exact `headRefName`
match from `listChangeRequests`; `refresh` re-finds the open PR and enriches it via
`getChangeRequestStatus` (added in `3f2e8dbdc`: `gh pr view --json
mergeable,statusCheckRollup,reviews,reviewDecision,comments`) feeding the `approveMerge` gates.
At committed HEAD every REVIEW.md defect on this path is fully open. Finding 8: `writeBodyFile` is
an optional dep the live layer never supplies, so the body-file write at PullRequest.ts:141
collapses to `Effect.void`; the dispatcher passes no `bodyFileDir` and the finalizer defaults it to
`""`, so `gh pr create --body-file /pr-...md` fails and the failure is swallowed. Finding 7
(verified against `git show HEAD`): `unresolvedComments` counts `comments[].isResolved === false`
at GitHubCli.ts:344, a field `gh pr view --json comments` never returns, so the gate is dead code.
Also open: the `JSON.parse`-in-flatMap defect at GitHubCli.ts:502 (P1); `mergeable` tri-state
collapse and never-populated `latestCommit` (P2); `refresh` filtering `state: "open"` so
merged/closed is never reflected (P2); and the fabricated `number: 0` evidence on lookup miss (P2).

Provenance note: while this review ran, a concurrent unidentified writer produced uncommitted
working-tree edits (17:24-17:45 local, ~40 files including `Evidence/PullRequest.ts`,
`Runner/Dispatcher.ts`, `Runner/ExecutionFinalizer.ts`, `sourceControl/GitHubCli.ts` and the
takeover/removal-guard files) that appear to implement REVIEW.md findings, including a
`writeBodyFile`/`bodyFileDir` fix for finding 8. Those edits are excluded from this judgment per
the committed-state rule and were not authored by this judge; an earlier draft of this paragraph
briefly described them as committed and has been corrected. They change nothing in the verdicts
below: no upstream pick touches the functions they edit, and the finding-7/8 fixes remain work our
side must land regardless of who commits it.

#### 3. Which is better

Upstream is better at the layer it addresses; it does not address our defective layer at all.

On PR-to-branch association and lookup behavior, upstream's stack (`376c149ea` + `9a0a07167` +
`2d31cb022` server part + `0ad91b6e7`) is strictly superior to our fork-point code: cached lookups
stop hammering gh on every status poll (performance, AGENTS.md priority 1), the sticky fallback
stops badge flapping on transient failures (reliability under partial failures, priority 3), the
decode tolerance stops a version-drifted gh from silently dropping every PR, and drift-follow with
a CAS keeps thread metadata honest when agents check out branches themselves, which coding agents
do constantly. All of it is backend, local-first clean, and lands in files we have only rebranded.
Two of these directly harden Symphony as well: Symphony's `listChangeRequests` decodes through the
same `gitHubPullRequests.ts`, so the strict-decode failure currently cascades into
`Effect.orElseSucceed(() => [])` in `PullRequestService` and from there into the fabricated
`number: 0` evidence (REVIEW P2); the decode tolerance shrinks that trigger surface, though the
honest-null fix remains ours to make.

On merge-gate evidence, upstream has nothing: no `getChangeRequestStatus`, no `statusCheckRollup`,
no `reviewThreads`, no review-state or mergeability model anywhere in `apps/server/src`. Upstream
sidesteps the problem our findings 7 and 8 live in because it only ever renders a PR badge and
never gates a merge on host evidence. There is no upstream fix to take for findings 7 and 8; the
fixes are ours to write (GraphQL `reviewThreads(first:100){nodes{isResolved}}` or dropping the
field, `Schema.fromJsonString` for the decode, positive merge gates, directory creation plus
surfaced errors for the body file).

Judged pieces individually: `571a8b44b` is motivated entirely by legacy mobile UUID branches; the
mobile app is carved out, our prefix is `neokod`, and the pattern widening buys us nothing. Skip.
`edc503a7a` duplicates our own `cf0ebebc4` (PR #90), which already fills `HOME` from the homedir
during PATH hydration; ours shipped first and covers the same failure. Skip. `38a6e3ce6` is
eligible under performance-first and genuinely valuable (the flat 5 s failure cooldown it replaces
is a real storm risk on flaky remotes), but it is an 800-line rework of a file where we have real
divergence (`85d255a63` idempotent worktree removal, `115f00d17`, `8a7ae4fa9`) plus a
client-runtime protocol surface; it should be its own reviewed lane, not a rider on this
reconciliation.

#### 4. Verdict

Hybrid.

- Keep ours: the entire Symphony evidence path (PullRequestService, `getChangeRequestStatus`,
  merge gates), fixed per REVIEW.md rather than replaced; upstream has no equivalent to adopt.
- Cherry-pick upstream, in this order (it is the file-history order of `GitManager.ts`:
  `f1fb03e7e → 58bd8602d → e59613f7c → 86e10d9f9`):
  1. `376c149ea` (server files only: `git/GitManager.ts` + test, `sourceControl/gitHubPullRequests.ts`,
     `sourceControl/GitHubCli.test.ts`, `vcs/GitVcsDriverCore.ts` normalize-url hunk,
     `vcs/VcsStatusBroadcaster.ts` + test; drop `server.test.ts` if it conflicts on unrelated context)
  2. `9a0a07167`
  3. `2d31cb022` (only `apps/server/src/git/GitManager.ts` + `GitManager.test.ts`; exclude every
     `apps/web` path per AGENTS.md filter 1)
  4. `0ad91b6e7`
- Defer to a separate lane: `38a6e3ce6` (port by intent against our drifted `GitVcsDriverCore`).
- Skip: `571a8b44b` (mobile-only motivation, naming diverged), `edc503a7a` (covered by `cf0ebebc4`).

#### 5. Reconciliation steps and conflict points

1. Apply the four picks with `git cherry-pick -n <sha>` one at a time, restricting to the server
   paths listed, then rebrand each: `@t3tools/*` imports become `@neokod/*`, and any `t3code`
   literal becomes `neokod` (none of the four diffs hard-codes the branch prefix, but comments
   reference T3 command names). Per AGENTS.md these are ports; where a hunk misses, re-apply the
   intent by hand rather than forcing the diff.
2. Expected mechanical conflicts: `GitManager.ts` context drift from the rebrand commits
   (`25e46ed8d`, `8e30d0405`, `b7a517969`) is comment-and-string level; the code hunks should land
   clean since no functional commit has touched the file on our side. The `376c149ea` hunk in
   `GitVcsDriverCore.ts` (delete local `normalizeRemoteUrl`, use shared `normalizeGitRemoteUrl`)
   may need manual placement because our copy has drifted; verify `normalizeGitRemoteUrl` exists in
   `@neokod/shared/git` first and add it there if the rebrand renamed or dropped it.
3. `0ad91b6e7` preconditions, all verified present on our side: `VcsStatusBroadcaster.refreshLocalStatus`
   already returns `VcsStatusLocalResult` (VcsStatusBroadcaster.ts:160-162), `thread.meta.update`
   already carries `expectedBranch` (packages/contracts/src/orchestration.ts:577), and
   `isTemporaryWorktreeBranch` exists in `@neokod/shared/git`. The port is additive to
   `CheckpointReactor.ts:531-546`. One behavioral note: upstream's motivation cites their client
   rule #4460 (PR state attributed only when checked-out branch equals recorded branch), which we
   have not ported; the drift-follow is still correct and useful for us because recorded branch
   feeds Work-mode PR lookup keys and any future strict matching, but do not port the web-side
   strict-matching rule as a rider.
4. Symphony interplay: `followWorktreeBranchDrift` cannot touch Symphony workspaces, because they
   are not thread worktrees (`thread.worktreePath === cwd` fails), and the shared-cwd guard
   excludes multi-thread paths. The Work-thread binding created by `takeOver` (from `f49bdca61`)
   does make the handed-over workspace a thread worktree; after takeover, drift-follow operating
   there is desired behavior (Work mode now owns the workspace), not a conflict.
5. REVIEW.md P0/P1 collision assessment: no overlap in edited regions. The planned finding-7 fix
   rewrites `normalizeChangeRequestStatus` and the `comments` query in `GitHubCli.ts`
   (lines ~283-351, 489-513); the planned finding-8 completion touches
   `symphony/Evidence/PullRequest.ts`, `Runner/Dispatcher.ts` and `Runner/ExecutionFinalizer.ts`;
   the planned P1 decode fix swaps `JSON.parse` for `Schema.fromJsonString` in
   `getChangeRequestStatus`. None of the four upstream picks touches any of those functions
   (`376c149ea`'s `GitHubCli.test.ts` hunk is in the pull-request-list area; if it overlaps test
   scaffolding, prefer our test file and re-add upstream's cases). Order the work so the REVIEW
   fixes and the upstream picks are separate commits; if both land in one PR, run the two-lane
   review per the security-paths memory since merge-gate code is a governance surface.
   Sequencing constraint from the provenance note above: the working tree currently holds
   uncommitted REVIEW-fix edits by another writer in `GitHubCli.ts`/`GitHubCli.test.ts` and the
   Symphony runner files. Land or explicitly discard those first; do not start cherry-picking into
   a tree where an active writer holds uncommitted state in the same files, or the picks will
   entangle with unreviewed work.
6. After the picks: `vp check`, `vp run typecheck`, and the GitManager, gitHubPullRequests,
   VcsStatusBroadcaster and CheckpointReactor test suites, run from a clean committed tree (the
   sol review's standing condition).

## Judge 2: Sol analysis (gpt-5.6-sol, high)

Judgment basis: fork `HEAD=5978342a5` on `feat/symphony-mode-impl`; upstream `upstream/main=e4abc31f1`. I read the fork through committed Git objects only. `REVIEW.md` is uncommitted, so I used it only as the requested defect checklist. No files were changed and no runtime tests were run.

## Area A: Thread settling and turn lifecycle

### 1. What upstream does

The upstream commits form two distinct mechanisms.

Turn lifecycle:

- `501ce27b8` clears `session.activeTurnId` whenever `session.state.changed` maps to an inactive state. Only `starting` and `running` may retain an active turn.
- This closes a live-event hole where a provider reports `ready`, `error`, `interrupted`, or `stopped` without a separate `turn.completed`.
- The regression specifically starts a turn, emits `session.state.changed: ready`, and expects `activeTurnId: null`.

Thread settlement:

- `32c6012da` introduces a durable explicit settlement lifecycle:
  - `thread.settle` and `thread.unsettle` commands.
  - `thread.settled` and `thread.unsettled` events.
  - Projected `settledOverride: null | "settled" | "active"` and `settledAt`.
  - SQLite persistence, snapshot transport, projection rebuild support, and client-runtime policy.
- The decider refuses settlement while:
  - A session is starting or running.
  - Approval or user input is pending.
  - A recent user message has not yet been adopted by a turn. This uses a bounded two-minute grace window.
- Real activity clears either override. Thus an explicitly settled thread wakes, and an explicitly active thread eventually becomes eligible for automatic settlement again.
- Automatic settlement remains derived in client-runtime rather than written as a server event:
  - Explicit settled override wins.
  - Explicit active override suppresses automatic settlement.
  - Merged or closed PR settles immediately.
  - Open PR prevents inactivity settlement.
  - Otherwise configured inactivity can settle it.
- Policy evolution:
  - `193e3c62e` temporarily added a one-hour warm-thread exception after merge/close.
  - `9cf9fc9c5` removed that exception, restoring immediate settlement.
  - `491219bf1` added the final open-PR rule: an open PR never auto-settles merely from inactivity.

### 2. What the fork does

The fork has stronger turn termination machinery but no thread settlement lifecycle.

Stop and late-frame handling, PR #31/release 3.0.25:

- `76bd86fd9`, `40e028003`, and `0166b336a` immediately settle a Claude turn as interrupted before forwarding the SDK interrupt.
- Interrupted turn identities are retained so late results can be absorbed without completing a successor turn.
- Late assistant, stream, user, and system-status frames are selectively drained so they cannot recreate a synthetic running turn.
- Interrupt settlement avoids the live context-usage query, since that request can hang behind the same background work that made Stop unresponsive.
- The session remains usable for a later turn.

Projection lifecycle:

- `HEAD:apps/server/src/orchestration/Layers/ProjectionPipeline.ts:73` maps a session leaving `running` to a terminal turn state.
- `HEAD:.../ProjectionPipeline.ts:1071` settles every still-running projected turn when the session becomes inactive.
- `HEAD:.../ProjectionPipeline.ts:1199` avoids treating an intermediate assistant message as turn completion while the session still owns that turn.
- `packages/client-runtime/src/state/threadReducer.ts:219` and `:281` apply the same rules optimistically.

Restart handling:

- `814408bc9` reconciles a projected running turn after restart only when there is no live provider session and a matching durable provider binding is stopped or errored.
- `a709bb58b` also clears a running session whose referenced turn is already terminal.
- Reconciliation dispatches a domain `thread.session.set`; it does not mutate projection tables, so replay and live state remain consistent.

Missing pieces:

- There is no `settledOverride`, `settledAt`, `thread.settle`, or durable thread-settlement event.
- `HEAD:apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1293` still retains `activeTurnId` for `session.state.changed`, including inactive states. Therefore the exact live-event hole fixed by `501ce27b8` remains.
- Orchestration interrupt requests are session-scoped at `ProviderCommandReactor.ts:906`; the adapter’s optional turn-id correlation is not used by that public path.

### 3. Comparative judgment

Correctness:

- Fork wins for immediate Stop behavior, late-frame containment, projection turn termination, and conservative startup reconciliation.
- Upstream wins for the missing live inactive-state edge and for an explicit, durable thread settlement model.
- Replacing fork lifecycle code with upstream code would be a regression. The two implementations are additive.

Restart safety:

- Fork is materially stronger for stuck turns because it reconciles persisted projections against live sessions and durable bindings.
- Upstream is stronger for user settlement intent because explicit settle/unsettle survives restart and projection rebuild.
- Upstream automatic settlement is not fully restart-authoritative. PR and inactivity classification is recomputed client-side. If PR discovery fails after restart, “no PR” can be indistinguishable from “PR state unknown”; that can defeat the open-PR protection unless the port adds an explicit unknown state.

Fit:

- The backend lifecycle, contracts, persistence, and client-runtime policy are local-first compatible.
- All sidebar and mobile portions of `32c6012da` violate the fork’s sync policy and should be excluded.
- Neither implementation repairs Symphony’s separate run-attempt cancellation, orphan-process, or restart-recovery findings in `REVIEW.md`. Symphony does not use the ordinary thread-settlement lifecycle as its durable work-item state machine.

### 4. Verdict

**Hybrid.**

Retain the fork’s:

- `76bd86fd9` → `40e028003` → `0166b336a`
- `814408bc9`
- `a709bb58b`
- Current projection and client reducer turn-settlement behavior.

Port, in this order:

1. `501ce27b8`, complete mechanism and regression.
2. `32c6012da`, only contracts, server decider/projector, persistence, snapshots, and the pure client-runtime settlement policy.
3. `491219bf1`, open-PR inactivity guard.

Do not port:

- `193e3c62e`, because its warm-thread exception was intentionally superseded.
- Any net code from `9cf9fc9c5`; it restores the immediate merged/closed behavior already present in `32c6012da`. Use it as the semantic authority for the final policy.
- Sidebar or mobile changes from `32c6012da`.

### 5. Reconciliation and conflicts

1. Apply `501ce27b8` to the fork’s current ingestion switch. Preserve `session.started` and `thread.started` behavior during a live turn.

2. Add the settlement schema as a new migration, likely `039`, not upstream’s `033`. Fork migrations `033` and `034` already hold goal and worker-count fields, followed by Symphony `035` through `038`.

3. Merge settlement fields into the fork’s extended orchestration schemas and repositories. Do not replace goal, worker, expected-branch, or Symphony-era fields with upstream snapshots.

4. Extend the current decider with settle/unsettle cases and activity-driven unsettlement. Preserve the fork’s `expectedBranch` compare-and-swap and other newer command invariants.

5. Keep the current `ProjectionPipeline` turn logic. Add the settled projection alongside it rather than taking upstream’s older pipeline wholesale.

6. Add a conservative “PR state unknown” input to automatic settlement. An unsuccessful host lookup should keep an inactive thread visible; a confirmed absence may allow inactivity settlement.

7. Test the combined interleavings:
   - Stop settles immediately, then late Claude frames arrive.
   - Session changes directly from running to ready/error without `turn.completed`.
   - Explicit settlement survives projection rebuild.
   - Real activity clears both settled and active overrides.
   - Open PR never inactivity-settles.
   - Host lookup failure after restart does not masquerade as “no PR”.
   - Startup reconciliation remains no-op for a genuinely live provider session.

## Area B: PR linking, drift, worktree naming, and status

### 1. What upstream does

- `571a8b44b` standardizes temporary branches as `t3code/<8 hex>`, normalizes UUID-producing callbacks to eight hex characters, and recognizes old RFC 4122 v4 mobile branch names.
- `376c149ea` adds:
  - Two-minute successful PR lookup caching.
  - Twenty-second failure caching.
  - Explicit cache epochs for forced refreshes.
  - A last-successful PR fallback fenced by cwd, branch, upstream, normalized remote URL, and remote identity.
  - GitHub decoder compatibility with older `gh` versions that omit `headRepository.nameWithOwner`.
- `9a0a07167` corrects that fallback: a temporarily missing remote URL is treated as unknown rather than evidence the remote changed.
- `2d31cb022` fixes cross-repository matching. A checkout whose configured remote is itself the PR’s fork can now match a GitHub cross-repository PR when repository identity agrees.
- `38a6e3ce6` prevents ref-refresh storms:
  - Repository paths and common Git directory are cached.
  - One `for-each-ref` snapshot replaces repeated scans.
  - Snapshots live for two minutes; forced refreshes coalesce for five seconds.
  - Epochs and generations prevent an invalidated slow scan from publishing stale results.
  - Client-runtime uses revision-checked persisted snapshots and a per-environment persistence lock.
  - Git fetch failures receive exponential cooldown rather than five-second retries.
- `edc503a7a` hydrates `HOME` before finding or running `gh`, fixing service environments without a home variable.
- `0ad91b6e7` adopts branch drift after a completed ordinary Work turn:
  - Reads the actual checked-out branch.
  - Rejects detached and temporary branches.
  - Requires an exclusively owned dedicated worktree.
  - Dispatches `thread.meta.update` with `expectedBranch` as a compare-and-swap.

### 2. What the fork does

The fork has a broader provider architecture but weaker ordinary PR status stability.

Strengths:

- `GitWorkflowService` routes through VCS and source-control provider registries rather than hard-coding GitHub.
- `GitManager` already supports GitHub, GitLab, Bitbucket, and Azure DevOps change requests.
- Fork `expectedBranch` support is already present, making `0ad91b6e7` relatively easy to adapt.
- HOME hydration is already implemented by fork commit `cf0ebebc4`; `HEAD:apps/server/src/os-jank.ts:28-53` resolves and sets HOME before shell and CLI probing.
- Ordinary `GitManager` already has a correct body-file pattern at `HEAD:apps/server/src/git/GitManager.ts:1360-1388`: write a temp file, invoke the provider, then remove it in `ensuring`.

Weaknesses:

- `GitManager` has only a one-second status cache. It has no dedicated PR cache or repository-fenced last-successful fallback.
- Its `matchesBranchHeadContext` is the pre-`2d31cb022` form, so it rejects a valid cross-repository PR whenever the expected checkout context is classified as non-cross-repository.
- `CheckpointReactor` refreshes local status after a turn but discards the result. It does not follow branch drift.
- Git refs still use separate scans and a five-second client query stale time. The server’s broadcaster already has 30-second to 15-minute remote polling backoff, but the Git driver’s own upstream-fetch failure cache remains five seconds.
- Temporary worktree naming is already `neokod/<8 hex>`. The mobile UUID compatibility from upstream has no local-first consumer.

Symphony-specific defects:

- `PullRequestService.create` pushes the actual current branch but ignores the returned branch and creates/searches the PR using the originally assigned `workspace.branch`.
- Reused Symphony workspaces return the derived/tracker branch without verifying the checked-out branch. A branch changed by an agent persists across restart while Symphony continues reporting the original.
- The PR body is optional and unwired in production, then the finalizer supplies an empty directory. This is the `REVIEW.md` P0.
- `getChangeRequestStatus` reads `gh pr view --json comments`, whose comment objects cannot carry review-thread resolution. `unresolvedComments` therefore reports zero.
- The JSON parser can defect, `UNKNOWN` mergeability becomes false, and `latestCommit` is never queried.
- Refresh queries only open PRs, so merged or closed evidence remains stale.
- A failed post-create lookup fabricates PR number zero.

### 3. Comparative judgment

Correctness and reliability:

- Upstream is better for ordinary PR association, transient host failure behavior, cross-repository identity, ref refresh pressure, and Work-thread branch drift.
- Fork is better architecturally for Symphony and non-GitHub providers, but its current Symphony evidence path is not correct enough for merge gating.
- Upstream does not solve the two named `REVIEW.md` defects. It sidesteps them:
  - It does not implement Symphony PR-body wiring.
  - It does not claim unresolved review-thread status through the broken `comments` field.
- Upstream’s PR cache is suitable for display and settlement classification, not for Symphony merge approval. A two-minute cached result or sticky fallback is not current host evidence.

Restart safety:

- Upstream branch adoption is durable because it writes thread metadata.
- PR cache fallback is process-local; after restart it must query the provider again.
- Ref persistence is generation-protected across client restart.
- `0ad91b6e7` does not cover Symphony attempts, which have their own workspace and work-item persistence.

Fit:

- Backend/cache/provider fixes fit local-first.
- Mobile legacy naming and all UI changes should be excluded.
- Keep the `neokod` prefix.
- Keep the SourceControlProvider abstraction. Adapt upstream algorithms into it rather than replacing it with GitHub-specific flows.

### 4. Verdict

**Hybrid.**

Port intent in this order:

1. Backend portions of `376c149ea`.
2. `9a0a07167`.
3. Server `GitManager` portion of `2d31cb022`.
4. Server, contracts, and client-runtime ref-cache/invalidation portions of `38a6e3ce6`.
5. Server portion of `0ad91b6e7` for ordinary Work threads.

Keep from the fork:

- `GitWorkflowService`, VCS drivers, SourceControlProvider registry, and provider-neutral Symphony evidence design.
- Existing `neokod/<8 hex>` temporary naming.
- Existing HOME hydration.
- Existing VCS broadcaster backoff.

Skip:

- `571a8b44b`. Its useful canonical form already exists; its remaining behavior is mobile compatibility, and its callback normalization can silently produce fewer than eight characters from invalid input.
- `edc503a7a`, already independently implemented.
- Every UI/mobile change in `2d31cb022` and `38a6e3ce6`.

### 5. Reconciliation and conflicts

1. Fix the Symphony evidence root defects before treating any PR-status port as acceptance proof:
   - Reuse the existing `GitManager` temp-body pattern.
   - Make the file write mandatory, scoped, and cleanup-backed.
   - Do not swallow PR creation into a successful `ready_for_review` state without recording the failure.
   - Never fabricate PR number zero.

2. Make Symphony branch identity authoritative:
   - On workspace reuse, read the actual checked-out branch.
   - Re-read it at finalization because the agent may change it during the run.
   - Use that branch consistently for evidence, push, provider `headSelector`, and lookup.
   - As a final guard, consume the branch returned by `pushCurrentBranch`.
   - `0ad91b6e7` alone does not cover this path.

3. Repair GitHub host enrichment:
   - Obtain review-thread resolution from paginated GraphQL `reviewThreads`, or omit the field until it is available.
   - Decode JSON with `Schema.fromJsonString`.
   - Represent mergeability as true, false, or unknown.
   - Query and record the latest commit.
   - Make merge approval require positive fresh evidence rather than treating absent fields as passes.

4. Refresh Symphony evidence by stored PR reference or an all-state lookup. Do not query only `state: "open"`.

5. Keep the upstream PR cache strictly in ordinary status presentation. Symphony `approveMerge` must bypass it and issue a fresh host query.

6. Port `0ad91b6e7` using the fork’s existing `expectedBranch`. Its raw worktree-path equality collides with the planned `REVIEW.md` canonical-path fix. Canonicalize both sides using the existing filesystem real-path facilities before exclusivity checks.

7. Port `38a6e3ce6` carefully around the fork’s newer VCS abstractions:
   - Preserve the existing broadcaster’s exponential backoff.
   - Add the missing common-directory ref snapshot, refresh coalescing, generation fencing, and client invalidation.
   - Do not replace provider registry routing or import mobile persistence.

8. Required regressions should include:
   - Fork-origin cross-repository PR association.
   - Transient remote URL failure retaining the last known PR.
   - Explicit refresh bypassing PR cache.
   - Slow ref scan invalidated mid-flight cannot republish.
   - Agent checkout during a Work turn durably updates thread branch.
   - Agent checkout during Symphony uses the actual branch for PR creation, including after restart.
   - PR-body production wiring with a real filesystem seam.
   - GitHub unresolved review threads, malformed output, unknown mergeability, latest commit, and merged/closed refresh.

Overall: upstream should supply missing algorithms, not replace the fork architecture. The highest-risk mistake would be landing the PR caching and branch-linking improvements, then treating them as proof that Symphony’s PR creation and merge gates are fixed. They are separate paths.

## Final adjudication (orchestrator)

Judged 2026-08-06 against Judge 1 (Fable) above and Judge 2 (sol) below. The two judges worked
independently and did not see each other's output.

### Where they agree (adopt as settled)

- Area A core: keep the fork's stop/drain machinery (76bd86fd9, 40e028003, 0166b336a) and the
  startup reconcilers (814408bc9, a709bb58b); upstream's lifecycle code would be a regression if
  taken wholesale. Cherry-pick 501ce27b8 (clear stale active turn on live session.state.changed);
  both judges verified our ingestion still has the exact hole it closes.
- Area B core: keep the fork architecture (SourceControlProvider registry, VCS drivers, Symphony
  evidence design). Port, in order: 376c149ea (PR lookup caching + fallback + gh decode
  tolerance), 9a0a07167 (missing remote URL treated as unknown), 2d31cb022 server portion
  (cross-repository PR matching), 0ad91b6e7 (branch-drift adoption via expectedBranch CAS).
- Skip on both scorecards: 571a8b44b (mobile-motivated; our neokod/<8hex> naming is already
  canonical) and edc503a7a (our cf0ebebc4 already hydrates HOME).
- Upstream sidesteps, and does not fix, the REVIEW.md Symphony defects (PR body file, comments
  based enrichment). Those fixes remain ours to write, and the ports must not be presented as
  evidence they are fixed.

### Where they split, and the call

1. 32c6012da settlement lifecycle backend. Fable: skip entirely (UI-coupled, archive covers it).
   Sol: port the backend slice (contracts, decider, persistence, pure client policy) plus
   491219bf1, with a new "PR state unknown" input. Call: DEFER, conditional. Sol is right that the
   backend slice is not excluded by the AGENTS.md UI filter, but a durable settlement lifecycle
   with no UI consumer is dead weight; we are not porting sidebar v2. If we later adopt a
   settled/auto-tidy UX, port the backend slice then, exactly per sol's plan (migration 039, PR
   unknown tri-state, the seven interleaving tests).
2. 38a6e3ce6 ref-storm rework. Fable: defer to its own lane (GitVcsDriverCore genuinely
   diverged). Sol: port carefully around our abstractions. Call: BOTH — it becomes its own
   follow-up lane, executed with sol's porting constraints (keep broadcaster backoff, add ref
   snapshot + coalescing + generation fencing, no mobile persistence).
3. Fleet-stop (a2ca89aa1 stopTask) into interruptTurn. Only Fable raised it. Call: optional
   backlog item; real value (ends runaway token burn) but not part of this reconciliation.

### Additional binding constraints from sol (adopted)

- approveMerge must bypass every PR cache and demand a fresh host query; cached/sticky PR data is
  for display and settlement only.
- Symphony branch identity must be authoritative: read the actual checked-out branch on workspace
  reuse and again at finalization, consume the branch returned by pushCurrentBranch, use it for
  evidence/push/headSelector/lookup. 0ad91b6e7 does not cover this path.
- Enrichment repair: paginated GraphQL reviewThreads (or omit the field), Schema.fromJsonString,
  tri-state mergeability, record latestCommit, refresh by stored PR reference not state:"open",
  never fabricate PR number 0.
- 0ad91b6e7's raw worktree-path equality must be canonicalized (real-path) to avoid colliding
  with the planned REVIEW.md canonical-path fix.

### Sequenced execution order

1. Fix the REVIEW.md P0/P1 root defects (removal gateway, cancelRun, approveMerge gates, PR body
   file, lifecycle fencing, enrichment) — none of the ports below may be conflated with this.
2. Cherry-pick the consensus set: 501ce27b8, then 376c149ea -> 9a0a07167 -> 2d31cb022(server) ->
   0ad91b6e7 (canonicalized), with sol's regression list as the test bar.
3. Dedicated lane: 38a6e3ce6 adaptation.
4. Conditional/backlog: 32c6012da backend + 491219bf1 (only with a settled UX), fleet-stop port.

## External reference: KiroCrew patterns applicable to Symphony (2026-08-06)

Reviewed https://github.com/kirodotdev/KiroCrew (persistent agent gateway; Python; task runner +
scheduler + approvals over ACP). Architecture is a personal-agent daemon, not a code-work
scheduler, so nothing ports as code. Four patterns are worth adopting as design intent:

1. Finalization checkpoints. KiroCrew resumes task runs from a per-step checkpoint set and skips
   completed steps unless --fresh. Symphony analog: make ExecutionFinalizer a checkpointed
   pipeline (validated -> pushed -> PR created -> evidence persisted -> transitioned) so restart
   recovery resumes finalization instead of re-running the whole agent. Directly addresses sol
   review P1.11.
2. Headless deny-by-default approvals with audit reasons. Their standalone runner denies any tool
   not on an explicit allowlist and logs reason: headless_no_authorization. Symphony autonomous
   runs should adopt the same semantics and audit vocabulary for approval policy classes.
3. Failure lessons fed to retries. They persist failure-derived lessons into future sessions.
   Symphony retries currently restart blind; persist a per-item failure digest (validation output,
   error class) and inject it into the next attempt prompt. Also the right shape for
   requestChanges -> continuation turns (fixes the stranded changes_requested lifecycle, sol
   P1.5, as a goal-loop instead of a parked state).
4. Session multiplexing. Their shared ACP runtime multiplexes session handles instead of
   process-per-session. Relevant later for per-issue Codex app-server spawn cost under provider
   concurrency limits.

Skip: messaging surfaces, memory/skills subsystem, dashboard apps (non-local-first or orthogonal).
