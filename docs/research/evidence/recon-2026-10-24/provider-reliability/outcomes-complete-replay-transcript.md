I'll start by reading the required documentation and tracing the actual code paths.Now I'll implement the contract change.Implemented the owned scope. No commits, builds, installs, deployment, or process signals were used.

## Changed

- `packages/contracts/src/orchestration.ts`
  - Added `OrchestrationLatestTurnOutcome` (`completed | interrupted | error`).
  - Added optional `latestTurnOutcome: OrchestrationLatestTurnOutcome | null` to `thread.session.set` and `thread.session-set`. Omitted remains legacy inference; explicit `null` is unknown.
- `apps/server/src/orchestration/decider.ts`
  - Forwards explicit value and explicit `null`; omitted stays omitted.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
  - Added `runtimeTurnOutcome`, separate from `normalizeRuntimeTurnState`.
  - `turn.completed` now emits `completed` for `completed`, `error` for `failed`, `interrupted` for `interrupted`/`cancelled`, and explicit `null` for unknown/malformed state. Session status still returns to `ready`; the session is never marked interrupted to show an interrupted turn.
  - Existing `normalizeRuntimeTurnState` default is unchanged deliberately for session-status handling.
- `apps/server/src/orchestration/projector.ts`
  - Explicit outcome is applied only to the turn named by `interruptedTurnId` and only while that turn is still running. Explicit `null` does not settle or infer completion. Late outcomes for older turns cannot settle newer work.
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
  - Same scoped-target rule for SQL turn rows and settlements. Explicit `null` records no settlement; legacy omission keeps the existing all-running-turn behaviour and timestamps.

## Regressions added

- Contracts schema, explicit value, explicit `null`, omission, and rejection of `"running"`.
- Ingestion through the real engine, decider, projection pipeline and snapshot query:
  - `turn.completed` interrupted, session `ready`, latest turn `interrupted`.
  - Confirmed completion, session `ready`, latest turn `completed`.
  - Emitted `thread.session-set` carries `latestTurnOutcome: "interrupted"`.
  - Unknown runtime state emits explicit `null` and does not become `completed`.
- Pure projector: explicit outcome precedence, delayed old outcome not settling newer work, explicit `null` not inferring completion, and the existing legacy ready-to-completed test remains unchanged.
- SQL projection: an explicit interrupted outcome settles only its named old turn; a newer running turn and its settlement state remain untouched.

`decider.test.ts` does not exist in this base. I did not create a new per-function suite; decider forwarding is covered end to end by the ingestion regression, which reads the persisted `thread.session-set` payload.

## Verification

- `vp test run` on the four affected files: **146 passed**, files: contracts 38, projector 14, projection pipeline 30, ingestion 64.
- `vp check`: **0 errors, 54 pre-existing warnings**.
- `vp run typecheck`: passed across all **10 packages**.
- `git diff --check`: clean.

Environment note: this checkout's `apps/server/node_modules` symlink resolved `@neokod/contracts` to the separate `neokod-core-execution` worktree. To exercise the changed contract against server tests I temporarily rebound `apps/server/node_modules` to a local test-only link structure, then restored the original symlink exactly. Root should ensure integration dependency links resolve to the reviewed contracts source.

## Limitation / integration blocker outside my ownership

`packages/client-runtime/src/state/threadReducer.ts` still infers `completed` from a `ready` session for `thread.session-set` and does not consume `latestTurnOutcome`. The live thread stream applies that reducer directly, so the run banner can still display Completed until a later snapshot replaces the cached thread. The server and pure projector now carry the correct evidence, but end-to-end UI acceptance requires that reducer and its test to apply the same explicit-outcome and `interruptedTurnId` rules. I did not edit it because it is outside the exclusive file list.I'll read the review reports and current state first.Implemented the ROOT FINAL DECISIONS across the expanded allowlist. No commits, builds, installs, lockfile changes, migrations, deployment, or signals.

## Contract and resolver

- `packages/contracts/src/orchestration.ts` / test
  - `latestTurnOutcome` is now `Schema.optional(OrchestrationLatestTurnOutcome)` with known values only: `completed | interrupted | error`.
  - Explicit `null`, `running`, and unknown values are rejected by both command and payload schemas.
  - Omitted still preserves legacy session-status inference.
- `packages/shared/src/orchestrationTurnOutcome.ts` / `packages/shared/package.json`
  - Added one shared resolver module for legacy inference, explicit outcome targeting, terminal-state checks, and session identity retention.
  - `ProjectionPipeline`, server `projector`, and client `threadReducer` now consume the same policy.

## Server behaviour

- `decider.ts`
  - Rejects `latestTurnOutcome` without `interruptedTurnId` using `OrchestrationCommandInvariantError`.
  - Forwards a present outcome and preserves omission.
- `ProviderRuntimeIngestion.ts`
  - Exhaustive typed mapping: `completed -> completed`, `failed -> error`, `interrupted/cancelled -> interrupted`.
  - Attaches the outcome only when `endedTurnId` is known.
  - No null outcome path and no new fallback.
- `projector.ts`
  - Explicit outcome settles only its pinned turn.
  - Delayed old-target updates no longer replace a newer running session or latest turn.
  - Late running events cannot reopen a terminal turn.
  - Late checkpoints preserve terminal state and authoritative closure time.
- `Layers/ProjectionPipeline.ts`
  - SQL session upsert is identity-guarded.
  - Explicit outcomes settle only the named historical row, including correcting an inferred `completed` to authoritative `interrupted`/`error`.
  - Other running rows are not broadly settled when the outcome is explicit.
  - Late running session updates preserve terminal rows.
  - Final messages and checkpoints preserve terminal state and closure time.

## Client behaviour

- `packages/client-runtime/src/state/threadReducer.ts` / test
  - Live session updates now use the same resolver and session identity guard.
  - Ready no longer overwrites an interrupted outcome.
  - Same-target inferred completion is corrected by authoritative interrupted/error.
  - Late running and late checkpoint events preserve terminal state and time.

## Regressions

Added or extended focused coverage for:

- Interrupted and cancelled turns returning the session to `ready` while the turn stays `interrupted`.
- Confirmed successful completion.
- Failed mapping to `error`.
- Decider rejection of an outcome without a target turn, plus successful forwarding.
- Delayed old-target outcome preserving both the newer session and turn in SQL, pure projection, and the client reducer.
- Message-first inferred completion corrected by authoritative interrupted outcome.
- Final message plus late checkpoint preserving interrupted state and authoritative time.
- Late running session-set not reopening a terminal turn.
- Schema rejection of `null`/unknown outcomes.
- Existing explicit-null completion timestamp and omitted legacy replay tests remain passing.

## Verification

- Focused six-file run: **194 tests passed**.
  - contracts 38, decider 1, projector 14, projection pipeline 31, ingestion 64, client reducer 46.
- `vp check`: **0 errors, 54 pre-existing warnings**.
- Recursive `vp run typecheck`: passed across **10 packages**.
- `git diff --check` and targeted `vp fmt --check`: clean.

Environment note: `apps/server`, `packages/client-runtime`, and `packages/shared` had `node_modules` symlinks resolving workspace packages to `neokod-core-execution`. I temporarily rebound those three links to this checkout for tests/typecheck, then restored the original symlinks exactly. No tracked files or lockfiles were changed by that.

## Remaining limits

- No durable unknown-outcome state exists, as directed. Malformed provider values are handled at provider adapters; this patch does not introduce a null or unknown persistence path.
- If a Stop request is optimistically shown as interrupted and the turn later completes with no intervening running/message evidence, the client reducer keeps the first terminal state. Fixing that ambiguity needs provenance and was explicitly out of scope.
- When a message-first inferred completion is later corrected, the durable turn row and live latest turn use the authoritative terminal time, but the first settlement outbox row keeps its first-wins time. No new provenance or storage was invented.
- No live Chrome/provider proof was run.Implemented the three required late-event corrections within the existing allowlist. No new provenance, migration, dependency, or build/install work.

## Corrections

1. **Late client messages no longer reopen a confirmed terminal turn**
   - `packages/client-runtime/src/state/threadReducer.ts`
   - A same-turn streaming or final assistant message preserves the settled state and completion time when the session no longer runs that turn.
   - Provisional Stop still resumes to `running` while the session still runs the same turn, so the existing provisional-Stop/resumed-stream regression remains valid.

2. **Late same-ID running updates no longer reopen session or lifecycle**
   - `packages/shared/src/orchestrationTurnOutcome.ts`
   - `shouldApplySessionUpdate` now receives current turn identity evidence.
   - A running update for an already terminal turn is rejected when the current session has left that turn.
   - New turn IDs remain admissible.
   - Applied consistently in SQL session upsert, server pure projector, and client reducer.
   - Extended tests assert preserved session status, active turn ID, and following message state, not just latest-turn state.

3. **Late checkpoints preserve the newer latest-turn pointer**
   - Added shared `shouldReplaceLatestTurnPointer`.
   - SQL `projection_threads.latest_turn_id` no longer moves to an older checkpoint turn when a different latest turn is already known.
   - Pure projector and client reducer use the same rule.
   - Historical checkpoint metadata and the historical turn row still update.
   - Tests cover a late checkpoint for old turn A while newer turn B is running, then again after B settles, asserting latest identity and session at both stages.

## Verification

- Focused six-file run: **194 tests passed** across contracts, decider, projector, projection pipeline, ingestion, and client reducer.
- Extended three-file run after final test edits: **91 passed**.
- Recursive `vp run typecheck`: passed across **10 packages**.
- `vp check`: **0 errors, 54 pre-existing warnings**.
- Targeted `vp fmt --check`: clean.
- `git diff --check`: clean.

As before, tests and typecheck used temporary local workspace links so `@neokod/contracts`, `@neokod/shared`, and `@neokod/client-runtime` resolved to this worktree. The original dependency symlinks were restored exactly afterward.

## Remaining limits

- Pure projector and client reducer can identify a late running update for a terminal turn while that turn is still the latest. If the latest pointer has already moved to a newer turn, they lack a durable historical terminal-state lookup for the old ID; SQL can use the turn row. This is an evidence limitation, not invented storage.
- Settlement outbox remains first-write-wins, so a later authoritative correction updates the turn row and live latest turn but does not retract an already recorded settlement timestamp.
- No live provider, browser, installed-desktop, or restart acceptance was run.Implemented both Opus blockers on top of the late-event corrections. No provenance, migration, dependency, or contract changes.

## Blocker 1: provisional Stop in the live client

`packages/client-runtime/src/state/threadReducer.ts`

- A latest turn that looks `interrupted` while the current session still runs that same turn is now treated as provisional.
- Explicit outcomes are resolved against a `running` identity in that case.
- Failed-Stop running updates are no longer blocked by the terminal-state guard.
- Authoritative interrupted/completed outcomes transition the provisional turn normally and use the first authoritative session time.

Added client regressions:

- Stop then authoritative `completed` ends `completed`.
- Stop then authoritative `interrupted` ends `interrupted` at the session time, not the Stop request time.
- Failed Stop then a running update for the same turn reopens it as `running`.

## Blocker 2: immutable settlement timestamp

When a turn is already settled, all three projections now change only its state and preserve its existing `completedAt`, including explicit `null`.

- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
  - The SQL turn row keeps its existing timestamp for correction or repeated terminal outcomes.
  - The settlement outbox is still first-write-wins.
  - The settlement row now uses the same preserved timestamp as the turn row.
- `apps/server/src/orchestration/projector.ts`
  - Live latest-turn correction preserves the settled timestamp.
- `packages/client-runtime/src/state/threadReducer.ts`
  - Correction and repeated outcomes preserve the settled timestamp.
  - Provisional Stop is excluded so its first authoritative transition still uses session time.

Updated regressions:

- Inferred `completed` corrected to `interrupted` now keeps the inferred completion time in SQL, pure projector, and client.
- Repeated authoritative terminal outcomes do not rewrite that time.
- SQL now asserts turn-row timestamp equals settlement-row timestamp.
- SQL reload re-projects and asserts the same turn and settlement timestamps.
- Late messages, checkpoints, and running updates continue to preserve the settled time.
- Explicit nullable `latestTurnCompletedAt` behavior remains unchanged.

## Verification

- Focused six-file run: **197 tests passed** across contracts, decider, projector, projection pipeline, ingestion, and client reducer.
- Recursive `vp run typecheck`: passed across **10 packages**.
- `vp check`: **0 errors, 54 pre-existing warnings**.
- `git diff --check`: clean.
- Worker-local dependency links were used for contracts/shared/client-runtime during tests and typecheck, then restored exactly to the original `neokod-core-execution` targets.

## Remaining limits

- Settlement outbox remains first-write-wins. This patch makes the turn row, live latest turn, published settlement event, and reload agree with the first settlement time; it does not move or retract an already recorded outbox time.
- The provisional-Stop distinction relies on the current session still running the same turn, which is the existing evidence available in the client. No new provenance was added.
- No live provider, browser, installed-desktop, or restart proof was run.Applied the remaining SQL late-event consistency fix on top of `9874ed395`. Only two files changed.

## SQL admissibility

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`

- Extracted `appliesSessionSetEvent` as the shared session-update admissibility check.
- Added `appliesRunningSessionSetEvent` for late running-update rejection.
- Applied it before side effects in:
  - thread session upsert;
  - thread latest-turn pointer update;
  - turn running/supersession logic;
  - pending-start consumption;
  - turn settlement and settlement outbox writes.
- Explicit outcomes for an old target still settle their pinned historical row while the session and latest pointer remain on newer work.
- Legitimate unseen turn IDs remain admissible.

## Bootstrap consistency

- Replaced per-projector whole-history catch-up with event-ordered replay across projectors.
- Each projector still tracks its own `last_applied_sequence` and only applies unseen events.
- For each event, all required projectors have the state from previous events, so admissibility does not depend on which projector finished its entire history first.
- Existing projector resume/bootstrap tests continue to pass.

## Regression coverage

Extended the A/B SQL sequence regression with a delayed legacy running update for terminal turn A while newer B is running, asserting:

- B turn remains `running`;
- session remains `running` on B;
- latest-turn pointer remains B;
- B pending start remains `pending`;
- no false B settlement row is created;
- A remains the historical interrupted turn.

Added a bootstrap regression that appends this exact ordering to the event store, replays it through `bootstrap`, and asserts the same turn, session, pointer, pending-start, and settlement results.

## Verification

- Focused six-file run: **198 tests passed**.
- Projection pipeline file alone: **32 passed**.
- Recursive `vp run typecheck`: passed across **10 packages**.
- `vp check`: **0 errors, 54 pre-existing warnings**.
- `git diff --check`: clean.
- Worker-local dependency links resolved contracts/shared/client-runtime to this worktree during tests and typecheck, then were restored exactly.

## Remaining limits

- Pure projector and client reducer still cannot identify a delayed running update for a historical terminal turn once the latest pointer has moved beyond it. SQL now has and uses the turn-row evidence.
- Settlement outbox remains first-write-wins; authoritative time is not retracted or moved.
- No live provider, browser, installed-desktop, restart, build, install, commit, or push proof was produced.Applied the independent-offset bootstrap correction in the two owned SQL files only. No storage, migration, dependency, or shared-contract changes.

## As-of-event admissibility

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`

- Added a projector context flag for independent catch-up when a dependent session/turn projector is ahead of the event being replayed.
- In that catch-up case, a persisted terminal turn whose `completedAt` is later than the replayed event is evaluated as the running identity it had at that event. It is not rejected using future terminal evidence.
- A truly late running event after settlement still fails the guard.
- Live `projectEvent` always uses `allowHistoricalTerminalEvidence: false`, so this cannot admit an old-delivery event and move the live session or pointer backwards.
- The admission result is applied before session upsert, latest-pointer assignment, supersession, turn upsert, pending-start consumption, and settlement writes.
- Events with explicit old-target outcomes still settle their pinned historical row without changing the newer session or pointer.
- Legitimate unseen turn IDs remain admissible.

Bootstrap now computes the flag only when a dependent session or turn projector has already advanced beyond the replayed event. Full replay from zero therefore behaves the same as normal live ordering, while a lagging projector can catch up against future rows without misreading them as already-terminal evidence.

## Regression coverage

Extended the existing bootstrap regression with an independently advanced case:

- full replay first records the expected latest identity;
- sessions and turns remain advanced through the terminal old turn;
- the threads projector offset is rewound to just after thread creation;
- the pointer is cleared;
- bootstrap replays the original running event against future terminal session/turn rows;
- the final latest identity matches full replay, with the terminal turn and ready session preserved.

The existing A/B bootstrap case remains and still asserts:

- B stays running;
- B session binding stays active;
- latest pointer stays B;
- B pending start is not consumed;
- no false B settlement;
- delayed running A does not supersede B.

## Verification

- Focused six-file run: **198 tests passed**.
- Projection pipeline alone: **32 passed**.
- Recursive `vp run typecheck`: passed across **10 packages**.
- `vp check`: **0 errors, 54 pre-existing warnings**.
- `git diff --check`: clean.
- Local dependency links were used for this worktree during tests/typecheck and restored exactly.

## Remaining limits

- As-of bootstrap evidence uses the persisted turn completion timestamp. A terminal turn with an explicit `null` completion time cannot be distinguished from a late running event during independent catch-up, so that case conservatively rejects the running update. Fixing it would require additional sequence/provenance evidence.
- Pure and client projections still lack historical terminal identity once the latest pointer has advanced beyond the old turn.
- No live provider, browser, installed-desktop, restart, build, install, commit, or push proof was produced.Removed the timestamp heuristic entirely and replaced it with an enforced replay invariant in the two owned SQL files. No commit.

## Replay invariant

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`

- Bootstrap now validates persisted projector cursors before reading or applying any event.
- Accepted shapes are only those the pipeline can create:
  - all cursors at the same sequence; or
  - non-increasing cursors across projector order with a maximum one-event gap, meaning earlier projectors at N and later projectors at N-1.
- Any other skew fails with a typed `PersistenceSqlError`:
  - operation: `ProjectionPipeline.bootstrap:projector-coordination`
  - message states dependent projections require coordinated recovery and includes the full cursor summary.
- The error is raised before any projection rows, offsets, pointers, pending starts, or settlements are written.
- No rows or cursors are automatically cleared, reset, or rewound.
- The error explains the restoration path: clear and reset the coupled `projection.thread-sessions`, `projection.thread-turns`, and `projection.threads` group, plus any other projector outside the allowed interruption prefix, then restart to rebuild from the event store.
- Removed the occurredAt/completedAt heuristic and its context plumbing. Explicit-null, same-millisecond, clock-skew, and late-arrival timestamps are no longer treated as ordering authority.
- Event-ordered replay remains for the supported partial-interruption shape.

## Regression coverage

Extended the existing bootstrap test:

- Full replay still produces the expected A/B, pending-start, session, pointer, and no-false-settlement result.
- Supported partial interruption, sessions/turns at N and threads at N-1, bootstraps successfully and advances the lagging cursor.
- Unsupported skew, sessions/turns at N and threads at N-2, is refused with the typed error.
- After refusal, the test asserts unchanged rows and cursors: latest pointer remains null, session remains ready, terminal turn remains interrupted, and all three projector cursors remain exactly as set.

## Verification

- Focused six-file run: **198 tests passed**.
- Projection pipeline alone: **32 passed**.
- Recursive `vp run typecheck`: passed across **10 packages**.
- `vp check`: **0 errors, 54 pre-existing warnings**.
- `git diff --check`: clean.
- Worker-local dependency links were used during tests/typecheck and restored exactly afterward.

## Remaining limits

- Unsupported cursor skew now requires explicit coordinated recovery. The pipeline deliberately does not repair it automatically.
- Introducing a new projector whose persisted cursor is far behind while others are current would be refused under the same conservative invariant.
- Pure and client projections still lack historical terminal identity after the latest pointer advances.
- No live provider, browser, installed-desktop, restart, build, install, commit, or push proof was produced.Wording-only correction applied. Tree left frozen with one modified file.

## Exact diff

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`

```diff
@@ -1909,16 +1909,11 @@ const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjecti
         const cursorSummary = states
           .map((state) => `${state.projector.name}=${state.lastAppliedSequence}`)
           .join(", ");
-        const coordinatedProjectors = [
-          ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
-          ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
-          ORCHESTRATION_PROJECTOR_NAMES.threads,
-        ].join(", ");
         return yield* new PersistenceSqlError({
           operation: "ProjectionPipeline.bootstrap:projector-coordination",
           detail:
             `Dependent projections require coordinated recovery (${cursorSummary}). ` +
-            `Clear and reset the persisted projection rows and last_applied_sequence for the coupled ${coordinatedProjectors} group, and for any other projector outside the single allowed interruption prefix, then restart to rebuild from the event store. No automatic reset was performed.`,
+            "Unsupported projection cursor skew requires investigation. Preserve the database, event store and attachments; take backups and use a separately validated coordinated recovery procedure rather than assuming row deletion or cursor resets are safe. No automated reset or recovery was attempted.",
         });
       }
       const replayFrom = minimumOffset;
```

The typed operation, cursor summary, refusal before side effects, and no-automatic-reset guarantee remain. The unsafe clear/reset/restart recipe is gone.

## Checks

- Affected existing pipeline test only: **32 passed**.
- `git diff --check`: clean.
- Local dependency link restored exactly after the test.

No broad test/typecheck rerun, build, install, commit, push, or process signal.Implemented the legacy upgrade compatibility correction in the two owned SQL files.

## Exact production diff

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`

```diff
-    // Replay events once in order only when persisted projector cursors match
-    // the single partial-interruption shape this pipeline creates: all equal,
-    // or a non-increasing prefix at N and suffix at N-1 in projector order.
-    // Any other skew is rejected before projection side effects because the
-    // coupled session, turn and thread projections cannot safely rebuild
-    // independently against each other's future rows.
+    // Replay events once in order. The coupled session, turn and thread
+    // projections must share one as-of boundary: their cursors may be equal or
+    // form the single partial-interruption shape this pipeline creates, a
+    // non-increasing prefix at N and suffix at N-1. Other projectors may catch
+    // up independently, including a newly introduced projector at cursor zero.
+    // Unsupported skew inside the coupled group is rejected before side effects.
...
-      const offsets = states.map((state) => state.lastAppliedSequence);
-      const maximumOffset = Math.max(...offsets);
-      const minimumOffset = Math.min(...offsets);
-      const offsetsAreOrdered = offsets.every(
-        (offset, index) => index === 0 || offsets[index - 1]! >= offset,
+      const coupledProjectorNames = new Set<ProjectorName>([
+        ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
+        ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
+        ORCHESTRATION_PROJECTOR_NAMES.threads,
+      ]);
+      const coupledStates = states.filter((state) =>
+        coupledProjectorNames.has(state.projector.name),
+      );
+      const coupledOffsets = coupledStates.map((state) => state.lastAppliedSequence);
+      const maximumOffset = Math.max(...coupledOffsets);
+      const minimumOffset = Math.min(...coupledOffsets);
+      const offsetsAreOrdered = coupledOffsets.every(
+        (offset, index) => index === 0 || coupledOffsets[index - 1]! >= offset,
       );
       if (!offsetsAreOrdered || maximumOffset - minimumOffset > 1) {
-        const cursorSummary = states
+        const cursorSummary = coupledStates
...
-      const replayFrom = minimumOffset;
+      const replayFrom = Math.min(...states.map((state) => state.lastAppliedSequence));
```

Test file: `+302` lines, adding the legacy runtime-item cursor-zero regression and restoring a supported cursor shape after the refusal fixture.

## Proof

New regression: `replays legacy runtime items from cursor zero without disturbing coupled projections`

- Appends eleven events covering two turns, two runtime items, a revert that removes the second item/turn, and a pending turn start.
- Full ordered replay establishes the reference state.
- Simulates migration 040’s actual upgrade shape by setting only `projection.runtime-items` to cursor zero while every other projector remains current.
- Replays again and asserts the complete final state is unchanged:
  - runtime item rows;
  - session status/active turn;
  - turn rows and checkpoint counts;
  - latest-turn pointer;
  - pending start;
  - settlement rows.
- Asserts the runtime-items cursor catches up to the final event.

Retained existing bootstrap coverage:

- Full replay.
- Supported sessions/turns at N, threads at N-1 catch-up.
- Unsupported coupled-group skew refused with `PersistenceSqlError`, unchanged rows and cursors.
- A/B running state, session binding, latest pointer, pending start, and no false B settlement.

The coupled group is still validated in actual projector order before any replay side effect. Unrelated projectors, including legacy `runtimeItems` at zero, now catch up independently.

## Checks

- `ProjectionPipeline.test.ts`: **33 passed**.
- Runtime-item and migration checks: **30 passed** across `ProjectionRuntimeItems.test.ts`, `RuntimeItemProjection.test.ts`, `Migrations.test.ts`, `decider.runtimeItems.test.ts`.
- `git diff --check`: clean.
- Worker-local dependency links restored exactly afterward.

## Limitations

- `runtimeItems` remains a read dependency of the thread-shell projector for worker counts. A runtime-items-only catch-up does not itself recompute existing thread shell summaries; they refresh on a later thread event. No row, pending, pointer, settlement, session, or turn corruption was observed or asserted otherwise.
- Runtime-item revert replay was verified against normal ordered history. An adversarial future turn-checkpoint mutation could theoretically change its turn-retention input; no such case is claimed or introduced here.
- Unsupported skew inside sessions/turns/threads still requires explicit investigation and coordinated recovery; no automatic reset is provided.
- No build, install, provider run, process signal, commit, push, root check, or recursive typecheck was run.Committed only the two task-owned files. Working tree is clean and the commit was not pushed.

Commit: `5d91f949a fix: replay legacy runtime item projections [skip ci]`

```text
 apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts | 325 +++++++++++++++++++++
 apps/server/src/orchestration/Layers/ProjectionPipeline.ts       |  34 ++-
 2 files changed, 346 insertions(+), 13 deletions(-)
```

## Exact production diff

```diff
@@ -1881,12 +1881,12 @@
-    // Replay events once in order only when persisted projector cursors match
-    // the single partial-interruption shape this pipeline creates: all equal,
-    // or a non-increasing prefix at N and suffix at N-1 in projector order.
-    // Any other skew is rejected before projection side effects because the
-    // coupled session, turn and thread projections cannot safely rebuild
-    // independently against each other's future rows.
+    // Replay events once in order. The coupled session, turn and thread
+    // projections must share one as-of boundary: their cursors may be equal or
+    // form the single partial-interruption shape this pipeline creates, a
+    // non-increasing prefix at N and suffix at N-1. Other projectors may catch
+    // up independently, including a newly introduced projector at cursor zero.
+    // Unsupported skew inside the coupled group is rejected before side effects.
@@
-      const offsets = states.map((state) => state.lastAppliedSequence);
-      const maximumOffset = Math.max(...offsets);
-      const minimumOffset = Math.min(...offsets);
-      const offsetsAreOrdered = offsets.every(
-        (offset, index) => index === 0 || offsets[index - 1]! >= offset,
+      const coupledProjectorNames = new Set<ProjectorName>([
+        ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
+        ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
+        ORCHESTRATION_PROJECTOR_NAMES.threads,
+      ]);
+      const coupledStates = states.filter((state) =>
+        coupledProjectorNames.has(state.projector.name),
+      );
+      const coupledOffsets = coupledStates.map((state) => state.lastAppliedSequence);
+      const maximumOffset = Math.max(...coupledOffsets);
+      const minimumOffset = Math.min(...coupledOffsets);
+      const offsetsAreOrdered = coupledOffsets.every(
+        (offset, index) => index === 0 || coupledOffsets[index - 1]! >= offset,
       );
       if (!offsetsAreOrdered || maximumOffset - minimumOffset > 1) {
-        const cursorSummary = states
+        const cursorSummary = coupledStates
@@
-      const replayFrom = minimumOffset;
+      const replayFrom = Math.min(...states.map((state) => state.lastAppliedSequence));
```

The error operation and message are unchanged. Only the coupled sessions/turns/threads group is validated. Unrelated projectors can catch up independently, including `runtimeItems` at cursor zero.

## Test proof

The existing regression now covers both migration shapes:

1. **Retained runtime-item rows with cursor zero**
   - All other projectors remain current.
   - Runtime-items alone reaches the final cursor.
   - Full state remains identical to the full-replay reference.

2. **Migration 040 empty runtime-item table**
   - Fixture-only deletion of this thread’s runtime-item rows, plus cursor zero.
   - Confirms the table is empty before replay.
   - Bootstrap reconstructs the rows.
   - Final runtime items, session, turns, latest pointer, pending start, and settlement rows deep-equal the full-replay reference.
   - Runtime-items cursor advances to the last event.

The regression includes two turns, two runtime items, a revert that removes the second turn/item, and a pending turn start after the revert.

## Checks

- `ProjectionPipeline.test.ts`: **33 passed**
- `ProjectionRuntimeItems.test.ts`, `RuntimeItemProjection.test.ts`, `Migrations.test.ts`, `decider.runtimeItems.test.ts`: **30 passed**
- Changed files formatted; `git diff --check` clean before commit.
- Worker-local dependency links restored exactly afterward.
- No build, install, deploy, provider run, process signal, push, root `vp check`, or recursive typecheck was run.

## Residual risks

- On `thread.reverted`, the runtime-items projector derives retained turn IDs from current turn rows. A runtime-items-only catch-up therefore uses the final turn state, not the historical as-of state. Normal monotonic checkpoint history matched full replay in the regression. A later mutation of checkpoint counts/rows in a way that changes the historical retained set could still diverge.
- The threads projector reads runtime-item rows when deriving shell worker counts. A runtime-items-only catch-up rebuilds the rows and cursor but does not itself recompute existing thread shell worker counts; those refresh on a later thread event.
- These are derived-view risks, not observed corruption in the tested upgrade shape. No additional weakened guard or speculative recovery was added.Committed the catch-up cap fix in the two owned paths only. No push, build, install, deploy, provider action, or process signal.

Commit: `886c49aa3 fix: replay projection catch-up beyond event page cap [skip ci]`

```text
 .../Layers/ProjectionPipeline.test.ts | 287 +++++++++++++++++++++
 .../spec/orchestration/Layers/ProjectionPipeline.ts |  26 +-
 2 files changed, 301 insertions(+), 12 deletions(-)
```

## Exact production diff

`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`

```diff
@@ -1925,18 +1925,20 @@
       const replayFrom = Math.min(...states.map((state) => state.lastAppliedSequence));
-      yield* Stream.runForEach(eventStore.readFromSequence(replayFrom), (event) =>
-        Effect.forEach(
-          states,
-          (state) => {
-            if (state.lastAppliedSequence >= event.sequence) {
-              return Effect.void;
-            }
-            state.lastAppliedSequence = event.sequence;
-            return runProjectorForEvent(state.projector, event);
-          },
-          { concurrency: 1 },
-        ),
+      yield* Stream.runForEach(
+        eventStore.readFromSequence(replayFrom, Number.MAX_SAFE_INTEGER),
+        (event) =>
+          Effect.forEach(
+            states,
+            (state) => {
+              if (state.lastAppliedSequence >= event.sequence) {
+                return Effect.void;
+              }
+              state.lastAppliedSequence = event.sequence;
+              return runProjectorForEvent(state.projector, event);
+            },
+            { concurrency: 1 },
+          ),
       );
```

This explicitly consumes the complete event stream during bootstrap instead of the default 1,000-event cap. `readFromSequence` already pages internally; the stream remains lazy and ordered.

## Regression proof

Added a fresh-layer regression with more than 1,500 events:

- project/thread creation and one running turn;
- 1,500 filler events;
- runtime-item evidence after the former 1,000-event boundary;
- session completion;
- pending turn start.

Flow:

1. Full bootstrap establishes the reference snapshot.
2. Simulates migration 040’s legacy upgrade:
   - runtime-items cursor set to zero;
   - runtime-item rows deleted in the fixture only;
   - sessions/turns at the final event;
   - threads one event behind as the supported coupled partial tail.
3. Bootstrap again.

Assertions compare the complete final state with the full-replay reference:

- runtime item after event 1,000 exists and is completed;
- session is ready and has no active turn;
- turn is completed;
- latest pointer is intact;
- pending start is intact;
- settlement row is intact;
- runtime-items and threads cursors both reach the final event.

Before the production change, this fixture failed with an empty runtime-item result because the default 1,000-event replay stopped before the item. After the change it passes.

## Checks

- `ProjectionPipeline.test.ts`: **34 passed**
- `ProjectionRuntimeItems.test.ts`, `RuntimeItemProjection.test.ts`, `Migrations.test.ts`, `decider.runtimeItems.test.ts`: **30 passed**
- Changed files formatted; `git diff --check` clean before commit.
- Worker-local dependency links restored exactly.
- Working tree clean after commit.

## Remaining limits

- Runtime-items catch-up still reads current turn rows when replaying historical `thread.reverted` events. Normal monotonic checkpoint history matches full replay in the existing regression. A later mutation that changes the historical retention set could diverge.
- The threads projector reads runtime items for shell worker counts; runtime-items-only catch-up does not itself recompute existing shell worker counts until a later thread event.
- No root `vp check`, recursive typecheck, live provider, browser, installed-desktop, or restart proof was run.
