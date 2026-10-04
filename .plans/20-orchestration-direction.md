# Plan 20: Orchestration Direction

Status: Design direction, expanded against upstream's shipped V2 nightlies and complete PR inventory on 2026-10-04. The earlier independent reviews rejected wholesale engine adoption. The dated reassessment below retains evolutionary development as the default and gives explicit evidence gates for reconsidering a replacement. Orchestration within chat without a required mode switch, plus optional Symphony workstreams across delivery applications, is now the product direction. Broader competitor performance/product research and tracker-neutral intake assessment are complete as source research, with proposed measurement and implementation gates. Implementation remains outstanding.
Supersedes: the parked Agent Gateway spec as the forward direction. Does not delete it; the Agent Gateway's hardened control-plane design is carried forward here as the governance layer.
Related: plan 17 (Symphony), plan 18 (Kiro ACP provider), plan 19 (capability graph).

## 2026-10-04 reassessment and work status

The current source-backed assessment is [Neokod: upstream nightlies and the next product direction](../docs/research/upstream-nightly-review-2026-10-03.md). This plan remains the canonical direction and work-status record. Earlier comparisons below describe the implementation reviewed at that time; the dated facts here supersede branch-status assumptions.

- Upstream [PR #2829](https://github.com/pingdotgg/t3code/pull/2829) merged on 2026-10-02 at `de343914273e`. V2 shipped in [`v0.0.46-nightly.20261003.2610`](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); the expanded review examines [`.2644`](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261004.2644), `737993303d36`, published 4 October. The complete PR inventory ends at 05:27:33 UTC, with main then at `ee7b49d638e4`. Earlier architectural source pins remain dated in the report. Shipped availability does not prove all provider/failure cases.
- The latest published Neokod release is [v3.6.0](https://github.com/kamo62/neokod/releases/tag/v3.6.0), 10 August at 06:42:36 UTC. It supplies the release baseline; the installed/deployed build was not verified. The [PR ledger](../docs/research/upstream-pr-ledger-2026-10-04.csv) accounts for 3,233 closed PRs (2,562 merged, 671 unmerged) and 1,059 open PRs, with complete enumeration, per-file scope triage and separately identified deeper comparisons. Eight incomplete file inventories remain deferred.
- The replacement still spans commands, event/projection persistence, provider execution, history import and client contracts. Upstream explicitly describes lossy cross-provider handoff and a one-way V1 history copy. Neokod's UI and removed hosted/remote infrastructure remain excluded by `AGENTS.md`.
- A fresh source check found upstream MCP delegation narrowing child runtime mode and stamping lineage. Its authenticated WebSocket operate path stamps creation provenance and reaches raw orchestrator dispatch without that MCP-specific ceiling check. This is a difference between admission surfaces, not evidence of unauthenticated access or proof that a managed child can obtain the necessary credential. Preserve that distinction in future governance reviews.
- Neokod's serialized command worker and transactional event/projection/receipt writes remain a usable admission seam. Its client-owned follow-up queue is a concrete opportunity for server-owned durable intents. Symphony still executes through a separate Codex runner, so common authority or explicit coverage of both paths must precede a claim of unified governance.
- The user values orchestration living within chat without a required mode switch, and explicitly retains Symphony's value for tracker-led workstreams such as Jira. The product target is a conversation that can queue, delegate, schedule, watch and receive outcomes, plus "Send to Symphony" with linked progress/evidence and governed workspace transfer. Retain the Symphony board for project-wide work. Adapt durable task, recovery, cancellation, result and admission patterns into both execution paths where applicable. Existing cross-mode handoff is ownership machinery, not evidence of shared lifecycle enforcement; runtime/permission policies remain explicit.
- Claude Code successfully consulted canonical `claude-sonnet-5-5` with tools and persistence disabled. Sonnet's supplied-context critique supports keeping the engine, but challenges the separability assumption and asks for migration and behavioural evidence before ruling out a new core. It is not a second source/runtime verification.
- A second confirmed Sonnet 5.5 call assessed chat plus existing-Jira-task dispatch. Its useful shared seam is a durable delegation request and result-delivery receipt, with canonical target identity, provider-aware authority and workspace ownership. Preserve each execution path's authoritative attempt state. The critique is summary-based, not source/runtime evidence.
- The comparison now includes Synara's last three calendar months of PRs and every B-and-above application in the supplied tier image, with current GitHub issue reports considered alongside code. The image defines scope, not an independently verified ranking. [Competitor report](../docs/research/competitor-codebase-review-2026-10-04.md). UI inspiration remains a deliberate Neokod design decision; a separate [interactive concept](../docs/research/chat-workstreams-concept-2026-10-04.html) illustrates parent/child work and seven delivery-app examples without changing the application.
- The user changed delegated investigation/validation to GPT 6.1 Sol at high. Active Luna investigation stopped; Sol independently validated all prior substantive findings before final research acceptance. GPT 6 Luna at max remains available to execute established work plans, with Sol validation of substantial implementation. Global instructions were updated.

| Work item | Status | Next gate |
| --- | --- | --- |
| Latest stable/nightly/main and all closed/open PR inventory | Complete as inventory and scope research | All 4,292 captured PRs are accounted for in the ledger. The report identifies deeper local comparisons, incomplete file evidence and remaining validation. This is not a line-by-line audit of every diff. Selected source/finding corrections are integrated and separately recorded. |
| Current Neokod architecture and clean-slate comparison | Complete as source research | The report identifies a minimal alternative and reasons to reverse the recommendation. |
| Claude Sonnet 5.5 critique | Complete | Exact model confirmed by CLI response metadata; advice qualified as context-based. |
| Independent Sol validation of earlier Luna findings | Complete as source/finding validation | All 100 PR findings and 17 broader claims independently accounted for. Corrected #12847 exclusion, snapshot/rewind/SQLite/fallback claims, missing early ledger rows and classifier scope. [Per-finding record](../docs/research/evidence/t3-sol-per-finding-validation.json) and corrected narrative remain qualified; runtime gates outstanding. |
| Competitor code, current issues and Synara PR comparison | Complete as source/tracker research | All 16 B-and-above apps plus Synara covered; 24,333 open-issue records inventoried across 16 public trackers; 83 initial and 17 additional performance/product cases assessed. Synara: 965 PRs/file inventories, 12 selected comparisons. Public-source/licence and mutable-capture gaps explicit. [Report and appendices](../docs/research/competitor-codebase-review-2026-10-04.md) map patterns to local seams and finite acceptance gates. No competitor runtime or live tracker reproduction claimed. |
| Wider competitor performance/product comparison and delivery-app intake | Complete as source/product research | 49 additional source/document patterns across all 17 apps, with callers where public implementation is available, local matches, issue qualifiers and proposed finite measurement gates. All seven tracker adapters traced; reference/native identity, scope, state, dependency and read/write capability gaps recorded in the [intake assessment](../docs/research/work-delivery-intake-review-2026-10-04.md). The standalone concept covers seven illustrative delivery sources. Performance measurements, implementation and live support remain outstanding. |
| Existing-engine safety/reliability ports | Outstanding | Start with rewind isolation (#12306) and receipt aggregate identity (#5246), then terminal-write recovery (#15442), process guards (#14461), writable SQLite/error semantics (#15488) and Codex EOF (#12777). Local rewind currently always restores files; a conversation-only path would be a separate contract/action addition. Continue Claude result/config/auth truth, checkpoint quarantine, read-only git and file-permission/optional-metadata fixes against the report's gates. Open PRs remain proposals. |
| Measured performance and storage improvements | Outstanding | Include growing-code Markdown/highlighting, byte/tail-bounded terminal history and parser/consumer pressure, idle live-stream versus warm-cache ownership, codec reuse, hidden optional clocks/polls, diff/index/watcher cost, command navigation and packaged startup/process attribution. Reuse existing LegendList/highlight cache/diff workers/native index. Freeze relevant local fixtures and measure each candidate before claiming a gain. Bound individual event serialisation (#12305), snapshot payloads (#9000), streaming append (#9032), focused history reads (#9662/#9758/#10108/#10120), diagnostics (#13763) and WAL retention (#13684). Use equivalent frozen workloads; source opportunities are not measured savings. |
| Reconnect policy ports | Outstanding | Adapt justified backend intent from #14897; investigate the still-open #14518 against local delayed-snapshot behaviour. |
| Symphony live tracker-to-PR proof | Outstanding | Preserve/integrate the existing dirty changes through normal review, then run a controlled workflow and retain evidence. Do not upgrade source/test evidence to live proof. |
| Durable server queue and manual `/throw` | Outstanding | Persist intent/selection/content and idempotency; prove restart ordering and exclusive workspace ownership. Manual handoff can precede general delegation, but must handle permissions and briefing omissions honestly. |
| Chat orchestration and optional Symphony workstreams | Outstanding, user direction | Prove prompt → queued/delegated work → reviewable outcome in one chat, including stop and restart. Then prove "Send this task to Symphony" through each advertised delivery adapter: reference→canonical scoped native ID, state/dependency/capability and workflow checks, one existing claim, durable source-chat/request linkage, linked attempt/evidence/PR and ownership transfer. Jira, Linear, GitHub Issues/Projects, Azure Boards, GitLab and Asana have registered source adapters with differing limitations; future apps need explicit support. Current freeform delegation creates a manual item and lacks this intake/linkage. [Adapter matrix](../docs/research/work-delivery-intake-review-2026-10-04.md). Retain Symphony board/approval controls and keep tracker/source-control integrations independent. |
| Provider capability and admission model | Outstanding | Inventory interactive and Symphony entry paths; stamp policy/provenance atomically; retain unknown capabilities and Kiro's restrictions. |
| Bounded delegated tasks, PR watches and schedules | Outstanding | Follow the capability/admission, result, cancellation and recovery gates in the report. Each delegated review round is its own task. |
| Replacement-core or clean-slate feasibility | Conditional, not started | Compare a pinned prototype if a shared chat/task lifecycle otherwise requires mirrored authoritative Code/Symphony state, or another concrete obstacle/credible simpler integration is demonstrated. Use copied history and equivalent workloads, with migration/rollback gates. |
| Required application checks for this checkout | Unavailable | `vp check` and `vp run typecheck` both exit 127 because `vp` and the local dependency binary are absent. No application change is claimed complete. |

Changes from this assessment are documentation-only. Existing dirty Symphony and adjacent UI/contracts work remains owned by its prior workstream. There is no research blocker; the implementation and live-evidence gates above remain open.

## Review synthesis (Fable + Codex sol xhigh, independent lanes)

Both lanes reviewed the first draft's "adopt upstream v2's engine, keep our control plane on top" and rejected it as written, for the same grounded reasons. The corrected decisions this document now reflects:

1. **Migration, not rebase.** Upstream v2 is not a separable engine under neokod's runtime. It is a vertical replacement across commands, projections, persistence, provider execution, and lifecycle. Neokod's providers expose `adapter`; v2 expects a separate `orchestrationAdapter`, so Kiro, Copilot, and the rest need bridges or new v2 adapters, not registration changes. Runtime-item closure (#112) is embedded in current ingestion, reactors, and projections, not a layer that stays "on top." The repo's own policy (`AGENTS.md`) says upstream work is ported and adapted, not merged wholesale. So: own neokod's engine as the default, harvest v2's four good ideas into it as new commands, and treat any deeper v2 adoption as a pinned backend port gated on the seams in point 3. Fork-and-own is the fallback if upstream will not provide those seams.

2. **Vantage: agent proposes, orchestrator disposes.** "You cannot govern where the governed party initiates" is a false dichotomy. Initiation is not authority. The correct model is: the agent proposes, and the orchestrator admits, narrows, provisions, observes, and cancels. This keeps emergent agent-directed delegation while credentials, budgets, workspaces, and execution authority stay outside the agent.

3. **The command boundary must become a real capability boundary, not a wrapper.** Neokod's own raw dispatch is already public and reachable from WS, HTTP, CLI, startup, reactors, and reconciliation. A read-then-dispatch wrapper has a race. Governance requires: no external caller receives raw engine dispatch; every path routes through one governed admission; actor, source, parent, workspace authority, and ceiling are server-derived, never repaired from wire fields; authorization covers later mutations too (mode changes, provider and model switches, forks, reads, waits, interrupts); and policy evaluation plus immutable lineage and ceiling persistence happen inside the engine's serialized admission transaction. The low-conflict form is an engine-owned admission hook with a neokod-owned policy implementation.

4. **Governance is cooperative, visibility-first, and opt-in.** Neokod is first a developer platform; governance is a layer a team turns on, not a default that ships enabled. When on, the organization's interest is sight and routing: provenance of what agents did, and provider traffic routed through its controls. The developer stays trusted; the agent is where enforcement lives, and it tightens as autonomy grows. A harder tier (mandatory credential-owning gateway, fail-closed routing, durable audit ledger) is a further opt-in surface for organizations with a specific compliance mandate, offered neutrally rather than as the standard the cooperative model is judged against.

5. **Provider-native versus app-owned delegation.** App-owned delegation (the orchestrator spawns the child) is enforceable at the command boundary. Provider-native subagents (a Codex or Claude agent spawning its own children through its own tools) are observed after the fact and can only be governed if managed mode disables those native tools or routes them through app-owned admission. The plan must treat these as two different governance classes.

6. **Symphony is not yet a subagent substrate.** The "model reviewer is an embryo" claim is factually wrong: the reviewer is a `generateCodeReview` call on a diff at fixed concurrency, not a child run, session, workspace, or cancellable node. Symphony execution is also Codex-specific today. Before nested roles it needs durable root/parent/role/depth state, tree-wide cost and concurrency reservation before spawn, transitive cancellation and orphan recovery, durable wait dependencies with cycle rejection, bounded attributed child results, and isolated worktree identity with serialized merge-back. The proposed setup-script exclusion also conflicts with Symphony's current `after_create` hook and must be reconciled.

7. **Preconditions and omissions to close.** A single ordered runtime-mode rank is not a valid cross-provider privilege model; compare effective capabilities per provider. A command receipt proves domain acceptance, not provider-turn acceptance; launch outcome must stay durable and idempotent. Child output is untrusted context and needs size limits, provenance, and prompt-injection boundaries. Neokod needs its own migration, rollback and canary plan before adopting another history core. And "single omniscient choke point" is false until native subagents, direct provider actions, and every raw-dispatch consumer are covered. Use a versioned acceptance checklist: V2 now ships in upstream nightlies, with active provider, rollback and subagent hardening, rather than being only branch work.

## 0. How to read this document

This plan started from a comparison between neokod's parked Agent Gateway and upstream T3 Code's `orchestration-v2`. The first draft concluded "adopt upstream's engine, keep our control plane." The Fable review lane refuted that on grounded evidence, and this revision reflects the corrected direction. The comparison and the four-axis evidence are kept because they are still the reason the direction exists. The decision they lead to has changed.

## 1. Decision

1. **Keep neokod's own orchestration engine as the default.** Do not rebase onto upstream's `orchestration-v2`. Neokod owns a shipped event-sourced engine (decider, projector, event store, four reactors, with runtime-item lifecycle from #112 and settings revisions from #117). Adopting V2 requires a migration across different commands, projections and provider contracts. Reconsider the core against the dated prototype gates, including the user's requirement for orchestration within chat.

2. **Harvest v2's four good ideas as new commands on the engine neokod owns.** The execution-node tree, cohort coalescing of delegated completions, the immutable delegated-result pin, and the replay-safe versus process-bound effect classification are the parts of v2 worth having. Port them as new commands, events, and reactors in neokod's decider, not by adopting the foreign engine that carries them.

3. **Govern at the command boundary neokod owns.** Because the command boundary is neokod's own decider (`decider.ts` plus `commandInvariants.ts`), the privilege ceiling is a small permanent invariant there, not a perpetual patch on someone else's hot path.

4. **Keep the orchestrator vantage, reframed as owning authority, not initiation.** Agents may initiate delegation. What matters is that an agent-initiated request carries no authority, and the orchestrator stamps the ceiling and provenance server-side at the single command choke. This preserves emergent, agent-directed delegation while keeping governance real.

5. **Before any subagent work, land a provider-aware capability model** and flip the default runtime mode off the most-permissive setting. Narrow effective capabilities within each provider instead of forcing unlike permission vocabularies into one rank. This is a precondition, not a later cleanup.

One-line form: own the engine, harvest the ideas, govern at your own command boundary by owning authority rather than initiation.

## 2. Why: the comparison that produced this direction

Neokod designed an Agent Gateway (MCP-driven multi-agent delegation) and parked it after a three-round adversarial review. The initial comparison examined upstream `orchestration-v2` on the `codex-turn-mapping` branch, with a 9-document design spec and an `orchestrator-mcp-server` exposing eleven tools at that time. That system has since merged and shipped in upstream nightlies; its current surface is broader, as the dated reassessment records. The two systems converged on the same primitive: an interface where an agent can spawn and supervise subagent trees across providers.

### The four-axis review of upstream v2 against neokod's Agent Gateway design

- **Trust boundary (governance-critical)**: the earlier review found helper-level delegation ceilings without the same check at the shared raw-command boundary. The dated source check above still finds that mismatch on an authenticated operate-scope path. Neokod's proposed server-derived provenance and command-boundary gating address that class of failure, but this is a reviewed design, not shipped enforcement. Agent credential possession and exploitability remain unproven.
- **Worktree identity and recovery**: the earlier upstream snapshot stored branch/path strings without the recovery identity proposed by Neokod's design. That design requires pinned base SHA, common-dir identity, collision-safe branches and porcelain-based recovery. It remains unimplemented and is an acceptance checklist for either engine, not evidence that Neokod's runtime already provides stronger recovery. Recheck the current upstream implementation before asserting those fields are absent today.
- **Setup-script execution**: the earlier upstream review found unsandboxed setup-script execution outside the runtime ceiling. Neokod's delegation design excludes setup scripts; this is a design requirement, distinct from Symphony's existing lifecycle hooks. Reconcile those semantics before implementing children.
- **Crash recovery**: the reviewed upstream implementation fail-closed ambiguous provider starts, while Neokod proposed `launch_unknown` plus pinned turns. These are alternatives to test, not equivalent runtime proof. Upstream's immutable delegated-result pin and explicit effect replay classes remain useful concepts to adapt.

### What the comparison actually proves

Upstream implemented a fleet engine; Neokod reviewed a set of proposed governance invariants. The first draft read this as "take their engine, keep our control plane." The review showed that Neokod already has an engine with a different command/persistence foundation, while Symphony runs on a separate plane that engine replacement would not automatically cover. The default remains adapting useful concepts into Neokod. A replacement needs the pinned prototype, provider coverage and migration gates in the dated reassessment.

## 3. The engine decision, corrected

Grounded facts from the tree that decide this:

- Neokod owns a full event-sourced engine: `apps/server/src/orchestration/decider.ts`, `projector.ts`, `OrchestrationEventStore`, and four reactors (`ProviderCommandReactor`, `OrchestrationReactor`, `CheckpointReactor`, `ThreadDeletionReactor`). `runtimeMode` is already a first-class event field.
- The command boundary is neokod's own code, importing `@neokod/contracts`, not upstream's.
- Upstream v2 is an execution-node aggregate tree with a leased effect outbox. Neokod is a decider producing events consumed by a projector and reactors. "Rebase your control plane onto their engine" is not a meaningful operation across that boundary, because neokod's control plane is its decider.
- The existing event-sourced core, provider registry, separate Symphony plane, and merged #112/#117 increase migration scope. They support the current evolutionary recommendation; they do not measure whether ownership is cheaper than a replacement.

On Neokod's engine, governed admission and its invariants can live with the serialized command path. Every external dispatch path still has to route through that admission, and later mutations need the same authorization; this is more than a `thread.create` guard. A replacement would need a Neokod-owned admission seam supplied by the upstream core or maintained in a bounded fork, with every caller covered. The helper/raw-command mismatch explains why the seam matters; it does not prove such a seam cannot be implemented in another engine. A pinned prototype can establish its feasibility and maintenance cost.

## 4. Vantage: own the authority, not the initiation

The first draft claimed "you cannot govern from a vantage where the governed party initiates." That is too absolute, and the plan's own delegation design contradicts it. The correct axis is not who initiates but where authority is stamped.

- An agent may initiate a delegation request. If that request carries no authority of its own, and the orchestrator stamps the ceiling and provenance server-side, the delegation is fully governable.
- Upstream's failure was not that the agent initiated. It was that enforcement lived in the MCP handler while an unenforced WS dispatch path existed. The lesson is single-choke authority, not orchestrator-only initiation.

So neokod keeps emergent, agent-directed delegation (the agent picks what, when, and to whom) while the orchestrator holds authority (whether, under what ceiling, with what provenance). This is also exactly the shape of the slash-command and `/throw` flows in section 6: user or agent initiates, the orchestrator authorizes and records.

## 5. ACP, MCP, and the delegation surface

A subagent is just another agent session, so a subagent tree is a tree of sessions the orchestrator manages, over ACP for ACP providers (Cursor, Grok, Kiro) and each provider's native protocol otherwise. Delegation does not need to be an MCP tool the agent calls. It can be a first-class orchestration primitive: the parent expresses a need, and the orchestrator, as the authority, spawns and governs a child session.

Upstream chose MCP because it is the portable way to hand any agent orchestration power without custom integration. That portability is real and is why MCP is attractive. The cost is that MCP tools make the agent the initiator, and that is fine under section 4 as long as authority stays server-side. So keep an MCP surface as an optional, governed request channel into the orchestrator, not a bypass of it. "Further than MCP" is not a richer tool protocol. It is keeping the delegation authority in the orchestrator, which then speaks whatever protocol each child needs.

## 6. Conversation handoff: the /throw flow

### The problem it solves

A thread today is bound to one provider driver once it has a session (see section 7). If an agent runs out of usage, you cannot move the live thread to another provider, and the live cross-driver handoff machinery (upstream's context-handoff service) is fragile and provider-specific. `/throw` sidesteps all of that.

### The design

`/throw` sends a conversation to another agent as a Markdown briefing, from one thread to a new thread, and links the two. The link is a document, not a session bridge, which is why it works across any provider.

1. **Payload**: render the source thread's conversation to a Markdown briefing (messages, decisions, files touched, current diff).
2. **Target**: create a new thread on the chosen agent. The driver switch happens cleanly because it is a fresh thread, not a rejected mid-thread driver change.
3. **Seed**: inject the Markdown as the new thread's opening context, as a preamble on the first turn. The new agent links by reading the briefing. Any agent reads Markdown; there is no internal-state handoff to get wrong.
4. **Lineage edge**: record a durable "thrown from thread X to thread Y" link. This edge does not exist today and is the small durable addition worth making, because a delegated-subagent relationship needs the same primitive. Build it once.

### Design decisions inside /throw

- **Conversation only, or conversation plus workspace.** The powerful version has the new thread continue in the same worktree, so the new agent inherits the live code state, not just the chat. This raises the two-threads-on-one-worktree ownership question, which the #112 workspace-lease work already has machinery for.
- **Full transcript or compacted.** A long thread will overflow the target context window, so `/throw` offers full or summarized. The summary is where an agent links in the other sense: the source agent or a cheap summarizer produces the briefing before the throw. That is a small bounded delegation and connects `/throw` to the subagent model without depending on it.

### Why /throw matters strategically

It is a proposed near-term answer to the quota-switch problem on Neokod's own engine. A human-requested `/throw` can precede general delegation, but needs server-stamped provenance, target-capability checks, bounded briefing/omission handling, exclusive workspace semantics, and durable accepted/started/outcome evidence. An observable handoff event alone does not establish authority or successful continuation. Agent-initiated handoff must use governed admission.

### The UI layer

`/throw` requires a UI layer, and it is the same view a project wants anyway: a chain, or lineage, view. A project accumulates threads, and with `/throw` those threads form chains across agents (thread A on Claude, thrown to thread B on Codex, thrown to thread C for review). The lineage edges feed a project-level chain view that shows what has been going on within the project: which work moved where, on which agent, and why. This is a first-class surface, related to the existing project sidebar and the My Work inbox, and it is how a person reconstructs the arc of a project that has spanned several threads and agents. The lineage edge from step 4 is the data behind it.

## 7. Mid-thread agent switch: the current state, as motivation

Verified in code, so the direction is grounded in what exists.

- **Code mode.** A thread binds to a driver once it has a session (`ProviderCommandReactor.ts:447-457`). Switching between instances of the same driver, or changing the model within a driver, is allowed, subject to a `requiresNewThreadForModelChange` flag for providers like Codex. Switching to a different driver is blocked outright: the reactor errors `Thread is bound to driver 'X' and cannot switch to 'Y'`. Adapters detect quota and overload errors, but nothing acts on them; there is no auto-failover. So on quota exhaustion today you can only move a thread to another instance of the same provider, manually.
- **Symphony mode.** Execution is Codex-only today: `Runner/AgentRuntime.ts` spawns `codex app-server` directly. Config and attempt metadata may resolve a provider from `agent.model`, but that does not supply another execution adapter. Retries reuse the workflow/model configuration, with no execution-provider fallback. Other providers can participate in configured review roles; reviewers are not execution failover.

Neither mode does what a user wants when an agent runs out of usage. `/throw` (section 6) is the near-term answer for Code mode. A governed, quota-aware mid-run agent switch is the answer for Symphony (section 8): when the dispatched agent exhausts quota, Symphony re-dispatches to a workflow-configured fallback agent and preserves the run, an event the orchestrator records.

## 8. Symphony subagent delegation

The goal is that a Symphony agent working an issue can spin up its own subagents for research, for review, and for parallel work, under Symphony's authority.

Symphony's model reviewer (#108) provides useful policy and evidence patterns, but it is a bounded `generateCodeReview` call, not a child run, session, workspace, or cancellable node. General subagents therefore require new durable orchestration state for three roles: read-only research children, interim review children, and parallel work children in isolated worktrees.

The load-bearing failure modes that must be designed before this is built, flagged by the review lane:

- **Substrate mismatch.** Symphony runs on a separate plane: `Runner/AgentRuntime.ts` spawns `codex app-server` directly as a child process, and the Dispatcher calls `runTurn`, never `orchestrationEngine.dispatch`. So subagents built on the Symphony runner do not inherit the engine's outbox, coalescing, or immutable pin. Either re-platform Symphony onto the engine (large, unscoped) or reimplement fan-in and pinning in the runner. This must be decided, not assumed.
- **Capability narrowing.** "Child equals parent narrowed" needs a provider-aware comparison that does not exist. There are three un-unified permission vocabularies (orchestration `RuntimeMode`, Symphony `autonomy`, Codex sandbox), no narrowing function, and the default runtime mode is `full-access`, the most permissive. An "observe" ceiling for research children is not even in the `RuntimeMode` enum. Land the effective-capability model and flip the default to the floor first (section 1, item 5).
- **Cost and quota.** No budget exists. Fan-out multiplies credit burn, and Copilot quota is data-layer only. The orchestrator must debit a per-run budget before granting a subagent. This is the most concrete organization ask and it is currently absent from the whole model.
- **Nesting and concurrency.** No max depth or total concurrency cap. Work subagents that can request subagents give an unbounded tree. Add both.
- **Wait deadlock.** A blocking wait primitive plus Symphony's blocking approval loop can deadlock: a parent blocked in wait cannot answer the child's approval, and two work subagents can wait on each other's worktree. Need wait TTLs, cycle detection, and a rule that a waiting parent still services child approvals.
- **Worktree identity and runaway control.** Base-SHA and common-dir recovery is design, not code. Parallel merge-back semantics are unspecified. The process-group primitives in `AgentRuntime.ts` (`makeProvenGroupIdentity`, `captureProcessBirthToken`) exist and should back a hard wall-clock TTL that kills a runaway subagent tree.

## 9. Governance for a local-first product

Governance in neokod is opt-in. Neokod is first a developer platform, the best local-first tool for agentic work it can be, and governance is a layer a developer or organization turns on, not something that ships enabled. Every tier below is opt-in, including the cooperative one. The design goal is the platform; governance is what the fork adds on top for teams that want it.

When it is turned on, neokod's governance is cooperative and visibility-first by design. That is the intended model, not a shortfall from some stricter ideal. On a developer's own loopback instance the developer is trusted, so governance is not about restricting the person. It is about giving the organization sight and routing: provenance of what agents and developers did, and provider traffic routed through the organization's controls. For the "route, don't restrict" thesis this is complete governance, not a fallback from a harder one.

Three tiers, in order of how much they matter for this lens:

- **The developer is trusted.** Point-of-action restriction against the person is theater and against the point. For the developer, governance is visibility: the command boundary is the instrumentation point, every governed action emits a structured event (agent, provider, ceiling, parent, output), and the organization governs by seeing the whole picture.
- **The agent is where enforcement lives, and it scales with autonomy.** A prompt-injected agent reaching a dispatch channel is what ceiling plus server-stamped provenance at the command boundary defends against, and there it is real enforcement. The narrow fail-closed set (an agent self-approving its own approval, a credential leaking into a child, a subagent escalating its ceiling) is first-class. This is the axis that adjusts as work becomes more agentic. More autonomy and more delegation mean the agent-side controls (ceiling, provenance, cost and depth budgets, cancellation) carry more of the load, while the developer stays trusted. Being comfortable with that adjustment is the point: tightening the agent boundary is how neokod earns more autonomy safely, and it is a different thing from restricting the person.
- **Org-mandated hard enforcement is an optional tier for those who need it.** A cooperating local client can stop cooperating, so a hard block for an organization with a specific compliance mandate needs a routing gateway that owns provider credentials and controls egress. That is a central control point, so it is offered as an opt-in surface for organizations that want it. It is not required of everyone, and it is not the standard against which the cooperative model is judged. Offering it does not turn the local default into a lockdown.

Two grounded corrections the plan carries regardless of tier. First, "the command boundary is the single point through which every dispatch flows" is not true today, because Symphony runs on the separate plane in section 8, so the interactive engine and the Symphony runner must be unified or both explicitly instrumented before observability is called the mechanism. Second, PostHog can carry governance events for analytics, but a compliance audit trail wants a durable ordered ledger, so treat PostHog as telemetry and keep the audit log separate.

Telemetry substrate: PostHog is in for rough usage stats. The direction is to enhance it into the governance telemetry layer, structured error logging and feature-usage events emitted from the command boundary as governed-action events, alongside a local durable audit log and optional forwarding to the org's AI-Orch endpoint. The same instrumentation serves product analytics and governance, because both answer the same question: what did the agents do.

## 10. What to keep, what to harvest, what to build

- Keep: neokod's event-sourced engine (decider, projector, reactors, event store), the merged #112 runtime-item lifecycle and #117 settings revisions, the provider registry, and Symphony.
- Harvest from v2 as new commands on neokod's engine: the execution-node tree, cohort coalescing, the immutable delegated-result pin, and the replay-safe versus process-bound effect classification.
- Keep from the Agent Gateway design: command-boundary privilege enforcement, server-stamped un-forgeable provenance, worktree-identity recovery, setup-script exclusion, ancestry authorization on read, wait, and interrupt.
- Build new: the provider-aware capability model (precondition), the `/throw` flow and its project chain UI (near-term, standalone), the Symphony subagent-role model with the bounds in section 8, the governance telemetry substrate on the command boundary, and the routing integration with AI-Orch.

## 11. Sequencing and open questions

Start with the existing Symphony live-proof gap and justified local reliability work. Then add the durable server queue and manual `/throw`, alongside provider-aware capabilities and admission inventory. A human-requested briefing into a fresh thread need not wait for the entire delegation design, but workspace ownership and permission handling are preconditions. Agent-initiated handoff and app-owned children must use governed admission. Neokod designs any required UI itself.

Then: harvest v2's ideas into neokod's engine as they prove out upstream, without adopting the engine. Decide the Symphony-plane question (re-platform onto the engine, or dual-instrument) before subagents, because it gates both the substrate and the single-boundary governance claim.

Open questions for the final review pass:

- The Symphony-plane decision. Re-platforming Symphony onto the orchestration engine is large and unscoped. Dual-instrumenting keeps two planes but delivers governance sooner. Which, and at what cost?
- Capability narrowing. How are effective capabilities compared within each provider, and what cross-provider narrowing relation is safe? This blocks subagents.
- Cost and quota governance. What is the budget model, and where is it debited, given Copilot quota is data-layer only today?
- The org gateway. Is an opt-in credential-owning gateway acceptable as a separate surface, and does offering it undermine the local-first positioning, or extend it?
- `/throw` workspace semantics. Does a thrown thread share the source worktree (live state, ownership question) or start clean (safe, loses working state)?

## Appendix A: the Agent Gateway design and its three-round review

This appendix is the durable record of the Agent Gateway work, because that design is the control plane this plan carries forward and because it was reviewed harder than anything else in the codebase. The plan above draws on it in sections 2, 4, 6, and 10; the detail lives here.

### What the Agent Gateway was

An MCP-driven multi-agent delegation system. A provider agent, through MCP tools, could spawn and supervise child agent runs. The Phase 1 tool surface, after review, was seven tools: `context`, `catalog`, `create`, `create_batch`, `wait` (terminal-only), `read` (bounded), and `interrupt`. Children were first-class threads with their own runtime mode, worktree, and lifecycle, created by the orchestrator on behalf of the requesting agent.

### How it was reviewed

Three rounds, three independent lanes each: an orchestrator lane (Fable), a Codex gpt-5.6-sol xhigh lane, and a deep-reasoner (Opus) lane. The lanes reviewed the spec independently and were synthesized at the end of each round. Round 1 blocked implementation. Round 2 resolved most blockers in design terms. Round 3 was a delta patch. The verdict was to park the build after the Fable and sol lanes agreed the direction was sound but the spec was not implementable as written without further hardening, and the product priority moved elsewhere.

### The load-bearing finding: the trust boundary (C1)

At the historical review, the loopback server lacked application authentication and its raw dispatch route bypassed MCP capability checks. That described the review-time tree. Current headless `serve`/`start` use a per-launch bearer and single-use WebSocket tickets; the legacy desktop bootstrap may still omit the loopback credential, as the current README explains. Authentication does not by itself narrow the broad RPC authority after connection. An agent's access to the credential or unauthenticated bootstrap must be established separately before claiming it can use that route. The trusted OS-user boundary and the need for agent-aware command admission remain relevant.

The spec's resolution, accepted as sound for a local-first product, was to take the advisory branch explicitly and do it honestly: `origin` and actor are stamped from a server-internal dispatch context, never from client-decodable command fields, and never inferred from a caller-controlled command-id prefix. The residual bypass is stated plainly rather than hidden behind a capability model that pretends to enforce what it cannot. The round-3 synthesis added one narrowing: capability-gate the genuinely dangerous commands (approval-response and checkpoint-revert) at the command boundary, because a prompt-injected agent could otherwise self-approve its own approval request or revert the workspace through the raw route, and approval-required is the gateway's own default safety posture. This self-approval gate is the direct ancestor of the "narrow fail-closed set" in section 9 of this plan.

This finding is why the plan requires an owned admission seam (section 3) and server-derived authority (section 4). The dated upstream check identifies an analogous helper/raw-command mismatch, qualified by its authenticated operate scope. It does not establish a production exploit or what upstream has acknowledged.

### The hardened control-plane decisions

These are the design decisions the review produced, and they are what section 10 means by "keep from the Agent Gateway design":

- **Server-stamped, un-forgeable provenance.** Origin, actor, and lineage stamped from the server-internal dispatch context. A child cannot claim an identity it was not given.
- **Fail-closed dual-control transport.** A remote-peer guard that rejects non-loopback peers before bearer resolution, plus a dedicated `127.0.0.1` listener that is the normative home for the MCP route, with startup blocked if it cannot bind. No silent fallback to the shared wildcard route.
- **The `launch_unknown` launch-state machine with pinned turns.** Explicit states: `turn_intent_committed`, `provider_started(turnId)`, `launch_failed`, `launch_unknown`. A claimed-but-unacknowledged intent becomes `launch_unknown`, is never auto-resent, and is never auto-closed by a TTL; it is resolved only by send-key correlation after a confirmed session stop with no active binding. A create returns running only once the concrete provider turn id is durably stored. A `provider_send_idempotency_key` prevents duplicate sends. The pinned accepted turn id is used by wait, read, and interrupt, so a later human turn on the child cannot change what the parent reads.
- **Turn-targeted interrupt.** `expectedActiveTurnId` is an atomic command invariant, rechecked under a per-thread provider-session lock immediately before adapter interruption, returning not-active on mismatch, with a human-turn race test. A stop never hits the wrong turn.
- **Atomic reservation.** Limit reservation, the operation row, and the per-item rows land in one SQLite transaction before any side effect, with a per-task ownership claim shared by live retries and the reconciliation worker so the two cannot both act. The idempotency hash is over canonicalized caller input, not resolved defaults, so an honest retry after a defaults or catalog change does not spuriously conflict.
- **Single wait coordinator, terminal-only wait.** One combined live subscription attached before any snapshot read, so a multi-task wait cannot lose a wakeup. The `settled` mode was dropped from Phase 1; only `terminal` waits ship. Default timeout 60s, hard max 120s, always returning a retry-after hint, with ceilings raised only on per-provider conformance evidence.
- **Ancestry authorization.** A caller may pass to wait, read, and interrupt only taskIds within its own root delegation subtree. A compromised parent cannot read arbitrary thread transcripts by id.
- **Worktree identity and recovery.** Base commit SHA pinned at reservation, repo common-dir identity, collision-safe branch derivation from stable ids, recovery via `git worktree list --porcelain`, and an explicit rule for the crashed-mid-create case where the intended path exists as an unregistered directory. Non-force removal only when the directory is clean, operation-owned, and unreferenced.
- **Setup-script exclusion.** Setup-script execution was removed from the delegation path entirely, because it is unsandboxed host execution outside every runtime ceiling.
- **Fail-closed child policy.** A missing or failed origin lookup yields observe-only, never create. Credential revocation is session-generation-aware, so a stale session exit cannot revoke a replacement session's credential. A conformance test proves a Codex child's shell cannot read the raw bearer from its environment.

### Compensation and crash safety

A command receipt is not provider-turn acceptance. The reactor commits the receipt with the orchestration event, before publish, and forks the send later, so a crash between the two must not strand or duplicate work. The design pins a launch state before invoking the provider, moves auto-compensation to before the final turn-start intent commits, and confirms no active provider session for the child before removing anything (a compensation time-of-check-to-time-of-use guard). This is the same problem upstream v2 solves with its replay-safe versus process-bound effect classification, and section 10 harvests that classification as the cleaner mechanism, while keeping the pinned turn identity from this design.

### Why this is carried forward, not rebuilt

The Agent Gateway was parked as a build, not discarded as a design. Its control-plane decisions are the strongest governance work in the project, and they map directly onto neokod's own engine as command-boundary invariants (section 3), rather than onto a foreign engine as perpetual patches. The engine question changed after the review comparison in section 2; the control plane did not. This plan keeps it.
