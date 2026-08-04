# Symphony Mode Technical Plan

## Purpose

This document is the implementation plan for Symphony Mode, the second top-level operating mode
in Neokod. It is written for engineering review before any implementation starts.

Sources:

- `Neokod Symphony Mode Product Requirements.pdf` (PRD, v0.1, 3 August 2026). Referenced as PRD
  with section numbers.
- OpenAI Symphony specification `SPEC.md` (Draft v1, language-agnostic).
  https://github.com/openai/symphony/blob/main/SPEC.md. Referenced as SPEC with section numbers.
- The current Neokod codebase on branch `feat/symphony-mode`, which is where this work will land.

Guiding constraints, in priority order:

1. Do not create a second, unrelated execution stack. Symphony reuses the provider, git, workspace,
   persistence, secret, process, and observability foundations that Work Mode already has.
2. Keep the two modes' domain models separate. The existing orchestration engine is a user-driven
   CQRS for threads and projects; Symphony is a daemon-driven scheduler. They share platform
   services, not aggregate state.
3. Autonomy is bounded by policy. There is no unrestricted mode. Merge is off by default.
4. Restart safety and idempotency are first-class, not afterthoughts.

Verification gate for every workstream: `vp check` and `vp run typecheck` must pass; `vp test`
for the affected package suites.

## Revision history

**Revision 1 (4 August 2026).** Two independent review passes against the PRD and the codebase
produced 36 findings, 6 of them blockers. Substantive changes:

- Dispatch dedup claim corrected. The storage layer does not support the "impossible across
  processes" language; the real guarantee, plus `busy_timeout` and owner-token work, is in section 4.
- `thread/start` sequence corrected. `V2ThreadStartParams` carries no prompt or title, so the first
  prompt goes on `turn/start` (section 8.1).
- Live request registry added (8.3.1). Approvals and agent questions are blocking JSON-RPC
  requests; a persisted row cannot answer one. This was the largest architectural omission.
- Security step A rewritten as router-wide validation with configurable public Host/Origin pairs,
  because the original fixed allowlist would have broken reverse-proxied deployments (13.2).
  Step B split into WS-A2 covering all six delivery contexts, gating Phase 2 (13.3).
- Workspace ownership added as a handoff prerequisite (16.0). Both modes could previously delete a
  worktree the other was using.
- Approval slice moved into Phase 2 as WS-J2; WS-J's exit criterion was unreachable without it.
- Generated fallback summaries removed from evidence (section 10); they defeat `insufficient`.
- Host-side workspace containment specified as a real boundary, not a sandbox setting (7.1).
- Tracker scope widened to all five upstream adapters, Jira prioritised second (5.0.1).
- Pull-request evidence gap documented: creation is multi-host and free, enrichment exists for no
  host and is per-host Phase 5 work (10.1).
- Testing section cut from broad coverage to seven correctness-invariant suites, with the
  deletions and their justification recorded (section 19).
- Config gaps closed: `maxAttempts`, `initialRetryDelayMs`, `maxRunDurationMs`, provider
  concurrency, poll-interval bounds, approval policy classes, `waitTimeoutMs`.
- Missing RPCs added for queue overrides, repository pause, review actions and user-input responses.

## 1. Current state assessment

### 1.1 What already exists that Symphony can build on

| Capability | Where | Reuse note |
|---|---|---|
| Codex app-server protocol client | `packages/effect-codex-app-server/src/{protocol,client}.ts` | Typed NDJSON-over-stdio JSON-RPC client, request/notification routing, schema-typed methods, error algebra. This is the protocol layer the agent runner needs. |
| Codex driver config and instance model | `apps/server/src/provider/Drivers/CodexDriver.ts`, `Services/ProviderInstanceRegistry.ts`, `Layers/ProviderInstanceRegistryHydration.ts` | Provider settings resolution, shadow-home materialization (`CodexHomeLayout`, `codex_personal`/`codex_work`), availability probing. Symphony resolves Codex config and model from here. |
| Codex session runtime (reference) | `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | Reference for spawn (`codex app-server`), `initialize` handshake, `thread/start|resume`, `turn/start|interrupt`, approval handling via `pendingApprovalsRef`, `runtimeModeToThreadConfig` mapping, stderr classification. Symphony builds its own runtime but reuses these patterns. |
| Git worktrees, branches, commits, push, PR | `apps/server/src/git/GitWorkflowService.ts`, `git/GitManager.ts`, `vcs/GitVcsDriver.ts`, `vcs/GitVcsDriverCore.ts` | `createWorktree`, `fetchRemote`, `resolveRemoteTrackingCommit`, `createRef`, `switchRef`, `push`, `runStackedAction`, commit/PR content generation via `TextGeneration`. Note: some of these assume thread/project context; the workspace manager may call the VCS driver directly. |
| Source control providers | `apps/server/src/sourceControl/` (GitHub, GitLab, Bitbucket, Azure DevOps, all CLI-based) | `createChangeRequest` for PR creation with host credential. No Issues client exists anywhere. |
| Secrets | `apps/server/src/secrets/ServerSecretStore.ts` | File-based store under `stateDir/secrets`, `0600`, atomic writes. Storage for any tracker PAT. |
| SQLite persistence + migrations | `apps/server/src/persistence/`, `Migrations.ts` (34 migrations, `NNN_Name.ts` convention) | Same SqlClient infra for Symphony tables. New migrations start at `035_`. |
| Process runner | `apps/server/src/processRunner.ts` | Spawn with timeout/output caps; used for hooks and validation commands. |
| Terminal + process cleanup | `apps/server/src/terminal/Manager.ts`, `process/` | PTY management, SIGTERM-to-SIGKILL escalation, env blocklist precedent for child environment scrubbing. |
| Observability | `apps/server/src/observability/` (`Metrics.ts`, `Observability.ts`) | NDJSON tracer, Effect metrics, structured log annotations. Symphony metrics and log fields slot in here. |
| RPC/WS infrastructure | `apps/server/src/ws.ts`, `transport/WslBearerAuth.ts`, `packages/contracts/src/rpc.ts` | WS method groups, subscriptions, request schemas. Symphony methods extend these. |
| Client RPC + state atoms | `packages/client-runtime/src/{rpc,state}/`, `apps/web/src/state/` | `createEnvironmentRpcQueryAtomFamily`, `createEnvironmentRpcSubscriptionAtomFamily`, `createEnvironmentRpcCommand`. Live run/queue state follows this pattern. |
| UI shell | `apps/web/src/components/Sidebar.tsx`, `routes/`, `state/uiStateStore.ts` | Route-driven sidebar content swap precedent (`isOnSettings`), persisted UI store, shadcn/Base UI primitives, right-panel surface model. |
| Notifications | `apps/web/src/notifications/ActivityNotificationCoordinator.tsx`, `toast.tsx` | In-app toasts + native notifications. Symphony needs its own coordinator with work-item routing. |
| Desktop bootstrap envelope | `apps/desktop/src/backend/DesktopBackendManager.ts`, `DesktopBackendConfiguration.ts`, `ipc/preload.ts` | fd3 bootstrap JSON to the server and `desktopBridge.getLocalEnvironmentBootstraps()` back to the renderer. This is the channel for a per-launch credential. |
| Auth precedent for non-loopback transport | `apps/server/src/transport/WslBearerAuth.ts` | HTTP bearer + short-lived single-use WS tickets, already implemented for WSL. The loopback transport skips all of it today. |

### 1.2 Gaps to build

| Gap | Notes |
|---|---|
| GitHub Issues adapter | `sourceControl/*` providers read/write PRs only. No issues list/read exists. `gh issue` is the natural path, consistent with the CLI-based approach. |
| `WORKFLOW.md` loader and typed config layer | Nothing parses a repo-owned workflow contract. Needs front-matter/prompt split, `$VAR` resolution, validation, dynamic reload. |
| Symphony orchestrator | Poll loop, eligibility, dispatch, retry/backoff, reconciliation, restart recovery. New module. |
| Per-issue workspace manager with hooks | Thread worktrees are keyed by thread; Symphony workspaces are keyed by issue identifier with collision-resistant keys (SPEC 4.2, 9.2) and lifecycle hooks (SPEC 9.4). |
| Autonomous agent runtime | A headless Codex session per issue with continuation turns on one thread, its own approval/input policy, and normalized run events. Does not use the chat `ProviderService` session directory. |
| Evidence bundle service | No evidence/proof-of-work concept exists server-side today. `ReviewService` only does diff preview. |
| Attention queue and approval routing | `projection_pending_approvals` exists for thread turns; Symphony needs a work-item-scoped queue with approval scopes and policy sources. |
| Security remediation of local transport | README documents no Host/Origin validation and pass-through loopback auth. PRD 17.1 makes this Phase 0. |
| Symphony UI mode | No app-level mode concept exists. Sidebar tabs (`threads`/`workspace`) and the settings swap are the only precedents. |
| Cross-mode handoff | Mapping work item to an existing thread (workspace + branch) and back. |

## 2. Architecture

### 2.1 Component layout

New server module `apps/server/src/symphony/`, assembled as Effect layers into the existing runtime
(`apps/server/src/server.ts`) via the `RuntimeCoreDependenciesLive`/`RuntimeDependenciesLive`
composition, the same way `orchestration/` is wired. It consumes, never mutates, the Work-mode
engine.

```text
apps/server/src/symphony/
  Domain/                 pure types, schemas, invariants (no IO)
    WorkItem.ts, RunAttempt.ts, Issue.ts, Evidence.ts, Attention.ts
    Lifecycle.ts          work-item lifecycle transitions + legality table
    Keys.ts               workspace key sanitization + hash suffix (SPEC 4.2)
  Workflow/
    Loader.ts             WORKFLOW.md read + front-matter/prompt split (SPEC 5.2)
    Config.ts             typed config resolution, $VAR indirection, defaults (SPEC 6.1)
    Validation.ts         startup + per-tick validation (SPEC 6.3)
    PromptRenderer.ts     strict template render (issue + attempt)
    Watch.ts              dynamic reload, last-known-good on invalid reload (SPEC 6.2)
  Trackers/
    Adapter.ts            TrackerAdapter interface (PRD 25.2, SPEC 11.1)
    GitHubIssuesAdapter.ts, GitHubIssuesCli.ts
    Normalize.ts          payload -> Issue, malformed-record rules (SPEC 11.3)
  Workspaces/
    Manager.ts            deterministic per-issue workspaces, hooks, safety invariants (SPEC 9)
    Hooks.ts              after_create/before_run/after_run/before_remove + timeout
  Runner/
    AgentRuntime.ts       Codex app-server session per issue, continuation turns (SPEC 10)
    CodexAppServer.ts     spawn + client wiring over effect-codex-app-server
    Events.ts             Codex events -> normalized run events (SPEC 10.4)
    Policy.ts             approval/sandbox/input policy mapping (SPEC 10.5)
  Validation/
    Runner.ts             required validation commands, exit-code capture (PRD 14.10, risk 27.6)
  Evidence/
    Service.ts            evidence bundle assembly (PRD 11.5, 14.10)
    PullRequest.ts        PR evidence via sourceControl providers
  Attention/
    Service.ts            attention queue (PRD 14.8)
    Approvals.ts          approval scopes and policy resolution (PRD 14.9)
  Orchestrator/
    Orchestrator.ts       poll loop, single-authority state, eligibility, dispatch (SPEC 7, 8)
    Retry.ts              exponential backoff queue (SPEC 8.4)
    Reconcile.ts          stall detection + tracker state refresh (SPEC 8.5)
    Recovery.ts           restart recovery (SPEC 8.6, PRD 18.1)
  Persistence/
    Migrations/035_*      SQLite migrations
    Services/             repos for workflows, work items, runs, events, evidence,
                          attention, approvals, retry queue, checkpoints, audit
  Services/               Context tags (Orchestrator, WorkflowLoader, TrackerRegistry,
                          WorkspaceManager, AgentRuntimeFactory, EvidenceService, ...)
  Layers/                 Live implementations + the SymphonyLayerLive assembly
  Audit.ts                privileged-operation audit log (PRD 17.4)
```

Contracts land in `packages/contracts/src/symphony.ts` (domain types + RPC schemas) and extend
`packages/contracts/src/rpc.ts` (WS method groups). The server RPC handlers live in
`apps/server/src/symphony/rpc.ts` and are mounted in `apps/server/src/ws.ts` alongside the other
aggregates.

### 2.2 Decisions and rationale

**D1. Dedicated orchestrator, not a new aggregate in the existing engine.**

The existing `orchestration/` stack (decider, projector, reactors) is built around
`OrchestrationProject`/`OrchestrationThread` aggregates and a message/checkpoint projection model
that is tightly coupled to the chat UX. Symphony needs a scheduler with its own state machine,
poll loop, and retry queue. Folding it in would either fork the projector or pollute the Work-mode
event stream. Instead Symphony persists its own state in SQLite (PRD 18.3), keeps one
single-authority in-memory scheduler state (SPEC 3.1, 7), and reconstructs state on restart from
the database plus tracker/filesystem reconciliation (SPEC 8.6). It reuses the platform services in
1.1, so this is not a parallel stack.

**D2. Symphony drives Codex through its own agent runtime, not the chat `ProviderService`.**

`ProviderService`/`ProviderAdapter` start sessions bound to a `threadId` in the chat session
directory and stream canonical `ProviderRuntimeEvent`s into the projection pipeline. Symphony's
Agent Runner contract (SPEC 10) is different: one app-server process kept alive across
continuation turns on the same `thread_id`, `session_id = <thread_id>-<turn_id>`, its own approval
and user-input policy, its own prompt rendering. The runner builds on `effect-codex-app-server`
(the same package `CodexSessionRuntime` uses) and resolves the Codex driver config/availability
from `ProviderInstanceRegistry` + `ServerSettings`, so provider configuration stays shared. The
`AutonomousAgentProvider` interface (PRD 25.3) isolates provider-specific code so a second provider
(ACP-backed Cursor/Grok) can be added in Phase 6 without touching the orchestrator.

Shadow home: Symphony sessions use a dedicated Codex shadow home (`CodexHomeLayout` resolution, a
`codex_symphony` install identity) so concurrent Symphony runs do not fight Work-mode sessions over
`CODEX_HOME` config and thread storage. This reuses `CodexDriver`'s existing multi-instance
isolation rather than inventing a new mechanism.

**D3. GitHub Issues via `gh`, first tracker.**

The existing source-control layer is entirely CLI-based (`gh`, `glab`, `az`, `bb`). Adding a GitHub
API SDK for issues would be the odd one out. `gh issue list --json <fields>` and `gh issue view`
give state, labels, assignee, timestamps, priority field if configured, and blocker metadata from
issue body/labels. The token problem: prefer `gh`'s own credential store so the adapter process
needs no literal token; where a PAT is configured it lives in `ServerSecretStore` and is injected
only into the host-side adapter process, and its env name is declared for removal from the
agent child environment (SPEC 15.3, 11.5). See section 5.

**D4. Orchestrator-owned PR creation in Phase 3; agent tracker tools deferred.**

SPEC 11.5 keeps the orchestrator a tracker reader and lets the agent write tickets via provider
tools. That is the right end state, but provider-native agent tools (Codex dynamic tool call
handling) are an extension with a real surface area. Phase 3 ships orchestrator-owned PR creation
via the existing `SourceControlProvider.createChangeRequest` (host credential, no token to the
child). Phase 5/6 can add host-executed tracker tools (`update_issue_state`, `add_issue_comment`)
for the agent to call, following SPEC 10.5 (`agent_tool_specs`, `secret_environment_names`,
`execute_agent_tool`).

**D5. Security remediation ships in Phase 0 but incrementally.**

The PRD makes it Phase 0; the risk is that it touches every client/server boundary. It is split
into two steps so it can land independently: (a) strict Host/Origin validation on HTTP and the WS
upgrade for all transports, and (b) a first-party per-launch credential for desktop, delivered via
the existing fd3 bootstrap and `desktopBridge`, replacing the loopback pass-through. Step (a) is
small and unblocks everything; step (b) reuses the existing WSL bearer/ticket machinery. Details in
section 13.

## 3. Domain model

All types below live in `packages/contracts/src/symphony.ts` as Effect Schemas so they are shared
verbatim between server and client. This is the canonical form of PRD section 11.

### 3.1 Issue (normalized tracker record, SPEC 4.1.1)

```ts
export const NormalizedIssueSchema = Schema.Struct({
  id: Schema.NonEmptyString,            // opaque dispatch identity
  nativeRef: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })), // non-secret
  identifier: Schema.NonEmptyString,    // human key, names workspaces
  title: Schema.NonEmptyString,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Int),  // 1..4 rank first, rest sort with null
  state: Schema.NonEmptyString,
  branchName: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  assigneeId: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),  // trimmed + lowercased, blanks dropped
  blockedBy: Schema.Array(BlockerRefSchema),
  dispatchable: Schema.Boolean,         // explicit adapter-derived
  createdAt: Schema.NullOr(Schema.InstantFromSelf),
  updatedAt: Schema.NullOr(Schema.InstantFromSelf),
});
```

State comparisons are always `trim + lowercase` (SPEC 4.2). `nativeRef` never contains secrets and
is never used as a map key.

### 3.2 Work item, lifecycle, run attempt, evidence

`WorkItem` follows PRD 11.1 with `mode: "work" | "symphony"` retained for cross-mode references,
`source: WorkSource`, `workflowId`, `workspaceId`/`workspacePath`, `provider`, `lifecycle`,
`sessions`, `evidence`, `approvals`, `createdAt`, `updatedAt`. The `lifecycle` is the PRD 11.3
union (draft, eligible, queued, preparing, running, blocked, waiting_for_approval,
retry_scheduled, validation_failed, ready_for_review, changes_requested, ready_to_merge, completed,
cancelled, failed).

The spec's orchestration claim states (unclaimed, claimed, running, retry_queued, released, SPEC
7.1) map onto this lifecycle: `eligible`/`queued` = unclaimed, `preparing`/`running` = running,
`retry_scheduled` = retry_queued, terminal states = released.

`RunAttempt` follows PRD 11.4: `attemptNumber`, `workspacePath`, `provider`, `startedAt`,
`finishedAt`, `status` (the SPEC 7.2 phase union plus PRD terminal distinctions: user_cancelled,
tracker_cancelled, timed_out, process_failed, validation_failed, workflow_error, provider_error,
PRD 14.5 FR-046), `error`, `tokenUsage`, `timeline`. `interrupted` is included in the status union:
restart recovery (9.7) writes it, so the schema must define it or recovery writes an undefined
status. `retries_exhausted` is likewise a distinct terminal status, reached when `maxAttempts` is
hit.

`EvidenceBundle` follows PRD 11.5: `implementationSummary`, `changedFiles: ChangedFileEvidence[]`,
`validationResults: ValidationResult[]`, `assumptions: EvidenceItem[]`, `risks: RiskEvidence[]`,
`artefacts: EvidenceArtefact[]`, `pullRequest?: PullRequestEvidence`, and `overallAssessment` in
`insufficient | failed | ready_with_warnings | ready_for_review | ready_to_merge`.

PRD FR-091 additionally requires four fields the earlier draft omitted, all of which are host-
derivable and therefore trustworthy: `objective` (from the work item), `testsChanged:
ChangedFileEvidence[]` (subset of `changedFiles` matched against the workflow's test path patterns),
`commits: CommitEvidence[]` (`{sha, message, authoredAt}` from the branch range), and `unresolved:
EvidenceItem[]`. `acceptanceCriteria: string[]` is carried on the work item from the tracker record
(parsed from issue body checklists where present) so the Reviews page in 15.3 has a real source
rather than an unbacked UI field (PRD 16.5).
`ValidationResult` carries `{ command, status: passed|failed|skipped|unavailable|warning, exitCode,
durationMs, outputPath, executedAt }`. `exitCode` and `outputPath` are required for
passed/failed so "executed" is always distinguishable from "assumed" (PRD risk 27.6, quality metric
18.3).

### 3.3 Workflow definition and typed config

`WorkflowDefinition = { config: Record<string, unknown>; promptTemplate: string }` (SPEC 5.2).
`EffectiveWorkflowConfig` is the typed view (SPEC 6.4): `polling.intervalMs` (default 30000,
**validated into a bounded range of 5000 to 3600000**; PRD 19.2 requires the minimum be safely
bounded, and dynamic reload re-validates so a hot edit cannot drop the interval to zero),
`workspace.root` (default `<stateDir>/symphony/workspaces`; Neokod's own default rather than a
global temp dir so local-first persistence and cleanup are consistent), `hooks.{afterCreate,
beforeRun, afterRun, beforeRemove, timeoutMs=60000}`, `agent.{maxConcurrentAgents=10, maxTurns=20,
maxAttempts=5, initialRetryDelayMs=10000, maxRetryBackoffMs=300000, maxConcurrentAgentsByState,
maxRunDurationMs=14400000}`, `codex.{command="codex app-server", approvalPolicy, threadSandbox,
turnSandboxPolicy, turnTimeoutMs=3600000, readTimeoutMs=5000, stallTimeoutMs=300000}`,
`tracker.{kind, provider, requiredLabels, activeStates, terminalStates}`, plus Neokod extension
keys: `validation.required`, `validation.testPathPatterns`, `approvals.{beforePush,
beforePullRequest, beforeMerge, protectedPaths, waitTimeoutMs=1800000, policies}` where `policies`
covers the eight FR-083 classes, `concurrency.{global, repository, provider, workflow}`, `autonomy`
(observe|prepare|execute|deliver), `handoff.state`.

`agent.maxAttempts` and `agent.initialRetryDelayMs` close PRD FR-061, which requires configurable
maximum attempts and initial delay; the earlier draft hard-coded the delay and left attempts
unbounded, so a permanently failing issue would retry forever. `concurrency.provider` closes
FR-023's provider-specific limit. `agent.maxRunDurationMs` gives FR-071's "run exceeds configured
duration" attention trigger something to measure against.

`autonomy` defaults to `execute`; automatic merge is off unless the workflow explicitly sets it and
the user enables it (PRD 13.5, 17.6). Protected paths default to `.github/workflows/**`,
`infrastructure/**`, `migrations/**`, `auth/**`, `security/**` (PRD 17.5).

## 4. Persistence

New migrations in `apps/server/src/persistence/Migrations/`, registered in `Migrations.ts`. Same
WAL SQLite, idempotent `CREATE TABLE IF NOT EXISTS`, foreign keys on.

```text
035_SymphonyWorkflows         id PK, repository_id, workflow_path, status (active|paused|invalid),
                              autonomy_level, definition_json, effective_config_json,
                              validation_error, enabled_at, created_at, updated_at
036_SymphonyWorkItems         id PK, workflow_id FK, tracker_kind, tracker_issue_id,
                              tracker_identifier, repository_id, objective, description, priority,
                              state, labels_json, assignee_id, blockers_json, branch_name, issue_url,
                              lifecycle, workspace_key, workspace_path, base_branch, created_at,
                              updated_at, last_seen_at, claimed_at, dispatch_seq
                              UNIQUE(tracker_kind, tracker_issue_id)
037_SymphonyRunAttempts       id PK, work_item_id FK, attempt_number, provider, model, status,
                              current_stage, workspace_path, started_at, finished_at, error_json,
                              token_usage_json, UNIQUE(work_item_id, attempt_number)
038_SymphonyRunEvents         rowid AUTOINC, run_attempt_id FK, sequence, event_type, occurred_at,
                              payload_json   -- timeline, appended only
039_SymphonyEvidence          work_item_id PK, bundle_json, created_at
040_SymphonyAttentionItems    id PK, work_item_id FK, kind, severity, state (open|resolved|dismissed),
                              payload_json, recommended_action, created_at, resolved_at, resolution
041_SymphonyApprovals         id PK, request_id, work_item_id FK, action, scope
                              (once|current_run|repository), state, decision, decided_at,
                              policy_source, payload_json
042_SymphonyRetryQueue        work_item_id PK, attempt, due_at_ms, error_json, scheduled
043_SymphonyTrackerCheckpoints tracker_kind, scope_key, last_poll_at, cursor_json, PK(tracker_kind, scope_key)
044_SymphonyAuditEvents       rowid AUTOINC, occurred_at, actor, event_type, work_item_id,
                              run_attempt_id, payload_json   -- privileged ops only (PRD 17.4)
```

Indexes: `036` on `(workflow_id, lifecycle)`, `(repository_id, lifecycle)`, `(tracker_kind, state)`,
`last_seen_at`. `038` on `(run_attempt_id, sequence)`. `040` on `(state, created_at)`.

Repositories follow the existing `Services/<Name>.ts` + `Layers/<Name>.ts` split. Work-item rows
are the dispatch authority: claiming an issue is a conditional `UPDATE ... WHERE lifecycle IN
(eligible, queued, retry_scheduled)` returning rowcount.

The precise guarantee, stated no more strongly than the storage layer supports: for a given row, at
most one concurrent claimant can successfully move an eligible lifecycle to claimed. Other
claimants observe either zero changed rows or a retriable `SQLITE_BUSY` error. Stale claims and
orphaned workers are handled by recovery plus an owner/generation token, not by the update alone.

Runtime SQLite already enables WAL and foreign keys (`persistence/Layers/Sqlite.ts:33-38`) but does
not set `busy_timeout`, and the Node client opens a single `DatabaseSync` connection guarded by a
process-local semaphore (`persistence/NodeSqliteClient.ts:256-290`). There is no interprocess owner
lock. Required work:

- Set a bounded `busy_timeout` for both the Node and Bun clients.
- Retry busy failures with a bounded policy.
- Check rowcount before running any side effect (workspace creation, process launch).
- Combine claim and run-attempt creation in one transaction.
- Use `BEGIN IMMEDIATE` only where a transaction reads before writing or must reserve the writer
  across several statements.
- Persist an `owner_token` + `generation` on the work-item row so a restarted orchestrator can
  distinguish its own stale claims from a live claim.

This is the persistence-side twin of the in-memory `claimed` set and, with recovery, satisfies PRD
quality metric 18.3 (fewer than 5% double dispatch). Note the app runs one server process today;
the cross-process language in earlier drafts was unsupported.

## 5. Tracker adapter layer

### 5.0 Upstream reference adapters

The OpenAI Symphony reference implementation already ships five tracker adapters, all Elixir:

```text
elixir/lib/symphony_elixir/tracker.ex          the behaviour our TrackerAdapter must mirror
elixir/lib/symphony_elixir/tracker/issue.ex    normalized issue shape
elixir/lib/symphony_elixir/github/adapter.ex   + client.ex + agent_tool.ex
elixir/lib/symphony_elixir/linear/adapter.ex   + client.ex + agent_tool.ex
elixir/lib/symphony_elixir/jira/adapter.ex     + client.ex + agent_tool.ex
elixir/lib/symphony_elixir/gitlab/adapter.ex
elixir/lib/symphony_elixir/asana/adapter.ex
```

None of it ports as code into an Effect/TypeScript codebase. What it provides is an authoritative
reference for field mappings, normalization, pagination and error semantics, and confirmation that
the `agent_tool` surface deferred in D4 is real and specified rather than hypothetical.

Two consequences for this plan:

1. **Vendor the repo into `.repos/symphony`** as a read-only reference before WS-F starts. The plan
   previously cited `.repos/` as a source for protocol shape, but only `alchemy-effect` and
   `effect-smol` are vendored today, so that citation was unbacked.
2. **Shape `TrackerAdapter` against `tracker.ex`, not against GitHub Issues.** Any place where one
   adapter needs something the interface lacks is a signal the interface is too narrow, not a
   reason to special-case that adapter.

### 5.0.1 First-release tracker scope (resolves open decision 1)

**All five adapters ship in the first release: GitHub Issues, Jira, Linear, GitLab, Asana.** This is
a deliberate widening beyond PRD 29, which recommended GitHub Issues alone and placed the rest in
Phase 6. The driver is that Jira is the operator's actual tracker, so a GitHub-only first release
would not be usable by its first user.

Consequences, stated plainly so they are not discovered late:

- Phase 1 grows from one adapter to five, each with its own auth model (`gh` credential store,
  Jira PAT/basic + site URL, Linear API key, `glab` credential store, Asana PAT).
- Five adapter profile docs under `docs/integrations/`, not one.
- Tracker health probes and activation validation must cover five credential paths.
- Implementation order is **GitHub, Jira, Linear, GitLab, Asana**. GitHub goes first because the
  delivery half of the pipeline already depends on `gh`, so it exercises the full loop soonest;
  Jira goes second because it is the operator's real tracker and the messiest mapping, so its
  problems should surface early rather than at the end.

**Tracker and source control are independent.** `Trackers/*` reads issues; `sourceControl/*` creates
pull requests. Nothing couples them, so Jira issues driving GitHub pull requests is a first-class
configuration, not a special case. The workflow declares `tracker.kind: jira` and the repository's
source-control provider stays whatever the remote implies. This combination gets an explicit
integration test and is documented in `docs/integrations/symphony-jira.md`.

### 5.1 Interface (SPEC 11.1, PRD 25.2)

```ts
export interface TrackerAdapter {
  validateConfiguration(): Effect<ValidationResult>;
  listCandidateIssues(): Effect<NormalizedIssue[], AdapterError>;
  refreshIssues(ids: string[]): Effect<NormalizedIssue[], AdapterError>;
  getIssue(id: string): Effect<NormalizedIssue, AdapterError>;
  secretEnvironmentNames(): string[];          // removed from agent child env
  profile(): AdapterProfile;                    // documented contract (SPEC 11.2)
}
```

Empty input lists return empty results without a network request. `refreshIssues` is complete for
the requested set: a malformed requested record is an error, not an omission; an ID no longer
visible in scope is omitted and the orchestrator treats omission as no-longer-visible (SPEC 11.1).
`listCandidateIssues` returns active-state scoped issues including `dispatchable: false`; the
orchestrator owns the final filter (SPEC 8.2).

Error algebra (SPEC 11.4): `unsupported_tracker_kind`, `invalid_tracker_config`,
`missing_tracker_secret`, `tracker_request`, `tracker_status`, `tracker_response`,
`tracker_pagination`, `tracker_rate_limited`. Each carries `category`, `message`, and optional
`retryable`/`retry_after_ms`. The orchestrator only branches on success vs failure; `retryable`
drives the poll backoff for candidate fetch.

### 5.2 GitHub Issues adapter

`GitHubIssuesAdapter` wraps `gh` (new `GitHubIssuesCli.ts` next to the existing
`GitHubCli.ts`). It reuses `gh`'s credential store when present; if the workflow config declares a
PAT via `$VAR` indirection it is read from `ServerSecretStore` at adapter construction and injected
only into the host-side `gh` process env. The configured `GH_TOKEN`/`GITHUB_TOKEN` env name is
returned by `secretEnvironmentNames()` so the agent child never inherits it.

`listCandidateIssues` runs `gh issue list --repo <owner/repo> --state open --limit 100 --json
number,title,body,state,labels,assignees,createdAt,updatedAt,url` (paged via `--page`), mapping
to `NormalizedIssue`: `id` = the issue number as a string (stable within the repo scope, used as
the opaque dispatch ID), `identifier` = `#<number>` (collision risk handled by the workspace key
hash, SPEC 4.2), `nativeRef` = `{ owner, repo, number }` for later agent tools, `priority` from a
configured priority label mapping (`P0..P4`, configurable in `tracker.provider`), `blockedBy` from
issue links/body when reliably parseable, `dispatchable` from `tracker.provider` rules (default:
issue is open, unassigned or assigned to the configured bot identity, and not blocked).

The adapter profile (SPEC 11.2) is written to `docs/integrations/symphony-github.md` as part of
the workstream, documenting keys, defaults, scope, pagination, normalization, and error mapping.

Tracker health (PRD 16.1, 20.2): each adapter exposes a probe (`gh auth status` equivalent) used by
the Overview panel and by activation validation (PRD 12.4: tracker auth must succeed before a
workflow runs).

## 6. WORKFLOW.md loader and config layer

### 6.1 Loader and parser (SPEC 5.2, 5.5)

`Workflow.Loader` reads the file at the repository root. If it starts with `---`, everything up to
the next `---` is parsed as YAML front matter; the remainder (trimmed) is the prompt body. Non-map
front matter is a `workflow_front_matter_not_a_map` error. Missing file is
`missing_workflow_file`. YAML failure is `workflow_parse_error`. These are dispatch-gating errors:
they block new dispatches until fixed (SPEC 5.5), and the workflow's `status` in
`035_SymphonyWorkflows` flips to `invalid` with the validation message surfaced in the UI.

### 6.2 Config resolution (SPEC 6.1)

Pipeline: parse front matter to a raw map; apply built-in defaults; resolve `$VAR_NAME` indirection
only for values that explicitly reference an env var (plus documented adapter fallbacks); coerce and
validate typed values. Environment variables never override YAML globally. Path values support `~`
expansion and `$VAR`; relative `workspace.root` resolves against the directory containing
`WORKFLOW.md`. Unknown top-level keys are preserved and ignored for forward compatibility (SPEC
5.3).

### 6.3 Validation (SPEC 6.3, 5.3)

Startup validation fails startup with an operator-visible error. Per-tick validation before each
dispatch cycle: on failure, skip dispatch for that tick but keep reconciliation active. Checks:
workflow loads and parses; `tracker.kind` present and supported; adapter accepts
`tracker.provider`; **tracker authentication succeeds**; **provider authentication and availability
succeed**; `codex.command` present and non-empty; required env vars resolve; workspace root
writable; poll interval within bounds; declared approval policy classes are enforceable by the
selected provider; workflow explicitly enabled (PRD 12.4). Provider authentication was missing from
the earlier draft even though PRD 12.4 and the section 26 acceptance criteria both require it;
availability resolves through `ProviderInstanceRegistry`. The workflow editor exposes these as
`WorkflowValidation` results with per-field errors for the form view (PRD 12.3).

### 6.4 Dynamic reload (SPEC 6.2)

A file watcher on the `WORKFLOW.md` path re-reads and re-validates on change. Invalid reloads keep
the last known good effective config and emit an operator-visible error; they never crash the
service. Reloaded config applies to future dispatch, retry scheduling, reconciliation, hook
execution, and agent launches; in-flight agent sessions are not restarted automatically. The
orchestrator also re-validates defensively before each dispatch in case a watch event was missed.
Watcher implementation: `apps/server` runs on Bun or Node; use the platform `FileSystem` watcher
where available, otherwise a polling fallback at the poll interval, both behind one `Workflow.Watch`
service so the choice is isolated.

### 6.5 Prompt rendering (SPEC 5.4)

Strict template renderer: variables `issue` (full normalized issue including labels and blockers)
and `attempt` (null on first attempt, integer on retry). Unknown variables and filters fail
rendering (`template_render_error`), failing only the affected run attempt, not dispatch. The
renderer is a small `PromptRenderer.ts` with a Liquid-compatible subset; no new dependency unless
`liquidjs` is already available, otherwise a hand-rolled renderer with a documented grammar. The
existing `ChatMarkdown`/`TextGeneration` paths are not reused for this; they serve chat.

## 7. Workspace manager

### 7.1 Deterministic per-issue workspaces (SPEC 4.2, 9.1, 9.2)

Workspace key derivation: sanitize `issue.identifier` by replacing any char not in
`[A-Za-z0-9._-]` with `_`; if sanitization changed the identifier, append `-<hex>` where hex is a
stable hash (SHA-256, first 16 bytes = 64 bits) of the original identifier, using only allowed
chars. Path: `<workspace.root>/<key>`. `createdNow` is recorded (directory did not exist before
this call) to gate the `after_create` hook.

Safety invariants, enforced in `Workspaces/Manager.ts` before any launch (SPEC 9.5):

1. The agent subprocess `cwd` equals the resolved workspace path.
2. The resolved workspace path is a strict descendant of the resolved workspace root (both
   normalized absolute, prefix check with separator boundary, symlinks resolved via `realpath`
   before comparison so a symlinked workspace cannot escape).
3. The workspace key is sanitized per 7.1.

**Containment is a host-side boundary, not a sandbox setting (PRD FR-034, 17.2).** Codex's
`workspace-write` sandbox covers the agent's own file writes and nothing else: it does not cover
shell commands the agent runs, future providers with weaker sandboxes, symlink escapes, or the
existing privileged file and terminal RPCs which accept arbitrary paths today. Symphony therefore
enforces containment itself:

- Every path in a Symphony-originated file or command operation is resolved and checked against
  invariant 2 before execution, and rejected or routed to approval otherwise.
- Symphony-originated terminal commands inherit the same `cwd` restriction and env scrubbing.
- Escape attempts are audit events, not silent failures.
- Escape tests are one of the seven retained test suites (section 19).

Workspace population: `git worktree add` of `base_branch` into the workspace path, using the
existing `vcs` driver. Base branch resolution reuses `resolveDefaultBranchName` +
`resolveRemoteTrackingCommit` (prefers `origin/HEAD`, falls back to `main`/`master`).

Working branch (PRD FR-032): if the tracker supplies `branch_name`, that branch is checked out from
`origin`. Otherwise Symphony creates a deterministic branch `symphony/<workspace-key>`, derived from
the same sanitized key as the workspace so the mapping is one-to-one and reproducible across
restarts. On collision with an existing local or remote branch, the existing branch is reused when
its merge-base matches the resolved base branch, and otherwise the work item fails with a
`branch_collision` error routed to attention rather than silently forcing. A `after_create` hook
failure aborts workspace creation and removes the partial directory. Reused workspaces are not
destructively reset on population failure.

### 7.2 Hooks (SPEC 9.4)

`after_create` (only on newly created dir, fatal), `before_run` (before each attempt, fatal to that
attempt), `after_run` (after each attempt, logged and ignored), `before_remove` (before cleanup,
logged and ignored). Executed via `processRunner.ts` with `cwd = workspace`, timeout
`hooks.timeoutMs` (default 60000), output truncated in logs. Hook failures/timeouts are logged with
the hook name. Terminal-issue cleanup calls `before_remove` then `git worktree remove` (or the VCS
driver's `removeWorktree`), reusing existing worktree removal so refs are cleaned too.

### 7.3 Workspace lifecycle across phases

- Phase 2 (Prepare): workspace created for claimed issue, plan generated, no edits without
  approval.
- Phase 3 (Execute): same workspace reused across retries and continuation attempts
  (PRD FR-032: preserve workspace for retry).
- Restart: workspaces survive; `Recovery.ts` inspects them, preserves uncommitted changes, and
  identifies orphaned processes (PRD 18.1, 18.2).
- Terminal: cleaned per policy (startup terminal sweep, SPEC 8.6; active-transition cleanup,
  SPEC 8.5).

## 8. Agent runtime (Codex)

### 8.1 Process and session (SPEC 10.1, 10.2)

Per work item, the runner spawns `codex app-server` via `bash -lc <codex.command>` in the
workspace path, using the `effect-codex-app-server` client (`CodexClient.layerChildProcess`).
`CODEX_HOME` points at the Symphony shadow home (D2). The child env is scrubbed: adapter-declared
secret env names, plus the existing terminal env blocklist precedent (`PORT`, `ELECTRON_*`,
`NEOKOD_*`, `T3CODE_*`, `VITE_*`), are removed. Max buffered line size 10 MB (SPEC 10.1).

Startup sequence, corrected against the generated protocol schema: `V2ThreadStartParams` carries
neither a prompt nor a title (`packages/effect-codex-app-server/src/_generated/schema.gen.ts:41807-41823`),
so the prompt cannot ride on `thread/start`. The real sequence is:

1. `initialize` handshake.
2. `thread/start` with the workspace absolute path as the thread working directory and the
   workflow's approval/sandbox policy in thread config.
3. Persist the returned provider thread ID.
4. `turn/start` carrying the rendered prompt as the first turn input.
5. Persist the returned turn ID.

`session_id = <providerThreadId>-<turnId>`, derived from the provider's thread ID, not from any
Work-mode thread ID (`CodexSessionRuntime.ts:1232-1239, 1305-1328`). Issue-identifying metadata
(`<identifier>: <title>`) is held in Symphony's own run record rather than pushed into a thread
title, unless a thread-naming method is separately verified to exist.

### 8.2 Continuation turns (SPEC 7.1, 10.3)

After a turn completes successfully, the worker re-checks the tracker state. If the issue is still
active and routable and `turn_count < maxTurns`, the worker starts another turn on the same live
thread with continuation guidance only, never re-sending the original prompt. The app-server
process stays alive across these turns and is stopped when the worker run ends. When the worker
exits normally, the orchestrator schedules a short (1 s) continuation retry to re-check whether the
issue still needs work (SPEC 7.1, 8.4).

Turn processing: read timeout for sync requests (`readTimeoutMs`), turn stream silence timeout
(`turnTimeoutMs`, reset by each output), stall detection owned by the orchestrator
(`stallTimeoutMs`, SPEC 8.5), subprocess exit as failure. On stall/timeout/exit the worker is
terminated (`SIGTERM` then `SIGKILL` escalation, reusing the process kill pattern) and the
orchestrator schedules the appropriate retry.

### 8.3 Approval, sandbox, and user-input policy (SPEC 10.5)

The policy is documented in `Runner/Policy.ts` and driven by the workflow's autonomy level plus
`approvals.*` and `codex.*` settings:

| Autonomy | Codex thread config | Behavior |
|---|---|---|
| Prepare | `approvalPolicy: untrusted`, sandbox `read-only`, `approvalsReviewer: user` | Plan generation only; edits blocked by sandbox. Approval to proceed to Execute surfaces in attention. |
| Execute | `approvalPolicy: on-request`, sandbox `workspace-write`, per workflow approval policy | Command/file approvals: auto-approved for the session when the workflow policy allows; otherwise routed to the attention queue (PRD FR-083). Protected-path changes always route to attention (PRD 17.5). |
| Deliver | same as Execute | Adds merge gating (section 14). |

User-input-required events (`item/tool/requestUserInput`, `turn_input_required`): never allowed to
stall indefinitely. Default policy: surface to the attention queue as an open question with the
full prompt; if the workflow disables interactive clarification, treat as a failed attempt
(recoverable or not per workflow error classes). The run must reach a human via attention rather
than hanging (SPEC 10.5).

### 8.3.1 Live request registry (required, not optional)

Approvals and user-input requests are **blocking server-to-client JSON-RPC requests**, not
fire-and-forget notifications. The existing chat runtime holds a `Deferred` in
`pendingApprovalsRef` and waits on it (`CodexSessionRuntime.ts:967-1019`), resolves it from public
response methods (`:1364-1418`), and settles everything still pending at shutdown (`:1256-1274`).

This means a persisted attention row **cannot by itself answer a request**: the Deferred lives in
the orchestrator process and dies with it. Symphony therefore needs both halves:

- `Runner/LiveRequests.ts`: an in-memory registry keyed by `(workItemId, runAttemptId, requestId)`
  holding the Deferred for each outstanding approval or input request. Exposes
  `respondToApproval(requestId, decision)` and `respondToUserInput(requestId, text)`, plus expiry,
  per-request timeout, and shutdown settlement so no child process is left blocked.
- `041_SymphonyApprovals` / `040_SymphonyAttentionItems`: the durable record of the request and the
  decision, for history, audit, and UI. Durable rows never resolve a Deferred.

Policy interaction:

- Auto-approve policy answers the Deferred immediately and writes the durable row asynchronously.
- Human policy keeps the agent process alive only for a bounded window (`approvals.waitTimeoutMs`,
  default 30 min). On expiry the request is rejected, the attempt fails with a distinguishable
  reason, and the attention item stays open for the operator.
- After a restart, every outstanding request is marked `interrupted` in the durable table. It is
  never silently re-offered as live, because the process that owned the Deferred is gone.

### 8.4 Emitted run events (SPEC 10.4)

The runner normalizes Codex events into the run timeline (`038_SymphonyRunEvents`):
`session_started`, `startup_failed`, `turn_completed`, `turn_failed`, `turn_cancelled`,
`turn_ended_with_error`, `turn_input_required`, `approval_auto_approved`, `unsupported_tool_call`,
`notification`, `other_message`, `malformed`, each with `event`, `timestamp`, optional
`codex_app_server_pid`, and `usage`. Orchestrator-generated timeline events add: `issue_claimed`,
`workspace_created`, `hook_executed`, `agent_started`, `plan_produced`, `files_modified`,
`validation_started`, `validation_failed`, `retry_scheduled`, `branch_pushed`, `pull_request_opened`,
`human_review_requested` (PRD FR-052). Token usage follows SPEC 13.5: absolute thread totals only
(`thread/tokenUsage/updated`, `total_token_usage`), delta relative to last reported totals, never
delta-style payloads.

## 9. Orchestrator

### 9.1 State

Single-authority in-memory state in `Orchestrator/Orchestrator.ts`:

```ts
interface OrchestratorState {
  effectiveConfig: EffectiveWorkflowConfig;   // per active workflow, last-known-good
  workflows: Map<WorkflowId, WorkflowRuntime>; // status, autonomy, pause, config
  claimed: Set<string>;                        // issue IDs reserved/running/retrying
  running: Map<IssueId, RunningEntry>;         // run attempt + live session metadata
  retryQueue: Map<IssueId, RetryEntry>;        // { attempt, dueAtMs, timerHandle, error }
  completed: Set<string>;                      // bookkeeping only, not dispatch gating
  tokenTotals: TokenTotals;                    // aggregate + runtime seconds (SPEC 13.5)
  rateLimits: RateLimitSnapshot;               // latest from agent events
  globalPaused: boolean;
  perWorkflowPaused: Set<WorkflowId>;
}
```

`claimed`/`running` checks are required before any launch; persistence (section 4) is the
cross-restart authority underneath.

### 9.2 Poll loop (SPEC 8.1)

On startup: load workflows from DB, re-read `WORKFLOW.md`, run startup validation, startup terminal
cleanup (SPEC 8.6), schedule an immediate tick, then repeat every `polling.interval_ms` (updated at
runtime when config reloads).

Tick sequence:

1. Reconcile running issues (9.4).
2. Run dispatch preflight validation (6.3). On failure, skip dispatch but keep reconciliation.
3. For each active workflow: `listCandidateIssues`.
4. Sort candidates by dispatch priority (SPEC 8.2): priority 1..4 ascending, then created_at
   oldest first, then identifier lexicographic.
5. Dispatch eligible issues while slots remain (9.3).
6. Notify observability/status consumers of state changes.

Tracker candidate-fetch failure: log and skip dispatch for that tick.

### 9.3 Eligibility and dispatch (SPEC 8.2, PRD FR-016)

An issue is dispatchable when all hold:

- `id`, `identifier`, `title`, `state` present.
- State in `active_states`, not in `terminal_states`.
- Adapter `dispatchable === true`.
- Every `tracker.required_labels` present (case/whitespace-insensitive).
- Not in `claimed` or `running`.
- Global, per-repository, per-workflow, and per-state concurrency slots available
  (PRD FR-023, SPEC 8.3). Per-state limit falls back to the global limit.
- Workflow enabled, not paused, global orchestrator not paused.

Dispatch path: claim transactionally (work-item row update, section 4); create workspace; run
`before_run` hook; start agent attempt; populate the running entry with zeroed token counters; add
to `claimed`; remove any retry entry. Duplicate dispatch is structurally prevented by the claim
update plus the in-memory checks (PRD FR-024).

### 9.4 Reconciliation (SPEC 8.5)

Part A, stall detection: for each running issue, `elapsed` since `lastCodexTimestamp` (or
`startedAt` if no event yet). If elapsed exceeds `stallTimeoutMs`, terminate the worker and queue a
retry. `stallTimeoutMs <= 0` disables stall detection.

Part B, tracker refresh: `refreshIssues(runningIds)`. Per running issue:

- Terminal state: terminate worker and clean workspace.
- Active + routable: update the in-memory snapshot.
- Active but no longer routable, or neither active nor terminal: terminate worker without workspace
  cleanup.
- Missing from the refresh result: terminate worker without cleanup (treated as no longer visible).

Refresh failure: keep workers running and retry next tick.

### 9.5 Retry and backoff (SPEC 8.4, PRD FR-060 to 62)

Cancel any existing retry timer for the issue, store `{attempt, identifier, error, dueAtMs,
timerHandle}`. Backoff: normal continuation after clean worker exit = fixed 1000 ms; failure-driven
= `min(10000 * 2^(attempt - 1), agent.maxRetryBackoffMs)`. Retry classes come from the workflow:
user cancellation and tracker cancellation are not retryable; timeout, process failure, provider
error, stall, and (optionally) validation failure are. On timer fire: `refreshIssues([id])`; if
missing, release claim; if terminal, clean workspace and release; if active and routable, dispatch
if slots are free, else requeue with `no available orchestrator slots`; otherwise release. Retry
state is visible in the UI: reason, count, next retry time, previous errors (PRD FR-062).

### 9.6 Run cancellation (PRD FR-044, 45)

Cancellation terminates the active turn (`turn/interrupt`), the child process, the related terminal
command, and any pending retry. Exit reasons are distinguished: user_cancelled, tracker_cancelled,
timed_out, process_failed, validation_failed, workflow_error, provider_error (PRD FR-046). Global
stop-all requires confirmation (PRD FR-132, 133); global pause only blocks new dispatches (PRD
FR-130, 131). Per-workflow and per-repository pause are independent (PRD FR-134).

### 9.7 Restart recovery (SPEC 8.6, PRD 18.1, 18.2, 18.4)

On restart, `Recovery.ts`:

1. Reload workflows from DB and re-read `WORKFLOW.md`; mark `invalid` where validation fails.
2. Query the tracker for terminal-state issues and remove their workspaces (startup terminal
   cleanup, best-effort).
3. For each run attempt in a non-terminal state: inspect the workspace (preserve uncommitted
   changes), identify orphaned app-server/terminal processes via the existing process diagnostics,
   and mark the run as `interrupted` with an attention item. **Identification is not enough
   (PRD 18.2).** Each orphan is either terminated (SIGTERM then SIGKILL escalation, reusing the
   existing process kill pattern) or adopted, decided by matching the recorded `owner_token` and
   PID against the live process; a PID that has been recycled to an unrelated process is never
   killed. Workspace leases whose owner is gone are released, so an abandoned lock cannot block a
   workspace forever. Outstanding approval and input requests are marked `interrupted` per 8.3.1.
4. Reconstruct work-item state from SQLite; release stale claims whose tracker state is terminal.
5. Resume or fail runs per workflow policy (default: resume `preparing`/`running` attempts as
   retry_scheduled with attempt+1; surface `waiting_for_approval` and `ready_for_review` unchanged).
6. Idempotency: every recovery step is re-runnable; work-item rows and command receipts make
   repeated polling, reconciliation, and recovery safe (PRD 18.4).

## 10. Evidence service

`Evidence/Service.ts` assembles the bundle when a run reaches a stopping point (review-ready,
failed validation, or changes-requested resolution):

- `changedFiles` from the git diff between `base_branch` and the work branch, via the existing
  `CheckpointDiffQuery`/`vcs` diff machinery (file list + per-file additions/deletions).
- `validationResults` from `Validation/Runner.ts`: run each `validation.required` command via
  `processRunner.ts` with `cwd = workspace`, capture `{command, exitCode, status, durationMs,
  outputPath, executedAt}`, preserve raw output to `logs/symphony/<runId>/validation/`. A check is
  `passed` only when it executed with exit code 0; `skipped`/`unavailable` are never reported as
  passed (PRD quality 18.3, risk 27.6).
- `implementationSummary`, `assumptions`, `risks`, `unresolved`: collected from a structured
  handoff file the agent is prompted to write (e.g. `SYMPHONY_EVIDENCE.md` in the workspace, schema
  documented in the workflow template) parsed by `Evidence/Service.ts`. **No generated fallback.**
  An earlier draft filled a missing summary with `TextGeneration` output; that is removed. Model
  prose about what an agent probably did is not evidence that it did it, and a fallback hides the
  very signal `insufficient` exists to expose. When the handoff file is missing or incomplete, the
  fields stay empty and `overallAssessment` is `insufficient`. Host-derived inventories (diff
  summary, validation table) may be displayed alongside, explicitly labelled as host-derived, and
  never satisfy a required evidence field.
- `testsChanged`, `commits`: derived host-side from the branch range and the workflow's test path
  patterns, so they cannot be overstated by the agent.
- `pullRequest`: PR number, title, branch, base, status, CI status, review state, mergeability,
  unresolved comments, latest commit (PRD FR-101). **Only the first six of those exist today.** See
  10.1.

### 10.1 Pull-request evidence gap and multi-host support

Two separate facts, previously conflated:

**Creation is already multi-host and free.** `SourceControlProvider` exposes `createChangeRequest`,
`getChangeRequest`, `listChangeRequests`, `checkoutChangeRequest`, `getDefaultBranch`
(`sourceControl/SourceControlProvider.ts:86-123`), and GitHub, GitLab, Bitbucket and Azure DevOps
all implement it. Symphony's orchestrator-owned PR creation (D4) therefore supports all four hosts
at no extra cost, on one condition: **WS-L must go through the provider abstraction and never call
`gh` directly.** Hard-coding `gh` for PR creation is the single mistake that would forfeit this.

**Evidence enrichment does not exist for any host.** The current change-request shape carries
`number`, `title`, `url`, `baseRefName`, `headRefName`, `state`, `updatedAt` and nothing more (e.g.
`azureDevOpsPullRequests.ts:11-17`). There is no CI status, review decision, mergeability, or
unresolved-comment data anywhere in `sourceControl/`. FR-101 requires all four, and FR-095 makes
merge readiness depend on them, so this is load-bearing rather than cosmetic.

Consequences:

- Extending the provider interface with `getChangeRequestStatus` returning `{ciStatus, reviewState,
  mergeable, unresolvedComments, latestCommit}` is net-new work, and it is **per host**: four
  implementations across four different CLIs/APIs (`gh`, `glab`, Bitbucket REST, `az`).
- Phase 3 needs only creation, so it stays cheap and multi-host from day one.
- Phase 5 owns the enrichment, because that is where CI status, review-comment ingestion and merge
  readiness live. Sequence it host by host: GitHub first (richest `gh --json` surface), then Azure
  DevOps and Bitbucket, then GitLab.
- Until a host's enrichment lands, `overallAssessment` for repositories on that host caps at
  `ready_for_review` and never reaches `ready_to_merge`, since FR-095 forbids claiming merge
  readiness without the checks that prove it. This degrades honestly rather than silently.
- `artefacts`, `tokenUsage`, `totalDuration`, `workflowVersion`, `agent`/`model`: from the run
  attempt and workflow snapshot.
- `overallAssessment` computed by rules: any failed required validation with no open resolution =
  `failed`; incomplete required evidence = `insufficient`; all required checks pass with risks =
  `ready_with_warnings`; clean = `ready_for_review`; only after merge policy checks pass = upgrade
  to `ready_to_merge`.

PRD FR-095: a run is never marked `ready_to_merge` unless all required workflow checks pass and the
merge policy (section 14) is satisfied.

## 11. Attention and approvals

### 11.1 Attention queue (PRD 14.8)

`Attention/Service.ts` is the single writer. Items are created on: agent question/input-required,
command approval required, protected-path modification, tracker credential failure, invalid
workflow, repeated validation failure, merge conflict, run exceeds configured duration, agent
stall, automatic-merge approval. Each item carries `{what happened, why human action is required,
affected work item, recommended response, available actions, consequences of approval/rejection}`
(PRD FR-072). Filterable by repository, severity, type, age, workflow, provider (PRD FR-073).

### 11.2 Approvals (PRD 14.9)

Approval request → `041_SymphonyApprovals` with scope `once | current_run | repository`, paired with
a live Deferred in the 8.3.1 registry. Persistent (repository-scoped) changes require explicit
confirmation (PRD FR-081). High-risk actions render exact command, working directory, reason,
expected impact, affected files, reversibility, policy source (PRD FR-082). The provider-runtime
approvals in chat (`thread.approval.respond`) are separate; Symphony approvals are work-item-scoped
and never cross into the chat pending-approvals table.

Approval policy classes (PRD FR-083) are typed and complete: `commandExecution`, `networkAccess`,
`dependencyInstallation`, `protectedFileChange`, `push`, `pullRequest`, `merge`, `trackerWrite`.
Where the provider cannot enforce a class (for example Codex cannot isolate network access per
command), the policy **fails closed**: the class is reported as unenforceable in workflow
validation and the workflow cannot enable autonomous behavior that depends on it.

## 12. Server API surface

New WS methods in `packages/contracts/src/rpc.ts` (method schemas in `contracts/src/symphony.ts`),
handlers in `apps/server/src/symphony/rpc.ts`:

Unary: `symphonyGetOverview`, `symphonyListQueue`, `symphonyListRuns`, `symphonyGetRun`,
`symphonyListWorkflows`, `symphonyGetWorkflow`, `symphonyValidateWorkflow`,
`symphonyActivateWorkflow`, `symphonyPauseWorkflow`, `symphonyResumeWorkflow`,
`symphonyPauseGlobal`, `symphonyResumeGlobal`, `symphonyDispatchWorkItem`,
`symphonyCancelRun`, `symphonyStopAllRuns`, `symphonyApprove`, `symphonyReject`,
`symphonyResolveAttention`, `symphonyTakeOver`, `symphonyResumeAutonomous`,
`symphonyDelegateFromThread`, `symphonyListTrackers`, `symphonyConfigureTracker`,
`symphonyListHistory`, `symphonyExportDiagnostics`.

Added to close PRD gaps the earlier draft named in the UI but never gave a backend:

- `symphonyExcludeWorkItem` / `symphonyIncludeWorkItem` and `symphonySetLocalPriority` (FR-022).
  Both write a persisted override on the work-item row, survive restart, and are re-applied after
  every tracker refresh so a poll cycle cannot silently resurrect an excluded item. Both emit audit
  events. Local priority takes precedence over tracker priority in the 9.2 sort.
- `symphonyPauseRepository` / `symphonyResumeRepository` (FR-134). Repository pause is persisted
  state alongside workflow pause and gates dispatch independently. The earlier draft asserted
  repository pause in section 9.6 but defined neither state nor RPC.
- `symphonyRequestChanges` and `symphonyApproveMerge` (FR-094). Review actions need explicit
  commands with their own lifecycle transitions and confirmations; the earlier draft listed them
  as UI affordances only.
- `symphonyRespondToUserInput` (FR-071, section 8.3.1), distinct from `symphonyApprove`, because an
  agent question and a command approval settle different JSON-RPC requests.

Stream (subscriptions, PRD FR-052, performance 19.1): `subscribeSymphonyOverview`,
`subscribeSymphonyRuns`, `subscribeSymphonyQueue`, `subscribeSymphonyAttention`,
`subscribeSymphonyRunEvents`. These follow the existing `subscribe` + `afterSequence` resume
pattern with a bounded gap cap, backed by a PubSub `Stream` fed by the orchestrator, so live events
reach the UI in under a second and reconnect resumes without a full snapshot.

The client-side commands and subscriptions mirror the PRD 25.1 `SymphonyClient` interface
(`getOverview`, `listQueue`, `listRuns`, `getRun`, `pauseWorkflow`, `resumeWorkflow`,
`dispatchWorkItem`, `cancelRun`, `approve`, `reject`, `takeOver`, `resumeAutonomous`).

## 13. Security and local transport remediation

### 13.1 Target posture (PRD 17.1)

Desktop: privileged operations go through a controlled native IPC boundary or an authenticated
local channel, not an unauthenticated loopback WebSocket. Browser (`neokod serve`): loopback bind,
random per-launch credential, strict Origin and Host validation, authenticated HTTP, short-lived
WebSocket tickets, explicit workspace path restrictions.

### 13.2 Step A: Host and Origin validation

Editing the existing auth helpers is **not sufficient**. Today's auth runs on the WebSocket route
(`ws.ts:1608-1654`) and on selected HTTP endpoints only, while API, OTLP, ticket, asset,
static/dev, WebSocket, and MCP routes are merged separately (`server.ts:319-332, 368-371`). A check
added inside `WslBearerAuth` would leave most routes uncovered.

Step A is therefore **router-wide transport validation**, applied before route dispatch and before
the WS upgrade, in a new `transport/LocalTransportAuth.ts`:

- Host validation: loopback bind accepts `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`.
- Origin validation: dev origin(s), `neokod://app`, `neokod-dev://app`, and self-origin. Existing
  CORS already derives the dev origin dynamically (`http.ts:35-48`); reuse that derivation rather
  than duplicating a literal list.
- **Configurable public Host/Origin pairs.** A fixed allowlist breaks the reverse-proxy deployment
  the README documents. Reverse-proxied `neokod serve` must be able to declare its public hostname
  and HTTPS origin explicitly, and those declared pairs are accepted.
- Specified explicitly, because these are the bug farm: malformed Host, multiple Host headers, IPv6
  normalization, implicit default ports, and requests with no `Origin` (non-browser clients such as
  the desktop renderer on a custom scheme) which fall through to the 13.3 credential policy.
- The README "Security posture" section is updated to match, and the reverse-proxy path is
  re-verified end to end.

Sequencing: Step A stays in Phase 0, but its `server.ts` / `ws.ts` integration serializes with WS-B,
which touches the same two files.

### 13.3 Step B: first-party per-launch credential (desktop)

Mirror the WSL bearer path, which already implements HTTP bearer + short-lived single-use WS
tickets. Current state to work against: loopback bypasses bearer and tickets entirely
(`WslBearerAuth.ts:73-88, 106-120`), its ticket route is not even mounted (`:142-159`), bootstrap
config only consumes a token for `wsl-bearer` (`cli/config.ts:291-292`), and loopback clients
resolve unauthenticated (`client-runtime/src/connection/resolver.ts:43-65`).

Step B is its own workstream (**WS-A2**), not a bullet inside WS-A, and must cover every delivery
context rather than desktop alone:

| Context | Credential delivery |
|---|---|
| Packaged desktop | fd3 `DesktopBackendBootstrap` (new field) → `desktopBridge.getLocalEnvironmentBootstraps()` |
| Desktop dev / Vite | same fd3 path, dev origin allowed |
| WSL | unchanged; existing bearer preserved |
| Direct `neokod serve` | printed/loopback-file per-launch token, see below |
| Proxied `neokod serve` | declared public Host/Origin pair plus the same token |
| Non-browser clients | bearer header, no Origin required |

The unresolved piece the plan previously hid: **fd3 gives `neokod serve` nothing.** Requiring a
token there breaks serve and dev unless a delivery mechanism exists, while a blanket self-origin
bypass would contradict PRD 17.1's authenticated-browser target. Decision for first release: serve
prints a per-launch token at startup and accepts it as a bearer or as a one-time ticket; the
self-origin bypass is **not** used to skip authentication, only to skip the Origin check for
non-browser clients. If that proves too disruptive in practice, the fallback is to narrow the first
release to Host/Origin-protected loopback serve and say so plainly in the README.

- The token is per-launch and never persisted to disk.
- `packages/client-runtime/src/environment` target resolution selects the credential transport for
  desktop the way it already selects the WSL bearer transport.
- `config.isServerBindAuthorized` is updated so `0.0.0.0` still requires the bearer path.

Timing (resolves open decision 6): WS-A2 may start after the Observe foundation, but it **must land
before Phase 2**, because Phase 2 is where privileged autonomous execution begins. It is a Phase 0
exit criterion in the sense that Phase 2 cannot open without it.

### 13.4 Command surface and workspace containment

- The Symphony dispatch RPC union is minimal and explicit; every Symphony command is validated
  against the work item's state machine server-side, not just the client (PRD 14.4 FR-034,
  security posture).
- Agent processes run only in the assigned workspace (section 7.1 invariants). Secrets are stored
  in `ServerSecretStore`, never logged, never written to evidence, and never inherited by the agent
  child (SPEC 15.3, PRD 17.3). Child env scrubbing per 8.1.
- Protected paths are enforced host-side on any file write observed through the runner and on PR
  creation (PRD 17.5).
- Audit log: `044_SymphonyAuditEvents` records file writes, terminal commands, approvals, branch
  creation, commit, push, PR creation, tracker writes, merge, cancellation, and workflow changes,
  with actor, timestamp, work item, and run attempt (PRD 17.4).

## 14. Delivery lifecycle (Phase 5)

Merge policy default: no automatic merge; human approval required; required checks must pass;
unresolved review comments block merge; branch must be current with base where configured (PRD
17.6). Merge readiness derivation feeds `overallAssessment`. PR review feedback is ingested by
refreshing PR evidence (`reviews`, `unresolvedComments`) and, when the workflow is in `deliver`
autonomy, fed back to the original work item as a continuation prompt on the same thread
(PRD FR-102 to 104). After changes, the run returns to validation before re-entering review.
Automatic merge remains policy-controlled and is a Phase 5 extension, off by default.

## 15. Web UI

### 15.1 Mode switch and navigation (PRD 9.1, 10.2)

- Persisted operating mode in `apps/web/src/uiStateStore.ts`: `operatingMode: "work" |
  "symphony"` (migrated store, `neokod:ui-state:v1`).
- A persistent top-level switch `[ Work ] [ Symphony ]` in the app chrome, visible in primary
  navigation, not inside provider selection, not requiring restart, preserving state on switch
  (PRD FR-001 to 003).
- Routes: `_symphony.tsx` layout + `_symphony.index` (Overview), `_symphony.queue`,
  `_symphony.running`, `_symphony.attention`, `_symphony.reviews`, `_symphony.workflows`,
  `_symphony.trackers`, `_symphony.history`, `_symphony.settings`, `_symphony.$runId` (run detail).
  File-based routes regenerate `routeTree.gen.ts`.
- Sidebar content swap in `components/Sidebar.tsx` parallel to the existing `isOnSettings` branch,
  with a Symphony nav list (Overview, Queue, Running, Needs Attention, Reviews, Workflows,
  Trackers, History, Settings).

### 15.2 State

`apps/web/src/state/symphony.ts` using the existing atom families: query atoms for snapshots
(overview, queue, runs, workflows, trackers, history), subscription atoms for live streams
(runs, queue, attention, run events), command atoms for the RPC methods in section 12. Reconnect
handling comes free from `SubscriptionRef.changes(supervisor.session)`.

### 15.3 Views

- Overview: metric tiles (Running, Queued, Needs Attention, Ready for Review, Retrying, Failed
  Today), panels for active workflows, provider health, tracker health, recent completions,
  average runtime, token usage, concurrency utilisation (PRD 16.1).
- Queue: priority, issue, repository, workflow, state, blockers, estimated readiness, dispatch
  status; actions dispatch-now, exclude, change-priority, open-issue, inspect-eligibility. Ineligible
  items show a human-readable reason (PRD experience metric 18.3).
- Running: list/cards/compact table, state, latest step, elapsed time, agent activity, workspace
  changes, validation status, cancel (PRD 16.3).
- Needs Attention: action-oriented cards with recommended action and available actions (approve
  once/reject/inspect diff/take over/stop run) (PRD 16.4).
- Reviews: default page ordering objective, implementation summary, acceptance criteria,
  validation status, risks, assumptions, changed areas, PR, merge readiness; raw logs and chat
  available but not dominant (PRD 16.5, FR-094). Grouped into the five FR-093 buckets, each with an
  explicit predicate so the grouping is derived rather than hand-assigned: `ready_for_review`
  (assessment `ready_for_review`), `ready_with_warnings` (assessment `ready_with_warnings`),
  `changes_requested` (lifecycle `changes_requested`), `ready_to_merge` (assessment
  `ready_to_merge`, which per 10.1 requires host enrichment), `failed_validation` (assessment
  `failed` or lifecycle `validation_failed`). Each bucket defines its ordering and empty state.
- Run detail: tabs for Summary, Timeline, Agent, Terminal, Files, Diff, Validation, Evidence,
  Issue, Pull Request, Logs (PRD FR-051), built on the existing right-panel surface model and
  `DiffPanel` (mode prop), `PlanSidebar`, `FileBrowserPanel`, `ThreadTerminalDrawer`.

### 15.3.1 Pull Request panel

The Codex desktop app's PR viewer is the reference design for this panel, and it is a closer match
to FR-101 than anything currently in Neokod. Its layout, which this panel adopts:

```text
PR #<n>                                         [host icon]
<title>

Branch      <head> → <base>        +<adds> -<dels>
Reviewers   <list | "No reviewers">
Comments    <count | "No comments">
Checks      <ci summary | "No CI checks">
Status      <open | draft | merged | closed>

Description  (collapsible)
  Summary / Why / Impact

[ Leave a comment ]
```

Three things this reference settles that the plan had left vague:

1. **The diff stat (`+adds -dels`) is part of PR evidence.** FR-101 does not name it and the earlier
   draft omitted it, but it is the single most useful signal for judging review size, and it is
   cheap: it comes from the same branch range already computed for `changedFiles`.
2. **Absent data renders as an explicit state, not a blank.** "No CI checks" and "No reviewers" are
   real answers. This is exactly the honest-degradation requirement in 10.1: where a host has no
   enrichment yet, the panel says so rather than implying a clean bill of health. A blank row and a
   passing row must never look alike.
3. **The description is structured, not free prose.** Summary / Why / Impact is a better shape for
   the `SYMPHONY_EVIDENCE.md` handoff schema (section 10) than an unstructured summary field, and
   it maps onto PR body generation directly.

The panel is a surface over `PullRequestEvidence`; it renders whatever the host provided and
degrades per 10.1. It is tabbed and closable like the reference, so several PRs can be open at once.

**Work Mode also wants this, and that is outside the Symphony PRD.** The reference app exposes
"Pull requests" as a top-level nav item, listing PRs for the repository independent of any run. That
is a genuinely useful Work Mode feature and the panel component would be shared, but the Symphony
PRD covers Symphony Mode only, so it is recorded here as a candidate rather than smuggled into this
scope. Building the panel against `PullRequestEvidence` rather than against Symphony run state keeps
it reusable if Work Mode adopts it later. See open decision 13.
- Workflows: editor with form view, source view, YAML validation, schema errors, prompt preview,
  resolved-config preview, env validation, dry-run validation, workflow diff, save confirmation,
  version-control status (PRD 12.3).
- Settings: Symphony settings, autonomy level display in the header (PRD 13.5).

### 15.4 Notifications

A `SymphonyNotificationCoordinator` alongside `ActivityNotificationCoordinator`, emitting native
notifications only for: human input required, repeated run failure, review ready, merge approval
required, workflow stopped, tracker authentication failed, protected action requested (PRD FR-120).
Routine progress stays in-app (FR-121). Toast actions navigate to the run detail or the specific
attention item (FR-122). The existing thread-scoped toast helper is not reused; Symphony toasts
route by work item.

## 16. Cross-mode handoff (Phase 4)

`HandoffService` maps work items to Work-mode threads and back, reusing the existing thread model
where `projection_threads` already stores `branch` + `worktree_path`.

### 16.0 Workspace ownership (prerequisite)

Pointing a Work thread at a Symphony workspace is mechanically easy and unsafe as the codebase
stands. `thread.create` accepts a `worktreePath` after checking only project and thread existence
(`orchestration/decider.ts:214-245`); the schema requires merely a non-empty string
(`contracts/src/orchestration.ts:536-550`); persistence stores it verbatim
(`ProjectionThreads.ts:28-84`); and Work operations then prefer that path (`ws.ts:1277-1296`).
Nothing validates repository identity, registered-worktree status, branch, or exclusive ownership.
Worse, Work-mode cleanup only considers other Work threads (`apps/web/src/worktreeCleanup.ts:11-32`),
so it will happily remove a worktree that a live Symphony run owns.

Handoff therefore requires a persisted ownership record before anything else:

- New table `045_SymphonyWorkspaceOwnership`: `workspace_path` PK, `owner` (`symphony` | `work`),
  `work_item_id`, `thread_id`, `lease_expires_at`, `updated_at`.
- **Take over** must: stop the Symphony worker, settle every outstanding protocol request via the
  8.3.1 registry, wait for process exit, validate canonical repository / worktree / branch identity,
  then transfer ownership to `work`.
- **Resume** must: require the Work provider session and any Work terminals on that path to be idle,
  then transfer ownership back to `symphony`.
- Both cleanup paths, Work-mode and Symphony, must consult this record before removing a worktree.

Without this, the two modes can edit and delete the same worktree concurrently. Treat it as part of
the Phase 4 definition of done, not a follow-up.

- Take over (`symphonyTakeOver`, PRD FR-112, 113): create (or reuse) a Work-mode thread bound to
  the work item's workspace path and branch. The thread's `worktreePath` is the Symphony
  workspace, so the environment panel, terminal, files, and diff all point at the same filesystem.
  Context carried across: workspace, branch, issue, run history, evidence, current diff, pending
  questions.
- Resume (`symphonyResumeAutonomous`, PRD FR-114): return the same work item to Symphony; re-run
  validation and continue the lifecycle.
- Delegate (`symphonyDelegateFromThread`, PRD FR-110, 111): create a Symphony work item from a
  thread carrying objective, repository, current branch, relevant files, conversation summary,
  acceptance criteria, selected provider, and workspace where appropriate.
- No unnecessary duplication of branches or workspaces (PRD FR-115): takeover reuses the worktree;
  delegation reuses the thread's worktree when it matches the work item's branch, otherwise creates
  a fresh isolated workspace.

## 17. Reliability and observability

- Structured logs: every event annotated with `work_item_id`, `issue_identifier`, `run_attempt_id`,
  `session_id`, `repository`, `workflow`, `provider`, `event_type`, `severity`, `error_code` where
  applicable (PRD 20.1).
- Metrics in `observability/Metrics.ts`: `symphonyWorkItemsTotal`, `symphonyRunsTotal`,
  `symphonyRunDuration`, `symphonyRetriesTotal`, `symphonyValidationResultsTotal` (with status),
  `symphonyHumanInterventionsTotal`, `symphonyPollDuration`, `symphonyDispatchDuration`.
- Resource gauges (PRD 19.3), which the earlier draft omitted three of:
  `symphonyActiveProcessCount`, `symphonyResidentMemoryBytes`, `symphonyWorkspaceDiskBytes`,
  `symphonyQueueDepth`, plus token totals. Disk use is sampled per workspace on a slow cadence
  (default 5 min) rather than per tick, since it walks directories; memory comes from
  `process.memoryUsage()` with a documented no-op fallback where a platform does not supply it.
- Telemetry (PRD 21): **opt-in and local-only in this release.** All counters above stay on the
  machine; nothing is transmitted. The plan deliberately does not build a transmission path,
  because PRD 21 forbids sending source, prompts, issue descriptions or secrets without explicit
  consent and no consent surface is in scope. This is a conscious deferral, recorded here so it is
  not mistaken for an oversight.
- Success-metric instrumentation (PRD 22): each target gets a named local signal so it is
  measurable rather than aspirational. `symphonyRunsTotal{outcome}` gives completion and retry
  rates; `symphonyHumanInterventionsTotal` over runs gives the unsupervised-review rate;
  evidence completeness is a computed field on the bundle; double dispatch is derivable from claim
  attempts versus successful claims; restart-recovery success from recovery outcomes; cancellation
  latency from a `symphonyCancellationDuration` histogram, which the ten-second PRD 22.2 target
  needs and nothing else provides.
- Operational health on Overview: orchestrator running/paused, last tracker poll, tracker auth,
  provider availability, workflow validation, active agent count, retry queue, failed hooks,
  disk-space warnings (PRD 20.2).
- Diagnostics export: redacted bundle with app version, workflow validation, recent logs, failed
  event history, provider availability, tracker health, workspace metadata; no secrets, no repo
  source files by default (PRD 20.3).
- Performance targets (PRD 19): Overview query under 2 s for 500 recent items (indexed + paged
  query atoms); live events under 1 s (PubSub stream); mode switch immediate (persisted flag, no
  reload); dispatch decision under 5 s for 1,000 candidates (in-memory eligibility over indexed
  candidate sets); a stuck run never blocks unrelated repositories (per-workflow concurrency and
  dispatch fibers).

## 18. Delivery phases and workstreams

Each phase maps to the PRD exit criteria. Workstreams land on `feat/symphony-mode` in this order;
each is reviewable and green on `vp check` / `vp run typecheck` / `vp test` before the next starts.

### Phase 0: Foundation
- WS-A: Security remediation step A (router-wide Host/Origin validation) + README security update.
  Integration into `server.ts`/`ws.ts` serializes with WS-B.
- WS-A2: Security remediation step B (per-launch credential across all six delivery contexts,
  section 13.3). Own workstream. May start after Phase 1 but **must land before Phase 2 opens.**
- WS-B: `packages/contracts/src/symphony.ts` domain schemas; WS method schemas; server module
  skeleton with `Services/` tags and layer assembly. **Owns shared contracts; freezes interfaces
  before C/D/F start.**
- WS-C: Persistence migrations `035` to `045` and repositories.
- WS-D: Workflow loader, config resolution, validation, prompt renderer, dynamic reload,
  starter-template scaffolding for repositories with no `WORKFLOW.md` (PRD 15.1, 27.4).
- WS-E: Mode switch, Symphony route layout, navigation shell, empty states, per-mode view-state
  persistence (FR-003).
- Exit: app switches modes; workflow validates; starter template can be created; no autonomous
  dispatch.

### Phase 1: Observe
- WS-F: `TrackerAdapter` interface shaped against upstream `tracker.ex`, normalization, error
  mapping. Five adapters in order **GitHub, Jira, Linear, GitLab, Asana**, each with a profile doc
  under `docs/integrations/`. Vendor `.repos/symphony` first.
- WS-G: Poll loop, eligibility calculation, queue projection, tracker checkpoints, queue overrides
  (exclude / local priority, FR-022).
- WS-H: Queue view, tracker health for five credential paths, workflow visualization, overview shell.
- Exit: eligible work appears accurately from all five trackers; nothing is dispatched.

### Phase 2: Prepare
Entry gate: WS-A2 has landed. Phase 2 is where privileged autonomous execution starts.
- WS-I: Workspace manager (deterministic keys, branch naming, worktree population, hooks, host-side
  containment invariants).
- WS-J: Agent runtime (Codex app-server), plan generation, approval-before-edit.
- WS-J2: **Minimal approval slice, required for WS-J's exit criterion.** Live request registry
  (8.3.1), durable request record, list/detail API, approve/reject, timeout/cancel, minimal UI.
  Without this WS-J cannot satisfy "no code modified without approval", because the blocking
  JSON-RPC request has nothing to answer it. Filtering, polished attention UX, notifications and
  repository-scoped policy stay in WS-N.
- WS-K: Run timeline, cancellation, Running view (complete `RunSummary` per FR-050), run detail shell.
- Exit: issue can be claimed; workspace created; plan generated; no code modified without approval.

### Phase 3: Execute
- WS-L: Validation runner + evidence service + orchestrator-owned PR creation.
- WS-M: Retry/backoff, reconciliation, restart recovery.
- WS-N: Reviews view, Needs Attention view + approvals, notifications.
- Exit: issue moves from tracker to review-ready PR with evidence.

### Phase 4: Cross-mode handoff
- WS-O: Take over, resume, delegate, shared workspace/evidence.
- Exit: work transitions between modes without duplication or context loss.

### Phase 5: Delivery lifecycle
- WS-P: CI status, review-comment ingestion, changes-requested loop, merge readiness,
  policy-controlled merge.
- Exit: Symphony continues work after PR review and returns to review.

### Phase 6: Additional integrations
- WS-Q: Second provider via `AutonomousAgentProvider` (ACP-backed Cursor/Grok), richer workflow
  templates, Azure Boards and GitHub Projects adapters. The five trackers moved into Phase 1, so
  this phase is provider-focused.

### Workstream concurrency map

Derived from where workstreams collide on files, not from phase membership. This governs how many
implementation agents can run at once.

**Safe to run in parallel, with strict file ownership:**

- WS-E alongside WS-A through WS-D (web-only, no server files).
- WS-C and WS-D after WS-B freezes contracts, provided WS-D does not touch shared contracts or
  integration files.
- WS-F tracker leaf code alongside WS-I workspace leaf code, after WS-D.
- The five adapters within WS-F are mutually independent leaf modules once the interface is frozen,
  so they parallelise cleanly. This is what makes the five-tracker scope affordable.
- WS-I and WS-J leaf implementations after interfaces freeze; integration still serializes I before J.
- WS-H web views alongside server-only I/J work, after API contracts freeze.
- L/M/N leaf modules only while they avoid lifecycle, repositories, RPC/contracts, orchestrator,
  layer assembly, shared web state, and routes.

**Must serialize, or route through one integration owner:**

- WS-A and WS-B both need `server.ts` and `ws.ts`.
- WS-B before C, D and F.
- C + D + F before G. G before H and K integration.
- I before J integration; WS-J2 before the Phase 2 exit; J before K.
- Backend L/M/N integration. M's retry and recovery transitions land before L/N add terminal ones.
- E/H/N/O/P whenever they touch routes, `routeTree.gen.ts`, navigation, or `state/symphony.ts`.
- O after M and the approval infrastructure. P after L/M/N, serialized with O wherever lifecycle,
  runner, evidence, or review UI overlap.

## 19. Testing strategy

Tests are limited to correctness invariants the Symphony contract actually depends on. Nothing here
tests functionality that is not in the spec, and no test exists to demonstrate coverage. Seven
suites, following the existing `*.logic.test.ts` / `.test.ts` conventions:

1. **Dispatch claim and dedup.** Two independent connections against one temporary SQLite database.
   Exactly one claim succeeds; the loser sees zero changed rows or a bounded-retry busy error; the
   loser runs no workspace or process side effect.
2. **Workspace containment.** Absolute normalization, sibling-prefix attacks (`/root-evil` against
   root `/root`), `..` traversal, separator boundaries, symlink escape via `realpath`, root
   equality, and cwd equality.
3. **Config resolution and `$VAR` handling.** Defaults, YAML precedence over environment, expansion
   only where explicitly referenced, missing and empty variables, relative roots, `~`, coercion,
   invalid values, and unrelated environment variables left alone. Includes poll-interval bounds.
4. **Workspace keys.** Safe identifiers unchanged, replacement of disallowed characters, stable
   hash suffixes, collisions, hostile identifiers, separators, cross-platform determinism.
5. **Retry arithmetic.** First attempt, exponential growth, cap at `maxRetryBackoffMs`, the fixed
   1 s continuation delay, `maxAttempts` exhaustion, overflow and invalid inputs, persisted due time.
6. **Lifecycle legality.** Every allowed and forbidden transition, including cancellation, approval,
   retry, validation, review, takeover/resume, and terminal-state immutability.
7. **Evidence rules.** A required command counts as passed only on exit code 0; failed, skipped,
   unavailable, missing output and missing handoff all resolve to `failed` or `insufficient`, never
   to passed. Explicitly covers the removed-fallback case from section 10.

Deliberately **not** written, and why:

- Eligibility and sort-order tests: pure data transformation with no invariant that a type error
  would not already catch.
- Prompt-renderer tests: the renderer fails closed on unknown variables, which suite 3 covers.
- Concurrency-slot, stall-detection, reconciliation and restart-recovery suites beyond dispatch
  dedup: these need elaborate fakes and mostly assert the fake behaves as written.
- Real-`git` worktree/hook/checkpoint integration and credential-dependent tracker integration:
  environment-gated, slow, and skipped on most machines, so they buy little and rot fast.
- Symphony UI and browser tests: the views are projections of server state, and the derivation
  logic worth testing is already covered above.

## 20. Open decisions to confirm before Phase 0 closes

1. ~~First tracker~~ **RESOLVED: all five upstream adapters ship in the first release (GitHub,
   Jira, Linear, GitLab, Asana), implemented in that order.** Widens PRD 29 deliberately because
   Jira is the operator's actual tracker. See 5.0.1.
2. GitHub Projects is not first-release scope; it moves to Phase 6 with Azure Boards.
3. Codex app-server mode: yes, required (the runner already depends on it; `codex exec` is not
   used for orchestration turns).
4. Persistence engine: SQLite in the existing state DB (recommended) vs a separate DB file.
5. Whether Symphony runs while the desktop UI is closed: no for Phase 0-3 (server lifecycle is the
   desktop app lifecycle); the option is preserved architecturally by the server being a separate
   process.
6. ~~Per-launch credential timing~~ **RESOLVED: WS-A2 is its own workstream, may start after the
   Observe foundation, and must land before Phase 2 opens** (section 13.3). Splitting it from step A
   keeps step A small and unblocking; gating Phase 2 on it means no privileged autonomous execution
   ever runs over an unauthenticated transport.
7. Workflow changes apply dynamically (yes, SPEC 6.2 requires it; no restart).
8. PR creation by the orchestrator in Phase 3 (recommended) vs agent-owned via tracker tools.
9. Evidence artefacts in first release: diff, validation output, PR link, risks, assumptions,
   summary, token usage. Videos/screenshots deferred (PRD open decision 9).
10. Merge support (Phase 5) before additional providers (recommended: yes, matches PRD 29).
11. Rust migration is not on this branch's critical path; Symphony modules are written so a future
    Rust port is mechanical (pure domain, isolated IO).
12. Work Mode threads are not migrated into the unified work-item model in this effort; the
    unified `WorkItem` type exists and cross-mode handoff maps between them.
13. **Open: a Work Mode pull-request view.** The Codex desktop app exposes "Pull requests" as a
    top-level nav item with the panel described in 15.3.1, independent of any agent run. This is
    outside the Symphony PRD but the operator has flagged it as wanted in both modes. Deciding it
    now matters because it changes where the panel component lives and how much of the per-host
    enrichment in 10.1 becomes load-bearing for Work Mode rather than Symphony-only. Recommendation:
    build the panel in Symphony first against `PullRequestEvidence`, keep it free of Symphony run
    state, and lift it into Work Mode as a follow-up once the enrichment exists for at least GitHub.

## 21. File map (new files)

```text
packages/contracts/src/symphony.ts                  domain + RPC schemas
packages/contracts/src/rpc.ts                       WS method groups (add)
apps/server/src/symphony/Domain/*                   pure domain types, keys, lifecycle
apps/server/src/symphony/Workflow/*                 loader, config, validation, prompt, watch
apps/server/src/symphony/Trackers/*                 adapter, GitHub issues, normalize
apps/server/src/symphony/Workspaces/*               manager, hooks
apps/server/src/symphony/Runner/*                   agent runtime, codex client wiring, policy
apps/server/src/symphony/Validation/Runner.ts
apps/server/src/symphony/Evidence/*                 service, PR evidence
apps/server/src/symphony/Attention/*                attention, approvals
apps/server/src/symphony/Orchestrator/*             orchestrator, retry, reconcile, recovery
apps/server/src/symphony/Persistence/Migrations/*   035..044
apps/server/src/symphony/Persistence/Services/*
apps/server/src/symphony/Services/*  Layers/*       Context tags + live impls + assembly
apps/server/src/symphony/rpc.ts                      WS handlers
apps/server/src/symphony/Audit.ts
apps/server/src/symphony/Handoff.ts                 cross-mode handoff
apps/server/src/server.ts                           wire SymphonyLayerLive (add)
apps/server/src/transport/LocalTransportAuth.ts     from WslBearerAuth (extend)
apps/server/src/observability/Metrics.ts            Symphony metrics (add)
apps/web/src/uiStateStore.ts                          operatingMode (add)
apps/web/src/state/symphony.ts                      atoms + commands
apps/web/src/routes/_symphony*.tsx                  routes
apps/web/src/components/symphony/*                  views
apps/web/src/notifications/SymphonyNotificationCoordinator.tsx
apps/desktop/src/backend/DesktopBackendManager.ts   per-launch credential (Phase 0 WS-A)
docs/integrations/symphony-github.md                adapter profile
```
