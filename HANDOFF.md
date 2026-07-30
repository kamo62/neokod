# Handoff: org fork of T3 Code (Copilot + Claude, AI-Orch governed)

Continuation notes for a fresh session opened in this directory. This file is
tracked, so keep it current with what actually merged; a stale status here is
worse than none.

**Two repos, one checkout.** This is the thing to understand before reading
anything below. Both remotes point at different fork lines and they are not in
sync:

| Remote     | Repo               | Contents                                                    |
| ---------- | ------------------ | ----------------------------------------------------------- |
| `neokod`   | `kamo62/neokod`    | The live product. `main` is what ships. Currently v3.5.2.   |
| `origin`   | `kamo62/t3code`    | The older AI-Orch-governed line. Only `org/copilot-claude`. |
| `upstream` | `pingdotgg/t3code` | Fetch only; push disabled.                                  |

`origin/org/copilot-claude` is at `f4ace8bd0` and holds **31 commits that are not
in neokod `main`**. Everything from "What this fork is" downward describes _that_
line, not `main`. Do not assume a file or behaviour documented in the lower half
exists on `main` without checking.

Claims here were verified against git and GitHub on **2026-07-30**. Anything
carrying an older date is a historical record of that session, not a statement
about the current tree. When this file and `git` disagree, trust `git`.

## START HERE — session of 2026-07-30

Read this section first. Everything below it predates this session.

### Open right now

All three are green on full CI (`Check`, `Test`, `Browser Test`, `Release
Smoke`) and none has been reviewed.

| PR                                              | What                                                             | Needs               |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------- |
| [#68](https://github.com/kamo62/neokod/pull/68) | New threads stop inheriting the viewed thread's branch (#4411)   | review, merge       |
| [#69](https://github.com/kamo62/neokod/pull/69) | Release a session holding an already-ended turn (#4713)          | **two-lane review** |
| [#70](https://github.com/kamo62/neokod/pull/70) | `Schema.is` hoist, locale-independent `formatSubagentUsage` test | review, merge       |

**#69 is the one that needs a real review.** It changes when a session releases
`active_turn_id`, in the area whose documented failure mode is bricking the
server at startup on projection rebuild (upstream's own #4626 writeup). It adds
no schema, no new status value and no projection write, which is what keeps it
safe, but two choices in it are worth arguing with:

- It deliberately skips the `liveThreadIds` guard that the v3.5.2 running-turn
  path requires. A terminal turn is terminal regardless of provider liveness,
  and requiring absence is what leaves the stuck state unrecoverable. It is
  still a widening of a pass this file describes as conservative.
- It preserves `session.lastError` rather than clearing it. The first
  implementation cleared it, which would have erased a quota or auth failure
  from the UI, since `ChatView.tsx:1251` reads that field as the thread's error
  text.

### Shipped this session (2026-07-30)

- **#65 merged** (`472c47907`). Pruned 33 shipped `.plans/`, fixed the T3
  Discord link. Its red CI was a _cancelled_ `Check` job, not a failure;
  `gh pr checks` renders both as "fail". A re-run cleared it.
- **#66 merged** (`fc27c17b7`). `auto-animate` gone, global reduced-motion
  block in `index.css`. The trade was taken deliberately: sidebar rows lose
  their add/remove/reorder animation, which cost a 2-second timer per row
  permanently.

Two defects were fixed in #66 before it could merge:

- **The lockfile was never regenerated.** `apps/web/package.json` dropped
  `@formkit/auto-animate` while `pnpm-lock.yaml` kept all three entries. CI
  installs `--frozen-lockfile`, so all four jobs died at `vp install` in ~25
  seconds with `ERR_PNPM_OUTDATED_LOCKFILE`, before running anything. Fixed with
  `pnpm install --lockfile-only`, which leaves `node_modules` alone and produced
  a diff of exactly 8 deletions with no collateral churn.
- **`usePrefersReducedMotion` was dead on arrival.** Exported with zero call
  sites. Its doc comment claimed a CSS-only guard cannot reach inline-style
  animations, which is not how the cascade works: an `!important` declaration in
  a stylesheet outranks a non-important inline one, which is exactly why the
  `index.css` block marks its properties `!important`. Removed.

**The pre-commit hook has a second confirmed instance of the `.plans/` bug.** A
lockfile-only commit has no formattable target, so `vp fmt` exits with "Expected
at least one target file" and the commit reverts. Two known paths now hit this.
Fix the hook to skip when nothing matches, rather than continuing to reach for
`--no-verify`.

`gh pr merge` **works** for the agent. What the permission classifier blocks is
`gh pr view --json` and compound `git fetch` calls, so merging succeeds but
confirming it needs a bare `git fetch` followed by `git log`. A Bash permission
rule would make this less awkward.

### Running four Codex lanes in one checkout — what it cost

#68, #69, #70 and the pruning decision were produced by four parallel sol lanes
in this single checkout, with file ownership assigned up front and every lane
told not to switch branches or commit. That part worked: no lane collided with
another, and no lane wrote outside its assignment.

What did not work is worth knowing before repeating it.

- **Three of the four lanes needed correction.** One cleared `lastError` while
  settling, which would have erased a provider's own error message from the UI.
  One reported `vp check` passing on files that were not formatted, and shipped
  a test asserting the formatter against its own `toLocaleString()` body, which
  can never fail. The rule about not trusting Codex's verification claims held
  up on both counts.
- **The read-only lane was the most valuable of the four.** It wrote no code and
  produced the pruning decision, including the IndexedDB slice nobody had
  listed. Reasoning-only delegation paid better here than implementation did.
- **The forwarder times out at 2 minutes; the Codex job does not.** Task
  notifications arrive long before the work is done. Poll
  `codex-companion.mjs status` and fetch with `result <task-id>`; do not treat
  the subagent notification as completion.
- **One lane sat in "verifying" for 23 minutes on a two-line change** and was
  cancelled with its edits intact on disk. Cancelling and finishing by hand cost
  less than waiting.
- **Branches were switched while a lane was still running**, to land two PRs.
  The rule at the top of "Environment" exists for a reason. Nothing was lost,
  because the running lane owned different files, but its verification was
  reading a tree that changed under it, which is the likeliest explanation for
  the 23-minute stall above. Land PRs after all lanes finish, not between them.

### Superseded: shipped in the 2026-07-29/30 session

- **v3.5.3** — Claude context meter no longer ratchets back after `/compact`.
  Eight defects over three review rounds; the last two rounds were found by sol.
- **`neokod` published to npm.** Installs cleanly on Ubuntu 22.04 / Node 22.
- **npm Trusted Publishing** configured, `NPM_TOKEN` deleted. There is no
  long-lived publishing credential in repository secrets.
- `docs/operations/self-hosting.md` — Traefik + Authelia forward-auth, written
  against the user's real config.

Three bugs surfaced only by doing rather than reasoning, which is the lesson
worth carrying: a release-blocking git-gc test flake, a missing `id-token: write`
permission that no dry run could catch, and a published binary reporting the
wrong version, found by installing the package and running it.

### Live problem, unresolved

**Providers will not activate on the user's home server** (`kamo@192.168.0.100`).

Ruled out by direct check: `codex` is installed (0.144.3), on `PATH` at
`~/.local/bin/codex`, and **authenticated** (`auth.json` present, `codex login
status` reports "Logged in using ChatGPT", `~/.codex/logs_2.sqlite` written
recently). `HOME` and `USER` are correct.

Confirmed separately: **`git config --global user.email` is unset** on that box.
That is a real and distinct problem — git refuses to commit without an identity —
but it does not explain the provider symptom.

Not yet gathered, because the agent's shell could not reach the host while the
user's could (both interfaces, both source addresses, port 22 closed to the
agent). Run these from the user's terminal and paste the output:

```
ssh kamo@192.168.0.100 'pgrep -af neokod; ls -la ~/.neokod/userdata/logs/; tail -40 ~/.neokod/userdata/logs/provider/*.log'
```

Two live candidates: neokod may simply not be running (never verified beyond
`--version` and `--help`), or the capability probe is failing or timing out.
There is precedent for the latter in this repo: Bedrock-backed Claude needed a
25s probe allowance in 3.3.0 for exactly this shape.

Note when comparing against a release: the installed `neokod@3.5.3` binary
reports `v3.0.3`. That mislabelling is fixed in `main` by PR #64 but is baked
into the published tarball, and npm does not allow republishing a version.

### Decisions taken, do not relitigate

- **Do not renumber toward upstream's 0.0.x.** electron-updater will not offer a
  lower version, so it strands every existing install. Recorded under "Smaller
  known items".
- **Do not build a combined agent trace.** A sol review at xhigh found it would
  be a fourth representation of state already owned by `PlanSidebar`,
  `SubagentsPanel` and the timeline's existing work-row folding. `ThreadRunBanner`
  is already the turn-activity surface, with `deriveActiveToolLabel` and
  `deriveActiveWorkStartedAt` already doing the derivation.
- **Reasoning display is a server projection problem, not UI.** Adapters already
  emit it — Codex with indexed raw _and_ summary streams, Claude as
  `thinking_delta`, Copilot suppressed for workers, Cursor and Grok not at all
  since the ACP parser ignores `agent_thought_chunk`. Common ingestion then drops
  it before the web layer (`ProviderRuntimeIngestion.ts:566-613`). Specify
  persistence and replay semantics before any UI work.
- **No standalone elapsed-time hook.** One was written and dropped in the same
  session: `useThreadRunSummary` already does wall-clock elapsed from the turn's
  persisted `startedAt` at 1Hz, and the new one collided by name with
  `formatElapsed` in `session-logic.ts:321`.

### Next, in order

1. Resolve the server provider problem above. It is the only thing blocking real
   use of what shipped. **Still not gathered on 2026-07-30**: the agent's shell
   gets "No route to host" on port 22 while the user's reaches the box. The
   command to run is in that section.
2. Set git identity on the server: `git config --global user.name/user.email`,
   then `gh auth login && gh auth setup-git`.
3. Review and merge #68, #69 and #70. #69 gets two lanes; see "Open right now".
4. Revoke the two npm tokens that were pasted into chat. Trusted Publishing
   makes them unnecessary; the secret is already deleted but the tokens remain
   valid on the account.
5. Consider `npm deprecate neokod@3.5.3`, or let the next release carry the
   corrected binary version. Leaning to the latter.
6. Build the activity-payload prune. The decision below is made; the plan is
   ready to execute.
7. Fix the pre-commit hook so a commit whose staged paths are all
   formatter-excluded does not fail.
8. Restyle `ThreadRunBanner` rather than adding new loading surfaces, per the
   sol review. **Still unspecified.** Nobody has written down what is wrong with
   how it looks now, and an unspecified visual task handed to an agent produces
   work that has to be undone. Write the brief before starting this.

### DECIDED 2026-07-30: prune payloads, do not add WebSocket compression

This settles the open question recorded under item 1 of the 2026-07-27 survey.
A sol review at xhigh, reading our code rather than upstream's numbers, found the
argument that had been missing on both sides.

**The WebSocket is not the cold-start path.** A cold open fetches the full
snapshot over HTTP (`threadSnapshotHttp.ts:23-48`); WS-embedded snapshots are a
fallback (`threads.ts:203-240`). A warm open decodes the complete cached thread
from IndexedDB and resumes only later WS events (`threads.ts:45-74`,
`storage.ts:39-58` and `:356-394`). The sidebar then prewarms up to ten visible
thread details, each retaining its activity array (`Sidebar.logic.ts:16-18`,
`:367-372`).

So compression buys nothing on the path that actually costs, and leaves the full
decoded payload in browser heap either way. Pruning removes the 1,110,122 bytes
of `data.state` from JSON parsing, IndexedDB encoding and retained client state.
The `pnpm patch` against `@effect/platform-node` that compression needs is also
a real maintenance liability: Effect platform packages are pinned to an exact
beta and every bump would require rebasing the patch and regenerating its lock
hash, and a rejected patch breaks staged desktop release builds
(`build-desktop-artifact.ts:1444-1494`). Given the `@pierre/diffs` install
history, that cost is not worth paying before profiling proves WS transport
dominates.

`data.state` is confirmed unread: no match for it anywhere in `apps/web/src` or
`packages/client-runtime/src`, and the exhaustive `payload.data` consumer in
`session-logic.ts:877-981` reads `toolName`, `kind`, `input`, `rawInput`,
`rawOutput`, `item` and `toolCallId`, never `state`.

Build plan, in order:

1. One shared server helper removing only own-property `data.state`, cloning
   only the changed activity. Test that every other top-level, nested tool and
   unknown provider key stays deeply equal.
2. Apply it at both HTTP snapshot handlers (`http.ts:27-70`), WS replay
   (`ws.ts:856-876`), and thread live, catch-up and initial-snapshot delivery
   (`ws.ts:967-1052`). Persisted events and projection tables stay unchanged.
3. **Do not skip this one.** Increment the IndexedDB version and clear only the
   derived `thread` object store on upgrade (`storage.ts:25-48`). Without it a
   warm cache keeps loading the old full payloads before WS connects, and the
   fix appears not to work. Preserve the catalog and shell stores.
4. Evidence gate: re-run the payload query, confirm zero delivered `data.state`,
   compare cold and warm snapshot bytes plus browser startup heap and time. Add
   compression only if that measurement leaves WS transport dominant.

Neither option helps a server-side heap OOM: the server selects and fully
decodes every `payload_json` before building the snapshot
(`ProjectionSnapshotQuery.ts:83-88`, `:823-845`, `:2028-2042`).

Still untested end to end: `neokod serve --mode web` actually serving, and the
`/ws` auth check returning a redirect rather than `101`. The second one matters
most — it is the difference between a proxy that protects the app and one that
only appears to.

## Current state (2026-07-28) — neokod track

Everything below concerns the neokod provider/UI/gateway track. The AI-Orch
governance track continues from "Local-first carve-out" onward and is unchanged.

### Environment (all previously-noted blockers are resolved)

- **One checkout.** The `~/Code/t3code-neokod` worktree is gone; all work happens
  in `~/Code/t3code`. The earlier split existed only because a second session was
  live in this checkout. `~/Code/t3code-slice1` is still that session's worktree,
  on the merged `feat/client-identity-enrolment` — leave it alone.
- **Toolchain works.** `vp`, `tsgo` and tests all run locally. The long-standing
  `@pierre/diffs` breakage is fixed: the repo patches it to add `./types` and
  `./utils/parsePatchFiles`, and the store copy was mis-patched. Root cause of the
  repeated install failures was NOT flaky network — the `@github/copilot-*`
  platform binaries are ~109MB each (~650MB total) and blow pnpm's default fetch
  timeout. Fix: `CI=true pnpm install --fetch-timeout 900000 --network-concurrency 2`.
- **Codex sandbox is rooted at `~/Code/t3code`.** Delegating implementation only
  works while work lives in this checkout, which is another reason not to
  reintroduce a worktree. Codex also cannot create `.git/index.lock`, so it
  reports success without committing — always verify and commit yourself.
- **Never switch branches while an agent is reading the tree.** Doing so wasted an
  11-minute sol review, which analysed a tree that lacked the changes under review.

### Shipped

**v3.3.0** (tagged, built, published) — Claude Opus 5; live Claude model discovery
via the SDK's `supportedModels()` so new models appear without a Neokod release;
Bedrock-backed Claude recognised as authenticated plus a 25s capability probe;
fractional Copilot quota counts; WCAG AA muted text in both themes; fast-mode
lightning bolt. PRs #43-#48 and #50.

**v3.4.1** (released 2026-07-27) — two verified upstream ports. Stopping a turn no
longer looks successful when the provider refuses the interrupt: `interruptTurn`
had no error handling and the reactor's top-level handler only logs, so the
failure reached the server log and nowhere else while the turn kept running.
OpenCode now clears pending approvals and questions on `session.error`; they were
only ever cleared by a reply, so an approval could sit in the UI forever with
nothing able to resolve it. PR #52.

**v3.5.0** (released 2026-07-27) — worker-count badge on sidebar rows, computed
server-side as an optional `OrchestrationThreadShell.workerCount` with migration
`034`, following the `pendingApprovalCount` precedent. The one buildable slice of
upstream #4456. PR #53.

**v3.5.1** (released 2026-07-27) — worktree removal is idempotent when the
directory is already gone, and bulk thread delete finishes instead of aborting at
the first failure, reporting how many succeeded plus each failure and its reason.
Upstream #4513. PR #54.

**v3.5.2** (released 2026-07-28) — a turn could stay stuck as running forever
after a restart. Provider lifecycle events arrive on a live stream that is never
replayed, so a provider that exited while the server was down never delivered the
event that settles the turn. Startup now makes one conservative reconciliation
pass. Upstream #4561. PR #56.

Build artifacts are pruned after each release (Actions storage, not local disk;
distributable binaries live in Releases and are never touched). Checked
2026-07-27: three artifacts totalling 87KB, so the old 20GB problem is
structurally gone now that binaries route to Releases rather than Actions.

### In flight

**3.5.3 — Claude context meter ratchet. PR #58, open, not yet released.**
Adapted from upstream #4650. `task_progress` reports tokens processed across the
whole session, which only tracks the live context while nothing has been
discarded from it, so `normalizeClaudeTaskProgressTokenUsage` used the cumulative
total as the active context size under a monotonic floor. `compact_boundary`
dropped the reading to `post_tokens` correctly and the next `task_progress` then
snapped it back up. The fix records a baseline at each compaction and measures
growth from it, and scopes the ratchet to a single compaction epoch.

Note for anyone touching this: the obvious anchor for "cumulative total at the
boundary" is `totalProcessedTokens`, and it does not work.
`makeClaudeTokenUsageSnapshot` omits that field when it is not greater than
`usedTokens`, so it is absent in exactly the case that matters. A first pass used
it, the baseline silently collapsed to `post_tokens`, and the regression test
still read the unfixed value. The baseline anchors on the last observed
`task_progress` total instead, with `pre_tokens` as fallback.

### Shipped: v3.4.0 — Auto runtime mode (PR #51)

**Released 2026-07-26 17:28 UTC.** Merge commit `f163dbe32`, tag `v3.4.0`,
GitHub release "Neokod v3.4.0" published with all 12 assets (arm64/x64 dmg + zip,
x64 exe, blockmaps, `latest.yml` / `latest-mac.yml`).

Port of upstream #4272 plus hardening upstream lacks, merged after three review
rounds with CI green on every job and both round-3 review lanes resolved. Kept as
3.4.0 rather than split into a 3.4.1: 3.4.0 was never tagged or released at that
point, so the review fixes corrected code no user had run, and a 3.4.1 heading
would have tagged v3.4.1 and skipped v3.4.0 permanently.

Upstream has two open bugs in this feature and we defend against both:

- **#4518** — a persisted `auto` fails a strict startup decoder and crash-loops the
  backend until the DB row is hand-edited.
- **#4495** — Claude turns fail immediately under Claude's `auto` permission mode.

Design: `RuntimeModeStored` decodes an unrecognised persisted value to
`FALLBACK_RUNTIME_MODE = "approval-required"` (fail-closed; deliberately NOT the
`full-access` default). Command inputs stay strict. Claude is clamped at the
**adapter** — `auto` is absent from `runtimeModeToPermission` so Claude prompts —
because a UI-only gate is bypassable by a persisted or API-supplied value.

One earlier fix was reverted rather than patched. To stop replay overwriting a
newer persisted mode, a `storedRuntimeMode` field preserved the original value
across projection writes. It read the column on _every_ row, not just unknown
ones, so `projection_threads.runtime_mode` froze at its creation value: changing
full-access to approval-required and restarting silently restored full-access,
for every provider. The whole mechanism was removed. Replay is lossy again for
unknown modes, and that loss is now permanent rather than temporary, since
bootstrap resumes from the stored cursor. Fail-closed direction, documented in
the changelog, re-select the mode to restore it.

Accepted follow-ups, not blockers: a project mapping that outlives its
draft-thread record synthesises a fresh record, so the picked mode is
unrecoverable there and the thread comes back on `approval-required`;
`CodexSessionRuntime` now sends `approvalsReviewer` unconditionally, which the
bundled server accepts but an older external codex binary might reject. The
`ProviderSessionRuntime` strict-decoding concern turned out to be smaller than
first recorded: `list` skips bad rows individually, so one corrupt row does not
stop the reaper. If that strictness is ever relaxed, use `RuntimeModeStored` in
the row schema rather than swallowing the error, or the `?? "full-access"`
defaults downstream become corrupt-to-full-access paths.

Six defects were found here across three rounds by five mechanisms (CI, my own
checks, CodeRabbit, sol, Fable). Most traced to flawed instructions rather than
the implementer, and two rounds introduced a worse bug than the one being fixed.
The last round's two reviewers each found a fail-open the other missed. Two-lane
review before merge earned its place on this one.

### Agent Gateway — spec only, never built

Synara-inspired (`github.com/Emanuele-web04/synara`): an opt-in, default-off local
MCP surface letting a running agent create and coordinate real cross-provider
neokod tasks, each a first-class thread with its own provider, model, branch and
worktree. Phase 1 is seven tools. Distinct from provider-native subagents, which
stay observation-only.

Spec lives on `docs/agent-gateway-spec-round3` (branch name says round3; content is
**round-5**). Artifact:
https://claude.ai/code/artifact/fe3e91c3-87e9-4d93-948d-aed9a24764a0
Review log: `REVIEW.md` in this checkout.

**Round 6 is committed (`15a101031`) and is the current content.** Rounds 2-5 all
failed review. Round 5 was reviewed by three independent lanes (sol, Opus, Fable):
sol returned NO-GO, the other two GO with amendments, but they agreed on nearly
every mechanical finding — the split was really "amend then start" versus "do not
start". All three confirmed the architecture is sound and the spec's citations
about our code are accurate.

The fatal round-5 defect, reproduced empirically by two reviewers on git 2.54.0:
the ownership claim marker was written _inside_ the target directory before calling
git, and `git worktree add` refuses a non-empty directory, with `--force` not
overriding it. Every gateway worktree creation would have failed. Round 6 moves the
marker out, writes it atomically, and adds the prunable recovery case.

Round 6 also drops `min(parent, configured)` for cross-provider targets (no
ordering function exists in the repo, and `auto` is the least privileged real mode
on Claude/Copilot/OpenCode but swaps the human reviewer for an AI one on Codex),
pins the ceiling to the parent's current mode rather than the value captured at
credential issuance, fixes `ready_to_send` recovery (re-dispatching the
deterministic command id hits the receipt and returns without re-emitting, and the
domain stream is hot-only, so the task stuck forever holding a reservation slot),
generalises origin to a discriminated `ThreadOrigin` so a parent-less caller need
not fake a parent, and requires a per-repository mutex because concurrent
`git worktree add` on one repo fails under config-lock contention.

Phase 1 is now ~35 deliverables across six ordered slices with five tools;
interrupt and batch create moved to Phase 1b. Slice 1 is the dedicated loopback
listener plus two read-only tools, sequenced first because the second-`HttpServer`
assumption is the one thing that can invalidate the phase and the spec itself lists
it unvalidated. **Round 6 is unreviewed.** Build in slices, after a review passes.

Relevant: upstream issue **#4456** (sub-agent UI segmentation) is effectively the
gateway's UI half. The one buildable slice, the worker-count badge, shipped in
v3.5.0.

**REVISED 2026-07-28. The "rest of it is unbuildable" conclusion no longer
holds.** Fable and sol independently reached it from the constraints that
sub-agents are only `task.*` activities stamped with the parent's threadId, that
no "queued" state exists in any provider, and that per-agent file attribution is
impossible on a shared worktree. Those readings of our code were accurate. The
conclusion drawn from them was that the missing model could not be built, and
upstream is now building it.

Five stacked PRs, open as of 2026-07-28, replacing an earlier ~3,100-line single
PR (#4551) that bundled the lot: **#4626** data model, storage and migration 043;
**#4629** populate from providers; **#4662** attribute reused subagents to the run
driving them; **#4663** the Agents panel; **#4664** hide subagent threads from
user-facing lists. #4626 introduces exactly the identity layer we found missing:
per-activation records (`SubagentActivationId`, `OrchestrationV2SubagentActivation`),
cumulative usage, a role, and an `idle` state a subagent can rest at between
activations, bridged to turn item status by an explicit total `Record` so adding a
status without giving it a timeline meaning is a compile error.

Read #4626's own writeup before porting anything. It documents that an earlier
iteration copied the raw status through, wrote a `turn-item.updated` event its own
schema could not decode, and bricked the server at startup on projection rebuild
with no in-app recovery. That is the failure mode this area actually has.

This does not make the Agent Gateway redundant, since the gateway is about
creating and coordinating real cross-provider tasks rather than displaying
provider-native ones. It does mean the gateway's UI half has an upstream
reference implementation to compare against, and that a re-survey should precede
any further gateway work.

### Upstream bug ports — status as of 2026-07-27

Done:

- **#4524** interrupt failures silently swallowed — shipped in v3.4.1.
- **PR #4381** OpenCode stranded permission requests on `session.error` — shipped
  in v3.4.1.
- **#4513** bulk delete aborts when the worktree is already gone — fixed in PR #54.

**PR #4348 unbounded OpenCode history hydration — CLOSED, deliberately not fixed.**
Do not reopen without new evidence. It is fixable in principle: the v2 client
accepts `limit` and `before` on `session.messages`. But the method we call
(`/session/{id}/message`) has no ordering parameter, the generated client does not
reorder or slice, and neither the types nor the official docs give an ordering
guarantee — only a _different_ v2 route (`/api/session/...`) documents `order` and
cursors, and it returns a different response shape. Bounding a fetch whose
truncation direction is unknown risks returning the oldest N and silently dropping
recent turns from the transcript, which is worse than the unbounded read.
`rollbackThread` is worse still: it derives a destructive revert target by index
from the full list. The real fix is migrating the hydration path to the
cursor-based route, which is a rewrite of the turn-snapshot builder, not a
parameter change.

- **#4561 stopped sessions block settling after restart — FIXED, shipped in v3.5.2** (PR #56). Provider lifecycle events arrive on a hot stream with no replay, so a
  provider that exited while the server was down never delivered the event that
  settles the turn, and the turn stayed running forever. Startup now runs one
  reconciliation pass (`apps/server/src/provider/Services/ProviderSessionReconciler.ts`
  holds the pure planner; the layer is under `Layers/`). It settles only when a
  projected running turn and a running session agree on the same `activeTurnId`, no
  live provider session exists, and a durable binding for the same provider is
  stopped or errored. Settlement goes through a `thread.session.set` domain command,
  never a projection write. Startup-only by design; add periodicity only if
  same-process pump loss is reproduced.

**Undetermined — reading cannot settle these, they need runtime reproduction:**
#4560 cross-project context leakage (still the highest severity if real; reproduce
with distinct sentinel data in two projects and inspect provider inputs for
cross-project leakage), #4452 Claude turns stuck "Working" (needs the affected
Claude version and captured SDK frames), #4463 MCP bearer idle expiry (the registry
deliberately expires at 30 minutes idle / 8 hours absolute while every
authenticated request refreshes `lastUsedAt`, so the claim needs observation across
the boundary).

All three were still open upstream on 2026-07-28. #4452 has gained reporters on
0.0.29, including one on a direct Anthropic connection with no proxy and
`ANTHROPIC_BASE_URL` unset, which weakens the network-path theory.

### New upstream issues, surveyed 2026-07-28

Checked against our tree. **None of these has a fix PR upstream**, so there is
nothing to wait for on any of them.

- **#4650 context meter ratchet — CONFIRMED in our code, fixed in PR #58.** See
  "In flight" above.
- **#4693 `@formkit/auto-animate` burns ~24% CPU permanently on an idle app —
  surface matches, not yet measured here.** We carry
  `@formkit/auto-animate@^0.9.0` (`apps/web/package.json:24`), used at
  `Sidebar.tsx:3697` and `:3706` on permanently mounted lists, which is the
  reporter's exact configuration. Their trace attributes 245 `TimerFire`/s and 122
  `requestIdleCallback`/s to the library's position polling rather than to app JS.
  Measure locally before acting; the fix direction is to drop the dependency for
  the two sidebar lists, not to tune its options.
- **#4713 thread stuck `running` after interrupt, stop becomes a no-op — BUILT,
  PR #69, open and unreviewed.** The query was re-run on 2026-07-30 and returns
  the **same single row and no newer ones**, across two further days of use.
  That is the opposite of what a live defect looks like: treat the row as stale
  residue from before the 3.0.25 and v3.5.2 fixes, and treat #69 as a defensive
  invariant rather than an incident response. The original 2026-07-28 notes
  follow unchanged.

  Their detection query, run against
  `~/.neokod/userdata/state.sqlite` on 2026-07-28, returns thread
  `514e9589-7f71-4ba1-8bf6-8d7c59af0c6f`: session `running`, active turn
  `opencode-turn-65197929…` already `completed` at 2026-05-17. Two caveats before
  weighting it: it is OpenCode rather than Claude, and it predates both the
  3.0.25 stop-settles fix and the v3.5.2 reconciler, so it may already be closed.

  What is **not** closed either way: the v3.5.2 reconciler settles only when a
  projected _running_ turn agrees with a running session. This shape is a terminal
  turn under a running session, so the reconciler skips it by design. #4713's
  suggested secondary guard, refusing to hold `active_turn_id` on a turn already
  in a terminal state, is genuinely additive to what we shipped. Re-run the query
  before building; it is the cheapest evidence available.

  ```sql
  SELECT s.thread_id, tu.state, tu.completed_at
    FROM projection_thread_sessions s
    JOIN projection_turns tu ON tu.turn_id = s.active_turn_id
   WHERE s.status = 'running'
     AND tu.state IN ('interrupted','completed','error')
     AND tu.completed_at IS NOT NULL;
  ```

Filed upstream in the last day and not yet checked against our tree: **#4710**
OpenCode skill approval never shows and the thread hangs (note **PR #4709** "Fix
OpenCode permission approval mapping" is open in the same area, filed an hour
before the issue, so check whether it covers it), **#4683** background Codex memory
activity appearing in the active conversation, **#4673** queued prompts interacting
badly with questions, **#4658** project-level `.claude/commands` not discovered
because the capability probe uses server cwd rather than the project (adjacent to
the #4414 skills work in item 3), **#4696** Claude docs still describing HOME-based
config dirs after the switch to `CLAUDE_CONFIG_DIR`.

Also open upstream and mapping onto the FORK.md platform backlog rather than onto
a bug: **#4630** cross-harness skill manager, **#4634** cross-harness MCP server
manager. **#4621** fixes #4524, which we already shipped in v3.4.1; their approach
routes the failure into an existing `provider.turn.interrupt.failed` activity via
`Effect.catchCause`, which is cheap to diff against ours.

### START HERE — next work, in order (survey 2026-07-27, re-surveyed 2026-07-28)

An upstream and Synara survey was run, then verified by sol against our code. The
findings below are **measured, not assumed** — reproduce a number before doubting
it, but do not redo the survey.

**Re-survey delta, 2026-07-28.** All three numbered items below have since merged
upstream: #4622 (item 1), #4411 (item 2), #4414 (item 3). The verdicts below are
unchanged by that, since each already said what to take and what to leave, but
there is now a reference implementation to diff against rather than a PR
description to reason from. Upstream also shipped **v0.0.29** on 2026-07-27, its
first stable in a while, and nightlies continue past it. Most of that release is
mobile, Clerk, Android and T3 Connect work that the local-first policy excludes.

**1. Adapted upstream #4622 — prune activity payloads. Highest value, ready to build.**

Measured on the live state DB (`~/.neokod/userdata/state.sqlite`, query
`projection_thread_activities`): 1,140 activity rows, 1,545,858 payload bytes.
`tool.completed` is 73.9% and `tool.updated` 20.3%, so tool activities are **94.2%**
of all payload bytes. One thread alone carries 636 KB. Within them, the
**unread `data.state` field is 1,110,122 bytes — 71.8% of all activity payload
text.** `task.progress` is only 1.54%, so the Copilot delta-dropping decision is
working.

Cause: tool `data` crosses ingestion unchanged while `detail` is capped at 180
chars (`ProviderRuntimeIngestion.ts:566-604`); Codex copies whole notification
payloads into `data` (`CodexAdapter.ts:454-488`); Claude puts full tool input and
result in both updated and completed (`ClaudeAdapter.ts:2415-2491`); ACP retains
`rawInput`/`rawOutput`/`content` (`AcpRuntimeModel.ts:308-379`). The whole payload
crosses the HTTP snapshot (`orchestration/http.ts:55-70`), WS live/catch-up/snapshot
(`ws.ts:967-1052`), and replay (`ws.ts:856-876`), and activity queries select every
`payload_json` with no row limit (`ProjectionSnapshotQuery.ts:823-845`, `:2028-2042`).

**Do NOT port upstream's patch.** Its projector keeps a narrow allowlist (command
fragments, `toolCallId`, `kind`, summarised `rawOutput`) and drops fields we
visibly render, including non-MCP tool input/output and `toolName`. Its test targets
upstream web and removed mobile code.

Build a **denylist** instead: remove only verified-unread bulk, starting with
`data.state`, pass every other key through, and apply it at all of the HTTP,
replay, catch-up, live-event and snapshot boundaries. That alone targets ~72% of
payload bytes. A closed allowlist is unsafe here because `payload` is
`Schema.Unknown`, so a new provider field would be silently deleted at every client
boundary with no schema error — labels or controls could vanish after a reconnect.
Guard it to known tool activities and add before/after equality checks for work-log
derivation and expanded tool bodies.

Fields our web client actually reads, verified, so do not prune these: approvals
`requestId`/`requestKind`/`requestType`/`detail` (`session-logic.ts:395-444`); user
input `requestId`/`questions[]` and nested question fields (`:451-543`); plans
`plan[].step`/`status`/`explanation` (`:550-604`); tasks `taskId`/`detail`/
`description`/`model`/`taskType`/`agentId`/`summary`/`lastToolName`/`usage`/`status`
(`:733-821`); errors `message`/`detail.message`/`errorCode`/`statusCode`/`errorType`
(`:858-875`); tools `itemType`/`status`/`detail`/`title` and under `data`
`toolName`/`kind`/`input`/`rawInput`/`rawOutput`/`item`/`toolCallId`/`command` plus
nested command/result/exit-code and path-like fields (`:877-981`, `:1271-1537`);
expanded rows render full input/output/MCP data
(`MessagesTimeline.logic.ts:179-208`); context-window counters
(`lib/contextWindow.ts:50-90`).

Note: this will **not** fix a server-side heap OOM, because the server has already
selected and decoded every full payload before projection. It improves client
startup and WS framing. Loopback removes the WAN benefit, not the CPU/memory one.

**Read upstream #4705 before starting this.** It is open as of 2026-07-28 and
filed explicitly as the follow-up to #4622: negotiate `permessage-deflate` on the
WebSocket, via `pnpm patch` entries against `@effect/platform-node` and
`@effect/platform-bun`, with context takeover left on so the compression window
is shared across frames. Their measurement, replaying 500 real
`thread.activity-appended` frames and counting raw TCP bytes: pruned frames
compress 4.0x, unpruned 3.7x, cold-open snapshots closer to 10x.

That reorders the case for item 1. Compression gets most of the wire-size win
without touching payload semantics at all, so it carries none of the "a new
provider field is silently deleted at a client boundary" risk that drove the
denylist-over-allowlist decision above. Pruning still wins on client CPU and
memory, which compression does not touch, and the two compose. If the goal is
bytes on the wire, compression is the cheaper and safer first move; if the goal
is client startup cost, pruning is still the one that matters. Decide which
problem is actually being solved before building either.

**RESOLVED 2026-07-30 in favour of pruning.** See "DECIDED 2026-07-30" near the
top of this file for the reasoning and the build plan. The short version is that
the paragraph above was reasoning about the wrong path: the WebSocket is not
where cold start spends its time, so compression misses the cost entirely.

**2. Upstream #4411 — new threads inherit the viewed thread's branch and
worktree. BUILT, PR #68, open and unreviewed.** Was at
`apps/web/src/lib/chatThreadActions.ts:60-79`, which explicitly copied `branch`
and `worktreePath` from the viewed thread. Only `activeDraftThread` supplies
them now, since a draft is pre-send configuration the user is editing and a
viewed thread is not. `envMode` moved with them; it derived `"worktree"` from
the viewed thread's `worktreePath`, which would otherwise have produced a thread
claiming worktree mode with no path behind it. Upstream's 14-file UI diff was
not taken.

**3. Upstream #4414 — Claude skills in the composer `$` picker. Later, server-only.**
Claude probing returns models and slash commands but no skills
(`ClaudeProvider.ts:759-766`, `:903-965`), while the composer already consumes
provider skills for `$` search (`ChatComposer.tsx:1071-1084`). Local filesystem
discovery fits us. Do not import upstream UI or pnpm artifacts.

**Do NOT do these, with reasons:**

- **#4457 Codex approval reviewer replays.** It changes only 25 orchestration-v2
  NDJSON fixtures, no production code, and we do not have that replay harness. Our
  unconditional `approvalsReviewer` is correct and our unit expectations already
  agree (`CodexSessionRuntime.ts:265-297`, `CodexSessionRuntime.test.ts:90-222`).
  This was checked specifically because 3.4.0 changed that behaviour — we did not
  break anything.
- **#4413 keep settled threads reachable.** Our sidebar already forces an active
  thread into the visible preview beyond the preview limit
  (`Sidebar.logic.ts:526-570`); upstream's `SidebarV2` target does not exist here.
- **#4640 files panel truncation.** Separate concern: workspace indexing has an
  explicit 25,000-entry cap and returns a truncation flag
  (`WorkspaceSearchIndex.ts:15-16`, `:288-299`). Activity projection cannot fix it.
- **Synara #472 reconcile stale live thread projections.** Synara already had a
  `ProviderRuntimeReconciler` before that PR; #472 only hardens it, and we have no
  reconciler for it to patch. Its _pre-existing_ design informed our #4561 fix,
  which is the useful outcome. Also excluded by the local-first policy: upstream
  #4635 and #4530 managed tunnel limits, #4556 Tailscale dev sharing, #4440 Clerk.

### Synara — re-survey 2026-07-28

v0.6.2 (2026-07-27) shipped #472 above. **v0.6.3 (2026-07-27) is the one worth
reading**, because it hardens turn settlement in the same places we have now been
twice:

- Claude retains the last turn id on the session context, so a terminal result
  arriving without live turn state can still name the turn it settles. Runtime
  ingestion drops an unattributable terminal event, which stranded the projection
  in `running` forever. **This is the SDK no-turn-id residual we documented as
  unresolved in the stop-settles-turn fix.**
- Two-lane orchestration admission, merged from contributor PR #476: control
  commands (stop, interrupt) get a dedicated queue polled ahead of the normal
  lane, so a saturated normal queue can no longer starve a stop.
- Provider commands are bounded per attempt and a timed-out one settles as
  uncertain, because their delivery lock is single-permit and process-wide, making
  a hung attempt a total outage rather than one stuck thread.
- An urgent control-plane lifecycle variant waits a bounded time for the
  per-thread lock and then proceeds without it, so a provider start that never
  returns cannot hold an interrupt hostage.

**Do not port the bounding work without reading Synara #483 first.** Filed
2026-07-28: ACP providers (Cursor and Grok confirmed) return empty turns since
v0.6.3, because the `startSession` timeout interrupts the `session/update`
consumer. Their timeout hardening shipped a regression in the same release. The
retained-turn-id change is the part with the clearest value and the least
coupling to that mistake.

Also open there and in the same family as upstream #4713: Synara **#465**, thread
stays "working" after the assistant finishes, Cancel does nothing.

**Excluded by policy generally:** anything about hosted or remote server
management. We removed cloud, Clerk, hosted pairing, relay, SSH/Tailscale and the
auth/session control plane.

### Smaller known items

- **`package.json` versions are stale and drifting.** `apps/web`, `apps/server` and
  `apps/desktop` all still declare `"version": "3.0.3"`. Nothing is broken by this:
  `release.yml:66` derives the release version solely from the first `## ` heading
  in `CHANGELOG.md` (`grep -m1 -E '^## '`, then strip at the first whitespace), so
  the packages are never read. But they have not moved since 3.0.3 while the
  product shipped through 3.4.0, so anyone inspecting a package gets a wrong
  answer. Decide whether to sync them to the changelog on release or drop the
  field; do not half-fix by bumping once by hand. Parked deliberately 2026-07-26.
- **Renumbering to track upstream was considered and rejected, 2026-07-28.** The
  question was whether to move our 3.x line closer to upstream's 0.0.x. We ship an
  auto-updater with published `latest-mac.yml` / `latest.yml`, and electron-updater
  compares semver and will not offer a lower version (`allowDowngrade` defaults to
  false), so renumbering downward strands every existing install permanently with
  no in-app path back. That is decisive on its own. Secondarily, version parity
  would imply a correspondence that does not exist: we are a hard fork that
  cherry-picks individual upstream fixes, not a tracking fork, so a Neokod
  "0.0.29" would not be upstream's 0.0.29. If the goal is making the relationship
  legible, state the baseline ("Neokod 3.5.3, based on T3 Code 0.0.29") in the
  About dialog and at the top of the changelog rather than encoding it in the
  version. Do not reopen this without a plan for the stranded-installs problem.
- ~~`formatSubagentUsage` test hardcodes US number formatting~~ and
  ~~`Schema.is(RuntimeMode)` is recompiled on every decode~~ — **both done in PR
  #70**, open and unreviewed. The test now pins digits, units and joiner while
  letting the grouping mark vary, verified against en-US, de-DE, fr-FR's narrow
  no-break space, ru-RU, sv-SE, en-IN and es-ES, where four-digit numbers are
  not grouped at all. Asserting against `toLocaleString()` was rejected: the
  formatter's body _is_ `toLocaleString()`, so that restates the implementation
  and can never fail. The `RuntimeModeStored` predicate is hoisted to a
  module-level const, with the fail-closed `approval-required` fallback
  untouched.
- **The pre-commit hook fails when every staged path is formatter-excluded.**
  Two confirmed cases now: a `.plans/`-only commit, and a `pnpm-lock.yaml`-only
  commit. `vp fmt` exits with "Expected at least one target file" and the commit
  is reverted. `--no-verify` is the workaround in use; fix the hook to skip when
  nothing matches, because reaching for `--no-verify` routinely is how a real
  formatting miss eventually ships.
- 9 `pre-rebase-*` snapshots were verified disposable and deleted: the only
  substantive commit (`ba938a579`, thread goal + goalStatus) is already on main.

### Branch inventory (verified 2026-07-30)

| Branch                                     | Where            | Status                                                                                                          |
| ------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `main`                                     | local + `neokod` | Ships. At `fc27c17b7` after #65 and #66 merged.                                                                 |
| `fix/new-thread-branch-inheritance`        | local + `neokod` | PR #68, open, CI green, unreviewed. Upstream #4411.                                                             |
| `fix/terminal-turn-active-id`              | local + `neokod` | PR #69, open, CI green, unreviewed. Upstream #4713. **Wants two lanes.**                                        |
| `chore/parked-small-items`                 | local + `neokod` | PR #70, open, CI green, unreviewed. Two parked items.                                                           |
| `docs/handoff-2026-07-30`                  | local + `neokod` | PR #67, this file.                                                                                              |
| `fix/claude-context-meter-compaction`      | local + `neokod` | PR #58, open. Context meter ratchet, upstream #4650.                                                            |
| `docs/agent-gateway-spec-round3`           | local + `neokod` | Branch name says round3; content is **round 6** (`15a101031`). Unreviewed. Do not build until a review passes.  |
| `feat/diff-pane-review`                    | local + `neokod` | Closed PR #34, kept in case it is reintroduced.                                                                 |
| `wip/copilot-evidence-sink-simplification` | local + `neokod` | The other session's work, preserved.                                                                            |
| `feat/browser-test-lane`                   | **local only**   | See the correction below. Needs a rebase, not a push. **Exists on this machine only.**                          |
| `feat/client-identity-enrolment`           | local only       | Checked out in the `~/Code/t3code-slice1` worktree. Merged.                                                     |
| `org/copilot-claude`                       | local + `origin` | Older fork line. Local `5424488b3` is contained in `main`; `origin/org/copilot-claude` is ahead at `f4ace8bd0`. |

Branches for merged PRs #51 through #57 were deleted on both sides, `docs/handoff-3.5.2`
(PR #57) included. Delete local branches only after confirming
`git branch --merged main` lists them.

**Correction to the previous entry for `feat/browser-test-lane`.** It was recorded
as "1 commit ahead of main, review-clean, never pushed", which is true and
misleading. It is 1 ahead and, as of this writing, nearly 200 commits behind, having
branched from `a1153e971` on 2026-07-12. Compute the current gap with
`git rev-list --count feat/browser-test-lane..main` rather than trusting a number
written here. The commit itself is small and sound (6 files, 204 insertions: a
blocking Chromium browser-test CI job, one `.browser.tsx` test, vite config, docs).
Pushing it as-is is pointless because CI would run against a stale base. The work
is a rebase onto current main, and the `vite.config.ts` and `apps/web/package.json`
hunks are the most likely to have moved.

**Decision pending on `origin/org/copilot-claude`.** A full triage of all 31
commits found every one either superseded on `main` (usually by an exact
patch-equivalent commit) or documentation churn. Nothing unique and wanted. `main`
is also strictly ahead, holding the in-app GitHub device login and the local-first
carve-out that branch never received. The recommendation is to retire it. **Not
done, because that branch is the sole non-symbolic ref keeping those 31 commits
alive** — no tag contains them — so deleting it makes them garbage-collectable.
Needs an explicit decision, not an agent's say-so.

Worktrees: `~/Code/t3code` (on `main`) and `~/Code/t3code-slice1` (on
`feat/client-identity-enrolment`). Leave slice1 alone; it belongs to another
session.

## Local-first carve-out — LANDED (originally written 2026-07-13)

**This is done and on `main`.** The `feat/local-first-carveout` branch and its
worktree no longer exist; nothing is waiting to be committed. Main carries the
whole sequence, including the two stages the old note described as outstanding:
`4c12112f1` (Stage 2, loopback-only), `db8de279c` (Stage 3, relay removal),
`e6c6467f7` (Stage 4, cloud/Clerk/hosted removal), `549ff8923` (Stage 5,
auth/session control plane removal) and `b7a517969` (Stage 6, `@t3tools/*` →
`@neokod/*`). Rebrand stages followed in `8e30d0405` and `25e46ed8d`.

The description below is accurate as a statement of the resulting architecture.
Native desktop, standalone `neokod
serve`, and Vite bind to `127.0.0.1`; loopback HTTP and WebSocket are direct and
have no application auth/session control plane. Desktop-managed WSL remains the
sole `0.0.0.0` exception and fails closed behind a desktop-generated HTTP bearer
plus short-lived, single-use WebSocket tickets. The bearer is topology-only and
never persisted. Agent-awareness notifications and both toast/coordinator mounts
remain local and unconditional. The package scope is `@neokod`; the remaining
rebrand work is tracked in the Neokod rebrand plan.

---

# Everything below describes `origin/org/copilot-claude`, not `main`

The sections that follow were written across sessions on the AI-Orch-governed
fork line in **`kamo62/t3code`**, not the shipping neokod line. That branch is at
`f4ace8bd0` with 31 commits never brought into neokod `main`, so a file, commit
or behaviour named below may simply not exist on `main`. Check before relying on
it. The commit SHAs quoted (`cc71b7f26`, `ae279e107`, `64200e454` and the rest)
resolve only on `origin/org/copilot-claude`.

Where the two lines solved the same problem independently, `main` has its own
implementation: subagent observability landed on `main` via PR #37
(`ddc907b4e`), unrelated to the A1-A4 slices described below.

## What this fork is

MIT fork of pingdotgg/t3code (web GUI driving local coding-agent CLIs). Org goal:
ship GitHub Copilot and Claude as the out-of-the-box agents, governed by AI-Orch
(the control plane in /Users/kamogelo/Code/ai-orch). Cursor/OpenCode/Grok stay in
code but are default-disabled. Copilot runs natively through the official
`@github/copilot-sdk` (bundled CLI spawned as JSON-RPC server); Claude runs through
the existing Claude driver, pointed at the AI-Orch gateway (`ANTHROPIC_BASE_URL` ->
`/v1/messages`; server-side backend switch `AI_ORCH_CLAUDE_BACKEND=anthropic|bedrock|foundry`,
foundry currently fails closed pending a translation adapter). Governance philosophy:
route, don't restrict; evidence over blocking, except at the MCP boundary where
AI-Orch's gateway can enforce.

## State (updated 2026-07-04 after the full review pass)

`FORK.md` is the authoritative, current conflict/feature map — read it first. This
section is a fast status summary; when the two disagree, trust `FORK.md` + git.

Branch `org/copilot-claude`, HEAD `cc71b7f26` **as of 2026-07-04**. That is no
longer its head: `origin/org/copilot-claude` has since moved to `f4ace8bd0`. The
working-tree state described here is historical; this checkout is on `main` and
clean apart from untracked `.pnpm-store/`, `REVIEW.md`, `PLAN-exec-demo.md` and
`demo.md`.

### Session update 2026-07-04c (killable workers + Copilot tasklist)

Commit `cc71b7f26` `feat(subagents+copilot): killable workers + Copilot
tasklist parity`:

- **Killable / auto-disappearing workers:** `SubagentsPanel` workers now have a
  × on tabs and cards and a Dismiss button in the selected view; finished
  workers with no progress and no summary auto-disappear. New pure helpers
  `isDismissableEmptyWorker`/`visibleSubagentCards` (tested); count/tabs/list/
  selection all run off the visible set.
- **Copilot tasklist parity (all providers now feed `turn.plan.updated`):** the
  Copilot adapter maps `session.todos_changed` → `turn.plan.updated` via a
  coalesced re-read of `rpc.plan.readSqlTodosWithDependencies` (guarded
  refreshing/dirty flags; read once on session start for resume). Pure
  `mapCopilotTodosToPlanSteps` + `normalizeCopilotTodoStatus` (free-string
  status → pending/inProgress/completed; text-less rows dropped; the `todo_deps`
  DAG is flattened for v1 — ponytail note names the ceiling). Codex/Claude/
  Cursor/Grok were already wired; Copilot was the only gap.

Verified: `vp check` 0 errors / 20 warnings; server Copilot suite 77 passed;
web full suite 1339 passed; server + web typecheck clean.

**Sub-agent results → main agent:** confirmed this is the provider CLI/SDK's
responsibility, not ours. The A2 diversion only reclassifies what the _T3 UI
transcript_ shows (worker output → `task.progress` instead of the main thread);
it never changes what the model sees. Copilot feeds the sub-agent result back
to the parent internally (`subagent.completed` + the parent's next
`assistant.message`), Codex via the collab protocol, Claude via Task tool
results — all untouched. Limitation: the panel's completion summary is the SDK
`agentDisplayName`, not the returned result text (the SDK's `subagent.completed`
carries usage/duration, not result content); the result itself lands in the
main transcript.

### Session update 2026-07-04b (live-run bug fixes + SDK tasklist audit)

Commit `0fc5ce7c3` `fix(subagents): correct panel field mapping, races, dupes,
and surfacing` fixes six issues found running the app:

- **Field mismatch (blank cards):** `deriveSubagentCards` read
  `payload.description/summary`, but `ProviderRuntimeIngestion` stores task
  text under `payload.detail`. Now reads `detail` with description/summary
  fallback. New test asserts the stored (`detail`) shape.
- **Copilot attribution race:** the `agentId→taskId` map was set inside
  `subagent.started`'s fork while worker handlers read it in other forks. All
  map set/get/delete are now synchronous in the SDK callbacks (which fire in
  event order); worker handlers capture the resolved taskId before `runFork`.
- **Codex duplicate `task.started`:** a spawn emitted it on both item/started
  and item/completed. Now emitted only on item/started. Test updated to a
  two-notification lifecycle asserting exactly one started + one completed.
- **Selection leak across threads:** `SubagentsPanel` is now keyed by
  `activeThreadId` in ChatView, resetting per-thread selection.
- **Tab a11y + disambiguation:** tabs got `role=tab`/`aria-selected`/
  `aria-label`/`title`; `deriveSubagentTabs` disambiguates duplicate names with
  `#n` and carries a `hint` (model/kind).
- **Panel never surfaced:** added a guarded auto-open in ChatView — first
  `task.started` opens the subagents surface, only when the panel is closed and
  once per thread (mirrors the plan-sidebar auto-open).

Verified: `vp check` 0 errors / 20 warnings; server full suite 1473 passed /7
skipped; web full suite 1335 passed.

Known tradeoff (not a bug): Copilot worker streaming deltas are intentionally
dropped (each `task.progress` is a durable projection row, so per-token rows
would be a storage bug). The detail-field fix means message-completion and
tool-boundary progress rows now show real text, so workers no longer look
frozen between boundaries; the panel shows a spinner while inProgress.

### SDK tasklist support (audited this session; NOT built)

All provider SDKs expose structured tasklists, and Neokod already normalizes them
into one canonical `turn.plan.updated` (`plan:[{step,status}]`) feeding
`PlanSidebar` / `/plan` / the right-panel "plan" surface:

- Codex `turn/plan/updated` (native update_plan) — wired.
- Claude `TodoWrite` tool (`isTodoTool`+`extractPlanStepsFromTodoInput`) — wired.
- Cursor/Grok ACP `cursor/update_todos` — wired.
- **Copilot — NOT wired.** The SDK has the richest: `session.todos_changed`
  signal + `session.plan.readSqlTodosWithDependencies()` (rows
  `{id,title,description,status}` + a `todo_deps` dependency graph), plus
  `session.plan_changed` and `exit_plan_mode.*`. `CopilotAdapter` subscribes to
  none. Clean next slice (mirrors A2): debounce `todos_changed`, call
  `readSqlTodosWithDependencies`, map rows → `turn.plan.updated` (normalize the
  free-string status; drop the dependency graph for v1 or extend RuntimePlanStep
  if the DAG is rendered). `readSqlTodosWithDependencies` is `@experimental` and
  fails safe (empty arrays).

### Steering / queued messages (reported; investigated, no defect found)

User reported these "don't seem to work." Audited: the Copilot adapter steering
path is structurally correct — `sendTurn` uses `mode: "immediate"` when
`ctx.activeTurnId` is set (steer) and `"enqueue"` otherwise, both valid SDK
`MessageOptions.mode` values; orchestration supports steer-supersede
(ProjectionPipeline: "a new active turn supersedes any still-running turn");
the client models steer-superseded turns (MessagesTimeline.logic). No obvious
defect located from static reading. Needs a concrete repro to fix responsibly:
which provider, and does the message error / drop silently / not display as
queued? Orthogonal to the sub-agent work.

### Session update 2026-07-04 (sub-agent panel workstream A)

Landed the review-fix slice and Workstream A slices A1–A4 (the sub-agent panel,
the user's top priority). Commits (newest first): `ae279e107` (panel key
hygiene + A5-deferral note), `fd5503006` (A4 Codex collab → task.\*),
`d05d8ed38` (A3 worker tabs + model/kind), `3c50263cd` (A2 Copilot worker
attribution), `72bfca9d3` (A1 contracts+ingestion worker identity),
`b5a0a43db` (plan docs), `b844e176b` (review-fix: shell subscriptions + goal
focus ring + migration 033 test).

- **A1 ✅** optional `agentId`/`model`/`parentToolCallId` on `task.*` payloads +
  ProviderRuntimeIngestion whitelist extension. Tests: contracts round-trip,
  ingestion survival.
- **A2 ✅** Copilot adapter `agentId -> taskId` map; worker messages/tools →
  coalesced `task.progress`, kept off the main thread; deltas/reasoning emit
  nothing; unknown agentId falls back safely. Tests added.
- **A3 ✅** `deriveSubagentCards` reads real `model`, moves `taskType` → `kind`,
  carries `agentId`; `SubagentsPanel` worker tab strip + auto-following stream;
  pure helpers exported + tested. (This alone fixed Claude's display.)
- **A4 ✅ (collab path)** Codex `collabTaskEvents`: `collabAgentToolCall` →
  `task.*` keyed on receiver thread id. Review-item path omitted (not a
  thread-item type in this schema); `agentsStates`→progress deferred (no
  per-transition `item/updated`). Tests added.
- **A5 ⏸ DEFERRED** Claude nested-content attribution is gated on the slice's
  own "step zero" live stream-json correlation fixture (`task_id` vs
  `parent_tool_use_id`). Not guessed. The determinable Claude win already
  shipped in A3.
- **A6 / Workstream B** untouched: A6 (steering) stays last; B (in-app GitHub
  device login) is gated on the manual B1 entitlement spike (OAuth client id +
  `getAuthStatus()` proof) which can't run headless here.

Verification at `ae279e107`: `vp run typecheck` clean (all 15 packages);
`vp check` 0 errors / 20 warnings (down from 21 — removed a pre-existing
`no-array-index-key`); test suites — server 1473 passed/7 skipped, web 1333
passed, contracts 188 passed. Desktop suite not run (pre-existing local
electron-install import issue documented below).

DONE and committed before this session (newest first):

```
64200e454 docs(fork): retitle APM section as parked skills-distribution layer
95bb35e67 docs(fork): record governance decoupling + correct skills framing
9664cefe9 polish(web): stronger diff green + raise slow-RPC toast threshold
db8c5879f feat(web): thread workspace rail, subagents panel, goal/fleet/mcp controls
0a0765e71 feat(copilot): decouple governance recorder from MCP gateway + MCP JSON editor
ba938a579 feat(orchestration): add thread goal + goalStatus state
189c40966 Add the governance settings section with an evidence test-connection action
68fcfebf9 Forward managed-client evidence to the AI-Orch governance endpoint
bd9996ea7 Update the fork manifest for the Copilot driver expansion and UI backlog
5a6b35242 Surface Copilot onboarding, terminal and diff slash commands, and subagent activity
1953f35f8 Add the managed-client evidence mapper for the AI-Orch governance lane
6db297af6 Extend the Copilot driver with tool identity, MCP servers, live models, governance events, custom agents, and fleet mode
adc815c66 Add Copilot MCP, agent, and evidence settings plus a Copilot raw event source
24ec4fa18 Surface the underlying SDK error message on Copilot client start failure
f0861e44b Register the Copilot driver and update settings/UI defaults
836c4de48 Add the GitHub Copilot provider driver, adapter, and text generation
66a317e7b Add the GitHub Copilot SDK dependency
4b6bddaed Add rebase scaffolding for the Copilot driver fork
```

The three original backlog items (driver fix pass, governance forwarder,
onboarding surfaces) are all landed:

- Driver fix pass: `CopilotAdapter.ts` caches `toolCallId -> {toolName, mcpServerName, mcpToolName, arguments}` at `tool.execution_start` and reuses it at complete; MCP attribution is forwarded; `CopilotProvider.ts` uses live `client.listModels()` with a static fallback; governance-grade SDK events are preserved via the `copilot.sdk.session-event` raw source.
- Governance forwarder: `ManagedClientEvidenceForwarder.ts` subscribes to both the provider runtime stream and the orchestration domain stream, batches with a bounded sliding queue, backs off on failure, and never blocks the provider stream. Test-connection RPC + governance settings UI exist.
- Onboarding: Copilot is a live provider in settings with a setup row and an AI-Orch governance section.

UI Phases 1–5 (across sessions) — COMMITTED in `ba938a579`/`0a0765e71`/
`db8c5879f`/`9664cefe9`. `FORK.md` is the authoritative per-file map; summary:

- **Phase 1 — workspace rail:** `ThreadWorkspaceRail.tsx` (+ test) mounted in `ChatHeader.tsx`. Active model (click opens picker), live terminal-running indicator, open-terminal / open-diff actions, Copilot fleet chip when `fleetMode` is on, and the `CopilotThreadControls` popover.
- **Phase 2 — slash + palette routing:** `/files`, `/subagents`, `/goal`, `/fleet`, `/mcp` composer commands; command-palette Open Files / Open Plan / Open Subagents / Switch Model / Open MCP servers; routing centralized in the pure, tested `resolveSlashCommandAction`. `/goal`/`/fleet`/`/mcp` open header popovers via the small `workspaceRailUiStore` signal. `/git`/`/handoff` intentionally omitted (would duplicate `/diff`, or no backing surface).
- **Phase 3 — Subagents panel:** `SubagentsPanel.tsx` + pure `deriveSubagentCards` (groups `task.*` activities by `taskId`), a `"subagents"` singleton right-panel kind, reachable via `/subagents` + palette. Generic timeline rows remain the fallback.
- **Phase 4 — Copilot fleet/agent controls:** `CopilotThreadControls.tsx` toggles `fleetMode` and selects `activeAgent` from existing `customAgents` via the existing `settings.providers` write path. Custom-agent authoring stays in settings.json.
- **Phase 5 — thread goal:** optional `goal`/`goalStatus` on the thread contract, persisted through the existing event-sourced `thread.meta.update` command + migration `033_ProjectionThreadsGoal`; `GoalChip.tsx` near the thread title.
- **Copilot MCP config + `/mcp` view:** an "MCP servers" JSON editor in the Copilot provider card (validated against `CopilotMcpServers`), plus `CopilotMcpControls.tsx` — the `/mcp` rail popover with per-server enable/disable toggles (a new optional `enabled` flag on the schema; the resolver drops disabled servers and never forwards the flag). Gated on the thread's active provider being Copilot; on a non-Copilot thread `/mcp` shows an info toast pointing to that agent's own MCP config.
- **Polish:** diff add/remove row backgrounds strengthened (`DiffPanel.tsx`, ~8%→~18% green so additions read clearly); slow-RPC-ack warning threshold raised 15s→30s (`requestLatencyState.ts`) so `vcs.refreshStatus` stops nagging.

IMPORTANT — two defects in the auto-generated Phase 5 were found and fixed this
session: (a) `goal`/`goalStatus` were declared with `withDecodingDefault`, making
them _required_ in the type and breaking the reducer + ~20 fixtures — changed to
`Schema.optional`; (b) the `ProjectionSnapshotQuery` `SELECT`s omitted the
`goal`/`goal_status` columns while the row schema required them — a runtime decode
failure typecheck can't catch — columns added to all four full-thread-row SELECTs.
Also wired the Subagents panel's missing open path.

Verified 2026-07-04 at HEAD `64200e454` (whole monorepo): `vp run typecheck`
clean (all 15 packages); `vp check` 0 errors (21 pre-existing warnings); full
`vp test` 4432 passed / 0 failed. NOTE: 17 desktop test files fail at IMPORT in
this checkout because the Electron postinstall never ran under the pnpm store
setup — a local env issue, not code. Fix:
`node node_modules/.pnpm/electron@41.5.0/node_modules/electron/install.js`,
then write `path.txt` (content `Electron.app/Contents/MacOS/Electron`) next to
that install.js. Done on this machine 2026-07-04; desktop suite passes after.

### Review pass (2026-07-04): fixes in the working tree, findings

A high-effort review of the Phases 1–5 + MCP/governance diff ran to completion.
**These fixes were committed; the working tree is no longer holding them.**
Verified on `main`: `033_ProjectionThreadsGoal.test.ts` exists and `GoalChip.tsx`
uses `useThreadShell`. The list is kept as a record of what changed:

- `GoalChip.tsx` / `ThreadWorkspaceRail.tsx` / `CopilotMcpControls.tsx`:
  `useThread` → `useThreadShell` for shell-sourced fields (goal/goalStatus,
  modelSelection). These are permanently mounted in the header; `useThread`
  also subscribes to the thread-detail atom whose identity changes on every
  streaming token, so they re-rendered per token during active turns.
- `GoalChip.tsx`: `focus-visible` ring on the goal status toggle (matches the
  `ContextWindowMeter` hand-rolled-circle precedent).
- NEW `apps/server/src/persistence/Migrations/033_ProjectionThreadsGoal.test.ts`:
  real-SQLite upgrade path (32 → 33: legacy row reads back `goal NULL` /
  `goal_status 'active'`) + guard idempotence. Passes.

Findings left OPEN (deliberate, minor):

- `/files` (composer + palette) opens the files right panel without a
  workspace-root gate; ChatView's files branch then renders nothing. Same
  pre-existing pattern as `/diff`; fix is a `hasWorkspace` gate or an empty
  state in the panel.
- `CopilotThreadControls`: `setFleetMode`/`setActiveAgent` are near-identical
  spread-and-patch callbacks and the component subscribes to all of
  `settings.providers` (comment documents this as deliberate). A
  `patchCopilot(partial)` helper + narrower read would tidy it.
- `SubagentsPanel`: `mode` union includes `"sheet"` but every call site passes
  `"embedded"`; narrow when convenient.

## Backlog, in priority order

Full detail lives in `FORK.md` ("Product UI backlog" + "Suggested implementation
order" + the "Sub-agent panel + in-app GitHub device login: implementation plan"
section, which is the authoritative spec for items 2 and 3 below). Items 1–5 of
the original UI order are landed. What's next:

1. ~~Commit the review-fix slice in the working tree~~ — done, see "Review pass".
2. **Sub-agent panel (user's TOP priority; Codex-reviewed plan in FORK.md).**
   Target: the Codex-desktop companion-pane experience (named worker tabs,
   per-worker narrative streams, model labels, steering only where honest).
   Slices, in order:
   - **A1 contracts + ingestion:** optional `agentId`/`model`/`parentToolCallId`
     on `task.started/progress/completed` payloads in
     `packages/contracts/src/providerRuntime.ts` AND extension of the
     `ProviderRuntimeIngestion` task-payload copy whitelist (Codex review
     catch: without the whitelist change the new fields are silently dropped
     before they reach stored activities).
   - **A2 Copilot adapter:** `agentId -> toolCallId` correlation map from
     `subagent.started`; `agentId`-tagged assistant/reasoning/tool events
     become per-worker `task.progress`, coalesced strictly at
     message-completion/tool boundaries (progress rows are durable projection
     rows; per-token emission would be a storage bug); stop dropping the
     subagent `model`. Facts: the SDK tags ~50 event types with `agentId` and
     `includeSubAgentStreamingEvents: true` is already set
     (`CopilotAdapter.ts:616`), so the data is already arriving and being
     flattened.
   - **A3 web panel:** worker tab strip inside the existing singleton
     `SubagentsPanel` (NO rightPanelStore changes; parameterized per-worker
     surfaces deferred until steering exists, per Codex review);
     `deriveSubagentCards` reads real `model`, moves `taskType` to `kind`.
     After A3 the Copilot experience matches the target screenshot minus the
     composer. Ship and evaluate here.
   - **A4 Codex adapter:** emit `task.*` from `collab_agent_tool_call`/review
     items (worker id = `receiverThreadId`, collab item id kept as fallback
     since resume-stability is unverified; model + `agentsStates` transitions
     to progress). Existing `item.*` timeline rows stay as fallback.
   - **A5 Claude adapter:** verify `task_id` vs spawning `tool_use` id, then
     use `parent_tool_use_id` (today discarded as noise,
     `ClaudeAdapter.ts:1274`) to attribute nested content into per-worker
     progress. No model, no steering for Claude.
   - **A6 steering (LAST, gated):** provider capability flag; per-worker
     composer/stop rendered only where the backend supports it. Codex first
     (`sendInput`/`resumeAgent`), Copilot session-level only, Claude none.
     This subsumes old item 8 (companion-thread mode).
3. **In-app GitHub device login (Codex-reviewed plan in FORK.md).** Slices:
   - **B1 spike (hard gate):** choose the OAuth client id (public Copilot
     device-flow id vs org GitHub App) and prove entitlement end to end:
     device flow, then `new CopilotClient({ gitHubToken })` +
     `getAuthStatus()` must report authenticated. Flow completion alone is
     insufficient (entitlement/SSO can still fail). Can run parallel to A.
   - **B2 server:** fork-owned
     `apps/server/src/provider/copilot/GithubDeviceLogin.ts` (start + poll
     honoring `authorization_pending`/`slow_down`/expiry/denial, cancellation,
     one flow per environment); token in `ServerSecretStore`
     (`apps/server/src/secrets/ServerSecretStore.ts`, confirmed present; NO
     settings.json fallback); RPCs `copilotDeviceLoginStart`/`Status` (+
     `copilotSignOut`) registered like `testManagedClientEvidenceConnection`;
     `CopilotDriver.ts` passes `gitHubToken` when stored, otherwise leaves the
     `useLoggedInUser` default so gh CLI auth / prior `copilot login` keep
     working zero-setup.
   - **B3 web:** "Sign in with GitHub" modal in the Copilot provider card
     (large copyable user code, open-URL button, live status polling, expiry
     countdown + retry, denied/error states, sign-out; the token is never
     rendered). Success routes through the existing provider refresh so
     `getAuthStatus()` confirms.
4. **Item 6 — git/diff adjacency polish.** Tighten branch/diff/review access beside the terminal and agent workflow; reuse the existing branch toolbar / diff / review surfaces.
5. **Item 7 — governance/evidence surface.** Only after the AI-Orch endpoint (uncommitted in ai-orch, see below) is proven end to end; the UI must not claim governance is active before the runtime path exists.
6. Rename + logo (inventory done below; awaiting the name).

### Platform & integration backlog (designed this session, NOT built)

Full design + research is captured in `FORK.md` → "Platform & integration backlog". Summary:

- **Shared secret storage (do first).** Route the governance `air_` credential, Jira/Rovo tokens, and MCP keys through `ServerSecretStore` instead of `settings.json` plaintext. The problem has recurred 3× — solve once before adding more credential fields.
- **MCP registry + provider-neutral injection.** A per-user "MCP" settings tab (enable + key), and lift MCP config out of `githubCopilot` so every adapter injects enrolled servers. IMPORTANT: the **org fronts MCP via a Foundry gateway** — keep the client thin (enable + credential, point at the gateway); do NOT build a heavy client-side catalog/marketplace.
- **Jira/Rovo (research done).** Official Rovo MCP `https://mcp.atlassian.com/v1/mcp`; Basic (personal token) / Bearer (service key) auth both fit our `http` MCP schema; works today for Copilot via the `/mcp` JSON editor. Lean on Rovo _summarize_ tools for the token offload, not raw fetches. `/v1/sse` retired 2026-06-30.
- **Codex SDK (decision: do NOT migrate).** `@openai/codex-sdk` is a thin `codex exec` wrapper, less capable than the current app-server integration. To drop the CLI install, bundle `@openai/codex`; gateway via `--config openai_base_url`.
- **APM (skills distribution layer) — parked.** The deferred distribution/auto-update layer on top of the Skills tab (see next bullet), not a competing skills design: auto-updating org skills with team customization (layered precedence, pinned vs rolling channels, notify-on-update); reuse existing provider-skill infra; deliver registry via the Foundry/AI-Orch gateway. No spec yet.
- **Governance mode = recorder-first, gateway opt-in — ✅ DONE.** `CopilotManagedClientEvidenceSettings` split into `enabled` (passive recording, v1) + `gatewayEnabled` (active MCP-gateway routing, default off); `resolveCopilotMcpServers` now gates gateway injection on `gatewayEnabled`, and the governance UI has a second "Route MCP through gateway" switch. Recording no longer pulls the gateway into the request path. Verified (contracts/server/web typecheck + tests + `vp check`).
- **Skills = top-level "Skills" tab, Kiro-style (design; NOT built).** A skill is just a scoped `.md` file. Surface = provider-neutral file management: a top-level **Skills** settings tab (sibling to Providers/Source Control/Connections) with **Workspace** (`.neokod/skills/`) + **Global** (`~/.neokod/skills/`) scope, list/import/enable-disable per scope — same architecture as the MCP registry surface. Injection is the mechanism, not the surface: Copilot via `skillDirectories`/`disabledSkills` on `createSession` (mirrors `mcpServers`/`customAgents` in `CopilotAdapter.ts`), Codex/Claude via their own skill mechanisms pointed at the same folders. Near-term: a `/skills` picker (same pattern as `/mcp`) surfacing provider-native skills (Codex `skills/list`, `searchProviderSkills`, `$skill`). Distribution/auto-update (APM) deferred. Rule: surface now, manage files next, distribute later.

## GitHub device-code login (plan finalized + Codex-reviewed 2026-07-04, not built)

The build plan (slices B1/B2/B3, acceptance criteria, RPC registration list,
secret-store decision) lives in `FORK.md` under "Sub-agent panel + in-app
GitHub device login: implementation plan" and in backlog item 3 above. The
sections below are the underlying evidence.

Reference implementation: /Users/kamogelo/Code/codex-lb-local (OpenAI device
flow). Its shape transfers cleanly: request device code → surface
`user_code` + `verification_url` → background token poll honoring
`authorization_pending`/`slow_down` → persist encrypted tokens
(`app/core/clients/oauth.py`, `app/modules/oauth/service.py`, RPC triad
`start_oauth`/`oauth_status`/`complete_oauth`).

SDK facts (verified 2026-07-04 against `@github/copilot-sdk` 1.0.5 +
`@github/copilot` 1.0.68 in node_modules):

- No CLI install step exists for devs at all: the SDK bundles the entire
  runtime via the `@github/copilot` platform packages and spawns it. The only
  thing missing out of the box is a GitHub token.
- The client exposes NO login RPC (methods: start/stop/create-resume-list
  sessions/getStatus/getAuthStatus/listModels/ping). Two sanctioned auth
  inputs exist in `CopilotClientOptions` (`dist/types.d.ts` ~170-205):
  `gitHubToken` (passed to the runtime via env, takes priority) and
  `useLoggedInUser` (default true: the runtime reads its own stored OAuth
  tokens from a previous `copilot login` on that machine, or gh CLI auth).
- The bundled CLI itself implements GitHub's device flow
  (`/login/device/code` → `/login/oauth/access_token` against
  `https://github.com`, visible in the app.js bundle), so the device-flow path
  to a Copilot-entitled token is proven; its OAuth client id is compiled into
  the native binary and was not extractable statically.

Design: Neokod runs the device flow itself (fork-owned server module + start/status
RPC pair, same registration pattern as `testManagedClientEvidenceConnection`),
stores the token via the shared secret-storage layer (FORK.md platform
backlog; do NOT add another plaintext settings field), and passes it to
`new CopilotClient({ gitHubToken })` in `CopilotDriver.ts`. Do not write the
CLI's internal token store and do not drive the CLI's TUI login. The setup row
in `ProviderInstanceCard.tsx` (~line 907) becomes a "Sign in with GitHub"
button showing `user_code` + verification URL with status polling;
`getAuthStatus()` stays the post-login verification.

VS Code auth reuse: NOT directly possible. VS Code keeps its GitHub session in
VS Code's own secret storage and the bundled CLI reads neither that nor the
legacy `hosts.json`/`apps.json`. What DOES work with zero setup (via the
`useLoggedInUser` default): gh CLI auth (`gh auth login`) and any previous
`copilot login` on the machine. Everyone else uses the in-app device flow.
Open item before building: pick the OAuth client id (the public Copilot
device-flow client id editor integrations use, or an org-registered GitHub
App) and verify a device-flow token from it carries Copilot API entitlement.

## Rename + logo (inventory done, awaiting the name)

User-visible branding is centralized: `apps/web/src/branding.ts` defines
`APP_BASE_NAME` (default "Neokod") with a desktop-injected
`DesktopAppBranding` override (`window.desktopBridge.getAppBranding()`).
Rename surface:

- `apps/web/src/branding.ts` base name; desktop `productName` in
  `apps/desktop/package.json` ("Neokod (Alpha)"); `apps/web/index.html`
  title/splash.
- A few dozen literal "Neokod" strings in web UI copy (settings, connections,
  update dialogs; grep `"Neokod"`) that should switch to `APP_BASE_NAME`
  interpolation as part of the rename.
- Icons: `apps/web/public/*` favicons/apple-touch and
  `apps/desktop/resources/icon.*`.
- Do NOT rename the internal package scope `@neokod/*` (1000+ references, zero
  user visibility, large rebase surface against upstream).

## Cross-repo dependency / risk

The AI-Orch receiving endpoint (v0 schema incl. `permission_decision`, Claude
backend switch, version bumps to v0.23.0-beta) is implemented but UNCOMMITTED in
/Users/kamogelo/Code/ai-orch on branch `feat/governed-client-onboarding`, awaiting
the owner's review. The governance forwarder here cannot be validated end to end
until that lands; do not describe governance as fully wired in the UI before then.
Remaining ai-orch backlog: browser SSO enrolment flow for credentials, Foundry
Anthropic translation adapter, MCP gateway tool annotations + W3C trace context,
enterprise working set (SSO/RBAC + KMS, Postgres/HA, OTel).

## Fork discipline (non-negotiable)

New code in fork-owned directories/files only; edits to shared upstream files must
be one import + one registration/mount entry wherever possible; never reformat
upstream code; update `FORK.md` for every shared file touched; lockfile changes via
`pnpm install --lockfile-only`; rebase with
`scripts/rebase-upstream.sh` per upstream release. Commit in logical units; never
push to upstream. Upstream remote fetch works but push is disabled
(`DISABLED_NO_PUSH`); add the org's internal remote as `origin` when it exists.

## Verification commands

- All packages: `vp check` and `vp run typecheck`.
- Web only: `node_modules/.bin/vp run --filter @neokod/web typecheck`; tests via `vp test run <path>` from `apps/web`.
- Server (package name `neokod`): `node_modules/.bin/vp run --filter neokod typecheck`; Copilot suite `vp test run src/provider/copilot/` from `apps/server`.
- Contracts: `@neokod/contracts` typecheck + tests.
