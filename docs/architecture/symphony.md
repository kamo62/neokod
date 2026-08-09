# Symphony

Symphony is Neokod's second operating mode: workflow-led, tracker-driven execution of repository
work, running unattended. Code mode is a person driving an agent thread by
hand, with git worktrees, diffs, and provider sessions in the same window. Symphony is a scheduler
that polls an issue tracker, dispatches an agent into an isolated worktree for each eligible item,
runs validation, assembles evidence, and opens a pull request, all bounded by a policy declared in
the repository's own `WORKFLOW.md`.

Symphony's runtime lives entirely under `apps/server/src/symphony/`. Its domain model and RPC surface
are in `packages/contracts/src/symphony.ts`. It runs inside the same Node.js server process as Code
mode (see [Architecture overview](./overview.md)), not a separate service: `Layers/SymphonyLayer.ts`
composes Symphony's layer graph as an additional slice on top of the existing server, and both modes
share the same `SourceControlProviderRegistry`, git plumbing, and provider-instance infrastructure.

Read this page for what Symphony does and how far along it is. It is merged, policy-gated, and
exercised by unit and integration tests and a live server-boot probe, but it has not yet been run
end to end against a production tracker with a real pull request. See
[Current maturity](#current-maturity) before treating it as a finished, battle-tested path.

## WORKFLOW.md

A YAML-front-matter-plus-Markdown file at the root of the target repository, `WORKFLOW.md`. The front
matter configures Symphony; the Markdown body is a prompt template appended to every dispatched
agent's first turn. Front matter is never sent to the model, only the prompt body is. Parsing is
`Workflow/Parser.ts`; validation and defaulting is `Workflow/Config.ts`. An invalid file still loads
as a record with `status: "invalid"` and a `validationError`, never silently dropped, so
the Overview panel can show you why a workflow isn't running.

Configuration groups, with their real front-matter keys:

| Group         | Keys                                                                                                                       | What it controls                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tracker`     | `kind`, `active_states`, `terminal_states`, `required_labels`, `provider` (adapter-specific)                               | Which tracker, which issue states are eligible, adapter credentials and scope      |
| `polling`     | `interval_ms` (default 30000, bounded 5000-3,600,000)                                                                      | How often this workflow's tracker is polled                                        |
| `workspace`   | `root`                                                                                                                     | Where isolated worktrees are created for this workflow                             |
| `autonomy`    | `observe \| prepare \| execute \| deliver` (default `execute`)                                                             | How much the agent is allowed to do; see [Autonomy levels](#autonomy-levels)       |
| `agent`       | `max_concurrent_agents`, `max_turns` (default 20), `max_attempts` (default 5), `max_run_duration_ms`, retry backoff, model | Turn, retry, and model settings; some limits are not yet enforced, as noted below  |
| `codex`       | `command` (default `codex app-server`), `approval_policy`, sandbox and timeout settings                                    | How the execution agent is spawned and sandboxed                                   |
| `validation`  | `required` (shell commands), `test_path_patterns`                                                                          | What must pass before a run can reach evidence and a PR                            |
| `approvals`   | `before_push`, `before_pull_request`, `before_merge`, `protected_paths`, `policies[]`, `wait_timeout_ms`                   | Approval records and timeout settings; see the enforcement limits below            |
| `review`      | `agents` (reviewer model list), `require` (`all-approve \| any-approve \| advisory`, default `advisory`)                   | Optional AI code review before a human looks at the PR                             |
| `concurrency` | `global` (default 3), `repository` (default 2), `provider`, `workflow`                                                     | Global, repository, and workflow run caps; provider is parsed but not enforced yet |
| `hooks`       | `after_create`, `before_run`, `after_run`, `before_remove`, `timeout_ms`                                                   | Shell hooks around the workspace lifecycle                                         |

Several forward-looking keys are accepted by the config schema but do not yet drive runtime
enforcement: `agent.max_concurrent_agents`, `agent.max_run_duration_ms`, `concurrency.provider`,
`approvals.before_*`, `approvals.protected_paths`, and `approvals.policies[]`. Do not rely on them as
safety gates. The enforced dispatch caps today are `concurrency.global`, `.repository`, and
`.workflow`; live agent approvals are governed by the effective `codex.approval_policy` and answered
through the human request UI.

## The dispatch-to-PR flow

```
Tracker  --poll-->  Eligibility  --dispatch-->  Isolated worktree  -->  Agent run  -->  Validation  -->  Evidence  -->  Pull request  -->  approveMerge (human/gate)
```

1. **Scheduler tick.** `Orchestrator/Layers/SymphonyOrchestratorLive.ts` runs a tick once on startup
   and every 5 seconds after (`SCHEDULER_SCAN_INTERVAL`). Each tick reloads any changed `WORKFLOW.md`
   files, polls each active workflow whose own `polling.interval_ms` is due, reconciles stale claims,
   runs a retry sweep, launches at most one newly queued item, and sweeps expired approvals. Only one
   server process dispatches at a time: the orchestrator holds a startup advisory lock, and a second
   process degrades to read-only observation.

2. **Poll and eligibility.** The workflow's tracker adapter (see [Tracker adapters](#tracker-adapters))
   lists candidate issues. `Orchestrator/Eligibility.ts` checks each one against `active_states`,
   `terminal_states`, `required_labels`, and whether it's already claimed. `Orchestrator/Projection.ts`
   turns eligible issues into `WorkItem` rows, persisted by `Persistence/Layers/WorkItemRepository.ts`.
   A `WorkItem` moves through a defined lifecycle: `draft, eligible, queued, preparing, running,
blocked, waiting_for_approval, retry_scheduled, validation_failed, ready_for_review,
changes_requested, ready_to_merge, completed, cancelled, failed`. Claiming a queued item for
   dispatch is an optimistic-fenced SQL update, so two orchestrator instances (or a stale retry) can't
   double-claim the same item.

3. **Dispatch gate.** Before a claimed item actually runs, `prepareDispatch` checks the advisory lock,
   global/workflow/repository pause flags, workflow `autonomy` (an `observe` workflow never dispatches),
   and the enforced global, repository, and workflow concurrency caps (global default 3, repository
   default 2). Only the first item that clears every gate is dispatched per tick.

4. **Isolated worktree.** `Workspaces/Manager.ts` creates a dedicated git worktree per issue at a
   deterministic path under the workflow's `workspace.root`, on a branch named `symphony/<workspace
key>` (or the tracker's own branch name, if it supplies one). The workspace is reused across retries
   of the same issue and never recreated, and containment is enforced: a path that would escape
   `workspace.root` fails outright. This is different from Code mode's worktrees, which are optional,
   created on demand per thread (mainly for reviewing a PR branch), and not reused by a scheduler. An
   ownership lease (`WorkspaceOwnershipRepository`) keeps Code mode from deleting a workspace a live
   Symphony run holds, and vice versa; a human can explicitly take a Symphony workspace over into Code
   mode, and hand it back, through `HandoffService.ts`.

5. **Agent run.** `Runner/Dispatcher.ts` claims the work, ensures the workspace, opens a `RunAttempt`,
   and starts an agent runtime. Today that runtime is Codex only: `Runner/AgentRuntime.ts` spawns
   `codex app-server` (configurable via `codex.command`) and drives it over its JSON-RPC protocol,
   suspending the agent's blocking approval and user-input requests through Symphony's own
   `LiveRequests` registry until a person answers them in the UI. `Runner/Prompt.ts` builds the first turn from the
   issue's identifier, title, description, and acceptance criteria, the workflow's configured
   validation commands, an instruction to write a `SYMPHONY_EVIDENCE.md` handoff file, and the
   workflow's own prompt template body. `Runner/Policy.ts` maps the workflow's `autonomy` level to a
   Codex sandbox and approval policy (`observe`/`prepare` run read-only; `execute`/`deliver` allow
   edits), overridable by explicit `codex.*` keys. A run can continue for up to `agent.max_turns`
   turns (default 20) on the same live thread, including a bounded round of review-comment feedback if
   a prior attempt's PR came back with changes requested.

6. **Validation.** Before any evidence is assembled, `Validation/Runner.ts` runs every command in
   `validation.required` inside the workspace, with a 10-minute timeout per command, and persists raw
   stdout/stderr per command to the run's log directory. Any failed or unavailable command marks the
   attempt `validation_failed`; if attempts remain, it's rescheduled as a retry and does not advance.

7. **Evidence bundle.** `Evidence/Service.ts` assembles the bundle from two distinct sources, kept
   separate on purpose: host-derived facts (changed files and commits from a `baseBranch..HEAD` git
   diff, and the validation results above) are computed by the server, so the agent cannot overstate
   them; agent-authored fields (implementation summary, assumptions, risks, unresolved issues) come
   exclusively from the `SYMPHONY_EVIDENCE.md` file the agent was prompted to write, with no generated
   fallback if it's missing or empty. The bundle's `overallAssessment` is computed by the server, not
   claimed by the agent: any failed or skipped required validation makes it `failed`; a missing or
   empty handoff file makes it `insufficient`; open risks make it `ready_with_warnings`; otherwise
   `ready_for_review`.

8. **Pull request.** `Evidence/PullRequest.ts` pushes the work branch and opens a pull request through
   the same `SourceControlProvider` abstraction Code mode uses (GitHub, GitLab, Bitbucket, or Azure
   DevOps, never a hard-coded CLI call). The PR body is host-generated from the evidence bundle: a
   summary, a changed-files table, a validation results table, and any risks. It is deliberately not
   model-generated prose. On success the work item moves to `ready_for_review`.

9. **Merge gate.** A run that reaches `ready_for_review` is never merged automatically. Merging
   requires a separate `symphony.approveMerge` RPC call, and it re-checks fresh evidence from the host
   before allowing it: the evidence bundle's `overallAssessment` must not be `failed` or `insufficient`,
   any configured model review must pass, CI status must be `success`, the PR's review state must not
   be `changes_requested`, the PR must be positively `mergeable` (an unknown mergeable state is
   refused, not treated as safe), and there must be zero unresolved review comments. A PR with no host
   enrichment data at all caps at `ready_for_review` and is never promoted on the absence of a signal.
   Merging stays off by default until this explicit, gated approval happens.

## Autonomy levels

- **`observe`**: poll and project tracker issues into work items, but never dispatch an agent.
- **`prepare`**: dispatch into a read-only sandbox; the agent can plan but not edit.
- **`execute`** (default): the agent can edit the workspace, subject to `approvals.*` policy.
- **`deliver`**: same as `execute`, for workflows that intend to carry a run through to a PR.

## Policy controls

- **Agent approvals**: the effective `codex.approval_policy` controls whether Codex emits blocking
  requests. `LiveRequests` records those requests durably and surfaces them as attention items for a
  human to approve or reject. The more granular `approvals.policies[]`, `before_*`, and
  `protected_paths` keys are parsed but not yet consulted by the runner, so they are not safety gates.
- **Pause controls**: a global pause (a kill switch for all Symphony dispatch), a per-workflow pause,
  and a per-repository pause, plus a `stopAllRuns` action that requires an explicit confirmation
  literal on the request.
- **Queue overrides**: a work item can be explicitly excluded or included, or given a local priority
  override, and these overrides are re-applied after every tracker poll so a refresh cannot silently
  resurrect an excluded item.
- **Review agents**: `review.agents` can name other provider instances to review a PR before a human
  does. Only provider instances flagged for Symphony code review are eligible; every shipped provider
  except Kiro carries that flag. This is separate from execution: the agent that does the work is
  Codex, regardless of which providers are configured for review.

## Tracker adapters

| `tracker.kind`    | Tracker                          | Doc                                                                        |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `github`          | GitHub Issues (via the `gh` CLI) | [symphony-github.md](../integrations/symphony-github.md)                   |
| `github_projects` | GitHub Projects v2               | [symphony-github-projects.md](../integrations/symphony-github-projects.md) |
| `jira`            | Jira                             | [symphony-jira.md](../integrations/symphony-jira.md)                       |
| `linear`          | Linear                           | [symphony-linear.md](../integrations/symphony-linear.md)                   |
| `gitlab`          | GitLab                           | [symphony-gitlab.md](../integrations/symphony-gitlab.md)                   |
| `asana`           | Asana                            | [symphony-asana.md](../integrations/symphony-asana.md)                     |
| `azure_boards`    | Azure Boards                     | [symphony-azure-boards.md](../integrations/symphony-azure-boards.md)       |

A tracker and a source-control provider are independent: a Jira-tracked issue can still open a GitHub
pull request, for example. Every adapter's credentials are scrubbed from the coding-agent child's
environment; the agent never sees the tracker token directly.

## Current maturity

Symphony is implemented, merged, and covered by unit and integration tests across the orchestrator,
trackers, workflow config, runner, evidence, and persistence layers, plus a live server-boot probe
that confirms the whole layer graph composes and starts cleanly. What it has not yet done is complete
a live run against a real tracker, a real coding agent turn, and a real pull request, end to end, in
production. That first live run is exactly what `SMOKE.md` at the repository root defines pass
criteria for: the tracker item, isolated workspace, agent turn, validation results, populated
evidence, pushed branch, and real pull request all have to agree, without creating a hosted repository
or merging the result.

Treat Symphony as present and policy-bounded, not as a finished, battle-tested path yet. In
particular:

- Merging is gated behind the explicit `approveMerge` checks in step 9 above, and stays off by
  default until a human (or a configured automated gate that itself passes those checks) approves it.
- The execution agent is Codex only today, even though the workflow schema is written to be
  provider-agnostic for the future.
- A workflow's `autonomy` and effective `codex.*` settings determine whether the runner can edit;
  human responses to live approval requests determine whether gated Codex actions proceed. Read a new
  `WORKFLOW.md` carefully before activating it, and do not treat the parsed-only approval fields listed
  above as enforcement.
