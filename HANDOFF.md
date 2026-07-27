# Handoff: org fork of T3 Code (Copilot + Claude, AI-Orch governed)

Continuation notes for a fresh session opened in this directory. This file is
tracked, so keep it current with what actually merged; a stale status here is
worse than none.

**Two repos, one checkout.** This is the thing to understand before reading
anything below. Both remotes point at different fork lines and they are not in
sync:

| Remote     | Repo               | Contents                                                    |
| ---------- | ------------------ | ----------------------------------------------------------- |
| `neokod`   | `kamo62/neokod`    | The live product. `main` is what ships. Currently v3.4.0.   |
| `origin`   | `kamo62/t3code`    | The older AI-Orch-governed line. Only `org/copilot-claude`. |
| `upstream` | `pingdotgg/t3code` | Fetch only; push disabled.                                  |

`origin/org/copilot-claude` is at `f4ace8bd0` and holds **31 commits that are not
in neokod `main`**. Everything from "What this fork is" downward describes _that_
line, not `main`. Do not assume a file or behaviour documented in the lower half
exists on `main` without checking.

Claims here were verified against git and GitHub on **2026-07-26**. Anything
carrying an older date is a historical record of that session, not a statement
about the current tree. When this file and `git` disagree, trust `git`.

## Current state (2026-07-26) — neokod track

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

Build artifacts are pruned after each release (Actions storage, not local disk;
distributable binaries live in Releases and are never touched).

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

Three review rounds failed. Round-5 fixed sol's round-4 findings: removed an
`agent_gateway_turn_index` that was undefined and redundant, made the worktree
ownership claim provable on disk rather than only in SQLite, and stopped the
interrupt tool promising a synchronous result the architecture cannot deliver.
**Round-5 is unreviewed.** Phase 1 is ~89 deliverables across 12+ files — build in
slices, and only after a review passes.

Relevant: upstream issue **#4456** (sub-agent UI segmentation) is effectively the
gateway's UI half. Fable and sol independently found it unbuildable today —
sub-agents are only `task.*` activities stamped with the parent's threadId, no
"queued" state exists in any provider, and per-agent file attribution is impossible
on a shared worktree. Buildable now: a worker-count badge on sidebar rows, done
server-side as a field on `OrchestrationThreadShell`.

### Verified upstream bugs worth porting (none started)

- **#4524** interrupt failures silently swallowed (`ProviderCommandReactor.ts:863`)
  — Stop looks successful while the turn keeps running. Flagged independently by
  two passes. Highest user impact.
- **PR #4381** OpenCode leaves pending permission requests stranded on
  `session.error`. Small.
- **PR #4348** unbounded OpenCode history hydration. Medium.

Unverified, do not act without reproducing: #4560 cross-project context leakage
(highest severity if real), #4561 stranded sessions after restart, #4452 turns
stuck "Working", #4513 bulk delete vs missing worktree, #4463 MCP token idle expiry.

### Smaller known items

- **`package.json` versions are stale and drifting.** `apps/web`, `apps/server` and
  `apps/desktop` all still declare `"version": "3.0.3"`. Nothing is broken by this:
  `release.yml:66` derives the release version solely from the first `## ` heading
  in `CHANGELOG.md` (`grep -m1 -E '^## '`, then strip at the first whitespace), so
  the packages are never read. But they have not moved since 3.0.3 while the
  product shipped through 3.4.0, so anyone inspecting a package gets a wrong
  answer. Decide whether to sync them to the changelog on release or drop the
  field; do not half-fix by bumping once by hand. Parked deliberately 2026-07-26.
- `formatSubagentUsage` test hardcodes US number formatting (`1,234 tok`) and fails
  under locales using a space separator. Fix the test, not the formatter. Confirmed
  still failing locally on 2026-07-26; it passes in CI because the runner is en-US.
- 9 `pre-rebase-*` snapshots were verified disposable and deleted: the only
  substantive commit (`ba938a579`, thread goal + goalStatus) is already on main.

### Branch inventory (verified 2026-07-26, after the v3.4.0 release)

Local branches went 65 → 7, remote 48 → 4, worktrees 7 → 2 over this session's
cleanup. Current state, in full:

| Branch                                     | Where            | Status                                                                                                                                                                     |
| ------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                                     | local + `neokod` | Ships. At `f163dbe32` (v3.4.0).                                                                                                                                            |
| `docs/agent-gateway-spec-round3`           | local + `neokod` | Round-5 spec, unreviewed. Do not build until a review passes.                                                                                                              |
| `feat/diff-pane-review`                    | local + `neokod` | Closed PR #34, kept in case it is reintroduced.                                                                                                                            |
| `wip/copilot-evidence-sink-simplification` | local + `neokod` | The other session's work, preserved.                                                                                                                                       |
| `feat/browser-test-lane`                   | **local only**   | 1 commit ahead of main (`e0bc2a96b`, Chromium browser-test lane M1). Review-clean, never pushed; pending a networked `vp` install and CI. **Exists on this machine only.** |
| `feat/client-identity-enrolment`           | local only       | Checked out in the `~/Code/t3code-slice1` worktree. Merged.                                                                                                                |
| `org/copilot-claude`                       | local + `origin` | The older fork line. Local is at `5424488b3` and is contained in `main`; `origin/org/copilot-claude` is ahead at `f4ace8bd0` with 31 commits absent from `main`.           |

`feat/auto-runtime-mode` was deleted on both sides when PR #51 merged.

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
