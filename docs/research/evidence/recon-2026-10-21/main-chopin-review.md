# Main review: Chopin fit for Neokod, 21 October 2026

Source pin: `githubnext/chopin` at `a55c9380c9c50aa16f2a794a119be1a2ce14b608`, also the peeled `cli-v0.0.18` tag. Research prototype, MIT. Source inspection only. See `chopin-source-manifest.json` for file hashes, release capture and bounded merged-PR coverage.

## Recommendation

Use Chopin as a planning and execution-contract reference after the locked core work. Keep Neokod's local Effect/event-sourced engine, ordinary Code thread and Symphony policy boundaries. A focused plan/decisions surface beside the conversation would complement the supplied execution graphs: plan explains intent, decisions capture unresolved choices, graph explains actual execution. A visual dependency node is not necessarily an agent.

## Mechanisms checked

1. `apps/server/src/tasks/graphs.ts:322` claims the current approved graph only when plan revision, graph revision and run binding match. `tasks/lifecycle.ts` handles ordered, idempotent progress. Ordinary execution requires graph verification before implementation settles; changed tasks must report an appropriate PR. The claim check is useful, but does not prove the human saw that exact graph. Main subsequently traced the Build caller after Opus highlighted it: `apps/web/src/build-model.ts:544-547`, `main.ts:1176` and `tasks/builds.ts:230-232` automatically draft/approve/start after the Build press. Do not describe that as separate human graph approval. Nor is verification independently executed: agent reports remain reports. Neokod must retain exact-head evidence and its own server validation/review gates.
2. `docs/decisions.md`, decision storage/prose descriptions and `apps/web/src/decision-view-control.tsx` separate drafts, saved human answers, reopening/history and unanswered counts. A saved answer can initiate a Planner turn. In Neokod, saving a decision may request plan revision, never implicitly approve execution or merge. ProposedPlanCard/PlanSidebar currently render/export plan text and are the first surfaces to extend; a durable decision system requires explicit contracts and persistence, not component-local state.
3. `packages/dialect/src/dialect.ts` and `validate.ts` use a bounded allowlist and parse/render untrusted MDX without compiling or evaluating it. Prefer Neokod's existing Markdown and owned diagram components initially. Do not embed arbitrary generated React/JSX or import an entire editor to show a workflow graph.
4. `docs/background-jobs.md`, `apps/server/src/jobs/runner.ts` and `research/publication.ts` separate target generation, claim generation, validation, immutable artifacts and fenced publication. Research becomes an attributed child document. Apply this as a review of W6's existing durable child result, cancellation and late-publication design; avoid a second job engine. A local file plus result receipt is sufficient before a richer research library.
5. `apps/connector/src/reconnect.ts`, `tasks/connector.ts` and builds model preserve run identity across reconnect with bounded reports/retries. The pending connector report queue is in memory, so do not call it crash-durable delivery. It is future own-machine reference material, not permission to add hosted machine pairing. Neokod must pin the user-selected environment/machine and preserve unknown/orphaned outcomes when process continuity cannot be proved.

## Important execution-mode difference

`apps/connector/src/implementation.ts` has an ordinary implementation prompt and a separate `liveImplementationPrompt`; `tasks/lifecycle.ts:66` explicitly marks live archived runs released without verification. LIVE_BUILD rebuilds can apply later plan edits. Do not borrow this automatic rebuild/approval behaviour for Neokod. Plan edits must invalidate the applicable approval/evidence; our configured repair budget and human/policy merge gate remain authoritative. The source also asks implementers for draft PRs and worktree cleanup; retain the owner's normal PR preference and preserve dirty work instead of copying those policies.

## Newest merged changes inspected

Selected PR file patches are preserved in `chopin-selected-pr-deltas.json`; source pin contains all five merge SHAs.

- #714: persisted human title ownership plus an active-renaming hold prevents Planner naming jobs from replacing a person's title. Borrow the ownership rule for any later plan editor, not its multiplayer presence implementation by default.
- #713 (with #709): restarted server waits ten minutes for the same machine's build, with a separate one-minute allowance after machine reconnect. This supersedes the older 90-second description. Same-machine/owner and active-run fencing matters more than the chosen timer value; do not add a Neokod grace-period knob speculatively.
- #712: saved decision answers feed the Planner and keep cards linked to prose. Treat source anchors, durable saves and stale-answer checks as a single contract. Do not use casual chat text as a resolved decision.
- #711: a launched workflow remains active until authoritative root termination. Activity can be idle between steps and arrive before/after lifecycle events. This reinforces Neokod's existing state-and-evidence policy; an empty child list or paused stage cannot prove root completion.

## Neokod destination and acceptance

Keep three bounded follow-ups in existing sequencing: planning/decision UX after ordinary managed children; approved-plan revision binding in Symphony D-1/D-3/D-4; reconnect/claim fencing review when saved owner machines resume. Add precise acceptance to canonical plan 16.9. None reopens Phase 1. Static review establishes possible fit only; no Chopin UI quality, recovery or performance was validated at runtime.

## Reconciliation with completed Opus review

Actual Copilot Opus 5.5 high, session `ses_ea049599affeKDWeTrysTrb8WM`, completed `opus-chopin-review.md`. Direct onboard Claude was tried first and hit its session limit; the owner-authorised fallback was used. Main verified the actual assistant metadata, not just the requested model.

Opus sharpened three important exclusions, and main traced their callers: Build can auto-approve the graph drafted after the button press; optional CONVERSATION_PLAN can record a resolution inferred from sourced member chat (`conversation-plan/event-lifecycle.ts:34-66`); and stop/disconnect may be reported as failed before the local process is confirmed stopped (`tasks/routes.ts`, `tasks/connector.ts`). These are not behaviours to port. The explicit saved-decision path is only one path through Chopin, not a universal guarantee.

Opus recommends exact source-plan/base/policy provenance, replay payload conflicts, and event-derived progress in existing W6/D slots. Main agrees, adding plan/decision UX only as a later enhancement to our existing components. Neokod's own source plan reference currently has only threadId/planId and plan text can change under the same id, so any future revision-pinning claim needs a real content digest and start-time check. Symphony attempt provenance likewise needs a captured base/workflow digest before the UI can claim it displays an immutable dispatch contract. These are future acceptance requirements, not completed fixes or new locked core cards.

The raw Opus report did not verify ancestry locally because the clone is shallow. Main separately checked GitHub compare results for #714/#713/#712/#711/#709 against the pinned release: all are ahead with behindBy zero. `chopin-build-inclusion.json` preserves that evidence. No independently labelled nightly or server/web release was found in the bounded release snapshot; do not interpret that as an exhaustive search of every channel.
