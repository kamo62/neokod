# Plan 20: Orchestration Direction

Status: Reviewed by two independent lanes (Fable orchestrator, Codex gpt-5.6-sol xhigh). Both returned NO-GO as written and converged on the same corrections. This revision folds both in. The direction is sound; the original engine decision was not, and is corrected below.
Supersedes: the parked Agent Gateway spec as the forward direction. Does not delete it; the Agent Gateway's hardened control-plane design is carried forward here as the governance layer.
Related: plan 17 (Symphony), plan 18 (Kiro ACP provider), plan 19 (capability graph).

## Review synthesis (Fable + Codex sol xhigh, independent lanes)

Both lanes reviewed the first draft's "adopt upstream v2's engine, keep our control plane on top" and rejected it as written, for the same grounded reasons. The corrected decisions this document now reflects:

1. **Migration, not rebase.** Upstream v2 is not a separable engine under neokod's runtime. It is a vertical replacement across commands, projections, persistence, provider execution, and lifecycle. Neokod's providers expose `adapter`; v2 expects a separate `orchestrationAdapter`, so Kiro, Copilot, and the rest need bridges or new v2 adapters, not registration changes. Runtime-item closure (#112) is embedded in current ingestion, reactors, and projections, not a layer that stays "on top." The repo's own policy (`AGENTS.md`) says upstream work is ported and adapted, not merged wholesale. So: own neokod's engine as the default, harvest v2's four good ideas into it as new commands, and treat any deeper v2 adoption as a pinned backend port gated on the seams in point 3. Fork-and-own is the fallback if upstream will not provide those seams.

2. **Vantage: agent proposes, orchestrator disposes.** "You cannot govern where the governed party initiates" is a false dichotomy. Initiation is not authority. The correct model is: the agent proposes, and the orchestrator admits, narrows, provisions, observes, and cancels. This keeps emergent agent-directed delegation while credentials, budgets, workspaces, and execution authority stay outside the agent.

3. **The command boundary must become a real capability boundary, not a wrapper.** Neokod's own raw dispatch is already public and reachable from WS, HTTP, CLI, startup, reactors, and reconciliation. A read-then-dispatch wrapper has a race. Governance requires: no external caller receives raw engine dispatch; every path routes through one governed admission; actor, source, parent, workspace authority, and ceiling are server-derived, never repaired from wire fields; authorization covers later mutations too (mode changes, provider and model switches, forks, reads, waits, interrupts); and policy evaluation plus immutable lineage and ceiling persistence happen inside the engine's serialized admission transaction. The low-conflict form is an engine-owned admission hook with a neokod-owned policy implementation.

4. **Two honest governance profiles.** Local cooperative (advisory policy, routing, local audit, optional forwarding) is a legitimate personal model, not organizational enforcement. Organization managed requires an authenticated mandatory gateway, signed policy and device identity, removal of direct provider credentials, fail-closed routing, a durable ordered audit ledger (PostHog can consume governance events but cannot be the ledger), and endpoint controls for shell and direct-CLI bypass. Name the second one centrally governed local execution, not unrestricted local-first.

5. **Provider-native versus app-owned delegation.** App-owned delegation (the orchestrator spawns the child) is enforceable at the command boundary. Provider-native subagents (a Codex or Claude agent spawning its own children through its own tools) are observed after the fact and can only be governed if managed mode disables those native tools or routes them through app-owned admission. The plan must treat these as two different governance classes.

6. **Symphony is not yet a subagent substrate.** The "model reviewer is an embryo" claim is factually wrong: the reviewer is a `generateCodeReview` call on a diff at fixed concurrency, not a child run, session, workspace, or cancellable node. Symphony execution is also Codex-specific today. Before nested roles it needs durable root/parent/role/depth state, tree-wide cost and concurrency reservation before spawn, transitive cancellation and orphan recovery, durable wait dependencies with cycle rejection, bounded attributed child results, and isolated worktree identity with serialized merge-back. The proposed setup-script exclusion also conflicts with Symphony's current `after_create` hook and must be reconciled.

7. **Preconditions and omissions to close.** A single ordered runtime-mode rank is not a valid cross-provider privilege model; compare effective capabilities per provider. A command receipt proves domain acceptance, not provider-turn acceptance; launch outcome must stay durable and idempotent. Child output is untrusted context and needs size limits, provenance, and prompt-injection boundaries. There is no migration, rollback, or canary plan for existing local v1 history. And "single omniscient choke point" is false until native subagents, direct provider actions, and every raw-dispatch consumer are covered. Replace "v2 is real, built, and correct" with a versioned acceptance checklist, since it is still branch work with unresolved provider, rollback, and subagent cases.

The sections below predate this synthesis in places; where a section still reads "adopt the engine" or calls the reviewer an embryo, this synthesis governs. A later editing pass will reconcile the body line by line.

## 0. How to read this document

This plan started from a comparison between neokod's parked Agent Gateway and upstream T3 Code's `orchestration-v2`. The first draft concluded "adopt upstream's engine, keep our control plane." The Fable review lane refuted that on grounded evidence, and this revision reflects the corrected direction. The comparison and the four-axis evidence are kept because they are still the reason the direction exists. The decision they lead to has changed.

## 1. Decision

1. **Keep neokod's own orchestration engine.** Do not rebase onto upstream's `orchestration-v2`. Neokod already owns a complete, shipped, event-sourced engine (decider, projector, event store, four reactors, with the merged runtime-item lifecycle from #112 and settings revisions from #117 on top of it). Rebasing onto v2 is not a merge, it is a re-platform across an incompatible persistence philosophy, and it would delete working code without delivering the product goal.

2. **Harvest v2's four good ideas as new commands on the engine neokod owns.** The execution-node tree, cohort coalescing of delegated completions, the immutable delegated-result pin, and the replay-safe versus process-bound effect classification are the parts of v2 worth having. Port them as new commands, events, and reactors in neokod's decider, not by adopting the foreign engine that carries them.

3. **Govern at the command boundary neokod owns.** Because the command boundary is neokod's own decider (`decider.ts` plus `commandInvariants.ts`), the privilege ceiling is a small permanent invariant there, not a perpetual patch on someone else's hot path.

4. **Keep the orchestrator vantage, reframed as owning authority, not initiation.** Agents may initiate delegation. What matters is that an agent-initiated request carries no authority, and the orchestrator stamps the ceiling and provenance server-side at the single command choke. This preserves emergent, agent-directed delegation while keeping governance real.

5. **Before any subagent work, land a canonical privilege lattice** and flip the default runtime mode off the most-permissive setting. This is a precondition, not a later cleanup.

One-line form: own the engine, harvest the ideas, govern at your own command boundary by owning authority rather than initiation.

## 2. Why: the comparison that produced this direction

Neokod designed an Agent Gateway (MCP-driven multi-agent delegation) and parked it after a three-round adversarial review. Upstream built a functionally similar system, `orchestration-v2`, on the `codex-turn-mapping` branch (not yet on upstream main), with a 9-document design spec and an `orchestrator-mcp-server` exposing eleven tools. The two systems converged on the same primitive: an interface where an agent can spawn and supervise subagent trees across providers.

### The four-axis review of upstream v2 against neokod's Agent Gateway design

- **Trust boundary (governance-critical)**: upstream's privilege ceiling is enforced only inside the MCP service handlers. The shared command boundary underneath (`ThreadManagementService.dispatch`) is a bare `orchestrator.dispatch(command)` with no policy. The authenticated WebSocket `dispatchCommand` path accepts client-provided `runtimeMode` and `parentThreadId` with no ceiling re-check, so a local principal with a WS operate-scope session can bypass the ceiling. No upstream doc flags this as advisory. Neokod's design confronted this exact case with server-stamped provenance and command-boundary gating. This is the axis governance depends on, and neokod's design is stronger on it.
- **Worktree identity and recovery**: upstream stores only `branch` and `worktreePath` (nullable strings), with no base-commit SHA, no git common-dir, and no porcelain-based recovery or crashed-mid-create handling. Neokod's design pinned base SHA, common-dir identity, collision-safe branch derivation, and porcelain recovery. Neokod's design is a generation ahead.
- **Setup-script execution**: upstream runs the project setup script as unsandboxed host execution not governed by the runtime ceiling. Neokod's design removed setup-script execution from the delegation path entirely.
- **Crash recovery**: comparable. Upstream fail-closes an ambiguous provider-turn-start to `cancelled`, which is defensible and simpler than neokod's `launch_unknown` state. Upstream's immutable delegated-result pin is genuinely good and worth harvesting.

### What the comparison actually proves

Upstream built a strong fleet engine. Neokod designed a stronger governed control plane. The first draft read this as "take their engine, keep our control plane." The Fable lane showed why that inverts: neokod does not lack an engine that upstream would supply. It has a complete one, on a different and incompatible foundation, and its governed flagship (Symphony) runs on a third plane that upstream's engine would not touch. So the value in v2 is a set of ideas to port, not an engine to adopt.

## 3. The engine decision, corrected

Grounded facts from the tree that decide this:

- Neokod owns a full event-sourced engine: `apps/server/src/orchestration/decider.ts`, `projector.ts`, `OrchestrationEventStore`, and four reactors (`ProviderCommandReactor`, `OrchestrationReactor`, `CheckpointReactor`, `ThreadDeletionReactor`). `runtimeMode` is already a first-class event field.
- The command boundary is neokod's own code, importing `@neokod/contracts`, not upstream's.
- Upstream v2 is an execution-node aggregate tree with a leased effect outbox. Neokod is a decider producing events consumed by a projector and reactors. "Rebase your control plane onto their engine" is not a meaningful operation across that boundary, because neokod's control plane is its decider.
- The threshold where forking is cheaper than tracking has already been crossed: own event-sourced core, own provider registry, Symphony on a separate plane, #112 and #117 merged.

Enforcement follows directly. On neokod's own engine the ceiling is roughly a ten-line invariant in `commandInvariants.ts` and `decider.ts` `thread.create`, permanent and conflict-free. On upstream's engine it would be a perpetual patch at the hottest path, and upstream's own trust-boundary gap (enforced at the MCP handler, unenforced at the WS dispatch) is direct evidence that you cannot reliably bolt a ceiling onto an engine you do not own. Owning the choke requires owning the engine.

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

It is a real answer to the quota-switch problem that ships on neokod's own engine, needs none of the big orchestration decisions, is provider-agnostic, and is trivially governable because it is one observable event: thread X thrown to agent Y with N tokens of context at time Z. It should be built as a near-term, standalone feature, ahead of and independent of the larger orchestration work.

### The UI layer

`/throw` requires a UI layer, and it is the same view a project wants anyway: a chain, or lineage, view. A project accumulates threads, and with `/throw` those threads form chains across agents (thread A on Claude, thrown to thread B on Codex, thrown to thread C for review). The lineage edges feed a project-level chain view that shows what has been going on within the project: which work moved where, on which agent, and why. This is a first-class surface, related to the existing project sidebar and the My Work inbox, and it is how a person reconstructs the arc of a project that has spanned several threads and agents. The lineage edge from step 4 is the data behind it.

## 7. Mid-thread agent switch: the current state, as motivation

Verified in code, so the direction is grounded in what exists.

- **Code mode.** A thread binds to a driver once it has a session (`ProviderCommandReactor.ts:447-457`). Switching between instances of the same driver, or changing the model within a driver, is allowed, subject to a `requiresNewThreadForModelChange` flag for providers like Codex. Switching to a different driver is blocked outright: the reactor errors `Thread is bound to driver 'X' and cannot switch to 'Y'`. Adapters detect quota and overload errors, but nothing acts on them; there is no auto-failover. So on quota exhaustion today you can only move a thread to another instance of the same provider, manually.
- **Symphony mode.** The agent is resolved once from `agent.model` in `WORKFLOW.md` to a single provider (`Config.ts:292-293`), and the whole run uses it (`Dispatcher.ts:258-259`). Retry re-dispatches to the same agent (`Dispatcher.ts:165-176`), so a quota exhaustion retries into the same wall. The only multi-agent element is `reviewAgents` (the #108 reviewers), a review role, not execution failover.

Neither mode does what a user wants when an agent runs out of usage. `/throw` (section 6) is the near-term answer for Code mode. A governed, quota-aware mid-run agent switch is the answer for Symphony (section 8): when the dispatched agent exhausts quota, Symphony re-dispatches to a workflow-configured fallback agent and preserves the run, an event the orchestrator records.

## 8. Symphony subagent delegation

The goal is that a Symphony agent working an issue can spin up its own subagents for research, for review, and for parallel work, under Symphony's authority.

The pattern exists in embryo. Symphony's model reviewer (#108) is an orchestrator-spawned, ceiling-bounded review subagent whose output is evidence with `provenance: "model"`, not authority, and `resolveRunnerPolicy` computes the sandbox server-side and refuses silent escalation. Generalizing gives three orchestrator-granted roles: read-only research children, interim review children, and parallel work children in isolated worktrees.

The load-bearing failure modes that must be designed before this is built, flagged by the review lane:

- **Substrate mismatch.** Symphony runs on a separate plane: `Runner/AgentRuntime.ts` spawns `codex app-server` directly as a child process, and the Dispatcher calls `runTurn`, never `orchestrationEngine.dispatch`. So subagents built on the Symphony runner do not inherit the engine's outbox, coalescing, or immutable pin. Either re-platform Symphony onto the engine (large, unscoped) or reimplement fan-in and pinning in the runner. This must be decided, not assumed.
- **Privilege lattice.** "Child equals parent narrowed" needs a total order that does not exist. There are three un-unified permission vocabularies (orchestration `RuntimeMode`, Symphony `autonomy`, Codex sandbox), no narrowing function, and the default runtime mode is `full-access`, the most permissive. An "observe" ceiling for research children is not even in the `RuntimeMode` enum. Land the lattice and flip the default to the floor first (section 1, item 5).
- **Cost and quota.** No budget exists. Fan-out multiplies credit burn, and Copilot quota is data-layer only. The orchestrator must debit a per-run budget before granting a subagent. This is the most concrete organization ask and it is currently absent from the whole model.
- **Nesting and concurrency.** No max depth or total concurrency cap. Work subagents that can request subagents give an unbounded tree. Add both.
- **Wait deadlock.** A blocking wait primitive plus Symphony's blocking approval loop can deadlock: a parent blocked in wait cannot answer the child's approval, and two work subagents can wait on each other's worktree. Need wait TTLs, cycle detection, and a rule that a waiting parent still services child approvals.
- **Worktree identity and runaway control.** Base-SHA and common-dir recovery is design, not code. Parallel merge-back semantics are unspecified. The process-group primitives in `AgentRuntime.ts` (`makeProvenGroupIdentity`, `captureProcessBirthToken`) exist and should back a hard wall-clock TTL that kills a runaway subagent tree.

## 9. Governance for a local-only product

Neokod is local-only. Each developer runs a loopback instance; there is no central server that can block a request. Governance here is defined as observability plus routing at the orchestrator command boundary, with a narrow set of hard blocks. The review lane sharpened this into two tiers that must be stated separately.

- **The human principal is trusted.** On a developer's own loopback box the developer is fully trusted, so point-of-action restriction against the human is theater. For the human, governance is visibility: the command boundary is the instrumentation point, every governed action emits a structured event (which agent, provider, ceiling, parent, output), and the organization governs by seeing the whole picture. This is what govern-not-restrict means for the human.
- **The agent principal is the real threat.** A prompt-injected agent reaching a dispatch channel is exactly what ceiling plus provenance at the owned command boundary defends against, and there it is real enforcement, not observation. The narrow fail-closed set (an agent self-approving its own approval, a credential leaking into a child, a subagent escalating its ceiling) is load-bearing and should be a first-class mechanism, not framed as an exception.
- **Org-mandated enforcement is a separate, opt-in surface.** A cooperating local client can stop cooperating, so true blocking for an organization requires a routing gateway that owns provider credentials and controls egress. That is a central control point and it does break local-first purity. Be explicit: real enforcement lives at an opt-in org gateway that owns credentials, is a separate product surface, and is not part of the local-first core. "Route, don't restrict" is the local default, and it must not become the excuse that neokod cannot offer enforcement to organizations that want it.

One correction the plan must carry: "the command boundary is the single point through which every dispatch flows" is not true today, because Symphony runs on the separate plane described in section 8. Before observability is called the governance mechanism, the interactive engine and the Symphony runner must be unified onto one boundary, or both must be explicitly instrumented. As it stands the governed flagship does not flow through the boundary the plan names.

Telemetry substrate: PostHog is in for rough usage stats. The direction is to enhance it into the governance telemetry layer, structured error logging and feature-usage events emitted from the command boundary as governed-action events, alongside a local durable audit log and optional forwarding to the org's AI-Orch endpoint. The same instrumentation serves product analytics and governance, because both answer the same question: what did the agents do.

## 10. What to keep, what to harvest, what to build

- Keep: neokod's event-sourced engine (decider, projector, reactors, event store), the merged #112 runtime-item lifecycle and #117 settings revisions, the provider registry, and Symphony.
- Harvest from v2 as new commands on neokod's engine: the execution-node tree, cohort coalescing, the immutable delegated-result pin, and the replay-safe versus process-bound effect classification.
- Keep from the Agent Gateway design: command-boundary privilege enforcement, server-stamped un-forgeable provenance, worktree-identity recovery, setup-script exclusion, ancestry authorization on read, wait, and interrupt.
- Build new: the canonical privilege lattice (precondition), the `/throw` flow and its project chain UI (near-term, standalone), the Symphony subagent-role model with the bounds in section 8, the governance telemetry substrate on the command boundary, and the routing integration with AI-Orch.

## 11. Sequencing and open questions

Near-term and independent of everything else: the privilege lattice, and `/throw` with its chain UI. Neither waits on any orchestration decision.

Then: harvest v2's ideas into neokod's engine as they prove out upstream, without adopting the engine. Decide the Symphony-plane question (re-platform onto the engine, or dual-instrument) before subagents, because it gates both the substrate and the single-boundary governance claim.

Open questions for the final review pass:

- The Symphony-plane decision. Re-platforming Symphony onto the orchestration engine is large and unscoped. Dual-instrumenting keeps two planes but delivers governance sooner. Which, and at what cost?
- The privilege lattice. What is the canonical order across the three vocabularies, and what is the narrowing function? This blocks subagents.
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

The single most important finding, unique to the Codex lane in round 1 and carried through every round. The loopback server has no application authentication by design. `POST /api/orchestration/dispatch` accepts the public client command union, and loopback authorization is a no-op. So an agent that can run local code (which children can, and full-access children certainly can) can skip the MCP capability model entirely and dispatch thread creation, full-access turns, or interrupts directly. The capability and delegation model is therefore advisory for a cooperating local agent, and the OS user boundary is the real one.

The spec's resolution, accepted as sound for a local-first product, was to take the advisory branch explicitly and do it honestly: `origin` and actor are stamped from a server-internal dispatch context, never from client-decodable command fields, and never inferred from a caller-controlled command-id prefix. The residual bypass is stated plainly rather than hidden behind a capability model that pretends to enforce what it cannot. The round-3 synthesis added one narrowing: capability-gate the genuinely dangerous commands (approval-response and checkpoint-revert) at the command boundary, because a prompt-injected agent could otherwise self-approve its own approval request or revert the workspace through the raw route, and approval-required is the gateway's own default safety posture. This self-approval gate is the direct ancestor of the "narrow fail-closed set" in section 9 of this plan.

This finding is why this plan insists on owning the command boundary (section 3) and stamping authority server-side rather than trusting agent-provided fields (section 4). Upstream's v2 has the same class of gap and did not resolve or acknowledge it.

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
