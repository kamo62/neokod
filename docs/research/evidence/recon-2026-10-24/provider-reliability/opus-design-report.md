# Design review, plan 16.19 (read-only, not source acceptance)

**Scope:** I read the root at `1eee19299` with the uncommitted 16.19 section of `plan.md`, plus `AGENTS.md`, `state-and-evidence.md`, the contracts, `decider`, both server projectors, ingestion, the command reactor, the session reconciler, the client reducer and the web lifecycle code. I also read the current diffs in all three worker trees, which are still changing. I made no edits and ran no build, install or browser commands.

**Verdict:** The approach holds in each lane, but the current diffs have five design-level blockers, listed below. The most important is that the visible "Completed after Stop" bug would survive the outcome lane as it is scoped now.

## A. Outcome seam (`neokod-turn-outcomes`)

**A1. Blocker: a fourth projection is outside every lane.** `packages/client-runtime/src/state/threadReducer.ts:288-330` has its own copy of `settledTurnStateForSessionStatus`. When you press Stop, `thread.turn-interrupt-requested` marks the turn `interrupted` straight away (lines 161-184). The next `thread.session-set` with `ready` then matches `sessionRunsTurn(thread.session, …)` and overwrites it with `completed`.

- So even with a correct server, the live Chrome banner will still say Completed until a reload pulls a fresh snapshot.
- **Constraint:** add `threadReducer.ts` and its test to the outcome lane. All three projections (in-memory projector, SQL `ProjectionPipeline`, client reducer) should call one pure resolver in `packages/shared`, not three copies plus the new `explicitSettledTurnState`. `contracts` must stay schema-only; `client-runtime` and `server` already depend on `@neokod/shared`.

**A2. Blocker: `null` has nowhere correct to land.**

- In the worker diff, `ProjectionPipeline` returns early on `null` and the projector leaves `latestTurn` unchanged, so the turn stays `running`.
  - `deriveThreadLifecycle` (`threadLifecycle.logic.ts:33-38`) then shows "working" forever.
  - A later non-streaming `thread.message-sent` (pipeline line 1334) or `thread.turn-diff-completed` (line 1415) then settles the turn as **`completed`**. Unknown becomes completed by another route.
- No emitter can produce `null` today:
  - `RuntimeTurnState` in `providerRuntime.ts:75` has no unknown value, so the worker's `runtimeTurnOutcome` default branch is unreachable.
  - A malformed parent Codex `turn/completed` emits nothing at all (`CodexAdapter.ts:999-1002`).
- **Constraint, pick one:**
  - **(a)** Add an `unknown` turn state to `OrchestrationLatestTurnState` and `ProjectionTurnState`. No migration is needed (`state TEXT`, no CHECK), and `deriveThreadLifecycle` already falls through to "Status unavailable". It does widen the lane to persistence plus about 10 consumers that typecheck will surface.
  - **(b) Recommended for a bounded checkpoint:** make the field `Schema.optional(OrchestrationLatestTurnOutcome)` with no `null`. Drop the unreachable default and record unknown-outcome landing as a follow-up.
- Don't ship a `null` branch that turns out to be a stuck-running turn.

**A3. Outcome needs its target turn: enforce it in the decider, not by dropping it silently.**

- **Constraint:** the decider rejects a `latestTurnOutcome` that arrives without `interruptedTurnId`.
- **Constraint:** ingestion attaches an outcome only when `endedTurnId !== undefined`.
- The worker diff attaches it to any `turn.completed`, even when there is no target. With the strict guard off, that gives an untargeted outcome that both projectors drop, so the turn stays running where it used to complete.
- `interruptedTurnId` stays identity only. It is already set on normal completions (`ProviderRuntimeIngestion.ts:1860`), which is correct.

**A4. Guard against delayed events reopening a turn: needed in both server projectors and the client.**

- SQL `ProjectionPipeline.ts:1228-1231` keeps only `completed`/`error`, so a late `running` session-set for the same turn id moves `interrupted` back to `running`.
- The in-memory projector (line 474) and the reducer reopen any terminal turn.
- After this change many more turns end up `interrupted`, so this hole will be hit more often.
- **Constraint:** a `running` session-set never reopens a terminal turn with the same id. An explicit outcome only settles its target while that target is `running`, and first terminal wins.
- **Open decision, root to make:** should an explicit `interrupted`/`error` be allowed to replace an _inferred_ `completed` on the same turn? That case arises if message-sent settled the turn first. Whatever you choose, all three projections must apply the same rule.

**A5. Non-target running turns.** With an explicit outcome, the worker's SQL filter now settles only the target, so other stale `running` rows stay running forever. Before this change they were settled as completed.

- **Constraint:** non-target running turns keep the old session-status inference.
- Record the remaining residuals as known gaps for this checkpoint, not as fixed:
  - the steering supersede (`ProjectionPipeline.ts:1205`) still settles the superseded turn as `completed`;
  - legacy-path emitters still infer completed: `ProviderCommandReactor` `setThreadSessionErrorOnTurnStartFailure` keeps `ready` (line 351) and `bindSessionToThread` maps restarts to `ready`, and `session.state.changed: ready` mid-turn behaves the same.

**A6. Keep "healthy session readiness" separate from runtime-item behaviour.** `turn.completed` with interrupted/cancelled correctly stays session `ready`.

- `processDomainEvent` and the domain filter (lines 2299-2306, 2477) key `closeItemsOfSettledSession` on session status `interrupted`. That path does not fire for ready-plus-interrupted; turn-boundary closure from `runtimeEventToItemsClosure` covers it. A test should pin that.
- Startup reconcile (lines 2414-2445) treats an `interrupted` turn as `terminationGuaranteed: false`, so active runtime items it finds there will be **orphaned**, not completed, after a restart. That is more correct, but it changes behaviour, and tests should state it explicitly.

**A7. Small points:**

- Make `runtimeTurnOutcome` take the typed `RuntimeTurnState` with an exhaustive switch, not `string`.
- Copilot (`aborted ? "cancelled"`), Codex (`toTurnStatus`) and OpenCode/Kiro already emit interrupted/cancelled states, so the loss really does happen in ingestion and the projections.

## B. Detection (`neokod-provider-detection`)

**B1. Blocker: `Effect.yieldNow` does not guarantee the subscription is in place.**

- `providerRegistry.streamChanges` is `Stream.fromPubSub`, which subscribes lazily. It is wrapped in `Stream.debounce` and two `Stream.merge`s, each of which forks fibers.
- One yield does not ensure all three subscriptions exist before `refresh` or the snapshot runs.
- The repo documents this exact race and its fix in `ProviderRegistry.ts:630-662`: acquire with `subscribeChanges`, then `Stream.fromSubscription`.
- The new test publishes after a `Deferred.await`, which already yields many times, so it passes without proving the race is closed.
- **Constraint:** expose scoped `subscribeChanges` on the provider registry, at minimum; settings and keybindings can follow. Acquire those subscriptions in the RPC scope before `refresh` and `loadServerConfig`. This means adding `ProviderRegistry.ts` (and its `Services` shape) to the detection lane.
- The test should publish synchronously right after the stream is constructed, with no intervening await.

**B2. The buffer's ordering is sound.** It keeps every post-subscription update in order, and provider statuses replace the full list, so replaying them after the snapshot is idempotent. That part needs no change.

**B3. 401/403 classification is still by substring.** The worker adds `(status=401)` to the detail text, and `OpenCodeProvider.ts:88-91` classifies by matching `"401"` anywhere in the lowercased text, which is fragile against URLs, ports and ids.

- **Preferred:** pass the structured status (from the worker's `readHttpStatus`) to `formatOpenCodeProbeError`. That needs `OpenCodeProvider.ts` in the lane; otherwise mark it as a known limit.
- This only applies to external OpenCode servers, and OpenCode 2.0.32 is refused before spawn anyway. It does not explain the owner's issue with the three main providers.

## C. Native orchestration (`neokod-native-orchestration`)

**C1. Cover `subAgentActivity` on both `item/started` and `item/completed`.**

- The session runtime's lineage records the child on both notifications, but the adapter emits `task.started` only on `item/started`.
- A `subAgentActivity` that only completes falls through to the generic `mapItemLifecycle`. That risks a stray parent-timeline `item.completed` and no task card.
- **Constraint:** handle both, suppress the generic item lifecycle for this type, and build the eventId from `agentThreadId` rather than `event.id`. That way start and completion, or a collab spawn of the same child, cannot produce duplicate `task.started` rows.
- Decode with the generated union (`V2Item…Notification`) instead of raw `typeof` probing.

**C2. Handle `kind` correctly.** The schema allows `started | interacted | interrupted`.

- `interrupted` is the parent's interrupt intent, not a confirmed child end. Map it to progress or leave the card open; the authoritative terminal is the child's `turn/aborted` or `turn/completed`.
- This also keeps parent Stop from cascading into the children (W6 is not reopened).

**C3. Child `turn/completed` no longer suppressed: acceptable, but pin it with a test.** The typed handler (`CodexSessionRuntime.ts:939-955`) only skips when `providerThreadId` is already set. If a child completion arrives before the parent thread id is known, it could mark the parent session `ready`. Add a regression test for that ordering. Returning nothing for a malformed child completion matches plan item 4.

**C4. The dismiss predicate still hides real stopped workers that have no content.** That conflicts with the plan's "preserve real empty cards" and with the Stop-race check, which expects two real cards after Stop.

- **Constraint:** never auto-hide a card that has provider `task.started` evidence. Leave hiding to explicit user dismissal, or base it on provenance, not on `status === "stopped"`.

## D. Lane changes the root must approve

| Lane      | Add                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome   | `packages/client-runtime/src/state/threadReducer.ts` and its test; one new `packages/shared` resolver module. Under option A2(a), also `persistence/Services/ProjectionTurns.ts`. |
| Detection | `provider/Layers/ProviderRegistry.ts` and its service shape; optionally `OpenCodeProvider.ts`.                                                                                    |
| Native    | none                                                                                                                                                                              |

## Minimum regression tests, beyond what the lanes already list

- **Same turn sequence through all three projections:** interrupt request → `turn.completed: interrupted` → final assistant message → late checkpoint. All three must end `interrupted`, never `completed`.
- **Delayed events:**
  - a late `running` session-set for an already `interrupted` turn does not reopen it;
  - a late outcome for an old turn while a new turn is running leaves the new turn untouched.
- **Decider:** rejects an outcome that has no target turn.
- **Old event-store replay:** events without the field still project exactly as before.
- **Detection:** a status published synchronously, before the snapshot, still reaches the client.
- **Codex children:**
  - a `subAgentActivity` that only completes still creates exactly one card;
  - an early child completion before the parent thread id is known does not change the parent session.

No source is accepted yet. I could not write the plan file because no write tool was available in this session, so the full review is in this message.
